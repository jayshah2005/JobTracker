/**
 * Ashby (jobs.ashbyhq.com) extraction.
 */

import {
  ATS_DOM_SCORE,
  ATS_JSON_SCORE,
  ATS_SCORE,
  addCandidate,
  firstText,
  humanizeSlug,
  locationFromObject,
  parseNextData,
  titleFromObject,
  walkObjects,
} from './shared.js';

export function collectAshby(document, url, candidates, meta = {}) {
  if (!document) return;

  collectFromNextData(document, candidates);
  collectFromDom(document, candidates);

  if (meta.org) {
    addCandidate(
      candidates.company,
      humanizeSlug(meta.org),
      ATS_SCORE - 5,
      'ashby-org',
      'high'
    );
  }
  if (meta.jobId) {
    addCandidate(candidates.jobId, meta.jobId, ATS_SCORE, 'ashby-url', 'high');
  }
}

function collectFromNextData(document, candidates) {
  const next = parseNextData(document);
  if (!next) return;

  walkObjects(next, (obj) => {
    const title = titleFromObject(obj) || obj.jobTitle;
    if (!title) return;
    const looks =
      obj.locationName ||
      obj.employmentType ||
      obj.jobBoard ||
      obj.organizationId ||
      obj.jobPostingId ||
      /JobPosting/i.test(String(obj.__typename || ''));
    if (!looks) return;

    addCandidate(candidates.role, title, ATS_JSON_SCORE, 'ashby-next', 'high');
    const loc = locationFromObject(obj) || obj.locationName;
    if (loc) {
      addCandidate(candidates.location, loc, ATS_JSON_SCORE, 'ashby-next', 'high');
    }
    const company =
      obj.organizationName ||
      obj.organization?.name ||
      obj.jobBoard?.organizationName;
    if (company) {
      addCandidate(
        candidates.company,
        company,
        ATS_JSON_SCORE,
        'ashby-next',
        'high'
      );
    }
    const id = obj.id || obj.jobPostingId || obj.jobId;
    if (id) {
      addCandidate(
        candidates.jobId,
        String(id),
        ATS_JSON_SCORE,
        'ashby-next',
        'high'
      );
    }
  });
}

function collectFromDom(document, candidates) {
  const role = firstText(document, [
    'h1',
    '[class*="JobPosting"] h1',
    '[data-testid="job-posting-title"]',
  ]);
  if (role && !/^jobs?$/i.test(role)) {
    addCandidate(candidates.role, role, ATS_DOM_SCORE, 'ashby-dom', 'high');
  }

  const location = firstText(document, [
    '[class*="location"]',
    '[data-testid="job-location"]',
  ]);
  if (location) {
    addCandidate(
      candidates.location,
      location,
      ATS_DOM_SCORE,
      'ashby-dom',
      'medium'
    );
  }
}
