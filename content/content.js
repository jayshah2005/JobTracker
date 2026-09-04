/**
 * Content script — detects job pages and shows the floating tracker panel.
 * Injected into all frames so iframe-hosted ATS postings are covered.
 */

import { extractJobData, isLikelyJobPage } from '../lib/job-extractor.js';

const PANEL_ID = 'job-tracker-panel';
let panelVisible = false;
let lateScanTimer = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_PAGE_JOB_DATA') {
    sendResponse({
      success: true,
      data: extractJobData(document, window.location.href),
      isJobPage: isLikelyJobPage(window.location.href, document),
    });
  }
  if (message.type === 'TOGGLE_PANEL') {
    // Only toggle in the top frame to avoid duplicate panels
    if (window === window.top) {
      togglePanel();
      sendResponse({ success: true, visible: panelVisible });
    } else {
      sendResponse({ success: true, visible: false, skipped: true });
    }
  }
  if (message.type === 'HIDE_PANEL') {
    if (window === window.top) {
      hidePanel();
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

function createPanel() {
  if (window !== window.top) return;
  if (document.getElementById(PANEL_ID)) return;

  injectStyles();

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'jt-panel jt-hidden';
  panel.innerHTML = `
    <div class="jt-panel-header">
      <span class="jt-panel-title">Job Tracker</span>
      <button class="jt-btn-icon jt-close" title="Close">×</button>
    </div>
    <div class="jt-panel-body">
      <p class="jt-hint"></p>
    </div>
  `;

  document.body.appendChild(panel);
  panel.querySelector('.jt-close').addEventListener('click', hidePanel);
}

async function refreshPanelCopy() {
  if (window !== window.top) return;
  createPanel();
  const hint = document.querySelector(`#${PANEL_ID} .jt-hint`);
  const panel = document.getElementById(PANEL_ID);
  if (!hint || !panel) return;

  const data = extractJobData(document, window.location.href);
  try {
    const found = await chrome.runtime.sendMessage({
      type: 'FIND_APPLICATION',
      extractedData: data,
    });
    if (found?.matched) {
      panel.classList.add('jt-applied');
      const when = found.dateApplied ? ` on ${found.dateApplied}` : '';
      const status = found.status ? ` (${found.status})` : '';
      hint.innerHTML = `<span class="jt-applied-badge">Already applied</span><br>This job is in your tracker${when}${status}. It will not be saved again.`;
      return;
    }
  } catch {
    /* no sheet connected yet */
  }

  panel.classList.remove('jt-applied');
  hint.textContent = 'Click the Job Tracker icon in the toolbar to save this job.';
}

function showPanel() {
  if (window !== window.top) return;
  createPanel();
  refreshPanelCopy();
  const panel = document.getElementById(PANEL_ID);
  if (panel) {
    panel.classList.remove('jt-hidden');
    panelVisible = true;
  }
}

function hidePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) {
    panel.classList.add('jt-hidden');
    panelVisible = false;
  }
}

function togglePanel() {
  if (panelVisible) hidePanel();
  else showPanel();
}

function pageLooksReady() {
  return Boolean(
    document.querySelector(
      'script[type="application/ld+json"], [itemtype*="JobPosting" i], main h1, h1, [class*="job" i], [data-automation-id]'
    ) || (document.body && (document.body.innerText || '').length > 200)
  );
}

function maybeShowPanel(autoShow) {
  if (!autoShow || window !== window.top) return;
  if (isLikelyJobPage(window.location.href, document)) {
    showPanel();
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
        showPanel();
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
    maybeShowPanel(autoShow);
    // SPA / delayed ATS renders
    if (!pageLooksReady()) {
      setTimeout(() => maybeShowPanel(autoShow), 1200);
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
