/**
 * Collect job extraction results for a browser tab (all frames).
 * Owns scripting / content messaging for page data — not UI, not Sheets.
 */

import { pickBestExtraction } from '../lib/job-extractor.js';

export async function getTabJobData(tabId, fallbackUrl = '') {
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
