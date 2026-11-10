/**
 * Content script — job-page detection + floating launcher only.
 * Classic (non-module) entry so a failed static import cannot kill the whole
 * script. Heavy libs load via dynamic import(chrome.runtime.getURL(...)).
 *
 * Role in the extension:
 *  - Top frame: decides whether the page is a job posting (URL rules first,
 *    then the DOM extractor), shows/hides the floating launcher, re-checks on
 *    late-rendered content and SPA navigation, and asks the background worker
 *    to pre-extract job data for the tab.
 *  - Every frame: answers GET_PAGE_JOB_DATA from the sidepanel/background with
 *    extractJobData() (the best frame result is picked by pickBestExtraction).
 *  - Listens for SIDE_PANEL_STATE to hide the launcher while the panel is open.
 *
 * Launcher CSS is declared in manifest content_scripts.css (CSP-safe).
 */

const LAUNCHER_ID = 'job-tracker-launcher';
/** Distinguishes this script's launcher from one left by an orphaned older copy. */
const INSTANCE_ID = Math.random().toString(36).slice(2);
let orphaned = false;
let launcherVisible = false;
let sidePanelOpen = false;
let dismissed = false;
let lateScanTimer = null;
let lateContentObserver = null;
let lateContentStopTimer = null;
let preloadTimer = null;
let lastSeenUrl = '';
let urlWatchTimer = null;
/** Mirrors Settings → “Show Job Tracker button on job pages”. Default on. */
let autoShowEnabled = true;

/** Lazily loaded extractor / storage / URL-heuristic modules. */
let extractorMod = null;
let storageMod = null;
let jobPageUrlMod = null;
let urlHelperPromise = null;
let libsPromise = null;

/** Absolute chrome-extension:// URL of a packaged file (needed for dynamic import). */
function extUrl(path) {
  return chrome.runtime.getURL(path);
}

/** Tiny helper only — load first so the launcher can appear quickly. */
function loadUrlHelper() {
  if (!urlHelperPromise) {
    urlHelperPromise = import(extUrl('lib/job-page-url.js'))
      .then((mod) => {
        jobPageUrlMod = mod;
        return mod;
      })
      .catch((err) => {
        console.warn('[Job Tracker] Failed to load job-page-url:', err);
        urlHelperPromise = null;
        throw err;
      });
  }
  return urlHelperPromise;
}

/** Load the extractor + storage modules once (shared promise; retried after failure). */
function loadLibs() {
  if (!libsPromise) {
    libsPromise = Promise.all([
      loadUrlHelper(),
      import(extUrl('lib/job-extractor.js')),
      import(extUrl('lib/storage.js')),
    ])
      .then(([jobPageUrl, extractor, storage]) => {
        jobPageUrlMod = jobPageUrl;
        extractorMod = extractor;
        storageMod = storage;
        return { extractor, storage, jobPageUrl };
      })
      .catch((err) => {
        console.warn('[Job Tracker] Failed to load libs:', err);
        libsPromise = null;
        throw err;
      });
  }
  return libsPromise;
}

/** Cheap URL rules first (work before libs load), then the full DOM heuristic. */
function pageLooksLikeJob() {
  if (jobPageUrlMod?.urlLooksLikeJobPosting?.(location.href)) return true;
  if (extractorMod?.isLikelyJobPage) {
    try {
      return extractorMod.isLikelyJobPage(location.href, document);
    } catch (err) {
      console.warn('[Job Tracker] isLikelyJobPage failed:', err);
    }
  }
  return false;
}

/**
 * Fire-and-forget message to the service worker. After the extension is
 * reloaded/updated this orphaned script's chrome.runtime.sendMessage throws
 * synchronously ("Extension context invalidated"), so a bare .catch() is not
 * enough: the throw would surface from timers and click handlers.
 */
function sendToBackground(message) {
  try {
    const p = chrome.runtime.sendMessage(message);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // Extension context invalidated: this script is orphaned. Stop polling and
    // remove the launcher, which can no longer do anything. Any other throw
    // leaves a live script alone.
    if (!extensionAlive()) teardownOrphan();
  }
}

/** Remove everything an orphaned (post-reload) content script left on the page. */
function teardownOrphan() {
  orphaned = true;
  if (urlWatchTimer) clearInterval(urlWatchTimer);
  urlWatchTimer = null;
  lateContentObserver?.disconnect();
  lateContentObserver = null;
  for (const t of [lateScanTimer, lateContentStopTimer, preloadTimer]) if (t) clearTimeout(t);
  lateScanTimer = lateContentStopTimer = preloadTimer = null;
  // A live newer script may own the launcher now; only remove our own.
  const el = document.getElementById(LAUNCHER_ID);
  if (!el || el.dataset.jtInstance === INSTANCE_ID) {
    el?.remove();
    document.getElementById('job-tracker-styles')?.remove();
  }
}

/** False once the extension was reloaded/updated under this script. */
function extensionAlive() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_PAGE_JOB_DATA') {
    loadLibs()
      .then(({ extractor }) => {
        sendResponse({
          success: true,
          data: extractor.extractJobData(document, window.location.href),
          isJobPage: extractor.isLikelyJobPage(window.location.href, document),
        });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: String(err),
          data: { url: window.location.href, confidence: {}, sources: {} },
          isJobPage: Boolean(jobPageUrlMod?.urlLooksLikeJobPosting?.(window.location.href)),
        });
      });
    return true; // async sendResponse
  }
  if (message.type === 'SIDE_PANEL_STATE') {
    if (window === window.top) {
      sidePanelOpen = Boolean(message.open);
      syncLauncherVisibility();
    }
    sendResponse({ success: true });
  }
  // Synchronous / unknown messages: don't keep the channel open (returning
  // true without ever responding leaves other listeners' senders hanging).
  return false;
});

/** Minimal inline styles so the launcher still renders if the CSS file is blocked. */
function injectFallbackStyles() {
  if (document.getElementById('job-tracker-styles')) return;
  const style = document.createElement('style');
  style.id = 'job-tracker-styles';
  style.textContent = `
    #${LAUNCHER_ID} {
      position: fixed !important;
      right: 20px !important;
      bottom: 24px !important;
      z-index: 2147483646 !important;
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
    }
    #${LAUNCHER_ID}.jt-hidden {
      display: none !important;
    }
    #${LAUNCHER_ID} .jt-launcher-btn {
      display: inline-flex !important;
      align-items: center !important;
      gap: 8px !important;
      padding: 10px 14px 10px 10px !important;
      border: 1px solid #c7d2fe !important;
      border-radius: 999px !important;
      background: #ffffff !important;
      color: #1f2433 !important;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16) !important;
      cursor: pointer !important;
      font-size: 13px !important;
      font-weight: 650 !important;
    }
    #${LAUNCHER_ID} .jt-launcher-dismiss {
      width: 28px !important;
      height: 28px !important;
      border: 1px solid #dfe2ec !important;
      border-radius: 999px !important;
      background: #fff !important;
      color: #5b6475 !important;
      cursor: pointer !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

/** Build the launcher DOM once (top frame only); starts hidden until syncLauncherVisibility. */
function createLauncher() {
  if (window !== window.top || orphaned) return;
  const existing = document.getElementById(LAUNCHER_ID);
  if (existing) {
    if (existing.dataset.jtInstance === INSTANCE_ID) return;
    existing.remove(); // left by an orphaned copy: its click handler is dead
  }

  injectFallbackStyles();

  const root = document.createElement('div');
  root.id = LAUNCHER_ID;
  root.className = 'jt-launcher jt-hidden';
  root.setAttribute('data-job-tracker-launcher', '1');
  root.dataset.jtInstance = INSTANCE_ID;
  root.innerHTML = `
    <button type="button" class="jt-launcher-btn" title="Open Job Tracker" aria-label="Open Job Tracker">
      <img
        class="jt-launcher-logo"
        src="${extUrl('icons/logo.png')}"
        width="28"
        height="28"
        alt=""
      />
      <span class="jt-launcher-label">Job Tracker</span>
    </button>
    <button type="button" class="jt-launcher-dismiss" title="Hide" aria-label="Hide Job Tracker button">×</button>
  `;

  (document.body || document.documentElement).appendChild(root);

  root.querySelector('.jt-launcher-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sendToBackground({ type: 'OPEN_SIDE_PANEL' });
  });

  root.querySelector('.jt-launcher-dismiss').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismissed = true;
    hideLauncher();
  });
}

/** Apply all visibility conditions to the launcher element. */
function syncLauncherVisibility() {
  const el = document.getElementById(LAUNCHER_ID);
  if (!el) return;
  const shouldShow =
    autoShowEnabled &&
    launcherVisible &&
    !dismissed &&
    !sidePanelOpen &&
    pageLooksLikeJob();
  el.classList.toggle('jt-hidden', !shouldShow);
}

function showLauncher() {
  if (window !== window.top || dismissed || !autoShowEnabled) return;
  createLauncher();
  launcherVisible = true;
  syncLauncherVisibility();
}

function hideLauncher() {
  launcherVisible = false;
  const el = document.getElementById(LAUNCHER_ID);
  if (el) el.classList.add('jt-hidden');
}

/** Has the page rendered enough content that an early job-page check is meaningful? */
function pageLooksReady() {
  return Boolean(
    document.querySelector(
      'script[type="application/ld+json"], [itemtype*="JobPosting" i], main h1, h1, [class*="job" i], [data-automation-id]'
    ) || (document.body && (document.body.innerText || '').length > 200)
  );
}

/** Show the launcher on job pages, hide it otherwise (and when the setting is off). */
function maybeShowLauncher() {
  if (window !== window.top || orphaned) return;
  if (!autoShowEnabled) {
    // The setting loads asynchronously: the launcher may already be visible.
    hideLauncher();
    return;
  }
  if (dismissed) return;
  if (pageLooksLikeJob()) {
    showLauncher();
  } else {
    hideLauncher();
  }
}

/** Debounced: tell the background worker to pre-extract this tab's job data (or clear it). */
function requestPreloadJobData() {
  if (window !== window.top) return;
  if (preloadTimer) clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    preloadTimer = null;
    if (!pageLooksLikeJob()) {
      sendToBackground({ type: 'CLEAR_TAB_JOB_PRELOAD' });
      return;
    }
    sendToBackground({
      type: 'PRELOAD_TAB_JOB_DATA',
      url: window.location.href,
    });
  }, 400);
}

/**
 * SPA/late-render support: if the page is not yet a job page, watch DOM
 * mutations (debounced, for at most 12s) and re-check until it becomes one.
 */
function watchForLateContent() {
  if (window !== window.top) return;

  if (lateContentObserver) {
    lateContentObserver.disconnect();
    lateContentObserver = null;
  }
  if (lateContentStopTimer) {
    clearTimeout(lateContentStopTimer);
    lateContentStopTimer = null;
  }
  if (lateScanTimer) {
    clearTimeout(lateScanTimer);
    lateScanTimer = null;
  }

  if (pageLooksLikeJob()) {
    maybeShowLauncher();
    requestPreloadJobData();
    return;
  }

  const scan = () => {
    lateScanTimer = null;
    if (!pageLooksLikeJob()) return false;
    lateContentObserver?.disconnect();
    lateContentObserver = null;
    maybeShowLauncher();
    requestPreloadJobData();
    return true;
  };
  // Throttle, not debounce: on a page that mutates constantly (feeds, ads,
  // animations) a debounce never fires and the launcher would never appear.
  lateContentObserver = new MutationObserver(() => {
    if (lateScanTimer) return;
    lateScanTimer = setTimeout(scan, 500);
  });

  lateContentObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  lateContentStopTimer = setTimeout(() => {
    lateContentStopTimer = null;
    if (!lateContentObserver) return;
    // Last look before giving up, so content that settled late is not missed.
    if (lateScanTimer) clearTimeout(lateScanTimer);
    if (!scan()) {
      lateContentObserver?.disconnect();
      lateContentObserver = null;
    }
  }, 12000);
}

/** Detect client-side navigation (history API gives no event) by polling location.href. */
function watchForSpaUrlChanges() {
  if (window !== window.top) return;
  lastSeenUrl = window.location.href;

  const onPossibleUrlChange = () => {
    if (!extensionAlive()) {
      teardownOrphan();
      return;
    }
    if (window.location.href === lastSeenUrl) return;
    lastSeenUrl = window.location.href;
    dismissed = false;
    sidePanelOpen = false;
    maybeShowLauncher();
    requestPreloadJobData();
    watchForLateContent();
  };

  window.addEventListener('popstate', onPossibleUrlChange);
  window.addEventListener('hashchange', onPossibleUrlChange);
  if (urlWatchTimer) clearInterval(urlWatchTimer);
  urlWatchTimer = setInterval(onPossibleUrlChange, 1000);
}

/** Top-frame startup: URL-rule check, load libs + settings, re-check, start watchers. */
async function initTopFrame() {
  if (window !== window.top) return;

  // URL helper first (general path/ATS-host rules), then heavy extractor.
  try {
    await loadUrlHelper();
  } catch {
    /* pageLooksLikeJob can still use DOM extractor once libs load */
  }

  maybeShowLauncher();
  requestPreloadJobData();

  try {
    await loadLibs();
    if (storageMod?.getSettings) {
      const settings = await storageMod.getSettings();
      autoShowEnabled = settings.autoShowPopup !== false;
    }
  } catch (err) {
    console.warn('[Job Tracker] Libs/settings unavailable; using URL heuristics.', err);
  }

  maybeShowLauncher();
  requestPreloadJobData();
  if (!pageLooksReady()) {
    setTimeout(() => {
      maybeShowLauncher();
      requestPreloadJobData();
    }, 1200);
  }
  watchForLateContent();
  watchForSpaUrlChanges();
  watchSettingsChanges();
}

/** Apply the Settings "show button" toggle to already-open tabs without a reload. */
function watchSettingsChanges() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const next = changes.settings.newValue?.autoShowPopup !== false;
      if (next === autoShowEnabled) return;
      autoShowEnabled = next;
      maybeShowLauncher();
    });
  } catch {
    /* storage unavailable: the setting applies on the next page load */
  }
}

if (window === window.top) {
  const start = () => {
    initTopFrame().catch((err) => {
      console.warn('[Job Tracker] Launcher init failed:', err);
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
// Iframes load the libs lazily on GET_PAGE_JOB_DATA: eagerly importing the
// extractor into every ad/embed frame of every page costs more than it saves.
