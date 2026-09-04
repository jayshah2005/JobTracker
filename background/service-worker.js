/**
 * Background service worker — uses the user's Google account to edit sheets they paste.
 */

import {
  loadSpreadsheetTabs,
  loadTabRows,
  saveJobToTab,
  fetchSpreadsheetMetadata,
  syncTabHeaders,
} from '../lib/sheets-api.js';
import { parseGoogleSheetUrl } from '../lib/sheet-url.js';
import { prepareTabConfig, mergeTabMappings } from '../lib/sheet-config.js';
import {
  enrichMappingsWithDropdownOptions,
  buildRowFromMappings,
  buildColumnUniques,
  mergeDropdownOptions,
  normalizeDropdownOptions,
  getUniqueColumnValues,
} from '../lib/field-mapper.js';
import { FIELD_TAGS } from '../lib/constants.js';
import { findExistingApplication } from '../lib/duplicates.js';
import {
  getConfiguredSheets,
  saveConfiguredSheets,
  getSettings,
  getUndoStack,
  saveUndoStack,
  getOAuthClientId,
  saveOAuthClientId,
  getOAuthClientSecret,
  saveOAuthClientSecret,
  getOauthPkce,
  saveOauthPkce,
  clearOauthPkce,
  getGoogleToken,
  saveGoogleToken,
  clearGoogleToken,
} from '../lib/storage.js';
import {
  applySchemaChange,
  snapshotTabSchema,
  restoreTabSchema,
  createUndoEntry,
  pushUndo,
  popUndo,
  describeChange,
  isDestructiveOp,
  DESTRUCTIVE_WARNING,
  SCHEMA_OPS,
} from '../lib/schema-editor.js';
import {
  sheetsAccessError,
  SIGN_IN_REQUIRED,
  effectiveClientId,
  isValidClientId,
  isAccessTokenFresh,
  buildGoogleAuthUrl,
  parseOAuthRedirect,
  createPkcePair,
  exchangeCodeForToken,
  refreshAccessToken,
  normalizeRedirectUri,
} from '../lib/google-auth.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    sendResponse({ success: false, error: err.message });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'GET_AUTH_STATUS':
      return getAuthStatus();
    case 'GET_OAUTH_SETUP':
      return getOauthSetup();
    case 'SAVE_OAUTH_CLIENT':
      return saveOauthClient(message.clientId, message.clientSecret);
    case 'SIGN_IN':
      return signIn();
    case 'SIGN_OUT':
      return signOut();
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
    case 'UPDATE_TAB_MAPPINGS':
      return updateTabMappings(message);
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

function getRedirectUri() {
  return normalizeRedirectUri(chrome.identity.getRedirectURL());
}

async function resolveClientId() {
  return effectiveClientId(await getOAuthClientId());
}

async function getOauthSetup() {
  const stored = await getOAuthClientId();
  const clientId = effectiveClientId(stored);
  const clientSecret = await getOAuthClientSecret();
  const token = await getGoogleToken();
  return {
    success: true,
    redirectUri: getRedirectUri(),
    clientId,
    hasSecret: Boolean(clientSecret),
    needsSetup: !clientId || !clientSecret,
    signedIn: isAccessTokenFresh(token),
  };
}

async function saveOauthClient(clientId, clientSecret) {
  const trimmed = String(clientId || '').trim();
  if (!isValidClientId(trimmed)) {
    return {
      success: false,
      error: 'Paste the Client ID from Google Cloud. It ends with .apps.googleusercontent.com',
    };
  }
  await saveOAuthClientId(trimmed);
  if (typeof clientSecret === 'string' && clientSecret.trim()) {
    await saveOAuthClientSecret(clientSecret.trim());
  }
  return { success: true, ...(await getOauthSetup()) };
}

async function getAuthStatus() {
  const setup = await getOauthSetup();
  return {
    success: true,
    signedIn: setup.signedIn,
    needsSetup: setup.needsSetup,
    redirectUri: setup.redirectUri,
    clientId: setup.clientId,
  };
}

function launchAuthFlow(url, interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (responseUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(responseUrl);
    });
  });
}

async function requestGoogleToken(interactive) {
  const clientId = await resolveClientId();
  if (!clientId) {
    throw new Error('Finish Google connection in Job Tracker first (the extension shows the steps).');
  }

  const clientSecret = await getOAuthClientSecret();
  const existing = await getGoogleToken();

  if (existing?.refreshToken) {
    try {
      const refreshed = await refreshAccessToken({
        clientId,
        clientSecret: clientSecret || undefined,
        refreshToken: existing.refreshToken,
      });
      await saveGoogleToken(refreshed);
      return refreshed.accessToken;
    } catch {
      await clearGoogleToken();
      if (!interactive) throw new Error(SIGN_IN_REQUIRED);
    }
  }

  if (!interactive) {
    throw new Error(SIGN_IN_REQUIRED);
  }

  const redirectUri = getRedirectUri();
  const pkce = await createPkcePair();
  await saveOauthPkce({ verifier: pkce.verifier, redirectUri, clientId });

  const url = buildGoogleAuthUrl({
    clientId,
    redirectUri,
    codeChallenge: pkce.challenge,
  });
  const responseUrl = await launchAuthFlow(url, true);
  const parsed = parseOAuthRedirect(responseUrl);
  if (!parsed.ok) {
    await clearOauthPkce();
    throw new Error(parsed.error);
  }

  const pending = (await getOauthPkce()) || pkce;
  await clearOauthPkce();

  if (parsed.code) {
    const tokenInfo = await exchangeCodeForToken({
      clientId,
      clientSecret: clientSecret || undefined,
      code: parsed.code,
      redirectUri: pending.redirectUri || redirectUri,
      codeVerifier: pending.verifier,
    });
    await saveGoogleToken(tokenInfo);
    return tokenInfo.accessToken;
  }

  if (parsed.accessToken) {
    await saveGoogleToken({
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      refreshToken: '',
    });
    return parsed.accessToken;
  }

  throw new Error('Google did not return a sign-in code.');
}

async function signIn() {
  try {
    const setup = await getOauthSetup();
    if (setup.needsSetup) {
      return { success: false, signedIn: false, needsSetup: true, ...setup };
    }
    const token = await requestGoogleToken(true);
    return { success: true, signedIn: Boolean(token), needsSetup: false };
  } catch (err) {
    return { success: false, signedIn: false, error: sheetsAccessError(err.message) };
  }
}

async function signOut() {
  await clearGoogleToken();
  return { success: true, signedIn: false };
}

async function withSheetAccess(fn) {
  let tokenInfo = await getGoogleToken();
  let token = isAccessTokenFresh(tokenInfo) ? tokenInfo.accessToken : null;

  if (!token) {
    try {
      token = await requestGoogleToken(false);
    } catch {
      throw new Error(SIGN_IN_REQUIRED);
    }
  }

  try {
    return await fn(token);
  } catch (err) {
    const msg = err.message || '';
    if (/401|invalid.?token|unauthenticated/i.test(msg)) {
      await clearGoogleToken();
      try {
        const fresh = await requestGoogleToken(true);
        return fn(fresh);
      } catch (refreshErr) {
        throw new Error(sheetsAccessError(refreshErr.message));
      }
    }
    throw new Error(sheetsAccessError(msg));
  }
}

async function addSheet(url) {
  const parsed = parseGoogleSheetUrl(url);
  if (!parsed.valid) {
    return { success: false, error: parsed.error };
  }

  try {
    return await withSheetAccess(async (token) => {
      const meta = await fetchSpreadsheetMetadata(parsed.spreadsheetId, token);
      const rawTabs = await loadSpreadsheetTabs(parsed.spreadsheetId, token);
      const spreadsheetTitle =
        meta.properties?.title || `Sheet ${parsed.spreadsheetId.slice(0, 8)}…`;

      const tabs = rawTabs.map((t) => {
        const config = prepareTabConfig(
          t.tabName,
          parsed.spreadsheetId,
          t.gid,
          t.rows
        );
        return {
          tabName: config.tabName,
          gid: config.gid,
          tabId: config.gid,
          isNew: config.isNew,
          headers: config.headers,
          mappings: enrichMappingsWithDropdownOptions(config.mappings, t.rows),
          columnUniques: buildColumnUniques(t.rows),
          rowCount: t.rows.length,
        };
      });

      const sheets = await getConfiguredSheets();
      const existing = sheets.findIndex(
        (s) => s.spreadsheetId === parsed.spreadsheetId
      );

      const sheetEntry = {
        spreadsheetId: parsed.spreadsheetId,
        url: parsed.url,
        name: spreadsheetTitle,
        tabs,
        addedAt: Date.now(),
      };

      if (existing >= 0) {
        sheets[existing] = sheetEntry;
      } else {
        sheets.push(sheetEntry);
      }

      await saveConfiguredSheets(sheets);
      return { success: true, sheet: sheetEntry, sheets };
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function removeSheet(spreadsheetId) {
  const sheets = (await getConfiguredSheets()).filter(
    (s) => s.spreadsheetId !== spreadsheetId
  );
  await saveConfiguredSheets(sheets);
  return { success: true, sheets };
}

async function refreshAllSheets() {
  return withSheetAccess(async (token) => {
    const sheets = await getConfiguredSheets();
    const updated = [];

    for (const sheet of sheets) {
      const rawTabs = await loadSpreadsheetTabs(sheet.spreadsheetId, token);
      const tabs = rawTabs.map((t) => {
        const config = prepareTabConfig(
          t.tabName,
          sheet.spreadsheetId,
          t.gid,
          t.rows
        );
        const existingTab = sheet.tabs?.find((et) => et.gid === t.gid);
        const mappings = mergeTabMappings(existingTab?.mappings, config.mappings);
        return {
          tabName: config.tabName,
          gid: config.gid,
          tabId: config.gid,
          isNew: config.isNew,
          headers: config.headers,
          mappings: enrichMappingsWithDropdownOptions(mappings, t.rows),
          columnUniques: buildColumnUniques(t.rows),
          rowCount: t.rows.length,
        };
      });
      updated.push({ ...sheet, tabs });
    }

    await saveConfiguredSheets(updated);
    return { success: true, sheets: updated };
  });
}

async function updateTabMappings(message) {
  const { spreadsheetId, tabId, mappings } = message;
  const sheets = await getConfiguredSheets();
  const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
  if (!sheet) return { success: false, error: 'Sheet not found' };

  const tab = sheet.tabs.find((t) => t.tabId === tabId || t.gid === tabId);
  if (!tab) return { success: false, error: 'Tab not found' };

  tab.mappings = mappings;
  if (mappings?.length) {
    tab.headers = mappings.map((m) => m.header);
  }
  await saveConfiguredSheets(sheets);
  return { success: true, sheets };
}

async function applySchemaChangeMessage(message) {
  const {
    spreadsheetId,
    tabId,
    change,
    confirmed = false,
    skipSync = false,
  } = message;

  const sheets = await getConfiguredSheets();
  const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
  if (!sheet) return { success: false, error: 'Sheet not found' };

  const tab = sheet.tabs.find((t) => t.tabId === tabId || t.gid === tabId);
  if (!tab) return { success: false, error: 'Tab not found' };

  const destructive = isDestructiveOp(change.op) && !tab.isNew;
  if (destructive && !confirmed) {
    return {
      success: false,
      needsConfirmation: true,
      warning: DESTRUCTIVE_WARNING,
      label: describeChange(change),
    };
  }

  const before = snapshotTabSchema(tab);
  const result = applySchemaChange(tab.headers || [], tab.mappings || [], change);

  tab.headers = result.headers;
  tab.mappings = result.mappings;

  // When switching to Custom Dropdown, always re-read the sheet column and seed choices.
  if (
    change.op === SCHEMA_OPS.CHANGE_TAG &&
    change.newTag === FIELD_TAGS.CUSTOM_DROPDOWN
  ) {
    try {
      await hydrateTabColumnUniques(spreadsheetId, tab, {
        autoApplyEmptyDropdowns: true,
        applyColumnIndex: change.columnIndex,
      });
    } catch (err) {
      // Fall back to any cached uniques if the live read fails.
      const m = tab.mappings.find((x) => x.columnIndex === change.columnIndex);
      if (m) {
        const fromSheet = tab.columnUniques?.[change.columnIndex] || [];
        m.dropdownOptions = mergeDropdownOptions(m.dropdownOptions, fromSheet);
      }
      console.warn('Could not hydrate dropdown options from sheet:', err.message);
    }
  }

  if (result.syncHeaders && !skipSync && !tab.isNew) {
    await withSheetAccess(async (token) => {
      await syncTabHeaders(spreadsheetId, tab.tabName, tab.headers, token);
    });
  }

  const after = snapshotTabSchema(tab);
  const entry = createUndoEntry({
    spreadsheetId,
    tabId: tab.gid,
    tabName: tab.tabName,
    before,
    after,
    change,
    label: describeChange(change),
  });

  const stack = pushUndo(await getUndoStack(), entry);
  await saveUndoStack(stack);
  await saveConfiguredSheets(sheets);

  return {
    success: true,
    sheets,
    undoEntry: entry,
    stack,
    syncedHeaders: result.syncHeaders && !tab.isNew && !skipSync,
  };
}

/**
 * Re-read a tab from Google Sheets, refresh columnUniques, and optionally
 * seed Custom Dropdown mappings from unique cell values.
 */
async function hydrateTabColumnUniques(
  spreadsheetId,
  tab,
  { autoApplyEmptyDropdowns = false, applyColumnIndex = null } = {}
) {
  await withSheetAccess(async (token) => {
    const rows = await loadTabRows(spreadsheetId, tab.tabName, token);
    tab.columnUniques = buildColumnUniques(rows);
    tab.rowCount = rows.length;

    for (const m of tab.mappings || []) {
      if (m.tag !== FIELD_TAGS.CUSTOM_DROPDOWN) continue;
      const fromSheet = getUniqueColumnValues(
        rows,
        m.columnIndex,
        true,
        m.header
      );
      // Keep per-index cache in sync with header-aware lookup.
      if (!tab.columnUniques[m.columnIndex]?.length && fromSheet.length) {
        tab.columnUniques[m.columnIndex] = fromSheet;
      }
      const existing = normalizeDropdownOptions(m.dropdownOptions);
      const applyThis =
        applyColumnIndex != null && m.columnIndex === applyColumnIndex;
      if (applyThis || (autoApplyEmptyDropdowns && existing.length === 0)) {
        m.dropdownOptions = mergeDropdownOptions(existing, fromSheet);
      }
    }
  });
}

async function syncTabColumnUniques(message) {
  const {
    spreadsheetId,
    tabId,
    autoApplyEmptyDropdowns = true,
    columnIndex = null,
    applyColumnIndex = null,
  } = message;

  const sheets = await getConfiguredSheets();
  const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
  if (!sheet) return { success: false, error: 'Sheet not found' };

  const tab = sheet.tabs.find((t) => t.tabId === tabId || t.gid === tabId);
  if (!tab) return { success: false, error: 'Tab not found' };

  try {
    await hydrateTabColumnUniques(spreadsheetId, tab, {
      autoApplyEmptyDropdowns,
      applyColumnIndex,
    });
    await saveConfiguredSheets(sheets);
    const fromSheet =
      columnIndex == null
        ? tab.columnUniques || []
        : tab.columnUniques?.[columnIndex] || [];
    return { success: true, sheets, fromSheet, columnUniques: tab.columnUniques };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function undoSchemaChange(entryId) {
  const stack = await getUndoStack();
  let entry = null;
  let nextStack = stack;

  if (entryId) {
    const idx = stack.findIndex((e) => e.id === entryId);
    if (idx < 0) return { success: false, error: 'Nothing to undo.' };
    entry = stack[idx];
    nextStack = [...stack.slice(0, idx), ...stack.slice(idx + 1)];
  } else {
    const popped = popUndo(stack);
    entry = popped.entry;
    nextStack = popped.stack;
  }

  if (!entry) return { success: false, error: 'Nothing to undo.' };

  const sheets = await getConfiguredSheets();
  const sheet = sheets.find((s) => s.spreadsheetId === entry.spreadsheetId);
  if (!sheet) {
    await saveUndoStack(nextStack);
    return { success: false, error: 'Sheet no longer connected.' };
  }

  const tab = sheet.tabs.find(
    (t) => t.tabId === entry.tabId || t.gid === entry.tabId
  );
  if (!tab) {
    await saveUndoStack(nextStack);
    return { success: false, error: 'Tab no longer available.' };
  }

  restoreTabSchema(tab, entry.before);

  if (entry.destructive && !tab.isNew) {
    await withSheetAccess(async (token) => {
      await syncTabHeaders(entry.spreadsheetId, tab.tabName, tab.headers, token);
    });
  }

  await saveUndoStack(nextStack);
  await saveConfiguredSheets(sheets);

  return { success: true, sheets, stack: nextStack, restored: entry };
}

async function loadAllTabsWithRows(token, sheets) {
  const tabs = [];
  for (const sheet of sheets) {
    let rawTabs = [];
    try {
      rawTabs = await loadSpreadsheetTabs(sheet.spreadsheetId, token);
    } catch {
      continue;
    }
    for (const raw of rawTabs) {
      const configTab = sheet.tabs?.find((t) => String(t.gid) === String(raw.gid));
      tabs.push({
        sheetName: sheet.name,
        tabName: raw.tabName,
        spreadsheetId: sheet.spreadsheetId,
        gid: raw.gid,
        mappings: configTab?.mappings,
        rows: raw.rows || [],
      });
    }
  }
  return tabs;
}

async function findApplication(extractedData = {}) {
  const sheets = await getConfiguredSheets();
  if (!sheets.length) return { success: true, matched: false };

  try {
    return await withSheetAccess(async (token) => {
      const tabs = await loadAllTabsWithRows(token, sheets);
      const hit = findExistingApplication(tabs, extractedData);
      return { success: true, ...hit };
    });
  } catch (err) {
    return { success: false, matched: false, error: err.message };
  }
}

async function saveJob(message) {
  const { spreadsheetId, tabId, extractedData, userInputs } = message;

  return withSheetAccess(async (token) => {
    const sheets = await getConfiguredSheets();
    const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
    if (!sheet) return { success: false, error: 'Sheet not found' };

    const tab = sheet.tabs.find((t) => t.tabId === tabId || t.gid === tabId);
    if (!tab) return { success: false, error: 'Tab not found' };

    const allTabs = await loadAllTabsWithRows(token, sheets);
    const existing = findExistingApplication(allTabs, extractedData);
    if (existing.matched) {
      return {
        success: false,
        alreadyApplied: true,
        error: 'Already applied — this job is already in your tracker.',
        match: existing,
      };
    }

    const settings = await getSettings();

    const rawTabs = await loadSpreadsheetTabs(spreadsheetId, token);
    const rawTab = rawTabs.find((t) => String(t.gid) === String(tabId));
    const rows = rawTab?.rows ?? [];

    const tabConfig = {
      isNew: tab.isNew,
      headers: tab.headers,
      mappings: tab.mappings,
    };

    const row = buildRowFromMappings(tab.mappings, rows, extractedData, {
      ...userInputs,
      defaultApplicationStatus: settings.defaultApplicationStatus,
    });

    await saveJobToTab(spreadsheetId, tab.tabName, tabConfig, row, token);

    tab.isNew = false;
    tab.rowCount = (tab.rowCount || 0) + 1;
    await saveConfiguredSheets(sheets);

    return { success: true, row };
  });
}
