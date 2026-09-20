/**
 * Greenhouse job-board extraction (boards.greenhouse.io / embeds).
 */

import {
  ATS_DOM_SCORE,
  ATS_JSON_SCORE,
  ATS_SCORE,
  addCandidate,
  companyFromObject,
  firstText,
  humanizeSlug,
  jobIdFromObject,
  locationFromObject,
  metaContent,
  parseNextData,
  qs,
  qsa,
  titleFromObject,
  walkObjects,
} from './shared.js';

export function collectGreenhouse(document, url, candidates, meta = {}) {
  if (!document) return;

  collectFromNextData(document, candidates);
  collectFromInlineJson(document, candidates);
  collectFromDom(document, candidates);
  collectFromMeta(document, candidates);

  const board = meta.board || '';
  const jobId = meta.jobId || '';
  if (board) {
    addCandidate(
      candidates.company,
      humanizeSlug(board),
      ATS_SCORE - 8,
      'greenhouse-board',
      'medium'
    );
  }
  if (jobId) {
    addCandidate(candidates.jobId, String(jobId), ATS_SCORE, 'greenhouse-url', 'high');
  }
}

function collectFromNextData(document, candidates) {
  const next = parseNextData(document);
  if (!next) return;

  walkObjects(next, (obj) => {
    const title = titleFromObject(obj);
    const looksJob =
      title &&
      (obj.absolute_url ||
        obj.absoluteUrl ||
        obj.internal_job_id != null ||
        obj.location ||
        obj.departments ||
        /job/i.test(String(obj.__typename || '')));
    if (!looksJob) return;

    if (title) {
      addCandidate(candidates.role, title, ATS_JSON_SCORE, 'greenhouse-next', 'high');
    }
    const company = companyFromObject(obj) || obj.company_name;
    if (company) {
      addCandidate(
        candidates.company,
        company,
        ATS_JSON_SCORE,
        'greenhouse-next',
        'high'
      );
    }
    const loc = locationFromObject(obj);
    if (loc) {
      addCandidate(candidates.location, loc, ATS_JSON_SCORE, 'greenhouse-next', 'high');
    }
    const id = jobIdFromObject(obj);
    if (id && looksLikeGhId(id)) {
      addCandidate(candidates.jobId, id, ATS_JSON_SCORE, 'greenhouse-next', 'high');
    }
    const posted = obj.updated_at || obj.created_at || obj.first_published;
    if (posted) {
      addCandidate(
        candidates.postedDate,
        String(posted).slice(0, 10),
        ATS_JSON_SCORE - 5,
        'greenhouse-next',
        'medium'
      );
    }
  });
}

function collectFromInlineJson(document, candidates) {
  for (const script of qsa(document, 'script:not([src])')) {
    const raw = script.textContent || '';
    if (!/absolute_url|greenhouse|internal_job_id/i.test(raw)) continue;
    const blobs = extractJsonBlobs(raw);
    for (const obj of blobs) {
      walkObjects(obj, (node) => {
        if (!node?.title || !(node.absolute_url || node.internal_job_id != null)) return;
        addCandidate(
          candidates.role,
          node.title,
          ATS_JSON_SCORE - 2,
          'greenhouse-inline',
          'high'
        );
        if (node.location?.name || typeof node.location === 'string') {
          addCandidate(
            candidates.location,
            node.location?.name || node.location,
            ATS_JSON_SCORE - 2,
            'greenhouse-inline',
            'high'
          );
        }
        if (node.id != null) {
          addCandidate(
            candidates.jobId,
            String(node.id),
            ATS_JSON_SCORE - 2,
            'greenhouse-inline',
            'high'
          );
        }
      });
    }
  }
}

function collectFromDom(document, candidates) {
  const role = firstText(document, [
    'h1.app-title',
    '.app-title',
    '#header h1',
    '[data-testid="job-title"]',
    'h1.section-header',
  ]);
  if (role && !/^jobs?$/i.test(role)) {
    addCandidate(candidates.role, role, ATS_DOM_SCORE, 'greenhouse-dom', 'high');
  }

  const company = firstText(document, [
    '.company-name',
    '[data-testid="company-name"]',
    '#header .company-name',
    'a.company-name',
  ]);
  if (company) {
    addCandidate(candidates.company, company, ATS_DOM_SCORE, 'greenhouse-dom', 'high');
  }

  const location = firstText(document, [
    '.location',
    '.job__location',
    '[data-testid="job-location"]',
    '#header .location',
    '.app-location',
  ]);
  if (location) {
    addCandidate(
      candidates.location,
      location,
      ATS_DOM_SCORE,
      'greenhouse-dom',
      'high'
    );
  }

  // Logo alt often has company name on classic boards
  const logo = qs(document, '#logo img, .logo img, img[alt*="logo" i]');
  const alt = logo?.getAttribute?.('alt');
  if (alt && !/greenhouse|logo/i.test(alt)) {
    addCandidate(
      candidates.company,
      alt.replace(/\s*logo$/i, ''),
      ATS_DOM_SCORE - 10,
      'greenhouse-logo',
      'medium'
    );
  }
}

function collectFromMeta(document, candidates) {
  const ogTitle = metaContent(document, [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
  ]);
  if (ogTitle) {
    const parts = ogTitle.split(/\s+[|\-–—]\s+/);
    if (parts[0]) {
      addCandidate(
        candidates.role,
        parts[0],
        ATS_DOM_SCORE - 15,
        'greenhouse-meta',
        'medium'
      );
    }
    if (parts[1] && !/greenhouse|jobs?/i.test(parts[1])) {
      addCandidate(
        candidates.company,
        parts[1],
        ATS_DOM_SCORE - 15,
        'greenhouse-meta',
        'medium'
      );
    }
  }
}

function extractJsonBlobs(raw) {
  const out = [];
  // Assignment forms: window.foo = {...}
  const assign = raw.match(
    /(?:job|posting|Jobs?)\s*[:=]\s*(\{[\s\S]*?\})\s*;/i
  );
  if (assign) {
    try {
      out.push(JSON.parse(assign[1]));
    } catch {
      /* ignore */
    }
  }
  // Bare object containing absolute_url
  const idx = raw.indexOf('"absolute_url"');
  if (idx >= 0) {
    const start = raw.lastIndexOf('{', idx);
    if (start >= 0) {
      const slice = balancedObject(raw, start);
      if (slice) {
        try {
          out.push(JSON.parse(slice));
        } catch {
          /* ignore */
        }
      }
    }
  }
  return out;
}

function balancedObject(str, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

function looksLikeGhId(id) {
  return /^\d{4,}$/.test(String(id)) || /greenhouse|boards\./i.test(String(id));
}
