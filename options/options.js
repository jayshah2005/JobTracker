import { FIELD_TAGS, FIELD_TAG_LABELS } from '../lib/constants.js';
import {
  SCHEMA_OPS,
  DESTRUCTIVE_WARNING,
  isDestructiveOp,
} from '../lib/schema-editor.js';
import { normalizeDropdownOptions, normalizeDropdownDefault } from '../lib/field-mapper.js';
import { getSettings, saveSettings } from '../lib/storage.js';

const $ = (sel) => document.querySelector(sel);

let sheets = [];
let settings = {};
let undoStack = [];
/** Remember which dropdown editors the user expanded. */
const openDropdownEditors = new Set();

function dropdownEditorKey(sheetId, tabId, col) {
  return `${sheetId}:${tabId}:${col}`;
}

async function init() {
  $('#add-sheet-btn').addEventListener('click', handleAddSheet);
  $('#refresh-btn').addEventListener('click', handleRefresh);
  $('#undo-btn').addEventListener('click', () => handleUndo());
  $('#auto-show').addEventListener('change', saveSettingsFromUI);
  $('#embed-role-link').addEventListener('change', saveSettingsFromUI);
  $('#default-status').addEventListener('change', saveSettingsFromUI);
  $('#sign-in-btn').addEventListener('click', handleSignIn);
  $('#sign-out-btn').addEventListener('click', handleSignOut);
  $('#open-connect-btn')?.addEventListener('click', openConnectPage);
  $('#open-connect-btn-in')?.addEventListener('click', openConnectPage);

  $('#sheet-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddSheet();
  });

  await loadAuth();
  await loadSheets();
  await loadSettings();
  await loadUndoStack();
}

async function loadAuth() {
  const res = await sendMessage({ type: 'GET_AUTH_STATUS' });
  const signedIn = !!res?.signedIn;
  $('#google-signed-in').classList.toggle('hidden', !signedIn);
  $('#google-signed-out').classList.toggle('hidden', signedIn);
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
    if (res.needsSetup) {
      openConnectPage();
      showStatus('Finish Google setup on the page that just opened.', 'error');
      return;
    }
    if (res.success && res.signedIn) {
      await loadAuth();
      showStatus('Google connected. You can add any sheets this account can edit.', 'success');
    } else {
      showStatus(res.error || 'Google sign-in was cancelled.', 'error');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in with Google';
  }
}

async function handleSignOut() {
  await sendMessage({ type: 'SIGN_OUT' });
  await loadAuth();
  showStatus('Signed out. Sign in again to read or update sheets.', 'success');
}

async function loadSheets() {
  const res = await sendMessage({ type: 'GET_SHEETS' });
  sheets = res.sheets || [];
  renderSheetList();
  await syncDropdownColumnsFromSheet();
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
  settings = await getSettings();
  $('#auto-show').checked = settings.autoShowPopup !== false;
  $('#embed-role-link').checked = settings.embedRoleHyperlink !== false;
  $('#default-status').value = settings.defaultApplicationStatus || 'Applied';
}

async function loadUndoStack() {
  const res = await sendMessage({ type: 'GET_UNDO_STACK' });
  undoStack = res.stack || [];
  renderUndoBar();
}

async function saveSettingsFromUI() {
  await saveSettings({
    autoShowPopup: $('#auto-show').checked,
    embedRoleHyperlink: $('#embed-role-link').checked,
    defaultApplicationStatus: $('#default-status').value || 'Applied',
  });
  settings = await getSettings();
}

async function handleAddSheet() {
  const url = $('#sheet-url').value.trim();
  if (!url) {
    showStatus('Please paste a Google Sheets URL.', 'error');
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
    if (res.success) {
      sheets = res.sheets;
      $('#sheet-url').value = '';
      renderSheetList();
      showStatus('Sheet added successfully!', 'success');
    } else {
      showStatus(res.error || 'Failed to add sheet.', 'error');
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
    const res = await sendMessage({ type: 'REFRESH_SHEETS' });
    if (res.success) {
      sheets = res.sheets;
      renderSheetList();
      showStatus('Sheets refreshed.', 'success');
    } else {
      showStatus(res.error || 'Refresh failed.', 'error');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh All Sheets';
  }
}

function renderUndoBar() {
  const bar = $('#undo-bar');
  const btn = $('#undo-btn');
  const label = $('#undo-label');

  if (!undoStack.length) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  const last = undoStack[undoStack.length - 1];
  label.textContent = `Last change: ${last.label} (${last.tabName})`;
  btn.disabled = false;
  btn.textContent = `Undo (${undoStack.length})`;
}

function renderSheetList() {
  const container = $('#sheet-list');

  if (sheets.length === 0) {
    container.innerHTML =
      '<div class="empty-state card"><p>No sheets connected yet. Paste a Google Sheets link above to get started.</p></div>';
    return;
  }

  container.innerHTML = sheets.map((sheet) => renderSheetCard(sheet)).join('');

  container.querySelectorAll('[data-remove-sheet]').forEach((btn) => {
    btn.addEventListener('click', () => handleRemoveSheet(btn.dataset.removeSheet));
  });

  container.querySelectorAll('.header-input').forEach((input) => {
    input.addEventListener('change', onHeaderRename);
  });

  bindTagComboboxes(container);

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

  container.querySelectorAll('[data-dropdown-default]').forEach((select) => {
    select.addEventListener('change', onDropdownDefaultChange);
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

  const res = await sendMessage({
    type: 'SYNC_TAB_COLUMN_UNIQUES',
    spreadsheetId,
    tabId,
    autoApplyEmptyDropdowns: true,
    columnIndex,
  });
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

function renderSheetCard(sheet) {
  const tabs = (sheet.tabs || []).map((tab) => renderTabMappings(sheet, tab)).join('');

  return `
    <div class="sheet-card">
      <div class="sheet-card-header">
        <div>
          <div class="title">${escapeHtml(sheet.name || 'Spreadsheet')}</div>
          <div class="url">${escapeHtml(sheet.url)}</div>
        </div>
        <button class="btn btn-danger btn-sm" data-remove-sheet="${sheet.spreadsheetId}">Remove</button>
      </div>
      <div class="tab-list">${tabs}</div>
    </div>`;
}

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
        `<option value="">No default</option>`,
        ...options.map(
          (opt) =>
            `<option value="${escapeHtml(opt)}" ${
              opt === defaultValue ? 'selected' : ''
            }>${escapeHtml(opt)}</option>`
        ),
      ].join('');

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
                  <select id="dd-default-${sheet.spreadsheetId}-${tab.gid}-${m.columnIndex}"
                    class="dd-default-select"
                    data-dropdown-default
                    data-sheet="${sheet.spreadsheetId}"
                    data-tab="${tab.gid}"
                    data-col="${m.columnIndex}"
                    ${options.length ? '' : 'disabled'}>
                    ${defaultOptions}
                  </select>
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
          title="Rename column header" />
      </td>
      <td>
        ${renderTagCombobox(sheet.spreadsheetId, tab.gid, m.columnIndex, m.tag)}
      </td>
      <td class="col-actions">
        <button class="btn btn-secondary btn-xs" data-col-action="up"
          data-sheet="${sheet.spreadsheetId}" data-tab="${tab.gid}" data-col="${m.columnIndex}"
          title="Move left" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-secondary btn-xs" data-col-action="down"
          data-sheet="${sheet.spreadsheetId}" data-tab="${tab.gid}" data-col="${m.columnIndex}"
          title="Move right" ${i === mappings.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-danger btn-xs" data-col-action="delete"
          data-sheet="${sheet.spreadsheetId}" data-tab="${tab.gid}" data-col="${m.columnIndex}"
          title="Delete column">✕</button>
      </td>
    </tr>
    ${dropdownEditor}`;
    })
    .join('');

  const badge = tab.isNew
    ? '<span class="badge">New — headers will be created on first save</span>'
    : `<span class="badge">${tab.rowCount ?? 0} rows</span>`;

  return `
    <div class="tab-item">
      <div class="tab-item-header">
        <span class="tab-name">Tab: ${escapeHtml(tab.tabName)}</span>
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
          aria-autocomplete="list"
          aria-expanded="false"
          role="combobox" />
        <button type="button" class="combo-caret" tabindex="-1" aria-label="Show field types"></button>
      </div>
      <ul class="combo-menu hidden" role="listbox"></ul>
    </div>`;
}

/**
 * Searchable field-type dropdown (same interaction as save-form text dropdowns).
 */
function bindTagComboboxes(container) {
  container.querySelectorAll('[data-tag-combo]').forEach((root) => {
    const input = root.querySelector('.combo-input');
    const menu = root.querySelector('.combo-menu');
    const caret = root.querySelector('.combo-caret');
    if (!input || !menu) return;

    let options = [];
    try {
      options = JSON.parse(decodeURIComponent(root.dataset.options || '')) || [];
    } catch {
      options = Object.entries(FIELD_TAG_LABELS).map(([value, label]) => ({
        value,
        label,
      }));
    }

    let committedValue = root.dataset.value || '';
    let committedLabel =
      FIELD_TAG_LABELS[committedValue] || input.value || '';
    let open = false;
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
              o.value.toLowerCase().includes(q)
          )
        : options.slice();

      if (!filtered.length) {
        menu.innerHTML = `<li class="combo-empty">No matching field types</li>`;
        return;
      }

      menu.innerHTML = filtered
        .map((opt) => {
          const selected = opt.value === committedValue ? ' is-selected' : '';
          return `
            <li class="combo-item${selected}" role="option">
              <button type="button" class="combo-pick" data-pick="${escapeHtml(opt.value)}" data-label="${escapeHtml(opt.label)}">
                ${escapeHtml(opt.label)}
              </button>
            </li>`;
        })
        .join('');
    };

    const openMenu = ({ reset = false } = {}) => {
      open = true;
      root.classList.add('is-open');
      input.setAttribute('aria-expanded', 'true');
      menu.classList.remove('hidden');
      if (reset) {
        input.value = '';
        renderMenu('');
      } else {
        renderMenu(input.value);
      }
    };

    const closeMenu = ({ restore = false } = {}) => {
      open = false;
      root.classList.remove('is-open');
      input.setAttribute('aria-expanded', 'false');
      menu.classList.add('hidden');
      if (restore) input.value = committedLabel;
    };

    const pickValue = async (value, label) => {
      const spreadsheetId = root.dataset.sheet;
      const tabId = root.dataset.tab;
      const columnIndex = parseInt(root.dataset.col, 10);
      const prev = committedValue;
      setCommitted(value, label);
      closeMenu();
      if (value === prev) return;

      if (value === FIELD_TAGS.CUSTOM_DROPDOWN) {
        openDropdownEditors.add(
          dropdownEditorKey(spreadsheetId, tabId, columnIndex)
        );
      }

      await applyChange(spreadsheetId, tabId, {
        op: SCHEMA_OPS.CHANGE_TAG,
        columnIndex,
        newTag: value,
      });
    };

    input.addEventListener('focus', () => openMenu({ reset: true }));
    input.addEventListener('click', () => {
      if (!open) openMenu({ reset: true });
      else if (input.value !== '') openMenu({ reset: true });
    });

    caret.addEventListener('mousedown', (e) => {
      e.preventDefault();
      suppressBlur = true;
      if (open) closeMenu({ restore: true });
      else {
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
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = input.value.trim().toLowerCase();
        const match =
          options.find((o) => o.label.toLowerCase() === q) ||
          options.find((o) => o.label.toLowerCase().includes(q));
        if (match) pickValue(match.value, match.label);
        else closeMenu({ restore: true });
      }
    });

    input.addEventListener('blur', () => {
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
  });
}

async function applyChange(spreadsheetId, tabId, change) {
  const destructive = isDestructiveOp(change.op);
  let confirmed = !destructive;

  // New empty tabs: header sync is deferred until first save — still warn for clarity
  const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
  const tab = sheet?.tabs?.find((t) => t.gid === tabId);
  const willSyncNow = destructive && tab && !tab.isNew;

  if (destructive) {
    const extra = willSyncNow
      ? '\n\nThis will rewrite the header row in Google Sheets right away.'
      : '\n\nHeaders will be written when you first save a job to this new tab.';
    confirmed = confirm(`${DESTRUCTIVE_WARNING}${extra}\n\nContinue?`);
    if (!confirmed) return null;
  }

  const res = await sendMessage({
    type: 'APPLY_SCHEMA_CHANGE',
    spreadsheetId,
    tabId,
    change,
    confirmed: true,
  });

  if (!res.success) {
    if (res.needsConfirmation) {
      showStatus(res.warning || DESTRUCTIVE_WARNING, 'error');
    } else {
      showStatus(res.error || 'Could not update columns.', 'error');
    }
    return null;
  }

  sheets = res.sheets;
  undoStack = res.stack || undoStack;
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

async function onHeaderRename(e) {
  const input = e.target;
  const newHeader = input.value.trim();
  if (!newHeader) {
    showStatus('Column name cannot be empty.', 'error');
    await loadSheets();
    return;
  }

  await applyChange(input.dataset.sheet, input.dataset.tab, {
    op: SCHEMA_OPS.RENAME,
    columnIndex: parseInt(input.dataset.col, 10),
    newHeader,
  });
}

function getMapping(spreadsheetId, tabId, columnIndex) {
  const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
  const tab = sheet?.tabs?.find((t) => t.gid === tabId || t.tabId === tabId);
  return tab?.mappings?.find((m) => m.columnIndex === columnIndex) || null;
}

function getTab(spreadsheetId, tabId) {
  const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
  return sheet?.tabs?.find((t) => t.gid === tabId || t.tabId === tabId) || null;
}

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

async function onDropdownDefaultChange(e) {
  const select = e.currentTarget;
  const spreadsheetId = select.dataset.sheet;
  const tabId = select.dataset.tab;
  const columnIndex = parseInt(select.dataset.col, 10);
  const mapping = getMapping(spreadsheetId, tabId, columnIndex);
  const options = normalizeDropdownOptions(mapping?.dropdownOptions);
  await saveDropdownOptions(
    spreadsheetId,
    tabId,
    columnIndex,
    options,
    select.value
  );
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

  const res = await sendMessage({
    type: 'SYNC_TAB_COLUMN_UNIQUES',
    spreadsheetId,
    tabId,
    autoApplyEmptyDropdowns: false,
    columnIndex,
  });
  if (res?.success && res.sheets) sheets = res.sheets;

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
  const res = await sendMessage({
    type: 'SYNC_TAB_COLUMN_UNIQUES',
    spreadsheetId,
    tabId,
    autoApplyEmptyDropdowns: true,
    applyColumnIndex: columnIndex,
    columnIndex,
  });
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

async function handleUndo(entryId) {
  const btn = $('#undo-btn');
  btn.disabled = true;
  btn.textContent = 'Undoing…';

  try {
    const res = await sendMessage({ type: 'UNDO_SCHEMA_CHANGE', entryId });
    if (res.success) {
      sheets = res.sheets;
      undoStack = res.stack || [];
      renderSheetList();
      renderUndoBar();
      showStatus(
        `Undid: ${res.restored?.label || 'last change'}. Headers restored if needed.`,
        'success'
      );
    } else {
      showStatus(res.error || 'Undo failed.', 'error');
      renderUndoBar();
    }
  } catch (err) {
    showStatus(err.message, 'error');
    renderUndoBar();
  }
}

async function handleRemoveSheet(spreadsheetId) {
  if (!confirm('Remove this spreadsheet from Job Tracker?')) return;

  const res = await sendMessage({ type: 'REMOVE_SHEET', spreadsheetId });
  if (res.success) {
    sheets = res.sheets;
    renderSheetList();
    showStatus('Sheet removed.', 'success');
  }
}

function showStatus(msg, type) {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status status-${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4500);
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init();
