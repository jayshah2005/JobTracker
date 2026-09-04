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

export async function fetchSheetValues(spreadsheetId, range, token) {
  const encoded = encodeURIComponent(range);
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encoded}`;
  const res = await apiRequest(url, token);
  return res.values ?? [];
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

export async function writeHeaders(spreadsheetId, range, headers, token) {
  const encoded = encodeURIComponent(range);
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encoded}?valueInputOption=USER_ENTERED`;
  const res = await apiRequest(url, token, {
    method: 'PUT',
    body: JSON.stringify({ values: [headers] }),
  });
  return res;
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
export async function loadTabRows(spreadsheetId, tabName, token) {
  const escaped = `'${String(tabName).replace(/'/g, "''")}'`;
  return fetchSheetValues(spreadsheetId, `${escaped}!A1:ZZ2000`, token);
}

/**
 * Save a job row to the specified tab, creating headers if needed.
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
