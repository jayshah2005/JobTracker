import { jest } from '@jest/globals';
import { withSheetAccess } from '../background/google-session.js';
import { saveGoogleToken, getGoogleToken, saveOAuthClientId, _resetMemoryStore } from '../lib/storage.js';

describe('withSheetAccess', () => {
  beforeEach(async () => {
    _resetMemoryStore();
    await saveOAuthClientId('abc.apps.googleusercontent.com');
  });

  test('passes a fresh token to the callback', async () => {
    await saveGoogleToken({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    await expect(withSheetAccess(async (t) => t)).resolves.toBe('tok');
  });

  test('on 401 refreshes silently, keeps refresh token and retries once', async () => {
    await saveGoogleToken({ accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new', expires_in: 3600 }),
    });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('expired'), { status: 401 }))
      .mockResolvedValueOnce('done');
    await expect(withSheetAccess(fn)).resolves.toBe('done');
    expect(fn).toHaveBeenLastCalledWith('new');
    expect((await getGoogleToken()).refreshToken).toBe('r');
    global.fetch = realFetch;
  });

  test('a failing retry is translated into a friendly message', async () => {
    await saveGoogleToken({ accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new', expires_in: 3600 }),
    });
    const fn = jest.fn().mockRejectedValue(Object.assign(new Error('Google Sheets API error: 403'), { status: 401 }));
    await expect(withSheetAccess(fn)).rejects.toThrow(/editable by the Google account/);
    global.fetch = realFetch;
  });

  test('a network error during refresh keeps the stored session', async () => {
    await saveGoogleToken({ accessToken: 'old', refreshToken: 'r', expiresAt: 1 });
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(withSheetAccess(async () => 1)).rejects.toThrow(/internet connection/);
    expect((await getGoogleToken()).refreshToken).toBe('r');
    global.fetch = realFetch;
  });
});
