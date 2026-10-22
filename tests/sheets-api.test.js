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
});
