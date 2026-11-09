/**
 * Sheets add/save/find/schema orchestration for the service worker.
 * Calls lib/* for HTTP and domain rules; uses withSheetAccess for tokens.
 *
 * Every exported function is the handler for one message type (see
 * service-worker.js) and resolves to `{ success, ... }`; errors surface as
 * `{ success: false, error }` (or a thrown friendly Error the router converts).
 *
 * State: `configuredSheets` in chrome.storage.local is the local copy of each
 * connected spreadsheet's tabs/mappings. Handlers do network calls between
 * read and write, so writers that only change one tab re-read the latest
 * storage right before saving to avoid clobbering concurrent edits.
 */

import {
  loadSpreadsheetTabs,
  loadTabRows,
  loadRow,
  saveJobToTab,
  updateJobInTab,
  deleteJobRowInTab,
  fetchSpreadsheetMetadata,
  createSpreadsheet,
  syncTabHeaders,
  seedTabHeaders,
  deleteColumn,
  moveColumn,
  insertColumn,
  getSheetColumnCount,
  renameSheetTab,
  rowIndexFromUpdatedRange,
} from '../lib/sheets-api.js';
import { parseGoogleSheetUrl, buildSheetUrl } from '../lib/sheet-url.js';
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
import { findExistingApplication, rowFingerprint } from '../lib/duplicates.js';
import {
  getConfiguredSheets,
  saveConfiguredSheets,
  getSettings,
  getUndoStack,
  saveUndoStack,
  getRedoStack,
  saveRedoStack,
} from '../lib/storage.js';
import {
  applySchemaChange,
  snapshotTabSchema,
  restoreTabSchema,
  createUndoEntry,
  pushUndo,
  popUndo,
  pushRedo,
  popRedo,
  describeChange,
  planHistoryStep,
  isDestructiveOp,
  DESTRUCTIVE_WARNING,
  SCHEMA_OPS,
} from '../lib/schema-editor.js';
import { sheetsAccessError } from '../lib/google-auth.js';
import { withSheetAccess, isPickerAvailable } from './google-session.js';

/**
 * Build local tab configs from live sheet rows. Empty tabs get default headers
 * written to Google Sheets immediately, then marked isNew: false.
 */
async function materializeTabs(spreadsheetId, rawTabs, existingTabs, token) {
  const tabs = [];
  for (const t of rawTabs) {
    const config = prepareTabConfig(
      t.tabName,
      spreadsheetId,
      t.gid,
      t.rows
    );
    // A header-only tab whose header already IS the current default layout
    // (e.g. a fresh tracker with no jobs yet) needs no rewrite. Treating it as
    // "seeded" would also throw away the user's local column choices (tags,
    // dropdown options, ignored columns) on every refresh until the first save.
    const alreadyDefault =
      config.isNew &&
      t.rows.length === 1 &&
      config.headers.length === t.rows[0].length &&
      config.headers.every(
        (h, i) =>
          String(h).trim().toLowerCase() === String(t.rows[0][i] ?? '').trim().toLowerCase()
      );
    const seeded = config.isNew && !alreadyDefault;
    if (seeded) {
      await seedTabHeaders(spreadsheetId, t.tabName, config.headers, token, {
        sheetId: t.sheetId ?? t.gid,
      });
    }

    const existingTab = existingTabs?.find((et) => et.gid === t.gid);
    // Fresh default seeds must not inherit stale local mappings (e.g. old URL col).
    const baseMappings =
      seeded || !existingTab
        ? config.mappings
        : mergeTabMappings(existingTab.mappings, config.mappings);

    tabs.push({
      tabName: config.tabName,
      gid: config.gid,
      tabId: config.gid,
      sheetId: t.sheetId ?? t.gid,
      isNew: false,
      headers: config.headers,
      mappings: enrichMappingsWithDropdownOptions(
        baseMappings,
        seeded ? [] : t.rows
      ),
      columnUniques: buildColumnUniques(seeded ? [] : t.rows),
      // Seeding writes a header row that may not be in the pre-write snapshot.
      rowCount: seeded ? 1 : t.rows.length,
    });
  }
  return tabs;
}

/** True when a Sheets API failure means "this app has no access to that file yet". */
export function isAccessDeniedError(err) {
  return err?.status === 403 || err?.status === 404;
}

/**
 * Read a spreadsheet's tabs (seeding empty ones), build its config entry and
 * upsert it into configuredSheets. Shared by add-by-URL, create and picker.
 * Throws on API errors (with `.status`).
 */
async function connectSpreadsheet(spreadsheetId, url, token, { meta: knownMeta } = {}) {
  const meta = knownMeta || (await fetchSpreadsheetMetadata(spreadsheetId, token));
  const rawTabs = await loadSpreadsheetTabs(spreadsheetId, token);
  const spreadsheetTitle = meta.properties?.title || `Sheet ${spreadsheetId.slice(0, 8)}…`;

  const existing = (await getConfiguredSheets()).find((s) => s.spreadsheetId === spreadsheetId);
  const tabs = await materializeTabs(spreadsheetId, rawTabs, existing?.tabs, token);

  const sheetEntry = {
    spreadsheetId,
    url,
    name: spreadsheetTitle,
    tabs,
    // Strictly increasing per sheet: refreshAllSheets uses it to spot a reconnect.
    addedAt: Math.max(Date.now(), (existing?.addedAt || 0) + 1),
  };

  // Re-read: materializeTabs hits the network, so storage may have changed.
  const next = [...(await getConfiguredSheets())];
  const existingIndex = next.findIndex((s) => s.spreadsheetId === spreadsheetId);
  if (existingIndex >= 0) {
    next[existingIndex] = sheetEntry;
  } else {
    next.push(sheetEntry);
  }

  await saveConfiguredSheets(next);
  return { sheet: sheetEntry, sheets: next };
}

export const NO_ACCESS_NEEDS_PICKER =
  'Job Tracker could not open this spreadsheet. If the link is right, choose the spreadsheet with Google to give Job Tracker access.';
export const NO_ACCESS_NO_PICKER =
  'Job Tracker could not open this spreadsheet. Check the link is correct. It can only open spreadsheets it created. Use Create tracker sheet, or copy your data into a tracker sheet created by Job Tracker.';

/** Connect a spreadsheet by URL: reads all tabs, seeds empty ones, stores config. */
export async function addSheet(url) {
  const parsed = parseGoogleSheetUrl(url);
  if (!parsed.valid) {
    return { success: false, error: parsed.error };
  }

  try {
    return await withSheetAccess(async (token) => {
      let meta;
      try {
        meta = await fetchSpreadsheetMetadata(parsed.spreadsheetId, token);
      } catch (err) {
        // Under drive.file, 403/404 means the user hasn't granted this file yet.
        if (isAccessDeniedError(err)) {
          if (await isPickerAvailable()) {
            return {
              success: false,
              needsPicker: true,
              spreadsheetId: parsed.spreadsheetId,
              error: NO_ACCESS_NEEDS_PICKER,
            };
          }
          return { success: false, error: NO_ACCESS_NO_PICKER };
        }
        throw err;
      }
      const result = await connectSpreadsheet(parsed.spreadsheetId, parsed.url, token, { meta });
      return { success: true, ...result };
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Create a new tracker spreadsheet owned by the user and connect it. */
export async function createTrackerSheet(title) {
  try {
    return await withSheetAccess(async (token) => {
      const created = await createSpreadsheet(token, { title: title || undefined });
      const url = created.spreadsheetUrl || buildSheetUrl(created.spreadsheetId);
      const result = await connectSpreadsheet(created.spreadsheetId, url, token);
      return { success: true, ...result, spreadsheetUrl: url };
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Connect spreadsheets chosen in the website Picker. Already-connected sheets
 * are skipped unless they were flagged needsAccess (then they are re-granted). Resolves to { success, added, error? }; success is false if any
 * file could not be opened.
 */
export async function addPickedSheets(files) {
  // Outside the callback: withSheetAccess may re-run it after a 401, and sheets
  // connected by the first attempt must still be counted.
  let added = 0;
  try {
    return await withSheetAccess(async (token) => {
      const configured = await getConfiguredSheets();
      const have = new Set(configured.map((s) => s.spreadsheetId));
      // A re-picked sheet that was flagged needsAccess is reconnected (which clears the flag).
      const needsAccess = new Set(
        configured.filter((s) => s.needsAccess).map((s) => s.spreadsheetId)
      );
      const failed = [];
      for (const file of files) {
        if (have.has(file.id) && !needsAccess.has(file.id)) continue;
        try {
          await connectSpreadsheet(file.id, buildSheetUrl(file.id), token);
          have.add(file.id);
          added += 1;
        } catch (err) {
          if (isAccessDeniedError(err)) {
            failed.push(file.name || file.id);
            continue;
          }
          // 401 must reach withSheetAccess so it can refresh the token and retry.
          if (err?.status === 401 || added === 0) throw err;
          // Offline/5xx after some sheets were already saved: report the partial
          // result so the UI still refreshes instead of claiming nothing was added.
          return {
            success: false,
            added,
            error: sheetsAccessError(err?.message),
          };
        }
      }
      if (failed.length) {
        return {
          success: false,
          added,
          error: `Could not open: ${failed.join(', ')}. Make sure you selected it in the Google window.`,
        };
      }
      return { success: true, added };
    });
  } catch (err) {
    return { success: false, added, error: err.message };
  }
}

/** Disconnect a spreadsheet locally (the Google Sheet itself is untouched). */
export async function removeSheet(spreadsheetId) {
  const sheets = (await getConfiguredSheets()).filter(
    (s) => s.spreadsheetId !== spreadsheetId
  );
  await saveConfiguredSheets(sheets);
  return { success: true, sheets };
}

/**
 * Rename a worksheet tab in Google Sheets and persist the new title locally.
 */
export async function renameTab({ spreadsheetId, tabId, title }) {
  const nextTitle = String(title || '').trim();
  if (!nextTitle) {
    return { success: false, error: 'Tab name cannot be empty.' };
  }

  try {
    return await withSheetAccess(async (token) => {
      const sheets = await getConfiguredSheets();
      const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
      if (!sheet) {
        return { success: false, error: 'Spreadsheet not found.' };
      }

      const tab = (sheet.tabs || []).find(
        (t) => String(t.gid) === String(tabId) || String(t.tabId) === String(tabId)
      );
      if (!tab) {
        return { success: false, error: 'Sheet tab not found.' };
      }

      const duplicate = (sheet.tabs || []).some(
        (t) =>
          String(t.gid) !== String(tab.gid) &&
          String(t.tabName || '').toLowerCase() === nextTitle.toLowerCase()
      );
      if (duplicate) {
        return { success: false, error: 'Another tab already uses that name.' };
      }

      if (tab.tabName === nextTitle) {
        return { success: true, sheets, tab };
      }

      const sheetIdForApi = tab.sheetId ?? tab.gid;
      await renameSheetTab(spreadsheetId, sheetIdForApi, nextTitle, token);

      // Re-read before write so an in-flight sync cannot drop this rename.
      const latest = await getConfiguredSheets();
      const latestSheet = latest.find((s) => s.spreadsheetId === spreadsheetId);
      const latestTab = (latestSheet?.tabs || []).find(
        (t) => String(t.gid) === String(tab.gid) || String(t.tabId) === String(tab.gid)
      );
      if (!latestSheet || !latestTab) {
        return { success: false, error: 'Sheet tab not found after rename.' };
      }

      latestTab.tabName = nextTitle;
      await saveConfiguredSheets(latest);
      return { success: true, sheets: latest, tab: latestTab };
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Re-read every connected spreadsheet (titles, tabs, dropdown values) from Google. */
export async function refreshAllSheets() {
  return withSheetAccess(async (token) => {
    const sheets = await getConfiguredSheets();
    const updated = [];

    for (const sheet of sheets) {
      let meta;
      let rawTabs;
      try {
        meta = await fetchSpreadsheetMetadata(sheet.spreadsheetId, token);
        rawTabs = await loadSpreadsheetTabs(sheet.spreadsheetId, token);
      } catch (err) {
        // drive.file: sheets connected under the old broad scope may no longer
        // be accessible. Keep the config, flag it, and refresh the rest.
        if (isAccessDeniedError(err)) {
          updated.push({ ...sheet, needsAccess: true });
          continue;
        }
        throw err;
      }
      const tabs = await materializeTabs(
        sheet.spreadsheetId,
        rawTabs,
        sheet.tabs,
        token
      );
      updated.push({
        ...sheet,
        name:
          meta.properties?.title ||
          sheet.name ||
          `Sheet ${sheet.spreadsheetId.slice(0, 8)}…`,
        tabs,
        needsAccess: false,
      });
    }

    // The loop above made many network calls. Merge into the latest stored
    // list so a sheet added, removed or renamed meanwhile is not undone.
    // A sheet reconnected meanwhile (e.g. re-granted via the Picker, which
    // stamps a new addedAt) is newer than this refresh's read: keep it.
    const startedWith = new Map(sheets.map((s) => [s.spreadsheetId, s.addedAt]));
    const byId = new Map(updated.map((s) => [s.spreadsheetId, s]));
    // Schema edits (headers/mappings) made while we were reading win over the
    // refreshed copy of the same tab, which was derived from the older config.
    const schemaOf = (t) => JSON.stringify([t.headers, t.mappings, t.isNew]);
    const startSchemas = new Map(
      sheets.flatMap((sh) =>
        (sh.tabs || []).map((t) => [`${sh.spreadsheetId}:${t.gid}`, schemaOf(t)])
      )
    );
    const merged = (await getConfiguredSheets()).map((s) => {
      if (startedWith.get(s.spreadsheetId) !== s.addedAt) return s;
      const fresh = byId.get(s.spreadsheetId);
      if (!fresh) return s;
      const tabs = (fresh.tabs || []).map((t) => {
        const key = `${s.spreadsheetId}:${t.gid}`;
        const cur = (s.tabs || []).find((c) => String(c.gid) === String(t.gid));
        if (cur && startSchemas.has(key) && schemaOf(cur) !== startSchemas.get(key)) {
          return { ...t, headers: cur.headers, mappings: cur.mappings, isNew: cur.isNew };
        }
        return t;
      });
      return { ...fresh, tabs };
    });
    await saveConfiguredSheets(merged);
    return { success: true, sheets: merged };
  });
}

/**
 * Persist one tab's schema (headers, mappings, isNew and any refreshed column
 * caches) into the LATEST stored sheets. The schema handlers make network calls
 * between reading and writing, so saving their original snapshot would undo a
 * concurrent refresh, rename or save. Resolves to the latest sheets list.
 */
async function commitTabSchema(spreadsheetId, srcTab) {
  const latest = await getConfiguredSheets();
  const dest = latest
    .find((s) => s.spreadsheetId === spreadsheetId)
    ?.tabs?.find((t) => String(t.gid) === String(srcTab.gid));
  if (dest) {
    dest.headers = srcTab.headers;
    dest.mappings = srcTab.mappings;
    dest.isNew = srcTab.isNew;
    if (srcTab.columnUniques) dest.columnUniques = srcTab.columnUniques;
    if (srcTab.rowCount != null) dest.rowCount = srcTab.rowCount;
    await saveConfiguredSheets(latest);
  }
  return latest;
}

/**
 * Perform a real column operation in Google Sheets (delete / move / insert)
 * or a header rewrite. Callers run this BEFORE changing local config so a
 * failure leaves nothing half-applied.
 * `plan` is { kind, columnIndex?, fromIndex?, toIndex? }; `headers` are the
 * headers the tab should have afterwards (used for 'insert' and 'headers').
 */
async function runSheetPlan(spreadsheetId, tab, plan, headers, token) {
  const sheetId = tab.sheetId ?? tab.gid;
  switch (plan.kind) {
    case 'delete': {
      const width = await getSheetColumnCount(spreadsheetId, sheetId, token);
      if (plan.columnIndex >= width) return; // column never existed in the grid
      if (width <= 1) {
        throw new Error('Google Sheets needs at least one column in a tab.');
      }
      await deleteColumn(spreadsheetId, sheetId, plan.columnIndex, token);
      return;
    }
    case 'move': {
      const width = await getSheetColumnCount(spreadsheetId, sheetId, token);
      if (Math.max(plan.fromIndex, plan.toIndex) >= width) {
        throw new Error('That column is outside the sheet’s current width.');
      }
      await moveColumn(spreadsheetId, sheetId, plan.fromIndex, plan.toIndex, token);
      return;
    }
    case 'insert':
      await insertColumn(spreadsheetId, sheetId, plan.columnIndex, token);
      await syncTabHeaders(spreadsheetId, tab.tabName, headers, token);
      return;
    case 'headers':
      await syncTabHeaders(spreadsheetId, tab.tabName, headers, token);
      return;
  }
}

/**
 * Apply one column edit (rename/add/delete/move/tag/dropdown) to a tab, write
 * headers to Google when the change is structural, and record an undo entry.
 * Destructive ops require `confirmed: true` (otherwise `needsConfirmation`).
 */
export function applySchemaChangeMessage(message) {
  return serializeByKey(SCHEMA_QUEUE_KEY, () => applySchemaChangeMessageNow(message));
}

async function applySchemaChangeMessageNow(message) {
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
  let result;
  try {
    result = applySchemaChange(tab.headers || [], tab.mappings || [], change);
  } catch (err) {
    return { success: false, error: err.message };
  }

  // Touch Google Sheets first; if it fails, nothing local has changed.
  let plan = { kind: 'none' };
  if (change.op === SCHEMA_OPS.DELETE) {
    plan = { kind: 'delete', columnIndex: change.columnIndex };
  } else if (change.op === SCHEMA_OPS.MOVE) {
    plan = { kind: 'move', fromIndex: change.fromIndex, toIndex: change.toIndex };
  } else if (result.syncHeaders) {
    plan = { kind: 'headers' };
  }
  const touchesSheet = plan.kind !== 'none' && !skipSync && !tab.isNew;
  if (touchesSheet) {
    try {
      await withSheetAccess((token) =>
        runSheetPlan(spreadsheetId, tab, plan, result.headers, token)
      );
    } catch (err) {
      return {
        success: false,
        error: `Google Sheets did not accept the change, so nothing was changed. ${err.message}`,
      };
    }
  }

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

  const after = snapshotTabSchema(tab);
  const entry = createUndoEntry({
    spreadsheetId,
    tabId: tab.gid,
    tabName: tab.tabName,
    before,
    after,
    change,
    label: describeChange(
      change.op === SCHEMA_OPS.DELETE
        ? { ...change, header: before.headers[change.columnIndex] }
        : change
    ),
  });

  const stack = pushUndo(await getUndoStack(), entry);
  await saveUndoStack(stack);
  // New edits invalidate redo history.
  await saveRedoStack([]);
  const latestSheets = await commitTabSchema(spreadsheetId, tab);

  return {
    success: true,
    sheets: latestSheets,
    undoEntry: entry,
    stack,
    redoStack: [],
    syncedHeaders: touchesSheet,
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

/** Refresh a tab's cached unique column values (dropdown suggestions) from the sheet. */
export async function syncTabColumnUniques(message) {
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

    // Merge into the latest stored sheets so concurrent renames aren't clobbered.
    const latest = await getConfiguredSheets();
    const latestSheet = latest.find((s) => s.spreadsheetId === spreadsheetId);
    const latestTab = latestSheet?.tabs?.find(
      (t) => t.tabId === tabId || t.gid === tabId
    );
    if (!latestTab) {
      return { success: false, error: 'Tab not found' };
    }

    latestTab.columnUniques = tab.columnUniques;
    latestTab.mappings = tab.mappings;
    // Keep latestTab.tabName / headers from storage (rename-safe).
    await saveConfiguredSheets(latest);

    const fromSheet =
      columnIndex == null
        ? latestTab.columnUniques || []
        : latestTab.columnUniques?.[columnIndex] || [];
    return {
      success: true,
      sheets: latest,
      fromSheet,
      columnUniques: latestTab.columnUniques,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Revert a schema change (latest, or a specific entry id) and move it to the redo stack. */
export function undoSchemaChange(entryId) {
  return serializeByKey(SCHEMA_QUEUE_KEY, () => undoSchemaChangeNow(entryId));
}

async function undoSchemaChangeNow(entryId) {
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

  const target = structuredClone(tab);
  restoreTabSchema(target, entry.before);
  const plan = planHistoryStep(entry, 'undo');
  if (plan.kind !== 'none' && !tab.isNew) {
    try {
      await withSheetAccess((token) =>
        runSheetPlan(entry.spreadsheetId, target, plan, target.headers, token)
      );
    } catch (err) {
      // Nothing was saved yet: the entry stays on its stack, config is unchanged.
      return {
        success: false,
        error: `Google Sheets did not accept the change, so nothing was changed. ${err.message}`,
      };
    }
  }
  restoreTabSchema(tab, entry.before);

  const redoStack = pushRedo(await getRedoStack(), entry);
  await saveUndoStack(nextStack);
  await saveRedoStack(redoStack);
  const latestSheets = await commitTabSchema(entry.spreadsheetId, tab);

  return {
    success: true,
    sheets: latestSheets,
    stack: nextStack,
    redoStack,
    restored: entry,
    note: plan.kind === 'insert' ? 'The column is back but empty; its old data cannot be restored.' : '',
  };
}

/** Re-apply a previously undone schema change. */
export function redoSchemaChange(entryId) {
  return serializeByKey(SCHEMA_QUEUE_KEY, () => redoSchemaChangeNow(entryId));
}

async function redoSchemaChangeNow(entryId) {
  const stack = await getRedoStack();
  let entry = null;
  let nextRedo = stack;

  if (entryId) {
    const idx = stack.findIndex((e) => e.id === entryId);
    if (idx < 0) return { success: false, error: 'Nothing to redo.' };
    entry = stack[idx];
    nextRedo = [...stack.slice(0, idx), ...stack.slice(idx + 1)];
  } else {
    const popped = popRedo(stack);
    entry = popped.entry;
    nextRedo = popped.stack;
  }

  if (!entry) return { success: false, error: 'Nothing to redo.' };

  const sheets = await getConfiguredSheets();
  const sheet = sheets.find((s) => s.spreadsheetId === entry.spreadsheetId);
  if (!sheet) {
    await saveRedoStack(nextRedo);
    return { success: false, error: 'Sheet no longer connected.' };
  }

  const tab = sheet.tabs.find(
    (t) => t.tabId === entry.tabId || t.gid === entry.tabId
  );
  if (!tab) {
    await saveRedoStack(nextRedo);
    return { success: false, error: 'Tab no longer available.' };
  }

  const target = structuredClone(tab);
  restoreTabSchema(target, entry.after);
  const plan = planHistoryStep(entry, 'redo');
  if (plan.kind !== 'none' && !tab.isNew) {
    try {
      await withSheetAccess((token) =>
        runSheetPlan(entry.spreadsheetId, target, plan, target.headers, token)
      );
    } catch (err) {
      // Nothing was saved yet: the entry stays on its stack, config is unchanged.
      return {
        success: false,
        error: `Google Sheets did not accept the change, so nothing was changed. ${err.message}`,
      };
    }
  }
  restoreTabSchema(tab, entry.after);

  const undoStack = pushUndo(await getUndoStack(), entry);
  await saveUndoStack(undoStack);
  await saveRedoStack(nextRedo);
  const latestSheets = await commitTabSchema(entry.spreadsheetId, tab);

  return {
    success: true,
    sheets: latestSheets,
    stack: undoStack,
    redoStack: nextRedo,
    restored: entry,
    note: plan.kind === 'delete' ? 'The column and its data were deleted again.' : '',
  };
}

/**
 * Yield every tab of every connected sheet with raw rows, one tab at a time,
 * so callers can stop at the first hit. Unreadable sheets/tabs are skipped so
 * one bad sheet doesn't block the check. `preferred` is a list of
 * `${spreadsheetId}:${gid}` keys: those sheets, and those tabs within a
 * sheet, are visited first.
 */
async function* iterateTabsWithRows(token, sheets, preferred = []) {
  const prefKeys = (preferred || []).map(String);
  const prefSheets = new Set(prefKeys.map((k) => k.split(':')[0]));
  const ordered = [
    ...sheets.filter((s) => prefSheets.has(String(s.spreadsheetId))),
    ...sheets.filter((s) => !prefSheets.has(String(s.spreadsheetId))),
  ];
  for (const sheet of ordered) {
    let metaSheets = [];
    try {
      const meta = await fetchSpreadsheetMetadata(sheet.spreadsheetId, token);
      metaSheets = meta.sheets ?? [];
    } catch (err) {
      // An expired token must reach withSheetAccess so it can refresh and retry.
      if (err?.status === 401) throw err;
      continue;
    }
    const isPreferred = (entry) =>
      prefKeys.includes(`${sheet.spreadsheetId}:${entry.properties.sheetId}`);
    metaSheets = [
      ...metaSheets.filter(isPreferred),
      ...metaSheets.filter((e) => !isPreferred(e)),
    ];
    for (const entry of metaSheets) {
      const props = entry.properties;
      const tabName = props.title;
      const gid = String(props.sheetId);
      const configTab = sheet.tabs?.find((t) => String(t.gid) === gid);
      let rows = [];
      try {
        // FORMULA keeps Role HYPERLINK cells as formulas so we can read the URL.
        rows = await loadTabRows(sheet.spreadsheetId, tabName, token, {
          valueRenderOption: 'FORMULA',
        });
      } catch (err) {
        if (err?.status === 401) throw err;
        rows = [];
      }
      yield {
        sheetName: sheet.name,
        tabName,
        spreadsheetId: sheet.spreadsheetId,
        gid,
        mappings: configTab?.mappings,
        rows,
      };
    }
  }
}

/**
 * Look for an existing row for this job across all connected sheets.
 * Stops at the first match. The match names the destination it was found in
 * (spreadsheetId / gid / sheetName / tabName). `preferredDestinations`
 * (`${spreadsheetId}:${gid}` keys, e.g. the selected and default sheet) are
 * searched first so the common case returns without reading every tab.
 */
export async function findApplication(extractedData = {}, preferredDestinations = []) {
  const sheets = await getConfiguredSheets();
  if (!sheets.length) return { success: true, matched: false };

  try {
    return await withSheetAccess(async (token) => {
      for await (const tab of iterateTabsWithRows(
        token,
        sheets,
        Array.isArray(preferredDestinations) ? preferredDestinations : []
      )) {
        const hit = findExistingApplication([tab], extractedData);
        if (hit.matched) return { success: true, ...hit };
      }
      return { success: true, matched: false };
    });
  } catch (err) {
    return { success: false, matched: false, error: err.message };
  }
}

const ROW_CHANGED_ERROR =
  'This row changed in Google Sheets. Reopen Job Tracker on this page to reload it.';

/** Fingerprint of the row as currently stored (read errors propagate). */
async function readRowFingerprint(spreadsheetId, tabName, rowIndex, token) {
  const row = await loadRow(spreadsheetId, tabName, rowIndex, token);
  return rowFingerprint(row);
}

/**
 * Same, but best effort: used after a write succeeded, where a failed read
 * must not turn a saved row into a reported failure (the user would retry and
 * add a duplicate). null just disables the changed-row check for that row.
 */
async function tryReadRowFingerprint(spreadsheetId, tabName, rowIndex, token) {
  try {
    return await readRowFingerprint(spreadsheetId, tabName, rowIndex, token);
  } catch {
    return null;
  }
}

/**
 * Append (or update, when `existingRowIndex` is given) a job row in one tab.
 * Refuses to add a duplicate to the same tab unless updating.
 */
export function saveJob(message) {
  // Serialize per tab: a double-click or two panels saving the same job must
  // not both pass the duplicate check and then both append.
  return serializeByKey(`${message?.spreadsheetId}:${message?.tabId}`, () => saveJobNow(message));
}

/** All schema edits/undo/redo share one queue: each is read-modify-write on the same tab config. */
const SCHEMA_QUEUE_KEY = 'schema-edits';

/** Run `task` after every earlier task with the same key has settled. */
const keyQueues = new Map();
function serializeByKey(key, task) {
  const prev = keyQueues.get(key) || Promise.resolve();
  const run = prev.then(task);
  const tail = run.catch(() => {});
  keyQueues.set(key, tail);
  tail.then(() => {
    if (keyQueues.get(key) === tail) keyQueues.delete(key);
  });
  return run;
}

async function saveJobNow(message) {
  const {
    spreadsheetId,
    tabId,
    extractedData,
    userInputs,
    existingRowIndex = null,
    expectedFingerprint = null,
  } = message;

  return withSheetAccess(async (token) => {
    const sheets = await getConfiguredSheets();
    const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
    if (!sheet) return { success: false, error: 'Sheet not found' };

    const tab = sheet.tabs.find((t) => t.tabId === tabId || t.gid === tabId);
    if (!tab) return { success: false, error: 'Tab not found' };

    const updating =
      existingRowIndex != null &&
      Number.isFinite(Number(existingRowIndex)) &&
      Number(existingRowIndex) >= 0;

    const settings = await getSettings();

    // Only the chosen tab — never block because the job exists elsewhere.
    const rows = await loadTabRows(spreadsheetId, tab.tabName, token, {
      valueRenderOption: 'FORMULA',
    });

    if (!updating) {
      const existing = findExistingApplication(
        [
          {
            sheetName: sheet.name,
            tabName: tab.tabName,
            spreadsheetId,
            gid: String(tab.gid),
            mappings: tab.mappings,
            rows,
          },
        ],
        extractedData
      );
      if (existing.matched) {
        return {
          success: false,
          alreadyApplied: true,
          error:
            'Already in this sheet — update it here, or pick another destination to add a copy.',
          match: existing,
        };
      }
    }

    const tabConfig = {
      isNew: tab.isNew,
      headers: tab.headers,
      mappings: tab.mappings,
      sheetId: tab.sheetId ?? tab.gid,
      gid: tab.gid,
    };

    const row = buildRowFromMappings(tab.mappings, rows, extractedData, {
      ...userInputs,
      embedRoleHyperlink: settings.embedRoleHyperlink !== false,
    });

    if (updating) {
      const rowIndex = Number(existingRowIndex);
      if (rowIndex === 0) {
        // Row 0 is always the header row: never overwrite it.
        return { success: false, error: 'Cannot update the header row.' };
      }
      if (expectedFingerprint != null) {
        // `rows` was just read with FORMULA, same as the fingerprint source.
        if (rowFingerprint(rows[rowIndex]) !== expectedFingerprint) {
          return { success: false, code: 'ROW_CHANGED', error: ROW_CHANGED_ERROR };
        }
      }
      await updateJobInTab(spreadsheetId, tab.tabName, rowIndex, row, token);
      const newFingerprint = await tryReadRowFingerprint(
        spreadsheetId,
        tab.tabName,
        rowIndex,
        token
      );
      return {
        success: true,
        updated: true,
        row,
        rowIndex,
        rowFingerprint: newFingerprint,
        spreadsheetId,
        tabId: tab.gid,
        tabName: tab.tabName,
        sheetName: sheet.name,
      };
    }

    const appendRes = await saveJobToTab(
      spreadsheetId,
      tab.tabName,
      tabConfig,
      row,
      token
    );

    // Re-read before writing: the append above was a network round trip, and
    // saving the stale `sheets` snapshot could undo a concurrent rename/edit.
    const latest = await getConfiguredSheets();
    const latestTab = latest
      .find((s) => s.spreadsheetId === spreadsheetId)
      ?.tabs?.find((t) => t.tabId === tabId || t.gid === tabId);
    if (latestTab) {
      latestTab.isNew = false;
      latestTab.rowCount = (latestTab.rowCount || 0) + 1;
      await saveConfiguredSheets(latest);
    }

    const rowIndex = rowIndexFromUpdatedRange(appendRes?.updates?.updatedRange);
    const newFingerprint =
      rowIndex != null
        ? await tryReadRowFingerprint(spreadsheetId, tab.tabName, rowIndex, token)
        : null;

    return {
      success: true,
      row,
      rowIndex,
      rowFingerprint: newFingerprint,
      spreadsheetId,
      tabId: tab.gid,
      tabName: tab.tabName,
      sheetName: sheet.name,
    };
  });
}

/**
 * Delete an existing application row from a connected sheet tab.
 */
export async function deleteJob(message) {
  const { spreadsheetId, tabId, rowIndex, expectedFingerprint = null } = message;
  const index = Number(rowIndex);

  if (!spreadsheetId || tabId == null) {
    return { success: false, error: 'Missing sheet or tab.' };
  }
  if (!Number.isFinite(index) || index < 0) {
    return { success: false, error: 'Invalid row to delete.' };
  }
  if (index === 0) {
    return { success: false, error: 'Cannot delete the header row.' };
  }

  try {
    return await withSheetAccess(async (token) => {
      const sheets = await getConfiguredSheets();
      const sheet = sheets.find((s) => s.spreadsheetId === spreadsheetId);
      if (!sheet) return { success: false, error: 'Sheet not found' };

      const tab = (sheet.tabs || []).find(
        (t) => String(t.gid) === String(tabId) || String(t.tabId) === String(tabId)
      );
      if (!tab) return { success: false, error: 'Tab not found' };

      if (expectedFingerprint != null) {
        const current = await readRowFingerprint(
          spreadsheetId,
          tab.tabName,
          index,
          token
        );
        if (current !== expectedFingerprint) {
          return { success: false, code: 'ROW_CHANGED', error: ROW_CHANGED_ERROR };
        }
      }

      const sheetIdForApi = tab.sheetId ?? tab.gid;
      await deleteJobRowInTab(spreadsheetId, sheetIdForApi, index, token);

      // Re-read so we don't overwrite changes made while the delete was in flight.
      const latest = await getConfiguredSheets();
      const latestTab = latest
        .find((s) => s.spreadsheetId === spreadsheetId)
        ?.tabs?.find((t) => String(t.gid) === String(tab.gid));
      if (latestTab && Number(latestTab.rowCount) > 0) {
        latestTab.rowCount = Number(latestTab.rowCount) - 1;
        await saveConfiguredSheets(latest);
      }

      return {
        success: true,
        deleted: true,
        spreadsheetId,
        tabId: tab.gid,
        rowIndex: index,
      };
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}
