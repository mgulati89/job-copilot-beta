/**
 * Backend origin for the local FastAPI server. Used when no override is set.
 */
const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8000";

/**
 * Optional override (e.g. from chrome.storage.local). Null/empty → use default.
 * @type {string | null}
 */
let configuredBaseUrl = null;

const JC_ERR_INVALID_BACKEND_URL = "JC_INVALID_BACKEND_URL";

function getResolvedBackendBaseUrl() {
  const raw = configuredBaseUrl || DEFAULT_BACKEND_BASE_URL;
  const s = String(raw != null ? raw : "").trim();
  const normalized = (s !== "" ? s : DEFAULT_BACKEND_BASE_URL).replace(
    /\/+$/,
    ""
  );
  return normalized;
}

function apiUrl(path) {
  const baseUrl = getResolvedBackendBaseUrl();
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    throw new Error(`Invalid backend base URL: ${baseUrl}`);
  }
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${p}`;
}

function assertValidHttpUrl(url, baseUrlForLog) {
  if (
    typeof url !== "string" ||
    (!url.startsWith("http://") && !url.startsWith("https://"))
  ) {
    console.error("[JC FETCH] invalid backend url", {
      url,
      baseUrl: baseUrlForLog,
    });
    throw new Error(JC_ERR_INVALID_BACKEND_URL);
  }
  try {
    new URL(url);
  } catch {
    console.error("[JC FETCH] invalid backend url", {
      url,
      baseUrl: baseUrlForLog,
    });
    throw new Error(JC_ERR_INVALID_BACKEND_URL);
  }
}

/**
 * Validates full request URL, logs url + resolved base, then fetch().
 * @param {string} url
 * @param {RequestInit} [init]
 */
function jcFetch(url, init) {
  console.log("[JC STEP] inside API call function");
  const baseUrl = getResolvedBackendBaseUrl();
  assertValidHttpUrl(url, baseUrl);
  console.log("[JC FETCH] url:", url);
  console.log("[JC FETCH] baseUrl:", baseUrl);
  return fetch(url, init);
}

(function initBackendBaseFromStorage() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  chrome.storage.local.get({ jc_backend_base_url: null }, (r) => {
    const v = r.jc_backend_base_url;
    if (v != null && String(v).trim() !== "") {
      configuredBaseUrl = String(v).trim();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.jc_backend_base_url) return;
    const nv = changes.jc_backend_base_url.newValue;
    configuredBaseUrl =
      nv != null && String(nv).trim() !== "" ? String(nv).trim() : null;
  });
})();
