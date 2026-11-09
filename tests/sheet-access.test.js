/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import {
  isPickerAvailable,
  classifyAddResult,
  findAddedSheets,
  describeAdded,
  NEEDS_PICKER_MESSAGE,
} from '../sidepanel/sheet-access.js';

describe('sheet-access helpers', () => {
  test('isPickerAvailable defaults to true unless explicitly false', () => {
    expect(isPickerAvailable(undefined)).toBe(true);
    expect(isPickerAvailable({})).toBe(true);
    expect(isPickerAvailable({ pickerAvailable: true })).toBe(true);
    expect(isPickerAvailable({ pickerAvailable: false })).toBe(false);
  });

  test('classifyAddResult', () => {
    expect(classifyAddResult({ success: true }).kind).toBe('success');
    expect(classifyAddResult({ success: false, needsPicker: true, spreadsheetId: 'abc' })).toEqual({
      kind: 'needsPicker',
      spreadsheetId: 'abc',
      message: NEEDS_PICKER_MESSAGE,
    });
    expect(classifyAddResult({ success: false, error: 'Nope' })).toEqual({ kind: 'error', message: 'Nope' });
    expect(classifyAddResult(undefined).kind).toBe('error');
  });

  test('findAddedSheets and describeAdded', () => {
    const prev = [{ spreadsheetId: 'a', name: 'A' }];
    const next = [...prev, { spreadsheetId: 'b', name: 'B' }];
    expect(findAddedSheets(prev, next)).toEqual([{ spreadsheetId: 'b', name: 'B' }]);
    expect(findAddedSheets(undefined, next)).toHaveLength(2);
    expect(findAddedSheets(next, undefined)).toEqual([]);
    expect(describeAdded([])).toBe('');
    expect(describeAdded([{ spreadsheetId: 'b', name: 'B' }])).toBe('Added “B”.');
  });
});

describe('createSheetAccess announcements', () => {
  const makeEls = () => {
    const mk = () => document.createElement('button');
    return { create: mk(), choose: mk(), grant: mk(), hint: document.createElement('p'), note: document.createElement('p') };
  };

  test('create + storage event announce a new sheet once', async () => {
    const { createSheetAccess } = await import('../sidepanel/sheet-access.js');
    let storageCb;
    global.chrome = {
      storage: { onChanged: { addListener: (cb) => (storageCb = cb) } },
      runtime: { onMessage: { addListener: () => {} } },
    };
    const sheet = { spreadsheetId: 'abc', name: 'Tracker' };
    const onSheetsChanged = jest.fn();
    const els = makeEls();
    createSheetAccess({
      sendMessage: async () => ({ success: true, sheet, sheets: [sheet] }),
      showStatus: () => {},
      getSheets: () => [],
      onSheetsChanged,
      els,
    });
    storageCb({ configuredSheets: { newValue: [sheet] } }, 'local');
    els.create.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(onSheetsChanged).toHaveBeenCalledTimes(1);
    expect(els.create.disabled).toBe(false);
    delete global.chrome;
  });
});

import { sheetsNeedingAccess, needsAccessKey, applyAccessFlags } from '../sidepanel/sheet-access.js';

describe('needsAccess helpers', () => {
  const a = { spreadsheetId: 'a', needsAccess: true };
  const b = { spreadsheetId: 'b', needsAccess: false };
  test('filters and keys', () => {
    expect(sheetsNeedingAccess([a, b, undefined])).toEqual([a]);
    expect(needsAccessKey([b, a])).toBe('a');
    expect(needsAccessKey(undefined)).toBe('');
  });
  test('applyAccessFlags copies only the flag', () => {
    const cur = [{ spreadsheetId: 'a', name: 'A' }, { spreadsheetId: 'c', name: 'C', needsAccess: true }];
    const out = applyAccessFlags(cur, [a]);
    expect(out[0]).toEqual({ spreadsheetId: 'a', name: 'A', needsAccess: true });
    expect(out[1]).toBe(cur[1]);
  });
});

describe('createSheetAccess re-grant of a known sheet', () => {
  test('clears the picker wait hint and reports the access change', async () => {
    const { createSheetAccess } = await import('../sidepanel/sheet-access.js');
    let storageCb;
    global.chrome = {
      storage: { onChanged: { addListener: (cb) => (storageCb = cb) } },
      runtime: { onMessage: { addListener: () => {} } },
    };
    const mk = () => document.createElement('button');
    const els = { create: mk(), choose: mk(), grant: mk(), hint: document.createElement('p'), note: document.createElement('p') };
    const known = [{ spreadsheetId: 'abc', name: 'T', needsAccess: true }];
    const onAccessChanged = jest.fn();
    const sa = createSheetAccess({
      sendMessage: async () => ({ success: true }),
      showStatus: () => {},
      getSheets: () => known,
      onSheetsChanged: jest.fn(),
      onAccessChanged,
      els,
    });
    await sa.openPicker(els.choose);
    expect(els.hint.classList.contains('hidden')).toBe(false);
    storageCb({ configuredSheets: { newValue: [{ spreadsheetId: 'abc', name: 'T', needsAccess: false }] } }, 'local');
    await new Promise((r) => setTimeout(r, 0));
    expect(onAccessChanged).toHaveBeenCalledTimes(1);
    expect(els.hint.classList.contains('hidden')).toBe(true);
    delete global.chrome;
  });
});
