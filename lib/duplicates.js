import { FIELD_TAGS } from './constants.js';
import {
  resolveFieldTag,
  hyperlinkLabel,
  hyperlinkUrl,
  isApplicationStatusHeader,
} from './field-mapper.js';
import { extractJobId, normalizeJobUrl, urlsMatch } from './job-url.js';

export { extractJobId, normalizeJobUrl, urlsMatch };

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function columnForTag(mappings, tag) {
  return (mappings || []).find((m) => resolveFieldTag(m) === tag)?.columnIndex;
}

function columnForApplicationStatus(mappings) {
  const byLegacy = (mappings || []).find(
    (m) => m.tag === FIELD_TAGS.APPLICATION_STATUS
  )?.columnIndex;
  if (byLegacy != null) return byLegacy;
  return (mappings || []).find((m) => isApplicationStatusHeader(m.header))
    ?.columnIndex;
}

function cell(row, index) {
  if (index == null || index < 0) return '';
  return hyperlinkLabel(row?.[index]).trim();
}

function rowJobUrl(row, urlCol, roleCol) {
  const fromUrlCol = String(row?.[urlCol] ?? '').trim();
  if (fromUrlCol) {
    // URL cells are usually plain text; still accept a HYPERLINK formula.
    return hyperlinkUrl(fromUrlCol) || fromUrlCol;
  }
  return hyperlinkUrl(row?.[roleCol]) || '';
}

function rowJobId(row, idCol, rowUrl) {
  const fromCol = cell(row, idCol);
  if (fromCol) return fromCol;
  return extractJobId(rowUrl);
}

/**
 * Find an existing application for this job across loaded tabs.
 * Prefers URL / job-id match so edited company or role text still hits.
 * Falls back to company + role when both are present.
 */
export function findExistingApplication(tabs, job = {}) {
  const jobUrl = job.url || '';
  const company = normalizeText(job.company);
  const role = normalizeText(job.role);
  const jobId = String(job.jobId || extractJobId(jobUrl) || '').trim();

  for (const tab of tabs || []) {
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
        url: rowUrl,
      };
    }
  }

  return { matched: false };
}

function looksLikeHeaderRow(row, mappings) {
  if (!row || !mappings?.length) return true;
  const header = mappings[0]?.header;
  if (!header) return true;
  return normalizeText(row[mappings[0].columnIndex]) === normalizeText(header);
}
