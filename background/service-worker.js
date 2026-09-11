/**
 * Background service worker entry — message router only.
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
  findApplication,
  saveJob,
} from './sheets-orchestrator.js';
import { getConfiguredSheets, getSettings, saveSettings, getUndoStack } from '../lib/storage.js';
import {
  registerSidePanel,
  handleSidePanelMessage,
} from './side-panel.js';
import { getTabJobData } from './page-job-data.js';

registerSidePanel();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const sidePanelResult = handleSidePanelMessage(message, sender, sendResponse);
  if (sidePanelResult !== null) return sidePanelResult;

  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ success: false, error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
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
    case 'REFRESH_SHEETS':
      return refreshAllSheets();
    case 'GET_SHEETS':
      return { success: true, sheets: await getConfiguredSheets() };
    case 'SAVE_JOB':
      return saveJob(message);
    case 'FIND_APPLICATION':
      return findApplication(message.extractedData);
    case 'GET_TAB_JOB_DATA': {
      const tabId = message.tabId ?? sender.tab?.id;
      const data = await getTabJobData(tabId, message.url || sender.tab?.url || '');
      return { success: true, data };
    }
    case 'APPLY_SCHEMA_CHANGE':
      return applySchemaChangeMessage(message);
    case 'SYNC_TAB_COLUMN_UNIQUES':
      return syncTabColumnUniques(message);
    case 'UNDO_SCHEMA_CHANGE':
      return undoSchemaChange(message.entryId);
    case 'GET_UNDO_STACK':
      return { success: true, stack: await getUndoStack() };
    default:
      return { success: false, error: 'Unknown message type' };
  }
}
