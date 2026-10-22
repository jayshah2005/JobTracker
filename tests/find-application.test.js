import { jest } from '@jest/globals';
import { findApplication } from '../background/sheets-orchestrator.js';
import {
  saveGoogleToken,
  saveConfiguredSheets,
  saveOAuthClientId,
  _resetMemoryStore,
} from '../lib/storage.js';
import { FIELD_TAGS } from '../lib/constants.js';

const mappings = [
  { columnIndex: 0, header: 'Company', tag: FIELD_TAGS.COMPANY_NAME },
  { columnIndex: 1, header: 'Role', tag: FIELD_TAGS.ROLE },
];
const cfg = (id, tabs) => ({
  spreadsheetId: id,
  name: `Book ${id}`,
  tabs: tabs.map((gid) => ({ gid: String(gid), tabId: `t${gid}`, tabName: `Tab${gid}`, mappings })),
});

describe('findApplication', () => {
  let calls;
  const realFetch = global.fetch;

  beforeEach(async () => {
    _resetMemoryStore();
    await saveOAuthClientId('abc.apps.googleusercontent.com');
    await saveGoogleToken({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    await saveConfiguredSheets([cfg('A', [1, 2]), cfg('B', [3, 4])]);
    calls = [];
    // Only B/Tab4 holds the job.
    global.fetch = jest.fn(async (url) => {
      const u = decodeURIComponent(String(url));
      calls.push(u);
      const sheetId = u.match(/spreadsheets\/([^/?]+)/)[1];
      if (!u.includes('/values/')) {
        const ids = sheetId === 'A' ? [1, 2] : [3, 4];
        return {
          ok: true,
          json: async () => ({
            sheets: ids.map((id) => ({ properties: { sheetId: id, title: `Tab${id}` } })),
          }),
        };
      }
      const hit = sheetId === 'B' && u.includes('Tab4');
      return {
        ok: true,
        json: async () => ({
          values: [['Company', 'Role'], ...(hit ? [['Acme', 'Engineer']] : [['Other', 'Thing']])],
        }),
      };
    });
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  const job = { company: 'Acme', role: 'Engineer' };

  test('returns the destination that matched', async () => {
    const res = await findApplication(job);
    expect(res).toMatchObject({ success: true, matched: true, spreadsheetId: 'B', gid: '4', tabName: 'Tab4' });
  });

  test('preferred destination is searched first and stops early', async () => {
    const res = await findApplication(job, ['B:4']);
    expect(res.matched).toBe(true);
    const valueReads = calls.filter((u) => u.includes('/values/'));
    expect(valueReads).toHaveLength(1);
    expect(valueReads[0]).toContain('Tab4');
  });

  test('no match returns matched:false', async () => {
    const res = await findApplication({ company: 'Nope', role: 'Nada' });
    expect(res).toEqual({ success: true, matched: false });
  });
});
