console.log("[JC STEP] content script loaded");

function getVisibleText(el) {
  const text = el?.innerText?.trim();
  return text || "";
}

/**
 * Expand LinkedIn's "See more" / "Show more" button in the JD area so the
 * full description (including salary disclosures, which often live at the
 * bottom) is in the rendered DOM before extraction. innerText respects
 * visibility, so without this the regex never sees truncated content.
 *
 * Returns true if a button was clicked. Safe to call on any page; no-op
 * when no matching button exists.
 */
function jcExpandLinkedInJobDescription() {
  try {
    const sels = [
      "button.jobs-description__footer-button",
      ".jobs-description button",
      ".jobs-description-content button",
      ".jobs-box__html-content button",
      "button[aria-label*='see more' i]",
      "button[aria-label*='show more' i]",
      "button[aria-expanded='false'][class*='description']",
    ];
    const seen = new Set();
    for (const sel of sels) {
      const nodes = document.querySelectorAll(sel);
      for (const btn of nodes) {
        if (seen.has(btn)) continue;
        seen.add(btn);
        const txt = (btn.textContent || "").trim().toLowerCase();
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        const isExpander =
          txt.includes("see more") ||
          txt.includes("show more") ||
          aria.includes("see more") ||
          aria.includes("show more");
        if (!isExpander) continue;
        // Skip if already expanded.
        if (btn.getAttribute("aria-expanded") === "true") continue;
        try {
          btn.click();
          return true;
        } catch (_e) {
          /* try next */
        }
      }
    }
  } catch (_e) {
    /* ignore */
  }
  return false;
}

/** Synced with popup Debug toggle via chrome.storage.local */
let jcDebugVerbose = false;

let jcRetryCount = 0;
const JC_MAX_RETRIES = 10;

/** Dedupe repeated score-and-create for the same LinkedIn job id (session). */
let lastJobIdSent = null;
let lastScoreCreateBodyText = null;
try {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    chrome.storage.local.get({ jc_debug_verbose: false }, (r) => {
      jcDebugVerbose = !!r.jc_debug_verbose;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.jc_debug_verbose) return;
      jcDebugVerbose = !!changes.jc_debug_verbose.newValue;
    });
  }
} catch (_e) {
  /* ignore */
}

function jcVerboseLog(...args) {
  if (!jcDebugVerbose) return;
  console.log("[JC]", ...args);
}

function jcStageLog(stage, detail) {
  if (!jcDebugVerbose) return;
  if (detail !== undefined) console.log("[JC]", stage, detail);
  else console.log("[JC]", stage);
}

function jcFrontendDebugLog(...args) {
  jcVerboseLog(...args);
}

function jcFrontendDebugError(stage, detail) {
  if (!jcDebugVerbose) return;
  if (detail !== undefined) console.error("[JC]", stage, detail);
  else console.error("[JC]", stage);
}

/**
 * Hard gate: only LinkedIn hostname and supported jobs surfaces.
 * Extends the base path rules with patterns used by LinkedIn (e.g. search-results, /jobs/view?).
 */
function isSupportedLinkedInJobPage() {
  const href = window.location.href;
  const hostOk = window.location.hostname.includes("linkedin.com");
  const pathOk =
    href.includes("/jobs/view/") ||
    /\/jobs\/view(\/|\?|$)/i.test(href) ||
    href.includes("/jobs/collections") ||
    href.includes("/jobs/search/") ||
    href.includes("/jobs/search-results") ||
    (href.includes("/jobs/search") && href.includes("currentJobId="));
  return hostOk && pathOk;
}

function logJcFrontendDebugExtractionSummary(payload) {
  if (!payload || !jcDebugVerbose) return;
  const ed = payload.extraction_debug || {};
  jcFrontendDebugLog("extraction summary", {
    chosen_selector: ed.chosen_selector ?? ed.selector_used,
    description_length: ed.description_length,
    contaminated: !!payload.description_contaminated,
  });
}

/** Semantic / content-based — no hashed CSS-module classes. */
function getApplyButton() {
  const candidates = Array.from(document.querySelectorAll("button, a"));
  return (
    candidates.find((el) => {
      const t =
        getVisibleText(el) ||
        (el.getAttribute && el.getAttribute("aria-label")) ||
        "";
      return /apply/i.test(t);
    }) || null
  );
}

/** Left-rail list only — do not match the whole `.jobs-search-results` wrapper. */
function isNodeInSearchResultsListRail(el) {
  if (!el || !el.closest) return false;
  return !!el.closest(
    ".jobs-search-results__list, .jobs-search-results-list, .jobs-search-results__list-item, [class*='jobs-search-results__list']"
  );
}

/**
 * Strip "/yr", "/year", "per year" annotations from a salary range so the
 * backend regex (which matches `$X - $Y` with no annotation between) can parse it.
 * Input:  "$130K/yr - $155K/yr"
 * Output: "$130K - $155K"
 */
function normalizePostedSalaryText(raw) {
  return (raw || "")
    .replace(/\s*\/\s*(?:yr|year|hour|hr)\b/gi, "")
    .replace(/\s*per\s+(?:year|hour|hr|annum)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull a posted salary range (e.g. "$130K/yr - $155K/yr" or "$130,000 — $155,000")
 * from the LinkedIn top-card insight chips. LinkedIn renders posted salary in the
 * same insight panel as Hybrid/Full-time pills; the chip text is NOT included in
 * the JD body that the description extractor scrapes, which is why the backend
 * was falling back to a market estimate.
 *
 * Returns a NORMALIZED range string (e.g. "$130K - $155K") that the backend
 * salary regex can parse, or null if no chip range is found.
 */
function extractPostedSalaryText(scope) {
  // LinkedIn now ships hashed CSS-in-JS class names (e.g. "_c97b4825 _a29c78e3")
  // that change every deploy, so specific class selectors are unreliable. We
  // scan visible elements for the salary regex directly, preferring the
  // smallest matching element (most likely the chip itself, not a paragraph
  // that happens to mention a range).
  const SALARY_RX =
    /(?:Est\.?\s+)?\$\s?\d{1,3}(?:,\d{3})?\s?[Kk]?(?:\s?\/\s?(?:yr|year|hr|hour))?(?:\s?per\s?(?:year|hour|hr|annum))?\s*(?:[-–—]|to)\s*\$?\s?\d{1,3}(?:,\d{3})?\s?[Kk]?(?:\s?\/\s?(?:yr|year|hr|hour))?(?:\s?per\s?(?:year|hour|hr|annum))?/;

  function scanElementsForSalary(root) {
    if (!root || typeof root.querySelectorAll !== "function") return null;
    let best = null;
    let bestLen = Infinity;
    let nodes;
    try {
      nodes = root.querySelectorAll("li, span, div, p");
    } catch (_e) {
      return null;
    }
    for (const node of nodes) {
      // Skip the JD body — long containers are not chips.
      const raw = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length < 3 || raw.length > 240) continue;
      const m = raw.match(SALARY_RX);
      if (!m) continue;
      // Prefer the shortest matching node (the chip itself, not its parents).
      if (raw.length < bestLen) {
        const normalized = normalizePostedSalaryText(m[0]);
        if (normalized) {
          best = normalized;
          bestLen = raw.length;
        }
      }
    }
    return best;
  }

  // 1) Try named scopes first (cheap, exits fast on stable LinkedIn variants).
  const namedScopes = [];
  const namedSelectors = [
    ".job-details-jobs-unified-top-card",
    ".jobs-unified-top-card",
    ".jobs-details-top-card",
    ".job-view-layout",
    ".jobs-search__job-details--container",
    "[class*='top-card']",
    "[class*='job-insight']",
    "[class*='salary']",
    "[class*='compensation']",
  ];
  for (const sel of namedSelectors) {
    let els;
    try {
      els = document.querySelectorAll(sel);
    } catch (_e) {
      continue;
    }
    for (const el of els) namedScopes.push(el);
  }
  if (scope && typeof scope.querySelectorAll === "function") {
    namedScopes.push(scope);
  }
  for (const root of namedScopes) {
    const hit = scanElementsForSalary(root);
    if (hit) return hit;
  }

  // 2) Fallback: scan the whole document. We only land here when the JD body
  // had no salary range, so any hit is most likely the posted-salary chip.
  return scanElementsForSalary(document);
}

/**
 * True if a salary-like range already appears in the JD body — used to avoid
 * duplicating a "Posted salary:" line when the description itself names the band.
 */
function jdAlreadyContainsSalaryRange(jd) {
  if (!jd) return false;
  return /\$\s?\d{1,3}(?:,\d{3})?\s?[Kk]?\s*(?:[-–—]|to)\s*\$?\s?\d{1,3}(?:,\d{3})?\s?[Kk]?/.test(
    jd
  );
}

/**
 * LinkedIn hides the salary chip outside the prose JD; append it whenever the visible
 * range is missing from the scraped body. Runs even when the JD is empty after
 * contamination handling so scoring/salary_guidance still see a posted band.
 */
function appendPostedSalaryChip(jobDescription, scopeEl) {
  const base = typeof jobDescription === "string" ? jobDescription : "";
  if (jdAlreadyContainsSalaryRange(base)) return base;
  const posted = extractPostedSalaryText(scopeEl);
  if (!posted) return base;
  const line = `Posted salary: ${posted}`;
  const t = base.trim();
  return t ? `${base}\n\n${line}` : line;
}

/**
 * Pull "City, ST" from a LinkedIn location line (may include " · Remote", etc.).
 */
function extractCityStateFromLocationBlob(raw) {
  const t = (raw || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const parts = t.split(/\s*[·•]\s*/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (/^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Z]{2}\b/.test(p)) return p;
  }
  const m = t.match(/\b([A-Za-z][A-Za-z\s.'-]+,\s*[A-Z]{2})\b/);
  return m ? m[1].trim() : null;
}

/**
 * Location string from a specific detail root (metadata row / top card — not title text).
 */
function getJobLocationFromDetailRoot(root) {
  if (!root) return null;

  const tryText = (raw) => {
    const fromBlob = extractCityStateFromLocationBlob(raw);
    const t = (fromBlob || (raw || "").replace(/\s+/g, " ")).trim();
    if (t.length < 3 || t.length > 160) return null;
    if (/^\d[\d,\s]*\+?\s*employees?$/i.test(t)) return null;
    if (/^\(.*\)$/.test(t)) return null;
    if (/^(remote|hybrid|on-?site)\s*$/i.test(t)) return null;
    if (/^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Z]{2}\b/.test(t)) return t;
    return null;
  };

  const selectors = [
    "[data-test-id='job-location']",
    "[data-test-id=\"job-location\"]",
    ".jobs-unified-top-card__bullet",
    ".jobs-unified-top-card__job-insight span",
    ".jobs-unified-top-card__job-insight",
    ".jobs-unified-top-card__subtitle",
    "[class*='job-location']",
    "[class*='jobs-unified-top-card'] [class*='bullet']",
  ];
  for (let s = 0; s < selectors.length; s++) {
    const nodes = root.querySelectorAll(selectors[s]);
    for (let n = 0; n < nodes.length; n++) {
      const hit = tryText(getVisibleText(nodes[n]));
      if (hit) return hit;
    }
  }

  const primary = root.querySelector(
    ".jobs-unified-top-card__primary-description, .jobs-unified-top-card__primary-description-without-tagline"
  );
  if (primary) {
    const blob = getVisibleText(primary);
    const m = blob.match(
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2})\b/
    );
    if (m) return m[1].trim();
  }
  return null;
}

/** City, ST — only from active job detail header / top card (never search cards). */
function getJobLocation() {
  const root =
    getDetailPaneRootForHeaderExtraction() ||
    getActiveJobDetailRoot() ||
    findMainJobPane() ||
    document.querySelector(".jobs-search__job-details--container") ||
    document.querySelector(".job-view-layout") ||
    document.querySelector(".scaffold-layout__detail") ||
    null;
  return getJobLocationFromDetailRoot(root);
}

/**
 * Active job detail pane only — never the left search list; never bare document/body.
 */
function getActiveJobDetailRoot() {
  const tryPick = (el) => {
    if (!el) return null;
    if (isNodeInSearchResultsListRail(el)) return null;
    return el;
  };

  const href = window.location.href || "";
  if (shouldUseResultsPanelRootHref(href)) {
    const rp = tryPick(resolveResultsPanelJobDetailRoot());
    if (rp) return rp;
  }

  const ordered = [
    () => document.querySelector(".jobs-search__job-details--container"),
    () => document.querySelector(".jobs-details__main-content"),
    () => document.querySelector(".job-view-layout .jobs-details"),
    () => document.querySelector(".scaffold-layout__detail .jobs-details"),
    () => document.querySelector(".job-view-layout"),
    () => document.querySelector("div.jobs-details"),
  ];

  for (let i = 0; i < ordered.length; i++) {
    const picked = tryPick(ordered[i]());
    if (picked) return picked;
  }

  const fmp = tryPick(findMainJobPane());
  if (fmp) return fmp;

  return tryPick(document.querySelector(".scaffold-layout__detail"));
}

/** @deprecated Use getActiveJobDetailRoot — kept for minimal diff */
function getDescriptionRoot() {
  return getActiveJobDetailRoot();
}

/**
 * Narrow contamination: only clear search-results bleed (not short/slow loads).
 */
function detectDescriptionContamination(text, title, company) {
  void title;
  void company;
  const reasons = [];
  if (!text || String(text).trim().length < 40) {
    return { contaminated: false, reasons };
  }
  const sample = String(text).slice(0, 25000);

  if (/\b99\s*\+\s*results\b/i.test(sample)) {
    reasons.push("results_99_plus_banner");
  }

  const postedOn = sample.match(/\bPosted on\b/gi);
  if (postedOn && postedOn.length >= 3) {
    reasons.push("repeated_posted_on");
  }

  const actively = (sample.match(/\bActively recruiting\b/gi) || []).length;
  if (actively >= 3) {
    reasons.push("multiple_actively_recruiting");
  }

  const earlyApplicant = (sample.match(/\bBe an early applicant\b/gi) || []).length;
  if (earlyApplicant >= 3) {
    reasons.push("multiple_early_applicant_snippets");
  }

  return { contaminated: reasons.length > 0, reasons };
}

/**
 * Single debug line per attempt (or final). Call from scrape loops after each build.
 */
function emitJcExtractDebug(
  pageMode,
  detailRoot,
  payload,
  attempt,
  willRetry,
  finalFailureReason,
  waitStats,
  extra
) {
  const ed = payload.extraction_debug || {};
  const prev = (ed.description_preview_500 || "").slice(0, 300);
  const ws = waitStats || {};
  const ex = extra || {};
  jcVerboseLog("[JC EXTRACT DEBUG]", {
    page_mode: pageMode,
    attempt,
    wait_cycles_used: ws.wait_cycles,
    total_wait_ms: ws.total_wait_ms,
    cumulative_wait_ms: ex.cumulative_wait_ms,
    selector_used: ed.selector_used,
    chosen_selector: ed.chosen_selector ?? ed.selector_used,
    selector_candidates: ed.selector_candidates,
    candidate_lengths: ed.candidate_lengths,
    candidate_contamination_flags: ed.candidate_contamination_flags,
    selector_found: ed.selector_used != null && ed.selector_used !== "",
    description_length: ed.description_length,
    description_preview_300: prev,
    container_found: !!detailRoot,
    contamination_detected: ed.contamination_detected,
    contamination_reasons: ed.contamination_reasons || [],
    extraction_mode: ed.extraction_mode ?? payload.extraction_mode,
    retrying: !!willRetry,
    final_failure_reason:
      finalFailureReason != null ? finalFailureReason : null,
    reason_for_failure:
      ex.reason_for_failure != null ? ex.reason_for_failure : null,
    final_description_length: ex.final_description_length,
  });
}

/**
 * Poll until a job detail node exists and description text is long enough (lazy-loaded).
 * max 2500ms, step 250ms; default: keyword hit or long chunk.
 * opts.fullView: relaxed for /jobs/view/ (About the job OR length > 200 OR keywords).
 */
async function waitForJobDetailContentReady(maxMs = 2500, intervalMs = 250, opts) {
  const fullView = opts && opts.fullView;
  const deadline = Date.now() + maxMs;
  const minLen = fullView ? 40 : 150;
  let cycles = 0;
  const start = Date.now();
  while (Date.now() < deadline) {
    const bucket = gatherDescriptionCandidateElements(null, {
      fullViewPage: !!fullView,
    });
    for (let i = 0; i < bucket.length; i++) {
      const el = bucket[i].el;
      if (!el || isNodeInSearchResultsListRail(el)) continue;
      const t = (el.innerText || "").trim();
      if (t.length <= minLen) continue;
      const kw = computeLayoutKeywordBonus(t);
      if (fullView) {
        const ab =
          /about the job/i.test(t.slice(0, 120000)) ||
          countSectionHeadingPhrases(t) >= 1;
        if (t.length > 200 || ab || kw > 0 || t.length > 280) {
          return {
            ok: true,
            selector_matched: bucket[i].tag,
            wait_cycles: cycles,
            total_wait_ms: Date.now() - start,
          };
        }
      } else if (kw > 0 || t.length > 280) {
        return {
          ok: true,
          selector_matched: bucket[i].tag,
          wait_cycles: cycles,
          total_wait_ms: Date.now() - start,
        };
      }
    }
    await sleep(intervalMs);
    cycles += 1;
  }
  return {
    ok: false,
    selector_matched: null,
    wait_cycles: cycles,
    total_wait_ms: Date.now() - start,
  };
}

function getLongestBucketCandidateInfo(bucket) {
  let maxLen = 0;
  let chosenSelector = null;
  for (let i = 0; i < bucket.length; i++) {
    const txt = getVisibleText(bucket[i].el) || "";
    if (txt.length > maxLen) {
      maxLen = txt.length;
      chosenSelector = bucket[i].tag;
    }
  }
  return { maxLen, chosenSelector };
}

/**
 * Full /jobs/view/ readiness: title + company + (About the job signal OR long body text).
 * Uses relaxed gather (fullViewPage) — still subject to extraction scoring afterward.
 * @param {{ clearPairCache?: boolean }} [opts] clearPairCache false when attaching snapshot after extraction (avoid stale UI without disturbing pair).
 */
function getFullViewReadinessSnapshot(opts) {
  const clearPairCache = !opts || opts.clearPairCache !== false;
  const href = window.location.href || "";
  const isFullView = isLinkedInFullJobViewPath(href);
  if (isFullView && clearPairCache) {
    clearTitleCompanyPairCache();
  }
  const title = (getJobTitle() || "").trim();
  const company = (getCompany() || "").trim();
  const hasTitle =
    !!title &&
    !isInvalidPromoTitle(title) &&
    !isLikelyNoiseTitle(title);
  const hasCompany = !!company;
  const blob = (
    document.body?.innerText ||
    document.documentElement?.innerText ||
    ""
  ).slice(0, 200000);
  const hasAboutSection =
    /about the job/i.test(blob) || countSectionHeadingPhrases(blob) >= 1;
  const bucket = gatherDescriptionCandidateElements(null, { fullViewPage: true });
  const { maxLen, chosenSelector } = getLongestBucketCandidateInfo(bucket);
  const hasBodyText = maxLen > 200 || hasAboutSection;
  const ready = hasTitle && hasCompany && hasBodyText;
  return {
    ready,
    isFullView,
    hasTitle,
    hasCompany,
    hasAboutSection,
    hasBodyText,
    chosenSelector,
    bodyLength: maxLen,
  };
}

function shouldUseResultsPanelRootHref(href) {
  const h = href || "";
  if (isLinkedInFullJobViewPath(h)) return false;
  return (
    h.includes("/jobs/search-results") ||
    h.includes("/jobs/collections") ||
    (h.includes("/jobs/search") && h.includes("currentJobId="))
  );
}

/**
 * Right-hand job detail pane for collections / two-pane search (never the left list).
 */
function resolveResultsPanelJobDetailRoot() {
  const orderedSelectors = [
    ".jobs-search__job-details--container",
    "[class*='jobs-search__job-details']",
    ".jobs-details__main-content",
    ".job-view-layout .jobs-details",
    ".scaffold-layout__detail .jobs-details",
    ".job-view-layout",
    "div.jobs-details",
    "[class*='job-details']",
    "main.scaffold-layout__main",
  ];
  for (let s = 0; s < orderedSelectors.length; s++) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(orderedSelectors[s]));
    } catch (e) {
      continue;
    }
    nodes.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!el || !isElementVisible(el)) continue;
      if (isNodeInSearchResultsListRail(el)) continue;
      if ((getVisibleText(el) || "").length < 40) continue;
      return el;
    }
  }
  for (let s = 0; s < orderedSelectors.length; s++) {
    try {
      const el = document.querySelector(orderedSelectors[s]);
      if (
        el &&
        isElementVisible(el) &&
        !isNodeInSearchResultsListRail(el)
      ) {
        return el;
      }
    } catch (e) {
      /* ignore */
    }
  }
  return null;
}

/**
 * Collections / search two-pane: ready when the active right panel shows title, company,
 * and meaningful description body or "About the job" (readiness-only; extraction may still retry).
 * @param {{ clearPairCache?: boolean }} [opts]
 */
function getResultsPanelReadinessSnapshot(opts) {
  const clearPairCache = !opts || opts.clearPairCache !== false;
  if (clearPairCache) {
    clearTitleCompanyPairCache();
  }
  const panel = resolveResultsPanelJobDetailRoot();
  if (!panel) {
    return {
      ready: false,
      isResultsPanel: true,
      isFullView: false,
      hasTitle: false,
      hasCompany: false,
      hasBodyText: false,
      hasAboutSection: false,
      chosenSelector: null,
      bodyLength: 0,
    };
  }
  const pair = extractTitleAndCompanyFromScopedPane(panel);
  const title = (
    pair.normalized_title ||
    pair.display_title ||
    pair.title ||
    ""
  ).trim();
  const company = (pair.normalized_company || pair.company || "").trim();
  const hasTitle =
    !!title && !isInvalidPromoTitle(title) && !isLikelyNoiseTitle(title);
  const hasCompany = !!company;
  const blob = (getVisibleText(panel) || "").slice(0, 200000);
  const hasAboutSection =
    /about the job/i.test(blob) || countSectionHeadingPhrases(blob) >= 1;
  const bucket = gatherDescriptionCandidateElements(panel, {
    resultsPanelMode: true,
  });
  const { maxLen, chosenSelector } = getLongestBucketCandidateInfo(bucket);
  const hasBodyText = maxLen > 200 || hasAboutSection;
  const ready = hasTitle && hasCompany && hasBodyText;
  return {
    ready,
    isResultsPanel: true,
    isFullView: false,
    hasTitle,
    hasCompany,
    hasAboutSection,
    hasBodyText,
    chosenSelector,
    bodyLength: maxLen,
  };
}

async function waitForFullViewJobDetailReady(maxMs = 6000, intervalMs = 250) {
  const deadline = Date.now() + maxMs;
  let cycles = 0;
  const start = Date.now();
  while (Date.now() < deadline) {
    const snap = getFullViewReadinessSnapshot();
    if (snap.ready) {
      return {
        ok: true,
        wait_cycles: cycles,
        total_wait_ms: Date.now() - start,
        snapshot: snap,
      };
    }
    await sleep(intervalMs);
    cycles += 1;
  }
  return {
    ok: false,
    wait_cycles: cycles,
    total_wait_ms: Date.now() - start,
    snapshot: getFullViewReadinessSnapshot(),
  };
}

function collectMatchingNodes(detailRoot, sel) {
  if (!detailRoot) return [];
  const out = [];
  try {
    if (detailRoot.matches && detailRoot.matches(sel)) out.push(detailRoot);
  } catch (e) {
    /* ignore */
  }
  const nodes = detailRoot.querySelectorAll(sel);
  for (let i = 0; i < nodes.length; i++) out.push(nodes[i]);
  return out;
}

function pushUniqueCandidate(bucket, el, tag) {
  if (!el || !el.nodeType) return;
  if (isNodeInSearchResultsListRail(el)) return;
  for (let i = 0; i < bucket.length; i++) {
    if (bucket[i].el === el) return;
  }
  bucket.push({ el, tag });
}

/** Results panel: explicit selector list (scoped under right-hand detail pane first). */
const RESULTS_PANEL_CONTAINER_SELECTORS = [
  ".jobs-search__job-details--container",
  "[class*='jobs-search__job-details']",
  ".jobs-description-content",
  ".jobs-box__html-content",
  ".jobs-details__main-content",
  "[class*='jobs-description']",
  "[class*='job-details']",
  "main",
  "section",
  "article",
];

const SECTION_HEADING_PHRASE_RES = [
  /about the job/i,
  /qualifications/i,
  /responsibilities/i,
  /requirements/i,
];

function countSectionHeadingPhrases(text) {
  const s = String(text || "").slice(0, 80000);
  let n = 0;
  for (let i = 0; i < SECTION_HEADING_PHRASE_RES.length; i++) {
    if (SECTION_HEADING_PHRASE_RES[i].test(s)) n += 1;
  }
  return n;
}

function isElementVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  try {
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    if (parseFloat(st.opacity || "1") === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0;
  } catch (e) {
    return false;
  }
}

function gatherResultsPanelCandidateElements(detailRoot) {
  const bucket = [];
  const perSelCap = 22;

  function ingestFromRoot(root, prefix) {
    if (!root || !root.querySelectorAll) return;
    for (let si = 0; si < RESULTS_PANEL_CONTAINER_SELECTORS.length; si++) {
      const sel = RESULTS_PANEL_CONTAINER_SELECTORS[si];
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll(sel));
      } catch (e) {
        continue;
      }
      for (let i = 0; i < nodes.length && i < perSelCap; i++) {
        pushUniqueCandidate(bucket, nodes[i], `${prefix}${sel}[${i}]`);
      }
    }
  }

  const hint =
    detailRoot ||
    resolveResultsPanelJobDetailRoot() ||
    getActiveJobDetailRoot() ||
    findMainJobPane() ||
    null;
  if (hint) {
    ingestFromRoot(hint, "RP-scoped:");
  } else {
    ingestFromRoot(document, "RP:");
  }

  bucket.sort((a, b) => {
    const ta = getVisibleText(a.el) || "";
    const tb = getVisibleText(b.el) || "";
    return layoutContainerHeuristicScore(tb) - layoutContainerHeuristicScore(ta);
  });

  return bucket;
}

/** LinkedIn layout containers — primary → secondary → fallback (order preserved). */
const LAYOUT_CONTAINER_PRIMARY = [".jobs-search__job-details--container"];
const LAYOUT_CONTAINER_SECONDARY = [
  ".jobs-description-content",
  ".jobs-box__html-content",
];
/** Full-page /jobs/view/ layouts (additional roots; still scored + contamination-checked). */
const LAYOUT_CONTAINER_FULLVIEW_EXTRA = [
  "[class*='jobs-search__job-details']",
  "[class*='job-details']",
  "[class*='jobs-box']",
  "main",
  "article",
];
const LAYOUT_CONTAINER_FALLBACK = [
  "[class*='jobs-description']",
  "[class*='job-details']",
  "main",
  "section",
  "article",
];

const JOB_DETAIL_KEYWORD_RE =
  /\b(responsibilities|requirements|qualifications|what you will|what you'll|about the (job|role)|role overview|sales|operations|experience|skills|bachelor|degree|years of experience)\b/i;

function computeLayoutKeywordBonus(text) {
  const sample = String(text || "").slice(0, 80000);
  const lower = sample.toLowerCase();
  const explicit = [
    "responsibilities",
    "requirements",
    "qualifications",
    "sales",
    "operations",
  ];
  let hits = 0;
  for (let i = 0; i < explicit.length; i++) {
    if (lower.includes(explicit[i])) hits += 1;
  }
  if (JOB_DETAIL_KEYWORD_RE.test(sample)) hits += 2;
  return hits;
}

function layoutContainerHeuristicScore(text) {
  const len = String(text || "").length;
  const kw = computeLayoutKeywordBonus(text);
  return len + kw * 450;
}

function isLikelyJobChromeSubtree(el) {
  if (!el || !el.closest) return false;
  return !!el.closest(
    ".scaffold-layout__detail, .job-view-layout, .jobs-search-two-column, .jobs-search__job-details--container, [class*='jobs-details'], [class*='jobs-search'], .jobs-view-layout"
  );
}

/**
 * Enumerate layout containers across LinkedIn DOM variants (global + optional hint subtree).
 * @param {object} [options]
 * @param {boolean} [options.resultsPanelMode] — wider selector pass for jobs search / collections detail pane
 */
function gatherDescriptionCandidateElements(detailRoot, options) {
  const opts = options || {};
  if (opts.resultsPanelMode) {
    return gatherResultsPanelCandidateElements(detailRoot);
  }

  const fullViewPage = !!opts.fullViewPage;
  const href = window.location.href || "";
  const relaxBroadForFullView =
    fullViewPage && isLinkedInFullJobViewPath(href);

  const bucket = [];

  const runGroup = (groupName, selectors, cap) => {
    for (let si = 0; si < selectors.length; si++) {
      const sel = selectors[si];
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(sel));
      } catch (e) {
        continue;
      }
      const isBroad = /^(main|section|article)$/i.test(sel);
      for (let i = 0; i < nodes.length && i < cap; i++) {
        const el = nodes[i];
        if (isBroad && !isLikelyJobChromeSubtree(el)) {
          if (!relaxBroadForFullView) continue;
        }
        pushUniqueCandidate(bucket, el, `${groupName}:${sel}[${i}]`);
      }
    }
  };

  runGroup("PRIMARY", LAYOUT_CONTAINER_PRIMARY, 5);
  runGroup("SECONDARY", LAYOUT_CONTAINER_SECONDARY, 12);
  if (fullViewPage) {
    runGroup("FV", LAYOUT_CONTAINER_FULLVIEW_EXTRA, 20);
  }
  runGroup("FALLBACK", LAYOUT_CONTAINER_FALLBACK, 35);

  const root = detailRoot || getActiveJobDetailRoot() || findMainJobPane();
  if (root) {
    const scoped = [
      '[role="main"]',
      ".jobs-details__main-content",
      ".jobs-details",
      ".jobs-description-content",
      ".jobs-box__html-content",
    ];
    for (let s = 0; s < scoped.length; s++) {
      const sel = scoped[s];
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll(sel));
      } catch (e) {
        continue;
      }
      for (let k = 0; k < nodes.length && k < 12; k++) {
        pushUniqueCandidate(bucket, nodes[k], `scoped:${sel}[${k}]`);
      }
    }
  }

  bucket.sort((a, b) => {
    const ta = getVisibleText(a.el) || "";
    const tb = getVisibleText(b.el) || "";
    return layoutContainerHeuristicScore(tb) - layoutContainerHeuristicScore(ta);
  });

  return bucket;
}

function scoreJobDescriptionCandidate(text, title, company, selectorLabel) {
  const len = text.length;
  const contam = detectDescriptionContamination(text, title, company);
  const layoutKwHits = computeLayoutKeywordBonus(text);
  const layoutBoost = layoutKwHits * 320;
  const tNorm = (title || "").toLowerCase().trim().slice(0, 100);
  const cNorm = (company || "").toLowerCase().trim().slice(0, 80);
  const lower = text.toLowerCase();
  let headerScore = 0;
  if (tNorm.length >= 6 && lower.includes(tNorm)) {
    headerScore += 50000;
  } else if (tNorm.length >= 10) {
    const parts = tNorm.split(/\s+/).filter((w) => w.length > 3);
    let hits = 0;
    for (let i = 0; i < Math.min(parts.length, 5); i++) {
      if (lower.includes(parts[i])) hits += 1;
    }
    if (hits >= 2) headerScore += 25000;
  }
  if (cNorm.length >= 3 && lower.includes(cNorm)) {
    headerScore += 40000;
  }
  let score = len + headerScore + layoutBoost;
  if (contam.contaminated) {
    score = -1000000 - len;
  }
  return {
    score,
    contam,
    headerScore,
    len,
    selectorLabel,
    layout_keyword_hits: layoutKwHits,
    layout_boost: layoutBoost,
  };
}

function buildContainerDumpRow(el, tag, jobIdStr, text) {
  const t = String(text || "");
  const len = t.length;
  const visible = isElementVisible(el);
  const sectionHits = countSectionHeadingPhrases(t);
  const containsJobId =
    jobIdStr.length >= 6 && t.includes(jobIdStr);
  return {
    selector: tag,
    text_length: len,
    preview: t.slice(0, 120),
    contains_job_id: containsJobId,
    section_keyword_match: sectionHits > 0,
    section_keyword_hits: sectionHits,
    visible,
  };
}

function containerDumpSortKey(row, text) {
  let s = row.text_length;
  if (row.visible) s += 200000;
  if (row.contains_job_id) s += 50000;
  if (row.section_keyword_match) s += 25000 + row.section_keyword_hits * 8000;
  s += computeLayoutKeywordBonus(text) * 500;
  return s;
}

/**
 * Pick best description candidate by score; results panel uses expanded gather + dump metadata.
 * @param {object} [options]
 * @param {boolean} [options.resultsPanelMode]
 * @param {boolean} [options.fullViewPage] — extra selectors + relaxed broad roots on /jobs/view/
 */
function extractJobDescriptionWithBestCandidate(detailRoot, title, company, options) {
  const opts = options || {};
  const resultsPanelMode = !!opts.resultsPanelMode;
  const fullViewPage = !!opts.fullViewPage;
  const bucket = gatherDescriptionCandidateElements(detailRoot, {
    resultsPanelMode,
    fullViewPage,
  });
  const jobIdStr = (extractLinkedInJobId() || "").trim();

  const rawDumpRows = [];
  for (let i = 0; i < bucket.length; i++) {
    const { el, tag } = bucket[i];
    const text = getVisibleText(el);
    const row = buildContainerDumpRow(el, tag, jobIdStr, text);
    rawDumpRows.push(row);
    jcVerboseLog("[JC CONTAINER CANDIDATE]", row);
  }

  const indexedForSort = rawDumpRows.map((row, idx) => ({
    row,
    idx,
    text: getVisibleText(bucket[idx].el),
  }));
  indexedForSort.sort(
    (a, b) =>
      containerDumpSortKey(b.row, b.text) - containerDumpSortKey(a.row, a.text)
  );
  const container_dump_top5 = indexedForSort.slice(0, 5).map((x) => x.row);
  const container_dump_full = rawDumpRows.slice(0, 36);

  jcVerboseLog("[JC CONTAINER DUMP]", {
    results_panel_mode: resultsPanelMode,
    total_candidates: bucket.length,
    top5: container_dump_top5,
  });

  try {
    window.__jcLastContainerDump = {
      results_panel_mode: resultsPanelMode,
      total_candidates: bucket.length,
      top5: container_dump_top5,
      dump: container_dump_full,
    };
  } catch (e) {
    /* ignore */
  }

  const container_resolution_candidates = [];
  for (let i = 0; i < bucket.length; i++) {
    const txt = getVisibleText(bucket[i].el);
    const kw = computeLayoutKeywordBonus(txt || "");
    const h = layoutContainerHeuristicScore(txt || "");
    container_resolution_candidates.push({
      tag: rawDumpRows[i].selector,
      text_length: rawDumpRows[i].text_length,
      layout_keyword_hits: kw,
      heuristic_score: h,
      visible: rawDumpRows[i].visible,
      section_keyword_hits: rawDumpRows[i].section_keyword_hits,
    });
  }

  const evaluations = [];
  for (let i = 0; i < bucket.length; i++) {
    const { el, tag } = bucket[i];
    const text = getVisibleText(el);
    if (!text || text.length < 10) continue;
    const ev = scoreJobDescriptionCandidate(text, title, company, tag);
    evaluations.push({
      selector: tag,
      length: ev.len,
      contaminated: ev.contam.contaminated,
      contamination_reasons: ev.contam.reasons || [],
      header_boost: ev.headerScore,
      layout_keyword_hits: ev.layout_keyword_hits,
      layout_boost: ev.layout_boost,
      score: ev.score,
      visible: rawDumpRows[i].visible,
    });
  }

  function pickBestNonContaminated(minLen, preferVisible) {
    let bt = "";
    let btag = null;
    let bs = -Infinity;
    for (let i = 0; i < bucket.length; i++) {
      const { el, tag } = bucket[i];
      const text = getVisibleText(el);
      if (!text || text.length < minLen) continue;
      if (preferVisible && !rawDumpRows[i].visible) continue;
      const ev = scoreJobDescriptionCandidate(text, title, company, tag);
      if (ev.contam.contaminated) continue;
      if (ev.score > bs) {
        bs = ev.score;
        bt = text;
        btag = tag;
      }
    }
    return { text: bt, tag: btag, score: bs };
  }

  let bestText = "";
  let bestTag = null;
  let selectionReason = "";

  let pick = pickBestNonContaminated(20, false);
  if (!pick.text) pick = pickBestNonContaminated(15, false);
  if (!pick.text) pick = pickBestNonContaminated(12, true);
  if (!pick.text) pick = pickBestNonContaminated(10, true);
  if (!pick.text) pick = pickBestNonContaminated(10, false);

  if (pick.text) {
    bestText = pick.text;
    bestTag = pick.tag;
    selectionReason = `Non-contaminated pick (score=${pick.score}); min-len / visible fallback chain.`;
  }

  if (bestText.length > 0) {
    return {
      text: bestText,
      selector_used: bestTag,
      candidate_evaluations: evaluations,
      description_contaminated: false,
      contamination_reasons: [],
      container_dump_top5,
      container_dump_full,
      container_resolution_debug: {
        candidates: container_resolution_candidates.slice(0, 40),
        selected: bestTag,
        selection_reason: selectionReason,
        total_candidates: bucket.length,
        top5_preview: container_dump_top5,
      },
    };
  }

  const bodyText = getVisibleText(document.body);
  if (bodyText && bodyText.length > 400) {
    const bcont = detectDescriptionContamination(bodyText, title, company);
    if (!bcont.contaminated) {
      selectionReason =
        "Fallback: document.body innerText (passed contamination check); no scored layout container produced usable text.";
      return {
        text: bodyText,
        selector_used: "document.body_fallback",
        candidate_evaluations: evaluations,
        description_contaminated: false,
        contamination_reasons: [],
        container_dump_top5,
        container_dump_full,
        container_resolution_debug: {
          candidates: container_resolution_candidates.slice(0, 40),
          selected: "document.body_fallback",
          selection_reason: selectionReason,
          total_candidates: bucket.length,
          top5_preview: container_dump_top5,
        },
      };
    }
  }

  const allLongContaminated =
    bucket.length > 0 &&
    evaluations.filter((e) => e.length >= 40).length > 0 &&
    evaluations.filter((e) => e.length >= 40 && !e.contaminated).length === 0;

  let worstReasons = ["no_usable_non_contaminated_text"];
  if (!bucket.length) worstReasons = ["no_candidate_elements"];
  else if (allLongContaminated) {
    worstReasons = ["all_substantial_candidates_contaminated"];
  } else if (evaluations.length && evaluations.every((e) => e.contaminated)) {
    worstReasons = ["all_candidates_contaminated"];
  }

  return {
    text: "",
    selector_used: null,
    candidate_evaluations: evaluations,
    description_contaminated: true,
    contamination_reasons: worstReasons,
    container_dump_top5,
    container_dump_full,
    container_resolution_debug: {
      candidates: container_resolution_candidates.slice(0, 40),
      selected: null,
      selection_reason:
        "No non-contaminated container text after expanded gather + fallbacks; see container_dump_top5.",
      total_candidates: bucket.length,
      top5_preview: container_dump_top5,
    },
  };
}

/** Short pause between full extraction retries (wait loop runs each attempt). */
function sleepBeforeExtractionAttempt(attemptIndex) {
  if (attemptIndex >= 1) return sleep(250);
  return Promise.resolve();
}

/**
 * Job description via best candidate scoring (title, company, length, contamination).
 */
function extractJobDescriptionWithMeta(detailRoot, title, company) {
  const t = title != null ? title : getJobTitle() || "";
  const c = company != null ? company : getCompany() || "";
  return extractJobDescriptionWithBestCandidate(detailRoot, t, c);
}

/**
 * Job description only from the detail pane — best candidate wins.
 */
function extractJobDescriptionStrict(detailRoot, title, company) {
  const t = title != null ? title : getJobTitle() || "";
  const co = company != null ? company : getCompany() || "";
  return extractJobDescriptionWithBestCandidate(detailRoot, t, co).text;
}

function buildExtractionDebugFields(
  pageMode,
  title,
  company,
  location,
  jobDescription,
  contamination,
  containerFound,
  selectorUsed,
  candidateMeta,
  headerMeta
) {
  const jd = jobDescription ? String(jobDescription) : "";
  const c = contamination || { contaminated: false, reasons: [] };
  const cm = candidateMeta || {};
  const hm = headerMeta || {};
  const evals = cm.candidate_evaluations || [];
  return {
    page_mode: pageMode,
    container_found: !!containerFound,
    selector_used: selectorUsed || null,
    chosen_selector: selectorUsed || null,
    selector_candidates: evals.map((e) => e.selector),
    candidate_lengths: evals.map((e) => e.length),
    candidate_contamination_flags: evals.map((e) => e.contaminated),
    extracted_title: title || "",
    extracted_company: company || "",
    extracted_location: location || null,
    raw_title: hm.raw_title ?? null,
    normalized_title: hm.normalized_title ?? null,
    raw_company: hm.raw_company ?? null,
    normalized_company: hm.normalized_company ?? null,
    raw_location: hm.raw_location ?? null,
    normalized_location: hm.normalized_location ?? null,
    title_selector_used: hm.title_selector_used ?? null,
    company_selector_used: hm.company_selector_used ?? null,
    title_extraction_attempts: hm.title_extraction_attempts || [],
    company_extraction_attempts: hm.company_extraction_attempts || [],
    header_extraction_flags: hm.header_extraction_flags || [],
    title_candidates: hm.title_candidates || [],
    title_selection_reason: hm.title_selection_reason || null,
    container_resolution_debug: cm.container_resolution_debug || null,
    container_dump_top5: cm.container_dump_top5 || null,
    container_dump_full: cm.container_dump_full || null,
    description_length: jd.length,
    description_preview_500: jd.slice(0, 500),
    contamination_detected: !!c.contaminated,
    contamination_reasons: c.reasons || [],
    candidate_evaluations: evals,
  };
}

function isAboutTheJobSignalPresentInText(text) {
  const s = String(text || "").slice(0, 120000);
  if (/about the job/i.test(s)) return true;
  return countSectionHeadingPhrases(s) >= 1;
}

/** Full /jobs/view/: meaningful if long enough, or shorter chunk with clear job-description signals (not contaminated). */
function isMeaningfulFullViewDescription(rawLen, text, contaminated) {
  if (contaminated) return false;
  if (rawLen >= 200) return true;
  const t = String(text || "");
  if (rawLen >= 40 && isAboutTheJobSignalPresentInText(t)) return true;
  return false;
}

function shouldRetryExtractionAttempt(payload) {
  const rawLen = payload.extraction_debug?.description_length ?? 0;
  const contaminated = !!payload.description_contaminated;
  const text = payload.job_description || "";
  if (payload.page_mode === "results_panel_mode") {
    return contaminated || rawLen < 40;
  }
  if (payload.page_mode === "full_view_mode") {
    return (
      contaminated ||
      !isMeaningfulFullViewDescription(rawLen, text, contaminated)
    );
  }
  return contaminated || rawLen < 150;
}

/**
 * After retries: results panel ≥40 chars; full view = meaningful body rule; legacy fallback ≥150.
 */
function finalizeExtractionPayload(payload) {
  const rawLen = payload.extraction_debug?.description_length ?? 0;
  const contaminated = !!payload.description_contaminated;
  const isRp = payload.page_mode === "results_panel_mode";
  const isFv = payload.page_mode === "full_view_mode";
  const jd = payload.job_description || "";
  let reason = null;
  let descOk = false;
  let clearedContamination = false;

  if (contaminated) {
    if (isRp && rawLen >= 40) {
      const snap = getResultsPanelReadinessSnapshot({ clearPairCache: false });
      if (snap.ready) {
        descOk = true;
        reason = null;
        clearedContamination = true;
      } else {
        reason = "contaminated_search_results";
        descOk = false;
      }
    } else {
      reason = "contaminated_search_results";
      descOk = false;
    }
  } else if (isRp) {
    descOk = rawLen >= 40;
    if (rawLen === 0) reason = "empty_description";
    else if (!descOk) reason = "short_description";
  } else if (isFv) {
    descOk = isMeaningfulFullViewDescription(rawLen, jd, false);
    if (rawLen === 0) reason = "empty_description";
    else if (!descOk) reason = "short_description";
  } else {
    descOk = rawLen >= 150;
    if (rawLen === 0) reason = "empty_description";
    else if (!descOk) reason = "short_description";
  }

  const ok = descOk;

  let extraction_mode = "failed";
  if (ok) {
    if (isFv) {
      if (rawLen >= 300) extraction_mode = "full";
      else if (rawLen >= 200) extraction_mode = "partial";
      else extraction_mode = "partial";
    } else if (rawLen >= 300) extraction_mode = "full";
    else if (rawLen >= 150) extraction_mode = "partial";
    else extraction_mode = "minimal";
  }

  const out = {
    ...payload,
    extraction_failed: !ok,
    extraction_mode,
    extraction_failure_reason: ok ? null : reason,
    description_contaminated: clearedContamination
      ? false
      : payload.description_contaminated,
    extraction_debug: {
      ...payload.extraction_debug,
      final_failure_reason: ok ? null : reason,
      extraction_mode,
    },
  };
  if (!ok) {
    out.job_description = "";
  }
  return out;
}


function isResultsPanelReady() {
  const snap = getResultsPanelReadinessSnapshot({ clearPairCache: true });
  jcVerboseLog("[READY CHECK] results panel snapshot", snap);
  return !!snap.ready;
}

function isFullViewReady() {
  const title = (getJobTitle() || "").trim();
  const company = (getCompany() || "").trim();
  const hasTitle =
    !!title &&
    !isInvalidPromoTitle(title) &&
    !isLikelyNoiseTitle(title);
  const ready = !!(hasTitle && company);

  jcVerboseLog("[READY CHECK]", {
    title,
    company,
    ready,
  });

  return ready;
}

async function waitForResultsPanelReady(maxAttempts = 10) {
  for (let i = 1; i <= maxAttempts; i++) {
    jcVerboseLog(`[READY CHECK] results panel attempt: ${i}`);
    const snap = getResultsPanelReadinessSnapshot({
      clearPairCache: i === 1,
    });
    if (snap.ready) {
      jcVerboseLog("[READY CHECK] ✅ READY");
      return true;
    }
    await sleep(800);
  }
  jcVerboseLog("[READY CHECK] ❌ NOT READY");
  return false;
}

async function waitForFullViewReady(maxAttempts = 10) {
  jcVerboseLog("[FLOW] about to run view readiness");
  for (let i = 1; i <= maxAttempts; i++) {
    jcVerboseLog(`[READY CHECK] full view attempt: ${i}`);
    if (isFullViewReady()) {
      jcVerboseLog("[READY CHECK] ✅ READY");
      return true;
    }
    await sleep(800);
  }
  jcVerboseLog("[READY CHECK] ❌ NOT READY (timeout); proceeding to extract");
  return false;
}

/** Active job detail panel (right side) — legacy; prefer getDescriptionRoot() for roots. */
function getJobDetailContainer() {
  return (
    document.querySelector(".jobs-search__job-details--container") ||
    document.querySelector(".jobs-details") ||
    null
  );
}

function extractLinkedInJobId() {
  try {
    const href = window.location.href || "";
    const u = new URL(href);
    const fromQuery = u.searchParams.get("currentJobId");
    if (fromQuery && /^\d+$/.test(fromQuery.trim())) {
      return fromQuery.trim();
    }
    let m = u.pathname.match(/\/jobs\/view\/(\d+)/);
    if (m) return m[1];
    m = href.match(/[?&]currentJobId=(\d+)/);
    if (m) return m[1];
  } catch (e) {
    /* ignore */
  }
  return "";
}

/**
 * Canonical job URL for API — uses the real page URL (content script only; not the extension popup).
 */
function getCleanJobUrl() {
  const currentUrl = window.location.href;

  if (currentUrl.includes("/jobs/view/")) {
    return currentUrl.split("?")[0];
  }

  const match = currentUrl.match(/currentJobId=(\d+)/);
  if (match) {
    return `https://www.linkedin.com/jobs/view/${match[1]}/`;
  }

  const viewMatch = currentUrl.match(/\/jobs\/view\/(\d+)/);
  if (viewMatch) {
    return `https://www.linkedin.com/jobs/view/${viewMatch[1]}/`;
  }

  return null;
}

function normalizeSourceUrlForApi() {
  const raw = window.location.href || "";
  const cleanJobUrl = getCleanJobUrl();
  jcVerboseLog("[URL NORMALIZATION] raw:", raw);
  jcVerboseLog("[URL NORMALIZATION] clean:", cleanJobUrl);
  jcVerboseLog("[URL NORMALIZATION] length:", cleanJobUrl ? cleanJobUrl.length : 0);
  return cleanJobUrl ? cleanJobUrl.slice(0, 500) : null;
}

/** Same root as job detail container for description + legacy callers. */
function findMainJobPane() {
  return (
    getJobDetailContainer() ||
    document.querySelector(".jobs-details__main-content") ||
    document.querySelector(".scaffold-layout__detail") ||
    null
  );
}

function isLikelyNoiseTitle(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t || t.length > 280) return true;
  if (/^(skip to|linkedin|search|jobs|sign in)/i.test(t)) return true;
  return false;
}

function isInvalidPromoTitle(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("top job picks")) return true;
  if (t.includes("jobs where you'd be a top applicant")) return true;
  if (t.includes("jobs where you’d be a top applicant")) return true;
  if (t.includes("jobs where") && t.includes("top applicant")) return true;
  // LinkedIn Premium widgets bleed into title selection on some layouts.
  if (isLinkedInPremiumUiText(t)) return true;
  return false;
}

/**
 * True when text matches LinkedIn Premium / sidebar widget copy. These nodes
 * sometimes outrank the real job title or company in the candidate list and
 * need to be filtered out before selection.
 */
function isLinkedInPremiumUiText(s) {
  const t = (s || "").toLowerCase();
  if (!t) return false;
  if (t.includes("exclusive job seeker insights")) return true;
  if (t.includes("show premium insights")) return true;
  if (t.includes("premium insights")) return true;
  if (t.includes("use ai to assess")) return true;
  if (t.includes("ai to assess how you fit")) return true;
  if (t.includes("looking for talent")) return true;
  if (t.includes("post a job")) return true;
  if (t.includes("tailor my resume")) return true;
  if (t.includes("create cover letter")) return true;
  if (t.includes("help me stand out")) return true;
  if (t.includes("show match details")) return true;
  if (t.includes("retry premium for free")) return true;
  if (t.includes("try premium")) return true;
  // LinkedIn apply flow / post-apply modal copy that can outrank the real title.
  if (t.includes("put your best foot forward")) return true;
  if (t.includes("your application has been")) return true;
  if (t.includes("application sent")) return true;
  if (t.includes("you applied")) return true;
  if (t.includes("review your application")) return true;
  if (t.includes("submit application")) return true;
  if (t.includes("save this job")) return true;
  // LinkedIn post-apply / comparison widgets that surface after you've applied.
  if (t.includes("see how you compare")) return true;
  if (t.includes("how you compare to others")) return true;
  if (t.includes("others who clicked apply")) return true;
  if (t.includes("people clicked apply")) return true;
  if (t.includes("be an early applicant")) return true;
  return false;
}

function cleanJobTitle(title) {
  if (!title) return title;
  return title.replace(/\(.*?\)/g, "").trim();
}

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normalizeLocationText(loc) {
  let t = normalizeWhitespace(loc);
  if (!t) return "";
  t = t.replace(/\s*,\s*United States\s*$/i, "").trim();
  t = t.replace(/\s+United States\s*$/i, "").trim();
  t = t.replace(/\s*,\s*USA\s*$/i, "").trim();
  t = t.replace(/\s+USA\s*$/i, "").trim();
  t = t.replace(/\s+US\s*$/i, "").trim();
  t = t.replace(/^[,·•\s]+|[,·•\s]+$/g, "").trim();
  return t;
}

/**
 * Dedupe accidental repeated title phrases (e.g. duplicated line breaks merged into one string).
 */
function dedupeTitleFragments(t) {
  const s = normalizeWhitespace(t);
  if (!s || s.length < 12) return s;
  const words = s.split(/\s+/);
  if (words.length < 6) return s;
  for (let len = Math.min(6, Math.floor(words.length / 2)); len >= 2; len--) {
    for (let i = 0; i + 2 * len <= words.length; i++) {
      const a = words.slice(i, i + len).join(" ").toLowerCase();
      const b = words.slice(i + len, i + 2 * len).join(" ").toLowerCase();
      if (a === b && a.length > 6) {
        return words.slice(0, i + len).join(" ");
      }
    }
  }
  return s;
}

const TITLE_ROLE_WORD_RE =
  /\b(manager|director|lead|head|vp|vice\s+president|president|engineer|developer|analyst|designer|specialist|architect|scientist|officer|executive|coordinator|associate|consultant|partner|chief|owner|founder|staff|principal|senior|junior|intern|rep|representative|gtm|sales|marketing|product|operations|enablement)\b/i;

function titleHasCityStatePattern(s) {
  return /\b[A-Za-z][A-Za-z\s.'-]{0,48},\s*[A-Z]{2}\b/.test(s);
}

function titleHasAtEmployerMarker(s) {
  return /\s@\s/.test(s);
}

/**
 * Title pollution penalty for candidate ranking (company unknown).
 */
function titlePollutionPenalty(t) {
  const s = String(t || "");
  let p = 0;
  if (titleHasAtEmployerMarker(s)) p += 650;
  if (/\s·\s/.test(s) && s.length > 45) p += 280;
  if (titleHasCityStatePattern(s)) p += 480;
  if (/\bUnited States\b|\bUSA\b(?!\w)/i.test(s)) p += 220;
  if (s.length > 95) p += (s.length - 95) * 1.5;
  return p;
}

/**
 * Dedicated parser: raw title / meta line → job title only (no company, no location).
 * Uses normalized company + location when available.
 */
function parseCleanJobTitle(raw, companyNorm, locationNorm) {
  let t = normalizeWhitespace(raw);
  if (!t) return "";

  t = t.replace(/\([^)]{0,200}\)/g, "").trim();

  if (titleHasAtEmployerMarker(t)) {
    t = t.split(/\s@\s/)[0].trim();
  }

  const dotChunks = t.split(/\s*[·•]\s*/);
  if (dotChunks.length >= 2) {
    const left = dotChunks[0].trim();
    const right = dotChunks.slice(1).join(" · ");
    const rLow = right.toLowerCase();
    const cn = normalizeWhitespace(companyNorm || "").toLowerCase();
    if (
      titleHasCityStatePattern(right) ||
      /\bUnited States\b/i.test(right) ||
      (cn && rLow.includes(cn)) ||
      (right.length < t.length * 0.55 && titleHasCityStatePattern(t) && !titleHasCityStatePattern(left))
    ) {
      t = left;
    } else if (left.length >= 10 && left.length <= t.length * 0.62) {
      t = left;
    }
  }

  const dashParts = t.split(/\s+-\s+/);
  if (dashParts.length >= 2) {
    const left = dashParts[0].trim();
    const right = dashParts.slice(1).join(" - ").trim();
    const cn = normalizeWhitespace(companyNorm || "").toLowerCase();
    if (
      titleHasCityStatePattern(right) ||
      (cn && right.toLowerCase().includes(cn) && left.length >= 6)
    ) {
      t = left;
    }
  }

  for (let pass = 0; pass < 4; pass++) {
    const next = t
      .replace(
        /,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}\s*$/i,
        ""
      )
      .trim();
    if (next === t) break;
    t = next;
  }

  t = t
    .replace(/\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}\s*$/i, "")
    .trim();

  t = t.replace(/\s*,\s*United States\s*$/i, "").trim();
  t = t.replace(/\s+United States\s*$/i, "").trim();

  const cn = normalizeWhitespace(companyNorm || "");
  if (cn.length >= 2) {
    const esc = cn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`\\s*[,·]\\s*${esc}\\s*$`, "i"), "").trim();
    t = t.replace(new RegExp(`\\s+${esc}\\s*$`, "i"), "").trim();
    t = t.replace(new RegExp(`\\s+${esc}(?=\\s*[,·]|\\s*$)`, "gi"), " ").trim();
    t = t.replace(new RegExp(`\\b${esc}\\b`, "gi"), " ").trim();
  }

  const loc = normalizeWhitespace(locationNorm || "");
  if (loc.length >= 3) {
    const le = loc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`[,\\s]+${le}\\s*$`, "i"), "").trim();
    t = t.replace(new RegExp(`\\s*-\\s*${le}\\s*$`, "i"), "").trim();
  }

  t = t.replace(/\s+-\s+[A-Za-z][A-Za-z\s.'-]+,\s*[A-Z]{2}\s*$/i, "").trim();

  t = dedupeTitleFragments(t);
  t = normalizeWhitespace(t).replace(/\s{2,}/g, " ");
  return t.replace(/^[,·•\s|-]+|[,·•\s|-]+$/g, "").trim();
}

function scoreTitleCandidateForRanking(c, detailRoot) {
  const base = scoreTitleCandidate(c, detailRoot);
  const pen = titlePollutionPenalty(c.text);
  let bonus = 0;
  if (TITLE_ROLE_WORD_RE.test(c.text)) bonus += 90;
  const wc = wordCountTitle(c.text);
  if (wc >= 3 && wc <= 14) bonus += 40;
  return base - pen + bonus;
}

/**
 * Strip employee counts, followers, connections, "I'm interested", location junk from company line.
 */
function cleanCompanyText(raw) {
  if (!raw) return "";
  let s = String(raw).replace(/\r\n/g, "\n");
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  s = lines[0] || s;
  s = s.replace(/\s+/g, " ").trim();

  // Reject LinkedIn Premium widget copy that occasionally outranks the real
  // company name in the candidate list (e.g. "Show Premium Insights").
  if (isLinkedInPremiumUiText(s)) return "";

  s = s.replace(/\d[\d,]*\+?\s*(employees?|followers?)/gi, "").trim();
  s = s.replace(/\d[\d,.]*\s*(employees?|followers?)/gi, "").trim();
  s = s.replace(/\d+\+?\s*connections?/gi, "").trim();
  s = s.replace(/I[''\u2019]m interested/gi, "").trim();
  s = s.replace(/\b\d+\s*school\s*alumni\b/gi, "").trim();

  if (/[·•]/.test(s)) {
    s = s.split(/[·•]/)[0].trim();
  }
  if (/\s\|\s/.test(s)) {
    const left = s.split(/\s\|\s/)[0];
    if (left.length < 100) s = left.trim();
  }
  s = s.replace(/\s*·\s*$/, "").trim();
  s = s.replace(/,\s*[A-Z]{2}\s*$/, "").trim();

  return s.slice(0, 200).trim();
}

const COMPANY_LINK_EXCLUDE =
  /^(see all|follow|show more|visit|website|about|jobs at)/i;

/**
 * Fallback company: shortest plausible /company/ link inside the same panel only.
 */
function extractCompanyFromContainerFallback(jobContainer) {
  if (!jobContainer) return "";
  const links = jobContainer.querySelectorAll('a[href*="/company/"]');
  const candidates = [];
  for (const a of links) {
    const t = cleanCompanyText(getVisibleText(a));
    if (!t || t.length < 2) continue;
    if (t.length > 120) continue;
    if (COMPANY_LINK_EXCLUDE.test(t)) continue;
    candidates.push(t);
  }
  if (!candidates.length) return "";
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}

/**
 * LinkedIn full /jobs/view/ page: top card may live outside search-only containers.
 */
function getFullViewTopCardElement() {
  return (
    document.querySelector(".jobs-unified-top-card") ||
    document.querySelector("[class*='jobs-unified-top-card']") ||
    document.querySelector("[class*='jobs-details-top-card']") ||
    null
  );
}

/**
 * Prefer a root that contains the visible job header card on full-view pages.
 */
function getFullViewScopedRootForHeader() {
  const card = getFullViewTopCardElement();
  if (card) {
    const scoped = card.closest(
      ".jobs-details__main-content, .job-view-layout, .scaffold-layout__main, .jobs-details, .scaffold-layout__detail, [class*='job-view-layout'], [class*='jobs-details'], [class*='jobs-search__job-details']"
    );
    if (scoped) return scoped;
    const p = card.parentElement;
    if (p) return p;
  }
  return (
    document.querySelector(".jobs-details__main-content") ||
    document.querySelector(".job-view-layout") ||
    document.querySelector("[class*='jobs-details']") ||
    document.querySelector("main.scaffold-layout__main") ||
    document.querySelector("main") ||
    null
  );
}

/**
 * Same pane as job description: prefer LinkedIn search detail container, then active detail root.
 * Full-view (/jobs/view/): anchor to top job card / main content so title/company selectors match DOM.
 */
function getDetailPaneRootForHeaderExtraction() {
  const href = window.location.href || "";
  if (isLinkedInFullJobViewPath(href)) {
    const fvRoot = getFullViewScopedRootForHeader();
    if (fvRoot && !isNodeInSearchResultsListRail(fvRoot)) {
      return fvRoot;
    }
  }
  if (shouldUseResultsPanelRootHref(href)) {
    const rp = resolveResultsPanelJobDetailRoot();
    if (rp && !isNodeInSearchResultsListRail(rp)) {
      return rp;
    }
  }
  const container = document.querySelector(
    ".jobs-search__job-details--container"
  );
  if (container && !isNodeInSearchResultsListRail(container)) {
    return container;
  }
  const active = getActiveJobDetailRoot();
  if (active) return active;
  return findMainJobPane() || null;
}

function findLocalHeaderRegion(detailRoot) {
  if (!detailRoot) return null;
  const topGlobal = getFullViewTopCardElement();
  if (topGlobal && detailRoot.contains(topGlobal)) return topGlobal;
  const block =
    detailRoot.querySelector(".jobs-unified-top-card") ||
    detailRoot.querySelector("[class*='jobs-unified-top-card']") ||
    detailRoot.querySelector("[class*='job-details-jobs-unified']") ||
    detailRoot.querySelector("[class*='jobs-details-top-card']") ||
    detailRoot.querySelector("header") ||
    detailRoot.querySelector("[role='banner']");
  if (block) return block;
  const h = detailRoot.querySelector("h1, h2");
  if (h && h.parentElement && h.parentElement !== detailRoot) {
    return h.parentElement;
  }
  return detailRoot;
}

function findApplyOrSaveInHeader(headerEl) {
  if (!headerEl || !headerEl.querySelectorAll) return null;
  const candidates = headerEl.querySelectorAll(
    "button, a[role='button'], a.artdeco-button, a"
  );
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    const t = (getVisibleText(el) || "").toLowerCase();
    if (!t) continue;
    if (/\b(apply|easy apply|saved?|save)\b/i.test(t)) return el;
  }
  return null;
}

/**
 * Top visible heading near Apply / Save on the job header card.
 */
function findHeadingNearApplySave(headerRegion) {
  if (!headerRegion) return null;
  const btn = findApplyOrSaveInHeader(headerRegion);
  if (!btn) return null;
  let n = btn;
  for (let depth = 0; depth < 12 && n; depth++) {
    const hs = n.querySelectorAll("h1, h2");
    for (let i = 0; i < hs.length; i++) {
      const t = getFullTitleTextFromElement(hs[i]);
      if (t.length >= 3 && t.length <= 320 && !isLikelyNoiseTitle(t)) return hs[i];
    }
    let sib = n.previousElementSibling;
    let steps = 0;
    while (sib && steps < 6) {
      if (sib.matches && sib.matches("h1, h2")) {
        const t = getFullTitleTextFromElement(sib);
        if (t.length >= 3 && t.length <= 320 && !isLikelyNoiseTitle(t)) return sib;
      }
      const inner = sib.querySelector && sib.querySelector("h1, h2");
      if (inner) {
        const t = getFullTitleTextFromElement(inner);
        if (t.length >= 3 && t.length <= 320 && !isLikelyNoiseTitle(t)) return inner;
      }
      sib = sib.previousElementSibling;
      steps += 1;
    }
    n = n.parentElement;
  }
  return null;
}

/**
 * Visible text block above the metadata / insight row (company · location).
 */
function findTextBlockAboveMetadataRow(headerRegion) {
  if (!headerRegion) return null;
  const meta =
    headerRegion.querySelector(
      ".jobs-unified-top-card__primary-description, .jobs-unified-top-card__job-insight, [class*='jobs-unified-top-card__bullet'], [class*='job-insight'], [class*='jobs-unified-top-card__subtitle']"
    ) || null;
  if (!meta) return null;
  let prev = meta.previousElementSibling;
  let guard = 0;
  while (prev && guard < 8) {
    const t = getFullTitleTextFromElement(prev);
    if (t.length >= 8 && t.length <= 320 && !isLikelyNoiseTitle(t)) return prev;
    const h = prev.querySelector && prev.querySelector("h1, h2");
    if (h) {
      const ht = getFullTitleTextFromElement(h);
      if (ht.length >= 3 && ht.length <= 320 && !isLikelyNoiseTitle(ht)) return h;
    }
    prev = prev.previousElementSibling;
    guard += 1;
  }
  return null;
}

/**
 * Full-view only: ordered title fallbacks scoped to the header card (before generic selectors).
 */
function collectFullViewPriorityTitleCandidates(headerRegion, attemptsT) {
  const collected = [];
  const add = (text, source, el, strategy) => {
    const t = (text || "").replace(/\s+/g, " ").trim();
    if (!t || t.length < 2 || t.length > 320) return;
    if (isLikelyNoiseTitle(t)) return;
    if (isInvalidPromoTitle(t)) return;
    attemptsT.push(`fullview_title «${source}»`);
    collected.push({ text: t, source, el: el || null, strategy });
  };

  if (!headerRegion) return collected;

  const h1 = headerRegion.querySelector("h1");
  if (h1) {
    const full = getFullTitleTextFromElement(h1);
    if (full) add(full, "fullview:h1", h1, "fullview_priority");
  }

  let testIdNodes = [];
  try {
    testIdNodes = Array.from(
      headerRegion.querySelectorAll("[data-test-id*='job'], [data-test-id*='Job']")
    );
  } catch (_e) {
    /* ignore */
  }
  for (let i = 0; i < testIdNodes.length; i++) {
    const el = testIdNodes[i];
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "script" || tag === "style") continue;
    const full = getFullTitleTextFromElement(el);
    if (full.length >= 3) {
      add(full, `fullview:data-test-id-job[${i}]`, el, "fullview_priority");
      break;
    }
  }

  const nearApply = findHeadingNearApplySave(headerRegion);
  if (nearApply) {
    const full = getFullTitleTextFromElement(nearApply);
    if (full) add(full, "fullview:heading_near_apply_save", nearApply, "fullview_priority");
  }

  const aboveMeta = findTextBlockAboveMetadataRow(headerRegion);
  if (aboveMeta) {
    const full = getFullTitleTextFromElement(aboveMeta);
    if (full && full.length >= 8) {
      add(full, "fullview:text_above_metadata_row", aboveMeta, "fullview_priority");
    }
  }

  return collected;
}

/**
 * Full-view company: link near title, then top-card classes, then subtitle/metadata line.
 */
function tryFullViewCompanyFromHeader(headerRegion, titleEl, attemptsC) {
  if (!headerRegion) return null;

  const tryCompanyText = (raw, label) => {
    const t = cleanCompanyText(raw);
    if (!t || t.length < 2 || t.length > 120) return null;
    if (COMPANY_LINK_EXCLUDE.test(t)) return null;
    attemptsC.push(`${label}: OK`);
    return { text: t, source: label };
  };

  if (titleEl) {
    let anc = titleEl;
    for (let d = 0; d < 6 && anc; d++) {
      const links = anc.querySelectorAll('a[href*="/company/"]');
      for (let i = 0; i < links.length; i++) {
        const hit = tryCompanyText(
          getVisibleText(links[i]),
          `fullview:company_link_near_title_d${d}[${i}]`
        );
        if (hit) return hit;
      }
      anc = anc.parentElement;
    }
  }

  const companySelsFv = [
    ".jobs-unified-top-card__company-name",
    ".jobs-company__name",
    "a.jobs-unified-top-card__company-name",
    "[class*='company-name'] a",
    "[class*='company-name']",
    "a[href*='/company/']",
  ];
  for (let si = 0; si < companySelsFv.length; si++) {
    const el = headerRegion.querySelector(companySelsFv[si]);
    if (!el) {
      attemptsC.push(`fullview «${companySelsFv[si]}»: not found`);
      continue;
    }
    const hit = tryCompanyText(
      getVisibleText(el),
      `fullview:${companySelsFv[si]}`
    );
    if (hit) return hit;
  }

  const sub =
    headerRegion.querySelector(
      ".jobs-unified-top-card__subtitle, [class*='jobs-unified-top-card__subtitle'], [class*='top-card__subtitle']"
    ) || null;
  if (sub) {
    const line = getVisibleText(sub).split(/\n/)[0] || "";
    const parts = line.split(/[·•|]/).map((x) => x.trim()).filter(Boolean);
    if (parts[0]) {
      const hit = tryCompanyText(parts[0], "fullview:subtitle_first_segment");
      if (hit) return hit;
    }
  }

  const fb = extractCompanyFromContainerFallback(headerRegion);
  if (fb) {
    attemptsC.push("fullview:extractCompanyFromContainerFallback: OK");
    return { text: fb, source: "fullview:extractCompanyFromContainerFallback" };
  }
  attemptsC.push("fullview: company fallbacks empty");
  return null;
}

/** Role / level tokens — used to prefer complete titles over truncated UI lines. */
const TITLE_ROLE_LEVEL_RE =
  /\b(senior|staff|principal|lead|manager|director|head|vp|vice|president|engineer|developer|analyst|designer|specialist|architect|scientist|officer|executive|gtm|commercial|product|marketing|sales|operations|strategy|consultant|associate|coordinator|supervisor|chief)\b/i;

function wordCountTitle(s) {
  return (s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Prefer longest plausible full title: innerText vs textContent, aria-label, title attr,
 * and visually-hidden / sr-only siblings in the top card.
 */
function getFullTitleTextFromElement(el) {
  if (!el) return "";
  const candidates = [];
  const push = (s) => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    if (t) candidates.push(t);
  };
  push(el.innerText);
  push(el.textContent);
  push(el.getAttribute && el.getAttribute("aria-label"));
  push(el.getAttribute && el.getAttribute("title"));
  const card =
    el.closest &&
    el.closest(
      ".jobs-unified-top-card, .jobs-search__job-details--container, [class*='job-details'], [class*='top-card']"
    );
  if (card) {
    const hidden = card.querySelector(
      "[class*='visually-hidden'], .sr-only, [class*='screen-reader'], [class*='a11y-text']"
    );
    if (hidden) push(hidden.textContent);
  }
  let best = "";
  for (const c of candidates) {
    if (isLikelyNoiseTitle(c)) continue;
    if (c.length > best.length) best = c;
  }
  return best.trim();
}

function titleFromDocumentTitleAndMeta(detailRoot) {
  const out = [];
  const dt = (document.title || "").trim();
  if (dt) {
    let t = dt.replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
    const pipe = t.indexOf("|");
    if (pipe > 0) t = t.slice(0, pipe).trim();
    const dash = t.match(/^(.+?)\s+[-\u2013]\s+/);
    if (dash) t = dash[1].trim();
    if (t.length >= 3 && t.length < 280 && !/^linkedin$/i.test(t)) {
      out.push({ text: t, source: "document.title", strategy: "fallback" });
    }
  }
  const og = document.querySelector('meta[property="og:title"]');
  if (og) {
    const c = (og.getAttribute("content") || "").trim();
    if (
      c.length >= 3 &&
      c.length < 280 &&
      !/^linkedin$/i.test(c) &&
      !isLikelyNoiseTitle(c)
    ) {
      out.push({ text: c, source: "og:title", strategy: "fallback" });
    }
  }
  if (detailRoot) {
    const ja = detailRoot.querySelector('script[type="application/ld+json"]');
    if (ja && ja.textContent) {
      try {
        const j = JSON.parse(ja.textContent);
        const name = j.title || j.name || (j["@graph"] && j["@graph"][0] && j["@graph"][0].title);
        if (typeof name === "string" && name.length >= 3 && name.length < 280) {
          out.push({ text: name.trim(), source: "ld+json", strategy: "fallback" });
        }
      } catch (e) {
        /* ignore */
      }
    }
  }
  return out;
}

/**
 * Collect many title candidates (primary → secondary → fallback). Does not pick a winner.
 */
function collectJobTitleCandidates(detailRoot, headerRegion, attemptsT) {
  const seen = new Set();
  const add = (text, source, el, strategy) => {
    const t = (text || "").replace(/\s+/g, " ").trim();
    if (!t || t.length < 2 || t.length > 320) return;
    if (isLikelyNoiseTitle(t)) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    attemptsT.push(`candidate: ${strategy} «${source}» (${wordCountTitle(t)} words, len=${t.length})`);
    return { text: t, source, el: el || null, strategy };
  };

  const collected = [];
  const tryPush = (text, source, el, strategy) => {
    const o = add(text, source, el, strategy);
    if (o) collected.push(o);
  };

  const hrefFv = window.location.href || "";
  if (hrefFv.includes("/jobs/view/") && headerRegion) {
    const fvCands = collectFullViewPriorityTitleCandidates(
      headerRegion,
      attemptsT
    );
    for (let fi = 0; fi < fvCands.length; fi++) {
      const fc = fvCands[fi];
      tryPush(fc.text, fc.source, fc.el, fc.strategy);
    }
  }

  const regions =
    headerRegion && headerRegion !== detailRoot
      ? [headerRegion, detailRoot]
      : [detailRoot];

  const primarySelectors = [
    '[data-test-id="job-title"]',
    ".jobs-unified-top-card__job-title",
    "h1.jobs-unified-top-card__job-title",
    'h1[class*="job-title"]',
    ".jobs-details-top-card__title",
    ".jobs-details-top-card__title-text",
    "[class*='top-card'] h1",
    "[class*='job-details'] h1",
    "[class*='job-title']",
    "h1",
    "h2",
  ];

  for (let ri = 0; ri < regions.length; ri++) {
    const region = regions[ri];
    const tag = ri === 0 ? "header" : "detailRoot";
    for (let si = 0; si < primarySelectors.length; si++) {
      const sel = primarySelectors[si];
      const label = `${tag} «${sel}»`;
      let nodes = [];
      try {
        nodes = Array.from(region.querySelectorAll(sel));
      } catch (e) {
        attemptsT.push(`${label}: selector error`);
        continue;
      }
      if (!nodes.length) {
        attemptsT.push(`${label}: not found`);
        continue;
      }
      for (let ni = 0; ni < nodes.length; ni++) {
        const el = nodes[ni];
        const full = getFullTitleTextFromElement(el);
        tryPush(full, `${label}[${ni}]`, el, "primary");
        const vis = getVisibleText(el);
        if (vis && vis !== full) {
          tryPush(vis, `${label}[${ni}] innerText`, el, "primary");
        }
      }
    }
  }

  const secondarySelectors = [
    "[class*='job-title'] span",
    "[class*='top-card'] [class*='title']",
    "[class*='jobs-unified'] [class*='title']",
  ];
  for (const sel of secondarySelectors) {
    let nodes = [];
    try {
      nodes = Array.from(detailRoot.querySelectorAll(sel));
    } catch (e) {
      continue;
    }
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const full = getFullTitleTextFromElement(el);
      if (full.length >= 8 && full.length <= 320) {
        tryPush(full, `secondary «${sel}»[${i}]`, el, "secondary");
      }
    }
  }

  const headings = detailRoot.querySelectorAll("h1, h2");
  for (let i = 0; i < headings.length; i++) {
    const full = getFullTitleTextFromElement(headings[i]);
    tryPush(full, `heading h1/h2[${i}]`, headings[i], "secondary");
  }

  const metaCands = titleFromDocumentTitleAndMeta(detailRoot);
  for (let m = 0; m < metaCands.length; m++) {
    tryPush(
      metaCands[m].text,
      metaCands[m].source,
      null,
      metaCands[m].strategy
    );
  }

  return collected;
}

function scoreTitleCandidate(c, detailRoot) {
  const t = c.text;
  const wc = wordCountTitle(t);
  let score = Math.min(t.length, 400);
  if (TITLE_ROLE_LEVEL_RE.test(t)) score += 180;
  if (wc >= 3) score += 120;
  else score -= 100;
  if (c.el && detailRoot && detailRoot.contains(c.el)) score += 50;
  if (c.strategy === "fullview_priority") score += 220;
  if (c.strategy === "primary") score += 35;
  if (c.strategy === "secondary") score += 15;
  if (c.strategy === "fallback") score -= 25;
  return score;
}

/**
 * Prefer longest valid title with role keywords; if best has <3 words, prefer a longer candidate with ≥3 words when available.
 */
function selectBestJobTitle(candidates, detailRoot) {
  const title_candidates_debug = [];
  if (!candidates || !candidates.length) {
    return {
      text: null,
      el: null,
      title_selector_used: null,
      title_selection_reason: "no title candidates",
      title_candidates: title_candidates_debug,
    };
  }

  const scored = candidates.map((c) => {
    const sc = scoreTitleCandidateForRanking(c, detailRoot);
    return {
      ...c,
      wordCount: wordCountTitle(c.text),
      score: sc,
    };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.text.length - b.text.length;
  });

  for (let i = 0; i < scored.length; i++) {
    title_candidates_debug.push({
      text: scored[i].text.slice(0, 200),
      source: scored[i].source,
      strategy: scored[i].strategy,
      words: scored[i].wordCount,
      score: scored[i].score,
    });
  }

  let best = scored[0];
  const longEnough = scored.filter((s) => s.wordCount >= 3);
  if (best.wordCount < 3 && longEnough.length) {
    longEnough.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.text.length - a.text.length;
    });
    const alt = longEnough[0];
    return {
      text: alt.text,
      el: alt.el,
      title_selector_used: alt.source,
      title_selection_reason: `Swapped truncated-looking title (${best.wordCount} words: "${best.text.slice(0, 60)}") for candidate with ${alt.wordCount} words (score=${alt.score}).`,
      title_candidates: title_candidates_debug,
    };
  }

  return {
    text: best.text,
    el: best.el,
    title_selector_used: best.source,
    title_selection_reason: `Highest score (${best.score}); ${best.wordCount} words; strategy=${best.strategy}; roleKeyword=${TITLE_ROLE_LEVEL_RE.test(best.text)}; nearDetail=${!!(best.el && detailRoot && detailRoot.contains(best.el))}.`,
    title_candidates: title_candidates_debug,
  };
}

/**
 * Title + company scoped to the active detail pane (results panel + full view).
 * Logs every selector attempt for debugging.
 */
function extractTitleAndCompanyFromScopedPane(detailRoot) {
  const attemptsT = [];
  const attemptsC = [];
  if (!detailRoot) {
    return {
      title: null,
      company: null,
      raw_title: null,
      raw_company: null,
      raw_location: null,
      normalized_title: null,
      normalized_company: null,
      normalized_location: null,
      display_title: null,
      title_selector_used: null,
      company_selector_used: null,
      title_extraction_attempts: attemptsT,
      company_extraction_attempts: attemptsC,
      title_candidates: [],
      title_selection_reason: null,
    };
  }

  const headerRegion = findLocalHeaderRegion(detailRoot);
  const regions =
    headerRegion && headerRegion !== detailRoot
      ? [headerRegion, detailRoot]
      : [detailRoot];
  const titleCands = collectJobTitleCandidates(
    detailRoot,
    headerRegion,
    attemptsT
  );
  const picked = selectBestJobTitle(titleCands, detailRoot);
  let titleText = picked.text || null;
  let titleEl = picked.el || null;
  let titleSelectorUsed = picked.title_selector_used;
  attemptsT.push(`selected: ${titleSelectorUsed || "none"}`);
  attemptsT.push(`selection: ${picked.title_selection_reason || ""}`);

  const companySels = [
    ".jobs-unified-top-card__company-name",
    ".jobs-company__name",
    "a.jobs-unified-top-card__company-name",
    '[class*="company-name"] a',
    '[class*="company-name"]',
    'a[href*="/company/"]',
  ];

  let companyText = null;
  let companySelectorUsed = null;

  const hrefPane = window.location.href || "";
  const isFvPane = hrefPane.includes("/jobs/view/");
  if (isFvPane && headerRegion) {
    const fvCo = tryFullViewCompanyFromHeader(headerRegion, titleEl, attemptsC);
    if (fvCo && fvCo.text) {
      companyText = fvCo.text;
      companySelectorUsed = fvCo.source;
    }
  }

  if (!companyText) {
  for (let ri = 0; ri < regions.length; ri++) {
    const region = regions[ri];
    const tag = ri === 0 ? "header" : "detailRoot";
    for (let si = 0; si < companySels.length; si++) {
      const sel = companySels[si];
      const label = `${tag} «${sel}»`;
      const el = region.querySelector(sel);
      if (!el) {
        attemptsC.push(`${label}: not found`);
        continue;
      }
      const raw = cleanCompanyText(getVisibleText(el));
      if (!raw || raw.length < 2) {
        attemptsC.push(`${label}: empty`);
        continue;
      }
      if (COMPANY_LINK_EXCLUDE.test(raw)) {
        attemptsC.push(`${label}: excluded`);
        continue;
      }
      companyText = raw;
      companySelectorUsed = label;
      attemptsC.push(`${label}: OK`);
      break;
    }
    if (companyText) break;
  }
  }

  if (!companyText && titleEl) {
    let anc = titleEl.parentElement;
    for (let d = 0; d < 12 && anc; d++) {
      const as = anc.querySelectorAll('a[href*="/company/"]');
      for (let a = 0; a < as.length; a++) {
        const label = `near_title_ancestor_depth${d}_link[${a}]`;
        const raw = cleanCompanyText(getVisibleText(as[a]));
        attemptsC.push(`${label}: try`);
        if (raw && raw.length >= 2 && !COMPANY_LINK_EXCLUDE.test(raw)) {
          companyText = raw;
          companySelectorUsed = label;
          attemptsC.push(`${label}: OK`);
          break;
        }
      }
      if (companyText) break;
      anc = anc.parentElement;
    }
  }

  if (!companyText) {
    attemptsC.push("extractCompanyFromContainerFallback: try");
    const fb = extractCompanyFromContainerFallback(detailRoot);
    if (fb) {
      companyText = fb;
      companySelectorUsed = "extractCompanyFromContainerFallback";
      attemptsC.push("extractCompanyFromContainerFallback: OK");
    } else {
      attemptsC.push("extractCompanyFromContainerFallback: empty");
    }
  }

  const raw_title = titleText;
  const raw_company = companyText;
  const raw_location = getJobLocationFromDetailRoot(detailRoot);
  const normalized_company = cleanCompanyText(raw_company || "");
  const normalized_location = normalizeLocationText(raw_location || "");
  const normalized_title = parseCleanJobTitle(
    raw_title || "",
    normalized_company,
    normalized_location
  );

  if (isFvPane) {
    console.log("[JC FULLVIEW HEADER] rawTitleCandidate:", raw_title);
    console.log("[JC FULLVIEW HEADER] rawCompanyCandidate:", raw_company);
    console.log("[JC FULLVIEW HEADER] titleSelectorUsed:", titleSelectorUsed);
    console.log("[JC FULLVIEW HEADER] companySelectorUsed:", companySelectorUsed);
  }

  return {
    title: normalized_title || raw_title || null,
    company: normalized_company || raw_company || null,
    raw_title: raw_title || null,
    raw_company: raw_company || null,
    raw_location: raw_location || null,
    normalized_title: normalized_title || null,
    normalized_company: normalized_company || null,
    normalized_location: normalized_location || null,
    display_title: normalized_title || null,
    title_selector_used: titleSelectorUsed,
    company_selector_used: companySelectorUsed,
    title_extraction_attempts: attemptsT,
    company_extraction_attempts: attemptsC,
    title_candidates: picked.title_candidates || [],
    title_selection_reason: picked.title_selection_reason || null,
  };
}

let _titleCompanyPairCache = null;

function clearTitleCompanyPairCache() {
  _titleCompanyPairCache = null;
}

function getTitleCompanyPair() {
  const root = getDetailPaneRootForHeaderExtraction();
  if (!root) {
    return extractTitleAndCompanyFromScopedPane(null);
  }
  if (_titleCompanyPairCache && _titleCompanyPairCache.root === root) {
    return _titleCompanyPairCache.pair;
  }
  const pair = extractTitleAndCompanyFromScopedPane(root);
  _titleCompanyPairCache = { root, pair };
  return pair;
}

function getJobTitle() {
  const p = getTitleCompanyPair();
  const nt =
    p.normalized_title != null ? String(p.normalized_title).trim() : "";
  if (nt) return nt;
  if (p.display_title != null && String(p.display_title).trim() !== "") {
    return p.display_title;
  }
  return p.title;
}

function getCompany() {
  const p = getTitleCompanyPair();
  if (p.normalized_company != null && String(p.normalized_company).trim() !== "") {
    return p.normalized_company;
  }
  return p.company;
}

function extractDescriptionFromPane(pane) {
  return extractJobDescriptionStrict(pane);
}

/** Narrow fallback — same strict rules (no full-root innerText). */
function extractDescriptionBroad(root) {
  return extractJobDescriptionStrict(root);
}

const JOB_COPILOT_TOAST_ID = "job-copilot-page-toast";

function showMessage(text) {
  if (!isSupportedLinkedInJobPage()) return;
  try {
    let el = document.getElementById(JOB_COPILOT_TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = JOB_COPILOT_TOAST_ID;
      el.setAttribute("role", "status");
      el.style.cssText = [
        "position:fixed",
        "top:16px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:2147483646",
        "max-width:min(420px,92vw)",
        "padding:12px 16px",
        "background:#1f2937",
        "color:#f9fafb",
        "border-radius:8px",
        "font:14px/1.4 system-ui,-apple-system,sans-serif",
        "box-shadow:0 4px 20px rgba(0,0,0,.25)",
        "pointer-events:none",
      ].join(";");
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    clearTimeout(showMessage._t);
    showMessage._t = setTimeout(() => {
      el?.remove();
    }, 5000);
  } catch (e) {
    jcVerboseLog("toast failed", text);
  }
}

/**
 * Wait until a selector matches a node with visible text (LinkedIn renders async).
 */
function waitForElement(selector, timeoutMs = 12000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const el = document.querySelector(selector);
      if (el && getVisibleText(el)) {
        resolve(el);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("waitForElement timeout: " + selector));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * full_view_mode → /jobs/view/…
 * results_panel_mode → jobs search / collections with a right-hand detail pane
 */
function detectLinkedInJobPageMode() {
  const href = window.location.href || "";
  if (isLinkedInFullJobViewPath(href)) return "full_view_mode";
  if (
    href.includes("/jobs/search-results") ||
    href.includes("/jobs/collections") ||
    (href.includes("/jobs/search") && href.includes("currentJobId="))
  ) {
    return "results_panel_mode";
  }
  return "unknown";
}

/** Match /jobs/view/…, /jobs/view?…, and locale variants that omit trailing slash. */
function isLinkedInFullJobViewPath(href) {
  if (!href) return false;
  return /\/jobs\/view(\/|\?|$)/i.test(href) || href.includes("/jobs/view/");
}

/** Title + company via semantic helpers (stable selectors + fallbacks). */
function extractTitleCompanyFromPanel(panel) {
  void panel;
  return {
    title: (getJobTitle() || "").trim(),
    company: (getCompany() || "").trim(),
  };
}

function buildJobPayloadFromPanel(
  panel,
  pageMode,
  descriptionFallbackRoots,
  titleCompanyOverride
) {
  const detailRoot =
    getDetailPaneRootForHeaderExtraction() ||
    getActiveJobDetailRoot() ||
    panel;
  const { title, company } = titleCompanyOverride
    ? {
        title: (titleCompanyOverride.title || "").trim(),
        company: (titleCompanyOverride.company || "").trim(),
      }
    : extractTitleCompanyFromPanel(panel);

  const titleRaw = (title || "").trim();
  const companyRaw = (company || "").trim();

  const extractOpts = {
    resultsPanelMode: pageMode === "results_panel_mode",
  };
  let meta0 = extractJobDescriptionWithBestCandidate(
    detailRoot,
    titleRaw,
    companyRaw,
    extractOpts
  );
  let job_description = meta0.text;
  let selectorUsed = meta0.selector_used;
  if (!job_description) {
    const modalRoot = detailRoot || panel;
    const modal = modalRoot
      ? modalRoot.querySelector(
          ".jobs-easy-apply-content, .jobs-apply-form-container"
        )
      : null;
    const modalText = modal ? getVisibleText(modal).slice(0, 5000) : "";
    if (modalText && modalText.length > 40) {
      const mcont = detectDescriptionContamination(
        modalText,
        titleRaw,
        companyRaw
      );
      if (!mcont.contaminated) {
        job_description = modalText;
        selectorUsed = "modal_easy_apply";
        meta0 = {
          ...meta0,
          text: job_description,
          selector_used: selectorUsed,
          description_contaminated: false,
          candidate_evaluations: meta0.candidate_evaluations || [],
        };
      }
    }
  }
  if (!job_description || job_description.length < 40) {
    const roots = descriptionFallbackRoots || [];
    for (let r = 0; r < roots.length; r++) {
      const root = roots[r];
      if (!root) continue;
      if (isNodeInSearchResultsListRail(root)) continue;
      const m = extractJobDescriptionWithBestCandidate(
        root,
        titleRaw,
        companyRaw,
        extractOpts
      );
      if (
        m.text &&
        m.text.length >= 40 &&
        !m.description_contaminated &&
        m.text.length > (job_description || "").length
      ) {
        job_description = m.text;
        selectorUsed = m.selector_used;
        meta0 = m;
      }
    }
  }

  const pair = getTitleCompanyPair();
  const t = (
    pair.normalized_title ||
    pair.display_title ||
    cleanJobTitle(title.trim()) ||
    ""
  ).trim();
  const co = (pair.normalized_company || company.trim() || "").trim();
  const loc = (
    pair.normalized_location ||
    normalizeLocationText(pair.raw_location) ||
    (getJobLocation() || "") ||
    ""
  ).trim();

  const rawDesc = job_description;
  const contam = {
    contaminated: !!meta0.description_contaminated,
    reasons: meta0.contamination_reasons || [],
  };
  if (contam.contaminated) {
    job_description = "";
  }

  const scope = detailRoot || panel;

  // Salary chip rescue: LinkedIn renders the posted band as a top-card chip
  // (e.g. "$130K/yr - $155K/yr") that lives outside the JD body. If the body
  // doesn't already mention a range, append the chip text so the backend's
  // salary parser picks it up instead of falling back to "Market Estimate".
  job_description = appendPostedSalaryChip(job_description, scope);

  const source_url = normalizeSourceUrlForApi();
  const linkedin_job_id = extractLinkedInJobId();
  const hiring = extractHiringTeam(scope);
  const rel = extractRelationshipSignals(scope);
  const relationshipContext = buildRelationshipContext(
    hiring,
    rel,
    scope,
    co
  );

  const headerFlags = [];
  if (
    pageMode === "results_panel_mode" &&
    String(rawDesc || "").length > 2000 &&
    (!pair.title || !pair.company)
  ) {
    headerFlags.push("likely_wrong_container_long_desc_missing_header");
  }

  const extraction_debug = buildExtractionDebugFields(
    pageMode,
    t,
    co,
    loc || null,
    rawDesc,
    contam,
    !!(detailRoot || selectorUsed),
    selectorUsed,
    meta0,
    {
      title_selector_used: pair.title_selector_used,
      company_selector_used: pair.company_selector_used,
      title_extraction_attempts: pair.title_extraction_attempts,
      company_extraction_attempts: pair.company_extraction_attempts,
      header_extraction_flags: headerFlags,
      title_candidates: pair.title_candidates,
      title_selection_reason: pair.title_selection_reason,
      raw_title: pair.raw_title,
      normalized_title: pair.normalized_title,
      raw_company: pair.raw_company,
      normalized_company: pair.normalized_company,
      raw_location: pair.raw_location,
      normalized_location: pair.normalized_location,
      display_title: pair.display_title,
    }
  );
  jcVerboseLog("[JC EXTRACTION]", extraction_debug);

  return {
    title: t,
    company: co,
    location: loc || null,
    job_description,
    description_contaminated: contam.contaminated,
    extraction_debug,
    source_url,
    linkedin_job_id,
    hiring_team_visible: hiring.hiring_team_visible,
    hiring_manager_name: hiring.hiring_manager_name,
    hiring_manager_role: hiring.hiring_manager_role,
    hiring_manager_profile_url: hiring.hiring_manager_profile_url,
    shared_company_names: rel.shared_company_names,
    contact_seniority: "unknown",
    contact_type: relationshipContext.contact_type,
    relationship_context: relationshipContext,
    page_mode: pageMode,
    extraction_session: buildExtractionSession({ title: t, company: co }),
  };
}

/** Full-view extract: description only from active detail container + modal inside it. */
function buildFullViewJobPayloadFromHeadings(title, company, attempt) {
  void attempt;
  const jobContainer =
    getDetailPaneRootForHeaderExtraction() ||
    getActiveJobDetailRoot() ||
    findMainJobPane();

  const titleRaw = (title || "").trim();
  const companyRaw = (company || "").trim();

  let meta = extractJobDescriptionWithBestCandidate(
    jobContainer,
    titleRaw,
    companyRaw,
    { fullViewPage: true }
  );
  let job_description = meta.text;
  let selectorUsed = meta.selector_used;
  if (!job_description) {
    const modal = jobContainer
      ? jobContainer.querySelector(
          ".jobs-easy-apply-content, .jobs-apply-form-container"
        )
      : null;
    const modalText = modal ? getVisibleText(modal).slice(0, 5000) : "";
    if (modalText && modalText.length > 40) {
      const mcont = detectDescriptionContamination(
        modalText,
        titleRaw,
        companyRaw
      );
      if (!mcont.contaminated) {
        job_description = modalText;
        selectorUsed = "modal_easy_apply";
        meta = {
          ...meta,
          text: job_description,
          selector_used: selectorUsed,
          description_contaminated: false,
          candidate_evaluations: meta.candidate_evaluations || [],
        };
      }
    }
  }

  const pair = getTitleCompanyPair();
  const t = (
    pair.normalized_title ||
    pair.display_title ||
    cleanJobTitle(title.trim()) ||
    ""
  ).trim();
  const co = (pair.normalized_company || company.trim() || "").trim();
  const loc = (
    pair.normalized_location ||
    normalizeLocationText(pair.raw_location) ||
    (getJobLocation() || "") ||
    ""
  ).trim();

  const rawDesc = job_description;
  const contam = {
    contaminated: !!meta.description_contaminated,
    reasons: meta.contamination_reasons || [],
  };
  if (contam.contaminated) {
    job_description = "";
  }

  // Salary chip rescue (full-view path): LinkedIn renders the posted band as
  // a top-card chip outside the JD body. If the body doesn't already include
  // a range, append the chip text so the backend's salary parser uses the
  // posted band instead of falling back to "Market Estimate".
  // Unconditional log so we can diagnose without the Debug toggle.
  console.log(
    "[JC CHIP RESCUE] called",
    "jd_len=",
    (job_description || "").length,
    "jd_has_range=",
    jdAlreadyContainsSalaryRange(job_description || "")
  );
  job_description = appendPostedSalaryChip(job_description, jobContainer);
  console.log(
    "[JC CHIP RESCUE] after append jd_len=",
    (job_description || "").length
  );

  jcVerboseLog(
    "[EXTRACT] description length:",
    job_description ? job_description.length : 0
  );

  const extraction_debug = buildExtractionDebugFields(
    "full_view_mode",
    t,
    co,
    loc || null,
    rawDesc,
    contam,
    !!(jobContainer || selectorUsed),
    selectorUsed,
    meta,
    {
      title_selector_used: pair.title_selector_used,
      company_selector_used: pair.company_selector_used,
      title_extraction_attempts: pair.title_extraction_attempts,
      company_extraction_attempts: pair.company_extraction_attempts,
      header_extraction_flags: [],
      title_candidates: pair.title_candidates,
      title_selection_reason: pair.title_selection_reason,
      raw_title: pair.raw_title,
      normalized_title: pair.normalized_title,
      raw_company: pair.raw_company,
      normalized_company: pair.normalized_company,
      raw_location: pair.raw_location,
      normalized_location: pair.normalized_location,
      display_title: pair.display_title,
    }
  );
  jcVerboseLog("[JC EXTRACTION]", extraction_debug);

  const source_url = normalizeSourceUrlForApi();
  const linkedin_job_id = extractLinkedInJobId();
  const hiring = extractHiringTeam(jobContainer);
  const rel = extractRelationshipSignals(jobContainer);
  const relationshipContext = buildRelationshipContext(
    hiring,
    rel,
    jobContainer,
    co
  );

  return {
    title: t,
    company: co,
    location: loc || null,
    job_description,
    description_contaminated: contam.contaminated,
    extraction_debug,
    source_url,
    linkedin_job_id,
    hiring_team_visible: hiring.hiring_team_visible,
    hiring_manager_name: hiring.hiring_manager_name,
    hiring_manager_role: hiring.hiring_manager_role,
    hiring_manager_profile_url: hiring.hiring_manager_profile_url,
    shared_company_names: rel.shared_company_names,
    contact_seniority: "unknown",
    contact_type: relationshipContext.contact_type,
    relationship_context: relationshipContext,
    page_mode: "full_view_mode",
    extraction_session: buildExtractionSession({ title: t, company: co }),
  };
}

/** Full job URL (/jobs/view/…): semantic readiness, then extract. */
async function scrapeJobFullView() {
  await waitForFullViewReady();

  const fvReadyWait = await waitForFullViewJobDetailReady(6000, 250);
  const s = fvReadyWait.snapshot || {};
  console.log("[JC READY CHECK]", {
    isFullView: !!s.isFullView,
    hasTitle: !!s.hasTitle,
    hasCompany: !!s.hasCompany,
    hasBodyText: !!s.hasBodyText,
    chosenSelector: s.chosenSelector ?? null,
    bodyLength: s.bodyLength ?? 0,
  });

  const title = (getJobTitle() || "").trim();
  const company = (getCompany() || "").trim();

  jcVerboseLog("[EXTRACT] title:", title);
  jcVerboseLog("[EXTRACT] company:", company);

  if (!title || isInvalidPromoTitle(title) || isLikelyNoiseTitle(title)) {
    jcVerboseLog("[FLOW] returning early because: invalid_or_missing_title");
    return {
      extraction_failed: true,
      page_mode: "full_view_mode",
      linkedin_job_id: extractLinkedInJobId() || "",
      source_url: normalizeSourceUrlForApi(),
    };
  }

  if (!company) {
    jcVerboseLog("[FLOW] returning early because: missing_company");
    return {
      extraction_failed: true,
      page_mode: "full_view_mode",
      linkedin_job_id: extractLinkedInJobId() || "",
      source_url: normalizeSourceUrlForApi(),
    };
  }

  let payload = null;
  let cumulativeWaitMs = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    jcFrontendDebugLog(`extraction attempt ${attempt + 1} started`);
    await sleepBeforeExtractionAttempt(attempt);
    const waitStats = await waitForJobDetailContentReady(2500, 250, {
      fullView: true,
    });
    cumulativeWaitMs += waitStats.total_wait_ms;
    payload = buildFullViewJobPayloadFromHeadings(title, company, attempt + 1);
    const detailRoot = getActiveJobDetailRoot() || findMainJobPane();
    const needRetry = shouldRetryExtractionAttempt(payload);
    jcFrontendDebugLog(`extraction attempt ${attempt + 1} result`, {
      need_retry: needRetry,
      description_length: payload.extraction_debug?.description_length,
      description_contaminated: !!payload.description_contaminated,
      selector_used: payload.extraction_debug?.selector_used,
    });
    emitJcExtractDebug(
      "full_view_mode",
      detailRoot,
      payload,
      attempt + 1,
      needRetry && attempt < 2,
      null,
      waitStats,
      { cumulative_wait_ms: cumulativeWaitMs }
    );
    if (!needRetry || attempt === 2) break;
  }

  payload = finalizeExtractionPayload(payload);
  const fr = payload.extraction_debug?.final_failure_reason ?? null;
  const rdLen = payload.extraction_debug?.description_length ?? 0;
  emitJcExtractDebug(
    "full_view_mode",
    getActiveJobDetailRoot() || findMainJobPane(),
    payload,
    "final",
    false,
    fr,
    null,
    {
      cumulative_wait_ms: cumulativeWaitMs,
      reason_for_failure: fr,
      final_description_length: rdLen,
    }
  );
  jcVerboseLog("[JC EXTRACT DEBUG] summary", {
    cumulative_wait_ms: cumulativeWaitMs,
    final_description_length: rdLen,
    extraction_mode: payload.extraction_mode,
    extraction_failed: !!payload.extraction_failed,
    reason_for_failure: fr,
    selector_found: !!(payload.extraction_debug && payload.extraction_debug.selector_used),
  });

  logJcFrontendDebugExtractionSummary(payload);
  return payload;
}

/**
 * Jobs search / collections: right-panel readiness (title + company + body/about), then extract.
 */
async function scrapeJobResultsPanel() {
  const href = window.location.href || "";
  console.log("[JC MODE] results_panel");
  if (href.includes("/jobs/collections")) {
    jcVerboseLog("[FLOW] entering collections mode branch");
  } else {
    jcVerboseLog("[FLOW] entering results mode branch");
  }

  const ready = await waitForResultsPanelReady(10);
  const snapLog = getResultsPanelReadinessSnapshot({ clearPairCache: false });
  console.log("[JC PANEL READY]", {
    hasTitle: snapLog.hasTitle,
    hasCompany: snapLog.hasCompany,
    hasBodyText: snapLog.hasBodyText,
    chosenSelector: snapLog.chosenSelector ?? null,
    bodyLength: snapLog.bodyLength ?? 0,
  });
  if (!ready) {
    jcVerboseLog(
      "[FLOW] returning early because: results_panel_not_ready_after_retries"
    );
    showMessage(
      "Couldn't fully load this job from search results. Open the job in full view to analyze."
    );
    return {
      extraction_failed: true,
      page_mode: "results_panel_mode",
      linkedin_job_id: extractLinkedInJobId() || "",
      source_url: normalizeSourceUrlForApi(),
    };
  }

  const title = (getJobTitle() || "").trim();
  const company = (getCompany() || "").trim();

  jcVerboseLog("[EXTRACT] title:", title);
  jcVerboseLog("[EXTRACT] company:", company);

  if (!title || isInvalidPromoTitle(title) || isLikelyNoiseTitle(title)) {
    jcVerboseLog(
      "[FLOW] returning early because: invalid_or_missing_title_after_ready"
    );
    showMessage(
      "Couldn't fully load this job from search results. Open the job in full view to analyze."
    );
    return {
      extraction_failed: true,
      page_mode: "results_panel_mode",
      linkedin_job_id: extractLinkedInJobId() || "",
      source_url: normalizeSourceUrlForApi(),
    };
  }

  const panelRoot =
    resolveResultsPanelJobDetailRoot() || getActiveJobDetailRoot();
  const fallbackRoots = [panelRoot, findMainJobPane()].filter(
    (r) => r && !isNodeInSearchResultsListRail(r)
  );
  let payload = null;
  let cumulativeWaitMs = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    jcFrontendDebugLog(`extraction attempt ${attempt + 1} started`);
    await sleepBeforeExtractionAttempt(attempt);
    const waitStats = await waitForJobDetailContentReady(2500, 250);
    cumulativeWaitMs += waitStats.total_wait_ms;
    const tc = {
      title: (getJobTitle() || "").trim(),
      company: (getCompany() || "").trim(),
    };
    payload = buildJobPayloadFromPanel(
      panelRoot,
      "results_panel_mode",
      fallbackRoots,
      tc
    );
    const detailRoot = panelRoot || getActiveJobDetailRoot() || findMainJobPane();
    const needRetry = shouldRetryExtractionAttempt(payload);
    jcFrontendDebugLog(`extraction attempt ${attempt + 1} result`, {
      need_retry: needRetry,
      description_length: payload.extraction_debug?.description_length,
      description_contaminated: !!payload.description_contaminated,
      selector_used: payload.extraction_debug?.selector_used,
    });
    emitJcExtractDebug(
      "results_panel_mode",
      detailRoot,
      payload,
      attempt + 1,
      needRetry && attempt < 2,
      null,
      waitStats,
      { cumulative_wait_ms: cumulativeWaitMs }
    );
    if (!needRetry || attempt === 2) break;
  }

  payload = finalizeExtractionPayload(payload);
  const fr = payload.extraction_debug?.final_failure_reason ?? null;
  const rdLen = payload.extraction_debug?.description_length ?? 0;
  emitJcExtractDebug(
    "results_panel_mode",
    getActiveJobDetailRoot() || findMainJobPane(),
    payload,
    "final",
    false,
    fr,
    null,
    {
      cumulative_wait_ms: cumulativeWaitMs,
      reason_for_failure: fr,
      final_description_length: rdLen,
    }
  );
  jcVerboseLog("[JC EXTRACT DEBUG] summary", {
    cumulative_wait_ms: cumulativeWaitMs,
    final_description_length: rdLen,
    extraction_mode: payload.extraction_mode,
    extraction_failed: !!payload.extraction_failed,
    reason_for_failure: fr,
    selector_found: !!(payload.extraction_debug && payload.extraction_debug.selector_used),
  });

  jcVerboseLog(
    "[EXTRACT] description length:",
    payload.job_description ? payload.job_description.length : 0
  );

  logJcFrontendDebugExtractionSummary(payload);
  return payload;
}

function scrapeJobAsyncFailureReasonFromError(err) {
  const msg = String(err && err.message ? err.message : err);
  if (/regions is not defined/i.test(msg) || /\bregions\b/.test(msg)) {
    return "regions_not_defined";
  }
  return "scrape_substep_error";
}

async function scrapeJobAsync() {
  const href = window.location.href || "";
  if (!isSupportedLinkedInJobPage()) {
    jcVerboseLog("[FLOW] skip: not a supported LinkedIn jobs page");
    return {
      ok: false,
      extraction_failed: true,
      failure_reason: "unsupported_page",
      page_mode: "unknown",
      linkedin_job_id: "",
      source_url: href ? href.slice(0, 500) : null,
    };
  }
  let selectedMode = "unknown";
  try {
    try {
      clearTitleCompanyPairCache();
      jcVerboseLog("[PAGE MODE] href:", href);
      jcVerboseLog("[PAGE MODE] isView:", isLinkedInFullJobViewPath(href));
      jcVerboseLog(
        "[PAGE MODE] isSearchResults:",
        href.includes("/jobs/search-results/")
      );
      jcVerboseLog(
        "[PAGE MODE] isCollections:",
        href.includes("/jobs/collections/")
      );

      selectedMode = detectLinkedInJobPageMode();
      jcVerboseLog("[PAGE MODE] selected:", selectedMode);
      jcFrontendDebugLog("extraction pipeline started", {
        href: href ? href.slice(0, 500) : "",
        page_mode: selectedMode,
      });

      jcVerboseLog("[FLOW] entered main extraction");
      jcVerboseLog("[FLOW] selected mode:", selectedMode);
      jcVerboseLog("[FLOW] before branch dispatch");
      if (selectedMode === "unknown") {
        jcVerboseLog("[FLOW] returning early because: unknown_page_mode");
        showMessage("⚠️ Click into a job to analyze");
        return {
          ok: false,
          extraction_failed: true,
          failure_reason: "unknown_page_mode",
          page_mode: "unknown",
          linkedin_job_id: "",
          source_url: href ? href.slice(0, 500) : null,
        };
      }
      // Expand LinkedIn's "See more" button so the JD body in DOM includes
      // the bottom (where salary disclosures usually live). Wait briefly so
      // the rendered DOM updates before innerText-based extraction runs.
      const expanded = jcExpandLinkedInJobDescription();
      if (expanded) {
        jcVerboseLog("[FLOW] expanded JD via See more");
        await new Promise((r) => setTimeout(r, 250));
      }
      if (selectedMode === "full_view_mode") {
        jcVerboseLog("[FLOW] entering view mode branch");
        jcVerboseLog("[FLOW] about to run view readiness");
        return await scrapeJobFullView();
      }
      jcVerboseLog("[FLOW] entering results/collections panel branch");
      jcVerboseLog("[FLOW] about to run results readiness");
      return await scrapeJobResultsPanel();
    } catch (subErr) {
      const msg = String(subErr && subErr.message ? subErr.message : subErr);
      jcFrontendDebugLog("scrapeJobAsync substep failed:", msg);
      const failure_reason = scrapeJobAsyncFailureReasonFromError(subErr);
      return {
        ok: false,
        extraction_failed: true,
        failure_reason,
        page_mode: selectedMode || "unknown",
        flow_error: msg,
        linkedin_job_id: extractLinkedInJobId() || "",
        source_url:
          normalizeSourceUrlForApi() ?? (href ? href.slice(0, 500) : null),
      };
    }
  } catch (err) {
    console.error(
      "[Job Copilot] scrape failed:",
      err && err.message ? err.message : err
    );
    jcFrontendDebugError(
      "fatal error (scrapeJobAsync)",
      String(err && err.message ? err.message : err)
    );
    return {
      ok: false,
      extraction_failed: true,
      failure_reason: "scrape_fatal",
      page_mode: selectedMode || "unknown",
      flow_error: String(err && err.message ? err.message : err),
      linkedin_job_id: extractLinkedInJobId() || "",
      source_url: normalizeSourceUrlForApi() ?? (href ? href.slice(0, 500) : null),
    };
  }
}

// ===== Extraction reliability: delayed run + observer + click (verbose logs = Debug only) =====

/**
 * Re-run scrape when title/company are missing (LinkedIn still loading).
 */
function tryExtractJobWithRetry() {
  jcRetryCount = 0;
  const attempt = () =>
    scrapeJobAsync().then((data) => {
      const title = (data && data.title != null ? String(data.title) : "").trim();
      const company = (data && data.company != null ? String(data.company) : "").trim();
      const missingCore = !data || !title || !company;
      if (missingCore) {
        if (jcRetryCount < JC_MAX_RETRIES) {
          jcRetryCount++;
          console.log("[JC RETRY]", jcRetryCount);
          return new Promise((resolve) => {
            setTimeout(() => resolve(attempt()), 1500);
          });
        }
        console.warn("[JC FAILED] Could not extract job after retries");
        return data;
      }
      jcRetryCount = 0;
      return data;
    });
  return attempt();
}

function runExtractionPipeline() {
  if (!isSupportedLinkedInJobPage()) {
    jcVerboseLog("extraction pipeline skipped (unsupported page)");
    return Promise.resolve({
      ok: false,
      extraction_failed: true,
      failure_reason: "unsupported_page",
      page_mode: "unknown",
    });
  }
  jcVerboseLog("extraction pipeline run");
  return tryExtractJobWithRetry();
}

if (isSupportedLinkedInJobPage()) {
  // Backend warmup — fire-and-forget so the first user click doesn't pay
  // the FastAPI cold-start tax. Errors are silent (backend may be down).
  try {
    fetch("http://127.0.0.1:8000/health", { method: "GET" }).catch(() => {});
  } catch (_) {}

  setTimeout(runExtractionPipeline, 1500);

  // Debounced re-extract: on SPA navigation (URL change) or when the job
  // shell first appears. Avoids re-running on every DOM mutation.
  let lastUrl = location.href;
  let shellPresent = false;
  let extractTimer = null;

  function jcDebouncedExtract(reason, delayMs) {
    if (extractTimer) clearTimeout(extractTimer);
    extractTimer = setTimeout(() => {
      extractTimer = null;
      if (!isSupportedLinkedInJobPage()) return;
      jcVerboseLog("[FLOW] debounced extract:", reason);
      runExtractionPipeline();
    }, typeof delayMs === "number" ? delayMs : 400);
  }

  const observer = new MutationObserver(() => {
    if (!isSupportedLinkedInJobPage()) return;

    // SPA navigation: LinkedIn pushState'd to a new currentJobId. Always re-run.
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      shellPresent = false;
      jcDebouncedExtract("url_change", 600);
      return;
    }

    // Shell-appearance edge: only re-extract when the shell *transitions*
    // from missing → present. Subsequent mutations on the same shell are no-ops.
    const el =
      document.querySelector(".jobs-search__job-details--container") ||
      document.querySelector(".job-view-layout") ||
      document.querySelector("main");
    if (el && !shellPresent) {
      shellPresent = true;
      jcDebouncedExtract("shell_appeared", 400);
    } else if (!el && shellPresent) {
      shellPresent = false;
    }
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // Click debounce: covers cases where LinkedIn updates the right pane
  // without changing the URL (e.g. opening a job from a card click).
  document.body.addEventListener("click", () => {
    if (!isSupportedLinkedInJobPage()) return;
    jcDebouncedExtract("click", 800);
  });
}

/**
 * "You both worked at X" (and similar) from visible job/hiring panel text.
 */
function extractSharedCompaniesFromBlob(blob) {
  if (!blob) return [];
  const out = [];
  const patterns = [
    /you both worked at\s+([^\n.]+?)(?:\.|\n|$)/gi,
    /you both worked for\s+([^\n.]+?)(?:\.|\n|$)/gi,
    /both worked at\s+([^\n.]+?)(?:\.|\n|$)/gi,
    /you both worked at\s+([^\n,]+?)(?:,|\n|$)/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(blob)) !== null) {
      let name = m[1].trim().replace(/\s+/g, " ");
      const parts = name.split(/\s+and\s+/i);
      if (parts.length > 1) {
        name = parts[0].trim();
      }
      if (name.length > 0 && name.length < 120) out.push(name);
    }
  }
  return [...new Set(out)].slice(0, 5);
}

function extractRelationshipSignals(container) {
  const teamSection =
    container?.querySelector(
      "section.jobs-hiring-team, [class*='jobs-hiring-team'], [data-view-name='job-details-hiring-team']"
    ) || null;
  const blob = (
    (container?.innerText || "") +
    "\n" +
    (teamSection?.innerText || "")
  ).slice(0, 25000);
  return {
    shared_company_names: extractSharedCompaniesFromBlob(blob),
  };
}

/**
 * Relationship UI snippets only — not full job page text (avoids false "warm" from
 * sidebar noise like "following" or generic page copy).
 */
function extractNetworkRelationshipBlob(container) {
  if (!container) return "";
  const parts = [];
  const selectors = [
    "[data-view-name='job-details-people-who-can-help']",
    "[class*='mutual-connection']",
    "[class*='connections-who']",
    "[class*='people-who']",
    "[data-view-name='edge-connections']",
  ];
  for (let s = 0; s < selectors.length; s++) {
    try {
      const el = container.querySelector(selectors[s]);
      if (el) parts.push(getVisibleText(el).slice(0, 4000));
    } catch (e) {
      /* ignore */
    }
  }
  return parts.join("\n").slice(0, 12000);
}

/** Mutual / connection hints in scoped relationship UI (not whole page). */
function detectConnectionSignals(blob) {
  if (!blob) return false;
  return (
    /\b(1st|2nd|3rd)\b.*\bconnection\b/i.test(blob) ||
    /\bconnection\b.*\b(1st|2nd|3rd)\b/i.test(blob) ||
    /mutual connection/i.test(blob) ||
    /you(?:'|’)?re connected/i.test(blob) ||
    /\bin your network\b/i.test(blob)
  );
}

function extractSchoolOverlapHint(container) {
  const blob = container?.innerText
    ? container.innerText.slice(0, 8000)
    : "";
  const m = blob.match(
    /(?:studied at|school:?)\s*([^\n.]+?)(?:\.|\n|$)/i
  );
  if (m && m[1]) return m[1].trim().slice(0, 120);
  return "";
}

function buildContactDebug(hiring, relSignals, networkBlob, container) {
  const shared = (relSignals.shared_company_names || []).length > 0;
  const sharedFirst = shared
    ? String(relSignals.shared_company_names[0] || "").trim()
    : "";
  const networkWarm = !!(networkBlob && detectConnectionSignals(networkBlob));
  const schoolHint = extractSchoolOverlapHint(container || document.body);

  const name = (hiring.hiring_manager_name || "").trim();
  const hasPerson = name.length > 0;
  const sourceMod = (hiring.hiring_contact_source || "").trim();
  const visible = !!hiring.hiring_team_visible;

  if (networkWarm) {
    return {
      contact_type: "warm_contact",
      warmth: "warm",
      source_module: sourceMod || "network_ui",
      relationship_signal: "network_degree_or_mutual",
      overlap_type: "direct_connection",
      overlap_entity: "",
      shared_company_name: "",
      shared_school_name: "",
      overlap_years_ago: null,
      reason:
        "In-network / degree or mutual connection context (scoped UI), not hiring-card noise.",
    };
  }
  if (shared) {
    return {
      contact_type: "historical_connection",
      warmth: "reconnect",
      source_module: sourceMod || "shared_employer_text",
      relationship_signal: "shared_employer",
      overlap_type: "shared_company",
      overlap_entity: sharedFirst,
      shared_company_name: sharedFirst,
      shared_school_name: "",
      overlap_years_ago: null,
      reason:
        "Prior employer overlap from LinkedIn text; use reconnect tone, not referral.",
    };
  }
  if (schoolHint) {
    return {
      contact_type: "historical_connection",
      warmth: "reconnect",
      source_module: sourceMod || "profile_snippet",
      relationship_signal: "shared_school",
      overlap_type: "shared_school",
      overlap_entity: schoolHint,
      shared_company_name: "",
      shared_school_name: schoolHint,
      overlap_years_ago: null,
      reason: "School overlap visible in snippet.",
    };
  }
  if (visible && hasPerson) {
    return {
      contact_type: "hiring_team_contact",
      warmth: "cold",
      source_module: sourceMod || "hiring_team",
      relationship_signal: "",
      overlap_type: "none",
      overlap_entity: "",
      shared_company_name: "",
      shared_school_name: "",
      overlap_years_ago: null,
      reason:
        "Hiring / job poster contact without overlap or active relationship evidence.",
    };
  }
  return {
    contact_type: "unknown_or_none",
    warmth: "unknown",
    source_module: sourceMod || "",
    relationship_signal: "",
    overlap_type: "none",
    overlap_entity: "",
    shared_company_name: "",
    shared_school_name: "",
    overlap_years_ago: null,
    reason: hasPerson
      ? "Named contact without classified hiring module."
      : "No useful contact identified.",
  };
}

function buildExtractionSession(fields) {
  const href = window.location.href || "";
  const jid = extractLinkedInJobId() || "";
  const norm = normalizeSourceUrlForApi() || "";
  return {
    currentPageUrl: href.slice(0, 500),
    normalizedLinkedinJobId: jid,
    normalized_job_url: norm,
    extractedTitle: (fields && fields.title) || "",
    extractedCompany: (fields && fields.company) || "",
    extractionTimestamp: new Date().toISOString(),
  };
}

function extractFirstName(fullName) {
  if (!fullName || !String(fullName).trim()) return "there";
  return String(fullName).trim().split(/\s+/)[0];
}

/**
 * Reject company names and brand-like tokens (mirrors server validate_person_name_for_outreach).
 */
function isLikelyPersonName(name, companyName) {
  if (!name || !String(name).trim()) return false;
  const n = String(name).trim();
  if (n.length < 2 || n.length > 120) return false;
  if (/\d/.test(n)) return false;
  const lower = n.toLowerCase();
  if (
    /\b(recruiting|talent acquisition|sourcer|people partner|staffing|hiring team|meet the hiring)\b/i.test(
      lower
    )
  ) {
    return false;
  }
  if (/\bteam\b/i.test(lower) && n.split(/\s+/).length <= 3) return false;
  if (/\bcompany\b/i.test(lower)) return false;
  const norm = (s) =>
    String(s || "")
      .replace(/[^\w\s]/g, "")
      .toLowerCase()
      .trim();
  const cn = norm(companyName);
  const nn = norm(n);
  if (cn && cn.length >= 3 && (cn === nn || nn.includes(cn) || cn.includes(nn))) {
    return false;
  }
  const parts = n.split(/\s+/);
  if (parts.length >= 2) {
    return parts
      .slice(0, 4)
      .every((p) => /^[A-Za-z][A-Za-z'.-]{0,40}$/.test(p));
  }
  const tok = parts[0];
  if (/[a-z][A-Z]/.test(tok)) return false;
  if (/[A-Z]{2,}[a-z]+[A-Z]/.test(tok)) return false;
  if (tok === tok.toUpperCase() && tok.length >= 5) return false;
  return /^[A-Z][a-z]{1,30}$/.test(tok);
}

/**
 * Stricter check for modal rows: require First Last (e.g. Eugenie Ahn, Shane Bermingham).
 */
function isLikelyRealPersonFullName(name, companyName) {
  if (!name || !String(name).trim()) return false;
  const lower = name.trim().toLowerCase();
  if (/^(recruiting|talent|talent acquisition|hiring|company|team)$/i.test(lower)) {
    return false;
  }
  if (!isLikelyPersonName(name, companyName)) return false;
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return false;
  return parts
    .slice(0, 3)
    .every((p) => /^[A-Za-z][A-Za-z'.-]{1,40}$/.test(p));
}

/**
 * Find visible LinkedIn overlays that list people (e.g. "In your network", "Connections who…").
 * Scoped to document — modals are not inside the job detail container.
 */
function findNetworkModalRoots() {
  const roots = [];
  const modals = document.querySelectorAll(
    '.artdeco-modal[role="dialog"], div[role="dialog"].artdeco-modal, div[role="dialog"], .msg-overlay-list-bubble__content--scrollable, aside.msg-overlay-bubble--is-active .msg-overlay-list-bubble__content'
  );
  modals.forEach((m) => {
    const header = getVisibleText(
      m.querySelector(
        "h1, h2, h3, .artdeco-modal__header, [class*='modal-header'], .artdeco-modal__title"
      )
    );
    const snippet = (m.innerText || "").slice(0, 2500);
    const hay = `${header} ${snippet}`.toLowerCase();
    if (
      /in your network|connections who|people in your network|mutual connections|who work at|people who can help|in your connections|people you may know/.test(
        hay
      )
    ) {
      if (!roots.includes(m)) roots.push(m);
    }
  });
  return roots;
}

function parseDegreeFromText(text) {
  const t = text || "";
  if (/\b1st\b/i.test(t) && /connection/i.test(t)) return "1st";
  if (/\b2nd\b/i.test(t) && /connection/i.test(t)) return "2nd";
  if (/\b3rd\b/i.test(t) && /connection/i.test(t)) return "3rd";
  if (/\b1st\b/i.test(t)) return "1st";
  if (/\b2nd\b/i.test(t)) return "2nd";
  if (/\b3rd\b/i.test(t)) return "3rd";
  return "";
}

function parseActionFromCard(card) {
  const buttons = card.querySelectorAll("button");
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    const al = (b.getAttribute("aria-label") || "").toLowerCase();
    const lab = getVisibleText(b).toLowerCase().trim();
    if (al.includes("message") || lab === "message") return "Message";
    if (al.includes("connect") || lab === "connect") return "Connect";
  }
  return "";
}

/**
 * Parse profile rows inside "In your network" (and similar) modals — not the main job card.
 */
function extractContactsFromNetworkModals(companyName, sharedCompanyNames) {
  const roots = findNetworkModalRoots();
  const contacts = [];
  const seen = new Set();
  const sharedLower = (sharedCompanyNames || []).map((s) =>
    String(s).toLowerCase().trim()
  );

  for (let r = 0; r < roots.length; r++) {
    const root = roots[r];
    const profileAnchors = root.querySelectorAll('a[href*="/in/"]');
    for (let i = 0; i < profileAnchors.length; i++) {
      const a = profileAnchors[i];
      if (!/\/in\/[^/]+/.test(a.getAttribute("href") || "")) continue;
      const card =
        a.closest(
          "li, .reusable-search__result-container, [class*='entity-result'], article, .artdeco-list__item, .display-flex"
        ) || a.closest(".artdeco-entity-lockup")?.parentElement;
      if (!card || !root.contains(card)) continue;

      const nameEl =
        card.querySelector('.artdeco-entity-lockup__title a[href*="/in/"]') || a;
      let full_name = getVisibleText(nameEl).split("\n")[0].trim();
      if (!full_name || full_name.length > 100) continue;
      const key = full_name.toLowerCase();
      if (seen.has(key)) continue;
      if (!isLikelyRealPersonFullName(full_name, companyName)) continue;
      seen.add(key);

      const headline = getVisibleText(
        card.querySelector(
          ".artdeco-entity-lockup__subtitle, .entity-result__primary-subtitle, .linked-area-field-paragraph, [class*='subtitle']"
        )
      ).slice(0, 300);

      const blockText = getVisibleText(card).slice(0, 1600);
      const degree = parseDegreeFromText(blockText);
      const action_label = parseActionFromCard(card);
      const hl = `${headline} ${blockText}`.toLowerCase();

      const is_recruiter =
        /\b(recruiter|recruiters|recruiting|recruitment|talent|hiring)\b/i.test(
          hl
        );

      let is_warm_connection =
        degree === "1st" ||
        (/\b1st\b/i.test(blockText) && /\bconnection\b/i.test(blockText));
      if (!is_warm_connection) {
        for (let s = 0; s < sharedLower.length; s++) {
          const sc = sharedLower[s];
          if (sc.length >= 3 && blockText.toLowerCase().includes(sc)) {
            is_warm_connection = true;
            break;
          }
        }
      }

      const is_alumni = /school alumni|studied at the same|same school|alumni of/i.test(
        blockText
      );

      contacts.push({
        full_name,
        first_name: extractFirstName(full_name),
        headline,
        degree,
        action_label,
        is_recruiter,
        is_warm_connection,
        is_alumni,
      });
    }
  }
  return contacts;
}

function resolveBestRecruiterFromContacts(contacts) {
  const recs = contacts.filter((c) => c.is_recruiter);
  if (!recs.length) return null;
  const withMsg = recs.filter((c) => c.action_label === "Message");
  const pool = withMsg.length ? withMsg : recs;
  return pool[0];
}

function resolveBestWarmFromContacts(contacts) {
  const warms = contacts.filter((c) => c.is_warm_connection);
  if (!warms.length) return null;
  const firsts = warms.filter((c) => c.degree === "1st");
  const pool = firsts.length ? firsts : warms;
  return pool[0];
}

function resolveAlumniFromContacts(contacts) {
  const a = contacts.filter((c) => c.is_alumni);
  return a.length ? a[0] : null;
}

/**
 * Warm / mutual connection name — scoped UI only (never the job header company lockup).
 */
function extractWarmConnectionPersonName(container, companyName) {
  if (!container) return "";
  const roots = [];
  const add = (el) => {
    if (el && !roots.includes(el)) roots.push(el);
  };
  add(container.querySelector("[class*='connections-who']"));
  add(container.querySelector("[class*='mutual-connection']"));
  add(
    container.querySelector("[data-view-name='job-details-people-who-can-help']")
  );
  add(container.querySelector("[class*='people-who']"));
  const innerSelectors = ["h3", ".artdeco-entity-lockup__title", "span[dir='ltr']"];
  for (const root of roots) {
    for (const sel of innerSelectors) {
      const els = root.querySelectorAll(sel);
      for (let i = 0; i < els.length; i++) {
        const t = getVisibleText(els[i]);
        if (t && isLikelyPersonName(t, companyName)) return t.trim();
      }
    }
  }
  const msg = container.querySelector('[data-view-name="message-button"]');
  if (msg) {
    const t =
      getVisibleText(msg.querySelector(".truncate")) ||
      getVisibleText(msg.querySelector("span")) ||
      "";
    if (t && isLikelyPersonName(t, companyName)) return t.trim();
  }
  return "";
}

function extractAlumniCandidate(container) {
  const blob = (container?.innerText || "").slice(0, 8000);
  if (!/school alumni|studied at|same school|alumni of/i.test(blob)) {
    return {
      full_name: null,
      role: null,
      profile_url: null,
      shared_company_names: [],
    };
  }
  return {
    full_name: null,
    role: null,
    profile_url: null,
    shared_company_names: [],
  };
}

function buildContactCandidates(hiring, relSignals, container, companyName) {
  const warmShared = relSignals.shared_company_names || [];
  const contacts = extractContactsFromNetworkModals(companyName, warmShared);
  let recruiterCandidate = resolveBestRecruiterFromContacts(contacts);
  let warmCandidate = resolveBestWarmFromContacts(contacts);
  const alumniCandidate = resolveAlumniFromContacts(contacts);

  const recNameFromHiring =
    hiring.hiring_manager_name &&
    isLikelyPersonName(hiring.hiring_manager_name, companyName)
      ? hiring.hiring_manager_name.trim()
      : null;
  const hiringRoleLower = (hiring.hiring_manager_role || "").toLowerCase();
  const hiringLooksRecruiter =
    /\b(recruit|recruiting|talent|hiring|sourcer|people partner|staffing)\b/.test(
      hiringRoleLower
    );

  let recName = recruiterCandidate ? recruiterCandidate.full_name : null;
  let recruiterRole =
    recruiterCandidate?.headline || hiring.hiring_manager_role || null;
  if (!recName && recNameFromHiring && hiringLooksRecruiter) {
    recName = recNameFromHiring;
    recruiterRole = hiring.hiring_manager_role || recruiterRole;
    recruiterCandidate = {
      full_name: recNameFromHiring,
      first_name: extractFirstName(recNameFromHiring),
      headline: hiring.hiring_manager_role || "",
      degree: "",
      action_label: "",
      is_recruiter: true,
      is_warm_connection: false,
      is_alumni: false,
    };
  }

  let warmName = warmCandidate ? warmCandidate.full_name : "";
  const hasSharedEmployer = (relSignals.shared_company_names || []).length > 0;
  if (!warmName && hasSharedEmployer) {
    warmName = extractWarmConnectionPersonName(container, companyName);
  }

  const alumni = extractAlumniCandidate(container);
  const alumniFull =
    alumniCandidate && isLikelyPersonName(alumniCandidate.full_name, companyName)
      ? alumniCandidate.full_name
      : alumni.full_name;

  const result = {
    recruiter: {
      full_name: recName || null,
      role: recruiterRole,
      profile_url: hiring.hiring_manager_profile_url || null,
      shared_company_names: [],
    },
    warm_connection: {
      full_name: warmName || null,
      role: warmCandidate?.headline || null,
      profile_url: null,
      shared_company_names: warmShared,
    },
    alumni: {
      full_name: alumniFull,
      role: alumni.role,
      profile_url: alumni.profile_url,
      shared_company_names: alumni.shared_company_names || [],
    },
  };

  jcVerboseLog("[CONTACT EXTRACT] contacts:", contacts);
  jcVerboseLog("[CONTACT EXTRACT] recruiter:", recruiterCandidate || result.recruiter);
  jcVerboseLog("[CONTACT EXTRACT] warm:", warmCandidate || result.warm_connection);

  return result;
}

function detectContactSignals(
  hiring,
  relSignals,
  networkBlob,
  pageBlob,
  recruiterCandidate,
  companyName
) {
  const role = (hiring.hiring_manager_role || "").toLowerCase();
  const b = (pageBlob || "").toLowerCase();
  const namedRecruiter =
    recruiterCandidate &&
    recruiterCandidate.full_name &&
    isLikelyPersonName(recruiterCandidate.full_name, companyName);
  const hasHiringManager =
    /\bhiring manager\b/.test(role) || /\bhiring manager\b/.test(b.slice(0, 6000));
  let hasRecruiter = false;
  if (!hasHiringManager) {
    const roleSuggestsRecruiterSide =
      /recruiter|talent acquisition|gtm recruiting|sourcer|people partner|staffing/.test(
        role
      ) ||
      (/\bhiring\b/.test(role) && !/\bhiring manager\b/.test(role));
    hasRecruiter = !!(roleSuggestsRecruiterSide || namedRecruiter);
  }
  const hasWarm =
    (relSignals.shared_company_names || []).length > 0 ||
    detectConnectionSignals(networkBlob);
  const hasAlumni =
    /you both studied at|same school|alumni of|school alumni/.test(b);
  return {
    has_recruiter: !!hasRecruiter,
    has_warm_connection: !!hasWarm,
    has_alumni: !!hasAlumni,
    has_hiring_manager: !!hasHiringManager,
  };
}

function buildRelationshipContext(hiring, relSignals, container, companyName) {
  const teamSection =
    container?.querySelector(
      "section.jobs-hiring-team, [class*='jobs-hiring-team'], [data-view-name='job-details-hiring-team']"
    ) || null;
  const networkBlob = extractNetworkRelationshipBlob(container);
  const blob = (
    (container?.innerText || "") +
    "\n" +
    (teamSection?.innerText || "")
  ).slice(0, 25000);
  const isConnection = detectConnectionSignals(networkBlob);
  const contact_candidates = buildContactCandidates(
    hiring,
    relSignals,
    container,
    companyName
  );
  const rec = contact_candidates.recruiter;
  const legacyFull =
    rec.full_name && isLikelyPersonName(rec.full_name, companyName)
      ? rec.full_name
      : null;
  const legacyFirst =
    legacyFull && extractFirstName(legacyFull) !== "there"
      ? extractFirstName(legacyFull)
      : null;
  const contact_first_name = legacyFirst || null;
  const extractedRole = (hiring.hiring_manager_role || "").trim() || null;
  const contact_detection = detectContactSignals(
    hiring,
    relSignals,
    networkBlob,
    blob,
    rec,
    companyName
  );
  const rl = (extractedRole || "").toLowerCase();
  let legacyContactType = "unknown";
  if (isConnection) {
    legacyContactType = "connection";
  } else if (/\bhiring manager\b/.test(rl)) {
    legacyContactType = "hiring_manager";
  } else if (
    /\b(recruit|recruiting|talent|sourcer|people partner|staffing)\b/.test(rl)
  ) {
    legacyContactType = "recruiter";
  }
  const contact_debug = buildContactDebug(
    hiring,
    relSignals,
    networkBlob,
    container
  );
  return {
    contact_name: legacyFull,
    contact_full_name: legacyFull,
    contact_first_name,
    contact_role: extractedRole,
    shared_company_names: relSignals.shared_company_names || [],
    contact_type: legacyContactType,
    seniority_hint: extractedRole,
    contact_detection,
    contact_candidates,
    contact_debug,
  };
}

/**
 * LinkedIn "Meet the hiring team" — best-effort; DOM varies by A/B tests.
 */
function extractHiringTeam(container) {
  const empty = () => ({
    hiring_team_visible: false,
    hiring_manager_name: "",
    hiring_manager_role: "",
    hiring_manager_profile_url: "",
    hiring_contact_source: "",
  });
  if (!container) return empty();

  const blob = (container.innerText || "").slice(0, 12000);
  const mentionsTeam = /meet the hiring team|hiring team/i.test(blob);
  const section =
    container.querySelector(
      "section.jobs-hiring-team, [class*='jobs-hiring-team'], [data-test-id*='hiring-team'], [data-view-name='job-details-hiring-team']"
    ) || (mentionsTeam ? container : null);

  if (!section && !mentionsTeam) return empty();

  const root = section || container;
  let profileUrl = "";
  let name = "";
  let role = "";

  const profileLink = root.querySelector(
    'a[href*="linkedin.com/in/"], a[href*="/in/"]'
  );
  if (profileLink && profileLink.href && /\/in\//.test(profileLink.href)) {
    profileUrl = profileLink.href.split("?")[0];
    const card =
      profileLink.closest("li, article, [class*='hirer'], [class*='hiring-team']") ||
      profileLink.parentElement;
    const nameEl = card?.querySelector(
      "h3, .jobs-hiring-team__member-name, [class*='member-name'], strong"
    );
    const subEl = card?.querySelector(
      "h4, .jobs-hiring-team__member-subtitle, [class*='member-subtitle'], .text-body-small"
    );
    name = getVisibleText(nameEl) || getVisibleText(profileLink);
    role = getVisibleText(subEl);
  }

  if (!name && mentionsTeam) {
    const h3s = root.querySelectorAll("h3, .jobs-hiring-team__member-name");
    for (const el of h3s) {
      const t = getVisibleText(el);
      if (t && t.length > 2 && t.length < 120 && !/^meet /i.test(t)) {
        name = t;
        const next = el.nextElementSibling;
        if (next) role = getVisibleText(next);
        break;
      }
    }
  }

  const visible = !!(mentionsTeam || section || name || profileUrl);

  let hiring_contact_source = "";
  if (/meet the hiring team/i.test(blob)) {
    hiring_contact_source = "meet_the_hiring_team";
  } else if (/job\s*poster|posted\s+by|posted\s+this\s+job/i.test(blob)) {
    hiring_contact_source = "job_poster";
  } else if (visible) {
    hiring_contact_source = "hiring_team";
  }

  return {
    hiring_team_visible: visible,
    hiring_manager_name: name.slice(0, 200),
    hiring_manager_role: role.slice(0, 300),
    hiring_manager_profile_url: profileUrl.slice(0, 500),
    hiring_contact_source,
  };
}

function safeString(v) {
  return v == null ? "" : String(v);
}

/** "About the job" and similar description containers (LinkedIn DOM variants). */
function jcExtractAboutTheJobBlockText(title, company) {
  let best = "";
  const tryText = (t) => {
    const s = (t || "").trim();
    if (s.length < 15) return;
    if (!/about the job/i.test(s)) return;
    const c = detectDescriptionContamination(s, title, company);
    if (c.contaminated) return;
    if (s.length > best.length) best = s;
  };
  const headings = document.querySelectorAll(
    "h2, h3, h4, [class*='job-details'], [class*='description']"
  );
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!/about the job/i.test(getVisibleText(h))) continue;
    let el = h.closest("section") || h.parentElement;
    for (let up = 0; up < 5 && el; up++) {
      tryText(getVisibleText(el));
      el = el.parentElement;
    }
  }
  const sections = document.querySelectorAll(
    "section, .jobs-description, .jobs-description__content, .jobs-box__html-content, [class*='jobs-details__main'], [class*='description-content']"
  );
  for (let j = 0; j < sections.length; j++) {
    tryText(getVisibleText(sections[j]));
  }
  return best;
}

/** Longest non-contaminated text from the same candidate bucket used in readiness checks. */
function jcLongestReadinessBucketDescription(title, company) {
  const href = window.location.href || "";
  const fullView = isLinkedInFullJobViewPath(href);
  const pageMode = detectLinkedInJobPageMode();
  const bucket = gatherDescriptionCandidateElements(null, {
    fullViewPage: fullView,
    resultsPanelMode: pageMode === "results_panel_mode",
  });
  let best = "";
  for (let i = 0; i < bucket.length; i++) {
    const t = (getVisibleText(bucket[i].el) || "").trim();
    if (t.length < 1) continue;
    const c = detectDescriptionContamination(t, title, company);
    if (c.contaminated) continue;
    if (t.length > best.length) best = t;
  }
  return best;
}

/** main / article under the active job detail pane. */
function jcMainArticleJobPaneText(title, company) {
  const roots = [
    getDetailPaneRootForHeaderExtraction(),
    getActiveJobDetailRoot(),
    findMainJobPane(),
  ].filter(Boolean);
  let best = "";
  for (let r = 0; r < roots.length; r++) {
    const root = roots[r];
    const nodes = root.querySelectorAll(
      'main, article, [role="main"], .jobs-details__main-content'
    );
    for (let k = 0; k < nodes.length; k++) {
      const t = (getVisibleText(nodes[k]) || "").trim();
      if (t.length < 40 || t.length <= best.length) continue;
      const c = detectDescriptionContamination(t, title, company);
      if (c.contaminated) continue;
      best = t;
    }
  }
  return best;
}

/**
 * Re-run extraction and merge fallback sources when popup payload has no description.
 */
function jcFallbackJobDescriptionBeforeSend(p) {
  const title = safeString(p.title).trim();
  const company = safeString(p.company).trim();
  const pageMode = detectLinkedInJobPageMode();
  const resultsPanelMode = pageMode === "results_panel_mode";
  const fullViewPage = pageMode === "full_view_mode";

  const detailRoot =
    getDetailPaneRootForHeaderExtraction() ||
    getActiveJobDetailRoot() ||
    findMainJobPane();

  const candidates = [];

  const push = (s) => {
    const t = safeString(s).trim();
    if (t.length >= 1) candidates.push(t);
  };

  try {
    const meta = extractJobDescriptionWithBestCandidate(
      detailRoot,
      title,
      company,
      { resultsPanelMode, fullViewPage }
    );
    push(meta && meta.text);
  } catch (_e) {
    /* ignore */
  }

  push(jcExtractAboutTheJobBlockText(title, company));
  push(jcMainArticleJobPaneText(title, company));
  push(jcLongestReadinessBucketDescription(title, company));

  try {
    const meta2 = extractJobDescriptionWithBestCandidate(
      null,
      title,
      company,
      { resultsPanelMode, fullViewPage }
    );
    push(meta2 && meta2.text);
  } catch (_e) {
    /* ignore */
  }

  let best = "";
  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    if (!t || t.length < 1) continue;
    const c = detectDescriptionContamination(t, title, company);
    if (c.contaminated) continue;
    if (t.length > best.length) best = t;
  }
  return best;
}

/**
 * Build POST /score-and-create-job body matching FastAPI ScoreJobRequest:
 * required str fields must never be null/omitted; lengths must match Field(max_length=...).
 * Optional string fields use "" instead of null so JSON never carries null for strings.
 */
function jcBuildScoreAndCreateApiPayload(p, cleanJobUrl) {
  const title = safeString(p.title).trim().slice(0, 300);
  const company = safeString(p.company).trim().slice(0, 200);
  // Backend ScoreJobRequest.job_description allows up to 100_000 chars.
  // The previous 3_000 cap was severing chip-rescue text appended to the end
  // of long JDs, which was why salary kept falling back to Market Estimate.
  let job_description = safeString(p.job_description).trim().slice(0, 50000);
  if (!job_description) {
    job_description = "No description available";
  }
  const urlRaw = safeString(cleanJobUrl).trim().slice(0, 500);
  const linkedinJobId = safeString(p.linkedin_job_id).trim().slice(0, 64);
  const loc = safeString(p.location).trim().slice(0, 200);
  const extTitle = safeString(p.extracted_title ?? p.title).trim().slice(0, 300);
  const extCompany = safeString(p.extracted_company ?? p.company).trim().slice(0, 200);
  const extTs = safeString(
    p.extraction_timestamp || new Date().toISOString()
  ).slice(0, 64);
  return {
    title,
    company,
    job_description,
    location: loc,
    linkedin_job_id: linkedinJobId,
    normalized_job_url: urlRaw,
    extracted_title: extTitle,
    extracted_company: extCompany,
    extraction_timestamp: extTs,
    source_url: urlRaw,
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "GET_JOB_DATA") {
    try {
      if (!isSupportedLinkedInJobPage()) {
        console.warn("[JC BLOCKED] unsupported page (GET_JOB_DATA)");
        try {
          sendResponse({
            extraction_failed: true,
            failure_reason: "unsupported_page",
            page_mode: "unknown",
            source_url: (window.location.href || "").slice(0, 500),
          });
        } catch (_e) {
          /* ignore */
        }
        return false;
      }
      runExtractionPipeline()
        .then((data) => {
          try {
            if (data == null) {
              console.warn("[JC BLOCKED] no job data");
            }
            const merged =
              data && typeof data === "object" ? { ...data } : {};
            const pageHref = window.location.href || "";
            if (isLinkedInFullJobViewPath(pageHref)) {
              const snap = getFullViewReadinessSnapshot({
                clearPairCache: false,
              });
              merged.jc_readiness_snapshot = snap;
              merged.jc_readiness_ok = snap.ready;
            } else if (shouldUseResultsPanelRootHref(pageHref)) {
              const snap = getResultsPanelReadinessSnapshot({
                clearPairCache: false,
              });
              merged.jc_readiness_snapshot = snap;
              merged.jc_readiness_ok = snap.ready;
            }
            console.log("[JC STEP] job detected", merged);
            try {
              sendResponse(merged);
            } catch (_e) {
              /* ignore */
            }
          } catch (e) {
            console.error("[JC ERROR]", e);
          }
        })
        .catch((err) => {
          console.error("[JC ERROR]", err);
          console.error(
            "[Job Copilot] extraction failed:",
            err && err.message ? err.message : err
          );
          jcVerboseLog("GET_JOB_DATA detail", err);
          try {
            sendResponse({
              extraction_failed: true,
              page_mode: "unknown",
              flow_error: String(err && err.message ? err.message : err),
              source_url:
                normalizeSourceUrlForApi() ??
                (window.location.href || "").slice(0, 500),
            });
          } catch (sendErr) {
            jcVerboseLog("GET_JOB_DATA sendResponse failed", sendErr);
          }
        });
    } catch (e) {
      console.error("[JC ERROR]", e);
    }
    return true;
  }

  if (request.type === "SCORE_AND_CREATE_JOB") {
    try {
      if (!isSupportedLinkedInJobPage()) {
        console.warn("[JC BLOCKED] unsupported page (SCORE_AND_CREATE_JOB)");
        try {
          sendResponse({
            ok: false,
            status: 0,
            bodyText: JSON.stringify({ error: "unsupported_page" }),
          });
        } catch (_e) {
          /* ignore */
        }
        return false;
      }
      (async () => {
        try {
          const p = request.payload || {};
          const cleanJobUrl = getCleanJobUrl();

          if (p.description_contaminated) {
            console.warn("[JC BLOCKED] description_contaminated (SCORE_AND_CREATE_JOB)");
            sendResponse({
              ok: false,
              status: 400,
              bodyText: JSON.stringify({
                error: "description_contaminated",
                extraction_debug: p.extraction_debug,
              }),
            });
            return;
          }

          let description = safeString(p.job_description).trim();
          console.log("[JC DESC] extracted length:", description?.length || 0);
          if (!description) {
            description = jcFallbackJobDescriptionBeforeSend(p);
          }

          if (!safeString(description).trim()) {
            description = "No description available";
          }

          const payload = {
            ...jcBuildScoreAndCreateApiPayload(
              { ...p, job_description: description },
              cleanJobUrl
            ),
            user_profile: p.user_profile || null,
          };
          console.log(
            "[JC DESC] final length before send:",
            payload.job_description?.length || 0
          );
          console.log("[JC PAYLOAD SANITIZED]", payload);

          const lid = (payload.linkedin_job_id || "").trim();
          const bypassDedupe = !!request.bypassScoreCreateDedupe;
          // Only dedupe when no user_profile is present — a profile change must
          // always reach the backend so scoring reflects the updated themes.
          const hasProfile = !!(payload.user_profile && (
            payload.user_profile.name ||
            (payload.user_profile.background_themes || []).length > 0
          ));
          if (
            !bypassDedupe &&
            !hasProfile &&
            lid &&
            lid === lastJobIdSent &&
            lastScoreCreateBodyText != null
          ) {
            console.log("[JC SKIP] Duplicate job");
            sendResponse({
              ok: true,
              status: 200,
              bodyText: lastScoreCreateBodyText,
            });
            return;
          }

          try {
            let hr;
            try {
              hr = await fetch(apiUrl("/health"), { method: "GET" });
            } catch (_netErr) {
              console.warn("[JC BACKEND DOWN]");
              sendResponse({
                ok: false,
                status: 0,
                bodyText: JSON.stringify({ error: "backend_unavailable" }),
              });
              return;
            }
            if (!hr.ok) {
              console.warn("[JC BACKEND DOWN]");
              sendResponse({
                ok: false,
                status: 0,
                bodyText: JSON.stringify({ error: "backend_unavailable" }),
              });
              return;
            }

            const r = await jcFetch(apiUrl("/score-and-create-job"), {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(payload),
            });
            const bodyText = await r.text();
            if (lid && r.ok) {
              lastJobIdSent = lid;
              lastScoreCreateBodyText = bodyText;
            }
            sendResponse({ ok: r.ok, status: r.status, bodyText });
          } catch (e) {
            console.error("[JC ERROR]", e);
            console.error(
              "[Job Copilot] score-and-create request failed:",
              e && e.message ? e.message : e
            );
            jcVerboseLog("SCORE_AND_CREATE_JOB detail", e);
            sendResponse({
              ok: false,
              status: 0,
              bodyText: String(e && e.message ? e.message : e),
            });
          }
        } catch (e) {
          console.error("[JC ERROR]", e);
        }
      })();
    } catch (e) {
      console.error("[JC ERROR]", e);
    }
    return true;
  }

  return false;
});

function injectStatusBadges() {
  if (!isSupportedLinkedInJobPage()) return;
  const jobCards = document.querySelectorAll(".jobs-search-results__list-item");
  jcVerboseLog("JOB CARDS FOUND:", jobCards.length);

  jobCards.forEach((card) => {
    const title =
      card.querySelector("a.job-card-list__title") ||
      card.querySelector(".job-card-container__link") ||
      card.querySelector("a");

    if (!title) return;
    if (title.querySelector(".job-copilot-status")) return;

    const badge = document.createElement("span");
    badge.className = "job-copilot-status";
    badge.innerText = "🧪 TEST";
    badge.style.marginLeft = "6px";
    badge.style.color = "red";
    badge.style.fontWeight = "bold";

    title.appendChild(badge);
  });
}

window.addEventListener("load", injectStatusBadges);

let timeout;
window.addEventListener("scroll", () => {
  clearTimeout(timeout);
  timeout = setTimeout(injectStatusBadges, 500);
});

setTimeout(injectStatusBadges, 1500);
