import { jest } from '@jest/globals';

// Pretend the published OAuth client is baked in so the Picker is available.
jest.unstable_mockModule('../lib/oauth-config.js', () => ({
  DEFAULT_OAUTH_CLIENT_ID: 'pub.apps.googleusercontent.com',
  DEFAULT_OAUTH_CLIENT_SECRET: 'secret',
  DRIVE_FILE_SCOPE: 'https://www.googleapis.com/auth/drive.file',
  hasPublishedOAuthDefaults: () => true,
}));

const DRIVE = 'https://www.googleapis.com/auth/drive.file';
const ID = 'a'.repeat(30);
const goodSender = { origin: 'https://jobtracker.jayshah.xyz', url: 'https://jobtracker.jayshah.xyz/picker/?ext=x' };

const storage = await import('../lib/storage.js');
const { getAuthStatus } = await import('../background/google-session.js');
const { addSheet, createTrackerSheet } = await import('../background/sheets-orchestrator.js');
const { handlePickerExternalMessage, openPicker, validatePickedFiles } = await import(
  '../background/picker-messages.js'
);
const { buildPickerUrl } = await import('../lib/constants.js');
const { createSpreadsheet } = await import('../lib/sheets-api.js');

const realFetch = global.fetch;
const res = (status, body) => ({ ok: status < 300, status, json: async () => body });

beforeEach(async () => {
  storage._resetMemoryStore();
  await storage.saveGoogleToken({
    accessToken: 'tok',
    refreshToken: 'r',
    expiresAt: Date.now() + 3600_000,
    scope: DRIVE,
  });
  global.chrome = {
    identity: { getRedirectURL: () => 'https://extid.chromiumapp.org/' },
    runtime: { id: 'extid', sendMessage: jest.fn().mockResolvedValue(undefined) },
    tabs: { create: jest.fn().mockResolvedValue({}) },
  };
});
afterEach(() => {
  global.fetch = realFetch;
  delete global.chrome;
});

describe('pickerAvailable', () => {
  test('true with published client and no custom override', async () => {
    expect((await getAuthStatus()).pickerAvailable).toBe(true);
  });
  test('false once a custom client is stored', async () => {
    await storage.saveOAuthClientId('mine.apps.googleusercontent.com');
    expect((await getAuthStatus()).pickerAvailable).toBe(false);
  });
});

describe('OPEN_PICKER', () => {
  test('opens the picker URL with extension id and ids', async () => {
    await expect(openPicker(ID)).resolves.toEqual({ success: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: `https://jobtracker.jayshah.xyz/picker/?ext=extid&ids=${ID}`,
    });
    expect(buildPickerUrl('e')).toBe('https://jobtracker.jayshah.xyz/picker/?ext=e');
  });
  test('unavailable with a custom client', async () => {
    await storage.saveOAuthClientId('mine.apps.googleusercontent.com');
    const r = await openPicker();
    expect(r).toMatchObject({ success: false, code: 'PICKER_UNAVAILABLE' });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe('ADD_SHEET without access', () => {
  const url = `https://docs.google.com/spreadsheets/d/${ID}/edit`;
  test.each([403, 404])('returns needsPicker on %i', async (status) => {
    global.fetch = jest.fn().mockResolvedValue(res(status, { error: { message: 'nope' } }));
    const r = await addSheet(url);
    expect(r).toMatchObject({ success: false, needsPicker: true, spreadsheetId: ID });
  });
  test('plain error when picker unavailable', async () => {
    await storage.saveOAuthClientId('mine.apps.googleusercontent.com');
    global.fetch = jest.fn().mockResolvedValue(res(403, {}));
    const r = await addSheet(url);
    expect(r.success).toBe(false);
    expect(r.needsPicker).toBeUndefined();
    expect(r.error).toMatch(/Create tracker sheet/);
  });
});

describe('onMessageExternal handler', () => {
  const msg = { type: 'SHEETS_PICKED', files: [{ id: ID, name: 'x' }] };

  test('rejects wrong origin and wrong path', async () => {
    for (const sender of [
      { origin: 'https://evil.example', url: 'https://evil.example/picker/' },
      { origin: 'https://jobtracker.jayshah.xyz', url: 'https://jobtracker.jayshah.xyz/other' },
      undefined,
    ]) {
      expect((await handlePickerExternalMessage(msg, sender)).success).toBe(false);
    }
  });
  test('rejects unknown type, bad ids and too many files', async () => {
    expect((await handlePickerExternalMessage({ type: 'X' }, goodSender)).success).toBe(false);
    expect(validatePickedFiles([{ id: 'short' }]).error).toMatch(/invalid/);
    expect(validatePickedFiles([{ id: 'a/../' + ID }]).error).toBeTruthy();
    const many = Array.from({ length: 21 }, (_, i) => ({ id: String(i).padStart(25, 'z') }));
    expect(validatePickedFiles(many).error).toMatch(/at most/);
  });
  test('signed out gives a clear error', async () => {
    await storage.clearGoogleToken();
    const r = await handlePickerExternalMessage(msg, goodSender);
    expect(r).toMatchObject({ success: false, added: 0 });
    expect(r.error).toMatch(/sign in/i);
  });
  test('adds a picked sheet, dedupes on repeat, broadcasts update', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('?fields=')) {
        return res(200, { properties: { title: 'My sheet' }, sheets: [{ properties: { sheetId: 0, title: 'Tab', index: 0 } }] });
      }
      return res(200, { values: [['Company Name', 'Role'], ['A', 'B']] });
    });
    const first = await handlePickerExternalMessage(msg, goodSender);
    expect(first).toMatchObject({ success: true, added: 1 });
    expect((await storage.getConfiguredSheets())[0].name).toBe('My sheet');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'SHEETS_UPDATED' });
    const second = await handlePickerExternalMessage(msg, goodSender);
    expect(second).toMatchObject({ success: true, added: 0 });
    expect(await storage.getConfiguredSheets()).toHaveLength(1);
  });
  test('re-picking a needsAccess sheet reconnects it and clears the flag', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('?fields=')) {
        return res(200, { properties: { title: 'My sheet' }, sheets: [{ properties: { sheetId: 0, title: 'Tab', index: 0 } }] });
      }
      return res(200, { values: [['Company Name', 'Role'], ['A', 'B']] });
    });
    await handlePickerExternalMessage(msg, goodSender);
    const [sheet] = await storage.getConfiguredSheets();
    await storage.saveConfiguredSheets([{ ...sheet, needsAccess: true }]);
    const r = await handlePickerExternalMessage(msg, goodSender);
    expect(r).toMatchObject({ success: true, added: 1 });
    const sheets = await storage.getConfiguredSheets();
    expect(sheets).toHaveLength(1);
    expect(sheets[0].needsAccess).toBeFalsy();
  });
  test('reports files Google still denies', async () => {
    global.fetch = jest.fn().mockResolvedValue(res(403, {}));
    const r = await handlePickerExternalMessage(msg, goodSender);
    expect(r).toMatchObject({ success: false, added: 0 });
  });
});

describe('createSpreadsheet', () => {
  test('POSTs title and one Applications tab', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res(200, { spreadsheetId: ID, spreadsheetUrl: 'u', properties: { title: 'T' } })
    );
    const out = await createSpreadsheet('tok', { title: 'T' });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://sheets.googleapis.com/v4/spreadsheets');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(opts.body)).toEqual({
      properties: { title: 'T' },
      sheets: [{ properties: { title: 'Applications' } }],
    });
    expect(out).toEqual({ spreadsheetId: ID, spreadsheetUrl: 'u', title: 'T' });
  });
  test('CREATE_SHEET creates, seeds headers and stores the sheet', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, opts = {}) => {
      calls.push([opts.method || 'GET', url]);
      if (opts.method === 'POST') {
        return res(200, { spreadsheetId: ID, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${ID}/edit`, properties: { title: 'Job Tracker' } });
      }
      if (url.includes('?fields=')) {
        return res(200, { properties: { title: 'Job Tracker' }, sheets: [{ properties: { sheetId: 0, title: 'Applications', index: 0 } }] });
      }
      return res(200, { values: [] });
    });
    const r = await createTrackerSheet();
    expect(r.success).toBe(true);
    expect(r.spreadsheetUrl).toContain(ID);
    expect(r.sheet.tabs[0].headers.length).toBeGreaterThan(0);
    expect(calls.some(([m]) => m === 'PUT')).toBe(true);
    expect(await storage.getConfiguredSheets()).toHaveLength(1);
  });
});
