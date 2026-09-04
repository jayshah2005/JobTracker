import {
  parseGoogleSheetUrl,
  buildSheetUrl,
} from '../lib/sheet-url.js';

describe('parseGoogleSheetUrl', () => {
  test('parses standard spreadsheet URL', () => {
    const url =
      'https://docs.google.com/spreadsheets/d/abc123XYZ/edit#gid=0';
    const result = parseGoogleSheetUrl(url);
    expect(result.valid).toBe(true);
    expect(result.spreadsheetId).toBe('abc123XYZ');
    expect(result.gid).toBe('0');
  });

  test('parses URL with gid query param', () => {
    const url =
      'https://docs.google.com/spreadsheets/d/sheet-id-99/edit?gid=456789';
    const result = parseGoogleSheetUrl(url);
    expect(result.valid).toBe(true);
    expect(result.spreadsheetId).toBe('sheet-id-99');
    expect(result.gid).toBe('456789');
  });

  test('rejects non-Google URLs', () => {
    const result = parseGoogleSheetUrl('https://example.com/sheet');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('rejects empty input', () => {
    expect(parseGoogleSheetUrl('').valid).toBe(false);
    expect(parseGoogleSheetUrl(null).valid).toBe(false);
  });

  test('buildSheetUrl reconstructs URL', () => {
    expect(buildSheetUrl('abc', '123')).toBe(
      'https://docs.google.com/spreadsheets/d/abc/edit#gid=123'
    );
  });
});
