import {
  getConfiguredSheets,
  saveConfiguredSheets,
  getSettings,
  saveSettings,
  destinationKey,
  resolveDefaultDestination,
  clearDefaultDestinationForSheet,
  _resetMemoryStore,
} from '../lib/storage.js';

describe('storage', () => {
  beforeEach(() => {
    _resetMemoryStore();
  });

  test('returns empty sheets by default', async () => {
    const sheets = await getConfiguredSheets();
    expect(sheets).toEqual([]);
  });

  test('saves and retrieves sheets', async () => {
    const data = [{ spreadsheetId: 'abc', url: 'http://x.com' }];
    await saveConfiguredSheets(data);
    expect(await getConfiguredSheets()).toEqual(data);
  });

  test('merges settings with defaults', async () => {
    const settings = await getSettings();
    expect(settings.autoShowPopup).toBe(true);
    expect(settings.embedRoleHyperlink).toBe(true);
  });

  test('persists setting overrides', async () => {
    await saveSettings({ embedRoleHyperlink: false });
    const settings = await getSettings();
    expect(settings.embedRoleHyperlink).toBe(false);
    expect(settings.autoShowPopup).toBe(true);
  });

  describe('default destination', () => {
    const dests = [
      { sheetId: 's1', gid: 0 },
      { sheetId: 's1', gid: 7 },
      { sheetId: 's2', gid: 3 },
    ];

    test('defaults to empty and persists', async () => {
      expect((await getSettings()).defaultDestination).toBe('');
      await saveSettings({ defaultDestination: 's2:3' });
      expect((await getSettings()).defaultDestination).toBe('s2:3');
      expect((await getSettings()).autoShowPopup).toBe(true);
    });

    test('resolves saved key, falls back when blank or stale', () => {
      expect(destinationKey(dests[1])).toBe('s1:7');
      expect(resolveDefaultDestination(dests, 's2:3')).toBe(dests[2]);
      expect(resolveDefaultDestination(dests, '')).toBe(dests[0]);
      expect(resolveDefaultDestination(dests, 'gone:1')).toBe(dests[0]);
      expect(resolveDefaultDestination([], 's1:0')).toBeNull();
    });

    test('clears default only for the removed spreadsheet', async () => {
      await saveSettings({ defaultDestination: 's2:3' });
      expect(await clearDefaultDestinationForSheet('s1')).toBe(false);
      expect((await getSettings()).defaultDestination).toBe('s2:3');
      expect(await clearDefaultDestinationForSheet('s2')).toBe(true);
      expect((await getSettings()).defaultDestination).toBe('');
    });
  });
});
