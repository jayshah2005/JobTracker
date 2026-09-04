/**
 * Parse a Google Sheets URL and extract spreadsheet ID and optional tab (gid).
 * Supports formats:
 *   https://docs.google.com/spreadsheets/d/{id}/edit
 *   https://docs.google.com/spreadsheets/d/{id}/edit#gid=123
 *   https://docs.google.com/spreadsheets/d/{id}/edit?gid=123
 */
export function parseGoogleSheetUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Please enter a valid Google Sheets URL.' };
  }

  const trimmed = url.trim();
  const match = trimmed.match(
    /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/
  );

  if (!match) {
    return { valid: false, error: 'URL must be a Google Sheets link (docs.google.com/spreadsheets/...).' };
  }

  const spreadsheetId = match[1];
  let gid = null;

  const gidHash = trimmed.match(/[#&?]gid=(\d+)/);
  if (gidHash) {
    gid = gidHash[1];
  }

  return { valid: true, spreadsheetId, gid, url: trimmed };
}

export function buildSheetUrl(spreadsheetId, gid) {
  let url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  if (gid != null) {
    url += `#gid=${gid}`;
  }
  return url;
}
