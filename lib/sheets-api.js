/**
 * Google Sheets API client.
 * Uses fetch with a bearer token from the signed-in Google account.
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function fetchSpreadsheetMetadata(spreadsheetId, token) {
  const url = `${SHEETS_API}/${spreadsheetId}?fields=properties(title),sheets(properties(sheetId,title,index))`;
  const res = await apiRequest(url, token);
  return res;
}

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

export async function appendRow(spreadsheetId, range, row, token) {
  const encoded = encodeURIComponent(range);
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encoded}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await apiRequest(url, token, {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  });
  return res;
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

export async function writeHeaders(spreadsheetId, range, headers, token) {
  const encoded = encodeURIComponent(range);
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encoded}?valueInputOption=USER_ENTERED`;
  const res = await apiRequest(url, token, {
    method: 'PUT',
    body: JSON.stringify({ values: [headers] }),
  });
  return res;
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
    throw new Error(
      err.error?.message || `Google Sheets API error: ${res.status}`
    );
  }

  return res.json();
}

/**
 * Load all tabs and their first rows for a spreadsheet.
 */
export async function loadSpreadsheetTabs(spreadsheetId, token) {
  const meta = await fetchSpreadsheetMetadata(spreadsheetId, token);
  const sheets = meta.sheets ?? [];

  const tabs = [];
  for (const sheet of sheets) {
    const props = sheet.properties;
    const tabName = props.title;
    const gid = String(props.sheetId);
    const range = `'${tabName.replace(/'/g, "''")}'!A1:ZZ2000`;
    let rows = [];
    try {
      rows = await fetchSheetValues(spreadsheetId, range, token);
    } catch {
      rows = [];
    }
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
 * Load values for a single tab by gid (falls back to first tab name match).
 */
export async function loadTabRows(
  spreadsheetId,
  tabName,
  token,
  { valueRenderOption = 'FORMATTED_VALUE' } = {}
) {
  const escaped = `'${String(tabName).replace(/'/g, "''")}'`;
  return fetchSheetValues(spreadsheetId, `${escaped}!A1:ZZ2000`, token, {
    valueRenderOption,
  });
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
    await writeHeaders(
      spreadsheetId,
      `${escapedTab}!A1`,
      tabConfig.headers,
      token
    );
    tabConfig.isNew = false;
  }

  const range = `${escapedTab}!A:A`;
  return appendRow(spreadsheetId, range, row, token);
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
 * Overwrite the header row for a tab (destructive to column alignment).
 */
export async function syncTabHeaders(spreadsheetId, tabName, headers, token) {
  const escapedTab = `'${tabName.replace(/'/g, "''")}'`;
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
