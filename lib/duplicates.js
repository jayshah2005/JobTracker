import { FIELD_TAGS } from './constants.js';
import {
  resolveFieldTag,
  hyperlinkLabel,
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

/**
 * Find an existing application for this job across loaded tabs.
 * Prefers URL match; falls back to company + role when both are present.
 */
export function findExistingApplication(tabs, job = {}) {
  const jobUrl = job.url || '';
  const company = normalizeText(job.company);
  const role = normalizeText(job.role);

  for (const tab of tabs || []) {
    const mappings = tab.mappings || [];
    const rows = tab.rows || [];
    const urlCol = columnForTag(mappings, FIELD_TAGS.URL);
    const companyCol = columnForTag(mappings, FIELD_TAGS.COMPANY_NAME);
    const roleCol = columnForTag(mappings, FIELD_TAGS.ROLE);
    const dateCol = columnForTag(mappings, FIELD_TAGS.DATE_APPLIED);
    const statusCol = columnForApplicationStatus(mappings);
    const start = rows.length && looksLikeHeaderRow(rows[0], mappings) ? 1 : 0;

    for (let i = start; i < rows.length; i++) {
      const row = rows[i] || [];
      const rowUrl = cell(row, urlCol);
      const urlHit = jobUrl && rowUrl && urlsMatch(jobUrl, rowUrl);
      const companyHit =
        company &&
        role &&
        normalizeText(cell(row, companyCol)) === company &&
        normalizeText(cell(row, roleCol)) === role;
      const matchedBy = urlHit ? 'url' : companyHit ? 'company_role' : null;
      if (!matchedBy) continue;

      return {
        matched: true,
        matchedBy,
        sheetName: tab.sheetName,
        tabName: tab.tabName,
        spreadsheetId: tab.spreadsheetId,
        gid: tab.gid,
        rowIndex: i,
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
