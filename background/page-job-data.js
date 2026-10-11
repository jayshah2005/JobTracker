/**
 * Collect job extraction results for a browser tab (all frames).
 * Owns scripting / content messaging for page data — not UI, not Sheets.
 * Preloads likely job pages into chrome.storage.session for fast side-panel open.
 */

import { pickBestExtraction } from '../lib/job-extractor.js';
import { normalizeJobUrl, urlsMatch } from '../lib/job-url.js';

const PRELOAD_TTL_MS = 5 * 60 * 1000;
const PRELOAD_PREFIX = 'jobPreload:';

/** In-flight live extracts keyed by tabId + normalized URL (dedupe preload + panel). */
const inflightExtracts = new Map();

export function preloadStorageKey(tabId) {
  return `${PRELOAD_PREFIX}${tabId}`;
}

/**
 * Whether a session preload entry can be served for this tab URL.
 */
export function isPreloadFresh(entry, url, now = Date.now()) {
  if (!entry?.data || entry.url == null || entry.url === '') return false;
  if (now - Number(entry.cachedAt || 0) > PRELOAD_TTL_MS) return false;
  const cachedUrl = String(entry.url);
  const want = String(url || '');
  if (!want) return false;
  return (
    urlsMatch(cachedUrl, want) ||
    normalizeJobUrl(cachedUrl) === normalizeJobUrl(want)
  );
}

async function readPreload(tabId) {
  if (tabId == null || !chrome.storage?.session) return null;
  const key = preloadStorageKey(tabId);
  const bag = await chrome.storage.session.get(key);
  return bag[key] || null;
}

async function writePreload(tabId, url, data) {
  if (tabId == null || !chrome.storage?.session || !data) return;
  await chrome.storage.session.set({
    [preloadStorageKey(tabId)]: {
      url: url || data.url || '',
      data,
      cachedAt: Date.now(),
    },
  });
}

export async function clearTabJobPreload(tabId) {
  if (tabId == null || !chrome.storage?.session) return;
  await chrome.storage.session.remove(preloadStorageKey(tabId));
}

function inflightKey(tabId, tabUrl) {
  return `${tabId}:${normalizeJobUrl(tabUrl) || tabUrl || ''}`;
}

async function extractTabJobDataLive(tabId, tabUrl) {
  const results = [];

  try {
    const res = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_PAGE_JOB_DATA',
    });
    if (res?.data) results.push(res);
  } catch {
    /* content script may not be loaded yet */
  }

  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: async () => {
        try {
          const mod = await import(chrome.runtime.getURL('lib/job-extractor.js'));
          return {
            success: true,
            data: mod.extractJobData(document, location.href),
            isJobPage: mod.isLikelyJobPage(location.href, document),
          };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    });
    for (const frame of injected || []) {
      if (frame?.result?.success && frame.result.data) {
        results.push(frame.result);
      }
    }
  } catch {
    /* restricted pages or missing permission */
  }

  return pickBestExtraction(results, tabUrl || '');
}

function extractDeduped(tabId, tabUrl) {
  const key = inflightKey(tabId, tabUrl);
  const existing = inflightExtracts.get(key);
  if (existing) return existing;

  const pending = extractTabJobDataLive(tabId, tabUrl).finally(() => {
    inflightExtracts.delete(key);
  });
  inflightExtracts.set(key, pending);
  return pending;
}

function refreshPreloadInBackground(tabId, tabUrl) {
  extractDeduped(tabId, tabUrl)
    .then((data) => writePreload(tabId, data.url || tabUrl, data))
    .catch(() => {});
}

/**
 * Extract job fields for a tab. Serves a fresh session preload when the URL matches.
 */
export async function getTabJobData(
  tabId,
  fallbackUrl = '',
  { bypassCache = false } = {}
) {
  if (tabId == null) {
    return { url: fallbackUrl || '', confidence: {}, sources: {} };
  }

  let tabUrl = fallbackUrl;
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab?.url || fallbackUrl;
  } catch {
    /* tab may be gone */
  }

  if (!bypassCache) {
    try {
      const cached = await readPreload(tabId);
      if (isPreloadFresh(cached, tabUrl)) {
        refreshPreloadInBackground(tabId, tabUrl);
        return cached.data;
      }
    } catch {
      /* session storage unavailable — fall through */
    }
  }

  const data = await extractDeduped(tabId, tabUrl);
  try {
    await writePreload(tabId, data.url || tabUrl, data);
  } catch {
    /* ignore cache write failures */
  }
  return data;
}

/**
 * Warm the session cache for a tab (content script trigger on likely job pages).
 */
export async function preloadTabJobData(tabId, url = '') {
  if (tabId == null) {
    return { success: false, error: 'Missing tab id.' };
  }

  try {
    const data = await getTabJobData(tabId, url, { bypassCache: true });
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Clear preload when tabs navigate or close.
 */
export function registerJobPreloadLifecycle() {
  if (!chrome.tabs?.onRemoved || !chrome.tabs?.onUpdated) return;

  chrome.tabs.onRemoved.addListener((tabId) => {
    clearTabJobPreload(tabId).catch(() => {});
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return;
    clearTabJobPreload(tabId).catch(() => {});
  });
}
