/**
 * Shared helpers for ATS / general job extractors.
 * Runs in page or test DOM — no Chrome APIs.
 *
 * Every collector pushes `{ value, score, source, confidence }` candidates into
 * per-field buckets; job-extractor.js later groups, votes and picks a winner.
 * The ATS_* scores sit above every general-strategy score (max 100) so a
 * site-specific hit beats generic guesses.
 */

/** Score for values read from the URL / known-good ATS metadata. */
export const ATS_SCORE = 130;
/** Score for values read from site-specific DOM selectors. */
export const ATS_DOM_SCORE = 122;
/** Score for values read from embedded JSON (__NEXT_DATA__, inline scripts). */
export const ATS_JSON_SCORE = 128;


const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE_PATTERNS = [
  // 2025-08-15, 2025/08/15, 2025.08.15
  { re: /(?<![\d/.-])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g, order: 'ymd' },
  // Aug 15, 2025 / August 15th 2025
  { re: new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), order: 'mdy-text' },
  // 15 Aug 2025 / 15th August, 2025
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'gi'), order: 'dmy-text' },
  // 03/04/2025 (ambiguity resolved below)
  { re: /(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/g, order: 'num' },
];

function buildIso(y, m, d, now = new Date()) {
  if (y < 2000 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
  // A posting date cannot be meaningfully in the future (allow timezone slack).
  if (dt.getTime() > now.getTime() + 2 * 86400000) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const pad2 = (n) => String(n).padStart(2, '0');
const localIso = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;

// Optional "Posted on" style lead-in. Year-less and relative dates are only
// accepted when the WHOLE value is (prefix +) the date, so they cannot misfire
// on dates/phrases buried in body text ("responded 3 days ago", "Jan 5 kickoff").
const LEAD = '^(?:(?:date\\s+)?(?:posted|listed|published)\\s*(?:on|:)?\\s*)?';
const YEARLESS_MD = new RegExp(`${LEAD}${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\.?$`, 'i');
const YEARLESS_DM = new RegExp(`${LEAD}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?$`, 'i');
const RELATIVE_WORD = new RegExp(`${LEAD}(today|yesterday|just\\s+posted)\\.?$`, 'i');
const RELATIVE_AGO = new RegExp(
  `${LEAD}(\\d{1,3}|a|an|one)\\+?\\s*(minute|min|hour|hr|day|week|month)s?\\s+ago\\.?$`,
  'i'
);
const UNIT_MS = {
  minute: 60000, min: 60000, hour: 3600000, hr: 3600000,
  day: 86400000, week: 7 * 86400000,
  month: 30 * 86400000, // approximation: a month is treated as 30 days
};

/** Year-less "Jan 5" / "5 Jan": current year, or last year if that lands >2 days ahead. */
function yearlessIso(mo, d, now) {
  const y = now.getFullYear();
  return buildIso(y, mo, d, now) || buildIso(y - 1, mo, d, now);
}

/** Relative text ("3 days ago", "yesterday", "30+ days ago") -> YYYY-MM-DD, or ''. */
function relativeIso(s, now) {
  if (RELATIVE_WORD.test(s)) {
    const w = s.match(RELATIVE_WORD)[1].toLowerCase();
    return localIso(new Date(now.getTime() - (w === 'yesterday' ? 86400000 : 0)));
  }
  const m = s.match(RELATIVE_AGO);
  if (!m) return '';
  const n = /^\d/.test(m[1]) ? +m[1] : 1;
  return localIso(new Date(now.getTime() - n * UNIT_MS[m[2].toLowerCase()]));
}

/**
 * Normalize a date-ish string to YYYY-MM-DD, or '' when it is not a
 * trustworthy date. Accepts full dates (ISO, "Aug 15, 2025", "15 Aug 2025",
 * unambiguous d/m/y). Additionally, when the WHOLE value is just that phrase:
 * year-less dates ("Jan 5") assume the current year (previous year if that
 * would be >2 days in the future), and relative dates ("3 days ago",
 * "yesterday", "30+ days ago") are computed from `now`. Still rejects: bare
 * numbers, two-digit years, d/m vs m/d ambiguity (03/04/2025), years before
 * 2000, dates >2 days in the future, impossible dates, and text containing
 * several different dates. `now` is injectable for tests.
 */
export function normalizeDate(raw, now = new Date()) {
  if (raw == null || raw === '') return '';
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s || s.length > 120) return '';
  if (s.length <= 40) {
    const rel = relativeIso(s, now);
    if (rel) return rel;
    const md = s.match(YEARLESS_MD);
    if (md) return yearlessIso(MONTHS[md[1].slice(0, 3).toLowerCase()], +md[2], now);
    const dm = s.match(YEARLESS_DM);
    if (dm) return yearlessIso(MONTHS[dm[2].slice(0, 3).toLowerCase()], +dm[1], now);
  }
  const found = new Set();
  let ambiguous = false;
  for (const { re, order } of DATE_PATTERNS) {
    for (const m of s.matchAll(re)) {
      let y;
      let mo;
      let d;
      if (order === 'ymd') {
        [y, mo, d] = [+m[1], +m[2], +m[3]];
      } else if (order === 'mdy-text') {
        [mo, d, y] = [MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2], +m[3]];
      } else if (order === 'dmy-text') {
        [d, mo, y] = [+m[1], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[3]];
      } else {
        const a = +m[1];
        const b = +m[2];
        y = +m[3];
        if (a > 12 && b <= 12) [d, mo] = [a, b];
        else if (b > 12 && a <= 12) [mo, d] = [a, b];
        else if (a === b) [mo, d] = [a, b];
        else {
          ambiguous = true;
          continue;
        }
      }
      const iso = buildIso(y, mo, d, now);
      if (iso) found.add(iso);
      else ambiguous = true;
    }
  }
  if (ambiguous || found.size !== 1) return '';
  return [...found][0];
}

/** Whitespace-collapsed textContent of an element ('' when missing). */
export function textOf(el) {
  if (!el) return '';
  return String(el.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a raw candidate string: collapse whitespace, strip stray
 * separators and trailing "| Careers" style suffixes. Returns '' when the
 * result is implausibly short/long. (job-extractor.js reuses this.)
 */
export function cleanValue(value) {
  if (value == null) return '';
  let s = String(value).replace(/\s+/g, ' ').trim();
  s = s.replace(/^[\-–—•·|]+/, '').replace(/[\-–—•·|]+$/, '').trim();
  s = s.replace(/\s*[|\-–—]\s*(careers?|jobs?|home)\s*$/i, '').trim();
  if (s.length < 2 || s.length > 220) return '';
  return s;
}

/** Push a cleaned candidate into `bucket`; silently ignores empty values. */
export function addCandidate(bucket, value, score, source, confidence = 'high') {
  const cleaned = cleanValue(value);
  if (!cleaned || !bucket) return;
  bucket.push({ value: cleaned, score, source, confidence });
}

/** Safe querySelector: never throws on bad selectors / missing roots. */
export function qs(root, selector) {
  try {
    return root?.querySelector?.(selector) || null;
  } catch {
    return null;
  }
}

/** Safe querySelectorAll returning a real array. */
export function qsa(root, selector) {
  try {
    return [...(root?.querySelectorAll?.(selector) || [])];
  } catch {
    return [];
  }
}

/** Text of the first selector that matches an element with non-empty text. */
export function firstText(root, selectors) {
  for (const sel of selectors) {
    const el = qs(root, sel);
    const t = textOf(el);
    if (t) return t;
  }
  return '';
}

/** `content` of the first matching <meta> selector ('' if none). */
export function metaContent(document, selectors) {
  for (const sel of selectors) {
    const el = qs(document, sel);
    const v = el?.getAttribute?.('content') || el?.getAttribute?.('value');
    if (v) return String(v).trim();
  }
  return '';
}

/** Parse `<script id="__NEXT_DATA__">` if present. */
export function parseNextData(document) {
  const raw = qs(document, 'script#__NEXT_DATA__')?.textContent;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Depth-limited walk calling `visit(obj)` on every object in a JSON tree. */
export function walkObjects(node, visit, depth = 0) {
  if (!node || depth > 14) return;
  if (Array.isArray(node)) {
    for (const item of node) walkObjects(item, visit, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') walkObjects(val, visit, depth + 1);
  }
}

/** Best-guess job title from a JSON object of unknown ATS shape. */
export function titleFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return (
    obj.title ||
    obj.name ||
    obj.jobTitle ||
    obj.postingTitle ||
    obj.text ||
    ''
  );
}

/** Best-guess location string from a JSON object of unknown ATS shape. */
export function locationFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.location === 'string') return obj.location;
  if (obj.location?.name) return obj.location.name;
  if (obj.locationName) return obj.locationName;
  if (obj.locationsText) return obj.locationsText;
  if (Array.isArray(obj.categories)) {
    const loc = obj.categories.find(
      (c) => /location/i.test(c?.name || '') || c?.location
    );
    if (loc?.name && !/department|team|commitment/i.test(loc.name)) return loc.name;
    if (loc?.location) return loc.location;
  }
  if (Array.isArray(obj.locations)) {
    const parts = obj.locations
      .map((l) => (typeof l === 'string' ? l : l?.name || l?.locationName || ''))
      .filter(Boolean);
    if (parts.length) return parts.join('; ');
  }
  return '';
}

/** Best-guess company name from a JSON object of unknown ATS shape. */
export function companyFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return (
    obj.companyName ||
    obj.company ||
    obj.organizationName ||
    obj.hiringOrganization?.name ||
    obj.board?.name ||
    ''
  );
}

/** Best-guess job id (stringified) from a JSON object of unknown ATS shape. */
export function jobIdFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const id =
    obj.absolute_url ||
    obj.absoluteUrl ||
    obj.id ||
    obj.jobId ||
    obj.requisitionId ||
    obj.jobRequisitionId ||
    obj.internal_job_id ||
    obj.gh_Id ||
    '';
  return String(id);
}

/** "acme-corp" -> "Acme Corp". */
export function humanizeSlug(slug) {
  if (!slug) return '';
  return String(slug)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Well-known Workday tenant → display company name. */
const TENANT_COMPANY = {
  rbc: 'Royal Bank of Canada',
  rbccm: 'RBC Capital Markets',
};

/** Display company for a Workday tenant slug (known map, else humanized). */
export function companyFromTenant(tenant) {
  const key = String(tenant || '').toLowerCase();
  if (TENANT_COMPANY[key]) return TENANT_COMPANY[key];
  return humanizeSlug(tenant);
}

/**
 * Peel zero-padded / R- style requisition IDs that ATS sites (esp. RBC Workday)
 * embed in titles: "Role – 0000050007 Royal Bank of Canada".
 * @returns {{ title: string, jobId: string, companyHint: string }}
 */
export function peelRequisitionFromTitle(text) {
  const empty = { title: '', jobId: '', companyHint: '' };
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return empty;

  // Entire value is just an ID
  if (/^(?:R-?)?\d{6,14}$/i.test(s)) {
    return { title: '', jobId: s.replace(/^R-/i, ''), companyHint: '' };
  }

  // "0000050007 Royal Bank of Canada"
  let m = s.match(/^(?:R-?)?(\d{6,14})\s+(.+)$/i);
  if (m) {
    return { title: '', jobId: m[1], companyHint: m[2].trim() };
  }

  // "Role – 0000050007" or "Role – 0000050007 Company Name"
  m = s.match(
    /^(.+?)\s*[|–—\-]\s*(?:R-?)?(\d{6,14})(?:\s*[|–—\-]?\s*(.+))?$/i
  );
  if (m) {
    return {
      title: m[1].trim(),
      jobId: m[2],
      companyHint: (m[3] || '').trim(),
    };
  }

  // "Role (0000050007)"
  m = s.match(/^(.+?)\s*\((?:R-?)?(\d{6,14})\)\s*$/i);
  if (m) {
    return { title: m[1].trim(), jobId: m[2], companyHint: '' };
  }

  // Trailing ID without separator: "Role 0000050007"
  m = s.match(/^(.+?)\s+(?:R-?)?(\d{6,14})$/i);
  if (m && /[a-zA-Z]/.test(m[1])) {
    return { title: m[1].trim(), jobId: m[2], companyHint: '' };
  }

  return { title: s, jobId: '', companyHint: '' };
}

/**
 * Decode the body of a JSON string literal captured by regex from inline
 * script text (e.g. `"Senior \\u0026 Staff"`). Falls back to the raw text.
 */
export function unescapeJsonString(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

/** Non-empty URL path segments ([] for invalid URLs). */
export function pathSegments(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}
