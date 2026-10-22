/**
 * Typed accessors over chrome.storage.local with sensible defaults.
 * Keys are defined in constants.js (STORAGE_KEYS). Falls back to an in-memory
 * store when chrome.storage is unavailable (unit tests).
 * Note: get-then-set helpers (e.g. saveSettings) are not atomic; callers that
 * mutate shared lists should re-read immediately before writing.
 */

import { STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';
import { destinationKey } from './sheet-config.js';

export { destinationKey };

/** Test-only fallback store. */
const memoryStore = {};

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && chrome.storage?.local;
}

export async function getStorage(keys) {
  if (hasChromeStorage()) {
    return chrome.storage.local.get(keys);
  }
  const result = {};
  const keyList = Array.isArray(keys) ? keys : [keys];
  for (const key of keyList) {
    if (key in memoryStore) result[key] = memoryStore[key];
  }
  return result;
}

export async function setStorage(data) {
  if (hasChromeStorage()) {
    return chrome.storage.local.set(data);
  }
  Object.assign(memoryStore, data);
}

export async function getConfiguredSheets() {
  const data = await getStorage(STORAGE_KEYS.SHEETS);
  const sheets = data[STORAGE_KEYS.SHEETS];
  // Guard against corrupted storage so callers can rely on an array.
  return Array.isArray(sheets) ? sheets : [];
}

export async function saveConfiguredSheets(sheets) {
  return setStorage({ [STORAGE_KEYS.SHEETS]: sheets });
}

/** Stored settings merged over DEFAULT_SETTINGS (new defaults apply to old installs). */
export async function getSettings() {
  const data = await getStorage(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
}

export async function saveSettings(settings) {
  const current = await getSettings();
  return setStorage({
    [STORAGE_KEYS.SETTINGS]: { ...current, ...settings },
  });
}

/**
 * Pick the destination for `key` from a flat destination list. A blank, stale
 * or removed key falls back to the first destination (or null when empty).
 */
export function resolveDefaultDestination(destinations, key) {
  const list = Array.isArray(destinations) ? destinations : [];
  return (key && list.find((d) => destinationKey(d) === key)) || list[0] || null;
}

/** Clear the default destination if it belongs to the removed spreadsheet. */
export async function clearDefaultDestinationForSheet(spreadsheetId) {
  const { defaultDestination } = await getSettings();
  if (defaultDestination && defaultDestination.startsWith(`${spreadsheetId}:`)) {
    await saveSettings({ defaultDestination: '' });
    return true;
  }
  return false;
}

export async function getUndoStack() {
  const data = await getStorage(STORAGE_KEYS.UNDO_STACK);
  const stack = data[STORAGE_KEYS.UNDO_STACK];
  return Array.isArray(stack) ? stack : [];
}

export async function saveUndoStack(stack) {
  return setStorage({ [STORAGE_KEYS.UNDO_STACK]: stack });
}

export async function getRedoStack() {
  const data = await getStorage(STORAGE_KEYS.REDO_STACK);
  const stack = data[STORAGE_KEYS.REDO_STACK];
  return Array.isArray(stack) ? stack : [];
}

export async function saveRedoStack(stack) {
  return setStorage({ [STORAGE_KEYS.REDO_STACK]: stack });
}

export async function getOAuthClientId() {
  const data = await getStorage(STORAGE_KEYS.OAUTH_CLIENT_ID);
  return data[STORAGE_KEYS.OAUTH_CLIENT_ID] || '';
}

export async function saveOAuthClientId(clientId) {
  return setStorage({ [STORAGE_KEYS.OAUTH_CLIENT_ID]: String(clientId || '').trim() });
}

export async function getOAuthClientSecret() {
  const data = await getStorage(STORAGE_KEYS.OAUTH_CLIENT_SECRET);
  return data[STORAGE_KEYS.OAUTH_CLIENT_SECRET] || '';
}

export async function saveOAuthClientSecret(secret) {
  return setStorage({ [STORAGE_KEYS.OAUTH_CLIENT_SECRET]: String(secret || '').trim() });
}

/** Temporary PKCE verifier kept while the Google consent window is open. */
export async function getOauthPkce() {
  const data = await getStorage(STORAGE_KEYS.OAUTH_PKCE);
  return data[STORAGE_KEYS.OAUTH_PKCE] || null;
}

export async function saveOauthPkce(pkce) {
  return setStorage({ [STORAGE_KEYS.OAUTH_PKCE]: pkce });
}

export async function clearOauthPkce() {
  if (hasChromeStorage()) {
    return chrome.storage.local.remove(STORAGE_KEYS.OAUTH_PKCE);
  }
  delete memoryStore[STORAGE_KEYS.OAUTH_PKCE];
}

/** Stored token: { accessToken, refreshToken, expiresAt(ms) } or null. */
export async function getGoogleToken() {
  const data = await getStorage(STORAGE_KEYS.GOOGLE_TOKEN);
  return data[STORAGE_KEYS.GOOGLE_TOKEN] || null;
}

export async function saveGoogleToken(tokenInfo) {
  return setStorage({ [STORAGE_KEYS.GOOGLE_TOKEN]: tokenInfo });
}

export async function clearGoogleToken() {
  if (hasChromeStorage()) {
    return chrome.storage.local.remove(STORAGE_KEYS.GOOGLE_TOKEN);
  }
  delete memoryStore[STORAGE_KEYS.GOOGLE_TOKEN];
}

/** Reset memory store (for tests). */
export function _resetMemoryStore() {
  for (const key of Object.keys(memoryStore)) {
    delete memoryStore[key];
  }
}
