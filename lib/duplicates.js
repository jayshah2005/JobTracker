/**
 * Duplicate-application detection against rows already loaded from the user's
 * sheet tabs. Used by the sidepanel/background before saving so the same
 * posting is not added twice (and to show the existing row's status/date).
 *
 * Match priority: posting URL, then job id, then company + role text. An
 * id-only match is skipped when both companies are present and clearly unrelated.
 * Also re-exports the job-url helpers for callers that import from here.
 */

import { FIELD_TAGS } from './constants.js';
import {
  resolveFieldTag,
  hyperlinkLabel,
  hyperlinkUrl,
  stripTextMarker,
  isApplicationStatusHeader,
} from './field-mapper.js';
import { extractJobId, normalizeJobUrl, urlsMatch } from './job-url.js';

export { extractJobId, normalizeJobUrl, urlsMatch };

/**
 * Stable identity of a row's content, used to detect that a row changed (or
 * moved) in Google Sheets since we read it. Cells are stringified and trailing
 * empties trimmed (Sheets trims trailing blanks on reads), so two reads of an
 * unchanged row always agree. Always compute it from a read with the same
 * valueRenderOption (FORMULA), never from a locally built row.
 */
export function rowFingerprint(row) {
  const cells = Array.isArray(row) ? row.map((c) => String(c ?? '')) : [];
  while (cells.length && cells[cells.length - 1] === '') cells.pop();
  return JSON.stringify(cells);
}

/** Case/whitespace-insensitive form for comparing sheet text. */
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const COMPANY_NOISE = new Set([
  'inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc', 'the', 'group', 'holdings',
]);

/** Company text reduced to comparable tokens (punctuation and legal suffixes dropped). */
function companyTokens(value) {
  const tokens = normalizeText(value)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const core = tokens.filter((t) => !COMPANY_NOISE.has(t));
  return core.length ? core : tokens;
}

/**
 * True only when both companies are present and clearly unrelated: neither
 * contains the other and their word overlap is low. Edited or shortened names
 * ('Acme' vs 'Acme Inc', 'Google' vs 'Google LLC') are NOT clearly different.
 */
export function companiesClearlyDiffer(a, b) {
  const ta = companyTokens(a);
  const tb = companyTokens(b);
  if (!ta.length || !tb.length) return false;
  const ja = ta.join(' ');
  const jb = tb.join(' ');
  if (ja.includes(jb) || jb.includes(ja)) return false;
  const sa = new Set(ta);
  const shared = tb.filter((t) => sa.has(t)).length;
  const overlap = shared / Math.min(sa.size, new Set(tb).size);
  return overlap < 0.5;
}

/** Column index mapped to `tag` (by effective tag), or undefined. */
function columnForTag(mappings, tag) {
  return (mappings || []).find((m) => resolveFieldTag(m) === tag)?.columnIndex;
}

/** Status column: legacy APPLICATION_STATUS tag first, else a status-like header. */
function columnForApplicationStatus(mappings) {
  const byLegacy = (mappings || []).find(
    (m) => m.tag === FIELD_TAGS.APPLICATION_STATUS
  )?.columnIndex;
  if (byLegacy != null) return byLegacy;
  return (mappings || []).find((m) => isApplicationStatusHeader(m.header))
    ?.columnIndex;
}

/** Display text of a cell (HYPERLINK formulas reduced to their label); '' if no column. */
function cell(row, index) {
  if (index == null || index < 0) return '';
  return hyperlinkLabel(row?.[index]).trim();
}

/** Posting URL of a row: URL column, else the link hidden in the Role HYPERLINK. */
function rowJobUrl(row, urlCol, roleCol) {
  const fromUrlCol = stripTextMarker(String(row?.[urlCol] ?? '').trim());
  if (fromUrlCol) {
    // URL cells are usually plain text; still accept a HYPERLINK formula.
    return hyperlinkUrl(fromUrlCol) || fromUrlCol;
  }
  return hyperlinkUrl(row?.[roleCol]) || '';
}

/** Job id of a row: ID column, else derived from the row's URL. */
function rowJobId(row, idCol, rowUrl) {
  const fromCol = cell(row, idCol);
  if (fromCol) return fromCol;
  return extractJobId(rowUrl);
}

/** Restrict matching to one spreadsheet / tab (gid may be the sheet gid or tabId). */
function tabMatchesDestination(tab, { spreadsheetId, gid } = {}) {
  if (spreadsheetId != null && String(tab.spreadsheetId) !== String(spreadsheetId)) {
    return false;
  }
  if (gid != null) {
    const tabGid = String(tab.gid ?? '');
    const tabId = String(tab.tabId ?? '');
    const want = String(gid);
    if (tabGid !== want && tabId !== want) return false;
  }
  return true;
}

/**
 * Find an existing application for this job across loaded tabs.
 * Prefers URL / job-id match so edited company or role text still hits.
 * Falls back to company + role when both are present.
 *
 * Pass `{ spreadsheetId, gid }` to limit the search to one destination
 * (so the same job can still be saved to a different sheet/tab).
 */
export function findExistingApplication(tabs, job = {}, destination = {}) {
  const jobUrl = job.url || '';
  const company = normalizeText(job.company);
  const role = normalizeText(job.role);
  const jobId = String(job.jobId || extractJobId(jobUrl) || '').trim();
  const filter =
    destination?.spreadsheetId != null || destination?.gid != null
      ? destination
      : null;

  for (const tab of tabs || []) {
    if (filter && !tabMatchesDestination(tab, filter)) continue;

    const mappings = tab.mappings || [];
    const rows = tab.rows || [];
    const urlCol = columnForTag(mappings, FIELD_TAGS.URL);
    const companyCol = columnForTag(mappings, FIELD_TAGS.COMPANY_NAME);
    const roleCol = columnForTag(mappings, FIELD_TAGS.ROLE);
    const idCol = columnForTag(mappings, FIELD_TAGS.ID);
    const dateCol = columnForTag(mappings, FIELD_TAGS.DATE_APPLIED);
    const statusCol = columnForApplicationStatus(mappings);
    const start = rows.length && looksLikeHeaderRow(rows[0], mappings) ? 1 : 0;

    for (let i = start; i < rows.length; i++) {
      const row = rows[i] || [];
      const rowUrl = rowJobUrl(row, urlCol, roleCol);
      // An id-only match (URLs differ) is distrusted when both sides name a
      // company and the companies are clearly unrelated (ids collide across employers).
      const rowCompany = cell(row, companyCol);
      const idOnlyRejected = companiesClearlyDiffer(job.company, rowCompany);
      const exactUrl =
        jobUrl && rowUrl && normalizeJobUrl(jobUrl) === normalizeJobUrl(rowUrl);
      const urlHit =
        jobUrl &&
        rowUrl &&
        urlsMatch(jobUrl, rowUrl) &&
        (exactUrl || !idOnlyRejected);
      const idHit =
        Boolean(jobId) &&
        !idOnlyRejected &&
        normalizeText(rowJobId(row, idCol, rowUrl)) === normalizeText(jobId);
      const companyHit =
        company &&
        role &&
        normalizeText(cell(row, companyCol)) === company &&
        normalizeText(cell(row, roleCol)) === role;
      const matchedBy = urlHit
        ? 'url'
        : idHit
          ? 'job_id'
          : companyHit
            ? 'company_role'
            : null;
      if (!matchedBy) continue;

      return {
        matched: true,
        matchedBy,
        sheetName: tab.sheetName,
        tabName: tab.tabName,
        spreadsheetId: tab.spreadsheetId,
        gid: tab.gid,
        rowIndex: i,
        row: [...row],
        rowFingerprint: rowFingerprint(row),
        dateApplied: cell(row, dateCol),
        status: cell(row, statusCol),
        company: cell(row, companyCol),
        role: cell(row, roleCol),
        location: cell(row, columnForTag(mappings, FIELD_TAGS.LOCATION)),
        jobId: rowJobId(row, idCol, rowUrl),
        url: rowUrl,
      };
    }
  }

  return { matched: false };
}

/**
 * Is row 0 the header row? Compares the first mapped column's cell with its
 * header; defaults to true (skip row 0) when we cannot tell.
 */
function looksLikeHeaderRow(row, mappings) {
  if (!row || !mappings?.length) return true;
  const header = mappings[0]?.header;
  if (!header) return true;
  return normalizeText(row[mappings[0].columnIndex]) === normalizeText(header);
}
