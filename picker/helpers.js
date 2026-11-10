// Pure helpers for the hosted Picker page (no DOM, no globals).

export const EXT_ID_RE = /^[a-p]{32}$/;
export const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,}$/;
export const MAX_IDS = 50;

export function isValidExtId(value) {
  return typeof value === 'string' && EXT_ID_RE.test(value);
}

export function isValidSheetId(value) {
  return typeof value === 'string' && SHEET_ID_RE.test(value);
}

/** Split a comma-separated list, keep only valid, de-duplicated spreadsheet ids. */
export function parseSheetIds(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  const seen = new Set();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (isValidSheetId(id)) seen.add(id);
    if (seen.size >= MAX_IDS) break;
  }
  return [...seen];
}

/** Parse `?ext=<id>&ids=a,b` into { extId, ids, error }. */
export function parsePickerQuery(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const ext = (params.get('ext') || '').trim();
  if (!isValidExtId(ext)) {
    return { extId: null, ids: [], error: 'invalid-ext' };
  }
  return { extId: ext, ids: parseSheetIds(params.get('ids') || ''), error: null };
}

/** Keep only {id, name} for valid picked docs. */
export function toPickedFiles(docs) {
  if (!Array.isArray(docs)) return [];
  return docs
    .filter((d) => d && isValidSheetId(d.id))
    .map((d) => ({ id: d.id, name: typeof d.name === 'string' && d.name ? d.name : 'Untitled' }));
}
