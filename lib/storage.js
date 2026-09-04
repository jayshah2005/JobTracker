import { STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';

/**
 * Chrome storage wrapper with sensible defaults.
 * Falls back to in-memory store when chrome.storage is unavailable (tests).
 */

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
  return data[STORAGE_KEYS.SHEETS] || [];
}

export async function saveConfiguredSheets(sheets) {
  return setStorage({ [STORAGE_KEYS.SHEETS]: sheets });
}

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

export async function getUndoStack() {
  const data = await getStorage(STORAGE_KEYS.UNDO_STACK);
  return data[STORAGE_KEYS.UNDO_STACK] || [];
}

export async function saveUndoStack(stack) {
  return setStorage({ [STORAGE_KEYS.UNDO_STACK]: stack });
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
