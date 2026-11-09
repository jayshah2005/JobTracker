/** @jest-environment jsdom */
/**
 * Drives the real sidepanel.js + sidepanel.html with a mocked chrome and a
 * scripted service worker: save -> applied view -> delete, stale-state guards.
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { sheetsWereRemoved } from '../sidepanel/sheet-access.js';

const html = fs.readFileSync(path.resolve('sidepanel/sidepanel.html'), 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('</body>')).replace(/<script[^>]*><\/script>/g, '');

const mappings = [
  { columnIndex: 0, header: 'Company', tag: 'company_name' },
  { columnIndex: 1, header: 'Notes', tag: 'custom_textbox' },
];
const sheet = (id, name, gid = 11) => ({
  spreadsheetId: id,
  name,
  url: `https://docs.google.com/spreadsheets/d/${id}`,
  tabs: [{ tabName: 'Jobs', gid, tabId: gid, mappings, headers: ['Company', 'Notes'] }],
});

let runId = 0;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, n = 60) => {
  for (let i = 0; i < n; i += 1) {
    if (fn()) return;
    await tick(5);
  }
  throw new Error('timeout waiting for condition');
};

async function boot(handlers = {}, view = 'save') {
  jest.resetModules();
  document.body.innerHTML = body.replace(/^<body[^>]*>/, '');
  const sent = [];
  const sheets = handlers.sheets || [sheet('A'.repeat(25), 'Tracker')];
  const defaults = {
    GET_AUTH_STATUS: () => ({ signedIn: true, pickerAvailable: true }),
    GET_SHEETS: () => ({ success: true, sheets }),
    REFRESH_SHEETS: () => ({ success: true, sheets }),
    GET_TAB_JOB_DATA: () => ({ data: { url: 'https://example.com/jobs/1', company: 'Acme', role: 'Dev' } }),
    FIND_APPLICATION: () => ({ matched: false }),
    SAVE_JOB: () => ({ success: true, rowIndex: 4, row: ['Acme', ''], rowFingerprint: 'fp' }),
    DELETE_JOB: () => ({ success: true }),
  };
  const table = { ...defaults, ...handlers };
  const store = {};
  global.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://x/${p}`,
      openOptionsPage: jest.fn(),
      onMessage: { addListener: jest.fn() },
      sendMessage: jest.fn((msg, cb) => {
        sent.push(msg);
        const h = table[msg.type];
        const res = h ? h(msg) : { success: true };
        if (cb) setTimeout(() => cb(res), 0);
        else return Promise.resolve(res);
      }),
    },
    tabs: {
      query: jest.fn(async () => [{ id: 1, url: 'https://example.com/jobs/1' }]),
      get: jest.fn(async () => ({ id: 1, url: 'https://example.com/jobs/1' })),
      create: jest.fn(),
      onUpdated: { addListener: jest.fn() },
      onRemoved: { addListener: jest.fn() },
    },
    storage: {
      local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) },
      session: {
        get: jest.fn(async (k) => (typeof k === 'string' ? { [k]: store[k] } : {})),
        set: jest.fn(async (o) => Object.assign(store, o)),
        remove: jest.fn(async (k) => delete store[k]),
      },
      onChanged: { addListener: jest.fn() },
    },
  };
  await import(`../sidepanel/sidepanel.js?run=${++runId}`);
  await until(() => !document.querySelector(`#${view}-view`).classList.contains('hidden'));
  return { sent, store };
}

describe('sidepanel flows', () => {
  test('save then delete from the applied view targets the saved sheet and tab', async () => {
    const { sent } = await boot();
    document.querySelector('#save-btn').click();
    await until(() => !document.querySelector('#applied-view').classList.contains('hidden'));
    expect(document.querySelector('#save-btn').disabled).toBe(false);

    // confirmDialog is a real DOM dialog: confirm it.
    const del = document.querySelector('#delete-existing-btn');
    del.click();
    await until(() => document.querySelector('.jt-dialog'));
    document.querySelector('.jt-dialog-btn-danger').click();
    await until(() => sent.some((m) => m.type === 'DELETE_JOB'));
    const msg = sent.find((m) => m.type === 'DELETE_JOB');
    expect(msg.spreadsheetId).toBe('A'.repeat(25));
    expect(msg.tabId).toBe(11); // regression: used to be `false` outside edit mode
    expect(msg.rowIndex).toBe(4);
    // Let the post-delete reload finish so it cannot touch the next test's DOM.
    await until(() => !document.querySelector('#save-view').classList.contains('hidden'));
    await tick(20);
  });

  test('a rejected draft write cannot leave Save stuck busy', async () => {
    await boot();
    chrome.storage.session.set.mockRejectedValue(new Error('quota'));
    document.querySelector('#save-btn').click();
    await until(() => !document.querySelector('#applied-view').classList.contains('hidden'));
    expect(document.querySelector('#save-btn').hasAttribute('aria-busy')).toBe(false);
  });

  test('Add sheet ignores a second Enter while a request is in flight', async () => {
    let calls = 0;
    const { sent } = await boot(
      {
        GET_SHEETS: () => ({ success: true, sheets: [] }),
        REFRESH_SHEETS: () => ({ success: true, sheets: [] }),
        ADD_SHEET: () => {
          calls += 1;
          return { success: false, error: 'nope' };
        },
      },
      'setup'
    );
    const input = document.querySelector('#setup-sheet-url');
    input.value = 'https://docs.google.com/spreadsheets/d/' + 'B'.repeat(30);
    const enter = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    enter();
    enter();
    await until(() => !document.querySelector('#add-sheet-btn').disabled);
    expect(calls).toBe(1);
    expect(sent.filter((m) => m.type === 'ADD_SHEET')).toHaveLength(1);
  });

  const navigate = (url) => {
    chrome.tabs.get.mockImplementation(async () => ({ id: 1, url }));
    const [listener] = chrome.tabs.onUpdated.addListener.mock.calls[0];
    listener(1, { status: 'complete', url }, { id: 1, url });
  };
  const jobFor = (msg) => ({
    data: { url: msg.url, company: msg.url.endsWith('/2') ? 'Beta' : 'Acme', role: 'Dev' },
  });

  test('navigating to a different job clears the saved confirmation and reloads the form', async () => {
    await boot({ GET_TAB_JOB_DATA: jobFor });
    document.querySelector('#save-btn').click();
    await until(() => !document.querySelector('#applied-view').classList.contains('hidden'));
    expect(document.querySelector('#status').textContent).toMatch(/Saved/);

    // Same posting (e.g. a reload) keeps the confirmation.
    navigate('https://example.com/jobs/1');
    await tick(500);
    expect(document.querySelector('#applied-view').classList.contains('hidden')).toBe(false);

    navigate('https://example.com/jobs/2');
    await until(() => document.querySelector('#applied-view').classList.contains('hidden'), 200);
    await until(() => !document.querySelector('#save-view').classList.contains('hidden'));
    expect(document.querySelector('#status').textContent).toBe('');
    expect(document.querySelector('#job-card')?.textContent || document.body.textContent).toMatch(/Beta/);
  });

  test('a duplicate answer for a job the panel already left does not open edit mode', async () => {
    let release;
    const { sent } = await boot({
      GET_TAB_JOB_DATA: jobFor,
      SAVE_JOB: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    document.querySelector('#save-btn').click();
    await until(() => sent.some((m) => m.type === 'SAVE_JOB'));
    navigate('https://example.com/jobs/2');
    await until(() => sent.filter((m) => m.type === 'GET_TAB_JOB_DATA').length >= 2, 200);
    release({ alreadyApplied: true, match: { matched: true, rowIndex: 7, row: ['Acme', ''] }, error: 'dup' });
    await tick(50);
    expect(document.querySelector('#save-btn-label').textContent).toBe('Save to tracker');
    expect(document.querySelector('#status').textContent).toMatch(/already in the sheet you saved to|dup/);
    expect(document.querySelector('#save-btn').disabled).toBe(false);
  });

  test('Save ignores a second click while the first is still in flight', async () => {
    let release;
    const { sent } = await boot({
      SAVE_JOB: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    const btn = document.querySelector('#save-btn');
    btn.click();
    btn.click();
    await until(() => sent.some((m) => m.type === 'SAVE_JOB'));
    expect(sent.filter((m) => m.type === 'SAVE_JOB')).toHaveLength(1);
    release({ success: true, rowIndex: 4, row: ['Acme', ''] });
    await until(() => !document.querySelector('#applied-view').classList.contains('hidden'));
  });

  test('disconnecting a sheet in Settings reloads the panel once', async () => {
    const { sent } = await boot();
    const before = sent.filter((m) => m.type === 'GET_SHEETS').length;
    const listener = (...args) =>
      chrome.storage.onChanged.addListener.mock.calls.forEach(([fn]) => fn(...args));
    listener({ configuredSheets: { newValue: [] } }, 'local');
    await tick(400);
    expect(sent.filter((m) => m.type === 'GET_SHEETS').length).toBe(before + 1);
    // A needsAccess flag flip keeps every sheet: no reload.
    listener({ configuredSheets: { newValue: [{ spreadsheetId: 'A'.repeat(25) }] } }, 'local');
    await tick(400);
    expect(sent.filter((m) => m.type === 'GET_SHEETS').length).toBe(before + 1);
  });

  test('sheetsWereRemoved', () => {
    expect(sheetsWereRemoved([{ spreadsheetId: 'a' }], [])).toBe(true);
    expect(sheetsWereRemoved([{ spreadsheetId: 'a' }], undefined)).toBe(true);
    expect(sheetsWereRemoved([{ spreadsheetId: 'a' }], [{ spreadsheetId: 'a' }, { spreadsheetId: 'b' }])).toBe(false);
    expect(sheetsWereRemoved([], [{ spreadsheetId: 'b' }])).toBe(false);
  });
});
