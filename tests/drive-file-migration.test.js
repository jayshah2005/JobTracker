import { jest } from '@jest/globals';
import { refreshAllSheets } from '../background/sheets-orchestrator.js';
import { isTrustedPickerSender } from '../background/picker-messages.js';
import { sheetsAccessError } from '../lib/google-auth.js';
import {
  saveGoogleToken,
  saveConfiguredSheets,
  getConfiguredSheets,
  saveOAuthClientId,
  _resetMemoryStore,
} from '../lib/storage.js';

describe('isTrustedPickerSender', () => {
  const O = 'https://jobtracker.jayshah.xyz';
  test('accepts the picker page', () => {
    expect(isTrustedPickerSender({ origin: O, url: `${O}/picker/?ext=x` })).toBe(true);
  });
  test.each([
    [{ origin: O, url: `${O}/picker.evil/` }],
    [{ origin: O, url: `${O}/other/` }],
    [{ origin: 'http://jobtracker.jayshah.xyz', url: 'http://jobtracker.jayshah.xyz/picker/' }],
    [{ origin: 'https://jobtracker.jayshah.xyz.evil.com', url: 'https://jobtracker.jayshah.xyz.evil.com/picker/' }],
    [{ origin: O, url: `https://evil.com/picker/` }],
    [{ origin: O }],
    [{}],
    [null],
  ])('rejects %j', (s) => expect(isTrustedPickerSender(s)).toBe(false));
});

describe('refreshAllSheets with inaccessible sheets', () => {
  const realFetch = global.fetch;
  afterEach(() => (global.fetch = realFetch));

  test('keeps config and flags needsAccess instead of failing', async () => {
    _resetMemoryStore();
    await saveOAuthClientId('abc.apps.googleusercontent.com');
    await saveGoogleToken({
      accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
      scope: 'https://www.googleapis.com/auth/drive.file',
    });
    await saveConfiguredSheets([{ spreadsheetId: 'GONE', name: 'Old', tabs: [] }]);
    global.fetch = jest.fn(async () => ({
      ok: false, status: 404, json: async () => ({ error: { message: 'Requested entity was not found.' } }),
    }));
    const res = await refreshAllSheets();
    expect(res.success).toBe(true);
    const saved = await getConfiguredSheets();
    expect(saved).toHaveLength(1);
    expect(saved[0].needsAccess).toBe(true);
  });
});

test('API-not-enabled 403 is not reported as a missing-file error', () => {
  expect(
    sheetsAccessError('Google Sheets API has not been used in project 123 before or it is disabled.')
  ).toMatch(/not enabled/i);
});
