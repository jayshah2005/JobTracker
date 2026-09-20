/**
 * Shared helpers for ATS / general job extractors.
 * Runs in page or test DOM — no Chrome APIs.
 */

export const ATS_SCORE = 130;
export const ATS_DOM_SCORE = 122;
export const ATS_JSON_SCORE = 128;

export function textOf(el) {
  if (!el) return '';
  return String(el.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanValue(value) {
  if (value == null) return '';
  let s = String(value).replace(/\s+/g, ' ').trim();
  s = s.replace(/^[\-–—•·|]+/, '').replace(/[\-–—•·|]+$/, '').trim();
  s = s.replace(/\s*[|\-–—]\s*(careers?|jobs?|home)\s*$/i, '').trim();
  if (s.length < 2 || s.length > 220) return '';
  return s;
}

export function addCandidate(bucket, value, score, source, confidence = 'high') {
  const cleaned = cleanValue(value);
  if (!cleaned || !bucket) return;
  bucket.push({ value: cleaned, score, source, confidence });
}

export function qs(root, selector) {
  try {
    return root?.querySelector?.(selector) || null;
  } catch {
    return null;
  }
}

export function qsa(root, selector) {
  try {
    return [...(root?.querySelectorAll?.(selector) || [])];
  } catch {
    return [];
  }
}

export function firstText(root, selectors) {
  for (const sel of selectors) {
    const el = qs(root, sel);
    const t = textOf(el);
    if (t) return t;
  }
  return '';
}

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

/** Depth-limited walk collecting objects that look like job postings. */
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
  if (id == null) return '';
  return String(id);
}

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

export function pathSegments(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}
