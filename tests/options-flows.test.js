/** @jest-environment jsdom */
/** Drives the real options.js + options.html with a mocked chrome / service worker. */
import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve('options/options.html'), 'utf8');
const body = html.slice(html.indexOf('<body'), html.indexOf('</body>')).replace(/<script[^>]*><\/script>/g, '');
const ID = 'A'.repeat(25);

const mappings = [
  { columnIndex: 0, header: 'Company', tag: 'company_name' },
  { columnIndex: 1, header: 'Status', tag: 'custom_dropdown', dropdownOptions: [] },
  { columnIndex: 2, header: 'Notes', tag: 'custom_textbox' },
];
const sheets = () => [
  {
    spreadsheetId: ID,
    name: 'Tracker',
    url: `https://docs.google.com/spreadsheets/d/${ID}`,
    tabs: [{ tabName: 'Jobs', gid: 7, tabId: 7, rowCount: 3, mappings: JSON.parse(JSON.stringify(mappings)), headers: ['Company', 'Status', 'Notes'] }],
  },
];

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, n = 80) => {
  for (let i = 0; i < n; i += 1) {
    if (fn()) return;
    await tick(5);
  }
  throw new Error('timeout waiting for condition');
};
let runId = 0;

async function boot(handlers = {}) {
  document.body.innerHTML = body.replace(/^<body[^>]*>/, '');
  const sent = [];
  const table = {
    GET_AUTH_STATUS: () => ({ signedIn: true, pickerAvailable: true }),
    GET_SHEETS: () => ({ success: true, sheets: sheets() }),
    REFRESH_SHEETS: () => ({ success: true, sheets: sheets() }),
    GET_UNDO_STACK: () => ({ stack: [], redoStack: [] }),
    SYNC_TAB_COLUMN_UNIQUES: () => ({ success: true, sheets: sheets() }),
    APPLY_SCHEMA_CHANGE: () => ({ success: true, sheets: sheets(), stack: [], redoStack: [] }),
    ...handlers,
  };
  global.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => p,
      onMessage: { addListener: jest.fn() },
      sendMessage: jest.fn((msg, cb) => {
        sent.push(msg);
        const res = (table[msg.type] || (() => ({ success: true })))(msg);
        setTimeout(() => cb(res), 0);
      }),
    },
    tabs: { create: jest.fn() },
    storage: {
      local: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) },
      onChanged: { addListener: jest.fn() },
    },
  };
  await import(`../options/options.js?run=${++runId}`);
  await until(() => document.querySelector('.mapping-row'));
  await tick(30);
  return { sent };
}

describe('options flows', () => {
  test('keyboard focus survives the re-render after moving a column', async () => {
    await boot();
    const down = document.querySelector('[data-col-action="down"][data-col="0"]');
    down.focus();
    down.click();
    await until(() => document.activeElement && document.activeElement !== document.body);
    expect(document.activeElement.dataset.colAction).toBe('down');
  });

  test('opening a dropdown editor on an empty column syncs once, not in a loop', async () => {
    const { sent } = await boot();
    const before = sent.filter((m) => m.type === 'SYNC_TAB_COLUMN_UNIQUES').length;
    const details = document.querySelector('details.dd-editor');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await tick(150);
    const after = sent.filter((m) => m.type === 'SYNC_TAB_COLUMN_UNIQUES').length;
    expect(after - before).toBeLessThanOrEqual(1);
  });

  test('add sheet ignores a second Enter while the first is running', async () => {
    let adds = 0;
    const { sent } = await boot({
      ADD_SHEET: () => {
        adds += 1;
        return { success: false, error: 'nope' };
      },
    });
    const input = document.querySelector('#sheet-url');
    input.value = `https://docs.google.com/spreadsheets/d/${'B'.repeat(30)}`;
    const enter = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    enter();
    enter();
    await until(() => !document.querySelector('#add-sheet-btn').disabled);
    expect(adds).toBe(1);
    expect(sent.filter((m) => m.type === 'ADD_SHEET')).toHaveLength(1);
  });

  test('sendMessage survives a throwing chrome.runtime (extension reloaded)', async () => {
    await boot();
    chrome.runtime.sendMessage.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    document.querySelector('#refresh-btn').click();
    await until(() => /invalidated/i.test(document.querySelector('#status').textContent));
    expect(document.querySelector('#refresh-btn').disabled).toBe(false);
  });
});
