/**
 * Content script — detects job pages and shows a Simplify-style launcher.
 * Injected into all frames so iframe-hosted ATS postings are covered.
 */

import { extractJobData, isLikelyJobPage } from '../lib/job-extractor.js';

const LAUNCHER_ID = 'job-tracker-launcher';
let launcherVisible = false;
let sidePanelOpen = false;
let dismissed = false;
let lateScanTimer = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_PAGE_JOB_DATA') {
    sendResponse({
      success: true,
      data: extractJobData(document, window.location.href),
      isJobPage: isLikelyJobPage(window.location.href, document),
    });
  }
  if (message.type === 'SIDE_PANEL_STATE') {
    if (window === window.top) {
      sidePanelOpen = Boolean(message.open);
      syncLauncherVisibility();
    }
    sendResponse({ success: true });
  }
  if (message.type === 'TOGGLE_PANEL') {
    if (window === window.top) {
      if (launcherVisible) hideLauncher();
      else showLauncher();
      sendResponse({ success: true, visible: launcherVisible });
    } else {
      sendResponse({ success: true, visible: false, skipped: true });
    }
  }
  if (message.type === 'HIDE_PANEL') {
    if (window === window.top) {
      hideLauncher();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: true, skipped: true });
    }
  }
  return true;
});

function injectStyles() {
  if (document.getElementById('job-tracker-styles')) return;
  const link = document.createElement('link');
  link.id = 'job-tracker-styles';
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('content/floating-panel.css');
  document.head.appendChild(link);
}

function createLauncher() {
  if (window !== window.top) return;
  if (document.getElementById(LAUNCHER_ID)) return;

  injectStyles();

  const root = document.createElement('div');
  root.id = LAUNCHER_ID;
  root.className = 'jt-launcher jt-hidden';
  root.innerHTML = `
    <button type="button" class="jt-launcher-btn" title="Open Job Tracker" aria-label="Open Job Tracker">
      <span class="jt-launcher-logo" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M7 4h7l3 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#fff"/>
          <path d="M14 4v4h4" stroke="#bfdbfe" stroke-width="1.5"/>
        </svg>
      </span>
      <span class="jt-launcher-label">Job Tracker</span>
    </button>
    <button type="button" class="jt-launcher-dismiss" title="Hide" aria-label="Hide Job Tracker button">×</button>
  `;

  document.documentElement.appendChild(root);

  root.querySelector('.jt-launcher-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }).catch(() => {});
  });

  root.querySelector('.jt-launcher-dismiss').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismissed = true;
    hideLauncher();
  });
}

function syncLauncherVisibility() {
  const el = document.getElementById(LAUNCHER_ID);
  if (!el) return;
  const shouldShow =
    launcherVisible && !dismissed && !sidePanelOpen && isLikelyJobPage(location.href, document);
  el.classList.toggle('jt-hidden', !shouldShow);
  el.classList.toggle('jt-applied', el.dataset.applied === '1');
}

async function refreshLauncherState() {
  if (window !== window.top) return;
  createLauncher();
  const el = document.getElementById(LAUNCHER_ID);
  if (!el) return;

  const data = extractJobData(document, window.location.href);
  let applied = false;
  try {
    const found = await chrome.runtime.sendMessage({
      type: 'FIND_APPLICATION',
      extractedData: data,
    });
    applied = Boolean(found?.matched);
  } catch {
    /* no sheet connected yet */
  }

  el.dataset.applied = applied ? '1' : '0';
  const label = el.querySelector('.jt-launcher-label');
  if (label) {
    label.textContent = applied ? 'Already applied' : 'Job Tracker';
  }
  const btn = el.querySelector('.jt-launcher-btn');
  if (btn) {
    btn.title = applied ? 'Already saved — open Job Tracker' : 'Open Job Tracker';
  }
  syncLauncherVisibility();
}

function showLauncher() {
  if (window !== window.top || dismissed) return;
  createLauncher();
  launcherVisible = true;
  refreshLauncherState();
}

function hideLauncher() {
  launcherVisible = false;
  const el = document.getElementById(LAUNCHER_ID);
  if (el) el.classList.add('jt-hidden');
}

function pageLooksReady() {
  return Boolean(
    document.querySelector(
      'script[type="application/ld+json"], [itemtype*="JobPosting" i], main h1, h1, [class*="job" i], [data-automation-id]'
    ) || (document.body && (document.body.innerText || '').length > 200)
  );
}

function maybeShowLauncher(autoShow) {
  if (!autoShow || window !== window.top || dismissed) return;
  if (isLikelyJobPage(window.location.href, document)) {
    showLauncher();
  } else {
    hideLauncher();
  }
}

function watchForLateContent(autoShow) {
  if (!autoShow || window !== window.top) return;
  if (isLikelyJobPage(window.location.href, document)) return;

  const observer = new MutationObserver(() => {
    if (lateScanTimer) clearTimeout(lateScanTimer);
    lateScanTimer = setTimeout(() => {
      if (isLikelyJobPage(window.location.href, document)) {
        observer.disconnect();
        showLauncher();
      }
    }, 400);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  setTimeout(() => observer.disconnect(), 12000);
}

async function init() {
  const { settings } = await chrome.storage.local.get('settings');
  const autoShow = settings?.autoShowPopup !== false;

  const start = () => {
    maybeShowLauncher(autoShow);
    if (!pageLooksReady()) {
      setTimeout(() => maybeShowLauncher(autoShow), 1200);
    }
    watchForLateContent(autoShow);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}

init();
