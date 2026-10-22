/**
 * Duplicate-application detection against rows already loaded from the user's
 * sheet tabs. Used by the sidepanel/background before saving so the same
 * posting is not added twice (and to show the existing row's status/date).
 *
 * Match priority: posting URL, then job id, then company + role text.
 * Also re-exports the job-url helpers for callers that import from here.
 */

import { FIELD_TAGS } from './constants.js';
import {
  resolveFieldTag,
  hyperlinkLabel,
  hyperlinkUrl,
  isApplicationStatusHeader,
} from './field-mapper.js';
import { extractJobId, normalizeJobUrl, urlsMatch } from './job-url.js';

export { extractJobId, normalizeJobUrl, urlsMatch };

/** Case/whitespace-insensitive form for comparing sheet text. */
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
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
  const fromUrlCol = String(row?.[urlCol] ?? '').trim();
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
      const urlHit = jobUrl && rowUrl && urlsMatch(jobUrl, rowUrl);
      const idHit =
        Boolean(jobId) &&
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
