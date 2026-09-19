import { jest } from '@jest/globals';
import {
  apiRequest,
  fetchSheetValues,
  updateRow,
  rowIndexFromUpdatedRange,
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
});
