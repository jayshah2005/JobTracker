/**
 * Website Picker integration: opens the hosted Picker page and handles the
 * externally_connectable message it sends back with the user's chosen sheets.
 */

import { PICKER_ORIGIN, PICKER_PATH, MAX_PICKED_SHEETS, buildPickerUrl } from '../lib/constants.js';
import { isPickerAvailable } from './google-session.js';
import { addPickedSheets } from './sheets-orchestrator.js';

const SPREADSHEET_ID_RE = /^[A-Za-z0-9_-]{20,}$/;

export const PICKER_UNAVAILABLE_ERROR =
  'You are using your own Google client, so choose Create tracker sheet instead.';

/** Sender must be the Picker page on our site. */
export function isTrustedPickerSender(sender) {
  if (!sender || sender.origin !== PICKER_ORIGIN || typeof sender.url !== 'string') return false;
  try {
    const u = new URL(sender.url);
    return u.origin === PICKER_ORIGIN && u.pathname.startsWith(PICKER_PATH);
  } catch {
    return false;
  }
}

/** Validate/dedupe the picked files; returns { files } or { error }. */
export function validatePickedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { error: 'No spreadsheets were selected.' };
  }
  if (files.length > MAX_PICKED_SHEETS) {
    return { error: `Select at most ${MAX_PICKED_SHEETS} spreadsheets at a time.` };
  }
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const id = typeof f?.id === 'string' ? f.id : '';
    if (!SPREADSHEET_ID_RE.test(id)) {
      return { error: 'One of the selected spreadsheets has an invalid ID.' };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: typeof f.name === 'string' ? f.name.slice(0, 200) : '' });
  }
  return { files: out };
}

/** onMessageExternal handler. Resolves to { success, added, error? }. */
export async function handlePickerExternalMessage(message, sender) {
  if (!isTrustedPickerSender(sender)) {
    return { success: false, added: 0, error: 'Request not allowed.' };
  }
  if (message?.type !== 'SHEETS_PICKED') {
    return { success: false, added: 0, error: 'Unknown request.' };
  }
  const checked = validatePickedFiles(message.files);
  if (checked.error) return { success: false, added: 0, error: checked.error };

  const result = await addPickedSheets(checked.files);
  if (result.added > 0) {
    try {
      // Best effort: no listener (UI closed) rejects or sets lastError.
      const p = chrome.runtime.sendMessage({ type: 'SHEETS_UPDATED' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* ignore */
    }
  }
  return result;
}

/** OPEN_PICKER: open the hosted Picker in a new tab. */
export async function openPicker(spreadsheetId) {
  if (!(await isPickerAvailable())) {
    return { success: false, code: 'PICKER_UNAVAILABLE', error: PICKER_UNAVAILABLE_ERROR };
  }
  const ids = spreadsheetId && SPREADSHEET_ID_RE.test(String(spreadsheetId)) ? [spreadsheetId] : [];
  await chrome.tabs.create({ url: buildPickerUrl(chrome.runtime.id, ids) });
  return { success: true };
}
