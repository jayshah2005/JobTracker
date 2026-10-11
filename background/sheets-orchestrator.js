/**
 * Sheets add/save/find/schema orchestration for the service worker.
 * Calls lib/* for HTTP and domain rules; uses withSheetAccess for tokens.
 */

import {
  loadSpreadsheetTabs,
  loadTabRows,
  saveJobToTab,
  updateJobInTab,
  deleteJobRowInTab,
  fetchSpreadsheetMetadata,
  syncTabHeaders,
  seedTabHeaders,
  renameSheetTab,
  rowIndexFromUpdatedRange,
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
  isDestructiveOp,
  DESTRUCTIVE_WARNING,
  SCHEMA_OPS,
} from '../lib/schema-editor.js';
import { withSheetAccess } from './google-session.js';

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
    const seeded = config.isNew;
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

export async function addSheet(url) {
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

      const sheets = await getConfiguredSheets();
      const existing = sheets.find(
        (s) => s.spreadsheetId === parsed.spreadsheetId
      );
      const tabs = await materializeTabs(
        parsed.spreadsheetId,
        rawTabs,
        existing?.tabs,
        token
      );

      const sheetEntry = {
        spreadsheetId: parsed.spreadsheetId,
        url: parsed.url,
        name: spreadsheetTitle,
        tabs,
        addedAt: Date.now(),
      };

      const next = [...sheets];
      const existingIndex = next.findIndex(
        (s) => s.spreadsheetId === parsed.spreadsheetId
      );
      if (existingIndex >= 0) {
        next[existingIndex] = sheetEntry;
      } else {
        next.push(sheetEntry);
      }

      await saveConfiguredSheets(next);
      return { success: true, sheet: sheetEntry, sheets: next };
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

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

export async function refreshAllSheets() {
  return withSheetAccess(async (token) => {
    const sheets = await getConfiguredSheets();
    const updated = [];

    for (const sheet of sheets) {
      const meta = await fetchSpreadsheetMetadata(sheet.spreadsheetId, token);
      const rawTabs = await loadSpreadsheetTabs(sheet.spreadsheetId, token);
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
      });
    }

    await saveConfiguredSheets(updated);
    return { success: true, sheets: updated };
  });
}


export async function applySchemaChangeMessage(message) {
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
  // New edits invalidate redo history.
  await saveRedoStack([]);
  await saveConfiguredSheets(sheets);

  return {
    success: true,
    sheets,
    undoEntry: entry,
    stack,
    redoStack: [],
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

export async function undoSchemaChange(entryId) {
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

  const redoStack = pushRedo(await getRedoStack(), entry);
  await saveUndoStack(nextStack);
  await saveRedoStack(redoStack);
  await saveConfiguredSheets(sheets);

  return {
    success: true,
    sheets,
    stack: nextStack,
    redoStack,
    restored: entry,
  };
}

export async function redoSchemaChange(entryId) {
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

  restoreTabSchema(tab, entry.after);

  if (entry.destructive && !tab.isNew) {
    await withSheetAccess(async (token) => {
      await syncTabHeaders(entry.spreadsheetId, tab.tabName, tab.headers, token);
    });
  }

  const undoStack = pushUndo(await getUndoStack(), entry);
  await saveUndoStack(undoStack);
  await saveRedoStack(nextRedo);
  await saveConfiguredSheets(sheets);

  return {
    success: true,
    sheets,
    stack: undoStack,
    redoStack: nextRedo,
    restored: entry,
  };
}

async function loadAllTabsWithRows(token, sheets) {
  const tabs = [];
  for (const sheet of sheets) {
    let metaSheets = [];
    try {
      const meta = await fetchSpreadsheetMetadata(sheet.spreadsheetId, token);
      metaSheets = meta.sheets ?? [];
    } catch {
      continue;
    }
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
      } catch {
        rows = [];
      }
      tabs.push({
        sheetName: sheet.name,
        tabName,
        spreadsheetId: sheet.spreadsheetId,
        gid,
        mappings: configTab?.mappings,
        rows,
      });
    }
  }
  return tabs;
}

export async function findApplication(extractedData = {}) {
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

export async function saveJob(message) {
  const {
    spreadsheetId,
    tabId,
    extractedData,
    userInputs,
    existingRowIndex = null,
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
      if (rowIndex === 0 && rows.length && String(rows[0]?.[0] || '').trim()) {
        // Never overwrite the header row.
        const headerish = tab.headers?.[0];
        if (
          headerish &&
          String(rows[0][0]).trim().toLowerCase() ===
            String(headerish).trim().toLowerCase()
        ) {
          return { success: false, error: 'Cannot update the header row.' };
        }
      }
      await updateJobInTab(spreadsheetId, tab.tabName, rowIndex, row, token);
      return {
        success: true,
        updated: true,
        row,
        rowIndex,
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

    tab.isNew = false;
    tab.rowCount = (tab.rowCount || 0) + 1;
    await saveConfiguredSheets(sheets);

    const rowIndex = rowIndexFromUpdatedRange(appendRes?.updates?.updatedRange);

    return {
      success: true,
      row,
      rowIndex,
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
  const { spreadsheetId, tabId, rowIndex } = message;
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

      const sheetIdForApi = tab.sheetId ?? tab.gid;
      await deleteJobRowInTab(spreadsheetId, sheetIdForApi, index, token);

      if (Number.isFinite(Number(tab.rowCount)) && tab.rowCount > 0) {
        tab.rowCount = Math.max(0, Number(tab.rowCount) - 1);
        await saveConfiguredSheets(sheets);
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
