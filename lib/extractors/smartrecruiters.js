/**
 * SmartRecruiters careers pages.
 */

import {
  ATS_DOM_SCORE,
  ATS_JSON_SCORE,
  ATS_SCORE,
  addCandidate,
  firstText,
  humanizeSlug,
  metaContent,
  parseNextData,
  titleFromObject,
  walkObjects,
} from './shared.js';

export function collectSmartRecruiters(document, url, candidates, meta = {}) {
  if (!document) return;

  collectFromDom(document, candidates);
  collectFromNextData(document, candidates);
  collectFromMeta(document, candidates);

  if (meta.company) {
    addCandidate(
      candidates.company,
      humanizeSlug(meta.company),
      ATS_SCORE - 5,
      'smartrecruiters-slug',
      'high'
    );
  }
  if (meta.jobId) {
    addCandidate(
      candidates.jobId,
      meta.jobId,
      ATS_SCORE - 5,
      'smartrecruiters-url',
      'medium'
    );
  }
}

function collectFromDom(document, candidates) {
  const role = firstText(document, [
    'h1[data-test="job-title"]',
    '[data-test="job-title"]',
    'h1.job-title',
    'h1',
  ]);
  if (role) {
    addCandidate(
      candidates.role,
      role,
      ATS_DOM_SCORE,
      'smartrecruiters-dom',
      'high'
    );
  }

  const location = firstText(document, [
    '[data-test="job-location"]',
    '.job-location',
    '[class*="JobLocation"]',
  ]);
  if (location) {
    addCandidate(
      candidates.location,
      location,
      ATS_DOM_SCORE,
      'smartrecruiters-dom',
      'high'
    );
  }

  const company = firstText(document, [
    '[data-test="company-name"]',
    '.company-name',
  ]);
  if (company) {
    addCandidate(
      candidates.company,
      company,
      ATS_DOM_SCORE,
      'smartrecruiters-dom',
      'high'
    );
  }
}

function collectFromNextData(document, candidates) {
  const next = parseNextData(document);
  if (!next) return;
  walkObjects(next, (obj) => {
    const title = titleFromObject(obj);
    if (!title || !(obj.location || obj.company || obj.refNumber || obj.uuid)) {
      return;
    }
    addCandidate(
      candidates.role,
      title,
      ATS_JSON_SCORE,
      'smartrecruiters-json',
      'high'
    );
    if (obj.location?.city || obj.location?.address || typeof obj.location === 'string') {
      const loc =
        typeof obj.location === 'string'
          ? obj.location
          : [obj.location.city, obj.location.region, obj.location.country]
              .filter(Boolean)
              .join(', ');
      if (loc) {
        addCandidate(
          candidates.location,
          loc,
          ATS_JSON_SCORE,
          'smartrecruiters-json',
          'high'
        );
      }
    }
    if (obj.company?.name) {
      addCandidate(
        candidates.company,
        obj.company.name,
        ATS_JSON_SCORE,
        'smartrecruiters-json',
        'high'
      );
    }
    if (obj.refNumber || obj.uuid || obj.id) {
      addCandidate(
        candidates.jobId,
        String(obj.refNumber || obj.uuid || obj.id),
        ATS_JSON_SCORE,
        'smartrecruiters-json',
        'high'
      );
    }
  });
}

function collectFromMeta(document, candidates) {
  const og = metaContent(document, ['meta[property="og:title"]']);
  if (!og) return;
  const parts = og.split(/\s+[|\-–—]\s+/);
  if (parts[0]) {
    addCandidate(
      candidates.role,
      parts[0],
      ATS_DOM_SCORE - 12,
      'smartrecruiters-meta',
      'medium'
    );
  }
}
