/**
 * Google Sheets API client (thin fetch wrappers; no chrome.* APIs).
 * Every function takes the bearer token from the signed-in Google account.
 * Row indexes passed in/out are 0-based positions in the values grid
 * (row 0 = header row); the A1 notation used on the wire is 1-based.
 * Failed requests throw an Error carrying `.status` (HTTP code) so callers can
 * detect an expired token without parsing message text.
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Fetch the spreadsheet title and its tab list (ids, titles). */
export async function fetchSpreadsheetMetadata(spreadsheetId, token) {
  const url = `${SHEETS_API}/${spreadsheetId}?fields=properties(title),sheets(properties(sheetId,title,index))`;
  return apiRequest(url, token);
}

/** Read a range; resolves to a 2D array (empty when the range has no data). */
export function fetchSheetValues(
  spreadsheetId,
  range,
  token,
  { valueRenderOption = 'FORMATTED_VALUE' } = {}
) {
  const encoded = encodeURIComponent(range);
  const params = new URLSearchParams({ valueRenderOption });
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encoded}?${params}`;
  return apiRequest(url, token).then((res) => res.values ?? []);
}

/**
 * Append one row after the last data row. USER_ENTERED so formulas such as
 * HYPERLINK(...) and dates are parsed as if typed into the sheet.
 */
export async function appendRow(spreadsheetId, range, row, token) {
  const encoded = encodeURIComponent(range);
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encoded}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  return apiRequest(url, token, {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  });
}

/**
 * Overwrite an existing row (0-based index in the values grid, including header).
 */
export async function updateRow(spreadsheetId, tabName, rowIndex, row, token) {
  const sheetRow = Number(rowIndex) + 1;
  if (!Number.isFinite(sheetRow) || sheetRow < 1) {
    throw new Error('Invalid row to update.');
  }
  const escapedTab = `'${String(tabName).replace(/'/g, "''")}'`;
  const endCol = columnLetter(Math.max(row.length, 1));
  const range = `${escapedTab}!A${sheetRow}:${endCol}${sheetRow}`;
  const encoded = encodeURIComponent(range);
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encoded}?valueInputOption=USER_ENTERED`;
  return apiRequest(url, token, {
    method: 'PUT',
    body: JSON.stringify({ values: [row] }),
  });
}

/** Write a single header row into `range`. */
export async function writeHeaders(spreadsheetId, range, headers, token) {
  const encoded = encodeURIComponent(range);
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encoded}?valueInputOption=USER_ENTERED`;
  return apiRequest(url, token, {
    method: 'PUT',
    body: JSON.stringify({ values: [headers] }),
  });
}

/**
 * Rename a worksheet tab (Google Sheets "sheet" / gid).
 */
export async function renameSheetTab(spreadsheetId, sheetId, title, token) {
  const numericId = Number(sheetId);
  if (!Number.isFinite(numericId)) {
    throw new Error('Invalid sheet tab id.');
  }
  const nextTitle = String(title || '').trim();
  if (!nextTitle) {
    throw new Error('Tab name cannot be empty.');
  }
  const url = `${SHEETS_API}/${spreadsheetId}:batchUpdate`;
  return apiRequest(url, token, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: numericId,
              title: nextTitle,
            },
            fields: 'title',
          },
        },
      ],
    }),
  });
}

/**
 * fetch + JSON with auth. On failure throws Error(message) with `.status`
 * set to the HTTP status (Google's own message is used when available).
 */
export async function apiRequest(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(
      err.error?.message || `Google Sheets API error: ${res.status}`
    );
    error.status = res.status;
    throw error;
  }

  return res.json();
}

/** Rows requested per read; one values.get request per chunk. */
export const ROW_CHUNK_SIZE = 500;
/** Stop paging once a chunk ends with at least this many consecutive blank rows. */
export const BLANK_RUN_STOP = 100;

function isBlankRow(row) {
  return !Array.isArray(row) || row.every((c) => String(c ?? '').trim() === '');
}

function trailingBlankRun(rows) {
  let n = 0;
  for (let i = rows.length - 1; i >= 0 && isBlankRow(rows[i]); i--) n++;
  return n;
}

/**
 * Read every row of a tab (columns A:ZZ) in chunks of ROW_CHUNK_SIZE rows.
 * Row i of the result is sheet row i+1 (row 0 = header). Sheets trims trailing
 * empty rows, so a full chunk means more data may follow; paging stops on a
 * short chunk, an entirely blank chunk, or a long trailing blank run.
 * Interior blank rows are kept as [] so indexes stay aligned.
 */
async function readAllRows(spreadsheetId, tabName, token, options = {}) {
  const escaped = `'${String(tabName).replace(/'/g, "''")}'`;
  const rows = [];
  for (let start = 1; ; start += ROW_CHUNK_SIZE) {
    const end = start + ROW_CHUNK_SIZE - 1;
    let chunk;
    try {
      chunk = await fetchSheetValues(
        spreadsheetId,
        `${escaped}!A${start}:ZZ${end}`,
        token,
        options
      );
    } catch (err) {
      // Next chunk starts past the grid (sheet has exactly N*chunk rows).
      if (start > 1 && err?.status === 400) break;
      throw err;
    }
    if (!chunk.length || chunk.every(isBlankRow)) break;
    rows.push(...chunk);
    if (chunk.length < ROW_CHUNK_SIZE) break;
    if (trailingBlankRun(chunk) >= BLANK_RUN_STOP) break;
  }
  return rows;
}

/**
 * Load all tabs and all of their rows for a spreadsheet.
 * Row-read failures are NOT swallowed: treating a failed read as an empty tab
 * would make the caller seed default headers over a real, populated sheet.
 */
export async function loadSpreadsheetTabs(spreadsheetId, token) {
  const meta = await fetchSpreadsheetMetadata(spreadsheetId, token);
  const sheets = meta.sheets ?? [];

  const tabs = [];
  for (const sheet of sheets) {
    const props = sheet.properties;
    const tabName = props.title;
    const gid = String(props.sheetId);
    const rows = await readAllRows(spreadsheetId, tabName, token);
    tabs.push({
      tabName,
      gid,
      tabId: gid,
      sheetId: props.sheetId,
      rows,
    });
  }

  return tabs;
}

/**
 * Load all rows (A:ZZ, chunked) for a single tab by its title.
 */
export async function loadTabRows(
  spreadsheetId,
  tabName,
  token,
  { valueRenderOption = 'FORMATTED_VALUE' } = {}
) {
  return readAllRows(spreadsheetId, tabName, token, { valueRenderOption });
}

/**
 * Parse a Sheets A1 range like `'Jobs'!A12:G12` into a 0-based row index.
 */
export function rowIndexFromUpdatedRange(updatedRange) {
  const raw = String(updatedRange || '');
  const match = raw.match(/![A-Z]+(\d+)/i);
  if (!match) return null;
  const sheetRow = Number(match[1]);
  if (!Number.isFinite(sheetRow) || sheetRow < 1) return null;
  return sheetRow - 1;
}

/**
 * Save a job row to the specified tab, creating headers if needed.
 * Returns the append API response (includes updates.updatedRange).
 */
export async function saveJobToTab(
  spreadsheetId,
  tabName,
  tabConfig,
  row,
  token
) {
  const escapedTab = `'${tabName.replace(/'/g, "''")}'`;

  if (tabConfig.isNew) {
    await seedTabHeaders(
      spreadsheetId,
      tabName,
      tabConfig.headers,
      token,
      { sheetId: tabConfig.sheetId ?? tabConfig.gid }
    );
    tabConfig.isNew = false;
  }

  const range = `${escapedTab}!A:A`;
  const appendRes = await appendRow(spreadsheetId, range, row, token);

  // Appends often inherit bold from the header row — force data cells plain.
  const sheetId = tabConfig.sheetId ?? tabConfig.gid;
  const rowIndex = rowIndexFromUpdatedRange(appendRes?.updates?.updatedRange);
  if (
    sheetId != null &&
    rowIndex != null &&
    rowIndex > 0 &&
    Array.isArray(row) &&
    row.length
  ) {
    try {
      await setRowsBold(
        spreadsheetId,
        sheetId,
        rowIndex,
        rowIndex + 1,
        row.length,
        false,
        token
      );
    } catch {
      // Formatting is best-effort; the row values were already written.
    }
  }

  return appendRes;
}

/**
 * Update an existing job row in place (0-based values index).
 */
export async function updateJobInTab(
  spreadsheetId,
  tabName,
  rowIndex,
  row,
  token
) {
  return updateRow(spreadsheetId, tabName, rowIndex, row, token);
}

/**
 * Delete a sheet row by 0-based values index (same indexing as updateRow).
 * Uses deleteDimension so rows below shift up.
 */
export async function deleteJobRowInTab(
  spreadsheetId,
  sheetId,
  rowIndex,
  token
) {
  const numericSheetId = Number(sheetId);
  const index = Number(rowIndex);
  if (!Number.isFinite(numericSheetId)) {
    throw new Error('Invalid sheet tab id.');
  }
  if (!Number.isFinite(index) || index < 0) {
    throw new Error('Invalid row to delete.');
  }
  if (index === 0) {
    throw new Error('Cannot delete the header row.');
  }

  const url = `${SHEETS_API}/${spreadsheetId}:batchUpdate`;
  return apiRequest(url, token, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: numericSheetId,
              dimension: 'ROWS',
              startIndex: index,
              endIndex: index + 1,
            },
          },
        },
      ],
    }),
  });
}

function batchUpdate(spreadsheetId, requests, token) {
  return apiRequest(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, token, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

function requireSheetId(sheetId) {
  const id = Number(sheetId);
  if (sheetId == null || sheetId === '' || !Number.isFinite(id)) {
    throw new Error('Invalid sheet tab id.');
  }
  return id;
}

function requireColumnIndex(value, what = 'column') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${what}.`);
  return n;
}

/** Current number of grid columns in a tab (0-based indexes are < this). */
export async function getSheetColumnCount(spreadsheetId, sheetId, token) {
  const id = requireSheetId(sheetId);
  const res = await apiRequest(
    `${SHEETS_API}/${spreadsheetId}?fields=sheets(properties(sheetId,gridProperties(columnCount)))`,
    token
  );
  const match = (res.sheets ?? []).find((s) => s.properties?.sheetId === id);
  if (!match) throw new Error('That tab no longer exists in the spreadsheet.');
  return match.properties?.gridProperties?.columnCount ?? 0;
}

/**
 * Delete a whole column (0-based index) from a tab. Columns to its right
 * shift left, so every remaining column keeps its header and data.
 */
export async function deleteColumn(spreadsheetId, sheetId, columnIndex, token) {
  const id = requireSheetId(sheetId);
  const index = requireColumnIndex(columnIndex);
  return batchUpdate(
    spreadsheetId,
    [
      {
        deleteDimension: {
          range: { sheetId: id, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
        },
      },
    ],
    token
  );
}

/**
 * Move one column from `fromIndex` so it ends up at `toIndex` (both 0-based,
 * final position). The header and data move together.
 */
export async function moveColumn(spreadsheetId, sheetId, fromIndex, toIndex, token) {
  const id = requireSheetId(sheetId);
  const from = requireColumnIndex(fromIndex, 'column');
  const to = requireColumnIndex(toIndex, 'destination');
  if (from === to) return null;
  return batchUpdate(
    spreadsheetId,
    [
      {
        moveDimension: {
          source: { sheetId: id, dimension: 'COLUMNS', startIndex: from, endIndex: from + 1 },
          // destinationIndex is expressed before the move is applied.
          destinationIndex: to > from ? to + 1 : to,
        },
      },
    ],
    token
  );
}

/**
 * Insert one empty column at `columnIndex` (existing columns shift right).
 * When the index is past the current grid width, columns are appended instead.
 */
export async function insertColumn(spreadsheetId, sheetId, columnIndex, token) {
  const id = requireSheetId(sheetId);
  const index = requireColumnIndex(columnIndex);
  const width = await getSheetColumnCount(spreadsheetId, id, token);
  const request =
    index >= width
      ? { appendDimension: { sheetId: id, dimension: 'COLUMNS', length: index + 1 - width } }
      : {
          insertDimension: {
            range: { sheetId: id, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
            inheritFromBefore: false,
          },
        };
  return batchUpdate(spreadsheetId, [request], token);
}

/**
 * Overwrite the header row for a tab (destructive to column alignment).
 */
export async function syncTabHeaders(spreadsheetId, tabName, headers, token) {
  const escapedTab = `'${String(tabName).replace(/'/g, "''")}'`;
  const endCol = columnLetter(headers.length);
  // Clear a wide header band then write — avoids leftover old header cells
  const clearRange = `${escapedTab}!A1:ZZ1`;
  await apiRequest(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(clearRange)}:clear`,
    token,
    { method: 'POST', body: '{}' }
  );
  return writeHeaders(spreadsheetId, `${escapedTab}!A1:${endCol}1`, headers, token);
}

/**
 * Set bold on a half-open row range [startRowIndex, endRowIndex) for the
 * first `columnCount` columns (0-based indices).
 */
export async function setRowsBold(
  spreadsheetId,
  sheetId,
  startRowIndex,
  endRowIndex,
  columnCount,
  bold,
  token
) {
  const numericSheetId = Number(sheetId);
  const start = Number(startRowIndex);
  const end = Number(endRowIndex);
  const cols = Math.max(1, Number(columnCount) || 1);
  if (!Number.isFinite(numericSheetId)) {
    throw new Error('Invalid sheet tab id.');
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('Invalid row range.');
  }

  const url = `${SHEETS_API}/${spreadsheetId}:batchUpdate`;
  return apiRequest(url, token, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: start,
              endRowIndex: end,
              startColumnIndex: 0,
              endColumnIndex: cols,
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: !!bold },
              },
            },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
      ],
    }),
  });
}

/**
 * Write default headers for an empty / upgradable tab.
 * Clears the header band, bolds only the header row, and pre-clears bold on
 * data rows so later appends do not inherit header bold.
 */
export async function seedTabHeaders(
  spreadsheetId,
  tabName,
  headers,
  token,
  { sheetId = null } = {}
) {
  await syncTabHeaders(spreadsheetId, tabName, headers, token);

  const numericSheetId = Number(sheetId);
  if (!Number.isFinite(numericSheetId)) return;

  const cols = Math.max(headers?.length || 0, 1);
  // Header row bold; a wide data band explicitly not bold.
  await setRowsBold(spreadsheetId, numericSheetId, 0, 1, cols, true, token);
  await setRowsBold(spreadsheetId, numericSheetId, 1, 1000, cols, false, token);
}

/** 1-based column number to A1 letters (1 -> A, 27 -> AA). */
function columnLetter(n) {
  let s = '';
  let num = n;
  while (num > 0) {
    const rem = (num - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s || 'A';
}
