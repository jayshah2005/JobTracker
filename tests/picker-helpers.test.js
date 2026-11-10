import {
  isValidExtId,
  isValidSheetId,
  parseSheetIds,
  parsePickerQuery,
  toPickedFiles,
} from '../picker/helpers.js';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const ID = '1AbC_dEf-GhIjKlMnOpQrStUvWxYz0123456789';

describe('picker helpers', () => {
  test('isValidExtId', () => {
    expect(isValidExtId(EXT)).toBe(true);
    expect(isValidExtId(EXT.slice(1))).toBe(false);
    expect(isValidExtId('q'.repeat(32))).toBe(false);
    expect(isValidExtId(null)).toBe(false);
  });

  test('isValidSheetId', () => {
    expect(isValidSheetId(ID)).toBe(true);
    expect(isValidSheetId('short')).toBe(false);
    expect(isValidSheetId('has space and more chars here')).toBe(false);
  });

  test('parseSheetIds drops invalid and duplicate ids', () => {
    expect(parseSheetIds(`${ID}, bad ,${ID},${ID}x`)).toEqual([ID, `${ID}x`]);
    expect(parseSheetIds('')).toEqual([]);
    expect(parseSheetIds(undefined)).toEqual([]);
  });

  test('parsePickerQuery', () => {
    expect(parsePickerQuery(`?ext=${EXT}&ids=${ID}`)).toEqual({ extId: EXT, ids: [ID], error: null });
    expect(parsePickerQuery(`?ext=${EXT}`).ids).toEqual([]);
    expect(parsePickerQuery('?ext=nope').error).toBe('invalid-ext');
    expect(parsePickerQuery('').error).toBe('invalid-ext');
  });

  test('toPickedFiles', () => {
    expect(toPickedFiles([{ id: ID, name: 'Jobs', extra: 1 }, { id: 'x' }, null, { id: ID }])).toEqual([
      { id: ID, name: 'Jobs' },
      { id: ID, name: 'Untitled' },
    ]);
    expect(toPickedFiles(undefined)).toEqual([]);
  });
});
