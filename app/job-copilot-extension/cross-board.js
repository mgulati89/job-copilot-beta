/**
 * cross-board.js — Job Copilot adapter for non-LinkedIn job boards.
 *
 * Speaks the same chrome.runtime.onMessage protocol as content.js
 * (GET_JOB_DATA, SCORE_AND_CREATE_JOB) so popup.js doesn't need any
 * board-specific logic.
 *
 * Strategy:
 *   1. Prefer JSON-LD JobPosting schema (Greenhouse, Lever, Ashby, Workable,
 *      Workday in many tenants, Welcome to the Jungle, and most modern career
 *      pages emit this).
 *   2. Fall back to OpenGraph + h1 + longest-text-block heuristics.
 *   3. Always return a payload with the same shape content.js returns, with
 *      linkedin_job_id="" so the backend dedups by (title, company).
 */
(function () {
  // Don't run on LinkedIn — content.js owns that surface.
  if (
    location.hostname.includes("linkedin.com") ||
    location.hostname.endsWith(".linkedin.com")
  ) {
    return;
  }

  const API_BASE = "http://127.0.0.1:8000";

  // Backend warmup. Fire-and-forget; silent if backend is down.
  try {
    fetch(API_BASE + "/health", { method: "GET" }).catch(() => {});
  } catch (_e) {
    /* ignore */
  }

  // ---------- JSON-LD discovery ----------

  function findJsonLdJobPosting() {
    const blocks = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const s of blocks) {
      let parsed;
      try {
        parsed = JSON.parse(s.textContent || "");
      } catch (_e) {
        continue;
      }
      const found = walkForJobPosting(parsed);
      if (found) return found;
    }
    return null;
  }

  function isJobPosting(node) {
    if (!node || typeof node !== "object") return false;
    const t = node["@type"];
    if (t === "JobPosting") return true;
    if (Array.isArray(t) && t.includes("JobPosting")) return true;
    return false;
  }

  function walkForJobPosting(node) {
    if (!node) return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const f = walkForJobPosting(child);
        if (f) return f;
      }
      return null;
    }
    if (typeof node !== "object") return null;
    if (isJobPosting(node)) return node;
    if (Array.isArray(node["@graph"])) {
      const f = walkForJobPosting(node["@graph"]);
      if (f) return f;
    }
    return null;
  }

  // ---------- Field extraction (JSON-LD path) ----------

  function htmlToPlainText(htmlOrText) {
    if (htmlOrText == null) return "";
    const raw = String(htmlOrText);
    if (!/<[a-z][^>]*>/i.test(raw)) return raw.trim();
    const tmp = document.createElement("div");
    tmp.innerHTML = raw;
    const txt = tmp.textContent || tmp.innerText || "";
    return txt.replace(/ /g, " ").replace(/\s+\n/g, "\n").trim();
  }

  function extractCompanyName(jp) {
    const ho = jp.hiringOrganization;
    if (!ho) return "";
    if (typeof ho === "string") return ho.trim();
    if (Array.isArray(ho)) {
      for (const o of ho) {
        if (o && o.name) return String(o.name).trim();
      }
      return "";
    }
    if (ho.name) return String(ho.name).trim();
    return "";
  }

  function extractJobLocation(jp) {
    const j = jp.jobLocation;
    if (!j) {
      // Some JSON-LDs store location at the top level via applicantLocationRequirements
      if (jp.applicantLocationRequirements) {
        const a = jp.applicantLocationRequirements;
        if (typeof a === "string") return a;
        if (Array.isArray(a) && a[0] && a[0].name) return String(a[0].name);
        if (a.name) return String(a.name);
      }
      return null;
    }
    const obj = Array.isArray(j) ? j[0] : j;
    if (!obj) return null;
    const a = obj.address;
    if (!a) {
      if (obj.name) return String(obj.name);
      return null;
    }
    if (typeof a === "string") return a;
    const parts = [a.addressLocality, a.addressRegion, a.addressCountry]
      .filter((x) => x && String(x).trim())
      .map((x) => String(x).trim());
    return parts.length ? parts.join(", ") : null;
  }

  function formatMoney(n, currency) {
    const num = Number(n);
    if (!isFinite(num)) return String(n);
    const sym = currency === "USD" || !currency ? "$" : currency + " ";
    return sym + num.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function extractSalary(jp) {
    const bs = jp.baseSalary;
    if (!bs) return null;
    const cur = bs.currency || (bs.value && bs.value.currency) || "USD";
    const v = bs.value || bs;
    if (!v || typeof v !== "object") return null;
    const minV = v.minValue != null ? v.minValue : v.value;
    const maxV = v.maxValue;
    if (minV != null && maxV != null) {
      return formatMoney(minV, cur) + " - " + formatMoney(maxV, cur);
    }
    if (minV != null) return formatMoney(minV, cur);
    return null;
  }

  function payloadFromJsonLd(jp) {
    const title = String(jp.title || "").trim();
    const company = extractCompanyName(jp);
    const jdRaw = jp.description || "";
    let jd = htmlToPlainText(jdRaw);
    const salary = extractSalary(jp);
    if (salary && !/\$\s?\d/.test(jd.slice(0, 4000))) {
      jd = jd + "\n\nPosted salary: " + salary;
    }
    return {
      title,
      company,
      job_description: jd,
      location: extractJobLocation(jp),
      _source: "jsonld",
    };
  }

  // ---------- Heuristic fallback ----------

  function metaContent(prop) {
    const el =
      document.querySelector('meta[property="' + prop + '"]') ||
      document.querySelector('meta[name="' + prop + '"]');
    return el && el.content ? String(el.content).trim() : "";
  }

  function pickHeuristicTitle() {
    const og = metaContent("og:title");
    if (og) return cleanTitleSeparator(og);
    const h1 = document.querySelector("h1");
    if (h1 && h1.textContent && h1.textContent.trim()) {
      return h1.textContent.trim();
    }
    return cleanTitleSeparator(document.title || "");
  }

  function cleanTitleSeparator(s) {
    // "Senior RevOps Manager - Acme Inc" → "Senior RevOps Manager"
    // "Senior RevOps Manager | Acme" → "Senior RevOps Manager"
    return String(s)
      .replace(/\s+[-|–—]\s+[^-|–—]+$/, "")
      .trim();
  }

  function pickHeuristicCompany() {
    const og = metaContent("og:site_name");
    if (og) return og;
    // Try the right-side of a separator in <title>
    const t = document.title || "";
    const m = t.match(/[-|–—]\s*([^-|–—]+)$/);
    if (m && m[1]) return m[1].trim();
    // Fall back to hostname (capitalized)
    const host = location.hostname.replace(/^www\./, "").split(".")[0];
    return host ? host.charAt(0).toUpperCase() + host.slice(1) : "";
  }

  function pickHeuristicJd() {
    const candidates = document.querySelectorAll(
      "article, [role='main'], main, " +
        "[class*='job-description'], [class*='JobDescription'], " +
        "[class*='description'], [class*='posting'], [data-qa*='description']"
    );
    let best = "";
    for (const el of candidates) {
      const t = (el.textContent || "").trim();
      if (t.length > best.length) best = t;
    }
    if (best && best.length > 200) return best;
    const og = metaContent("og:description");
    if (og && og.length > 100) return og;
    // Last resort: clip body text
    const body = (document.body && document.body.textContent) || "";
    return body.trim().slice(0, 6000);
  }

  function payloadFromHeuristics() {
    return {
      title: pickHeuristicTitle(),
      company: pickHeuristicCompany(),
      job_description: pickHeuristicJd(),
      location: null,
      _source: "heuristic",
    };
  }

  // ---------- Build full payload (matches content.js shape) ----------

  function buildJobPayload() {
    const jp = findJsonLdJobPosting();
    const base = jp ? payloadFromJsonLd(jp) : payloadFromHeuristics();
    const url = (location.href || "").slice(0, 500);
    const ts = new Date().toISOString();
    return {
      title: base.title,
      company: base.company,
      job_description: base.job_description,
      location: base.location,
      linkedin_job_id: "",
      normalized_job_url: url,
      extracted_title: base.title,
      extracted_company: base.company,
      extraction_timestamp: ts,
      source_url: url,
      page_mode: "cross_board_" + base._source,
    };
  }

  function payloadIsUsable(p) {
    if (!p || typeof p !== "object") return false;
    const title = (p.title || "").trim();
    const company = (p.company || "").trim();
    const jd = (p.job_description || "").trim();
    return !!(title && company && jd && jd.length >= 120);
  }

  // ---------- Message handlers ----------

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || typeof request !== "object") return false;

    if (request.type === "GET_JOB_DATA") {
      try {
        const payload = buildJobPayload();
        if (!payloadIsUsable(payload)) {
          sendResponse({
            extraction_failed: true,
            failure_reason: "no_job_posting_found",
            page_mode: payload.page_mode || "cross_board",
            source_url: (location.href || "").slice(0, 500),
          });
          return false;
        }
        sendResponse(payload);
      } catch (err) {
        sendResponse({
          extraction_failed: true,
          failure_reason: "cross_board_error",
          page_mode: "cross_board",
          flow_error: String(err && err.message ? err.message : err),
          source_url: (location.href || "").slice(0, 500),
        });
      }
      return false;
    }

    if (request.type === "SCORE_AND_CREATE_JOB") {
      (async () => {
        try {
          const p = request.payload || {};
          let description = (p.job_description || "").trim();
          if (!description || description.length < 120) {
            // Re-extract if popup didn't supply a usable JD.
            const fresh = buildJobPayload();
            if (payloadIsUsable(fresh)) {
              description = fresh.job_description;
              p.title = p.title || fresh.title;
              p.company = p.company || fresh.company;
              p.location = p.location || fresh.location;
              p.source_url = p.source_url || fresh.source_url;
            }
          }
          if (!description) description = "No description available";

          const payload = {
            title: (p.title || "").trim(),
            company: (p.company || "").trim(),
            job_description: description,
            location: p.location || null,
            source_url: p.source_url || (location.href || "").slice(0, 500),
            normalized_job_url:
              p.normalized_job_url || (location.href || "").slice(0, 500),
            extracted_title: p.extracted_title || p.title || "",
            extracted_company: p.extracted_company || p.company || "",
            extraction_timestamp:
              p.extraction_timestamp || new Date().toISOString(),
            // No linkedin_job_id on cross-board. Backend dedups by title+company.
            linkedin_job_id: "",
          };

          // Backend health-check first so the popup gets a clean error if down.
          try {
            const hr = await fetch(API_BASE + "/health", { method: "GET" });
            if (!hr.ok) {
              sendResponse({
                ok: false,
                status: 0,
                bodyText: JSON.stringify({ error: "backend_unavailable" }),
              });
              return;
            }
          } catch (_e) {
            sendResponse({
              ok: false,
              status: 0,
              bodyText: JSON.stringify({ error: "backend_unavailable" }),
            });
            return;
          }

          const r = await fetch(API_BASE + "/score-and-create-job", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const bodyText = await r.text();
          sendResponse({ ok: r.ok, status: r.status, bodyText });
        } catch (e) {
          sendResponse({
            ok: false,
            status: 0,
            bodyText: String(e && e.message ? e.message : e),
          });
        }
      })();
      return true; // async sendResponse
    }

    return false;
  });
})();
