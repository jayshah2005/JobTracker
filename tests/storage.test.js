import {
  getConfiguredSheets,
  saveConfiguredSheets,
  getSettings,
  saveSettings,
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
    expect(settings.defaultApplicationStatus).toBe('Applied');
    expect(settings.autoShowPopup).toBe(true);
  });

  test('persists setting overrides', async () => {
    await saveSettings({ defaultApplicationStatus: 'Interviewing' });
    const settings = await getSettings();
    expect(settings.defaultApplicationStatus).toBe('Interviewing');
    expect(settings.autoShowPopup).toBe(true);
  });
});
