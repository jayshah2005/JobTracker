import { jest } from '@jest/globals';
import {
  applySchemaChangeMessage,
  undoSchemaChange,
  redoSchemaChange,
} from '../background/sheets-orchestrator.js';
import {
  saveGoogleToken,
  saveConfiguredSheets,
  getConfiguredSheets,
  getUndoStack,
  saveOAuthClientId,
  _resetMemoryStore,
} from '../lib/storage.js';
import { SCHEMA_OPS } from '../lib/schema-editor.js';
import { FIELD_TAGS } from '../lib/constants.js';

const headers = ['Company', 'Role', 'Notes'];
const mk = () => ({
  spreadsheetId: 'S',
  name: 'Book',
  tabs: [
    {
      gid: '7',
      tabId: '7',
      sheetId: 7,
      tabName: 'Jobs',
      isNew: false,
      headers: [...headers],
      mappings: headers.map((h, i) => ({
        columnIndex: i,
        header: h,
        tag: FIELD_TAGS.CUSTOM_TEXT,
        dropdownOptions: [],
        dropdownDefault: '',
      })),
    },
  ],
});

describe('delete / move column flow', () => {
  const realFetch = global.fetch;
  let bodies;
  let failBatch;
  let width;

  beforeEach(async () => {
    _resetMemoryStore();
    await saveOAuthClientId('abc.apps.googleusercontent.com');
    await saveGoogleToken({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    await saveConfiguredSheets([mk()]);
    bodies = [];
    failBatch = false;
    width = 5;
    global.fetch = jest.fn(async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('gridProperties')) {
        return { ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 7, gridProperties: { columnCount: width } } }] }) };
      }
      if (u.includes(':batchUpdate')) {
        if (failBatch) {
          return { ok: false, status: 403, json: async () => ({ error: { message: 'Denied' } }) };
        }
        bodies.push(JSON.parse(opts.body).requests[0]);
      }
      return { ok: true, json: async () => ({}) };
    });
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  const del = (columnIndex = 1) =>
    applySchemaChangeMessage({
      spreadsheetId: 'S',
      tabId: '7',
      confirmed: true,
      change: { op: SCHEMA_OPS.DELETE, columnIndex },
    });

  test('delete removes the real column and updates config without header rewrite', async () => {
    const res = await del(1);
    expect(res.success).toBe(true);
    expect(bodies[0].deleteDimension.range).toEqual({ sheetId: 7, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 });
    const tab = (await getConfiguredSheets())[0].tabs[0];
    expect(tab.headers).toEqual(['Company', 'Notes']);
    expect(tab.mappings.map((m) => m.columnIndex)).toEqual([0, 1]);
    expect(global.fetch.mock.calls.some(([u]) => String(u).includes(':clear'))).toBe(false);
    expect(res.undoEntry.label).toContain('Role');
  });

  test('delete requires confirmation', async () => {
    const res = await applySchemaChangeMessage({
      spreadsheetId: 'S', tabId: '7', change: { op: SCHEMA_OPS.DELETE, columnIndex: 1 },
    });
    expect(res.needsConfirmation).toBe(true);
    expect(bodies).toHaveLength(0);
  });

  test('API failure leaves config and undo stack untouched', async () => {
    failBatch = true;
    const res = await del(1);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/nothing was changed/i);
    expect((await getConfiguredSheets())[0].tabs[0].headers).toEqual(headers);
    expect(await getUndoStack()).toHaveLength(0);
  });

  test('column beyond grid width skips the API call', async () => {
    width = 2;
    const res = await del(2);
    expect(res.success).toBe(true);
    expect(bodies).toHaveLength(0);
  });

  test('cannot delete the only column', async () => {
    const sheets = [mk()];
    sheets[0].tabs[0].headers = ['Only'];
    sheets[0].tabs[0].mappings = [sheets[0].tabs[0].mappings[0]];
    await saveConfiguredSheets(sheets);
    const res = await del(0);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/at least one/i);
  });

  test('undo re-inserts an empty column and header; redo deletes it again', async () => {
    await del(1);
    bodies.length = 0;
    const undo = await undoSchemaChange();
    expect(undo.success).toBe(true);
    expect(undo.note).toMatch(/empty/i);
    expect(bodies[0].insertDimension.range.startIndex).toBe(1);
    expect((await getConfiguredSheets())[0].tabs[0].headers).toEqual(headers);
    bodies.length = 0;
    const redo = await redoSchemaChange();
    expect(redo.success).toBe(true);
    expect(bodies[0].deleteDimension.range.startIndex).toBe(1);
    expect((await getConfiguredSheets())[0].tabs[0].headers).toEqual(['Company', 'Notes']);
  });

  test('move uses moveDimension and undo reverses it', async () => {
    const res = await applySchemaChangeMessage({
      spreadsheetId: 'S', tabId: '7', change: { op: SCHEMA_OPS.MOVE, fromIndex: 0, toIndex: 1 },
    });
    expect(res.success).toBe(true);
    expect(bodies[0].moveDimension.destinationIndex).toBe(2);
    expect((await getConfiguredSheets())[0].tabs[0].headers).toEqual(['Role', 'Company', 'Notes']);
    bodies.length = 0;
    await undoSchemaChange();
    expect(bodies[0].moveDimension.source.startIndex).toBe(1);
    expect(bodies[0].moveDimension.destinationIndex).toBe(0);
    expect((await getConfiguredSheets())[0].tabs[0].headers).toEqual(headers);
  });

  test('failed undo keeps the entry on the stack', async () => {
    await del(1);
    failBatch = true;
    const undo = await undoSchemaChange();
    expect(undo.success).toBe(false);
    expect(await getUndoStack()).toHaveLength(1);
    expect((await getConfiguredSheets())[0].tabs[0].headers).toEqual(['Company', 'Notes']);
  });
});
