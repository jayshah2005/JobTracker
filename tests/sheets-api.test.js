import { jest } from '@jest/globals';
import { apiRequest, fetchSheetValues } from '../lib/sheets-api.js';

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
      expect.stringContaining('sheet-id'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      })
    );
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
