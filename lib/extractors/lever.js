/**
 * Lever (jobs.lever.co) extraction.
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
  qs,
  qsa,
  titleFromObject,
  walkObjects,
} from './shared.js';

export function collectLever(document, url, candidates, meta = {}) {
  if (!document) return;

  collectFromDom(document, candidates);
  collectFromNextData(document, candidates);
  collectFromInline(document, candidates);

  if (meta.company) {
    addCandidate(
      candidates.company,
      humanizeSlug(meta.company),
      ATS_SCORE - 5,
      'lever-slug',
      'high'
    );
  }
  if (meta.jobId) {
    addCandidate(candidates.jobId, meta.jobId, ATS_SCORE, 'lever-url', 'high');
  }
}

function collectFromDom(document, candidates) {
  const role = firstText(document, [
    '.posting-headline h2',
    '.posting-headline h1',
    '[data-qa="posting-name"]',
    'h2.posting-headline',
  ]);
  if (role) {
    addCandidate(candidates.role, role, ATS_DOM_SCORE, 'lever-dom', 'high');
  }

  const location = firstText(document, [
    '.posting-categories .location',
    '.posting-categories [class*="location"]',
    '.location',
    '[data-qa="posting-location"]',
  ]);
  if (location) {
    addCandidate(
      candidates.location,
      location,
      ATS_DOM_SCORE,
      'lever-dom',
      'high'
    );
  }

  // Commitment / team sometimes mistaken for location — skip department-only
  const company =
    qs(document, '.main-header-logo img')?.getAttribute?.('alt') ||
    firstText(document, ['.main-header-text a', '.posting-header .sort-by-time']);
  if (company && !/lever|jobs?/i.test(company)) {
    addCandidate(
      candidates.company,
      company.replace(/\s*logo$/i, ''),
      ATS_DOM_SCORE,
      'lever-dom',
      'high'
    );
  }
}

function collectFromNextData(document, candidates) {
  const next = parseNextData(document);
  if (!next) return;
  walkObjects(next, (obj) => {
    const title = titleFromObject(obj);
    if (!title) return;
    if (!(obj.categories || obj.hostedUrl || obj.applyUrl || obj.text)) return;
    addCandidate(candidates.role, title, ATS_JSON_SCORE, 'lever-json', 'high');
    const loc =
      locationFromObject(obj) ||
      obj.categories?.location ||
      (typeof obj.categories === 'object' ? obj.categories.location : '');
    if (loc) {
      addCandidate(candidates.location, loc, ATS_JSON_SCORE, 'lever-json', 'high');
    }
    if (obj.id) {
      addCandidate(
        candidates.jobId,
        String(obj.id),
        ATS_JSON_SCORE,
        'lever-json',
        'high'
      );
    }
  });
}

function collectFromInline(document, candidates) {
  for (const script of qsa(document, 'script:not([src])')) {
    const raw = script.textContent || '';
    if (!/lever|posting|hostedUrl/i.test(raw)) continue;
    const title = raw.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const loc = raw.match(/"location"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (title) {
      addCandidate(
        candidates.role,
        unesc(title[1]),
        ATS_JSON_SCORE - 4,
        'lever-inline',
        'high'
      );
    }
    if (loc) {
      addCandidate(
        candidates.location,
        unesc(loc[1]),
        ATS_JSON_SCORE - 4,
        'lever-inline',
        'high'
      );
    }
  }
}

function unesc(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}
