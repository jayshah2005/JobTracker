/**
 * Workday myworkdayjobs.com extraction.
 */

import {
  ATS_DOM_SCORE,
  ATS_JSON_SCORE,
  ATS_SCORE,
  addCandidate,
  companyFromTenant,
  firstText,
  metaContent,
  parseNextData,
  peelRequisitionFromTitle,
  qs,
  qsa,
  textOf,
  walkObjects,
} from './shared.js';

export function collectWorkday(document, url, candidates, meta = {}) {
  if (!document) return;

  collectFromDom(document, candidates);
  collectFromNextData(document, candidates);
  collectFromInlineJson(document, candidates);
  collectFromMeta(document, candidates);

  if (meta.tenant) {
    addCandidate(
      candidates.company,
      companyFromTenant(meta.tenant),
      ATS_SCORE - 8,
      'workday-tenant',
      'high'
    );
  }
  if (meta.jobId) {
    const peeled = peelRequisitionFromTitle(meta.jobId.replace(/-/g, ' '));
    const req =
      peeled.jobId ||
      meta.jobId.match(/_((?:R-?)?[A-Za-z0-9]+)$/i)?.[1] ||
      meta.jobId;
    // Prefer human req ids over long zero-padded internal numbers when both exist
    addCandidate(candidates.jobId, String(req), ATS_SCORE, 'workday-url', 'high');

    const titlePart =
      peeled.title ||
      meta.jobId.replace(/_((?:R-?)?[A-Za-z0-9]+)$/i, '').replace(/-/g, ' ');
    if (titlePart && titlePart.length > 3 && !/^\d+$/.test(titlePart)) {
      addRole(candidates, titlePart, ATS_SCORE - 20, 'workday-url-title', 'low');
    }
  }
}

function addRole(candidates, raw, score, source, confidence) {
  const { title, jobId, companyHint } = peelRequisitionFromTitle(raw);
  if (title) {
    addCandidate(candidates.role, title, score, source, confidence);
  }
  if (jobId) {
    addCandidate(candidates.jobId, jobId, score, `${source}-req`, 'high');
  }
  if (companyHint && !/^\d+$/.test(companyHint)) {
    addCandidate(
      candidates.company,
      companyHint,
      score - 5,
      `${source}-company`,
      'medium'
    );
  }
}

function collectFromDom(document, candidates) {
  const role = firstText(document, [
    '[data-automation-id="jobPostingHeader"]',
    'h2[data-automation-id="jobPostingHeader"]',
    'h1[data-automation-id="jobPostingHeader"]',
    '[data-uxi-element-id="jobPostingHeader"]',
  ]);
  if (role && !/search\s+for\s+jobs|start\s+your\s+application/i.test(role)) {
    addRole(candidates, role, ATS_DOM_SCORE, 'workday-dom', 'high');
  }

  const location = firstText(document, [
    '[data-automation-id="locations"]',
    '[data-automation-id="location"]',
    'dd[data-automation-id="locations"]',
  ]);
  if (location && !/posted\s+on|ago$/i.test(location)) {
    addCandidate(
      candidates.location,
      location,
      ATS_DOM_SCORE,
      'workday-dom',
      'high'
    );
  }

  // Definition list: Location / Time Type / etc.
  for (const dt of qsa(document, 'dt, [data-automation-id$="Label"]')) {
    const label = textOf(dt).toLowerCase();
    const dd =
      dt.nextElementSibling ||
      qs(dt.parentElement, 'dd, [data-automation-id$="Value"]');
    const value = textOf(dd);
    if (!value) continue;
    if (/location|cities|primary\s+location/i.test(label)) {
      addCandidate(
        candidates.location,
        value,
        ATS_DOM_SCORE,
        'workday-label',
        'high'
      );
    }
    if (/posted|date/i.test(label) && !/time\s*type/i.test(label)) {
      addCandidate(
        candidates.postedDate,
        value,
        ATS_DOM_SCORE - 10,
        'workday-label',
        'medium'
      );
    }
    if (/requisition|job\s*req|req\s*id|job\s*id/i.test(label)) {
      const peeled = peelRequisitionFromTitle(value);
      addCandidate(
        candidates.jobId,
        peeled.jobId || value,
        ATS_DOM_SCORE,
        'workday-label',
        'high'
      );
    }
  }

  const posted = firstText(document, [
    '[data-automation-id="postedOn"]',
    '[data-automation-id="jobPostDate"]',
  ]);
  if (posted) {
    addCandidate(
      candidates.postedDate,
      posted.replace(/^posted\s*(on)?\s*/i, ''),
      ATS_DOM_SCORE - 5,
      'workday-dom',
      'medium'
    );
  }
}

function collectFromNextData(document, candidates) {
  const next = parseNextData(document);
  if (!next) return;
  walkObjects(next, (obj) => {
    const title = obj.title || obj.jobTitle || obj.postingTitle;
    if (!title) return;
    const hasWd =
      obj.locationsText ||
      obj.externalPath ||
      obj.bulletFields ||
      obj.jobPostingInfo ||
      obj.jobDescription;
    if (!hasWd && !obj.location) return;

    addRole(candidates, title, ATS_JSON_SCORE, 'workday-json', 'high');
    if (obj.locationsText) {
      addCandidate(
        candidates.location,
        obj.locationsText,
        ATS_JSON_SCORE,
        'workday-json',
        'high'
      );
    }
    const info = obj.jobPostingInfo || obj;
    if (info.location) {
      addCandidate(
        candidates.location,
        typeof info.location === 'string'
          ? info.location
          : info.location?.descriptor || '',
        ATS_JSON_SCORE,
        'workday-json',
        'high'
      );
    }
    const id =
      info.jobReqId ||
      info.requisitionId ||
      (Array.isArray(obj.bulletFields) ? obj.bulletFields[0] : '') ||
      '';
    if (id) {
      const peeled = peelRequisitionFromTitle(String(id));
      addCandidate(
        candidates.jobId,
        peeled.jobId || String(id),
        ATS_JSON_SCORE,
        'workday-json',
        'high'
      );
    }
  });
}

function collectFromInlineJson(document, candidates) {
  for (const script of qsa(document, 'script:not([src])')) {
    const raw = script.textContent || '';
    if (!/jobPosting|locationsText|externalPath|jobReqId/i.test(raw)) continue;
    const m = raw.match(
      /"title"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,400}?"locationsText"\s*:\s*"((?:\\.|[^"\\])*)"/
    );
    if (m) {
      addRole(
        candidates,
        unescapeJson(m[1]),
        ATS_JSON_SCORE - 3,
        'workday-inline',
        'high'
      );
      addCandidate(
        candidates.location,
        unescapeJson(m[2]),
        ATS_JSON_SCORE - 3,
        'workday-inline',
        'high'
      );
    }
    const req = raw.match(/"jobReqId"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (req) {
      addCandidate(
        candidates.jobId,
        unescapeJson(req[1]),
        ATS_JSON_SCORE - 3,
        'workday-inline',
        'high'
      );
    }
  }
}

function collectFromMeta(document, candidates) {
  const ogTitle = metaContent(document, ['meta[property="og:title"]']);
  if (!ogTitle) return;
  addRole(candidates, ogTitle, ATS_DOM_SCORE - 12, 'workday-meta', 'medium');
}

function unescapeJson(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}
