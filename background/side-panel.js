/**
 * Tab-scoped Chrome side panel controller.
 *
 * Owns open/close/enable behavior and SIDE_PANEL_STATE page notifications.
 * Does not touch Google auth or Sheets.
 */

const SIDE_PANEL_PATH = 'sidepanel/sidepanel.html';

/** Tabs where the user explicitly opened the sidebar. */
const sidePanelEnabledTabs = new Set();

function isSidePanelableUrl(url) {
  if (!url) return true;
  return /^https?:/i.test(url) || url.startsWith('file:');
}

function disableGlobalSidePanel() {
  if (!chrome.sidePanel?.setOptions) return Promise.resolve();
  return chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
}

function enableSidePanelForTab(tabId) {
  if (!tabId || !chrome.sidePanel?.setOptions) return Promise.resolve();
  sidePanelEnabledTabs.add(tabId);
  return chrome.sidePanel.setOptions({
    tabId,
    path: SIDE_PANEL_PATH,
    enabled: true,
  });
}

function disableSidePanelForTab(tabId) {
  if (!tabId || !chrome.sidePanel?.setOptions) return Promise.resolve();
  sidePanelEnabledTabs.delete(tabId);
  return chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
}

function configureSidePanelBehavior() {
  disableGlobalSidePanel();
  if (!chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((err) => console.warn('sidePanel.setPanelBehavior failed:', err));
}

function notifyTabSidePanelState(tabId, open) {
  if (tabId == null) return;
  chrome.tabs
    .sendMessage(tabId, { type: 'SIDE_PANEL_STATE', open: Boolean(open) })
    .catch(() => {});
}

function openPanelOnTab(tabId, tabUrl) {
  if (tabId == null || !chrome.sidePanel?.open) return;
  if (!isSidePanelableUrl(tabUrl)) return;
  enableSidePanelForTab(tabId).catch(() => {});
  notifyTabSidePanelState(tabId, true);
  chrome.sidePanel.open({ tabId }).catch((err) => {
    console.warn('Could not open side panel:', err);
  });
}

/** Open the side panel for one tab only (sync gesture-safe). */
export function openSidePanelForTab(tab) {
  if (!tab?.id) return;
  openPanelOnTab(tab.id, tab.url);
}

export async function closeSidePanelForTab(tabId) {
  if (tabId == null) return;
  if (typeof chrome.sidePanel?.close === 'function') {
    try {
      await chrome.sidePanel.close({ tabId });
      notifyTabSidePanelState(tabId, false);
      return;
    } catch {
      /* fall through */
    }
  }
  sidePanelEnabledTabs.delete(tabId);
  await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
  notifyTabSidePanelState(tabId, false);
}

/**
 * Handle OPEN_SIDE_PANEL / CLOSE_SIDE_PANEL.
 * @returns {boolean|null} true = async channel, false = handled sync, null = not ours
 */
export function handleSidePanelMessage(message, sender, sendResponse) {
  if (message?.type === 'OPEN_SIDE_PANEL') {
    const tabId = message.tabId || sender.tab?.id;
    openPanelOnTab(tabId, sender.tab?.url);
    sendResponse({ success: true });
    return false;
  }

  if (message?.type === 'CLOSE_SIDE_PANEL') {
    const tabId = message.tabId || sender.tab?.id;
    closeSidePanelForTab(tabId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err?.message }));
    return true;
  }

  if (message?.type === 'SIDE_PANEL_UNLOADED') {
    const tabId = message.tabId || sender.tab?.id;
    notifyTabSidePanelState(tabId, false);
    sendResponse({ success: true });
    return false;
  }

  return null;
}

/** Wire Chrome events for the side panel. Call once from the service worker entry. */
export function registerSidePanel() {
  configureSidePanelBehavior();
  chrome.runtime.onInstalled.addListener(configureSidePanelBehavior);
  chrome.runtime.onStartup.addListener(configureSidePanelBehavior);

  chrome.tabs.onRemoved.addListener((tabId) => {
    sidePanelEnabledTabs.delete(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!sidePanelEnabledTabs.has(tabId)) return;
    if (!(changeInfo.status === 'complete' || changeInfo.url)) return;
    const url = tab?.url || changeInfo.url;
    if (!isSidePanelableUrl(url)) {
      disableSidePanelForTab(tabId);
      return;
    }
    enableSidePanelForTab(tabId).catch(() => {});
  });

  chrome.action.onClicked.addListener((tab) => {
    openSidePanelForTab(tab);
  });
}
