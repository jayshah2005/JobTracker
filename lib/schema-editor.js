/**
 * Column schema editing with destructive-change detection and undo snapshots.
 */

import { FIELD_TAGS } from './constants.js';
import { guessTagFromHeader as guessTag, normalizeDropdownOptions, normalizeDropdownDefault } from './field-mapper.js';

export const SCHEMA_OPS = {
  RENAME: 'rename',
  CHANGE_TAG: 'change_tag',
  SET_DROPDOWN_OPTIONS: 'set_dropdown_options',
  ADD: 'add',
  DELETE: 'delete',
  MOVE: 'move',
  REPLACE_ALL: 'replace_all',
};

/** Ops that rewrite the header row (and may misalign sheet data). */
export const DESTRUCTIVE_OPS = new Set([
  SCHEMA_OPS.RENAME,
  SCHEMA_OPS.ADD,
  SCHEMA_OPS.DELETE,
  SCHEMA_OPS.MOVE,
  SCHEMA_OPS.REPLACE_ALL,
]);

export const DESTRUCTIVE_WARNING =
  'This changes your sheet columns. Existing row data may no longer line up with the new headers. You can Undo this change from Settings.';

/**
 * Snapshot of a tab’s editable schema (for undo).
 */
export function snapshotTabSchema(tab) {
  return {
    headers: [...(tab.headers || [])],
    mappings: (tab.mappings || []).map((m) => ({
      columnIndex: m.columnIndex,
      header: m.header,
      tag: m.tag,
      dropdownOptions: [...(m.dropdownOptions || [])],
      dropdownDefault: m.dropdownDefault || '',
    })),
    isNew: !!tab.isNew,
  };
}

export function restoreTabSchema(tab, snapshot) {
  tab.headers = [...snapshot.headers];
  tab.mappings = snapshot.mappings.map((m) => ({
    ...m,
    dropdownOptions: [...(m.dropdownOptions || [])],
    dropdownDefault: m.dropdownDefault || '',
  }));
  tab.isNew = snapshot.isNew;
}

export function isDestructiveOp(op) {
  return DESTRUCTIVE_OPS.has(op);
}

/**
 * Apply a schema mutation to mappings/headers (pure).
 * Returns { headers, mappings, syncHeaders } where syncHeaders means write to Google Sheet.
 */
export function applySchemaChange(headers, mappings, change) {
  const nextHeaders = [...headers];
  let nextMappings = mappings.map((m) => ({
    ...m,
    dropdownOptions: [...(m.dropdownOptions || [])],
    dropdownDefault: m.dropdownDefault || '',
  }));
  let syncHeaders = false;

  switch (change.op) {
    case SCHEMA_OPS.RENAME: {
      const { columnIndex, newHeader } = change;
      const name = String(newHeader || '').trim();
      if (!name) throw new Error('Column name cannot be empty.');
      nextHeaders[columnIndex] = name;
      const m = nextMappings.find((x) => x.columnIndex === columnIndex);
      if (m) {
        const previousGuess = guessTag(m.header);
        m.header = name;
        const nextGuess = guessTag(name);
        // Keep an explicit user-chosen tag, but auto-infer when the header
        // clearly means a known field (e.g. Date Applied / Date Posted).
        if (
          m.tag === previousGuess ||
          m.tag === FIELD_TAGS.CUSTOM_TEXT ||
          m.tag === FIELD_TAGS.CUSTOM_TEXTBOX ||
          m.tag === FIELD_TAGS.IGNORE ||
          nextGuess === FIELD_TAGS.DATE_APPLIED ||
          nextGuess === FIELD_TAGS.JOB_POSTED_DATE
        ) {
          if (
            nextGuess !== FIELD_TAGS.CUSTOM_TEXT &&
            nextGuess !== FIELD_TAGS.CUSTOM_TEXTBOX
          ) {
            m.tag = nextGuess;
          } else if (
            m.tag === FIELD_TAGS.CUSTOM_TEXT ||
            m.tag === FIELD_TAGS.IGNORE
          ) {
            m.tag = nextGuess;
          }
        }
      }
      syncHeaders = true;
      break;
    }
    case SCHEMA_OPS.CHANGE_TAG: {
      const { columnIndex, newTag } = change;
      const m = nextMappings.find((x) => x.columnIndex === columnIndex);
      if (m) {
        m.tag = newTag;
        if (newTag !== FIELD_TAGS.CUSTOM_DROPDOWN) {
          m.dropdownOptions = Array.isArray(m.dropdownOptions) ? m.dropdownOptions : [];
          m.dropdownDefault = '';
        }
      }
      break;
    }
    case SCHEMA_OPS.SET_DROPDOWN_OPTIONS: {
      const { columnIndex, options, defaultValue } = change;
      const m = nextMappings.find((x) => x.columnIndex === columnIndex);
      if (m) {
        m.tag = FIELD_TAGS.CUSTOM_DROPDOWN;
        m.dropdownOptions = normalizeDropdownOptions(options);
        const nextDefault =
          defaultValue !== undefined ? defaultValue : m.dropdownDefault;
        m.dropdownDefault = normalizeDropdownDefault(
          m.dropdownOptions,
          nextDefault
        );
      }
      break;
    }
    case SCHEMA_OPS.ADD: {
      const name = String(change.header || 'New Column').trim() || 'New Column';
      const tag = change.tag || guessTag(name);
      const columnIndex = nextHeaders.length;
      nextHeaders.push(name);
      nextMappings.push({
        columnIndex,
        header: name,
        tag,
        dropdownOptions: [],
        dropdownDefault: '',
      });
      syncHeaders = true;
      break;
    }
    case SCHEMA_OPS.DELETE: {
      const { columnIndex } = change;
      if (nextHeaders.length <= 1) {
        throw new Error('You must keep at least one column.');
      }
      nextHeaders.splice(columnIndex, 1);
      nextMappings = nextMappings
        .filter((m) => m.columnIndex !== columnIndex)
        .map((m) => ({
          ...m,
          columnIndex: m.columnIndex > columnIndex ? m.columnIndex - 1 : m.columnIndex,
        }));
      syncHeaders = true;
      break;
    }
    case SCHEMA_OPS.MOVE: {
      const { fromIndex, toIndex } = change;
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= nextHeaders.length ||
        toIndex >= nextHeaders.length ||
        fromIndex === toIndex
      ) {
        break;
      }
      const [h] = nextHeaders.splice(fromIndex, 1);
      nextHeaders.splice(toIndex, 0, h);

      const sorted = [...nextMappings].sort((a, b) => a.columnIndex - b.columnIndex);
      const [moved] = sorted.splice(fromIndex, 1);
      sorted.splice(toIndex, 0, moved);
      nextMappings = sorted.map((m, i) => ({ ...m, columnIndex: i, header: nextHeaders[i] }));
      syncHeaders = true;
      break;
    }
    case SCHEMA_OPS.REPLACE_ALL: {
      nextHeaders.length = 0;
      nextHeaders.push(...change.headers);
      nextMappings = change.mappings.map((m, i) => ({
        columnIndex: i,
        header: change.headers[i] ?? m.header,
        tag: m.tag,
        dropdownOptions: [...(m.dropdownOptions || [])],
        dropdownDefault: m.dropdownDefault || '',
      }));
      syncHeaders = true;
      break;
    }
    default:
      throw new Error(`Unknown schema operation: ${change.op}`);
  }

  return { headers: nextHeaders, mappings: nextMappings, syncHeaders };
}

/**
 * In-memory undo stack helpers (also persisted via storage).
 */
export function createUndoEntry({ spreadsheetId, tabId, tabName, before, after, change, label }) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    spreadsheetId,
    tabId,
    tabName,
    before,
    after,
    change,
    label,
    destructive: isDestructiveOp(change.op),
  };
}

export function pushUndo(stack, entry, max = 30) {
  const next = [...stack, entry];
  if (next.length > max) return next.slice(next.length - max);
  return next;
}

export function popUndo(stack) {
  if (!stack.length) return { stack: [], entry: null };
  const next = [...stack];
  const entry = next.pop();
  return { stack: next, entry };
}

export function describeChange(change) {
  switch (change.op) {
    case SCHEMA_OPS.RENAME:
      return `Rename column to “${change.newHeader}”`;
    case SCHEMA_OPS.CHANGE_TAG:
      return `Change field type`;
    case SCHEMA_OPS.SET_DROPDOWN_OPTIONS:
      return `Edit dropdown options`;
    case SCHEMA_OPS.ADD:
      return `Add column “${change.header || 'New Column'}”`;
    case SCHEMA_OPS.DELETE:
      return `Delete column`;
    case SCHEMA_OPS.MOVE:
      return `Reorder columns`;
    case SCHEMA_OPS.REPLACE_ALL:
      return `Replace column layout`;
    default:
      return 'Edit columns';
  }
}
