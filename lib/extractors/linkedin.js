/**
 * LinkedIn Jobs detail extraction (/jobs/view/{id}).
 */

import {
  ATS_DOM_SCORE,
  ATS_SCORE,
  addCandidate,
  firstText,
  metaContent,
  qs,
} from './shared.js';

export function collectLinkedIn(document, url, candidates, meta = {}) {
  if (!document) return;

  collectFromDom(document, candidates);
  collectFromMeta(document, candidates);

  if (meta.jobId) {
    addCandidate(candidates.jobId, meta.jobId, ATS_SCORE, 'linkedin-url', 'high');
  }
}

function collectFromDom(document, candidates) {
  const role = firstText(document, [
    '.job-details-jobs-unified-top-card__job-title h1',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title h1',
    '.jobs-unified-top-card__job-title',
    'h1.t-24',
    'h1',
  ]);
  if (role) {
    addCandidate(candidates.role, role, ATS_DOM_SCORE, 'linkedin-dom', 'high');
  }

  const company = firstText(document, [
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    'a.topcard__org-name-link',
    '.topcard__org-name-link',
  ]);
  if (company) {
    addCandidate(candidates.company, company, ATS_DOM_SCORE, 'linkedin-dom', 'high');
  }

  const location = firstText(document, [
    '.job-details-jobs-unified-top-card__bullet',
    '.jobs-unified-top-card__bullet',
    '.topcard__flavor--bullet',
    '.job-details-jobs-unified-top-card__primary-description-container span',
  ]);
  if (location && !/applicants?|ago|promoted/i.test(location)) {
    addCandidate(candidates.location, location, ATS_DOM_SCORE - 5, 'linkedin-dom', 'medium');
  }
}

function collectFromMeta(document, candidates) {
  const title = metaContent(document, [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
  ]);
  // Often "Role | Company" or "Role at Company"
  if (title) {
    const at = title.split(/\s+[|\u2013\u2014-]\s+|\s+at\s+/i);
    if (at[0]) {
      addCandidate(candidates.role, at[0], ATS_SCORE - 15, 'linkedin-meta', 'medium');
    }
    if (at[1] && !/linkedin/i.test(at[1])) {
      addCandidate(candidates.company, at[1], ATS_SCORE - 15, 'linkedin-meta', 'medium');
    }
  }

  const site = metaContent(document, ['meta[property="og:site_name"]']);
  if (site && !/linkedin/i.test(site)) {
    addCandidate(candidates.company, site, ATS_SCORE - 40, 'linkedin-meta', 'low');
  }

  // Prefer canonical job URL when present
  const canonical = qs(document, 'link[rel="canonical"]')?.href;
  if (canonical && /\/jobs\/view\//i.test(canonical)) {
    addCandidate(candidates.url, canonical, ATS_SCORE - 10, 'linkedin-canonical', 'high');
  }
}
