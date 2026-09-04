import {
  SCHEMA_OPS,
  applySchemaChange,
  snapshotTabSchema,
  restoreTabSchema,
  pushUndo,
  popUndo,
  createUndoEntry,
  isDestructiveOp,
  DESTRUCTIVE_WARNING,
} from '../lib/schema-editor.js';
import { FIELD_TAGS } from '../lib/constants.js';
import { buildDefaultMappings } from '../lib/field-mapper.js';

describe('schema-editor', () => {
  const headers = ['Company', 'Role', 'Notes'];
  const mappings = [
    { columnIndex: 0, header: 'Company', tag: FIELD_TAGS.COMPANY_NAME, dropdownOptions: [] },
    { columnIndex: 1, header: 'Role', tag: FIELD_TAGS.ROLE, dropdownOptions: [] },
    { columnIndex: 2, header: 'Notes', tag: FIELD_TAGS.CUSTOM_TEXTBOX, dropdownOptions: [] },
  ];

  test('rename is destructive and updates header', () => {
    expect(isDestructiveOp(SCHEMA_OPS.RENAME)).toBe(true);
    const result = applySchemaChange(headers, mappings, {
      op: SCHEMA_OPS.RENAME,
      columnIndex: 0,
      newHeader: 'Employer',
    });
    expect(result.headers[0]).toBe('Employer');
    expect(result.mappings[0].header).toBe('Employer');
    expect(result.syncHeaders).toBe(true);
  });

  test('change tag is not destructive and does not sync headers', () => {
    expect(isDestructiveOp(SCHEMA_OPS.CHANGE_TAG)).toBe(false);
    const result = applySchemaChange(headers, mappings, {
      op: SCHEMA_OPS.CHANGE_TAG,
      columnIndex: 2,
      newTag: FIELD_TAGS.CUSTOM_DROPDOWN,
    });
    expect(result.mappings[2].tag).toBe(FIELD_TAGS.CUSTOM_DROPDOWN);
    expect(result.syncHeaders).toBe(false);
  });

  test('set dropdown options stores unique trimmed choices', () => {
    expect(isDestructiveOp(SCHEMA_OPS.SET_DROPDOWN_OPTIONS)).toBe(false);
    const result = applySchemaChange(headers, mappings, {
      op: SCHEMA_OPS.SET_DROPDOWN_OPTIONS,
      columnIndex: 2,
      options: [' LinkedIn ', 'Indeed', 'LinkedIn', ''],
    });
    expect(result.mappings[2].tag).toBe(FIELD_TAGS.CUSTOM_DROPDOWN);
    expect(result.mappings[2].dropdownOptions).toEqual(['LinkedIn', 'Indeed']);
    expect(result.syncHeaders).toBe(false);
  });

  test('add column appends header and mapping', () => {
    const result = applySchemaChange(headers, mappings, {
      op: SCHEMA_OPS.ADD,
      header: 'Source',
      tag: FIELD_TAGS.CUSTOM_DROPDOWN,
    });
    expect(result.headers).toHaveLength(4);
    expect(result.headers[3]).toBe('Source');
    expect(result.mappings[3].columnIndex).toBe(3);
    expect(result.syncHeaders).toBe(true);
  });

  test('delete column reindexes remaining columns', () => {
    const result = applySchemaChange(headers, mappings, {
      op: SCHEMA_OPS.DELETE,
      columnIndex: 1,
    });
    expect(result.headers).toEqual(['Company', 'Notes']);
    expect(result.mappings.map((m) => m.columnIndex)).toEqual([0, 1]);
    expect(result.mappings[1].header).toBe('Notes');
  });

  test('cannot delete last column', () => {
    expect(() =>
      applySchemaChange(['Only'], [{ columnIndex: 0, header: 'Only', tag: FIELD_TAGS.IGNORE, dropdownOptions: [] }], {
        op: SCHEMA_OPS.DELETE,
        columnIndex: 0,
      })
    ).toThrow(/at least one/i);
  });

  test('move reorders headers and mappings', () => {
    const result = applySchemaChange(headers, mappings, {
      op: SCHEMA_OPS.MOVE,
      fromIndex: 0,
      toIndex: 2,
    });
    expect(result.headers).toEqual(['Role', 'Notes', 'Company']);
    expect(result.mappings.map((m) => m.header)).toEqual(['Role', 'Notes', 'Company']);
    expect(result.mappings.map((m) => m.columnIndex)).toEqual([0, 1, 2]);
  });

  test('snapshot and restore round-trip', () => {
    const tab = {
      headers: [...headers],
      mappings: mappings.map((m) => ({ ...m })),
      isNew: false,
    };
    const snap = snapshotTabSchema(tab);
    tab.headers[0] = 'Changed';
    tab.mappings[0].header = 'Changed';
    restoreTabSchema(tab, snap);
    expect(tab.headers[0]).toBe('Company');
    expect(tab.mappings[0].header).toBe('Company');
  });

  test('undo stack push and pop', () => {
    let stack = [];
    const entry = createUndoEntry({
      spreadsheetId: 'abc',
      tabId: '0',
      tabName: 'Jobs',
      before: snapshotTabSchema({ headers, mappings, isNew: false }),
      after: snapshotTabSchema({
        headers: ['Employer', 'Role', 'Notes'],
        mappings,
        isNew: false,
      }),
      change: { op: SCHEMA_OPS.RENAME, columnIndex: 0, newHeader: 'Employer' },
      label: 'Rename',
    });
    expect(entry.destructive).toBe(true);
    stack = pushUndo(stack, entry);
    expect(stack).toHaveLength(1);
    const { stack: next, entry: popped } = popUndo(stack);
    expect(popped.id).toBe(entry.id);
    expect(next).toHaveLength(0);
  });

  test('default mappings are editable via replace_all', () => {
    const defaults = buildDefaultMappings();
    const defaultHeaders = defaults.map((m) => m.header);
    const result = applySchemaChange(defaultHeaders, defaults, {
      op: SCHEMA_OPS.RENAME,
      columnIndex: 2,
      newHeader: 'Employer Name',
    });
    expect(result.headers[2]).toBe('Employer Name');
  });

  test('destructive warning is present', () => {
    expect(DESTRUCTIVE_WARNING.toLowerCase()).toContain('existing');
  });
});
