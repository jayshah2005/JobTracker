/**
 * Side panel controller for Job Tracker.
 *
 * Shows one view at a time (see showView): loading, error, signin (Google not
 * connected), setup (no sheet added yet), save (form for the current job page,
 * also used to edit an already-saved row) and applied (post-save confirmation).
 * All Google/Sheets work happens in the service worker; this file only sends
 * chrome.runtime messages (GET_AUTH_STATUS, GET_SHEETS, REFRESH_SHEETS,
 * ADD_SHEET, CREATE_SHEET, OPEN_PICKER (via sheet-access.js), FIND_APPLICATION,
 * SAVE_JOB, DELETE_JOB (both may answer code ROW_CHANGED), APPLY_SCHEMA_CHANGE,
 * GET_TAB_JOB_DATA, SIGN_IN, CLOSE_SIDE_PANEL, SIDE_PANEL_UNLOADED).
 *
 * Loading is staged so the form never waits on the sheet search: cached
 * sheets paint the save form + destination picker first, a live
 * REFRESH_SHEETS and FIND_APPLICATION then run in the background (guarded by
 * loadToken so stale results are dropped). A found match auto-enters edit mode
 * only if the user has not touched the form; otherwise a banner offers
 * "View entry". The preselected destination is draft > default sheet
 * (settings.defaultDestination) > first.
 *
 * Sections: state / init / data loading / views / sign-in & setup /
 * destination picker / edit mode / job card & fields / dropdown comboboxes /
 * save & delete / helpers.
 */

import { FIELD_TAGS } from '../lib/constants.js';
import {
  getFieldsNeedingInput,
  normalizeDropdownOptions,
  normalizeDropdownDefault,
  rowToFormInputs,
  formatDate,
  toDateInputValue,
} from '../lib/field-mapper.js';
import {
  getAllDestinations,
  shouldShowDestinationPicker,
  findDestination,
  destinationKey,
  findDestinationIndexByKey,
  chooseInitialDestinationIndex,
} from '../lib/sheet-config.js';
import { urlsMatch } from '../lib/job-url.js';
import { getSettings, saveSettings } from '../lib/storage.js';
import { SCHEMA_OPS } from '../lib/schema-editor.js';
import {
  createSheetAccess,
  sheetsNeedingAccess,
  applyAccessFlags,
  sheetsWereRemoved,
  NEEDS_ACCESS_LABEL,
  NEEDS_ACCESS_HINT_NO_PICKER,
  PICKER_WAIT_HINT,
} from './sheet-access.js';
import { confirmDialog } from '../lib/dialog.js';

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sheets = [];
let destinations = [];
let selectedDestination = null;
let extractedData = {};
let userInputs = {};
let existingMatch = null;
/** When set, Save updates this sheet row instead of appending. */
let editingRowIndex = null;
/** Browser tab this side panel instance is linked to. */
let boundTabId = null;
let boundTabUrl = '';
let refreshTimer = null;
/** Bumped on every loadData; background results from older loads are ignored. */
let loadToken = 0;
/** True once the user typed or changed destination for the current page. */
let userInteracted = false;
/** `${sheetId}:${gid}` of the user's default sheet ('' when unset). */
let defaultDestinationKey = '';

/** Session-storage key for the unsaved form draft of a given tab. */
function draftKey(tabId) {
  return `sidepanelDraft:${tabId}`;
}

function isEditingExisting() {
  return editingRowIndex != null && Number.isFinite(Number(editingRowIndex));
}

/** Ask the service worker to close this panel, then close the window. */
async function collapseSidePanel() {
  try {
    await chrome.runtime.sendMessage({
      type: 'CLOSE_SIDE_PANEL',
      tabId: boundTabId,
    });
  } catch {
    /* ignore */
  }
  try {
    window.close();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Init & tab binding
// ---------------------------------------------------------------------------

/** Add-sheet controller (create / choose / grant access); set in init(). */
let sheetAccess = null;

async function init() {
  boundTabId = await resolveBoundTabId();
  window.addEventListener('pagehide', () => {
    if (boundTabId == null) return;
    chrome.runtime
      .sendMessage({ type: 'SIDE_PANEL_UNLOADED', tabId: boundTabId })
      .catch(() => {});
  });

  const openSettings = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
  $('#open-options').addEventListener('click', openSettings);
  $('#collapse-panel')?.addEventListener('click', collapseSidePanel);

  $('#retry-btn').addEventListener('click', () => loadData({ restoreDraft: true }));
  $('#sign-in-btn').addEventListener('click', handleSignIn);
  $('#open-connect-btn').addEventListener('click', openConnectPage);
  sheetAccess = createSheetAccess({
    sendMessage,
    showStatus,
    getSheets: () => sheets,
    onAccessChanged: (next) => {
      sheets = applyAccessFlags(sheets, next);
      renderNeedsAccess();
    },
    els: {
      create: $('#create-sheet-btn'),
      choose: $('#choose-sheet-btn'),
      grant: $('#grant-sheet-btn'),
      hint: $('#picker-hint'),
      note: $('#access-note'),
    },
    onSheetsChanged: async (_next, text) => {
      await loadData();
      showStatus(text || 'Sheet added. You can now save jobs to it.', 'success');
    },
  });
  $('#add-sheet-btn').addEventListener('click', handleAddSheet);
  $('#setup-sheet-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddSheet();
  });

  $('#save-btn').addEventListener('click', handleSave);
  bindDestinationCombo();
  $('#make-default-btn')?.addEventListener('click', handleMakeDefault);
  $('#view-existing-btn')?.addEventListener('click', () => {
    startEditingExisting().catch((err) => showStatus(err.message, 'error'));
  });
  $('#edit-existing-btn')?.addEventListener('click', () => {
    startEditingExisting().catch((err) => showStatus(err.message, 'error'));
  });
  $('#delete-existing-btn')?.addEventListener('click', () => {
    handleDeleteExisting().catch((err) => showStatus(err.message, 'error'));
  });
  $('#delete-editing-btn')?.addEventListener('click', () => {
    handleDeleteExisting().catch((err) => showStatus(err.message, 'error'));
  });

  chrome.tabs.onUpdated.addListener(onBoundTabUpdated);
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === boundTabId) {
      if (refreshTimer) clearTimeout(refreshTimer);
      chrome.storage.session?.remove?.(draftKey(tabId));
    }
  });
  // A sheet disconnected in Settings (or a disconnect that signs out) must not
  // stay selectable here: saving to it would fail.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.configuredSheets) return;
    if (!sheetsWereRemoved(sheets, changes.configuredSheets.newValue)) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadData({ restoreDraft: true, quiet: true }), 200);
  });

  await loadData({ restoreDraft: true });
}

/** Find the tab this panel belongs to (the active tab of the focused window). */
async function resolveBoundTabId() {
  // Prefer the tab this side panel is attached to (current window's active tab).
  const [tab] =
    (await chrome.tabs.query({ active: true, lastFocusedWindow: true })) || [];
  if (tab?.id) return tab.id;

  const [fallback] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return fallback?.id ?? null;
}

/** Reload job data (debounced) when the bound tab navigates or finishes loading. */
async function onBoundTabUpdated(tabId, changeInfo, tab) {
  if (tabId !== boundTabId) return;
  if (changeInfo.status !== 'complete' && !changeInfo.url) return;
  const nextUrl = tab?.url || changeInfo.url || '';
  if (nextUrl && nextUrl === boundTabUrl && changeInfo.status !== 'complete') {
    return;
  }
  // Same posting, and the panel shows the saved confirmation or the user's
  // in-progress form: a reload would re-render the fields and drop focus.
  if (
    boundTabUrl &&
    urlsMatch(boundTabUrl, nextUrl) &&
    (!$('#applied-view').classList.contains('hidden') ||
      (isSaveViewVisible() && userInteracted))
  ) {
    return;
  }
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadData({ restoreDraft: true, quiet: true });
  }, 350);
}

// ---------------------------------------------------------------------------
// Drafts (per-tab, survive panel reloads and tab navigation within the session)
// ---------------------------------------------------------------------------

async function saveDraft() {
  if (!boundTabId || !chrome.storage?.session) return;
  collectFieldValues();
  try {
    await chrome.storage.session.set({
      [draftKey(boundTabId)]: {
        pageUrl: boundTabUrl,
        userInputs: { ...userInputs },
        destinationKey: selectedDestination ? destinationKey(selectedDestination) : null,
        savedAt: Date.now(),
      },
    });
  } catch {
    /* drafts are best-effort; never block saving or loading on them */
  }
}

async function clearDraft() {
  if (!boundTabId || !chrome.storage?.session) return;
  try {
    await chrome.storage.session.remove(draftKey(boundTabId));
  } catch {
    /* best-effort */
  }
}

async function loadDraft() {
  if (!boundTabId || !chrome.storage?.session) return null;
  try {
    const data = await chrome.storage.session.get(draftKey(boundTabId));
    return data[draftKey(boundTabId)] || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data loading: decides which view to show
// ---------------------------------------------------------------------------

/**
 * Load auth, sheets and the current page, then pick a view. Any unexpected
 * failure lands on the error view with a retry button (unless quiet, where
 * the current view stays and only a status message appears).
 * @param {{restoreDraft?: boolean, quiet?: boolean}} opts quiet = background
 *   refresh after tab navigation (no loading spinner, uses cached sheets).
 */
async function loadData(opts = {}) {
  const token = loadToken + 1; // loadDataInner takes this token synchronously
  try {
    await loadDataInner(opts);
  } catch (err) {
    if (token !== loadToken) return; // a newer load owns the view now
    if (opts.quiet) {
      showStatus(err.message || 'Could not refresh job details.', 'error');
    } else {
      $('#error-view-text').textContent =
        err.message || 'Could not load job details. Try again.';
      showView('error');
    }
  }
}

async function loadDataInner({ restoreDraft = false, quiet = false } = {}) {
  const token = ++loadToken;
  if (!quiet) showView('loading');
  existingMatch = null;
  if (!restoreDraft) userInteracted = false;
  setSearching(false);

  const [authRes, tab] = await Promise.all([
    sendMessage({ type: 'GET_AUTH_STATUS' }),
    boundTabId
      ? chrome.tabs.get(boundTabId).catch(() => null)
      : getActiveTab(),
  ]);

  if (token !== loadToken) return;
  if (tab?.id) boundTabId = tab.id;
  const previousUrl = boundTabUrl;
  boundTabUrl = tab?.url || '';
  // Form values belong to one posting; a new job in the same tab starts fresh.
  const samePage = !previousUrl || urlsMatch(previousUrl, boundTabUrl);
  if (!samePage) {
    userInteracted = false;
    clearStatus(); // the old posting's "Saved" / error message does not apply here
  }

  const signedIn = !!authRes?.signedIn;
  const needsSetup = !!authRes?.needsSetup;
  $('#auth-pill').classList.toggle('hidden', !signedIn);
  sheetAccess?.applyAuth(authRes);

  if (!signedIn) {
    showView('signin');
    $('#sign-in-btn').classList.toggle('hidden', needsSetup);
    const connectBtn = $('#open-connect-btn');
    connectBtn.classList.toggle('btn-primary', needsSetup);
    connectBtn.classList.toggle('btn-secondary', !needsSetup);
    connectBtn.textContent = needsSetup ? 'Set up Google' : 'Sign-in help';
    $('#signin-copy').textContent = needsSetup
      ? 'First-time setup opens in a full page. Follow the steps there, then come back to sign in.'
      : authRes?.message || authRes?.error || 'Sign in with Google once. Job Tracker only accesses sheets it creates or you choose.';
    return;
  }

  // Paint from cached sheets (fast); full opens then pull live sheet data in
  // the background so manual Google Sheet edits sync without blocking the form.
  // Quiet tab navigations keep the cached config.
  const [cachedRes, settings] = await Promise.all([
    sendMessage({ type: 'GET_SHEETS' }),
    getSettings().catch(() => ({})),
  ]);
  if (token !== loadToken) return;
  defaultDestinationKey = settings?.defaultDestination || '';

  let sheetsRes = cachedRes;
  let refreshInBackground = !quiet;
  if (!quiet && !(sheetsRes?.sheets || []).length) {
    // Nothing cached: the live list is needed before we can show anything.
    const live = await sendMessage({ type: 'REFRESH_SHEETS' });
    if (token !== loadToken) return;
    if (live?.success) sheetsRes = live;
    else if (live?.error) showStatus(live.error, 'error');
    refreshInBackground = false;
  }

  sheets = sheetsRes?.sheets || [];
  destinations = getAllDestinations(sheets);
  renderNeedsAccess();

  if (sheets.length === 0) {
    showView('setup');
    return;
  }

  const previousInputs = restoreDraft && samePage ? { ...userInputs } : {};
  const draft = restoreDraft ? await loadDraft() : null;
  // The destination choice carries across pages; field values only restore
  // for the posting they were typed on.
  if (draft?.userInputs && urlsMatch(draft.pageUrl, boundTabUrl)) {
    Object.assign(previousInputs, draft.userInputs);
  }

  const pageData = await getPageJobData(tab);
  if (token !== loadToken) return;
  extractedData = pageData;
  if (!extractedData.url) {
    extractedData.url = tab?.url || '';
  }

  editingRowIndex = null;
  existingMatch = null;
  setupDestinationPicker(draft?.destinationKey);
  userInputs = previousInputs;
  renderJobCard();
  renderEditChrome();
  renderDynamicFields({ preferExistingInputs: Boolean(Object.keys(previousInputs).length) });
  showView('save');

  // Background work: neither blocks the form; both are dropped if a newer
  // loadData started meanwhile.
  runApplicationSearch(token);
  if (refreshInBackground) refreshSheetsInBackground(token);
  await saveDraft();
}

/** Show/hide the non-blocking "Checking your sheets…" indicator. */
function setSearching(on) {
  $('#search-indicator')?.classList.toggle('hidden', !on);
}

function isSaveViewVisible() {
  return !$('#save-view').classList.contains('hidden');
}

/**
 * Look for this job in the background (once per page load; changing the
 * destination picker never re-runs it). The selected and default destinations
 * are searched first. On a match: enter edit mode if the user has not touched
 * the form, otherwise just remember it so the banner offers "View entry".
 */
async function runApplicationSearch(token) {
  setSearching(true);
  const preferred = [
    ...new Set(
      [destinationKey(selectedDestination), defaultDestinationKey].filter(Boolean)
    ),
  ];
  const found = await sendMessage({
    type: 'FIND_APPLICATION',
    extractedData: { ...extractedData },
    preferredDestinations: preferred,
  });
  if (token !== loadToken) return;
  setSearching(false);
  if (!found?.matched) return;
  // Already editing, or the form was replaced (saved/applied/error): ignore.
  if (isEditingExisting() || !isSaveViewVisible()) return;
  if (!userInteracted) {
    enterEditMode(found);
    return;
  }
  existingMatch = found;
  renderEditChrome();
}

/**
 * Pull live sheet config after the form is already showing, then fold it in
 * without disturbing what the user is doing: the selection is kept (by key)
 * and fields are only re-rendered when the selected tab's columns changed.
 */
async function refreshSheetsInBackground(token) {
  const res = await sendMessage({ type: 'REFRESH_SHEETS' });
  if (token !== loadToken || !res?.success || !Array.isArray(res.sheets)) return;
  if (!isSaveViewVisible()) return;

  const prevKey = destinationKey(selectedDestination);
  const prevMappings = JSON.stringify(selectedDestination?.mappings || []);
  sheets = res.sheets;
  destinations = getAllDestinations(sheets);
  renderNeedsAccess();
  if (sheets.length === 0) {
    showView('setup');
    return;
  }
  $('#destination-section').classList.toggle(
    'hidden',
    !shouldShowDestinationPicker(sheets)
  );

  const idx = findDestinationIndexByKey(destinations, prevKey);
  if (idx < 0) {
    // The selected tab disappeared: fall back to default/first.
    onDestinationChange(
      chooseInitialDestinationIndex(destinations, {
        defaultKey: defaultDestinationKey,
      }),
      { fromUser: false }
    );
    return;
  }
  selectedDestination = destinations[idx];
  applyPickerSelection(idx);
  if (JSON.stringify(selectedDestination.mappings || []) !== prevMappings) {
    collectFieldValues();
    renderDynamicFields({ preferExistingInputs: true });
  }
  renderEditChrome();
}

/** Show exactly one top-level view: loading | error | signin | setup | save | applied. */
function showView(name) {
  $('#error-view').classList.toggle('hidden', name !== 'error');
  $('#loading-view').classList.toggle('hidden', name !== 'loading');
  $('#signin-view').classList.toggle('hidden', name !== 'signin');
  $('#setup-view').classList.toggle('hidden', name !== 'setup');
  $('#save-view').classList.toggle('hidden', name !== 'save');
  $('#applied-view').classList.toggle('hidden', name !== 'applied');
}

// ---------------------------------------------------------------------------
// Sign-in & first sheet
// ---------------------------------------------------------------------------

async function handleSignIn() {
  const btn = $('#sign-in-btn');
  clearStatus();
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
          'Sign-in failed. Open Sign-in help and check Common problems and fixes.',
        'error'
      );
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

/** Banner listing sheets Job Tracker lost access to, with a Grant access button each. */
function renderNeedsAccess() {
  const box = $('#needs-access');
  if (!box) return;
  const list = sheetsNeedingAccess(sheets);
  box.textContent = '';
  box.classList.toggle('hidden', list.length === 0);
  const canGrant = sheetAccess?.isPickerOk() !== false;
  for (const sheet of list) {
    const row = document.createElement('div');
    row.className = 'needs-access-row';
    const text = document.createElement('p');
    text.className = 'needs-access-text';
    const strong = document.createElement('strong');
    strong.textContent = NEEDS_ACCESS_LABEL;
    const nameEl = document.createElement('span');
    nameEl.className = 'needs-access-name';
    nameEl.title = sheet.name || 'Untitled sheet';
    nameEl.textContent = sheet.name || 'Untitled sheet';
    text.append(strong, nameEl);
    row.appendChild(text);
    if (canGrant) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary needs-access-btn';
      btn.textContent = 'Grant access';
      btn.setAttribute('aria-label', `Grant access to ${sheet.name || 'Untitled sheet'}`);
      btn.addEventListener('click', async () => {
        if (await sheetAccess.openPicker(btn, sheet.spreadsheetId)) showStatus(PICKER_WAIT_HINT, 'info');
      });
      row.appendChild(btn);
    } else {
      const hint = document.createElement('p');
      hint.className = 'field-hint';
      hint.textContent = NEEDS_ACCESS_HINT_NO_PICKER;
      row.appendChild(hint);
    }
    box.appendChild(row);
  }
}

async function handleAddSheet() {
  if ($('#add-sheet-btn').disabled) return; // Enter pressed while a request is running
  const url = $('#setup-sheet-url').value.trim();
  if (!url) {
    showStatus('Paste a Google Sheets link first.', 'error');
    $('#setup-sheet-url').focus();
    return;
  }

  const btn = $('#add-sheet-btn');
  btn.disabled = true;
  btn.textContent = 'Adding…';

  try {
    const res = await sendMessage({ type: 'ADD_SHEET', url });
    if (sheetAccess.handleAddResult(res)) {
      $('#setup-sheet-url').value = '';
      await loadData();
      showStatus('Sheet added. You can now save jobs to it.', 'success');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add sheet';
  }
}

// ---------------------------------------------------------------------------
// Destination picker (which spreadsheet tab a job is saved to)
// ---------------------------------------------------------------------------

function destinationLabel(d) {
  if (!d) return '';
  return `${d.sheetName || 'Untitled sheet'} → ${d.tabName || 'Sheet'}`;
}

/** Reflect `idx` in the picker input and the "Make default" control. */
function applyPickerSelection(idx) {
  const input = $('#destination-picker-input');
  const combo = $('#destination-combo');
  const label = destinationLabel(selectedDestination);
  if (input) {
    input.value = label;
    input.dataset.committed = label;
    input.dataset.index = String(idx);
  }
  if (combo) combo.dataset.index = String(idx);
  updateDefaultControl();
}

/** "Make default" / "Default ✓" state for the currently selected destination. */
function updateDefaultControl() {
  const btn = $('#make-default-btn');
  if (!btn) return;
  const key = destinationKey(selectedDestination);
  const isDefault = Boolean(key) && key === defaultDestinationKey;
  const label = destinationLabel(selectedDestination);
  btn.textContent = isDefault ? 'Default ✓' : 'Make default';
  btn.setAttribute('aria-pressed', isDefault ? 'true' : 'false');
  btn.setAttribute('aria-disabled', isDefault ? 'true' : 'false');
  btn.setAttribute(
    'aria-label',
    isDefault
      ? `${label} is your default sheet`
      : `Make ${label} your default sheet`
  );
}

async function handleMakeDefault() {
  const dest = selectedDestination;
  const key = destinationKey(dest);
  if (!key || key === defaultDestinationKey) return;
  const btn = $('#make-default-btn');
  btn.disabled = true;
  try {
    await saveSettings({ defaultDestination: key });
    defaultDestinationKey = key;
    showStatus(`${destinationLabel(dest)} is now your default sheet.`, 'success');
  } catch (err) {
    showStatus(
      `Could not save your default sheet${err?.message ? `: ${err.message}` : '.'}`,
      'error'
    );
  } finally {
    btn.disabled = false;
    updateDefaultControl();
  }
}

/** Preselect: draft destination, then the default sheet, then the first. */
function setupDestinationPicker(preferredKey = null) {
  const section = $('#destination-section');
  const combo = $('#destination-combo');

  const idx = chooseInitialDestinationIndex(destinations, {
    draftKey: preferredKey || '',
    defaultKey: defaultDestinationKey,
  });
  selectedDestination = destinations[idx] || destinations[0] || null;

  // Still honor preferred destination when the picker is hidden (single tab).
  section.classList.toggle('hidden', !shouldShowDestinationPicker(sheets));

  applyPickerSelection(idx);
  if (combo) combo.classList.toggle('is-disabled', false);
}

/** True when a FIND_APPLICATION match lives in the given destination tab. */
function destinationMatches(match, dest) {
  if (!match?.matched || !dest) return false;
  if (String(match.spreadsheetId) !== String(dest.sheetId)) return false;
  const gid = String(dest.gid);
  return (
    String(match.gid) === gid ||
    String(match.tabId) === gid ||
    String(match.tabId) === String(dest.tabId)
  );
}

function onDestinationChange(idx, { fromUser = true } = {}) {
  const next = destinations[idx];
  if (!next) return;
  if (fromUser) userInteracted = true;
  selectedDestination = next;
  applyPickerSelection(idx);

  // Same job in another sheet: switching destination leaves edit mode so Save
  // appends a new row. Switching back to the matched tab restores Update.
  if (
    destinationMatches(existingMatch, next) &&
    existingMatch.rowIndex != null &&
    Number.isFinite(Number(existingMatch.rowIndex))
  ) {
    editingRowIndex = Number(existingMatch.rowIndex);
    userInputs = rowToFormInputs(next.mappings || [], existingMatch.row || []);
  } else {
    editingRowIndex = null;
  }

  renderEditChrome();
  renderDynamicFields({ preferExistingInputs: true });
  saveDraft();
}

/**
 * Closed searchable destination picker (text dropdown, no free-form values).
 */
function bindDestinationCombo() {
  const root = $('#destination-combo');
  const input = $('#destination-picker-input');
  const menu = root?.querySelector('.combo-menu');
  const caret = root?.querySelector('.combo-caret');
  if (!root || !input || !menu) return;

  let open = false;
  let suppressBlur = false;

  const currentIndex = () => {
    const fromData = parseInt(input.dataset.index ?? root.dataset.index, 10);
    if (Number.isFinite(fromData) && destinations[fromData]) return fromData;
    return Math.max(
      0,
      destinations.findIndex(
        (d) =>
          selectedDestination &&
          d.sheetId === selectedDestination.sheetId &&
          String(d.gid) === String(selectedDestination.gid)
      )
    );
  };

  const renderMenu = (query = '') => {
    const q = String(query || '').trim().toLowerCase();
    const items = destinations
      .map((d, i) => ({ d, i, label: destinationLabel(d) }))
      .filter((item) => !q || item.label.toLowerCase().includes(q));

    if (!items.length) {
      menu.innerHTML = `<li class="combo-empty">No matching destinations</li>`;
      return;
    }

    const selectedIdx = currentIndex();
    menu.innerHTML = items
      .map(({ i, label }) => {
        const selected = i === selectedIdx ? ' is-selected' : '';
        if (destinations[i]?.needsAccess) label = `${label} (needs access)`;
        return `
          <li class="combo-item${selected}" role="option">
            <button type="button" class="combo-pick" data-pick="${i}">${escapeHtml(label)}</button>
          </li>`;
      })
      .join('');
  };

  const openMenu = ({ reset = false } = {}) => {
    if (root.classList.contains('is-disabled') || input.disabled) return;
    open = true;
    root.classList.add('is-open');
    input.setAttribute('aria-expanded', 'true');
    menu.classList.remove('hidden');
    if (reset) {
      input.value = '';
      renderMenu('');
    } else {
      renderMenu(input.value === input.dataset.committed ? '' : input.value);
    }
  };

  const closeMenu = ({ restore = false } = {}) => {
    open = false;
    root.classList.remove('is-open');
    input.setAttribute('aria-expanded', 'false');
    menu.classList.add('hidden');
    if (restore) input.value = input.dataset.committed || '';
  };

  const pickIndex = (idx) => {
    onDestinationChange(idx);
    closeMenu();
  };

  input.addEventListener('focus', () => openMenu({ reset: true }));
  input.addEventListener('click', () => {
    if (!open) openMenu({ reset: true });
  });
  caret?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (open) closeMenu({ restore: true });
    else {
      input.focus();
      openMenu({ reset: true });
    }
  });
  input.addEventListener('input', () => {
    if (!open) openMenu();
    else renderMenu(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu({ restore: true });
      input.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const first = menu.querySelector('.combo-pick');
      if (first) pickIndex(parseInt(first.dataset.pick, 10));
      else closeMenu({ restore: true });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openMenu({ reset: true });
    }
  });
  input.addEventListener('blur', () => {
    if (suppressBlur) return;
    setTimeout(() => closeMenu({ restore: true }), 120);
  });
  menu.addEventListener('mousedown', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (!pick) return;
    e.preventDefault();
    suppressBlur = true;
    pickIndex(parseInt(pick.dataset.pick, 10));
    suppressBlur = false;
  });
}

// ---------------------------------------------------------------------------
// Edit mode (job already saved in a sheet) and post-save confirmation
// ---------------------------------------------------------------------------

function renderApplied() {
  const m = existingMatch;
  const when = m.dateApplied ? ` on ${m.dateApplied}` : '';
  const status = m.status ? ` · ${m.status}` : '';
  $('#applied-summary').textContent = `${m.role || extractedData.role || 'This job'}${
    m.company || extractedData.company ? ` at ${m.company || extractedData.company}` : ''
  }`;
  $('#applied-meta').textContent = `Saved${when}${status}${
    m.tabName ? ` in ${m.sheetName ? `${m.sheetName} → ` : ''}${m.tabName}` : ''
  }.`;
}

/**
 * Switch the save form into "update this row" mode.
 * @returns {boolean} false (with a status message) if the match has no usable row.
 */
function enterEditMode(match) {
  if (match?.rowIndex == null || !Number.isFinite(Number(match.rowIndex))) {
    showStatus('This job is already in your tracker, but its row could not be located for editing. Reopen the side panel to retry.', 'error');
    return false;
  }

  existingMatch = match;
  editingRowIndex = Number(match.rowIndex);

  const dest =
    findDestination(sheets, match.spreadsheetId, match.gid) ||
    findDestination(sheets, match.spreadsheetId, match.tabId);
  const destKey =
    match.spreadsheetId && match.gid != null
      ? `${match.spreadsheetId}:${match.gid}`
      : null;
  setupDestinationPicker(destKey);
  if (dest) selectedDestination = dest;

  const mappings = selectedDestination?.mappings || [];
  // Sheet row is source of truth when revisiting — do not mix in page extraction.
  userInputs = rowToFormInputs(mappings, match.row || []);

  extractedData = {
    ...extractedData,
    company: match.company || extractedData.company,
    role: match.role || extractedData.role,
    url: match.url || extractedData.url,
    location: match.location || extractedData.location,
    jobId: match.jobId || extractedData.jobId,
    applicationStatus: match.status || extractedData.applicationStatus,
  };

  renderJobCard();
  renderEditChrome();
  renderDynamicFields({ preferExistingInputs: true });
  showView('save');
  saveDraft();
  return true;
}

/** Resolve a full match (with rowIndex/row) before entering edit mode. */
async function startEditingExisting() {
  let match = existingMatch;
  if (match?.rowIndex == null || !match.row) {
    const found = await sendMessage({
      type: 'FIND_APPLICATION',
      extractedData,
    });
    if (!found?.matched) {
      showStatus('Could not find that application in your sheet. It may have been moved or deleted.', 'error');
      return;
    }
    match = found;
  }
  enterEditMode(match);
}

function renderEditChrome() {
  const editing = isEditingExisting();
  const multiDest = shouldShowDestinationPicker(sheets);
  // With multiple destinations, keep the picker open so a job already in one
  // sheet can still be added to another.
  const lockDestination = editing && !multiDest;
  const banner = $('#editing-banner');
  const viewBtn = $('#view-existing-btn');
  const lockedHint = $('#destination-locked-hint');
  const combo = $('#destination-combo');
  const input = $('#destination-picker-input');
  const label = $('#save-btn-label');

  const elsewhere =
    !editing &&
    existingMatch?.matched &&
    selectedDestination &&
    !destinationMatches(existingMatch, selectedDestination);

  // A match found while the user was already filling the form (or in the
  // selected tab) is surfaced here instead of hijacking the form.
  const savedHere =
    !editing &&
    existingMatch?.matched &&
    selectedDestination &&
    destinationMatches(existingMatch, selectedDestination);

  banner?.classList.toggle('hidden', !editing && !elsewhere && !savedHere);
  viewBtn?.classList.toggle('hidden', editing || !(elsewhere || savedHere));
  lockedHint?.classList.toggle('hidden', !lockDestination);
  if (combo) combo.classList.toggle('is-disabled', lockDestination);
  if (input) {
    input.disabled = lockDestination;
    input.setAttribute('aria-disabled', lockDestination ? 'true' : 'false');
  }

  if (editing && existingMatch) {
    const when = existingMatch.dateApplied
      ? ` · saved ${existingMatch.dateApplied}`
      : '';
    const status = existingMatch.status ? ` · ${existingMatch.status}` : '';
    const where = existingMatch.tabName
      ? ` in ${existingMatch.sheetName ? `${existingMatch.sheetName} → ` : ''}${existingMatch.tabName}`
      : '';
    const switchHint = multiDest
      ? ' Choose another destination below to save a copy there.'
      : '';
    $('#editing-banner-title').textContent = 'Editing saved application';
    $('#editing-banner-meta').textContent =
      `Update any field (status, notes, etc.)${status}${when}${where}.${switchHint}`;
  } else if (elsewhere || savedHere) {
    const where = existingMatch.tabName
      ? `${existingMatch.sheetName ? `${existingMatch.sheetName} → ` : ''}${existingMatch.tabName}`
      : 'another sheet';
    $('#editing-banner-title').textContent = `This job is already saved in ${where}`;
    $('#editing-banner-meta').textContent = elsewhere
      ? 'Saving here will add a separate copy to this destination.'
      : 'Open the entry to update it.';
  }

  if (label) {
    label.textContent = editing ? 'Update tracker' : 'Save to tracker';
  }

  const deleteEditingBtn = $('#delete-editing-btn');
  deleteEditingBtn?.classList.toggle('hidden', !editing);
}

// ---------------------------------------------------------------------------
// Job card & dynamic form fields
// ---------------------------------------------------------------------------

function companyInitials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 'JT';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

function avatarColor(seed) {
  const palette = ['#1e3a8a', '#0f766e', '#7c2d12', '#4c1d95', '#1d4ed8', '#334155'];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

/** Fill the header card (company, role, chips, link) from extractedData. */
function renderJobCard() {
  const company = extractedData.company || 'Unknown company';
  const role = extractedData.role || 'Job details';
  $('#job-company').textContent = company;
  $('#job-role').textContent = role;

  const avatar = $('#job-avatar');
  if (avatar) {
    avatar.textContent = companyInitials(company);
    avatar.style.background = avatarColor(company);
  }

  const chips = [];
  if (extractedData.location) chips.push(extractedData.location);
  if (extractedData.postedDate) chips.push(`Updated ${extractedData.postedDate}`);
  if (extractedData.jobId) chips.push(`ID ${extractedData.jobId}`);
  $('#job-meta').innerHTML = chips
    .map((c) => `<span class="job-chip">${escapeHtml(c)}</span>`)
    .join('');

  const link = $('#job-url');
  if (extractedData.url) {
    link.href = extractedData.url;
    try {
      link.textContent = new URL(extractedData.url).hostname.replace(/^www\./, '');
    } catch {
      link.textContent = extractedData.url;
    }
    link.classList.remove('hidden');
  } else {
    link.removeAttribute('href');
    link.textContent = '';
    link.classList.add('hidden');
  }
}

/**
 * Build the form from the destination's column mappings. Only fields that
 * need user input are shown (see getFieldsNeedingInput).
 * @param {{preferExistingInputs?: boolean}} opts true when editing a saved row:
 *   sheet values win and page extraction/today's date are not injected.
 */
function renderDynamicFields({ preferExistingInputs = false } = {}) {
  if (!selectedDestination) return;

  const container = $('#dynamic-fields');
  const mappings = selectedDestination.mappings || [];
  const fields = getFieldsNeedingInput(mappings, extractedData);

  if (fields.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = fields.map((field) => renderField(field, preferExistingInputs)).join('');

  // When editing a saved row, never overwrite sheet values with page extraction.
  if (!preferExistingInputs) {
    for (const field of fields) {
      if (field.type === 'dropdown') continue;
      const existing = userInputs[`col_${field.columnIndex}`];
      if (existing != null && existing !== '') continue;
      const suggested = field.suggestedValue;
      if (suggested != null && suggested !== '') {
        setUserInputForField(field.tag, field.columnIndex, 'text', suggested);
      }
    }
  }

  container.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('change', onFieldChange);
    el.addEventListener('input', onFieldChange);
  });

  bindComboboxes(container);
}

/** HTML for one field row (dropdown combobox, textarea, date or text input). */
function renderField(field, preferExistingInputs = false) {
  const id = `field-${field.columnIndex}-${field.tag}`;
  const lowClass = field.lowConfidence ? ' low-confidence' : '';
  const existingCol = userInputs[`col_${field.columnIndex}`];
  const existingDropdown = userInputs[`dropdown_${field.columnIndex}`];

  if (field.type === 'dropdown') {
    const options = normalizeDropdownOptions(field.options);
    const optionsEncoded = encodeURIComponent(JSON.stringify(options));
    const suggested = preferExistingInputs
      ? existingDropdown || existingCol || ''
      : existingDropdown || existingCol || field.suggestedValue || '';
    const hint = preferExistingInputs
      ? suggested
        ? '<p class="field-hint">From your sheet — edit if needed</p>'
        : ''
      : field.hint
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

  const suggestedRaw = preferExistingInputs
    ? existingCol || ''
    : existingCol ||
      field.suggestedValue ||
      getAutoValue(field.tag, extractedData) ||
      '';
  const isDateField =
    field.tag === FIELD_TAGS.DATE_APPLIED ||
    field.tag === FIELD_TAGS.CURRENT_DATE ||
    field.tag === FIELD_TAGS.JOB_POSTED_DATE;
  // When editing from the sheet, never invent today's date over a blank/unparsed cell.
  const suggested = isDateField
    ? toDateInputValue(suggestedRaw) ||
      (preferExistingInputs
        ? ''
        : field.tag === FIELD_TAGS.JOB_POSTED_DATE
          ? ''
          : formatDate())
    : suggestedRaw;
  const hint = preferExistingInputs
    ? suggested
      ? '<p class="field-hint">From your sheet — edit if needed</p>'
      : ''
    : field.autoFilled
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

  const inputType = isDateField ? 'date' : 'text';

  return `
    <div class="field-row${lowClass}">
      <label for="${id}">${escapeHtml(field.header)}</label>
      <input type="${inputType}" id="${id}" data-field data-tag="${field.tag}" data-col="${field.columnIndex}"
        data-type="text" value="${escapeHtml(suggested)}" placeholder="${escapeHtml(field.header)}" />
      ${hint}
    </div>`;
}

// ---------------------------------------------------------------------------
// Dropdown-column comboboxes
// ---------------------------------------------------------------------------

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
      saveDraft();
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
            defaultValue: normalizeDropdownDefault(
              options,
              selectedDestination.mappings?.find(
                (m) => m.columnIndex === parseInt(input.dataset.col, 10)
              )?.dropdownDefault
            ),
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
        if (!res?.success) {
          showStatus(
            res?.error || 'Could not update the dropdown options in your sheet. Your choice is still used for this save.',
            'error'
          );
        }
      } catch {
        // Keep local options so the current save still works.
        showStatus('Could not update the dropdown options in your sheet. Your choice is still used for this save.', 'error');
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

/** Read the URI-encoded JSON options stored on a combobox root element. */
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
  if (mapping) {
    mapping.dropdownOptions = [...options];
    mapping.dropdownDefault = normalizeDropdownDefault(
      options,
      mapping.dropdownDefault
    );
  }
}

// ---------------------------------------------------------------------------
// Form value bookkeeping
// ---------------------------------------------------------------------------

/** Value the extension can fill in automatically for a field tag. */
function getAutoValue(tag, data) {
  switch (tag) {
    case FIELD_TAGS.DATE_APPLIED:
    case FIELD_TAGS.CURRENT_DATE:
      return formatDate();
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
      return toDateInputValue(data.postedDate) || data.postedDate || '';
    case FIELD_TAGS.APPLICATION_STATUS:
      return data.applicationStatus || 'Applied';
    default:
      return '';
  }
}

/**
 * Record a field value in userInputs under the keys the background expects:
 * col_<n> always, plus dropdown_<n> / text_<n> / <tag> depending on type.
 * Date fields are normalised to yyyy-mm-dd; blank applied dates become today.
 */
function setUserInputForField(tag, columnIndex, type, value) {
  const col = String(columnIndex);
  let next = value == null ? '' : String(value);
  if (
    tag === FIELD_TAGS.DATE_APPLIED ||
    tag === FIELD_TAGS.CURRENT_DATE ||
    tag === FIELD_TAGS.JOB_POSTED_DATE
  ) {
    const normalized = toDateInputValue(next);
    if (normalized) next = normalized;
    else if (
      (tag === FIELD_TAGS.DATE_APPLIED || tag === FIELD_TAGS.CURRENT_DATE) &&
      !next.trim()
    ) {
      next = formatDate();
    }
  }
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
  userInteracted = true;
  const el = e.target;
  setUserInputForField(el.dataset.tag, el.dataset.col, el.dataset.type, el.value);
  saveDraft();
}

// ---------------------------------------------------------------------------
// Save / update / delete
// ---------------------------------------------------------------------------

let saving = false;

async function handleSave() {
  if (saving || deleting) return;
  if (!selectedDestination) {
    showStatus('Choose a destination sheet before saving.', 'error');
    return;
  }
  if (selectedDestination.needsAccess) {
    showStatus(
      'Job Tracker needs access to that sheet. Use Grant access above, or pick another destination.',
      'error'
    );
    return;
  }
  clearStatus();

  const btn = $('#save-btn');
  // Only treat as update when the selected destination is the matched row's sheet.
  // Otherwise append a copy — even if we still have an editingRowIndex from before.
  const editing =
    isEditingExisting() &&
    (!existingMatch?.matched ||
      destinationMatches(existingMatch, selectedDestination));
  saving = true;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = `<span class="spinner"></span>${editing ? 'Updating…' : 'Saving…'}`;

  // Everything below must use what was on screen when Save was clicked: the
  // user can switch destination or the tab can navigate while we wait.
  const dest = selectedDestination;
  const tokenAtStart = loadToken;
  const sentExtracted = extractedData;
  collectFieldValues();
  const payload = {
    type: 'SAVE_JOB',
    spreadsheetId: dest.sheetId,
    tabId: dest.gid,
    extractedData: sentExtracted,
    userInputs: { ...userInputs },
  };
  if (editing) {
    payload.existingRowIndex = Number(editingRowIndex);
    if (existingMatch?.rowFingerprint != null) {
      payload.expectedFingerprint = existingMatch.rowFingerprint;
    }
  }

  try {
    await saveDraft();

    const res = await sendMessage(payload);

    if (
      tokenAtStart !== loadToken ||
      destinationKey(selectedDestination) !== destinationKey(dest)
    ) {
      // The panel moved to another job/destination while saving; don't paint this result over it.
      if (res.success) {
        await clearDraft();
        showStatus(res.updated ? 'Updated in your tracker.' : 'Saved to your tracker.', 'success');
      } else if (res.alreadyApplied) {
        showStatus(res.error || 'That job is already in the sheet you saved to.', 'info');
      } else if (res.code !== 'ROW_CHANGED') {
        showStatus(res.error || 'Could not save to your sheet. Please try again.', 'error');
      }
      return;
    }

    if (res.alreadyApplied && res.match) {
      // Duplicate only for this destination — open that row for edit.
      existingMatch = res.match;
      enterEditMode(res.match);
      showStatus(
        res.error ||
          'Already in this sheet. Update it here, or pick another destination to add a copy.',
        'info'
      );
      return;
    }

    if (res.success) {
      await clearDraft();

      const statusCol = dest.mappings?.find((m) =>
        /application status/i.test(m.header || '')
      )?.columnIndex;
      const statusValue =
        (statusCol != null &&
          (payload.userInputs[`dropdown_${statusCol}`] ||
            payload.userInputs[`col_${statusCol}`])) ||
        '';

      if (res.updated) {
        editingRowIndex = res.rowIndex;
        existingMatch = {
          matched: true,
          role: sentExtracted.role,
          company: sentExtracted.company,
          dateApplied: existingMatch?.dateApplied || '',
          status: statusValue || existingMatch?.status || '',
          tabName: dest.tabName,
          sheetName: dest.sheetName,
          spreadsheetId: dest.sheetId,
          gid: dest.gid,
          rowIndex: res.rowIndex,
          row: res.row,
          rowFingerprint: res.rowFingerprint ?? null,
        };
        userInputs = rowToFormInputs(
          dest.mappings || [],
          res.row || []
        );
        renderEditChrome();
        renderDynamicFields({ preferExistingInputs: true });
        showStatus('Updated in your tracker.', 'success');
      } else {
        const savedRowIndex =
          res.rowIndex != null && Number.isFinite(Number(res.rowIndex))
            ? Number(res.rowIndex)
            : null;
        existingMatch = {
          matched: true,
          role: sentExtracted.role,
          company: sentExtracted.company,
          dateApplied: formatDate(),
          status: statusValue,
          tabName: dest.tabName,
          sheetName: dest.sheetName,
          spreadsheetId: dest.sheetId,
          gid: dest.gid,
          rowIndex: savedRowIndex,
          row: res.row,
          rowFingerprint: res.rowFingerprint ?? null,
        };
        editingRowIndex = null;
        renderApplied();
        showView('applied');
        showStatus('Saved to your tracker.', 'success');
      }
    } else if (res.code === 'ROW_CHANGED') {
      await reloadAfterRowChanged(res.error);
    } else {
      showStatus(res.error || 'Could not save to your sheet. Please try again.', 'error');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    saving = false;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    restoreSaveButton();
  }
}

/** The sheet row moved or changed under us: drop stale row state and re-find the job. */
async function reloadAfterRowChanged(message) {
  existingMatch = null;
  editingRowIndex = null;
  await loadData({ restoreDraft: true });
  showStatus(message || 'This row changed in Google Sheets. Reopen Job Tracker on this page to reload it.', 'error');
}

/** Reset the Save button markup after the spinner state. */
function restoreSaveButton() {
  const btn = $('#save-btn');
  if (!btn) return;
  const label = isEditingExisting() ? 'Update tracker' : 'Save to tracker';
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </svg>
    <span id="save-btn-label">${label}</span>
  `;
}

let deleting = false;

/** Delete the saved row (from the applied banner or the edit form) after confirmation. */
async function handleDeleteExisting() {
  if (deleting || saving) return;
  const editing = isEditingExisting();
  // The matched row's own sheet/tab, never the picker: the user may have
  // selected another destination, and a row index only means something in its sheet.
  const spreadsheetId =
    existingMatch?.spreadsheetId || (editing ? selectedDestination?.sheetId : undefined);
  const tabId =
    existingMatch?.gid ??
    existingMatch?.tabId ??
    (editing ? selectedDestination?.gid : undefined);
  const rawIndex = editing ? editingRowIndex : existingMatch?.rowIndex;
  const rowIndex = rawIndex == null || rawIndex === '' ? NaN : Number(rawIndex);

  if (!spreadsheetId || tabId == null || !Number.isFinite(rowIndex) || rowIndex < 0) {
    showStatus('Could not find that saved row to delete. Reopen the side panel and try again.', 'error');
    return;
  }
  if (rowIndex === 0) {
    showStatus('That is the sheet header row and cannot be deleted.', 'error');
    return;
  }

  deleting = true; // also blocks a second dialog from a double click
  const role = existingMatch?.role || extractedData.role || 'this application';
  const company = existingMatch?.company || extractedData.company || '';
  const label = company ? `${role} at ${company}` : role;
  let confirmed = false;
  try {
    confirmed = await confirmDialog({
      title: 'Delete this application?',
      message: `Removes “${label}” from your Google Sheet. This cannot be undone here; try the sheet’s version history.`,
      confirmLabel: 'Delete row',
      danger: true,
    });
  } finally {
    if (!confirmed) deleting = false;
  }
  if (!confirmed) return;

  const appliedBtn = $('#delete-existing-btn');
  const editingBtn = $('#delete-editing-btn');
  const buttons = [appliedBtn, editingBtn].filter(Boolean);
  buttons.forEach((btn) => {
    btn.disabled = true;
  });
  if (appliedBtn) appliedBtn.textContent = 'Deleting…';
  if (editingBtn) editingBtn.textContent = 'Deleting…';

  try {
    const res = await sendMessage({
      type: 'DELETE_JOB',
      spreadsheetId,
      tabId,
      rowIndex,
      expectedFingerprint: existingMatch?.rowFingerprint ?? undefined,
    });

    if (res?.code === 'ROW_CHANGED') {
      await reloadAfterRowChanged(res.error);
      return;
    }
    if (!res?.success) {
      showStatus(res?.error || 'Could not delete that application.', 'error');
      return;
    }

    existingMatch = null;
    editingRowIndex = null;
    userInputs = {};
    await clearDraft();

    await loadData({ restoreDraft: false });
    showStatus('Removed from your tracker.', 'success');
  } catch (err) {
    showStatus(err.message || 'Could not delete that application.', 'error');
  } finally {
    deleting = false;
    if (appliedBtn) {
      appliedBtn.disabled = false;
      appliedBtn.textContent = 'Delete from tracker';
    }
    if (editingBtn) {
      editingBtn.disabled = false;
      editingBtn.textContent = 'Delete from tracker';
    }
  }
}

/** Sync every rendered field into userInputs (called before save/draft). */
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Show a message in the aria-live status bar ('success' | 'error' | 'info'). */
function showStatus(msg, type) {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status status-${type}`;
  // Errors interrupt screen readers; success/info are announced politely.
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.classList.remove('hidden');
}

function clearStatus() {
  const el = $('#status');
  el.textContent = '';
  el.classList.add('hidden');
}

/**
 * Promise wrapper for chrome.runtime.sendMessage. Never rejects: a missing
 * response (service worker error, extension reloaded) resolves to
 * { success: false, error } so callers can always read res.success / res.error.
 */
function sendMessage(msg) {
  return new Promise((resolve) => {
    const fail = (error) =>
      resolve({
        success: false,
        error: error || 'No response from the extension. Reload the side panel and try again.',
      });
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError || res == null) {
          fail(chrome.runtime.lastError?.message);
          return;
        }
        resolve(res);
      });
    } catch (err) {
      // e.g. "Extension context invalidated" after the extension was reloaded.
      fail(err?.message);
    }
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getPageJobData(tab) {
  if (!tab?.id) return { url: tab?.url || '', confidence: {}, sources: {} };
  const res = await sendMessage({
    type: 'GET_TAB_JOB_DATA',
    tabId: tab.id,
    url: tab.url || '',
  });
  return res?.data || { url: tab.url || '', confidence: {}, sources: {} };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init().catch((err) => {
  // e.g. extension reloaded under an open panel: never leave the spinner up.
  const text = $('#error-view-text');
  if (text) text.textContent = err?.message || 'Could not start Job Tracker. Reload the side panel.';
  showView('error');
});
