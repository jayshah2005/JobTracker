/**
 * Shared "add a sheet" flow for the side panel, Settings, and the connect page.
 *
 * Under the drive.file scope the extension only sees spreadsheets it created
 * or that the user picked in Google Picker. This module holds the pure result
 * handling (unit-tested) plus a small controller that wires the buttons:
 *   - Create tracker sheet        -> CREATE_SHEET
 *   - Choose existing sheet       -> OPEN_PICKER
 *   - Grant access to this sheet  -> OPEN_PICKER { spreadsheetId } (after ADD_SHEET needsPicker)
 * Picked sheets arrive via chrome.storage.onChanged('configuredSheets') and a
 * best-effort { type: 'SHEETS_UPDATED' } runtime message.
 */

export const ACCESS_NOTE = 'Job Tracker only accesses sheets it creates or you choose.';
export const PICKER_WAIT_HINT = 'Finish choosing your sheet in the new tab…';
export const NO_PICKER_HINT =
  'With your own Google client, Job Tracker can only create a new sheet. It cannot open the sheet chooser.';
export const NEEDS_PICKER_MESSAGE =
  'Job Tracker does not have access to that sheet yet. Grant access to continue.';

/** Picker is available unless the backend explicitly says it is not. */
export function isPickerAvailable(authRes) {
  return authRes?.pickerAvailable !== false;
}

/**
 * Normalise an ADD_SHEET / CREATE_SHEET response.
 * @returns {{kind:'success'|'needsPicker'|'error', spreadsheetId?:string, message?:string}}
 */
export function classifyAddResult(res) {
  if (res?.success) return { kind: 'success' };
  if (res?.needsPicker) {
    return {
      kind: 'needsPicker',
      spreadsheetId: res.spreadsheetId || null,
      message: NEEDS_PICKER_MESSAGE,
    };
  }
  return { kind: 'error', message: res?.error || 'Something went wrong. Try again.' };
}

/** Sheets in `next` whose spreadsheetId is not in `prev`. Both may be undefined. */
export function findAddedSheets(prev, next) {
  const known = new Set((Array.isArray(prev) ? prev : []).map((s) => s?.spreadsheetId));
  return (Array.isArray(next) ? next : []).filter((s) => s && !known.has(s.spreadsheetId));
}

/** Sheets whose last refresh was denied (drive.file access missing). */
export function sheetsNeedingAccess(sheets) {
  return (Array.isArray(sheets) ? sheets : []).filter((s) => s && s.needsAccess === true);
}

/** Stable key of which sheets need access; compare to detect flag changes. */
export function needsAccessKey(sheets) {
  return sheetsNeedingAccess(sheets)
    .map((s) => s.spreadsheetId)
    .sort()
    .join(',');
}

/** Copy `sheets`, taking each sheet's needsAccess flag from `next` (by id). */
export function applyAccessFlags(sheets, next) {
  const flags = new Map((Array.isArray(next) ? next : []).map((s) => [s?.spreadsheetId, s?.needsAccess === true]));
  return (Array.isArray(sheets) ? sheets : []).map((s) =>
    flags.has(s.spreadsheetId) ? { ...s, needsAccess: flags.get(s.spreadsheetId) } : s
  );
}

/** True when `current` shows a sheet that `next` (a stored sheet list) no longer has. */
export function sheetsWereRemoved(current, next) {
  const ids = new Set((Array.isArray(next) ? next : []).map((s) => s?.spreadsheetId));
  return (Array.isArray(current) ? current : []).some((s) => !ids.has(s?.spreadsheetId));
}

export const NEEDS_ACCESS_LABEL = 'Needs access';
export const NEEDS_ACCESS_HINT_NO_PICKER =
  'Job Tracker lost access to this sheet. With your own Google client it can only use sheets it created.';

/** Success text for newly added sheets, or '' when nothing is new. */
export function describeAdded(added) {
  if (!added.length) return '';
  const names = added.map((s) => `“${s.name || 'spreadsheet'}”`);
  return `Added ${names.join(', ')}.`;
}

/**
 * Wire the add-sheet buttons.
 * @param {object} o
 * @param {(msg:object)=>Promise<any>} o.sendMessage never needs to reject
 * @param {(msg:string,type:string)=>void} o.showStatus
 * @param {(sheets:any[], addedText:string)=>void|Promise<void>} o.onSheetsChanged
 * @param {(sheets:any[])=>void} [o.onAccessChanged] a sheet's needsAccess flag changed without a new sheet
 * @param {()=>any[]} o.getSheets current known sheets
 * @param {{create?:HTMLElement, choose?:HTMLElement, grant?:HTMLElement, hint?:HTMLElement, note?:HTMLElement}} o.els
 */
export function createSheetAccess({ sendMessage, showStatus, onSheetsChanged, getSheets, els, onAccessChanged }) {
  const labels = new Map();
  let grantId = null;
  let waiting = false;
  let pickerOk = true;
  // Sheet ids already announced. A create/add fires the storage event, the
  // SHEETS_UPDATED message and the direct response; only the first announces.
  const announced = new Set();
  const claim = (sheets) => {
    const fresh = (Array.isArray(sheets) ? sheets : []).filter((s) => s && !announced.has(s.spreadsheetId));
    fresh.forEach((s) => announced.add(s.spreadsheetId));
    return fresh;
  };
  const prune = (sheets) => {
    const ids = new Set((Array.isArray(sheets) ? sheets : []).map((s) => s?.spreadsheetId));
    for (const id of [...announced]) if (!ids.has(id)) announced.delete(id);
  };

  const setHint = (text) => {
    if (!els.hint) return;
    els.hint.textContent = text || '';
    els.hint.classList.toggle('hidden', !text);
  };
  const busy = (btn, on, text) => {
    if (!btn) return;
    if (on) {
      labels.set(btn, btn.textContent);
      btn.textContent = text;
    } else if (labels.has(btn)) {
      btn.textContent = labels.get(btn);
    }
    btn.disabled = on;
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
  };
  const hideGrant = () => {
    grantId = null;
    els.grant?.classList.add('hidden');
  };

  /** Apply backend capability flags (hide Picker buttons for custom clients). */
  function applyAuth(authRes) {
    const ok = isPickerAvailable(authRes);
    pickerOk = ok;
    els.choose?.classList.toggle('hidden', !ok);
    if (!ok) {
      hideGrant();
      if (els.note) els.note.textContent = NO_PICKER_HINT;
    } else if (els.note) {
      els.note.textContent = ACCESS_NOTE;
    }
  }

  /** Show needsPicker feedback and the "Grant access" button. */
  function offerGrant(spreadsheetId, message) {
    showStatus(message || NEEDS_PICKER_MESSAGE, 'info');
    if (els.grant && spreadsheetId) {
      grantId = spreadsheetId;
      els.grant.classList.remove('hidden');
    }
  }

  /** Handle an ADD_SHEET response from a paste-link form. @returns {boolean} success */
  function handleAddResult(res) {
    const r = classifyAddResult(res);
    if (r.kind === 'needsPicker') {
      offerGrant(r.spreadsheetId, r.message);
      return false;
    }
    if (r.kind === 'error') {
      hideGrant();
      showStatus(r.message, 'error');
      return false;
    }
    hideGrant();
    // The caller reports this add itself; stop the storage event repeating it.
    claim(res.sheet ? [res.sheet] : []);
    return true;
  }

  async function openPicker(btn, spreadsheetId) {
    busy(btn, true, 'Opening…');
    try {
      const res = await sendMessage(spreadsheetId ? { type: 'OPEN_PICKER', spreadsheetId } : { type: 'OPEN_PICKER' });
      if (res?.success) {
        waiting = true;
        setHint(PICKER_WAIT_HINT);
        return true;
      } else if (res?.code === 'PICKER_UNAVAILABLE') {
        els.choose?.classList.add('hidden');
        hideGrant();
        showStatus(res.error || NO_PICKER_HINT, 'error');
      } else {
        showStatus(res?.error || 'Could not open the sheet chooser. Try again.', 'error');
      }
    } catch (err) {
      showStatus(err?.message || 'Could not open the sheet chooser.', 'error');
    } finally {
      busy(btn, false);
    }
    return false;
  }

  async function createSheet() {
    busy(els.create, true, 'Creating…');
    try {
      const res = await sendMessage({ type: 'CREATE_SHEET' });
      if (res?.success) {
        const before = getSheets();
        const next = res.sheets || before;
        prune(next);
        // Already announced by the storage event or SHEETS_UPDATED: nothing to repeat.
        const fresh = claim(res.sheet ? [res.sheet] : findAddedSheets(before, next));
        if (fresh.length || !res.sheet) {
          await onSheetsChanged(next, describeAdded(fresh) || 'Tracker sheet created.');
        }
      } else {
        showStatus(res?.error || 'Could not create the sheet. Try again.', 'error');
      }
    } catch (err) {
      showStatus(err?.message || 'Could not create the sheet.', 'error');
    } finally {
      busy(els.create, false);
    }
  }

  /** Called when the stored sheet list changes (storage event or message). */
  async function handleSheetsChanged(nextSheets) {
    prune(nextSheets);
    const added = claim(findAddedSheets(getSheets(), nextSheets));
    if (!added.length) {
      if (needsAccessKey(getSheets()) !== needsAccessKey(nextSheets)) {
        // A re-granted sheet is not "new", but it does finish the picker wait.
        if (waiting) {
          waiting = false;
          setHint('');
        }
        hideGrant();
        onAccessChanged?.(nextSheets);
      }
      return;
    }
    if (waiting) {
      waiting = false;
      setHint('');
    }
    hideGrant();
    await onSheetsChanged(nextSheets, describeAdded(added));
  }

  els.create?.addEventListener('click', createSheet);
  els.choose?.addEventListener('click', () => openPicker(els.choose));
  els.grant?.addEventListener('click', () => grantId && openPicker(els.grant, grantId));

  if (typeof chrome !== 'undefined') {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes.configuredSheets) return;
      handleSheetsChanged(changes.configuredSheets.newValue).catch(() => {});
    });
    chrome.runtime?.onMessage?.addListener((msg) => {
      if (msg?.type !== 'SHEETS_UPDATED') return;
      sendMessage({ type: 'GET_SHEETS' })
        .then((res) => (res?.sheets ? handleSheetsChanged(res.sheets) : null))
        .catch(() => {});
    });
  }

  return {
    applyAuth,
    handleAddResult,
    offerGrant,
    hideGrant,
    setHint,
    openPicker,
    isPickerOk: () => pickerOk,
  };
}
