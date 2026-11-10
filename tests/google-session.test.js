import { jest } from '@jest/globals';
import { withSheetAccess } from '../background/google-session.js';
import { getAuthStatus, signIn } from '../background/google-session.js';
import { saveGoogleToken, getGoogleToken, saveOAuthClientId, saveOAuthClientSecret, _resetMemoryStore } from '../lib/storage.js';

const DRIVE = 'https://www.googleapis.com/auth/drive.file';

describe('withSheetAccess', () => {
  beforeEach(async () => {
    _resetMemoryStore();
    await saveOAuthClientId('abc.apps.googleusercontent.com');
  });

  test('passes a fresh token to the callback', async () => {
    await saveGoogleToken({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000, scope: DRIVE });
    await expect(withSheetAccess(async (t) => t)).resolves.toBe('tok');
  });

  test('on 401 refreshes silently, keeps refresh token and retries once', async () => {
    await saveGoogleToken({ accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 3600_000, scope: DRIVE });
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
    await saveGoogleToken({ accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 3600_000, scope: DRIVE });
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new', expires_in: 3600 }),
    });
    const fn = jest.fn().mockRejectedValue(Object.assign(new Error('Google Sheets API error: 403'), { status: 401 }));
    await expect(withSheetAccess(fn)).rejects.toThrow(/did not allow Job Tracker/);
    global.fetch = realFetch;
  });

  test('a network error during refresh keeps the stored session', async () => {
    await saveGoogleToken({ accessToken: 'old', refreshToken: 'r', expiresAt: 1, scope: DRIVE });
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(withSheetAccess(async () => 1)).rejects.toThrow(/internet connection/);
    expect((await getGoogleToken()).refreshToken).toBe('r');
    global.fetch = realFetch;
  });
});

describe('withSheetAccess interactive sign-in', () => {
  beforeEach(async () => {
    _resetMemoryStore();
    await saveOAuthClientId('abc.apps.googleusercontent.com');
  });

  test('parallel 401s open only one consent window', async () => {
    await saveGoogleToken({ accessToken: 'old', refreshToken: '', expiresAt: Date.now() + 3600_000, scope: DRIVE });
    const realFetch = global.fetch;
    const realChrome = global.chrome;
    const launch = jest.fn((url, cb) => setTimeout(() => cb('https://x.chromiumapp.org/?code=abc'), 20));
    global.chrome = {
      runtime: {},
      identity: { getRedirectURL: () => 'https://x.chromiumapp.org/', launchWebAuthFlow: launch },
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new', refresh_token: 'rr', expires_in: 3600, scope: DRIVE }),
    });
    const mk = () =>
      jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('expired'), { status: 401 }))
        .mockResolvedValueOnce('ok');
    const [a, b] = [mk(), mk()];
    await expect(Promise.all([withSheetAccess(a), withSheetAccess(b)])).resolves.toEqual(['ok', 'ok']);
    expect(launch).toHaveBeenCalledTimes(1);
    global.fetch = realFetch;
    global.chrome = realChrome;
  });
});

describe('scope migration', () => {
  beforeEach(async () => {
    global.chrome = { identity: { getRedirectURL: () => 'https://x.chromiumapp.org/' } };
    _resetMemoryStore();
    await saveOAuthClientId('abc.apps.googleusercontent.com');
  });

  test('old broad-scope session is treated as signed out and re-consent is requested', async () => {
    await saveGoogleToken({
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3600_000,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
    });
    await expect(withSheetAccess(async (t) => t)).rejects.toThrow(
      'Job Tracker now uses narrower Google access. Sign in again.'
    );
    expect(await getGoogleToken()).toBeNull();
  });

  test('token without a stored scope (legacy install) is signed out in auth status', async () => {
    await saveGoogleToken({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    const status = await getAuthStatus();
    // No default client in tests, but a stored client id exists; secret missing => needsSetup.
    expect(status.signedIn).toBe(false);
  });

  test('pickerAvailable is false when a custom client is stored', async () => {
    const status = await getAuthStatus();
    expect(status.pickerAvailable).toBe(false);
  });

  test('signIn without a client secret reports failure (needsSetup), not success', async () => {
    global.chrome = { identity: { getRedirectURL: () => 'https://x.chromiumapp.org/' } };
    const res = await signIn(); // client id stored, secret missing
    expect(res.success).toBe(false);
    expect(res.signedIn).toBe(false);
    expect(res.needsSetup).toBe(true);
  });

  test('an error that only mentions 401 (HTTP 400) does not drop the token or re-auth', async () => {
    await saveGoogleToken({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000, scope: DRIVE });
    const realFetch = global.fetch;
    global.fetch = jest.fn();
    const err = Object.assign(new Error("Unable to parse range: '401'!A1"), { status: 400 });
    await expect(withSheetAccess(async () => { throw err; })).rejects.toThrow('Unable to parse range');
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await getGoogleToken()).accessToken).toBe('tok');
    global.fetch = realFetch;
  });

  describe('interactive sign-in', () => {
    const realFetch = global.fetch;
    let launch;
    beforeEach(async () => {
      await saveOAuthClientSecret('secret');
      launch = jest.fn();
      global.chrome = {
        runtime: { lastError: undefined },
        identity: {
          getRedirectURL: () => 'https://x.chromiumapp.org',
          launchWebAuthFlow: (opts, cb) => cb(launch(opts)),
        },
      };
    });
    afterEach(() => {
      global.fetch = realFetch;
    });

    test('exchanges the code with the PKCE verifier and stores the token', async () => {
      launch.mockReturnValue('https://x.chromiumapp.org/?code=abc');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'new', refresh_token: 'rt', expires_in: 3600, scope: DRIVE }),
      });
      const res = await signIn();
      expect(res).toMatchObject({ success: true, signedIn: true });
      const authUrl = new URL(launch.mock.calls[0][0].url);
      expect(authUrl.searchParams.get('scope')).toBe(DRIVE);
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      const body = global.fetch.mock.calls[0][1].body;
      expect(body.get('code')).toBe('abc');
      expect(body.get('redirect_uri')).toBe('https://x.chromiumapp.org/');
      // The verifier sent to Google must hash to the challenge sent to Google.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')));
      const b64 = Buffer.from(digest).toString('base64url');
      expect(b64).toBe(authUrl.searchParams.get('code_challenge'));
      expect(await getGoogleToken()).toMatchObject({ accessToken: 'new', refreshToken: 'rt', scope: DRIVE });
    });

    test('closing the Google window is reported in plain language and stores nothing', async () => {
      global.chrome.identity.launchWebAuthFlow = (opts, cb) => {
        global.chrome.runtime.lastError = { message: 'The user did not approve access.' };
        cb(undefined);
        global.chrome.runtime.lastError = undefined;
      };
      const res = await signIn();
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/cancelled/i);
      expect(await getGoogleToken()).toBeNull();
    });

    test('Google returning an error in the redirect is surfaced', async () => {
      launch.mockReturnValue('https://x.chromiumapp.org/?error=access_denied');
      const res = await signIn();
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/cancelled/i);
    });

    test('two simultaneous sign-ins open one consent window', async () => {
      launch.mockReturnValue('https://x.chromiumapp.org/?code=abc');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'new', refresh_token: 'rt', scope: DRIVE }),
      });
      const [a, b] = await Promise.all([signIn(), signIn()]);
      expect(a.success && b.success).toBe(true);
      expect(launch).toHaveBeenCalledTimes(1);
    });

    test('revoked refresh token (invalid_grant): token cleared and "sign in" error, no window', async () => {
      await saveGoogleToken({ accessToken: 'old', refreshToken: 'dead', expiresAt: 0, scope: DRIVE });
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      });
      await expect(withSheetAccess(async (t) => t)).rejects.toThrow(/Sign in with Google/);
      expect(launch).not.toHaveBeenCalled();
      expect(await getGoogleToken()).toBeNull();
    });

    test('a transient refresh failure keeps the refresh token', async () => {
      await saveGoogleToken({ accessToken: 'old', refreshToken: 'keep', expiresAt: 0, scope: DRIVE });
      global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(withSheetAccess(async (t) => t)).rejects.toThrow(/Could not reach Google/);
      expect((await getGoogleToken()).refreshToken).toBe('keep');
    });
  });

  afterAll(() => {
    delete global.chrome;
  });
});
