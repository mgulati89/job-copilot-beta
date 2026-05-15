const resultDiv = document.getElementById("result");
const previewDiv = document.getElementById("jobPreview");
const runBtn = document.getElementById("runBtn");

// ── Settings tab ──────────────────────────────────────────────────────────────

const JC_PROFILE_KEYS = [
  "jc_user_name",
  "jc_user_oneliner",
  "jc_user_themes",
  "jc_user_role_focus",
  "jc_user_seniority",
];

function initSettingsTabs() {
  document.querySelectorAll(".jc-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      document.querySelectorAll(".jc-tab").forEach((t) =>
        t.classList.toggle("active", t.dataset.tab === target)
      );
      document.querySelectorAll(".jc-tab-panel").forEach((p) =>
        p.classList.toggle("active", p.id === `tab-${target}`)
      );
    });
  });
}

function loadProfileForm() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  chrome.storage.local.get(JC_PROFILE_KEYS, (items) => {
    const nameEl = document.getElementById("jcSettingName");
    const oneEl = document.getElementById("jcSettingOneliner");
    const themesEl = document.getElementById("jcSettingThemes");
    const focusEl = document.getElementById("jcSettingRoleFocus");
    const seniorityEl = document.getElementById("jcSettingSeniority");
    if (nameEl) nameEl.value = items.jc_user_name || "";
    if (oneEl) oneEl.value = items.jc_user_oneliner || "";
    if (themesEl) themesEl.value = items.jc_user_themes || "";
    if (focusEl) focusEl.value = items.jc_user_role_focus || "";
    if (seniorityEl) seniorityEl.value = items.jc_user_seniority || "";
  });
}

function initSaveSettings() {
  const btn = document.getElementById("jcSaveSettings");
  const status = document.getElementById("jcSaveStatus");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const name = (document.getElementById("jcSettingName")?.value || "").trim();
    const oneliner = (document.getElementById("jcSettingOneliner")?.value || "").trim();
    const themes = (document.getElementById("jcSettingThemes")?.value || "").trim();
    const roleFocus = (document.getElementById("jcSettingRoleFocus")?.value || "").trim();
    const seniority = (document.getElementById("jcSettingSeniority")?.value || "").trim();
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set(
        {
          jc_user_name: name,
          jc_user_oneliner: oneliner,
          jc_user_themes: themes,
          jc_user_role_focus: roleFocus,
          jc_user_seniority: seniority,
        },
        () => {
          if (status) {
            status.textContent = "Saved ✓";
            setTimeout(() => { status.textContent = ""; }, 2000);
          }
          // Refresh the profile reminder in the analyze tab
          _updateProfileReminder({ jc_user_name: name, jc_user_oneliner: oneliner,
            jc_user_themes: themes, jc_user_role_focus: roleFocus, jc_user_seniority: seniority });
        }
      );
    }
  });
}

function _updateProfileReminder(items) {
  const el = document.getElementById("jcProfileReminder");
  if (!el) return;
  const hasProfile = !!(items.jc_user_name || items.jc_user_oneliner || items.jc_user_themes);
  el.style.display = hasProfile ? "none" : "block";
}

function initProfileReminder() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  chrome.storage.local.get(JC_PROFILE_KEYS, (items) => _updateProfileReminder(items));
}

/** Build UserProfile object from storage, or return null if nothing saved. */
function jcGetUserProfile(callback) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    callback(null);
    return;
  }
  chrome.storage.local.get(JC_PROFILE_KEYS, (items) => {
    const name = (items.jc_user_name || "").trim();
    const oneliner = (items.jc_user_oneliner || "").trim();
    const themesRaw = (items.jc_user_themes || "").trim();
    const roleFocus = (items.jc_user_role_focus || "").trim();
    const seniority = (items.jc_user_seniority || "").trim();
    if (!name && !oneliner && !themesRaw && !roleFocus && !seniority) {
      callback(null);
      return;
    }
    const themes = themesRaw
      ? themesRaw.split("\n").map((t) => t.trim()).filter(Boolean)
      : [];
    callback({ name, one_liner: oneliner, background_themes: themes, role_focus: roleFocus, seniority });
  });
}

const JC_DEBUG_STORAGE_KEY = "jc_debug_verbose";

function jcDebugEnabled() {
  try {
    return localStorage.getItem(JC_DEBUG_STORAGE_KEY) === "1";
  } catch (_e) {
    return false;
  }
}

function jcPersistDebugFlag(on) {
  const v = !!on;
  try {
    localStorage.setItem(JC_DEBUG_STORAGE_KEY, v ? "1" : "0");
  } catch (_e) {
    /* ignore */
  }
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ jc_debug_verbose: v });
    }
  } catch (_e) {
    /* ignore */
  }
}

/** Verbose logs and technical details only when Debug is on. */
function jcDbg(...args) {
  if (jcDebugEnabled()) console.log("[JC]", ...args);
}

function jcDbgError(...args) {
  if (jcDebugEnabled()) console.error("[JC]", ...args);
}

function jcSetDebugPanelText(text) {
  const el = document.getElementById("jcDebugPanel");
  if (!el) return;
  if (!jcDebugEnabled() || !text) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "block";
  el.textContent = text;
}

function jcClearDebugPanel() {
  const el = document.getElementById("jcDebugPanel");
  if (!el) return;
  el.style.display = "none";
  el.textContent = "";
}

/** Clear debug panel and stale diagnostics before each analysis run (UI only). */
function jcResetPopupRunState() {
  jcClearDebugPanel();
  currentJobId = null;
  try {
    window.jobCopilotJobId = null;
  } catch (_e) {
    /* ignore */
  }
}

function initJcDebugToggle() {
  const cb = document.getElementById("jcDebugToggle");
  if (!cb) return;
  cb.checked = jcDebugEnabled();
  jcPersistDebugFlag(cb.checked);
  cb.addEventListener("change", () => {
    jcPersistDebugFlag(cb.checked);
    if (!cb.checked) jcSetDebugPanelText("");
  });
}

let currentJobId = null;

/** Last scrape metadata — used to detect LinkedIn job / page changes between runs. */
let lastExtractionSession = null;

function jcEarly(_reason) {
  /* Caller sets result UI */
}

function jcFatal(err) {
  jcDbgError("run failed", err);
  jcSetDebugPanelText(err != null ? String(err.message || err) : "");
  if (resultDiv) {
    resultDiv.innerHTML = `<div style="padding:12px;color:#991b1b;font-size:13px;line-height:1.4;">Something went wrong. Close the popup and try again.</div>`;
  }
  const act = document.getElementById("actions");
  if (act) act.style.display = "none";
}

function isValidTitleForScoring(title) {
  const t = (title || "").trim();
  return t.length > 0 && t !== "Unknown";
}

/** Prefer extraction_debug.normalized_title; falls back to payload title. */
function jobNormalizedTitleFromPayload(jobData) {
  const ed = jobData?.extraction_debug;
  const n = ed?.normalized_title;
  if (n != null && String(n).trim() !== "") return String(n).trim();
  return (jobData?.title || "").trim();
}

function displayLabelTitle(title) {
  const t = (title || "").trim();
  return t && t !== "Unknown" ? t : "Unknown";
}

function displayLabelCompany(company) {
  const c = (company || "").trim();
  return c ? c : "Unknown";
}

function hasJobDescription(jobData) {
  if (jobData?.description_contaminated) return false;
  const d = jobData?.job_description && String(jobData.job_description).trim();
  return !!d;
}

function cleanJobTitle(title) {
  if (!title) return title;
  return String(title).replace(/\(.*?\)/g, "").trim();
}

/**
 * POST /score-and-create-job via content script. Use bypassScoreCreateDedupe when
 * recovering from stale ephemeral job ids (404 on /jobs/{id}/...) so the real POST runs.
 * userProfile is the resolved UserProfile object (or null) from chrome.storage.
 */
function jcPopupScoreAndCreateJob(
  tabId,
  jobData,
  effectiveLinkedInJobId,
  opts,
  userProfile
) {
  const normalizedTitleForApi = jobNormalizedTitleFromPayload(jobData);
  const msg = {
    type: "SCORE_AND_CREATE_JOB",
    payload: {
      title: cleanJobTitle(normalizedTitleForApi) ?? normalizedTitleForApi,
      company: jobData.company,
      job_description: jobData.job_description,
      location: jobData.location || null,
      linkedin_job_id: effectiveLinkedInJobId || "",
      normalized_job_url: jobData.source_url || null,
      extracted_title: normalizedTitleForApi || "",
      extracted_company: jobData.company || "",
      extraction_mode: jobData.extraction_mode || null,
      extraction_timestamp:
        jobData.extraction_session?.extractionTimestamp ||
        new Date().toISOString(),
      description_contaminated: !!jobData.description_contaminated,
      extraction_debug: jobData.extraction_debug || null,
      user_profile: userProfile || null,
    },
  };
  if (opts && opts.bypassScoreCreateDedupe) {
    msg.bypassScoreCreateDedupe = true;
  }
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Parse a successful score-and-create response for a fresh job id (linkedin id must match expectLid when both set).
 */
function jcParseScoreCreateJobForFreshId(createResPayload, expectLid) {
  if (!createResPayload || typeof createResPayload.status !== "number") {
    return null;
  }
  const createStatus = createResPayload.status;
  const createBodyText = createResPayload.bodyText ?? "";
  let j;
  try {
    j = JSON.parse(createBodyText);
  } catch {
    return null;
  }
  if (createStatus !== 200 && createStatus !== 201) {
    return null;
  }
  if (j.success === false && j.error) {
    return null;
  }
  if (j.id == null) {
    return null;
  }
  const expect = (expectLid || "").trim();
  const resp = (j.linkedin_job_id || "").trim();
  if (expect && resp && expect !== resp) {
    return null;
  }
  return j;
}

/** Best-effort job id from tab URL (matches content script patterns). */
function extractLinkedInJobIdFromHref(href) {
  const h = href || "";
  try {
    const u = new URL(h);
    const q = u.searchParams.get("currentJobId");
    if (q && /^\d+$/.test(q.trim())) return q.trim();
    const m = u.pathname.match(/\/jobs\/view\/(\d+)/);
    if (m) return m[1];
  } catch (e) {
    /* ignore */
  }
  let m = h.match(/[?&]currentJobId=(\d+)/);
  if (m) return m[1];
  m = h.match(/\/jobs\/view\/(\d+)/);
  return m ? m[1] : "";
}

async function markReviewing() {
  const button =
    document.getElementById("mark-reviewing-btn") ||
    document.querySelector('.status-btn[data-status="Reviewing"]');

  const jobId = window.jobCopilotJobId;

  if (!jobId) {
    jcDbgError("markReviewing: missing jobId");
    return;
  }

  button.disabled = true;
  button.innerText = "Updating...";

  try {
    const url = apiUrl(`/jobs/${jobId}/update-status`);

    const response = await jcFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "Reviewing",
      }),
    });

    if (!response.ok) {
      throw new Error("Request failed");
    }

    const data = await response.json();

    button.innerText = "Reviewing ✓";
    button.style.backgroundColor = "#16a34a";
    button.disabled = true;
  } catch (err) {
    jcDbgError("markReviewing failed", err);

    button.innerText = "Retry";
    button.disabled = false;
  }
}

document.addEventListener("click", function (e) {
  const btn = e.target.closest("#mark-reviewing-btn");

  if (!btn) return;

  jcDbg("mark-reviewing button clicked");

  markReviewing();
});

document.addEventListener("click", function (e) {
  const btn = e.target;

  if (!btn) return;

  // Match the Reviewing button by text
  if (btn.innerText && btn.innerText.trim() === "Reviewing") {
    jcDbg("Reviewing status button clicked");

    markReviewing();
  }
});

function highlightStatus(statusLabel) {
  document.querySelectorAll(".status-btn").forEach((b) => {
    b.style.fontWeight = b.dataset.status === statusLabel ? "bold" : "normal";
  });
}

async function loadJobStatus() {
  const jobId = window.jobCopilotJobId;

  if (!jobId) {
    jcDbg("loadJobStatus: no jobId");
    return;
  }

  try {
    const res = await jcFetch(apiUrl(`/jobs/${jobId}/status`));

    if (!res.ok) return;

    const data = await res.json();

    jcDbg("loadJobStatus:", data?.status);

    resetStatusButtonLabels();

    if (data.status === "Applied") {
      applyAppliedUI();
    } else if (data.status === "Reviewing") {
      applyReviewingUI();
    } else if (data.status === "Skipped") {
      applySkippedUI();
    }

    if (data.status) {
      highlightStatus(data.status);
    }

    const pb = document.getElementById("jobCopilotPriorityBanner");
    if (pb) {
      if (data.priority_hiring_outreach) {
        pb.style.display = "block";
        pb.innerText = "⚠️ High Priority: Send Outreach";
      } else {
        pb.style.display = "none";
        pb.innerText = "";
      }
    }

    const hs = document.getElementById("hiringOutreachStatus");
    if (hs && typeof data.hiring_outreach_sent === "boolean") {
      hs.innerText = data.hiring_outreach_sent
        ? "Outreach: Sent"
        : "Outreach: Not Sent";
    }
  } catch (err) {
    jcDbgError("Failed to load status", err);
  }
}

function resetStatusButtonLabels() {
  document.querySelectorAll(".status-btn").forEach((btn) => {
    const s = btn.dataset.status;
    if (s) btn.innerText = s;
    btn.style.backgroundColor = "";
  });
}

function applyReviewingUI() {
  const btn = document.querySelector('.status-btn[data-status="Reviewing"]');
  if (!btn) return;
  btn.innerText = "Reviewing ✓";
  btn.style.backgroundColor = "#16a34a";
}

function applyAppliedUI() {
  const btn = document.querySelector('.status-btn[data-status="Applied"]');
  if (!btn) return;
  btn.innerText = "Applied ✓";
  btn.style.backgroundColor = "#2563eb";
}

function applySkippedUI() {
  const btn = document.querySelector('.status-btn[data-status="Skipped"]');
  if (!btn) return;
  btn.innerText = "Skipped ✓";
  btn.style.backgroundColor = "#6b7280";
}

function priorityFromFit(fitScore) {
  const f = fitScore == null ? 0 : Number(fitScore);
  if (f >= 80) {
    return { label: "Apply Now", color: "#15803d", emoji: "🟢" };
  }
  if (f >= 70) {
    return { label: "Apply", color: "#1d4ed8", emoji: "🔵" };
  }
  if (f >= 55) {
    return { label: "Consider", color: "#c2410c", emoji: "🟠" };
  }
  return { label: "Skip", color: "#6b7280", emoji: "⚪" };
}

function extensionUiStatusFromJob(backendStatus) {
  const s = String(backendStatus || "");
  const map = {
    New: "New",
    Scored: "New",
    "Ready to Apply": "Reviewing",
    Shortlisted: "Reviewing",
    "Needs Review": "Reviewing",
    "Outreach Drafted": "Reviewing",
    "Outreach Sent": "Reviewing",
    Applied: "Applied",
    "Applied Pending Confirmation": "Applied",
    "Applied Confirmed": "Applied",
    Skipped: "Skipped",
    Rejected: "Skipped",
    Withdrawn: "Skipped",
  };
  return map[s] || "New";
}

function getJobData() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) {
        jcDbgError("getJobData: no active tab id");
        resolve(undefined);
        return;
      }
      chrome.tabs.sendMessage(
        tabs[0].id,
        { type: "GET_JOB_DATA" },
        (response) => {
          if (chrome.runtime.lastError) {
            jcDbgError("GET_JOB_DATA:", chrome.runtime.lastError.message);
          }
          if (response == null) {
            jcDbgError(
              "GET_JOB_DATA response null (content script missing on this tab?)"
            );
          }
          resolve(response);
        }
      );
    });
  });
}

function attachActionHandlers(jobData) {
  const jobId = jobData?.job_id;
  if (!jobId) return;

  const actionsEl = document.getElementById("actions");
  if (actionsEl) actionsEl.style.display = "block";

  document.querySelectorAll(".status-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const status = btn.dataset.status;

      try {
        const res = await jcFetch(apiUrl(`/jobs/${jobId}/update-status`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });

        if (res.ok) {
          resetStatusButtonLabels();
          if (status === "Reviewing") applyReviewingUI();
          else if (status === "Applied") applyAppliedUI();
          else if (status === "Skipped") applySkippedUI();
          highlightStatus(status);
        }
      } catch (err) {
        jcDbgError("Status update failed", err);
      }
    });
  });

  const active = jobData?.active_status;
  if (active) {
    highlightStatus(active);
  }

  const outreachBtn = document.getElementById("copyOutreach");
  if (outreachBtn) {
    if (!jobData?.outreach) {
      outreachBtn.style.display = "none";
    } else {
      outreachBtn.style.display = "";
      const defaultLabel = "Copy Outreach";
      outreachBtn.onclick = () => {
        const fullOutreachText = String(jobData.outreach || "");
        navigator.clipboard.writeText(fullOutreachText);
        jcDbg("outreach copied to clipboard");
        outreachBtn.innerText = "Copied ✓";
        setTimeout(() => {
          outreachBtn.innerText = defaultLabel;
        }, 1500);
      };
    }
  }
}

function isLinkedInResultsPanelUrl(url) {
  const u = url || "";
  return (
    u.includes("/jobs/search-results") ||
    u.includes("/jobs/collections") ||
    (u.includes("/jobs/search") && u.includes("currentJobId"))
  );
}

/** Same rules as content script isSupportedLinkedInJobPage (tab URL, not window). */
function isSupportedLinkedInJobPageUrl(href) {
  const h = href || "";
  let hostOk = false;
  try {
    hostOk = new URL(h).hostname.includes("linkedin.com");
  } catch (_e) {
    hostOk = h.includes("linkedin.com");
  }
  const pathOk =
    h.includes("/jobs/view/") ||
    /\/jobs\/view(\/|\?|$)/i.test(h) ||
    h.includes("/jobs/collections") ||
    h.includes("/jobs/search/") ||
    h.includes("/jobs/search-results") ||
    (h.includes("/jobs/search") && h.includes("currentJobId="));
  return hostOk && pathOk;
}

/** Cross-board: ATS hosts where cross-board.js is injected. */
const JC_CROSS_BOARD_HOST_SUFFIXES = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "workable.com",
  "myworkdayjobs.com",
  "welcometothejungle.com",
];

function isSupportedCrossBoardPageUrl(href) {
  const h = href || "";
  let host = "";
  try {
    host = new URL(h).hostname.toLowerCase();
  } catch (_e) {
    return false;
  }
  return JC_CROSS_BOARD_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith("." + suffix)
  );
}

function isSupportedJobPageUrl(href) {
  return (
    isSupportedLinkedInJobPageUrl(href) || isSupportedCrossBoardPageUrl(href)
  );
}

const MSG_INVALID_PAGE =
  "Open a LinkedIn job page or a supported board (Greenhouse, Lever, Ashby, Workable, Workday, Welcome to the Jungle) to use Job Copilot.";
const MSG_WAITING_DETAILS =
  "Waiting for job details to load...";
const MSG_EXTRACTION_FAILED =
  "Job didn't fully load. Try opening in full view or refreshing.";
const MSG_MISSING_TITLE_OR_COMPANY =
  "Could not read job title or company. Try refreshing the page.";

function jcLogPopupState(phase, errorMessage, jobData) {
  if (!jcDebugEnabled()) return;
  const snap = jobData?.jc_readiness_snapshot;
  const hasTitle = snap
    ? !!snap.hasTitle
    : !!(jobData && jobNormalizedTitleFromPayload(jobData));
  const hasCompany = snap
    ? !!snap.hasCompany
    : !!(jobData && jobData.company);
  const hasBodyText = snap
    ? !!snap.hasBodyText
    : !!hasJobDescription(jobData);
  console.log("[JC STATE]", {
    phase,
    errorMessage: errorMessage != null ? errorMessage : null,
    hasTitle,
    hasCompany,
    hasBodyText,
  });
}

async function runCopilot() {
  let phase = "init";
  let errorMessage = null;
  jcResetPopupRunState();
  const actionsEl = document.getElementById("actions");
  if (actionsEl) actionsEl.style.display = "none";

  if (resultDiv) {
    resultDiv.innerHTML = `<div style="font-size:13px;color:#374151;line-height:1.5;">Loading job data...</div>`;
  }
  if (previewDiv) previewDiv.innerHTML = "";
  jcLogPopupState(phase, null, null);

  try {
    phase = "page_check";
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tabs[0]?.url || "";

    if (!isSupportedJobPageUrl(pageUrl)) {
      // Surface the URL we gate-checked so debug shows why we rejected it.
      try {
        console.log("[JC GATE] rejected page URL:", pageUrl);
        jcSetDebugPanelText &&
          jcSetDebugPanelText(`Gate rejected: ${pageUrl || "(empty)"}`);
      } catch (_e) {
        /* ignore */
      }
      jcEarly("not a supported job page");
      resultDiv.innerHTML = `<div style="font-size:13px;color:#374151;line-height:1.5;padding:8px 0;">${MSG_INVALID_PAGE}</div>`;
      previewDiv.innerHTML = "";
      if (actionsEl) actionsEl.style.display = "none";
      return;
    }

    phase = "await_extraction";
    errorMessage = null;
    resultDiv.innerHTML = `<div style="font-size:13px;color:#374151;line-height:1.5;">${MSG_WAITING_DETAILS}</div>`;

    let jobData = await getJobData();
    jcDbg("[JC STEP] popup received GET_JOB_DATA", jobData);
    if (jobData == null) {
      jcDbg("[JC BLOCKED] no job data");
    }

    const session = jobData?.extraction_session || {};
    const prev = lastExtractionSession;
    const prevJid = (prev?.normalizedLinkedinJobId || "").trim();
    const curJid = (session.normalizedLinkedinJobId || "").trim();
    const staleStateCleared = !!(
      prevJid &&
      curJid &&
      prevJid !== curJid
    );
    if (staleStateCleared) {
      currentJobId = null;
      window.jobCopilotJobId = null;
    }
    lastExtractionSession = {
      normalizedLinkedinJobId: curJid,
      extractedTitle:
        session.extractedTitle || jobNormalizedTitleFromPayload(jobData) || "",
      extractedCompany: session.extractedCompany || jobData?.company || "",
      currentPageUrl: session.currentPageUrl || pageUrl,
    };

    phase = "after_get_job_data";
    jcLogPopupState(phase, null, jobData);

    const idFromTab = extractLinkedInJobIdFromHref(pageUrl);
    const extractedLid = (jobData?.linkedin_job_id || "").trim();
    if (
      extractedLid &&
      idFromTab &&
      extractedLid !== idFromTab
    ) {
      jcEarly("job id mismatch (tab vs extract)");
      previewDiv.innerHTML = "";
      if (actionsEl) actionsEl.style.display = "none";
      resultDiv.innerHTML = `
    <div style="padding:12px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;font-size:14px;line-height:1.5;">
      Job ID from the page does not match the extracted job. Try refreshing the page, then run Job Copilot again.
    </div>`;
      return;
    }

    if (jobData && jobData.description_contaminated) {
      jcEarly("description_contaminated_search_results");
      resultDiv.innerHTML = `
    <div style="padding:12px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;font-size:14px;line-height:1.5;">
      The extracted text looked like <b>search results</b> (not the selected job posting). Open this job in <b>full view</b> and run Job Copilot again so the backend receives the real description and location.
    </div>`;
      previewDiv.innerHTML = "";
      if (actionsEl) actionsEl.style.display = "none";
      return;
    }

    if (jobData && jobData.extraction_failed) {
      const readinessOkFullView =
        jobData.page_mode === "full_view_mode" &&
        jobData.jc_readiness_ok === true;
      const readinessOkResultsPanel =
        jobData.page_mode === "results_panel_mode" &&
        jobData.jc_readiness_ok === true;
      if (readinessOkFullView || readinessOkResultsPanel) {
        phase = readinessOkFullView
          ? "readiness_ok_skip_stale_extraction_failed"
          : "readiness_ok_results_panel_skip_stale_extraction_failed";
        errorMessage = null;
        jcLogPopupState(phase, null, jobData);
      } else {
        jcEarly("extraction_failed");
        errorMessage = MSG_EXTRACTION_FAILED;
        previewDiv.innerHTML = "";
        if (actionsEl) actionsEl.style.display = "none";
        if (jobData.page_mode === "results_panel_mode") {
          const jid = (jobData.linkedin_job_id || "").trim();
          const openBtn =
            jid.length > 0
              ? `<div style="margin-top:10px;"><button type="button" id="openFullJobViewBtn" style="padding:8px 12px;font-size:13px;cursor:pointer;border-radius:6px;border:1px solid #2563eb;background:#eff6ff;color:#1d4ed8;">Open Full Job View</button></div>`
              : "";
          resultDiv.innerHTML = `
    <div style="padding:12px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;font-size:14px;line-height:1.5;">
      ${MSG_EXTRACTION_FAILED}
      ${openBtn}
    </div>`;
          const ob = document.getElementById("openFullJobViewBtn");
          if (ob && jid && tabs[0]?.id != null) {
            ob.onclick = () => {
              let origin = "https://www.linkedin.com";
              try {
                origin = new URL(pageUrl).origin;
              } catch (e) {
                /* ignore */
              }
              chrome.tabs.update(tabs[0].id, {
                url: `${origin}/jobs/view/${jid}/`,
              });
              window.close();
            };
          }
        } else if (jobData.page_mode === "full_view_mode") {
          resultDiv.innerHTML = `
    <div style="padding:12px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;font-size:14px;line-height:1.5;">
      ${MSG_EXTRACTION_FAILED}
    </div>`;
        } else {
          resultDiv.innerHTML = `
    <div style="padding:12px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;font-size:14px;line-height:1.5;">
      ${MSG_INVALID_PAGE}
    </div>`;
        }
        jcLogPopupState("extraction_failed_ui", errorMessage, jobData);
        return;
      }
    }

    if (
      !jobData ||
      !jobNormalizedTitleFromPayload(jobData) ||
      !jobData.company
    ) {
      if (!jobData) {
        jcDbg("[JC BLOCKED] no job data");
      } else {
        jcDbg("[JC BLOCKED] missing title or company", {
          title: jobNormalizedTitleFromPayload(jobData),
          company: jobData?.company,
        });
      }
      jcEarly("extraction empty or missing title/company");
      phase = "missing_title_or_company";
      errorMessage = MSG_MISSING_TITLE_OR_COMPANY;
      resultDiv.innerHTML = `
    <div style="padding:12px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;font-size:14px;line-height:1.5;">
      ${MSG_MISSING_TITLE_OR_COMPANY}
    </div>`;
      previewDiv.innerHTML = "";
      if (actionsEl) actionsEl.style.display = "none";
      jcLogPopupState(phase, errorMessage, jobData);
      return;
    }

    const descFound = hasJobDescription(jobData);
    const missingCriticalFields =
      !isValidTitleForScoring(jobNormalizedTitleFromPayload(jobData)) ||
      !(jobData?.company || "").trim();

    const displayTitle = displayLabelTitle(jobNormalizedTitleFromPayload(jobData));
    const displayCompany = displayLabelCompany(jobData?.company);

    if (missingCriticalFields) {
      previewDiv.innerHTML = "";
    } else {
      const partialNote =
        jobData.extraction_mode === "partial"
          ? '<div style="font-size:12px;color:#6b7280;margin-top:8px;">Using partial job description (shorter than ideal).</div>'
          : "";
      previewDiv.innerHTML = `
  <b>Title:</b> ${displayLabelTitle(jobNormalizedTitleFromPayload(jobData))}<br/>
  <b>Company:</b> ${displayLabelCompany(jobData?.company)}<br/>
  <b>Description:</b> found
  ${partialNote}
`;
    }

    if (missingCriticalFields) {
      const resultsPartial =
        jobData.page_mode === "results_panel_mode" ||
        isLinkedInResultsPanelUrl(pageUrl);
      const partialHeadline = resultsPartial
        ? "LinkedIn results view — partial extract"
        : "Easy Apply / Partial Page Mode";
      const partialBody = resultsPartial
        ? "We couldn't fully load the job description from the search results panel. Open the job in full view for reliable scoring, or continue with limited data."
        : "We could not fully extract this job description, so full scoring is skipped.";
      resultDiv.innerHTML = `
    <div style="border:1px solid #ddd; border-radius:8px; padding:10px; margin-top:10px; background:#fafafa; font-size:14px;">
      <div style="font-weight:bold; margin-bottom:6px;">${partialHeadline}</div>
      <div style="margin-bottom:8px;">
        ${partialBody}
      </div>
      <div style="margin-bottom:8px;">
        <b>Company:</b> ${displayCompany}<br/>
        <b>Title:</b> ${displayTitle}<br/>
        <b>Description:</b> ${descFound ? "found" : "not found"}
      </div>
      <div id="fallbackActions">
        <button id="mark-reviewing-btn">Mark Reviewing</button>
        <button id="copyCompanyBtn">Copy Company</button>
        ${
          resultsPartial && (jobData.linkedin_job_id || "").trim()
            ? `<button type="button" id="openFullJobPartialBtn" style="margin-left:6px;">Open Full Job View</button>`
            : ""
        }
      </div>
      </div>
  `;
      const openPartial = document.getElementById("openFullJobPartialBtn");
      if (openPartial && jobData.linkedin_job_id && tabs[0]?.id != null) {
        openPartial.onclick = () => {
          let origin = "https://www.linkedin.com";
          try {
            origin = new URL(pageUrl).origin;
          } catch (e) {
            /* ignore */
          }
          chrome.tabs.update(tabs[0].id, {
            url: `${origin}/jobs/view/${String(jobData.linkedin_job_id).trim()}/`,
          });
          window.close();
        };
      }

      const copyBtn = document.getElementById("copyCompanyBtn");
      if (copyBtn) {
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(jobData?.company || "");
          jcDbg("company copied");
        };
      }

      if (actionsEl) actionsEl.style.display = "none";
      jcEarly("partial extract / missing critical fields for scoring");
      return;
    }

    const tabsForCreate = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const tabUrlForCreate = tabsForCreate[0]?.url || "";
    const tabIdForCreate = tabsForCreate[0]?.id;
    const idFromTabForCreate = extractLinkedInJobIdFromHref(tabUrlForCreate);
    const effectiveLinkedInJobId =
      (jobData.linkedin_job_id || "").trim() || idFromTabForCreate;

    if (tabIdForCreate == null) {
      jcEarly("no active tab id for create job");
      resultDiv.innerHTML =
        '<div style="padding:12px;color:#92400e;">No active tab for create job.</div>';
      if (actionsEl) actionsEl.style.display = "none";
      return;
    }

    // Fetch user profile once — used for scoring and outreach requests
    const activeUserProfile = await new Promise((res) => jcGetUserProfile(res));

    let createResPayload;
    try {
      phase = "score_and_create";
      errorMessage = null;
      jcLogPopupState(phase, null, jobData);
      const normalizedTitleForApi = jobNormalizedTitleFromPayload(jobData);
      jcDbg("[JC STEP] popup about to send SCORE_AND_CREATE_JOB", {
        tabId: tabIdForCreate,
        jobDataSummary: {
          title: normalizedTitleForApi,
          company: jobData.company,
          linkedin_job_id: effectiveLinkedInJobId || "",
        },
      });
      createResPayload = await jcPopupScoreAndCreateJob(
        tabIdForCreate,
        jobData,
        effectiveLinkedInJobId,
        null,
        activeUserProfile
      );
      jcDbg("[JC STEP] popup received SCORE_AND_CREATE_JOB response", createResPayload);
    } catch (e) {
      jcDbgError("content script sendMessage failed", e);
      jcSetDebugPanelText(String(e && e.message ? e.message : e));
      resultDiv.innerHTML = `<div style="padding:12px;color:#92400e;font-size:14px;line-height:1.5;">Could not reach the page script. Reload the LinkedIn tab and try again.</div>`;
      if (actionsEl) actionsEl.style.display = "none";
      jcEarly("content script sendMessage failed");
      return;
    }

    if (
      !createResPayload ||
      typeof createResPayload.status !== "number"
    ) {
      jcDbg("[JC BLOCKED] invalid create response shape (no status)", createResPayload);
      jcDbgError("Invalid create response (no status)", createResPayload);
      jcEarly("invalid create response (no status)");
      resultDiv.innerHTML =
        "Error creating job (no response from page). Reload the LinkedIn tab.";
      if (actionsEl) actionsEl.style.display = "none";
      return;
    }

    const createStatus = createResPayload.status;
    const createBodyText = createResPayload.bodyText ?? "";

    jcDbg("[JC STEP] popup create response body (raw)", {
      createStatus,
      bodyPreview: String(createBodyText).slice(0, 500),
    });

    let job;
    try {
      job = JSON.parse(createBodyText);
    } catch (parseErr) {
      jcDbgError(
        "create job response is not JSON",
        parseErr,
        String(createBodyText).slice(0, 800)
      );
      jcEarly("JSON parse error on create job body");
      resultDiv.innerHTML = "Error creating job (invalid response)";
      if (actionsEl) actionsEl.style.display = "none";
      return;
    }

    if (createStatus !== 200 && createStatus !== 201) {
      if (
        createStatus === 400 &&
        (createBodyText.includes("description_contaminated") ||
          job?.error === "description_contaminated")
      ) {
        jcEarly("create blocked: description_contaminated (content guard)");
        resultDiv.innerHTML = `<div style="padding:12px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;font-size:14px;line-height:1.5;">
          Job description was not sent (search-results contamination guard). Open the job in <b>full view</b> and run Job Copilot again.
        </div>`;
        if (actionsEl) actionsEl.style.display = "none";
        return;
      }
      if (
        createStatus === 400 &&
        (job?.error === "empty_job_description" ||
          createBodyText.includes("empty_job_description"))
      ) {
        jcEarly("create blocked: empty_job_description");
        const msg =
          job?.message ||
          "Could not extract the job description from this page.";
        resultDiv.innerHTML = `<div style="padding:12px;color:#92400e;font-size:14px;line-height:1.5;">${msg}</div>`;
        if (actionsEl) actionsEl.style.display = "none";
        return;
      }
      if (createStatus === 422) {
        const detail =
          job?.detail != null
            ? typeof job.detail === "string"
              ? job.detail
              : JSON.stringify(job.detail)
            : createBodyText;
        jcDbgError("create job HTTP 422 validation", detail);
        jcSetDebugPanelText(String(detail).slice(0, 2000));
        jcEarly("create job HTTP 422 validation");
        resultDiv.innerHTML = `<div style="padding:12px;color:#92400e;font-size:14px;line-height:1.5;">Job payload failed validation. Check Debug.</div>`;
        if (actionsEl) actionsEl.style.display = "none";
        return;
      }
      const errMsg =
        job?.error ||
        (typeof job?.detail === "string" ? job.detail : JSON.stringify(job?.detail)) ||
        createBodyText;
      jcDbgError(`create job HTTP ${createStatus}`, errMsg);
      jcSetDebugPanelText(String(errMsg).slice(0, 800));
      jcEarly(`create job HTTP ${createStatus}`);
      resultDiv.innerHTML = `<div style="padding:12px;color:#92400e;font-size:14px;line-height:1.5;">Could not save the job. Try again, or open Debug for details.</div>`;
      if (actionsEl) actionsEl.style.display = "none";
      return;
    }

    if (job.success === false && job.error) {
      jcDbgError("job.success false", job.error);
      jcSetDebugPanelText(String(job.error).slice(0, 800));
      jcEarly("job.success false with error");
      resultDiv.innerHTML = `<div style="padding:12px;color:#92400e;font-size:14px;line-height:1.5;">Could not save the job. Try again.</div>`;
      if (actionsEl) actionsEl.style.display = "none";
      return;
    }

    if (job.id == null) {
      jcDbgError("missing job.id in create response", job);
      jcEarly("missing job.id in response");
      resultDiv.innerHTML = "Error creating job (missing job id in response)";
      if (actionsEl) actionsEl.style.display = "none";
      return;
    }

    const expectLid = (effectiveLinkedInJobId || "").trim();
    const respLid = (job.linkedin_job_id || "").trim();
    if (expectLid && respLid && expectLid !== respLid) {
      jcEarly("response mismatch: linkedin_job_id !== expected");
      resultDiv.innerHTML = `<div style="padding:12px;color:#92400e;font-size:14px;">Job changed during extraction. Please rerun Job Copilot on the current listing.</div>`;
      if (actionsEl) actionsEl.style.display = "none";
      return;
    }

    let freshJobId = job.id;
    currentJobId = freshJobId;
    window.jobCopilotJobId = freshJobId;

    let pkgRes;
    let sgRes;
    for (let downstreamAttempt = 0; downstreamAttempt < 2; downstreamAttempt++) {
      [pkgRes, sgRes] = await Promise.all([
        jcFetch(apiUrl(`/jobs/${freshJobId}/generate-application-package`), {
          method: "POST",
        }),
        jcFetch(apiUrl(`/jobs/${freshJobId}/salary-guidance`)),
      ]);
      const downstream404 =
        pkgRes.status === 404 || sgRes.status === 404;
      if (!downstream404 || downstreamAttempt === 1) {
        break;
      }
      jcDbg(
        "downstream 404 on package/salary; rerunning score-and-create once (ephemeral job id)"
      );
      let retryPayload;
      try {
        retryPayload = await jcPopupScoreAndCreateJob(
          tabIdForCreate,
          jobData,
          effectiveLinkedInJobId,
          { bypassScoreCreateDedupe: true },
          activeUserProfile
        );
      } catch (e) {
        jcDbgError("content script sendMessage failed on 404 retry", e);
        jcSetDebugPanelText(String(e && e.message ? e.message : e));
        resultDiv.innerHTML = `<div style="padding:12px;color:#92400e;font-size:14px;line-height:1.5;">Could not reach the page script. Reload the LinkedIn tab and try again.</div>`;
        if (actionsEl) actionsEl.style.display = "none";
        jcEarly("content script sendMessage failed (404 retry)");
        return;
      }
      const jobRetry = jcParseScoreCreateJobForFreshId(
        retryPayload,
        expectLid
      );
      if (!jobRetry) {
        jcEarly("score-and-create retry after 404 failed");
        resultDiv.innerHTML = `<div style="padding:12px;color:#92400e;font-size:14px;line-height:1.5;">The job session expired on the server. Close the popup and run Job Copilot again.</div>`;
        if (actionsEl) actionsEl.style.display = "none";
        return;
      }
      job = jobRetry;
      freshJobId = job.id;
      currentJobId = freshJobId;
      window.jobCopilotJobId = freshJobId;
    }

    if (pkgRes.status !== 200 && pkgRes.status !== 201) {
      jcEarly("generate-application-package failed");
      resultDiv.innerHTML = "Error generating package";
      if (actionsEl) actionsEl.style.display = "none";
      return;
    }

    const pkg = await pkgRes.json();
    let salaryGuidance = null;
    if (sgRes.ok) {
      salaryGuidance = await sgRes.json();
    }
    if (
      salaryGuidance &&
      expectLid &&
      salaryGuidance.linkedin_job_id &&
      String(salaryGuidance.linkedin_job_id).trim() !== expectLid
    ) {
      jcDbg(
        "salary-guidance linkedin_job_id mismatch; dropping salary block"
      );
      salaryGuidance = null;
    }

    const insightText = pkg.fit_summary?.[0] || "";

    // Run hiring-outreach-suggest and generate-outreach concurrently — they
    // hit independent endpoints and combined latency was the largest remaining
    // sequential block in the popup pipeline.
    const hiringSuggestPromise =
      job.fit_score >= 75
        ? jcFetch(apiUrl(`/jobs/${job.id}/hiring-outreach-suggest`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              hiring_team_visible: !!jobData.hiring_team_visible,
              hiring_manager_name: jobData.hiring_manager_name || null,
              hiring_manager_role: jobData.hiring_manager_role || null,
              hiring_manager_profile_url:
                jobData.hiring_manager_profile_url || null,
              shared_company_names: jobData.shared_company_names || [],
              contact_seniority: jobData.contact_seniority || "unknown",
              contact_type: jobData.contact_type || "unknown",
              relationship_context: jobData.relationship_context || null,
            }),
          })
            .then(async (r) => (r && r.ok ? await r.json() : null))
            .catch((e) => {
              jcDbgError("hiring-outreach-suggest failed", e);
              return null;
            })
        : Promise.resolve(null);

    const outreachPromise =
      job.fit_score >= 70 && job.recommended_action !== "Apply Now"
        ? jcFetch(apiUrl(`/jobs/${job.id}/generate-outreach`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              relationship_context: jobData.relationship_context || null,
              user_profile: activeUserProfile || null,
            }),
          })
            .then(async (r) =>
              r && (r.status === 200 || r.status === 201)
                ? await r.json()
                : null
            )
            .catch((e) => {
              jcDbgError("generate-outreach failed", e);
              return null;
            })
        : Promise.resolve(null);

    let hiringSuggest = null;
    let outreach = null;
    [hiringSuggest, outreach] = await Promise.all([
      hiringSuggestPromise,
      outreachPromise,
    ]);
    if (
      outreach &&
      expectLid &&
      outreach.linkedin_job_id &&
      String(outreach.linkedin_job_id).trim() !== expectLid
    ) {
      outreach = null;
    }

    const tabsFinal = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const urlFinal = tabsFinal[0]?.url || "";
    const idFinal = extractLinkedInJobIdFromHref(urlFinal);
    if (expectLid && idFinal && expectLid !== idFinal) {
      jcEarly("tab job id changed before render (stale)");
      resultDiv.innerHTML = `<div style="padding:12px;color:#92400e;font-size:14px;">Job changed during extraction. Please rerun Job Copilot on the current listing.</div>`;
      if (actionsEl) actionsEl.style.display = "none";
      return;
    }

    let outreachCopyText = "";
    let outreachRot = null;
    if (outreach) {
      outreachRot = outreach.recommended_outreach_type;
      const drafts = outreach.drafts || {};
      const strat = outreach.outreach_strategy;
      if (Array.isArray(strat) && strat.length > 0) {
        const primary =
          strat.find((b) => b.priority === "primary") || strat[0];
        outreachCopyText = primary?.message || "";
      } else {
        outreachCopyText =
          drafts[`${outreachRot}_clean`] || drafts[outreachRot] || "";
      }
    }

    previewDiv.innerHTML = "";

    resultDiv.innerHTML = "";

    const card = document.createElement("div");
    card.style.border = "1px solid #ddd";
    card.style.borderRadius = "8px";
    card.style.padding = "10px";
    card.style.marginTop = "10px";
    card.style.fontSize = "14px";
    card.style.background = "#fafafa";

    const priorityBanner = document.createElement("div");
    priorityBanner.id = "jobCopilotPriorityBanner";
    priorityBanner.style.display = "none";
    priorityBanner.style.marginBottom = "8px";
    priorityBanner.style.padding = "8px";
    priorityBanner.style.background = "#fef3c7";
    priorityBanner.style.border = "1px solid #f59e0b";
    priorityBanner.style.borderRadius = "6px";
    priorityBanner.style.fontSize = "13px";
    priorityBanner.style.fontWeight = "600";
    priorityBanner.style.color = "#92400e";
    card.appendChild(priorityBanner);

    if (job.notion_sync_ok === false) {
      const notionWarn = document.createElement("div");
      notionWarn.style.marginBottom = "8px";
      notionWarn.style.padding = "8px";
      notionWarn.style.background = "#fef2f2";
      notionWarn.style.border = "1px solid #fecaca";
      notionWarn.style.borderRadius = "6px";
      notionWarn.style.fontSize = "13px";
      notionWarn.style.color = "#991b1b";
      notionWarn.innerText = "Saved locally, Notion sync failed";
      card.appendChild(notionWarn);
      if (jcDebugEnabled() && job.notion_sync_error) {
        jcSetDebugPanelText(`notion_sync_error: ${job.notion_sync_error}`);
      }
    }

    const header = document.createElement("div");
    header.style.fontWeight = "bold";
    header.style.marginBottom = "6px";
    header.innerText = job.title + " @ " + job.company;

    const rec = document.createElement("div");
    rec.style.marginBottom = "6px";

    const fitLine = document.createElement("div");
    fitLine.style.fontSize = "14px";
    fitLine.innerHTML = `<b>Fit Score:</b> ${job.fit_score}`;
    rec.appendChild(fitLine);

    // Domain mismatch warning — show before priority so it's the first thing seen
    if (job.domain_mismatch) {
      const dmBanner = document.createElement("div");
      dmBanner.style.marginTop = "8px";
      dmBanner.style.marginBottom = "4px";
      dmBanner.style.padding = "7px 10px";
      dmBanner.style.background = "#fef3c7";
      dmBanner.style.border = "1px solid #f59e0b";
      dmBanner.style.borderRadius = "6px";
      dmBanner.style.fontSize = "12px";
      dmBanner.style.color = "#92400e";
      dmBanner.style.lineHeight = "1.5";
      dmBanner.innerHTML =
        `⚠️ <b>Domain mismatch</b> · Score penalized<br>` +
        `<span style="font-weight:normal">${job.domain_mismatch_reason || "Non-GTM domain detected — verify this is a fit before applying."}</span>`;
      rec.appendChild(dmBanner);
    }

    const pri = priorityFromFit(job.fit_score);
    if (pri.label === "Skip") {
      card.style.opacity = "0.85";
    }
    const priorityLine = document.createElement("div");
    priorityLine.style.fontWeight = "bold";
    priorityLine.style.fontSize = "15px";
    priorityLine.style.marginTop = "6px";
    priorityLine.style.marginBottom = "4px";
    priorityLine.style.color = pri.color;
    priorityLine.innerText = `${pri.emoji} Priority: ${pri.label}`;

    const resumeLine = document.createElement("div");
    resumeLine.style.fontSize = "14px";
    resumeLine.innerHTML = `<b>Resume:</b> ${job.resume_recommendation_display || job.recommended_resume_variant}`;

    rec.appendChild(priorityLine);

    rec.appendChild(resumeLine);

    const status = document.createElement("div");
    status.style.marginBottom = "6px";
    status.innerHTML = `<b>Saved:</b> ${job.notion_page_id ? "✅ Yes" : "❌ No"}`;

    const why = document.createElement("div");
    why.style.fontSize = "13px";
    why.style.color = "#555";
    why.innerHTML = `<b>Why:</b> ${insightText}`;

    card.appendChild(header);
    card.appendChild(rec);
    card.appendChild(status);
    card.appendChild(why);

    if (salaryGuidance && salaryGuidance.copy_text) {
      const sgBlock = document.createElement("div");
      sgBlock.style.marginTop = "10px";
      sgBlock.style.paddingTop = "8px";
      sgBlock.style.borderTop = "1px solid #ddd";

      const sgTitle = document.createElement("div");
      sgTitle.style.fontWeight = "bold";
      sgTitle.style.marginBottom = "6px";
      sgTitle.innerText = "Salary Guidance";

      const sgRange = document.createElement("div");
      sgRange.style.fontSize = "15px";
      sgRange.style.marginBottom = "4px";
      sgRange.innerText = salaryGuidance.copy_text;

      const sd = salaryGuidance.salary_debug || {};
      const displaySrcRaw =
        salaryGuidance.display_source != null &&
        String(salaryGuidance.display_source).trim() !== ""
          ? String(salaryGuidance.display_source).trim()
          : sd.display_source != null && String(sd.display_source).trim() !== ""
            ? String(sd.display_source).trim()
            : "";
      const srcLine = displaySrcRaw
        ? `Source: ${displaySrcRaw}`
        : "Source: —";
      const sgSrc = document.createElement("div");
      sgSrc.style.fontSize = "12px";
      sgSrc.style.color = "#555";
      sgSrc.style.marginBottom = "4px";
      sgSrc.innerText = srcLine;

      sgBlock.appendChild(sgTitle);
      sgBlock.appendChild(sgRange);
      sgBlock.appendChild(sgSrc);
      if (
        salaryGuidance.confidence != null &&
        salaryGuidance.confidence !== undefined
      ) {
        const sgConf = document.createElement("div");
        sgConf.style.fontSize = "11px";
        sgConf.style.color = "#777";
        sgConf.style.marginBottom = "4px";
        sgConf.innerText = `Confidence: ${Math.round(
          Number(salaryGuidance.confidence) * 100
        )}%`;
        sgBlock.appendChild(sgConf);
      }

      if (salaryGuidance.listed_in_jd) {
        const listed = document.createElement("div");
        listed.style.fontSize = "12px";
        listed.style.color = "#444";
        listed.style.marginBottom = "6px";
        listed.innerText = salaryGuidance.listed_in_jd;
        sgBlock.appendChild(listed);
      }

      const copySalBtn = document.createElement("button");
      copySalBtn.type = "button";
      copySalBtn.innerText = "Copy Salary Answer";
      copySalBtn.onclick = () => {
        navigator.clipboard.writeText(String(salaryGuidance.copy_text || ""));
        copySalBtn.innerText = "Copied ✓";
        setTimeout(() => {
          copySalBtn.innerText = "Copy Salary Answer";
        }, 1500);
      };
      sgBlock.appendChild(copySalBtn);
      card.appendChild(sgBlock);
    }

    if (hiringSuggest && hiringSuggest.eligible) {
      const hsBlock = document.createElement("div");
      hsBlock.style.marginTop = "10px";
      hsBlock.style.paddingTop = "8px";
      hsBlock.style.borderTop = "1px solid #ddd";

      const hsTitle = document.createElement("div");
      hsTitle.style.fontWeight = "bold";
      hsTitle.style.marginBottom = "6px";
      hsTitle.innerText = "Outreach Suggested";

      const hsMeta = document.createElement("div");
      hsMeta.style.fontSize = "12px";
      hsMeta.style.marginBottom = "4px";
      hsMeta.style.color = "#444";
      const hmName = hiringSuggest.hiring_manager_name || "—";
      const hmRole = hiringSuggest.hiring_manager_role || "—";
      hsMeta.innerHTML = `<b>Hiring contact:</b> ${hmName} · ${hmRole}`;

      const hsStatus = document.createElement("div");
      hsStatus.id = "hiringOutreachStatus";
      hsStatus.style.fontSize = "12px";
      hsStatus.style.marginBottom = "6px";
      hsStatus.innerText = hiringSuggest.hiring_outreach_sent
        ? "Outreach: Sent"
        : "Outreach: Not Sent";

      const hsPrev = document.createElement("div");
      hsPrev.className = "outreach-container";
      hsPrev.style.maxHeight = "140px";
      hsPrev.innerText = hiringSuggest.message || "";

      const btnRow = document.createElement("div");
      btnRow.style.marginTop = "8px";
      btnRow.style.display = "flex";
      btnRow.style.flexWrap = "wrap";
      btnRow.style.gap = "6px";

      const copyMsgBtn = document.createElement("button");
      copyMsgBtn.type = "button";
      copyMsgBtn.innerText = "Copy message";
      copyMsgBtn.onclick = () => {
        navigator.clipboard.writeText(String(hiringSuggest.message || ""));
        copyMsgBtn.innerText = "Copied ✓";
        setTimeout(() => {
          copyMsgBtn.innerText = "Copy message";
        }, 1500);
      };

      const liBtn = document.createElement("button");
      liBtn.type = "button";
      liBtn.innerText = "Open LinkedIn";
      liBtn.onclick = () => {
        const u = hiringSuggest.linkedin_url || "";
        if (u) chrome.tabs.create({ url: u });
      };

      const markSentBtn = document.createElement("button");
      markSentBtn.type = "button";
      markSentBtn.innerText = "Mark outreach sent";
      markSentBtn.disabled = !!hiringSuggest.hiring_outreach_sent;
      markSentBtn.onclick = async () => {
        try {
          const r = await jcFetch(
            apiUrl(`/jobs/${job.id}/mark-hiring-outreach-sent`),
            { method: "POST" }
          );
          if (r.ok) {
            markSentBtn.disabled = true;
            const st = document.getElementById("hiringOutreachStatus");
            if (st) st.innerText = "Outreach: Sent";
            const pb = document.getElementById("jobCopilotPriorityBanner");
            if (pb) pb.style.display = "none";
          }
        } catch (e) {
          jcDbgError("mark-hiring-outreach-sent failed", e);
        }
      };

      btnRow.appendChild(copyMsgBtn);
      btnRow.appendChild(liBtn);
      btnRow.appendChild(markSentBtn);

      hsBlock.appendChild(hsTitle);
      hsBlock.appendChild(hsMeta);
      const rcd = jobData?.relationship_context?.contact_debug;
      if (rcd && rcd.contact_type) {
        const contactLabel = {
          warm_contact: "Contact type: Warm contact",
          historical_connection: "Contact type: Historical connection",
          hiring_team_contact: "Contact type: Hiring contact",
          unknown_or_none: "Contact type: No contact context",
        };
        const line = contactLabel[rcd.contact_type];
        if (line) {
          const hsCd = document.createElement("div");
          hsCd.style.fontSize = "11px";
          hsCd.style.color = "#666";
          hsCd.style.marginBottom = "4px";
          hsCd.innerText = line;
          hsBlock.appendChild(hsCd);
        }
      }
      hsBlock.appendChild(hsStatus);
      hsBlock.appendChild(hsPrev);
      hsBlock.appendChild(btnRow);
      card.appendChild(hsBlock);
    }

    if (job.fit_score < 70) {
      const note = document.createElement("div");
      note.style.marginTop = "8px";
      note.style.fontSize = "13px";
      note.style.color = "#777";
      note.innerText = "No outreach suggested for this fit level.";
      card.appendChild(note);
    }

    if (outreach) {
      let currentRelFlag = "cold"; // tracks active relationship flag for re-fetch
      const strat = outreach.outreach_strategy;
      const outreachBlock = document.createElement("div");
      outreachBlock.style.marginTop = "10px";
      outreachBlock.style.paddingTop = "8px";
      outreachBlock.style.borderTop = "1px solid #ddd";

      // ── Relationship flag row ──────────────────────────────────────────────
      const relRow = document.createElement("div");
      relRow.style.display = "flex";
      relRow.style.alignItems = "center";
      relRow.style.gap = "6px";
      relRow.style.marginBottom = "10px";
      relRow.style.flexWrap = "wrap";

      const relLabel = document.createElement("span");
      relLabel.style.fontSize = "11px";
      relLabel.style.color = "#6b7280";
      relLabel.style.fontWeight = "600";
      relLabel.style.textTransform = "uppercase";
      relLabel.style.letterSpacing = "0.04em";
      relLabel.innerText = "Relationship:";
      relRow.appendChild(relLabel);

      const relOptions = [
        { flag: "cold",       label: "Cold" },
        { flag: "met_before", label: "Met before" },
        { flag: "in_contact", label: "Already in contact" },
      ];

      const stratBlocks = document.createElement("div");
      stratBlocks.id = "jc-strat-blocks";

      function renderStratBlocks(blocks) {
        stratBlocks.innerHTML = "";
        blocks.forEach((block) => {
          const sec = document.createElement("div");
          sec.style.marginBottom = "12px";
          sec.style.padding = "8px";
          sec.style.background = "#fff";
          sec.style.border = "1px solid #e5e7eb";
          sec.style.borderRadius = "6px";

          const title = document.createElement("div");
          title.style.fontSize = "13px";
          title.style.fontWeight = "600";
          title.style.marginBottom = "6px";
          title.style.color = "#111827";
          title.innerText = block.label
            ? `${block.badge} · ${block.label}`
            : block.badge;
          sec.appendChild(title);

          if (block.known_contact === false) {
            const empty = document.createElement("div");
            empty.style.fontSize = "12px";
            empty.style.color = "#6b7280";
            empty.style.lineHeight = "1.5";
            empty.style.padding = "6px 0";
            empty.innerText =
              `No contact found for ${job.company || "this company"}. ` +
              `Find a recruiter or hiring manager on LinkedIn, ` +
              `then come back — the draft is ready to personalize.`;

            const showDraftBtn = document.createElement("button");
            showDraftBtn.type = "button";
            showDraftBtn.style.fontSize = "11px";
            showDraftBtn.style.marginTop = "8px";
            showDraftBtn.style.padding = "3px 8px";
            showDraftBtn.style.color = "#6b7280";
            showDraftBtn.style.background = "transparent";
            showDraftBtn.style.border = "1px solid #d1d5db";
            showDraftBtn.style.borderRadius = "4px";
            showDraftBtn.style.cursor = "pointer";
            showDraftBtn.innerText = "Show draft anyway ▼";

            const draftWrap = document.createElement("div");
            draftWrap.style.display = "none";
            draftWrap.style.marginTop = "8px";

            const pre = document.createElement("div");
            pre.className = "outreach-container";
            pre.style.fontSize = "13px";
            pre.style.whiteSpace = "pre-wrap";
            pre.innerText = block.message_clean || block.message || "";

            const copyBtn = document.createElement("button");
            copyBtn.type = "button";
            copyBtn.style.fontSize = "12px";
            copyBtn.style.marginTop = "6px";
            copyBtn.innerText = "Copy draft";
            copyBtn.onclick = () => {
              navigator.clipboard.writeText(String(block.message || ""));
              copyBtn.innerText = "Copied ✓";
              setTimeout(() => { copyBtn.innerText = "Copy draft"; }, 1500);
            };
            draftWrap.appendChild(pre);
            draftWrap.appendChild(copyBtn);
            showDraftBtn.onclick = () => {
              const open = draftWrap.style.display === "none";
              draftWrap.style.display = open ? "block" : "none";
              showDraftBtn.innerText = open ? "Hide draft ▲" : "Show draft anyway ▼";
            };
            sec.appendChild(empty);
            sec.appendChild(showDraftBtn);
            sec.appendChild(draftWrap);
          } else {
            const pre = document.createElement("div");
            pre.className = "outreach-container";
            pre.style.fontSize = "13px";
            pre.style.whiteSpace = "pre-wrap";
            pre.innerText = block.message_clean || block.message || "";

            const copyBtn = document.createElement("button");
            copyBtn.type = "button";
            copyBtn.style.fontSize = "12px";
            copyBtn.style.marginTop = "6px";
            copyBtn.innerText = "Copy";
            copyBtn.onclick = () => {
              navigator.clipboard.writeText(String(block.message || ""));
              copyBtn.innerText = "Copied ✓";
              setTimeout(() => { copyBtn.innerText = "Copy"; }, 1500);
            };
            sec.appendChild(pre);
            sec.appendChild(copyBtn);
          }
          stratBlocks.appendChild(sec);
        });
      }

      // Build relationship flag buttons
      relOptions.forEach(({ flag, label }) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.flag = flag;
        btn.innerText = label;
        btn.style.fontSize = "11px";
        btn.style.padding = "3px 9px";
        btn.style.borderRadius = "4px";
        btn.style.cursor = "pointer";
        btn.style.border = "1px solid #d1d5db";
        btn.style.background = flag === "cold" ? "#1d4ed8" : "#f9fafb";
        btn.style.color = flag === "cold" ? "#fff" : "#374151";
        btn.style.fontWeight = flag === "cold" ? "600" : "400";

        btn.onclick = async () => {
          if (currentRelFlag === flag) return;
          currentRelFlag = flag;
          // Update button styles
          relRow.querySelectorAll("button[data-flag]").forEach((b) => {
            const active = b.dataset.flag === flag;
            b.style.background = active ? "#1d4ed8" : "#f9fafb";
            b.style.color = active ? "#fff" : "#374151";
            b.style.fontWeight = active ? "600" : "400";
          });
          stratBlocks.style.opacity = "0.5";
          try {
            const freshOutreach = await jcFetch(
              apiUrl(`/jobs/${job.id}/generate-outreach`),
              {
                method: "POST",
                body: {
                  relationship_context: jobData.relationship_context || null,
                  user_relationship_flag: flag,
                },
              }
            );
            const freshStrat = freshOutreach?.outreach_strategy;
            if (Array.isArray(freshStrat) && freshStrat.length > 0) {
              renderStratBlocks(freshStrat);
            }
          } catch (e) {
            jcDbgError("relationship flag re-fetch failed", e);
          } finally {
            stratBlocks.style.opacity = "1";
          }
        };
        relRow.appendChild(btn);
      });

      const outreachHeading = document.createElement("div");
      outreachHeading.style.fontWeight = "bold";
      outreachHeading.style.marginBottom = "8px";
      outreachHeading.innerText = "Outreach Strategy";

      outreachBlock.appendChild(outreachHeading);
      outreachBlock.appendChild(relRow);

      // Initial render using the already-fetched outreach response
      if (Array.isArray(strat) && strat.length > 0) {
        renderStratBlocks(strat);
        outreachBlock.appendChild(stratBlocks);
      } else {
        const rot = outreachRot;
        const drafts = outreach.drafts || {};
        const draftText =
          drafts[`${rot}_clean`] || drafts[rot] || "";
        const typeLine = document.createElement("div");
        typeLine.style.fontSize = "12px";
        typeLine.style.marginBottom = "4px";
        typeLine.innerHTML = `<b>Type:</b> ${rot || ""}`;
        const draftPreview = document.createElement("div");
        draftPreview.className = "outreach-container";
        draftPreview.innerText = draftText || "";
        const expandRow = document.createElement("div");
        expandRow.style.marginTop = "6px";
        const expandBtn = document.createElement("button");
        expandBtn.type = "button";
        expandBtn.style.fontSize = "12px";
        expandBtn.style.padding = "4px 8px";
        expandBtn.innerText = "Show More ▼";
        expandBtn.onclick = () => {
          const on = draftPreview.classList.toggle("expanded");
          expandBtn.innerText = on ? "Show Less ▲" : "Show More ▼";
        };
        expandRow.appendChild(expandBtn);
        outreachBlock.appendChild(typeLine);
        outreachBlock.appendChild(draftPreview);
        outreachBlock.appendChild(expandRow);
      }

      card.appendChild(outreachBlock);
    }

    resultDiv.appendChild(card);

    attachActionHandlers({
      job_id: job.id,
      outreach: outreachCopyText || "",
      active_status: extensionUiStatusFromJob(job.status),
    });

    if (runBtn) runBtn.style.display = "none";

    setTimeout(() => {
      loadJobStatus();
    }, 1000);
  } catch (e) {
    jcDbgError("runCopilot render failed", e);
    jcFatal(e);
  }
}

(function bootstrapPopup() {
  initJcDebugToggle();
  initSettingsTabs();
  loadProfileForm();
  initSaveSettings();
  initProfileReminder();
  void runCopilot().catch((err) => {
    jcDbgError("runCopilot failed", err);
    jcFatal(err);
  });
})();
