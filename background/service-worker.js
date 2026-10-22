/**
 * Background service worker entry — message router only.
 * UI pages and content scripts call chrome.runtime.sendMessage({ type, ... });
 * each handler resolves to `{ success, ... }` and failures become
 * `{ success: false, error }` so the UI never sees an unhandled rejection.
 * Auth → ./google-session.js · Sheets → ./sheets-orchestrator.js ·
 * Side panel → ./side-panel.js · Page extract → ./page-job-data.js
 */

import {
  getAuthStatus,
  saveOauthClient,
  signIn,
  signOut,
} from './google-session.js';
import {
  addSheet,
  removeSheet,
  refreshAllSheets,
  applySchemaChangeMessage,
  syncTabColumnUniques,
  undoSchemaChange,
  redoSchemaChange,
  findApplication,
  saveJob,
  deleteJob,
  renameTab,
} from './sheets-orchestrator.js';
import {
  getConfiguredSheets,
  getSettings,
  saveSettings,
  getUndoStack,
  getRedoStack,
} from '../lib/storage.js';
import {
  registerSidePanel,
  handleSidePanelMessage,
} from './side-panel.js';
import {
  getTabJobData,
  preloadTabJobData,
  clearTabJobPreload,
  registerJobPreloadLifecycle,
} from './page-job-data.js';

registerSidePanel();
registerJobPreloadLifecycle();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const sidePanelResult = handleSidePanelMessage(message, sender, sendResponse);
  if (sidePanelResult !== null) return sidePanelResult;

  handleMessage(message, sender).then(sendResponse).catch((err) => {
    console.error('Message failed:', message?.type, err);
    sendResponse({
      success: false,
      error: err?.message || 'Something went wrong. Please try again.',
    });
  });
  // Keep the message channel open for the async response.
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'GET_AUTH_STATUS':
      return getAuthStatus();
    case 'SAVE_OAUTH_CLIENT':
      return saveOauthClient(message.clientId, message.clientSecret);
    case 'SIGN_IN':
      return signIn();
    case 'SIGN_OUT':
      return signOut();
    case 'GET_SETTINGS':
      return { success: true, settings: await getSettings() };
    case 'SAVE_SETTINGS':
      await saveSettings(message.settings || {});
      return { success: true, settings: await getSettings() };
    case 'ADD_SHEET':
      return addSheet(message.url);
    case 'REMOVE_SHEET':
      return removeSheet(message.spreadsheetId);
    case 'RENAME_SHEET_TAB':
      return renameTab(message);
    case 'REFRESH_SHEETS':
      return refreshAllSheets();
    case 'GET_SHEETS':
      return { success: true, sheets: await getConfiguredSheets() };
    case 'SAVE_JOB':
      return saveJob(message);
    case 'DELETE_JOB':
      return deleteJob(message);
    case 'FIND_APPLICATION':
      return findApplication(message.extractedData);
    case 'GET_TAB_JOB_DATA': {
      const tabId = message.tabId ?? sender.tab?.id;
      const data = await getTabJobData(tabId, message.url || sender.tab?.url || '');
      return { success: true, data };
    }
    case 'PRELOAD_TAB_JOB_DATA': {
      const tabId = message.tabId ?? sender.tab?.id;
      return preloadTabJobData(tabId, message.url || sender.tab?.url || '');
    }
    case 'CLEAR_TAB_JOB_PRELOAD': {
      const tabId = message.tabId ?? sender.tab?.id;
      await clearTabJobPreload(tabId);
      return { success: true };
    }
    case 'APPLY_SCHEMA_CHANGE':
      return applySchemaChangeMessage(message);
    case 'SYNC_TAB_COLUMN_UNIQUES':
      return syncTabColumnUniques(message);
    case 'UNDO_SCHEMA_CHANGE':
      return undoSchemaChange(message.entryId);
    case 'REDO_SCHEMA_CHANGE':
      return redoSchemaChange(message.entryId);
    case 'GET_UNDO_STACK':
      return {
        success: true,
        stack: await getUndoStack(),
        redoStack: await getRedoStack(),
      };
    default:
      return { success: false, error: 'Unknown request. Reload the extension and try again.' };
  }
}
