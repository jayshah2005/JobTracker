/**
 * Settings page (options/options.html).
 *
 * Responsibilities: Google sign-in/out, connecting spreadsheets, editing
 * column headers / field types / dropdown choices (with undo + redo), and the
 * two display preferences. All Google and storage work happens in the service
 * worker via chrome.runtime messages (see sendMessage); this file only renders
 * state and reports the result of every action in the #status banner.
 *
 * Sections: state -> startup -> auth -> sheets -> rendering -> worksheet rename
 *           -> comboboxes -> schema changes -> dropdown choices -> undo/redo
 *           -> helpers.
 */

import { FIELD_TAGS, FIELD_TAG_LABELS } from '../lib/constants.js';
import {
  SCHEMA_OPS,
  DESTRUCTIVE_WARNING,
  isDestructiveOp,
} from '../lib/schema-editor.js';
import { normalizeDropdownOptions, normalizeDropdownDefault } from '../lib/field-mapper.js';
import {
  getSettings,
  saveSettings,
  destinationKey,
  resolveDefaultDestination,
  clearDefaultDestinationForSheet,
} from '../lib/storage.js';
import { getAllDestinations } from '../lib/sheet-config.js';

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sheets = [];
let undoStack = [];
let redoStack = [];
/** Remember which dropdown editors the user expanded. */
const openDropdownEditors = new Set();
/** Active spreadsheet + worksheet tab selections (survive re-renders). */
let activeSpreadsheetId = null;
const activeWorksheetBySheet = new Map();
/** Pending single-click tab switch — cancelled when a double-click starts rename. */
let pendingWorksheetClick = null;

/**
 * Single click selects a worksheet tab; double click renames it. The click is
 * delayed so a double click can cancel the pending selection (re-rendering on
 * the first click would destroy the node before dblclick fires).
 */
function bindWorksheetTab(btn, spreadsheetId) {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('is-editing')) return;

    // Already selected: do not re-render, or dblclick never reaches this node.
    if (btn.classList.contains('is-active')) return;

    clearTimeout(pendingWorksheetClick);
    const gid = btn.dataset.selectWorksheet;
    pendingWorksheetClick = setTimeout(() => {
      pendingWorksheetClick = null;
      activeWorksheetBySheet.set(spreadsheetId, gid);
      renderSheetList();
    }, 280);
  });

  btn.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(pendingWorksheetClick);
    pendingWorksheetClick = null;
    activeWorksheetBySheet.set(spreadsheetId, btn.dataset.selectWorksheet);
    beginWorksheetRename(btn);
  });
}

function dropdownEditorKey(sheetId, tabId, col) {
  return `${sheetId}:${tabId}:${col}`;
}

/**
 * Make sure the active spreadsheet and worksheet still exist after a data
 * change; fall back to the first one otherwise.
 * @returns {{sheet: object, tab: object|null}|null} null when no sheets exist
 */
function ensureActiveSelections() {
  if (!sheets.length) {
    activeSpreadsheetId = null;
    activeWorksheetBySheet.clear();
    return null;
  }

  if (!sheets.some((s) => s.spreadsheetId === activeSpreadsheetId)) {
    activeSpreadsheetId = sheets[0].spreadsheetId;
  }

  const sheet = sheets.find((s) => s.spreadsheetId === activeSpreadsheetId);
  const tabs = sheet?.tabs || [];
  if (!tabs.length) {
    activeWorksheetBySheet.delete(activeSpreadsheetId);
    return { sheet, tab: null };
  }

  const currentGid = activeWorksheetBySheet.get(activeSpreadsheetId);
  const tab =
    tabs.find((t) => String(t.gid) === String(currentGid)) || tabs[0];
  activeWorksheetBySheet.set(activeSpreadsheetId, tab.gid);
  return { sheet, tab };
}

let refreshOnVisibleTimer = null;
let statusTimer = null;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init() {
  $('#add-sheet-btn').addEventListener('click', handleAddSheet);
  $('#refresh-btn').addEventListener('click', handleRefresh);
  $('#undo-btn').addEventListener('click', () => handleUndo());
  $('#redo-btn').addEventListener('click', () => handleRedo());
  $('#auto-show').addEventListener('change', saveSettingsFromUI);
  $('#embed-role-link').addEventListener('change', saveSettingsFromUI);
  $('#default-destination').addEventListener('change', saveDefaultDestination);
  $('#sign-in-btn').addEventListener('click', handleSignIn);
  $('#sign-out-btn').addEventListener('click', handleSignOut);
  $('#open-connect-btn')?.addEventListener('click', openConnectPage);
  $('#open-connect-btn-in')?.addEventListener('click', openConnectPage);

  $('#sheet-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddSheet();
  });

  document.addEventListener('keydown', handleSchemaHistoryShortcut);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (refreshOnVisibleTimer) clearTimeout(refreshOnVisibleTimer);
    // Returning to this tab (e.g. after editing the sheet in Google) re-syncs
    // headers and row counts. Debounced; skipped while the user is typing in
    // the sheet list because a re-render would discard their input.
    refreshOnVisibleTimer = setTimeout(async () => {
      refreshOnVisibleTimer = null;
      if ($('#sheet-list').contains(document.activeElement) && isEditableTarget(document.activeElement)) return;
      try {
        const auth = await sendMessage({ type: 'GET_AUTH_STATUS' });
        if (auth?.signedIn) await loadSheets({ fromNetwork: true, quiet: true });
      } catch {
        // Silent: this is a background refresh, not a user action.
      }
    }, 400);
  });

  try {
    const signedIn = await loadAuth();
    // Pull live headers/rows so manual Google Sheet edits show up.
    await loadSheets({ fromNetwork: signedIn, quiet: true });
    await loadSettings();
    await loadUndoStack();
  } catch (err) {
    showStatus(err.message || 'Could not load settings.', 'error');
  }
}

/** True when the keyboard focus is in a text field (so Ctrl/Cmd+Z belongs to it). */
function isEditableTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

/** Ctrl/Cmd+Z, Shift+Z or Y trigger schema undo/redo when not typing in a field. */
function handleSchemaHistoryShortcut(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return;
  // Let the browser handle text undo/redo inside fields.
  if (isEditableTarget(e.target)) return;

  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    if (!undoStack.length) return;
    e.preventDefault();
    handleUndo();
    return;
  }
  if ((key === 'z' && e.shiftKey) || key === 'y') {
    if (!redoStack.length) return;
    e.preventDefault();
    handleRedo();
  }
}

// ---------------------------------------------------------------------------
// Google account
// ---------------------------------------------------------------------------

/** Show the signed-in or signed-out card. @returns {Promise<boolean>} signed in? */
async function loadAuth() {
  const res = await sendMessage({ type: 'GET_AUTH_STATUS' });
  const signedIn = !!res?.signedIn;
  $('#google-signed-in').classList.toggle('hidden', !signedIn);
  $('#google-signed-out').classList.toggle('hidden', signedIn);
  return signedIn;
}

function openConnectPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('connect/connect.html') });
}

async function handleSignIn() {
  const btn = $('#sign-in-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await sendMessage({ type: 'SIGN_IN' });
    if (res?.needsSetup) {
      openConnectPage();
      showStatus('Finish Google setup on the page that just opened, then sign in again.', 'error');
      return;
    }
    if (res?.success && res.signedIn) {
      await loadAuth();
      showStatus('Google connected. You can add any sheets this account can edit.', 'success');
      // Pick up sheets that were saved before a previous sign-out.
      loadSheets({ fromNetwork: true, quiet: true }).catch(() => {});
    } else {
      showStatus(res?.error || 'Google sign-in was cancelled.', 'error');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in with Google';
  }
}

async function handleSignOut() {
  try {
    await sendMessage({ type: 'SIGN_OUT' });
    await loadAuth();
    // Sign-out only forgets the local token; connected sheets stay listed.
    showStatus('Signed out. Your sheets stay listed; sign in again to read or update them.', 'success');
  } catch (err) {
    showStatus(err.message || 'Could not sign out.', 'error');
  }
}

// ---------------------------------------------------------------------------
// Loading data
// ---------------------------------------------------------------------------

/**
 * Load connected sheets into state and render them.
 * @param {{fromNetwork?: boolean, quiet?: boolean}} opts fromNetwork re-reads
 *   headers from Google (REFRESH_SHEETS) and falls back to the cache on
 *   failure; quiet suppresses the error banner for background refreshes.
 * @returns {Promise<boolean>} false when a network refresh failed
 */

async function loadSheets({ fromNetwork = false, quiet = false } = {}) {
  const res = await sendMessage({
    type: fromNetwork ? 'REFRESH_SHEETS' : 'GET_SHEETS',
  });

  if (fromNetwork && !res?.success) {
    const cached = await sendMessage({ type: 'GET_SHEETS' });
    sheets = cached?.sheets || [];
    renderSheetList();
    await syncDropdownColumnsFromSheet();
    if (!quiet) {
      showStatus(res?.error || 'Could not refresh sheets from Google.', 'error');
    }
    return false;
  }

  sheets = res?.sheets || [];
  renderSheetList();
  await syncDropdownColumnsFromSheet();
  return true;
}

/**
 * For any Custom Dropdown that has no choices (or no cached uniques),
 * re-read the sheet and auto-fill empty dropdowns from unique column values.
 */
async function syncDropdownColumnsFromSheet() {
  const jobs = [];
  for (const sheet of sheets) {
    for (const tab of sheet.tabs || []) {
      const dropdowns = (tab.mappings || []).filter(
        (m) => m.tag === FIELD_TAGS.CUSTOM_DROPDOWN
      );
      if (!dropdowns.length) continue;

      const needsSync = dropdowns.some((m) => {
        const options = normalizeDropdownOptions(m.dropdownOptions);
        const uniques = getColumnUniqueValues(tab, m.columnIndex);
        return options.length === 0 || uniques.length === 0;
      });
      if (!needsSync) continue;

      jobs.push(
        sendMessage({
          type: 'SYNC_TAB_COLUMN_UNIQUES',
          spreadsheetId: sheet.spreadsheetId,
          tabId: tab.gid,
          autoApplyEmptyDropdowns: true,
        })
      );
    }
  }

  if (!jobs.length) return;

  const results = await Promise.all(jobs);
  let updated = false;
  for (const res of results) {
    if (res?.success && res.sheets) {
      sheets = res.sheets;
      updated = true;
    }
  }
  if (updated) renderSheetList();
}

function getColumnUniqueValues(tab, columnIndex) {
  const raw = tab?.columnUniques;
  if (!raw) return [];
  const values = Array.isArray(raw)
    ? raw[columnIndex]
    : raw[columnIndex] ?? raw[String(columnIndex)];
  return Array.isArray(values) ? values.map((v) => String(v).trim()).filter(Boolean) : [];
}

async function loadSettings() {
  const settings = await getSettings();
  $('#auto-show').checked = settings.autoShowPopup !== false;
  $('#embed-role-link').checked = settings.embedRoleHyperlink !== false;
  await renderDefaultDestination();
}

/** Same label the side panel uses for a destination. */
function destinationLabel(d) {
  return `${d.sheetName || 'Spreadsheet'} → ${d.tabName || 'Sheet'}`;
}

/** Fill the Default sheet select from the current sheets; disabled with one destination. */
async function renderDefaultDestination() {
  const select = $('#default-destination');
  const hint = $('#default-destination-hint');
  const dests = getAllDestinations(sheets);
  let saved = '';
  try {
    saved = (await getSettings()).defaultDestination || '';
  } catch {
    /* fall back to first destination */
  }
  const current = resolveDefaultDestination(dests, saved);
  select.innerHTML = dests
    .map((d) => {
      const key = destinationKey(d);
      return `<option value="${escapeHtml(key)}">${escapeHtml(destinationLabel(d))}</option>`;
    })
    .join('');
  if (current) select.value = destinationKey(current);
  select.disabled = dests.length <= 1;
  hint.textContent =
    dests.length === 0
      ? 'Add a sheet to choose a default.'
      : dests.length === 1
        ? 'Only one sheet is connected, so it is used automatically.'
        : 'Pre-selected in the side panel when you save a job';
}

async function saveDefaultDestination() {
  const select = $('#default-destination');
  const dest = getAllDestinations(sheets).find((d) => destinationKey(d) === select.value);
  try {
    await saveSettings({ defaultDestination: select.value });
    showStatus(`Default sheet set to ${dest ? destinationLabel(dest) : 'selection'}.`, 'success');
  } catch (err) {
    showStatus(err.message || 'Could not save default sheet.', 'error');
    await renderDefaultDestination();
  }
}

async function loadUndoStack() {
  const res = await sendMessage({ type: 'GET_UNDO_STACK' });
  undoStack = res?.stack || [];
  redoStack = res?.redoStack || [];
  renderUndoBar();
}

/** Persist both preference checkboxes and confirm to the user. */
async function saveSettingsFromUI() {
  try {
    await saveSettings({
      autoShowPopup: $('#auto-show').checked,
      embedRoleHyperlink: $('#embed-role-link').checked,
    });
    showStatus('Preference saved.', 'success');
  } catch (err) {
    showStatus(err.message || 'Could not save preference.', 'error');
    await loadSettings();
  }
}

// ---------------------------------------------------------------------------
// Spreadsheets: add / refresh / remove
// ---------------------------------------------------------------------------

async function handleAddSheet() {
  const url = $('#sheet-url').value.trim();
  if (!url) {
    showStatus('Paste a Google Sheets link first.', 'error');
    return;
  }

  const auth = await sendMessage({ type: 'GET_AUTH_STATUS' });
  if (!auth?.signedIn) {
    showStatus('Sign in with Google first. That login is reused for every sheet.', 'error');
    return;
  }

  const btn = $('#add-sheet-btn');
  btn.disabled = true;
  btn.textContent = 'Adding…';

  try {
    const res = await sendMessage({ type: 'ADD_SHEET', url });
    if (res?.success) {
      sheets = res.sheets;
      if (res.sheet?.spreadsheetId) {
        activeSpreadsheetId = res.sheet.spreadsheetId;
      } else if (sheets.length) {
        activeSpreadsheetId = sheets[sheets.length - 1].spreadsheetId;
      }
      $('#sheet-url').value = '';
      renderSheetList();
      showStatus(`Added “${res.sheet?.name || 'spreadsheet'}”.`, 'success');
    } else {
      showStatus(res?.error || 'Failed to add sheet.', 'error');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Sheet';
  }
}

async function handleRefresh() {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';

  try {
    const ok = await loadSheets({ fromNetwork: true });
    if (ok) showStatus('Sheets refreshed.', 'success');
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh All Sheets';
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Show/hide the schema-history bar and label the next undo/redo step. */
function renderUndoBar() {
  const bar = $('#undo-bar');
  const undoBtn = $('#undo-btn');
  const redoBtn = $('#redo-btn');
  const label = $('#undo-label');

  if (!undoStack.length && !redoStack.length) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  if (undoStack.length) {
    const last = undoStack[undoStack.length - 1];
    label.textContent = `Last change: ${last.label} (${last.tabName})`;
  } else {
    const next = redoStack[redoStack.length - 1];
    label.textContent = `Ready to redo: ${next.label} (${next.tabName})`;
  }

  undoBtn.disabled = !undoStack.length;
  undoBtn.textContent = undoStack.length
    ? `Undo (${undoStack.length})`
    : 'Undo';
  redoBtn.disabled = !redoStack.length;
  redoBtn.textContent = redoStack.length
    ? `Redo (${redoStack.length})`
    : 'Redo';
}

/** Re-render the whole sheet workspace and rebind every control inside it. */
function renderSheetList() {
  const container = $('#sheet-list');
  renderDefaultDestination();

  if (sheets.length === 0) {
    activeSpreadsheetId = null;
    activeWorksheetBySheet.clear();
    container.innerHTML =
      '<div class="empty-state card"><p>No sheets connected yet. Paste a Google Sheets link above to get started.</p></div>';
    return;
  }

  const { sheet, tab } = ensureActiveSelections();
  if (!sheet) {
    container.innerHTML = '';
    return;
  }

  const sheetTabs = sheets
    .map((s) => {
      const selected = s.spreadsheetId === sheet.spreadsheetId;
      return `
      <button type="button" class="sheet-tab${selected ? ' is-active' : ''}"
        role="tab"
        aria-selected="${selected ? 'true' : 'false'}"
        data-select-sheet="${s.spreadsheetId}"
        title="${escapeHtml(s.name || 'Spreadsheet')}">
        ${escapeHtml(s.name || 'Spreadsheet')}
      </button>`;
    })
    .join('');

  container.innerHTML = `
    <div class="sheet-workspace">
      <div class="sheet-tabs" role="tablist" aria-label="Connected spreadsheets">
        ${sheetTabs}
      </div>
      ${renderSheetPanel(sheet, tab)}
    </div>`;

  container.querySelectorAll('[data-select-sheet]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeSpreadsheetId = btn.dataset.selectSheet;
      renderSheetList();
    });
  });

  container.querySelectorAll('[data-select-worksheet]').forEach((btn) => {
    bindWorksheetTab(btn, sheet.spreadsheetId);
  });

  container.querySelectorAll('[data-remove-sheet]').forEach((btn) => {
    btn.addEventListener('click', () => handleRemoveSheet(btn.dataset.removeSheet));
  });

  container.querySelectorAll('.header-input').forEach((input) => {
    input.addEventListener('change', onHeaderRename);
  });

  bindTagComboboxes(container);
  bindDefaultComboboxes(container);

  container.querySelectorAll('[data-col-action]').forEach((btn) => {
    btn.addEventListener('click', onColumnAction);
  });

  container.querySelectorAll('[data-add-column]').forEach((btn) => {
    btn.addEventListener('click', onAddColumn);
  });

  container.querySelectorAll('[data-add-option]').forEach((btn) => {
    btn.addEventListener('click', onAddDropdownOption);
  });

  container.querySelectorAll('[data-remove-option]').forEach((btn) => {
    btn.addEventListener('click', onRemoveDropdownOption);
  });

  container.querySelectorAll('[data-add-suggestion]').forEach((btn) => {
    btn.addEventListener('click', onAddSuggestion);
  });

  container.querySelectorAll('[data-import-sheet-options]').forEach((btn) => {
    btn.addEventListener('click', onImportSheetOptions);
  });

  container.querySelectorAll('[data-refresh-column-uniques]').forEach((btn) => {
    btn.addEventListener('click', onRefreshColumnUniques);
  });

  container.querySelectorAll('details.dd-editor').forEach((el) => {
    el.addEventListener('toggle', () => {
      const key = el.dataset.editorKey;
      if (!key) return;
      if (el.open) {
        openDropdownEditors.add(key);
        maybeSyncOnOpen(el);
      } else {
        openDropdownEditors.delete(key);
      }
    });
  });

  container.querySelectorAll('.dropdown-option-input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onAddDropdownOptionFromInput(input);
      }
    });
  });
}

/** Markup for one spreadsheet: toolbar, worksheet tabs, and active tab body. */
function renderSheetPanel(sheet, tab) {
  const worksheets = sheet.tabs || [];
  const worksheetTabs = worksheets
    .map((t) => {
      const selected = tab && String(t.gid) === String(tab.gid);
      const name = t.tabName || 'Untitled sheet';
      return `
      <button type="button" class="worksheet-tab${selected ? ' is-active' : ''}"
        role="tab"
        aria-selected="${selected ? 'true' : 'false'}"
        data-select-worksheet="${t.gid}"
        data-sheet="${sheet.spreadsheetId}"
        title="${escapeHtml(name)} — double-click to rename">
        <span class="worksheet-tab-label">${escapeHtml(name)}</span>
      </button>`;
    })
    .join('');

  const body = tab
    ? renderTabMappings(sheet, tab)
    : `<div class="empty-state"><p>This spreadsheet has no tabs yet.</p></div>`;

  const sheetTitle = sheet.name || 'Spreadsheet';
  const sheetUrl = sheet.url || '';

  return `
    <div class="sheet-panel">
      <div class="sheet-panel-toolbar">
        <div class="sheet-panel-title-row">
          <h2 class="sheet-panel-title" title="${escapeHtml(sheetTitle)}">${escapeHtml(sheetTitle)}</h2>
          <button type="button" class="btn btn-danger btn-sm" data-remove-sheet="${sheet.spreadsheetId}">Remove</button>
        </div>
        ${
          sheetUrl
            ? `<a class="sheet-panel-url" href="${escapeHtml(sheetUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sheetUrl)}</a>`
            : ''
        }
      </div>
      <div class="worksheet-tabs" role="tablist" aria-label="Spreadsheet tabs">
        ${worksheetTabs}
      </div>
      <p class="worksheet-hint">Showing real Google Sheet tab names. Double-click a tab to rename it.</p>
      <div class="worksheet-panel">${body}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Worksheet tab rename
// ---------------------------------------------------------------------------

/** Swap a worksheet tab button for an inline text input; Enter saves, Esc cancels. */
function beginWorksheetRename(tabBtn) {
  if (tabBtn.classList.contains('is-editing')) return;

  const spreadsheetId = tabBtn.dataset.sheet;
  const tabId = tabBtn.dataset.selectWorksheet;
  const label = tabBtn.querySelector('.worksheet-tab-label');
  const currentName = (label?.textContent || tabBtn.textContent || '').trim();
  const wasActive = tabBtn.classList.contains('is-active');

  // Never nest an <input> inside <button> — Enter activates the button and
  // aborts/races the save. Replace the tab with a non-button editor host.
  const host = document.createElement('div');
  host.className = `worksheet-tab is-editing${wasActive ? ' is-active' : ''}`;
  host.setAttribute('role', 'tab');
  host.dataset.sheet = spreadsheetId;
  host.dataset.selectWorksheet = tabId;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'worksheet-tab-input';
  input.value = currentName;
  input.setAttribute('aria-label', 'Rename sheet tab');
  input.maxLength = 100;
  host.appendChild(input);
  tabBtn.replaceWith(host);

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  let finished = false;
  let blurTimer = null;

  const teardownBlur = () => {
    input.removeEventListener('blur', onBlur);
    if (blurTimer) {
      clearTimeout(blurTimer);
      blurTimer = null;
    }
  };

  const finish = async (save) => {
    if (finished) return;
    finished = true;
    teardownBlur();

    const next = input.value.trim();
    if (!save || !next || next === currentName) {
      renderSheetList();
      return;
    }

    // Optimistic local update so the UI doesn't snap back if a background
    // sync response arrives mid-rename.
    const localSheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
    const localTab = localSheet?.tabs?.find(
      (t) => String(t.gid) === String(tabId) || String(t.tabId) === String(tabId)
    );
    if (localTab) localTab.tabName = next;
    activeWorksheetBySheet.set(spreadsheetId, tabId);
    input.disabled = true;

    try {
      const res = await sendMessage({
        type: 'RENAME_SHEET_TAB',
        spreadsheetId,
        tabId,
        title: next,
      });

      if (res?.success && res.sheets) {
        sheets = res.sheets;
        activeWorksheetBySheet.set(spreadsheetId, tabId);
        renderSheetList();
        showStatus(`Renamed tab to “${next}”.`, 'success');
        return;
      }

      if (localTab) localTab.tabName = currentName;
      renderSheetList();
      showStatus(res?.error || 'Could not rename tab.', 'error');
    } catch (err) {
      if (localTab) localTab.tabName = currentName;
      renderSheetList();
      showStatus(err.message || 'Could not rename tab.', 'error');
    }
  };

  const onBlur = () => {
    // Defer so Enter keydown can cancel blur and own the save.
    blurTimer = setTimeout(() => finish(true), 0);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      teardownBlur();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      teardownBlur();
      finish(false);
    }
  });

  input.addEventListener('blur', onBlur);
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
}

/**
 * When a Custom Dropdown editor is first opened and has no choices (or no
 * cached sheet values), read the column from Google once and fill it in.
 */
async function maybeSyncOnOpen(detailsEl) {
  if (detailsEl.dataset.synced === '1') return;
  const spreadsheetId = detailsEl.dataset.sheet;
  const tabId = detailsEl.dataset.tab;
  const columnIndex = parseInt(detailsEl.dataset.col, 10);
  const tab = getTab(spreadsheetId, tabId);
  const mapping = getMapping(spreadsheetId, tabId, columnIndex);
  const options = normalizeDropdownOptions(mapping?.dropdownOptions);
  const uniques = getColumnUniqueValues(tab, columnIndex);
  if (options.length && uniques.length) {
    detailsEl.dataset.synced = '1';
    return;
  }

  let res;
  try {
    res = await sendMessage({
      type: 'SYNC_TAB_COLUMN_UNIQUES',
      spreadsheetId,
      tabId,
      autoApplyEmptyDropdowns: true,
      columnIndex,
    });
  } catch {
    return; // Silent: the "Scan sheet" button remains for a manual retry.
  }
  detailsEl.dataset.synced = '1';
  if (res?.success && res.sheets) {
    sheets = res.sheets;
    renderSheetList();
    const next = getMapping(spreadsheetId, tabId, columnIndex);
    const count = normalizeDropdownOptions(next?.dropdownOptions).length;
    if (count) {
      showStatus(`Loaded ${count} choice${count === 1 ? '' : 's'} from the sheet column.`, 'success');
    }
  }
}

/** Markup for the column-mapping table (plus dropdown editors) of one tab. */
function renderTabMappings(sheet, tab) {
  const mappings = tab.mappings || [];
  const rows = mappings
    .map((m, i) => {
      const isDropdown = m.tag === FIELD_TAGS.CUSTOM_DROPDOWN;
      const options = normalizeDropdownOptions(m.dropdownOptions);
      const sheetValues = getColumnUniqueValues(tab, m.columnIndex);
      const suggested = sheetValues.filter(
        (v) => !options.some((o) => o.toLowerCase() === String(v).toLowerCase())
      );
      const editorKey = dropdownEditorKey(sheet.spreadsheetId, tab.gid, m.columnIndex);
      const isOpen = openDropdownEditors.has(editorKey);

      const chips = options
        .map(
          (opt) => `
        <li class="dd-chip">
          <span>${escapeHtml(opt)}</span>
          <button type="button" class="dd-chip-remove" title="Remove"
            data-remove-option
            data-sheet="${sheet.spreadsheetId}"
            data-tab="${tab.gid}"
            data-col="${m.columnIndex}"
            data-option="${escapeHtml(opt)}"
            aria-label="Remove ${escapeHtml(opt)}">×</button>
        </li>`
        )
        .join('');

      const suggestionChips = suggested
        .slice(0, 16)
        .map(
          (opt) => `
        <button type="button" class="dd-suggest"
          data-add-suggestion
          data-sheet="${sheet.spreadsheetId}"
          data-tab="${tab.gid}"
          data-col="${m.columnIndex}"
          data-option="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`
        )
        .join('');

      const defaultValue = normalizeDropdownDefault(
        options,
        m.dropdownDefault
      );
      const defaultOptions = [
        { value: '', label: 'No default' },
        ...options.map((opt) => ({ value: opt, label: opt })),
      ];
      const defaultEncoded = encodeURIComponent(JSON.stringify(defaultOptions));
      const defaultLabel =
        defaultOptions.find((o) => o.value === defaultValue)?.label ||
        'No default';
      const defaultDisabled = options.length ? '' : 'is-disabled';

      const countLabel =
        options.length === 0
          ? 'None yet'
          : defaultValue
            ? `${options.length} · default ${defaultValue}`
            : `${options.length}`;

      const fromSheetBlock = suggested.length
        ? `<div class="dd-sheet">
            <div class="dd-sheet-head">
              <span>In this sheet column</span>
              <button type="button" class="dd-link-btn" data-import-sheet-options
                data-sheet="${sheet.spreadsheetId}"
                data-tab="${tab.gid}"
                data-col="${m.columnIndex}">Add all</button>
            </div>
            <div class="dd-suggest-list">${suggestionChips}</div>
          </div>`
        : sheetValues.length === 0
          ? `<div class="dd-sheet dd-sheet-empty">
              <span>No values found in this column yet.</span>
              <button type="button" class="dd-link-btn" data-refresh-column-uniques
                data-sheet="${sheet.spreadsheetId}"
                data-tab="${tab.gid}"
                data-col="${m.columnIndex}">Scan sheet</button>
            </div>`
          : '';

      const dropdownEditor = isDropdown
        ? `
        <tr class="dd-row">
          <td colspan="4">
            <details class="dd-editor"
              data-editor-key="${editorKey}"
              data-sheet="${sheet.spreadsheetId}"
              data-tab="${tab.gid}"
              data-col="${m.columnIndex}"
              ${isOpen ? 'open' : ''}>
              <summary class="dd-summary">
                <span class="dd-summary-left">
                  <span class="dd-chevron" aria-hidden="true"></span>
                  Dropdown choices
                </span>
                <span class="dd-count">${escapeHtml(countLabel)}</span>
              </summary>
              <div class="dd-body">
                ${
                  options.length
                    ? `<ul class="dd-chips">${chips}</ul>`
                    : `<p class="dd-empty">Add choices manually, or pull unique values from the sheet.</p>`
                }
                ${fromSheetBlock}
                <div class="dd-default-row">
                  <label class="dd-default-label" for="dd-default-${sheet.spreadsheetId}-${tab.gid}-${m.columnIndex}">Default value</label>
                  <div class="combo combo--compact dd-default-combo ${defaultDisabled}"
                    data-default-combo
                    data-sheet="${sheet.spreadsheetId}"
                    data-tab="${tab.gid}"
                    data-col="${m.columnIndex}"
                    data-value="${escapeHtml(defaultValue)}"
                    data-options="${defaultEncoded}">
                    <div class="combo-control">
                      <input type="text" id="dd-default-${sheet.spreadsheetId}-${tab.gid}-${m.columnIndex}"
                        class="combo-input"
                        value="${escapeHtml(defaultLabel)}"
                        data-committed="${escapeHtml(defaultLabel)}"
                        placeholder="Search defaults…"
                        autocomplete="off"
                        spellcheck="false"
                        aria-autocomplete="list"
                        aria-expanded="false"
                        role="combobox"
                        ${options.length ? '' : 'disabled'} />
                      <button type="button" class="combo-caret" tabindex="-1" aria-label="Show default values"></button>
                    </div>
                    <ul class="combo-menu hidden" role="listbox"></ul>
                  </div>
                </div>
                <div class="dd-add">
                  <input type="text" class="dropdown-option-input"
                    placeholder="New choice"
                    data-sheet="${sheet.spreadsheetId}"
                    data-tab="${tab.gid}"
                    data-col="${m.columnIndex}"
                    aria-label="Add dropdown option" />
                  <button type="button" class="btn btn-secondary btn-xs" data-add-option
                    data-sheet="${sheet.spreadsheetId}"
                    data-tab="${tab.gid}"
                    data-col="${m.columnIndex}">Add</button>
                </div>
              </div>
            </details>
          </td>
        </tr>`
        : '';

      return `
    <tr class="mapping-row${isDropdown ? ' mapping-row--dropdown' : ''}">
      <td class="col-order">${i + 1}</td>
      <td>
        <input type="text" class="header-input"
          value="${escapeHtml(m.header)}"
          data-sheet="${sheet.spreadsheetId}"
          data-tab="${tab.gid}"
          data-col="${m.columnIndex}"
          title="Rename column header"
          aria-label="Column name" />
      </td>
      <td>
        ${renderTagCombobox(sheet.spreadsheetId, tab.gid, m.columnIndex, m.tag)}
      </td>
      <td class="col-actions">
        <button class="btn btn-secondary btn-xs" data-col-action="up"
          data-sheet="${sheet.spreadsheetId}" data-tab="${tab.gid}" data-col="${m.columnIndex}"
          title="Move left" aria-label="Move column left" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-secondary btn-xs" data-col-action="down"
          data-sheet="${sheet.spreadsheetId}" data-tab="${tab.gid}" data-col="${m.columnIndex}"
          title="Move right" aria-label="Move column right" ${i === mappings.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-danger btn-xs" data-col-action="delete"
          data-sheet="${sheet.spreadsheetId}" data-tab="${tab.gid}" data-col="${m.columnIndex}"
          title="Delete column" aria-label="Delete column">✕</button>
      </td>
    </tr>
    ${dropdownEditor}`;
    })
    .join('');

  const badge = tab.isNew
    ? '<span class="badge">New — seeding default headers…</span>'
    : `<span class="badge">${tab.rowCount ?? 0} rows</span>`;

  return `
    <div class="worksheet-body">
      <div class="worksheet-body-header">
        ${badge}
      </div>
      <p class="field-hint schema-hint">
        Edit column names and types below. Use Custom Text for a single line,
        Custom Textbox for multi-line notes, or Custom Dropdown for choices.
        Structural edits warn first and can be undone.
      </p>
      <table class="mapping-table">
        <thead>
          <tr><th>#</th><th>Column Name</th><th>Field Type</th><th>Edit</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="actions-row">
        <button class="btn btn-secondary btn-sm" data-add-column
          data-sheet="${sheet.spreadsheetId}" data-tab="${tab.gid}">+ Add Column</button>
      </div>
    </div>`;
}

/** Markup for the field-type combobox; behavior is added by bindTagComboboxes. */
function renderTagCombobox(spreadsheetId, tabId, columnIndex, selectedTag) {
  const label = FIELD_TAG_LABELS[selectedTag] || selectedTag || 'Choose type';
  const options = Object.entries(FIELD_TAG_LABELS).map(([value, text]) => ({
    value,
    label: text,
  }));
  const encoded = encodeURIComponent(JSON.stringify(options));
  const id = `tag-${spreadsheetId}-${tabId}-${columnIndex}`;

  return `
    <div class="combo combo--compact"
      data-tag-combo
      data-sheet="${spreadsheetId}"
      data-tab="${tabId}"
      data-col="${columnIndex}"
      data-value="${escapeHtml(selectedTag || '')}"
      data-options="${encoded}">
      <div class="combo-control">
        <input type="text" id="${id}" class="combo-input mapping-tag-input"
          value="${escapeHtml(label)}"
          data-committed="${escapeHtml(label)}"
          placeholder="Search field types…"
          autocomplete="off"
          spellcheck="false"
          aria-label="Field type"
          aria-autocomplete="list"
          aria-expanded="false"
          role="combobox" />
        <button type="button" class="combo-caret" tabindex="-1" aria-label="Show field types"></button>
      </div>
      <ul class="combo-menu hidden" role="listbox"></ul>
    </div>`;
}

/**
 * Wire up one searchable combobox (text input + caret + listbox menu).
 * Shared by the field-type picker and the dropdown-default picker so both
 * behave identically.
 *
 * @param {HTMLElement} root  element carrying data-value / data-options
 * @param {object} cfg
 * @param {Array<{value:string,label:string}>} cfg.fallbackOptions used if data-options is unreadable
 * @param {string} cfg.emptyText     menu text when the search matches nothing
 * @param {boolean} cfg.matchValue   also match the search text against option values
 * @param {boolean} cfg.enterPicksFirstMenuItem Enter picks the first visible item (else best label match)
 * @param {(value:string,label:string)=>Promise<void>|void} cfg.onPick called when the user changes the value
 */
function bindCombobox(root, cfg) {
  const input = root.querySelector('.combo-input');
  const menu = root.querySelector('.combo-menu');
  const caret = root.querySelector('.combo-caret');
  if (!input || !menu || input.disabled) return;

  let options = [];
  try {
    options = JSON.parse(decodeURIComponent(root.dataset.options || '')) || [];
  } catch {
    options = cfg.fallbackOptions;
  }

  let committedValue = root.dataset.value || '';
  let committedLabel =
    options.find((o) => o.value === committedValue)?.label || input.value || '';
  let open = false;
  // Why: the input blurs when the user clicks the menu or caret; without this
  // flag the blur handler would close the menu before the click registers.
  let suppressBlur = false;

  const setCommitted = (value, label) => {
    committedValue = value;
    committedLabel = label;
    root.dataset.value = value;
    input.dataset.committed = label;
    input.value = label;
  };

  const renderMenu = (query = '') => {
    const q = String(query || '').trim().toLowerCase();
    const filtered = q
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            (cfg.matchValue && o.value.toLowerCase().includes(q))
        )
      : options.slice();

    if (!filtered.length) {
      menu.innerHTML = `<li class="combo-empty">${escapeHtml(cfg.emptyText)}</li>`;
      return;
    }

    menu.innerHTML = filtered
      .map((opt) => {
        const selected = opt.value === committedValue;
        return `
          <li class="combo-item${selected ? ' is-selected' : ''}" role="option" aria-selected="${selected}">
            <button type="button" class="combo-pick" data-pick="${escapeHtml(opt.value)}" data-label="${escapeHtml(opt.label)}">
              ${escapeHtml(opt.label)}
            </button>
          </li>`;
      })
      .join('');
  };

  const openMenu = ({ reset = false } = {}) => {
    if (root.classList.contains('is-disabled')) return;
    open = true;
    root.classList.add('is-open');
    input.setAttribute('aria-expanded', 'true');
    menu.classList.remove('hidden');
    // reset clears the text so the full list shows; typing then filters it.
    if (reset) input.value = '';
    renderMenu(reset ? '' : input.value);
  };

  const closeMenu = ({ restore = false } = {}) => {
    open = false;
    root.classList.remove('is-open');
    input.setAttribute('aria-expanded', 'false');
    menu.classList.add('hidden');
    if (restore) input.value = committedLabel;
  };

  const pickValue = async (value, label) => {
    const prev = committedValue;
    setCommitted(value, label);
    closeMenu();
    if (value !== prev) await cfg.onPick(value, label);
  };

  input.addEventListener('focus', () => openMenu({ reset: true }));
  input.addEventListener('click', () => {
    if (!open || input.value !== '') openMenu({ reset: true });
  });

  caret?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    suppressBlur = true;
    if (open) {
      closeMenu({ restore: true });
    } else {
      input.focus();
      openMenu({ reset: true });
    }
    setTimeout(() => {
      suppressBlur = false;
    }, 0);
  });

  input.addEventListener('input', () => {
    if (!open) openMenu({ reset: false });
    else renderMenu(input.value);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu({ restore: true });
      input.blur();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openMenu({ reset: true });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      let match = null;
      if (cfg.enterPicksFirstMenuItem) {
        const first = menu.querySelector('.combo-pick');
        if (first) match = { value: first.dataset.pick, label: first.dataset.label };
      } else {
        const q = input.value.trim().toLowerCase();
        match =
          options.find((o) => o.label.toLowerCase() === q) ||
          options.find((o) => o.label.toLowerCase().includes(q)) ||
          null;
      }
      if (match) pickValue(match.value, match.label);
      else closeMenu({ restore: true });
    }
  });

  input.addEventListener('blur', () => {
    // Delay so a click on a menu item lands before the menu closes.
    setTimeout(() => {
      if (suppressBlur || !open) return;
      closeMenu({ restore: true });
    }, 120);
  });

  menu.addEventListener('mousedown', (e) => {
    e.preventDefault();
    suppressBlur = true;
  });

  menu.addEventListener('click', (e) => {
    const pickBtn = e.target.closest('[data-pick]');
    if (!pickBtn) return;
    pickValue(pickBtn.dataset.pick, pickBtn.dataset.label);
    suppressBlur = false;
  });
}

/** Searchable field-type picker (mapping table "Field Type" column). */
function bindTagComboboxes(container) {
  const fallbackOptions = Object.entries(FIELD_TAG_LABELS).map(([value, label]) => ({
    value,
    label,
  }));
  container.querySelectorAll('[data-tag-combo]').forEach((root) => {
    bindCombobox(root, {
      fallbackOptions,
      emptyText: 'No matching field types',
      matchValue: true,
      enterPicksFirstMenuItem: false,
      onPick: async (value) => {
        const { sheet: spreadsheetId, tab: tabId } = root.dataset;
        const columnIndex = parseInt(root.dataset.col, 10);
        if (value === FIELD_TAGS.CUSTOM_DROPDOWN) {
          // Open the choices editor right away so the user can add options.
          openDropdownEditors.add(dropdownEditorKey(spreadsheetId, tabId, columnIndex));
        }
        await applyChange(spreadsheetId, tabId, {
          op: SCHEMA_OPS.CHANGE_TAG,
          columnIndex,
          newTag: value,
        });
      },
    });
  });
}

/** Searchable default-value picker for Custom Dropdown columns. */
function bindDefaultComboboxes(container) {
  container.querySelectorAll('[data-default-combo]').forEach((root) => {
    bindCombobox(root, {
      fallbackOptions: [{ value: '', label: 'No default' }],
      emptyText: 'No matching defaults',
      matchValue: false,
      enterPicksFirstMenuItem: true,
      onPick: async (value) => {
        const { sheet: spreadsheetId, tab: tabId } = root.dataset;
        const columnIndex = parseInt(root.dataset.col, 10);
        const mapping = getMapping(spreadsheetId, tabId, columnIndex);
        await saveDropdownOptions(
          spreadsheetId,
          tabId,
          columnIndex,
          normalizeDropdownOptions(mapping?.dropdownOptions),
          value
        );
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Schema changes (rename / retype / move / add / delete columns)
// ---------------------------------------------------------------------------

/**
 * Send one schema edit to the background and refresh the UI.
 * Destructive ops ask for confirmation first. On any failure the sheet list is
 * re-rendered so optimistic UI (typed header, picked field type) reverts.
 * @returns {Promise<object|null>} the response, or null if cancelled/failed
 */
async function applyChange(spreadsheetId, tabId, change) {
  const destructive = isDestructiveOp(change.op);

  const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
  const tab = sheet?.tabs?.find((t) => t.gid === tabId);
  const willSyncNow = destructive && tab && !tab.isNew;

  if (destructive) {
    const extra = willSyncNow
      ? '\n\nThis will rewrite the header row in Google Sheets right away.'
      : '\n\nHeaders will be written to Google Sheets when this new tab is seeded.';
    if (!confirm(`${DESTRUCTIVE_WARNING}${extra}\n\nContinue?`)) {
      renderSheetList(); // revert any optimistic UI (e.g. picked field type)
      return null;
    }
  }

  let res;
  try {
    res = await sendMessage({
      type: 'APPLY_SCHEMA_CHANGE',
      spreadsheetId,
      tabId,
      change,
      // The user already confirmed above (or the op is not destructive).
      confirmed: true,
    });
  } catch (err) {
    res = { success: false, error: err.message };
  }

  if (!res?.success) {
    renderSheetList();
    showStatus(
      res?.needsConfirmation
        ? res.warning || DESTRUCTIVE_WARNING
        : res?.error || 'Could not update columns.',
      'error'
    );
    return null;
  }

  sheets = res.sheets;
  undoStack = res.stack || undoStack;
  redoStack = res.redoStack || [];
  renderSheetList();
  renderUndoBar();
  showStatus(
    res.syncedHeaders
      ? 'Columns updated in Google Sheets. Use Undo if this was a mistake.'
      : 'Column settings saved. Use Undo if this was a mistake.',
    'success'
  );
  return res;
}

/** Header input "change" handler: rename a column (empty names are rejected). */
async function onHeaderRename(e) {
  const input = e.target;
  const newHeader = input.value.trim();
  if (!newHeader) {
    showStatus('Column name cannot be empty.', 'error');
    renderSheetList(); // restore the previous header text
    return;
  }

  await applyChange(input.dataset.sheet, input.dataset.tab, {
    op: SCHEMA_OPS.RENAME,
    columnIndex: parseInt(input.dataset.col, 10),
    newHeader,
  });
}

// ---------------------------------------------------------------------------
// Dropdown choices
// ---------------------------------------------------------------------------

function getMapping(spreadsheetId, tabId, columnIndex) {
  const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
  const tab = sheet?.tabs?.find((t) => t.gid === tabId || t.tabId === tabId);
  return tab?.mappings?.find((m) => m.columnIndex === columnIndex) || null;
}

function getTab(spreadsheetId, tabId) {
  const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
  return sheet?.tabs?.find((t) => t.gid === tabId || t.tabId === tabId) || null;
}

/** Save a column's dropdown choices (and default) as an undoable schema change. */
async function saveDropdownOptions(
  spreadsheetId,
  tabId,
  columnIndex,
  options,
  defaultValue
) {
  openDropdownEditors.add(dropdownEditorKey(spreadsheetId, tabId, columnIndex));
  const mapping = getMapping(spreadsheetId, tabId, columnIndex);
  const nextDefault =
    defaultValue !== undefined ? defaultValue : mapping?.dropdownDefault || '';
  await applyChange(spreadsheetId, tabId, {
    op: SCHEMA_OPS.SET_DROPDOWN_OPTIONS,
    columnIndex,
    options,
    defaultValue: normalizeDropdownDefault(options, nextDefault),
  });
}

async function onAddDropdownOption(e) {
  const btn = e.currentTarget;
  const input = btn
    .closest('.dd-editor')
    ?.querySelector('.dropdown-option-input');
  if (!input) return;
  await onAddDropdownOptionFromInput(input);
}

async function onAddDropdownOptionFromInput(input) {
  const value = input.value.trim();
  if (!value) {
    showStatus('Type a choice before adding it.', 'error');
    return;
  }

  const spreadsheetId = input.dataset.sheet;
  const tabId = input.dataset.tab;
  const columnIndex = parseInt(input.dataset.col, 10);
  const mapping = getMapping(spreadsheetId, tabId, columnIndex);
  const existing = normalizeDropdownOptions(mapping?.dropdownOptions);
  if (existing.some((o) => o.toLowerCase() === value.toLowerCase())) {
    showStatus('That choice is already in the list.', 'error');
    return;
  }

  await saveDropdownOptions(spreadsheetId, tabId, columnIndex, [...existing, value]);
}

/** Clicking a "In this sheet column" chip adds that value as a choice. */
async function onAddSuggestion(e) {
  const btn = e.currentTarget;
  const spreadsheetId = btn.dataset.sheet;
  const tabId = btn.dataset.tab;
  const columnIndex = parseInt(btn.dataset.col, 10);
  const option = btn.dataset.option;
  const mapping = getMapping(spreadsheetId, tabId, columnIndex);
  const existing = normalizeDropdownOptions(mapping?.dropdownOptions);
  await saveDropdownOptions(spreadsheetId, tabId, columnIndex, [...existing, option]);
}

async function onImportSheetOptions(e) {
  const btn = e.currentTarget;
  const spreadsheetId = btn.dataset.sheet;
  const tabId = btn.dataset.tab;
  const columnIndex = parseInt(btn.dataset.col, 10);

  try {
    const res = await sendMessage({
      type: 'SYNC_TAB_COLUMN_UNIQUES',
      spreadsheetId,
      tabId,
      autoApplyEmptyDropdowns: false,
      columnIndex,
    });
    if (res?.success && res.sheets) sheets = res.sheets;
  } catch (err) {
    showStatus(err.message || 'Could not read this sheet column.', 'error');
    return;
  }

  const tab = getTab(spreadsheetId, tabId);
  const mapping = getMapping(spreadsheetId, tabId, columnIndex);
  const fromSheet = getColumnUniqueValues(tab, columnIndex);
  const existing = normalizeDropdownOptions(mapping?.dropdownOptions);
  const merged = normalizeDropdownOptions([...existing, ...fromSheet]);
  if (merged.length === existing.length) {
    showStatus(
      fromSheet.length
        ? 'All sheet values are already in the list.'
        : 'No values found in this column.',
      fromSheet.length ? 'success' : 'error'
    );
    renderSheetList();
    return;
  }
  await saveDropdownOptions(spreadsheetId, tabId, columnIndex, merged);
}

async function onRefreshColumnUniques(e) {
  const btn = e.currentTarget;
  const spreadsheetId = btn.dataset.sheet;
  const tabId = btn.dataset.tab;
  const columnIndex = parseInt(btn.dataset.col, 10);
  btn.disabled = true;
  let res;
  try {
    res = await sendMessage({
      type: 'SYNC_TAB_COLUMN_UNIQUES',
      spreadsheetId,
      tabId,
      autoApplyEmptyDropdowns: true,
      applyColumnIndex: columnIndex,
      columnIndex,
    });
  } catch (err) {
    res = { success: false, error: err.message };
  }
  btn.disabled = false;
  if (!res?.success) {
    showStatus(res?.error || 'Could not read this sheet column.', 'error');
    return;
  }
  sheets = res.sheets;
  openDropdownEditors.add(dropdownEditorKey(spreadsheetId, tabId, columnIndex));
  renderSheetList();
  const mapping = getMapping(spreadsheetId, tabId, columnIndex);
  const count = normalizeDropdownOptions(mapping?.dropdownOptions).length;
  showStatus(
    count
      ? `Found ${count} choice${count === 1 ? '' : 's'} in the sheet.`
      : 'Scanned the sheet — this column still looks empty.',
    count ? 'success' : 'error'
  );
}

async function onRemoveDropdownOption(e) {
  const btn = e.currentTarget;
  const spreadsheetId = btn.dataset.sheet;
  const tabId = btn.dataset.tab;
  const columnIndex = parseInt(btn.dataset.col, 10);
  const option = btn.dataset.option;
  const mapping = getMapping(spreadsheetId, tabId, columnIndex);
  const existing = normalizeDropdownOptions(mapping?.dropdownOptions);
  await saveDropdownOptions(
    spreadsheetId,
    tabId,
    columnIndex,
    existing.filter((o) => o !== option)
  );
}

/** Move up/down or delete a column from the row's action buttons. */
async function onColumnAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.colAction;
  const spreadsheetId = btn.dataset.sheet;
  const tabId = btn.dataset.tab;
  const columnIndex = parseInt(btn.dataset.col, 10);

  if (action === 'delete') {
    await applyChange(spreadsheetId, tabId, {
      op: SCHEMA_OPS.DELETE,
      columnIndex,
    });
    return;
  }

  if (action === 'up') {
    await applyChange(spreadsheetId, tabId, {
      op: SCHEMA_OPS.MOVE,
      fromIndex: columnIndex,
      toIndex: columnIndex - 1,
    });
  } else if (action === 'down') {
    await applyChange(spreadsheetId, tabId, {
      op: SCHEMA_OPS.MOVE,
      fromIndex: columnIndex,
      toIndex: columnIndex + 1,
    });
  }
}

async function onAddColumn(e) {
  const btn = e.currentTarget;
  const name = prompt('New column name:', 'Notes');
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    showStatus('Column name cannot be empty.', 'error');
    return;
  }

  await applyChange(btn.dataset.sheet, btn.dataset.tab, {
    op: SCHEMA_OPS.ADD,
    header: trimmed,
  });
}

// ---------------------------------------------------------------------------
// Undo / redo / remove / status
// ---------------------------------------------------------------------------

/**
 * Run an undo or redo round-trip and refresh the UI.
 * @param {'undo'|'redo'} kind
 * @param {string} [entryId] optional specific history entry
 */
async function runHistoryStep(kind, entryId) {
  const isUndo = kind === 'undo';
  if (!(isUndo ? undoStack : redoStack).length) return;
  const btn = $(isUndo ? '#undo-btn' : '#redo-btn');
  btn.disabled = true;
  btn.textContent = isUndo ? 'Undoing…' : 'Redoing…';

  try {
    const res = await sendMessage({
      type: isUndo ? 'UNDO_SCHEMA_CHANGE' : 'REDO_SCHEMA_CHANGE',
      entryId,
    });
    if (res?.success) {
      sheets = res.sheets;
      undoStack = res.stack || [];
      redoStack = res.redoStack || [];
      renderSheetList();
      showStatus(
        `${isUndo ? 'Undid' : 'Redid'}: ${res.restored?.label || 'last change'}. Headers restored if needed.`,
        'success'
      );
    } else {
      showStatus(res?.error || `${isUndo ? 'Undo' : 'Redo'} failed.`, 'error');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    renderUndoBar(); // always resets button labels/disabled state
  }
}

const handleUndo = (entryId) => runHistoryStep('undo', entryId);
const handleRedo = (entryId) => runHistoryStep('redo', entryId);

/** Disconnect a spreadsheet from the extension (the Google Sheet itself is untouched). */
async function handleRemoveSheet(spreadsheetId) {
  const name = sheets.find((s) => s.spreadsheetId === spreadsheetId)?.name || 'this spreadsheet';
  if (!confirm(`Remove “${name}” from Job Tracker?\n\nThe Google Sheet itself is not deleted.`)) return;

  try {
    const res = await sendMessage({ type: 'REMOVE_SHEET', spreadsheetId });
    if (res?.success) {
      sheets = res.sheets;
      try {
        await clearDefaultDestinationForSheet(spreadsheetId);
      } catch {
        /* a stale default falls back to the first destination */
      }
      renderSheetList();
      showStatus(`Removed “${name}”. The Google Sheet was not changed.`, 'success');
    } else {
      showStatus(res?.error || 'Could not remove the sheet.', 'error');
    }
  } catch (err) {
    showStatus(err.message || 'Could not remove the sheet.', 'error');
  }
}

/** Show a transient banner; a newer message replaces (and re-times) an older one. */
function showStatus(msg, type) {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status status-${type}`;
  el.classList.remove('hidden');
  clearTimeout(statusTimer);
  // Errors stay longer so they can be read.
  statusTimer = setTimeout(() => el.classList.add('hidden'), type === 'error' ? 8000 : 4500);
}

/** Promise wrapper around chrome.runtime.sendMessage; rejects on runtime errors. */
function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(res);
    });
  });
}

/** Escape text for safe use in innerHTML templates and attribute values. */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init();
