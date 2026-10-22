/**
 * Indeed job detail extraction (/viewjob, jk=).
 */

import {
  ATS_DOM_SCORE,
  ATS_SCORE,
  addCandidate,
  firstText,
  metaContent,
  qs,
} from './shared.js';

/**
 * Add Indeed (job-header DOM, og:title, canonical URL) candidates to `candidates` (mutated).
 * Scores come from shared.js ATS_* constants so they outrank general strategies.
 * The `url` argument is unused; it keeps every collector's signature uniform.
 */
export function collectIndeed(document, url, candidates, meta = {}) {
  if (!document) return;

  collectFromDom(document, candidates);
  collectFromMeta(document, candidates);

  if (meta.jobId) {
    addCandidate(candidates.jobId, meta.jobId, ATS_SCORE, 'indeed-url', 'high');
  }
}

function collectFromDom(document, candidates) {
  const role = firstText(document, [
    'h1.jobsearch-JobInfoHeader-title',
    'h1[data-testid="jobsearch-JobInfoHeader-title"]',
    '.jobsearch-JobInfoHeader-title',
    'h2.jobTitle',
    'h1',
  ]);
  if (role) {
    addCandidate(candidates.role, role, ATS_DOM_SCORE, 'indeed-dom', 'high');
  }

  const company = firstText(document, [
    '[data-company-name="true"]',
    '[data-testid="inlineHeader-companyName"] a',
    '[data-testid="inlineHeader-companyName"]',
    '.jobsearch-InlineCompanyRating a',
    '.jobsearch-CompanyInfoContainer a',
    'div[data-company-name] a',
  ]);
  if (company) {
    addCandidate(candidates.company, company, ATS_DOM_SCORE, 'indeed-dom', 'high');
  }

  const location = firstText(document, [
    '[data-testid="inlineHeader-companyLocation"]',
    '[data-testid="job-location"]',
    '.jobsearch-JobInfoHeader-subtitle > div:last-child',
    'div[data-testid="jobsearch-JobInfoHeader-companyLocation"]',
  ]);
  if (location) {
    addCandidate(candidates.location, location, ATS_DOM_SCORE - 5, 'indeed-dom', 'medium');
  }
}

function collectFromMeta(document, candidates) {
  const title = metaContent(document, [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
  ]);
  if (title) {
    // "Role - Company - Indeed.com" or similar
    const parts = title.split(/\s+[-|]\s+/);
    if (parts[0]) {
      addCandidate(candidates.role, parts[0], ATS_SCORE - 15, 'indeed-meta', 'medium');
    }
    if (parts[1] && !/indeed/i.test(parts[1])) {
      addCandidate(candidates.company, parts[1], ATS_SCORE - 15, 'indeed-meta', 'medium');
    }
  }

  const canonical = qs(document, 'link[rel="canonical"]')?.href;
  if (canonical && (/viewjob/i.test(canonical) || /[?&]jk=/i.test(canonical))) {
    addCandidate(candidates.url, canonical, ATS_SCORE - 10, 'indeed-canonical', 'high');
  }
}
