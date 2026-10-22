import { jest } from '@jest/globals';
import {
  apiRequest,
  fetchSheetValues,
  updateRow,
  deleteJobRowInTab,
  rowIndexFromUpdatedRange,
  seedTabHeaders,
  setRowsBold,
  loadSpreadsheetTabs,
  loadTabRows,
  deleteColumn,
  moveColumn,
  insertColumn,
  ROW_CHUNK_SIZE,
} from '../lib/sheets-api.js';

describe('sheets-api', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('fetchSheetValues returns values array', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ values: [['A', 'B'], ['1', '2']] }),
    });

    const rows = await fetchSheetValues('sheet-id', 'Sheet1!A1:B2', 'token');
    expect(rows).toHaveLength(2);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('valueRenderOption=FORMATTED_VALUE'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      })
    );
  });

  test('updateRow writes the 1-based sheet row range', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ updatedRows: 1 }),
    });

    await updateRow('sheet-id', 'Jobs', 3, ['a', 'b', 'c'], 'token');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/Jobs'!A4%3AC4/),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ values: [['a', 'b', 'c']] }),
      })
    );
  });

  test('deleteJobRowInTab sends deleteDimension for the row', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ replies: [{}] }),
    });

    await deleteJobRowInTab('sheet-id', '42', 5, 'token');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/spreadsheets/sheet-id:batchUpdate'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: 42,
                  dimension: 'ROWS',
                  startIndex: 5,
                  endIndex: 6,
                },
              },
            },
          ],
        }),
      })
    );
  });

  test('deleteJobRowInTab refuses the header row', async () => {
    await expect(deleteJobRowInTab('sheet-id', 0, 0, 'token')).rejects.toThrow(
      'Cannot delete the header row.'
    );
  });

  test('rowIndexFromUpdatedRange parses append updatedRange', () => {
    expect(rowIndexFromUpdatedRange('Jobs!A12:G12')).toBe(11);
    expect(rowIndexFromUpdatedRange("'My Jobs'!A2:Z2")).toBe(1);
    expect(rowIndexFromUpdatedRange('bad')).toBeNull();
  });

  test('apiRequest throws on error response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'Permission denied' } }),
    });

    await expect(apiRequest('https://example.com', 'token')).rejects.toThrow(
      'Permission denied'
    );
  });

  test('seedTabHeaders clears then writes row 1 for the tab', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ updatedRows: 1 }),
    });

    const headers = ['Date Applied', 'Job ID', 'Company Name'];
    await seedTabHeaders('sheet-id', 'Sheet1', headers, 'token');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/:clear/),
      expect.objectContaining({ method: 'POST' })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/Sheet1'!A1/),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ values: [headers] }),
      })
    );
  });

  test('seedTabHeaders bolds header row and clears bold on data rows', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const headers = ['Date Applied', 'Role', 'Location'];
    await seedTabHeaders('sheet-id', 'Sheet1', headers, 'token', {
      sheetId: 42,
    });

    const batchBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes(':batchUpdate'))
      .map(([, opts]) => JSON.parse(opts.body));

    expect(batchBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requests: [
            expect.objectContaining({
              repeatCell: expect.objectContaining({
                range: expect.objectContaining({
                  sheetId: 42,
                  startRowIndex: 0,
                  endRowIndex: 1,
                }),
                cell: {
                  userEnteredFormat: { textFormat: { bold: true } },
                },
              }),
            }),
          ],
        }),
        expect.objectContaining({
          requests: [
            expect.objectContaining({
              repeatCell: expect.objectContaining({
                range: expect.objectContaining({
                  sheetId: 42,
                  startRowIndex: 1,
                  endRowIndex: 1000,
                }),
                cell: {
                  userEnteredFormat: { textFormat: { bold: false } },
                },
              }),
            }),
          ],
        }),
      ])
    );
  });

  test('setRowsBold sends repeatCell for the row band', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await setRowsBold('sheet-id', 7, 3, 4, 5, false, 'token');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/spreadsheets/sheet-id:batchUpdate'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId: 7,
                  startRowIndex: 3,
                  endRowIndex: 4,
                  startColumnIndex: 0,
                  endColumnIndex: 5,
                },
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: false },
                  },
                },
                fields: 'userEnteredFormat.textFormat.bold',
              },
            },
          ],
        }),
      })
    );
  });

  test('apiRequest attaches the HTTP status to the error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    await expect(apiRequest('https://example.com', 't')).rejects.toMatchObject({
      status: 401,
    });
  });

  test('loadSpreadsheetTabs propagates row read failures instead of returning an empty tab', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sheets: [{ properties: { sheetId: 0, title: 'Jobs' } }] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({}),
      });
    await expect(loadSpreadsheetTabs('id', 't')).rejects.toThrow(/429/);
  });

  describe('chunked row reads', () => {
    const ok = (values) => ({ ok: true, json: async () => ({ values }) });
    const mkRows = (n, from = 0) =>
      Array.from({ length: n }, (_, i) => [`r${from + i}`]);
    const rangeOf = (call) => decodeURIComponent(call[0]).split('/values/')[1].split('?')[0];

    test('reads multiple chunks and keeps row indexes aligned', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(ok(mkRows(ROW_CHUNK_SIZE)))
        .mockResolvedValueOnce(ok(mkRows(ROW_CHUNK_SIZE, ROW_CHUNK_SIZE)))
        .mockResolvedValueOnce(ok(mkRows(5, ROW_CHUNK_SIZE * 2)));
      const rows = await loadTabRows('id', "Jo'bs", 't');
      expect(rows).toHaveLength(ROW_CHUNK_SIZE * 2 + 5);
      expect(rows[ROW_CHUNK_SIZE * 2 + 2]).toEqual([`r${ROW_CHUNK_SIZE * 2 + 2}`]);
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(rangeOf(global.fetch.mock.calls[1])).toBe(`'Jo''bs'!A${ROW_CHUNK_SIZE + 1}:ZZ${ROW_CHUNK_SIZE * 2}`);
      expect(rangeOf(global.fetch.mock.calls[2])).toBe(`'Jo''bs'!A${ROW_CHUNK_SIZE * 2 + 1}:ZZ${ROW_CHUNK_SIZE * 3}`);
    });

    test('stops when a chunk is blank or empty', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(ok(mkRows(ROW_CHUNK_SIZE)))
        .mockResolvedValueOnce(ok(undefined));
      const rows = await loadTabRows('id', 'Jobs', 't');
      expect(rows).toHaveLength(ROW_CHUNK_SIZE);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('stops after a long trailing blank run', async () => {
      const chunk = [...mkRows(ROW_CHUNK_SIZE - 100), ...Array(100).fill([])];
      global.fetch = jest.fn().mockResolvedValueOnce(ok(chunk));
      const rows = await loadTabRows('id', 'Jobs', 't');
      expect(rows).toHaveLength(ROW_CHUNK_SIZE);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('keeps blank gaps inside data and continues', async () => {
      const first = mkRows(ROW_CHUNK_SIZE);
      for (let i = 10; i < 60; i++) first[i] = [];
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(ok(first))
        .mockResolvedValueOnce(ok(mkRows(3, ROW_CHUNK_SIZE)));
      const rows = await loadTabRows('id', 'Jobs', 't');
      expect(rows).toHaveLength(ROW_CHUNK_SIZE + 3);
      expect(rows[30]).toEqual([]);
      expect(rows[ROW_CHUNK_SIZE]).toEqual([`r${ROW_CHUNK_SIZE}`]);
    });

    test('treats out-of-grid 400 on a later chunk as end of data', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(ok(mkRows(ROW_CHUNK_SIZE)))
        .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
      const rows = await loadTabRows('id', 'Jobs', 't');
      expect(rows).toHaveLength(ROW_CHUNK_SIZE);
    });

    test('a 400 on the first chunk still throws', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
      await expect(loadTabRows('id', 'Jobs', 't')).rejects.toMatchObject({ status: 400 });
    });
  });

  const okFetch = (body = {}) =>
    (global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body }));
  const sentRequests = () => JSON.parse(global.fetch.mock.calls[0][1].body).requests;

  test('deleteColumn sends a COLUMNS deleteDimension', async () => {
    okFetch();
    await deleteColumn('sid', '77', 2, 'tok');
    expect(global.fetch.mock.calls[0][0]).toContain('sid:batchUpdate');
    expect(sentRequests()).toEqual([
      { deleteDimension: { range: { sheetId: 77, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 } } },
    ]);
  });

  test('deleteColumn rejects bad ids/indexes without calling the API', async () => {
    okFetch();
    await expect(deleteColumn('sid', 'abc', 0, 't')).rejects.toThrow(/tab id/);
    await expect(deleteColumn('sid', '1', -1, 't')).rejects.toThrow(/column/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('moveColumn uses pre-move destinationIndex', async () => {
    okFetch();
    await moveColumn('sid', 5, 0, 2, 'tok'); // right: lands at index 2
    expect(sentRequests()[0].moveDimension).toEqual({
      source: { sheetId: 5, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
      destinationIndex: 3,
    });
    okFetch();
    await moveColumn('sid', 5, 2, 0, 'tok'); // left
    expect(sentRequests()[0].moveDimension.destinationIndex).toBe(0);
  });

  test('insertColumn inserts inside the grid and appends past it', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 9, gridProperties: { columnCount: 5 } } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await insertColumn('sid', 9, 1, 'tok');
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).requests[0].insertDimension.range).toEqual({
      sheetId: 9, dimension: 'COLUMNS', startIndex: 1, endIndex: 2,
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 9, gridProperties: { columnCount: 2 } } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await insertColumn('sid', 9, 4, 'tok');
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).requests[0].appendDimension).toEqual({
      sheetId: 9, dimension: 'COLUMNS', length: 3,
    });
  });
});
