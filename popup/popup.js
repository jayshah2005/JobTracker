import { FIELD_TAGS } from '../lib/constants.js';
import {
  getFieldsNeedingInput,
  normalizeDropdownOptions,
} from '../lib/field-mapper.js';
import {
  getAllDestinations,
  shouldShowDestinationPicker,
} from '../lib/sheet-config.js';
import { pickBestExtraction } from '../lib/job-extractor.js';
import { SCHEMA_OPS } from '../lib/schema-editor.js';

const $ = (sel) => document.querySelector(sel);

let sheets = [];
let destinations = [];
let selectedDestination = null;
let extractedData = {};
let settings = {};
let userInputs = {};
let existingMatch = null;

async function init() {
  $('#open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  $('#sign-in-btn').addEventListener('click', handleSignIn);
  $('#open-connect-btn').addEventListener('click', openConnectPage);
  $('#open-connect-help').addEventListener('click', (e) => {
    e.preventDefault();
    openConnectPage();
  });
  $('#add-sheet-btn').addEventListener('click', handleAddSheet);
  $('#setup-sheet-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddSheet();
  });

  $('#save-btn').addEventListener('click', handleSave);
  $('#destination-picker').addEventListener('change', onDestinationChange);

  await loadData();
}

async function loadData() {
  showView('loading');
  existingMatch = null;

  const [authRes, sheetsRes, settingsRes, tab] = await Promise.all([
    sendMessage({ type: 'GET_AUTH_STATUS' }),
    sendMessage({ type: 'GET_SHEETS' }),
    chrome.storage.local.get('settings'),
    getActiveTab(),
  ]);

  const signedIn = !!authRes?.signedIn;
  const needsSetup = !!authRes?.needsSetup;
  $('#auth-pill').classList.toggle('hidden', !signedIn);

  if (!signedIn) {
    showView('signin');
    $('#sign-in-btn').classList.toggle('hidden', needsSetup);
    $('#open-connect-btn').classList.toggle('hidden', !needsSetup);
    $('#open-connect-btn').classList.toggle('btn-primary', needsSetup);
    $('#open-connect-btn').classList.toggle('btn-secondary', !needsSetup);
    $('#signin-copy').textContent = needsSetup
      ? 'First-time setup opens in a full page. Follow the steps there, then come back to sign in.'
      : 'Sign in with Google once. That account is used for every spreadsheet you add.';
    return;
  }

  sheets = sheetsRes.sheets || [];
  settings = { defaultApplicationStatus: 'Applied', ...settingsRes.settings };
  destinations = getAllDestinations(sheets);

  if (sheets.length === 0) {
    showView('setup');
    return;
  }

  extractedData = await getPageJobData(tab);
  if (!extractedData.url) {
    extractedData.url = tab?.url || '';
  }

  const found = await sendMessage({
    type: 'FIND_APPLICATION',
    extractedData,
  });
  if (found?.matched) {
    existingMatch = found;
    renderApplied();
    showView('applied');
    return;
  }

  setupDestinationPicker();
  renderPreview();
  renderDynamicFields();
  showView('save');
}

function showView(name) {
  $('#loading-view').classList.toggle('hidden', name !== 'loading');
  $('#signin-view').classList.toggle('hidden', name !== 'signin');
  $('#setup-view').classList.toggle('hidden', name !== 'setup');
  $('#save-view').classList.toggle('hidden', name !== 'save');
  $('#applied-view').classList.toggle('hidden', name !== 'applied');
}

async function handleSignIn() {
  const btn = $('#sign-in-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await sendMessage({ type: 'SIGN_IN' });
    if (res.needsSetup) {
      openConnectPage();
      return;
    }
    if (res.success && res.signedIn) {
      await loadData();
    } else {
      showStatus(
        res.error ||
          'Sign-in failed. Open Set up Google and check Common problems and fixes.',
        'error'
      );
      $('#open-connect-btn').classList.remove('hidden');
      $('#open-connect-btn').classList.remove('btn-primary');
      $('#open-connect-btn').classList.add('btn-secondary');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in with Google';
  }
}

function openConnectPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('connect/connect.html') });
}

async function handleAddSheet() {
  const url = $('#setup-sheet-url').value.trim();
  if (!url) {
    showStatus('Paste a Google Sheets link.', 'error');
    return;
  }

  const btn = $('#add-sheet-btn');
  btn.disabled = true;
  btn.textContent = 'Adding…';

  try {
    const res = await sendMessage({ type: 'ADD_SHEET', url });
    if (res.success) {
      showStatus('Sheet connected.', 'success');
      await loadData();
    } else {
      showStatus(res.error || 'Could not add sheet.', 'error');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Sheet';
  }
}

function setupDestinationPicker() {
  const section = $('#destination-section');
  const picker = $('#destination-picker');

  if (!shouldShowDestinationPicker(sheets)) {
    section.classList.add('hidden');
    selectedDestination = destinations[0] || null;
    return;
  }

  section.classList.remove('hidden');
  picker.innerHTML = destinations
    .map(
      (d, i) =>
        `<option value="${i}">${escapeHtml(d.sheetName)} → ${escapeHtml(d.tabName)}</option>`
    )
    .join('');

  selectedDestination = destinations[0];
}

function onDestinationChange() {
  const idx = parseInt($('#destination-picker').value, 10);
  selectedDestination = destinations[idx];
  renderDynamicFields();
}

function renderApplied() {
  const m = existingMatch;
  const when = m.dateApplied ? ` on ${m.dateApplied}` : '';
  const status = m.status ? ` · ${m.status}` : '';
  $('#applied-summary').textContent = `${m.role || extractedData.role || 'This job'}${
    m.company || extractedData.company ? ` at ${m.company || extractedData.company}` : ''
  }`;
  $('#applied-meta').textContent = `Saved${when}${status}${
    m.tabName ? ` in ${m.sheetName ? `${m.sheetName} → ` : ''}${m.tabName}` : ''
  }. It will not be added again.`;
}

function renderPreview() {
  const grid = $('#preview-grid');
  const items = [
    ['Company', extractedData.company],
    ['Role', extractedData.role],
    ['Location', extractedData.location],
    ['Posted', extractedData.postedDate],
  ].filter(([, v]) => v);

  if (items.length === 0) {
    grid.innerHTML =
      '<p class="field-hint">Could not auto-detect job details. Fill in anything missing below.</p>';
    return;
  }

  grid.innerHTML = items
    .map(
      ([key, val]) =>
        `<div class="preview-item"><span class="key">${key}</span><span class="val">${escapeHtml(val)}</span></div>`
    )
    .join('');
}

function renderDynamicFields() {
  if (!selectedDestination) return;

  const container = $('#dynamic-fields');
  const mappings = selectedDestination.mappings || [];
  const fields = getFieldsNeedingInput(mappings, extractedData, settings);

  if (fields.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = fields.map((field) => renderField(field)).join('');

  // Seed inputs so Save uses the values shown, even if the user never edits them.
  for (const field of fields) {
    if (field.type === 'dropdown') continue;
    const suggested = field.suggestedValue;
    if (suggested != null && suggested !== '') {
      setUserInputForField(field.tag, field.columnIndex, 'text', suggested);
    }
  }

  container.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('change', onFieldChange);
    el.addEventListener('input', onFieldChange);
  });

  bindComboboxes(container);
}

function renderField(field) {
  const id = `field-${field.columnIndex}-${field.tag}`;
  const lowClass = field.lowConfidence ? ' low-confidence' : '';

  if (field.type === 'dropdown') {
    const options = normalizeDropdownOptions(field.options);
    const optionsEncoded = encodeURIComponent(JSON.stringify(options));
    const suggested = field.suggestedValue || '';
    const hint = field.hint
      ? `<p class="field-hint">${escapeHtml(field.hint)}</p>`
      : '';
    return `
      <div class="field-row">
        <label for="${id}">${escapeHtml(field.header)}</label>
        <div class="combo"
          data-combo
          data-col="${field.columnIndex}"
          data-tag="${field.tag}"
          data-options="${optionsEncoded}"
          data-suggested="${escapeHtml(suggested)}">
          <div class="combo-control">
            <input type="text" id="${id}" class="combo-input"
              data-field data-tag="${field.tag}" data-col="${field.columnIndex}" data-type="dropdown"
              data-committed="${escapeHtml(suggested)}"
              value="${escapeHtml(suggested)}"
              placeholder="Search or add…"
              autocomplete="off"
              spellcheck="false"
              aria-autocomplete="list"
              aria-expanded="false"
              role="combobox" />
            <button type="button" class="combo-caret" tabindex="-1" aria-label="Show options"></button>
          </div>
          <ul class="combo-menu hidden" role="listbox"></ul>
        </div>
        ${hint}
      </div>`;
  }

  const suggested =
    field.suggestedValue ||
    getAutoValue(field.tag, extractedData, settings) ||
    '';
  const hint = field.autoFilled
    ? '<p class="field-hint">Auto-filled — edit if needed</p>'
    : field.hint
      ? `<p class="field-hint">${escapeHtml(field.hint)}</p>`
      : '';

  if (field.type === 'textarea') {
    return `
      <div class="field-row${lowClass}">
        <label for="${id}">${escapeHtml(field.header)}</label>
        <textarea id="${id}" rows="3" data-field data-tag="${field.tag}" data-col="${field.columnIndex}"
          data-type="textarea" placeholder="${escapeHtml(field.header)}">${escapeHtml(suggested)}</textarea>
        ${hint}
      </div>`;
  }

  const inputType =
    field.tag === FIELD_TAGS.DATE_APPLIED ||
    field.tag === FIELD_TAGS.CURRENT_DATE ||
    field.tag === FIELD_TAGS.JOB_POSTED_DATE
      ? 'date'
      : 'text';

  return `
    <div class="field-row${lowClass}">
      <label for="${id}">${escapeHtml(field.header)}</label>
      <input type="${inputType}" id="${id}" data-field data-tag="${field.tag}" data-col="${field.columnIndex}"
        data-type="text" value="${escapeHtml(suggested)}" placeholder="${escapeHtml(field.header)}" />
      ${hint}
    </div>`;
}

/**
 * Searchable text combobox: click resets to search all options;
 * typing filters; Enter/add creates a new choice; × removes one.
 */
function bindComboboxes(container) {
  container.querySelectorAll('[data-combo]').forEach((root) => {
    const input = root.querySelector('.combo-input');
    const menu = root.querySelector('.combo-menu');
    const caret = root.querySelector('.combo-caret');
    if (!input || !menu) return;

    let options = parseComboOptions(root);
    let committed = String(
      input.dataset.committed || root.dataset.suggested || ''
    ).trim();
    let open = false;
    let suppressBlur = false;

    if (committed) {
      setUserInputForField(
        input.dataset.tag,
        input.dataset.col,
        'dropdown',
        committed
      );
    }

    const setCommitted = (value) => {
      committed = String(value || '').trim();
      input.dataset.committed = committed;
      input.value = committed;
      setUserInputForField(
        input.dataset.tag,
        input.dataset.col,
        'dropdown',
        committed
      );
    };

    const persistOptions = async (next) => {
      options = normalizeDropdownOptions(next);
      root.dataset.options = encodeURIComponent(JSON.stringify(options));
      updateDestinationDropdownOptions(
        parseInt(input.dataset.col, 10),
        options
      );
      try {
        const res = await sendMessage({
          type: 'APPLY_SCHEMA_CHANGE',
          spreadsheetId: selectedDestination.sheetId,
          tabId: selectedDestination.gid,
          change: {
            op: SCHEMA_OPS.SET_DROPDOWN_OPTIONS,
            columnIndex: parseInt(input.dataset.col, 10),
            options,
          },
          confirmed: true,
        });
        if (res?.success && res.sheets) {
          sheets = res.sheets;
          destinations = getAllDestinations(sheets);
          const current = destinations.find(
            (d) =>
              d.sheetId === selectedDestination.sheetId &&
              String(d.gid) === String(selectedDestination.gid)
          );
          if (current) selectedDestination = current;
        }
      } catch {
        /* keep local options even if persist fails */
      }
    };

    const renderMenu = (query = '') => {
      const q = String(query || '').trim().toLowerCase();
      const filtered = q
        ? options.filter((o) => o.toLowerCase().includes(q))
        : options.slice();

      const exact = options.some((o) => o.toLowerCase() === q);
      const rows = filtered
        .map(
          (opt) => `
          <li class="combo-item" role="option">
            <button type="button" class="combo-pick" data-pick="${escapeHtml(opt)}">${escapeHtml(opt)}</button>
            <button type="button" class="combo-remove" data-remove="${escapeHtml(opt)}" title="Remove option" aria-label="Remove ${escapeHtml(opt)}">×</button>
          </li>`
        )
        .join('');

      const addRow =
        q && !exact
          ? `<li class="combo-item combo-item-add" role="option">
              <button type="button" class="combo-add" data-add="${escapeHtml(query.trim())}">
                Add “${escapeHtml(query.trim())}”
              </button>
            </li>`
          : '';

      const empty =
        !filtered.length && !addRow
          ? `<li class="combo-empty">No options yet — type a value and press Enter</li>`
          : '';

      menu.innerHTML = rows + addRow + empty;
    };

    const openMenu = ({ reset = false } = {}) => {
      open = true;
      root.classList.add('is-open');
      input.setAttribute('aria-expanded', 'true');
      menu.classList.remove('hidden');
      if (reset) {
        // Click/focus reset: clear the field so typing searches all options.
        input.dataset.committed = committed;
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
      if (restore) {
        input.value = committed;
      }
    };

    const pickValue = async (value, { addIfMissing = false } = {}) => {
      const next = String(value || '').trim();
      if (!next) {
        setCommitted('');
        closeMenu();
        return;
      }
      const exists = options.some((o) => o.toLowerCase() === next.toLowerCase());
      if (addIfMissing && !exists) {
        await persistOptions([...options, next]);
      } else if (exists) {
        // Prefer canonical casing from the list.
        const match = options.find((o) => o.toLowerCase() === next.toLowerCase());
        setCommitted(match || next);
        closeMenu();
        return;
      }
      setCommitted(next);
      closeMenu();
    };

    input.addEventListener('focus', () => {
      openMenu({ reset: true });
    });

    input.addEventListener('click', () => {
      if (!open) openMenu({ reset: true });
      else if (input.value !== '') {
        // Already open with typed text — clicking again resets search.
        openMenu({ reset: true });
      }
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
      // Live draft value for save while searching.
      setUserInputForField(
        input.dataset.tag,
        input.dataset.col,
        'dropdown',
        input.value.trim() || committed
      );
    });

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu({ restore: true });
        input.blur();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const typed = input.value.trim();
        if (!typed) {
          closeMenu({ restore: true });
          return;
        }
        await pickValue(typed, { addIfMissing: true });
        return;
      }
      if (e.key === 'ArrowDown' && !open) {
        e.preventDefault();
        openMenu({ reset: false });
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (suppressBlur) return;
        if (!open) return;
        const typed = input.value.trim();
        if (!typed) {
          closeMenu({ restore: true });
          return;
        }
        // Keep typed value; add to options if new.
        pickValue(typed, { addIfMissing: true });
      }, 120);
    });

    menu.addEventListener('mousedown', (e) => {
      // Keep focus on input while interacting with the menu.
      e.preventDefault();
      suppressBlur = true;
    });

    menu.addEventListener('click', async (e) => {
      const removeBtn = e.target.closest('[data-remove]');
      if (removeBtn) {
        const value = removeBtn.dataset.remove;
        const next = options.filter((o) => o !== value);
        await persistOptions(next);
        if (committed === value) setCommitted('');
        renderMenu(input.value);
        suppressBlur = false;
        input.focus();
        return;
      }

      const addBtn = e.target.closest('[data-add]');
      if (addBtn) {
        await pickValue(addBtn.dataset.add, { addIfMissing: true });
        suppressBlur = false;
        return;
      }

      const pickBtn = e.target.closest('[data-pick]');
      if (pickBtn) {
        await pickValue(pickBtn.dataset.pick);
        suppressBlur = false;
      }
    });
  });
}

function parseComboOptions(root) {
  try {
    const raw = root.dataset.options || '';
    const decoded = raw.includes('%') ? decodeURIComponent(raw) : raw;
    const parsed = JSON.parse(decoded || '[]');
    return normalizeDropdownOptions(parsed);
  } catch {
    return [];
  }
}

function updateDestinationDropdownOptions(columnIndex, options) {
  if (!selectedDestination?.mappings) return;
  const mapping = selectedDestination.mappings.find(
    (m) => m.columnIndex === columnIndex
  );
  if (mapping) mapping.dropdownOptions = [...options];
}

function getAutoValue(tag, data, sett) {
  switch (tag) {
    case FIELD_TAGS.DATE_APPLIED:
    case FIELD_TAGS.CURRENT_DATE:
      return formatToday();
    case FIELD_TAGS.ID:
      return data.jobId || '';
    case FIELD_TAGS.COMPANY_NAME:
      return data.company;
    case FIELD_TAGS.ROLE:
      return data.role;
    case FIELD_TAGS.URL:
      return data.url;
    case FIELD_TAGS.LOCATION:
      return data.location;
    case FIELD_TAGS.JOB_POSTED_DATE:
      return data.postedDate;
    case FIELD_TAGS.APPLICATION_STATUS:
      return sett.defaultApplicationStatus;
    default:
      return '';
  }
}

function formatToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function setUserInputForField(tag, columnIndex, type, value) {
  const col = String(columnIndex);
  const next = value == null ? '' : String(value);
  userInputs[`col_${col}`] = next;
  if (type === 'dropdown') {
    userInputs[`dropdown_${col}`] = next;
  } else if (
    tag === FIELD_TAGS.CUSTOM_TEXT ||
    tag === FIELD_TAGS.CUSTOM_TEXTBOX
  ) {
    userInputs[`text_${col}`] = next;
  } else if (tag) {
    userInputs[tag] = next;
  }
}

function onFieldChange(e) {
  const el = e.target;
  setUserInputForField(el.dataset.tag, el.dataset.col, el.dataset.type, el.value);
}

async function handleSave() {
  if (!selectedDestination) {
    showStatus('No destination selected.', 'error');
    return;
  }

  const btn = $('#save-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Saving…';

  collectFieldValues();

  try {
    const res = await sendMessage({
      type: 'SAVE_JOB',
      spreadsheetId: selectedDestination.sheetId,
      tabId: selectedDestination.gid,
      extractedData,
      userInputs,
    });

    if (res.alreadyApplied && res.match) {
      existingMatch = res.match;
      renderApplied();
      showView('applied');
      return;
    }

    if (res.success) {
      showStatus('Saved.', 'success');
      setTimeout(() => window.close(), 900);
    } else {
      showStatus(res.error || 'Failed to save.', 'error');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

function collectFieldValues() {
  document.querySelectorAll('[data-field]').forEach((el) => {
    const tag = el.dataset.tag;
    const col = el.dataset.col;
    const type = el.dataset.type;
    if (type === 'dropdown') {
      const root = el.closest('[data-combo]');
      const isOpen = root?.classList.contains('is-open');
      const draft = el.value.trim();
      const committed = (el.dataset.committed || '').trim();
      // While searching (reset/cleared), keep the last committed choice for Save.
      const value = isOpen && !draft ? committed : draft || committed;
      setUserInputForField(tag, col, 'dropdown', value);
    } else {
      setUserInputForField(tag, col, type, el.value);
    }
  });
}

function showStatus(msg, type) {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status status-${type}`;
  el.classList.remove('hidden');
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getPageJobData(tab) {
  if (!tab?.id) return { url: tab?.url || '', confidence: {}, sources: {} };

  const results = [];

  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: 'GET_PAGE_JOB_DATA',
    });
    if (res?.data) results.push(res);
  } catch {
    /* content script may not be loaded yet */
  }

  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: async () => {
        try {
          const mod = await import(chrome.runtime.getURL('lib/job-extractor.js'));
          return {
            success: true,
            data: mod.extractJobData(document, location.href),
            isJobPage: mod.isLikelyJobPage(location.href, document),
          };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    });
    for (const frame of injected || []) {
      if (frame?.result?.success && frame.result.data) {
        results.push(frame.result);
      }
    }
  } catch {
    /* restricted pages or missing permission */
  }

  return pickBestExtraction(results, tab.url || '');
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
