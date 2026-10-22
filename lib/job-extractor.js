/**
 * Job-posting extractor — ATS pipelines + general multi-strategy fusion.
 *
 * Runs inside the content script (via dynamic import) and in tests; it only
 * needs a DOM `document` and a URL. Two public jobs:
 *   1. isLikelyJobPage()/jobPageSignals(): decide whether the page is a single
 *      job posting (drives the floating launcher and sidepanel behaviour).
 *   2. extractJobData(): pull company / role / location / posted date / job id.
 *
 * Extraction model: every strategy pushes scored candidates
 * `{ value, score, source, confidence }` into per-field buckets. Site-specific
 * collectors (lib/extractors/*) run first with scores above 100; general
 * strategies (JSON-LD, microdata, meta tags, DOM heuristics, title patterns,
 * URL heuristics) fill gaps. crossValidate() adjusts scores, then pickBest()
 * groups equal values (votes add a small bonus) and returns the top group.
 */

import { extractJobId } from './job-url.js';
import { classifyJobUrl, urlLooksLikeJobPosting } from './job-page-url.js';
import { collectAtsCandidates, detectAts } from './extractors/index.js';
import { addCandidate, cleanValue, normalizeDate, textOf } from './extractors/shared.js';

export { normalizeDate };

/** Confidence labels stored in `result.confidence[field]`. */
const CONFIDENCE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

/**
 * Base scores per strategy (ATS collectors use 122-130 from extractors/shared.js).
 * Higher = more trustworthy; structured data beats DOM guesses beats URL guesses.
 */
const SCORE = {
  JSON_LD: 100,
  MICRODATA: 92,
  META_STRUCTURED: 78,
  ATTR_HEURISTIC: 74,
  LABELED_FIELD: 72,
  SEMANTIC_DOM: 65,
  PROXIMITY: 62,
  TITLE_PATTERN: 58,
  URL_HEURISTIC: 45,
  GENERIC_DOM: 40,
  WEAK: 25,
};

/** Nav/button words that are never a job title. */
const ROLE_NOISE =
  /^(jobs?|careers?|home|search|filter|login|sign\s*in|apply(\s+now)?|back|menu|skip|cookies?|close|share|save|saved|next|previous|loading|error)$/i;

/**
 * Looks like a place: a work-mode keyword, or "City, ST" / "City, Country".
 * Case-sensitive on purpose (capitalised place names) to reject prose.
 */
const GEO_LIKE =
  /\b(remote|hybrid|on[- ]?site|onsite|worldwide|work from home|wfh)\b|\b[A-Z][a-zA-Z.(]+(?:[\s-][A-Z][a-zA-Z.]+)*,\s*(?:[A-Z]{2}\b|[A-Z][a-z]+)/;

/** Minimum DOM score for a page with no decisive URL/schema signal. */
const JOB_PAGE_THRESHOLD = 4;

/** Action labels that mean "apply to this one posting" (whole control text). */
const APPLY_CONTROL_RE =
  /^(apply|apply now|apply here|apply today|easy apply|quick apply|apply for this (job|position|role)|apply to this (job|position|role)|apply on (the )?company (website|site)|submit (your |an )?application|start (your |an )?application|i'?m interested)$/i;

/** Section headings typical of a job description. Each pattern counts once. */
const JD_HEADING_RES = [
  /responsibilit/i,
  /qualifications?/i,
  /requirements/i,
  /what you'?ll (do|be doing|work on)/i,
  /about (the|this) (role|job|position|opportunity)/i,
  /(who you are|about you|what you bring|what we'?re looking for)/i,
  /(nice to have|bonus points|preferred)/i,
  /(benefits|perks|what we offer)/i,
  /job (description|summary|details)/i,
  /(the|your) (role|impact)/i,
];

/** Employment-detail phrases. Each pattern counts once. */
const EMPLOYMENT_RES = [
  /\bfull[- ]time\b/i,
  /\bpart[- ]time\b/i,
  /\binternship\b/i,
  /\b(salary|compensation|pay range|base pay)\b/i,
  /\bequal (employment )?opportunity\b/i,
  /\byears? of (professional |relevant )?experience\b/i,
];

/** App shells (mail, chat, docs, dashboards) render big ARIA lists/grids. */
const APP_SHELL_ROW_LIMIT = 30;
/** Many distinct posting links = a listing/search page, not one posting. */
const LISTING_LINK_LIMIT = 15;

/**
 * Heuristic: does this page look like a single job posting?
 *
 * Decisive: posting-shaped URL, host-detected ATS with a job id, or one/two
 * schema.org JobPosting entries. Otherwise the DOM is scored (apply control,
 * JD headings, employment details, job-ish URL/host) minus penalties for app
 * shells and listing pages, and must reach JOB_PAGE_THRESHOLD.
 */
export function isLikelyJobPage(url, document) {
  return jobPageSignals(url, document).isJobPage;
}

/**
 * Detailed job-page signals (exported for tests / debugging).
 * @returns {{ isJobPage: boolean, reason: string, score: number, signals: Record<string, number> }}
 */
export function jobPageSignals(url, document) {
  const urlInfo = classifyJobUrl(url);
  if (urlInfo.kind === 'posting') {
    return { isJobPage: true, reason: 'url', score: Infinity, signals: {} };
  }
  const ats = detectAts(url, null);
  if (ats.ats !== 'general' && ats.jobId) {
    return { isJobPage: true, reason: 'ats-host', score: Infinity, signals: {} };
  }
  if (!document?.body) {
    return { isJobPage: false, reason: 'no-document', score: 0, signals: {} };
  }

  const structured = countJsonLdJobPostings(document) || countMicrodataJobPostings(document);
  if (structured >= 1 && structured <= 2) {
    return { isJobPage: true, reason: 'schema', score: Infinity, signals: { structured } };
  }

  const signals = {
    urlCareers: urlInfo.kind === 'careers' ? 1 : 0,
    jobHost: urlInfo.jobHost ? 1 : 0,
    applyControl: hasApplyControl(document) ? 2 : 0,
    jdHeadings: Math.min(2, countJdHeadings(document)),
    employment: countEmploymentTerms(document) >= 2 ? 1 : 0,
    appShell: countAriaRows(document) > APP_SHELL_ROW_LIMIT ? -3 : 0,
    editor: hasLargeEditor(document) ? -2 : 0,
    listing: countPostingLinks(document) > LISTING_LINK_LIMIT ? -2 : 0,
  };
  const score = Object.values(signals).reduce((a, b) => a + b, 0);
  return {
    isJobPage: score >= JOB_PAGE_THRESHOLD,
    reason: 'dom-score',
    score,
    signals,
  };
}

/** Whitespace-normalised visible label of a button/link/input. */
function controlLabel(el) {
  const raw =
    el.tagName === 'INPUT'
      ? el.value || el.getAttribute('aria-label') || ''
      : el.textContent || el.getAttribute('aria-label') || '';
  return raw.replace(/\s+/g, ' ').trim();
}

/** Is there a button/link whose entire label is an "Apply" action? (capped scan for speed) */
function hasApplyControl(document) {
  const controls = document.querySelectorAll(
    'a, button, [role="button"], input[type="submit"], input[type="button"]'
  );
  const max = Math.min(controls.length, 600);
  for (let i = 0; i < max; i++) {
    const label = controlLabel(controls[i]);
    if (label.length <= 45 && APPLY_CONTROL_RE.test(label)) return true;
  }
  return false;
}

/** How many distinct job-description section headings appear (short heading-like nodes only). */
function countJdHeadings(document) {
  const nodes = document.querySelectorAll(
    'h1, h2, h3, h4, h5, h6, [role="heading"], strong, b, dt'
  );
  const hit = new Set();
  const max = Math.min(nodes.length, 400);
  for (let i = 0; i < max && hit.size < JD_HEADING_RES.length; i++) {
    const text = textOf(nodes[i]);
    if (!text || text.length > 80) continue;
    JD_HEADING_RES.forEach((re, idx) => {
      if (re.test(text)) hit.add(idx);
    });
  }
  return hit.size;
}

/** How many distinct employment-detail phrases appear in the main content. */
function countEmploymentTerms(document) {
  const main = document.querySelector('main, [role="main"], article') || document.body;
  const text = (main.innerText || main.textContent || '').slice(0, 12000);
  return EMPLOYMENT_RES.filter((re) => re.test(text)).length;
}

/** Rows/options/list items in ARIA widgets — large counts mean an app shell (mail, chat). */
function countAriaRows(document) {
  return document.querySelectorAll('[role="row"], [role="option"], [role="listitem"]').length;
}

/** Rich-text editors (docs, composers) outside forms are not job postings. */
function hasLargeEditor(document) {
  for (const el of document.querySelectorAll('[contenteditable=""], [contenteditable="true"]')) {
    if (el.closest('form')) continue;
    const text = el.textContent || '';
    if (text.length > 200 || el === document.body) return true;
  }
  return false;
}

/** Distinct posting-shaped links on the page; stops counting just past the listing limit. */
function countPostingLinks(document) {
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href]');
  const max = Math.min(anchors.length, 1500);
  for (let i = 0; i < max && seen.size <= LISTING_LINK_LIMIT; i++) {
    const href = anchors[i].href;
    if (href && urlLooksLikeJobPosting(href)) seen.add(href.split('#')[0]);
  }
  return seen.size;
}

function countJsonLdJobPostings(document) {
  return readJsonLdJobPostings(document).length;
}

/** All schema.org JobPosting nodes in the page's JSON-LD blocks (invalid JSON skipped). */
function readJsonLdJobPostings(document) {
  const found = [];
  if (!document) return found;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      walkJsonLd(JSON.parse(script.textContent), found);
    } catch {
      /* skip invalid / truncated JSON-LD */
    }
  }
  return found;
}

/** Microdata/RDFa JobPosting elements (itemtype or typeof). */
function countMicrodataJobPostings(document) {
  return document.querySelectorAll('[itemtype*="JobPosting" i], [typeof*="JobPosting" i]').length;
}

/**
 * First schema.org JobPosting object found in the page's JSON-LD (deep graph
 * walk), or null. Exported for tests / other modules.
 */
export function extractJsonLdJobPosting(document) {
  return readJsonLdJobPostings(document)[0] || null;
}

/** Collect every JobPosting node from a JSON-LD value, including nested/@graph ones. */
function walkJsonLd(node, out, depth = 0) {
  if (!node || depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  if (isJobPostingType(node['@type'])) out.push(node);
  if (node['@graph']) walkJsonLd(node['@graph'], out, depth + 1);
  for (const key of Object.keys(node)) {
    // @graph already walked — counting it again doubles JobPosting nodes.
    if (key === '@type' || key === '@context' || key === '@graph') continue;
    const val = node[key];
    if (val && typeof val === 'object') walkJsonLd(val, out, depth + 1);
  }
}

/** `@type` may be a string or array, sometimes a full schema.org URL. */
function isJobPostingType(type) {
  if (!type) return false;
  if (typeof type === 'string') return /JobPosting/i.test(type);
  if (Array.isArray(type)) return type.some((t) => /JobPosting/i.test(String(t)));
  return false;
}

/**
 * Score an extraction result so frames can be compared (a job page iframe may
 * hold the real posting while the top frame holds only chrome).
 * Role/company dominate; each field is weighted by its confidence label.
 * @param {object} data an extractJobData() result
 * @param {boolean} [isJobPage] bonus when the frame was judged a job page
 */
export function scoreExtraction(data, isJobPage = false) {
  if (!data) return 0;
  let s = isJobPage ? 15 : 0;
  const confWeight = { high: 1, medium: 0.65, low: 0.35 };
  for (const field of ['role', 'company', 'location', 'postedDate']) {
    if (!data[field]) continue;
    const w = confWeight[data.confidence?.[field]] ?? 0.4;
    const base = field === 'role' ? 40 : field === 'company' ? 35 : field === 'location' ? 12 : 8;
    s += base * w;
  }
  return s;
}

/**
 * Pick the strongest extraction among frame results.
 * @param {Array<{ data: object, isJobPage?: boolean }>} results one per frame
 * @param {string} [fallbackUrl] used when no frame produced data / a url
 * @returns {object} the winning extraction data (empty shell when none)
 */
export function pickBestExtraction(results, fallbackUrl = '') {
  const list = (results || []).filter((r) => r?.data);
  if (!list.length) {
    return { url: fallbackUrl, confidence: {}, sources: {} };
  }
  let best = list[0];
  let bestScore = scoreExtraction(best.data, best.isJobPage);
  for (let i = 1; i < list.length; i++) {
    const score = scoreExtraction(list[i].data, list[i].isJobPage);
    if (score > bestScore) {
      best = list[i];
      bestScore = score;
    }
  }
  const data = { ...best.data };
  if (!data.url) data.url = fallbackUrl;
  return data;
}

/**
 * Main extraction — ATS pipelines then general multi-strategy fusion.
 * @param {Document} document
 * @param {string} [url] defaults to location.href
 * @returns {{
 *   company: string, role: string, url: string, location: string,
 *   postedDate: string, jobId: string, applicationStatus: string,
 *   confidence: Record<string, 'high'|'medium'|'low'>,
 *   sources: Record<string, string>, ats: string
 * }}
 */
export function extractJobData(document, url) {
  const pageUrl = url || (typeof location !== 'undefined' ? location.href : '');
  const candidates = {
    company: [],
    role: [],
    location: [],
    postedDate: [],
    jobId: [],
    url: [
      {
        value: pageUrl,
        score: SCORE.JSON_LD,
        source: 'page-url',
        confidence: CONFIDENCE.HIGH,
      },
    ],
  };

  const atsMeta = collectAtsCandidates(document, pageUrl, candidates);

  collectJsonLdCandidates(document, candidates);
  collectMicrodataCandidates(document, candidates);
  collectMetaCandidates(document, candidates, pageUrl);
  collectNextDataGeneral(document, candidates);
  collectAttributeHeuristicCandidates(document, candidates);
  collectLabeledFieldCandidates(document, candidates);
  collectSemanticDomCandidates(document, candidates);
  collectProximityCandidates(document, candidates);
  collectTitlePatternCandidates(document, candidates);
  collectUrlHeuristicCandidates(pageUrl, candidates);
  collectGenericDomCandidates(document, candidates);

  // Strip button / suffix noise before voting so equal values group together.
  for (const c of candidates.role) {
    const v = cleanRoleTitle(c.value);
    if (v.length >= 2) c.value = v;
  }
  for (const c of candidates.company) c.value = cleanCompanyName(c.value);
  candidates.company = candidates.company.filter((c) => c.value);

  crossValidate(candidates, pageUrl, document);

  // Safety net: whatever source produced it, a posted date must be unambiguous.
  candidates.postedDate = candidates.postedDate
    .map((c) => ({ ...c, value: normalizeDate(c.value) }))
    .filter((c) => c.value);

  const result = {
    company: '',
    role: '',
    url: pageUrl,
    location: '',
    postedDate: '',
    jobId: '',
    applicationStatus: '',
    confidence: {},
    sources: {},
    ats: atsMeta?.ats || 'general',
  };

  for (const field of ['company', 'role', 'location', 'postedDate', 'jobId', 'url']) {
    const best = pickBest(candidates[field]);
    if (best) {
      result[field] = best.value;
      result.confidence[field] = scoreToConfidence(best.score, best.confidence);
      result.sources[field] = best.source;
    } else {
      result.confidence[field] = CONFIDENCE.LOW;
    }
  }

  if (!result.jobId) {
    const fromUrl = extractJobId(pageUrl);
    if (fromUrl) {
      result.jobId = fromUrl;
      result.confidence.jobId = CONFIDENCE.MEDIUM;
      result.sources.jobId = 'url';
    }
  }

  return result;
}

/**
 * Comparison key for grouping equal candidates ("Acme, Inc." == "acme inc").
 * Unicode-aware so non-Latin names (e.g. Japanese companies) still get a key;
 * an ASCII-only key was '' for them and they were silently dropped.
 */
function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Collapse candidates with the same normalized value into groups, award a
 * small bonus per extra vote (capped), and return the highest-scoring group.
 * @returns {{ value: string, score: number, source: string, confidence: string, votes: number } | null}
 */
function pickBest(list) {
  if (!list || !list.length) return null;

  const groups = new Map();
  for (const item of list) {
    const key = normalizeKey(item.value);
    if (!key) continue;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        value: item.value,
        score: item.score,
        source: item.source,
        confidence: item.confidence,
        votes: 1,
      });
      continue;
    }
    existing.votes += 1;
    if (item.score > existing.score) {
      existing.value = item.value;
      existing.score = item.score;
      existing.source = item.source;
      existing.confidence = item.confidence;
    }
  }

  for (const g of groups.values()) {
    if (g.votes > 1) g.score += Math.min(18, (g.votes - 1) * 4);
  }

  return [...groups.values()].sort((a, b) => b.score - a.score)[0];
}

/** Map a final score (or the strategy's own hint when score is decent) to a label. */
function scoreToConfidence(score, hint) {
  if (hint && score >= 50) return hint;
  if (score >= 85) return CONFIDENCE.HIGH;
  if (score >= 55) return CONFIDENCE.MEDIUM;
  return CONFIDENCE.LOW;
}

/** Lower-cased concatenation of identifying attributes, used for keyword sniffing. */
function attrBlob(el) {
  if (!el || el.nodeType !== 1) return '';
  const className =
    typeof el.className === 'string'
      ? el.className
      : el.className?.baseVal || '';
  return [
    className,
    el.id,
    el.getAttribute('name'),
    el.getAttribute('data-testid'),
    el.getAttribute('data-test'),
    el.getAttribute('data-qa'),
    el.getAttribute('data-automation-id'),
    el.getAttribute('data-field'),
    el.getAttribute('aria-label'),
    el.getAttribute('itemprop'),
    el.getAttribute('title'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** True for site chrome (header/nav/footer/sidebars) that never holds the posting itself. */
function isChromeRegion(el) {
  return !!el?.closest?.(
    'header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]'
  );
}

/** Narrowest container likely to hold the posting, falling back to <body>. */
function contentRoot(document) {
  return (
    document.querySelector('main, article, [role="main"], [itemtype*="JobPosting" i]') ||
    document.body ||
    document.documentElement
  );
}

/* -------------------- Strategies -------------------- */

function collectJsonLdCandidates(document, candidates) {
  if (!document) return;
  const jobs = readJsonLdJobPostings(document);
  // Listing pages embed many JobPostings. One or two (duplicate markup) is a posting.
  if (jobs.length < 1 || jobs.length > 2) return;

  for (const job of jobs) {
    addCandidate(
      candidates.role,
      job.title || job.name,
      SCORE.JSON_LD,
      'json-ld',
      CONFIDENCE.HIGH
    );
    addCandidate(
      candidates.company,
      getOrganizationName(job.hiringOrganization),
      SCORE.JSON_LD,
      'json-ld',
      CONFIDENCE.HIGH
    );

    const location =
      formatJobLocation(job.jobLocation) ||
      formatJobLocation(job.applicantLocationRequirements) ||
      remoteFromJob(job);
    addCandidate(candidates.location, location, SCORE.JSON_LD - 5, 'json-ld', CONFIDENCE.HIGH);

    addCandidate(
      candidates.postedDate,
      normalizeDate(job.datePosted),
      SCORE.JSON_LD,
      'json-ld',
      CONFIDENCE.HIGH
    );
    addCandidate(
      candidates.jobId,
      formatJobIdentifier(job.identifier) || job.jobId || job.requisitionId,
      SCORE.JSON_LD,
      'json-ld',
      CONFIDENCE.HIGH
    );
    if (job.url) {
      addCandidate(candidates.url, absoluteUrl(job.url, document), SCORE.JSON_LD - 10, 'json-ld', CONFIDENCE.HIGH);
    }
  }
}

/** "Remote" when schema.org marks the posting TELECOMMUTE, else ''. */
function remoteFromJob(job) {
  const type = String(job.jobLocationType || job.jobLocationTypes || '');
  if (/TELECOMMUTE|REMOTE/i.test(type)) return 'Remote';
  return '';
}

/** Root element of a microdata/RDFa JobPosting, if any. */
function findMicrodataJobPosting(document) {
  if (!document) return null;
  return (
    document.querySelector('[itemtype*="JobPosting" i]') ||
    document.querySelector('[typeof*="JobPosting" i]')
  );
}

function collectMicrodataCandidates(document, candidates) {
  const root = findMicrodataJobPosting(document);
  if (!root) return;

  const prop = (name) => {
    const el =
      root.querySelector(`[itemprop="${name}"]`) ||
      root.querySelector(`[property$="${name}" i]`);
    if (!el) return '';
    return el.getAttribute('content') || el.getAttribute('datetime') || textOf(el);
  };

  addCandidate(candidates.role, prop('title'), SCORE.MICRODATA, 'microdata', CONFIDENCE.HIGH);
  const org = root.querySelector('[itemprop="hiringOrganization"], [property*="hiringOrganization" i]');
  const orgName = org
    ? textOf(org.querySelector('[itemprop="name"], [property$="name" i]')) ||
      prop('hiringOrganization') ||
      textOf(org)
    : '';
  addCandidate(candidates.company, orgName, SCORE.MICRODATA, 'microdata', CONFIDENCE.HIGH);
  addCandidate(
    candidates.location,
    prop('jobLocation') || prop('address') || prop('jobLocationType'),
    SCORE.MICRODATA - 5,
    'microdata',
    CONFIDENCE.MEDIUM
  );
  addCandidate(
    candidates.postedDate,
    normalizeDate(prop('datePosted')),
    SCORE.MICRODATA,
    'microdata',
    CONFIDENCE.HIGH
  );
}

/**
 * Generic Next.js / SPA payload — catch JobPosting-shaped objects on any host.
 */
function collectNextDataGeneral(document, candidates) {
  if (!document) return;
  const raw = document.querySelector('script#__NEXT_DATA__')?.textContent;
  if (!raw) return;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  const visit = (node, depth = 0) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    const type = node['@type'] || node.__typename || '';
    const title = node.title || node.jobTitle || node.name || '';
    const isJob =
      /JobPosting/i.test(String(type)) ||
      (title &&
        (node.hiringOrganization ||
          node.jobLocation ||
          node.locationName ||
          node.absolute_url ||
          node.applyUrl));

    if (isJob && title && !ROLE_NOISE.test(title)) {
      addCandidate(
        candidates.role,
        title,
        SCORE.META_STRUCTURED + 5,
        'next-data',
        CONFIDENCE.HIGH
      );
      const company =
        getOrganizationName(node.hiringOrganization) ||
        node.companyName ||
        node.company?.name ||
        node.organizationName;
      if (company) {
        addCandidate(
          candidates.company,
          company,
          SCORE.META_STRUCTURED + 5,
          'next-data',
          CONFIDENCE.HIGH
        );
      }
      const loc =
        formatJobLocation(node.jobLocation) ||
        node.locationName ||
        (typeof node.location === 'string' ? node.location : node.location?.name) ||
        remoteFromJob(node);
      if (loc) {
        addCandidate(
          candidates.location,
          loc,
          SCORE.META_STRUCTURED,
          'next-data',
          CONFIDENCE.MEDIUM
        );
      }
      if (node.datePosted) {
        addCandidate(
          candidates.postedDate,
          normalizeDate(node.datePosted),
          SCORE.META_STRUCTURED,
          'next-data',
          CONFIDENCE.HIGH
        );
      }
    }

    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val && typeof val === 'object') visit(val, depth + 1);
    }
  };

  visit(data);
}

/** og:/twitter:/description meta tags: title patterns, site name, free-text company/location. */
function collectMetaCandidates(document, candidates, pageUrl) {
  if (!document) return;
  const meta = (sel) => document.querySelector(sel)?.content?.trim() || '';

  const ogTitle = meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]');
  const ogSite = meta('meta[property="og:site_name"]');
  const description =
    meta('meta[property="og:description"]') ||
    meta('meta[name="description"]') ||
    meta('meta[name="twitter:description"]');

  parseTitlePatterns(ogTitle, candidates, SCORE.META_STRUCTURED, 'og-title');

  if (ogSite && !isPlatformBrand(ogSite, pageUrl)) {
    addCandidate(candidates.company, ogSite, SCORE.META_STRUCTURED - 15, 'og-site', CONFIDENCE.MEDIUM);
  }

  // Common non-OG meta used by ATS tools
  for (const sel of [
    'meta[name="company" i]',
    'meta[name="twitter:data1"]',
    'meta[property="og:company" i]',
    'meta[name="author"]',
  ]) {
    const val = meta(sel);
    if (val && val.length < 80 && !isPlatformBrand(val, pageUrl)) {
      addCandidate(candidates.company, val, SCORE.META_STRUCTURED - 20, 'meta-company', CONFIDENCE.LOW);
    }
  }

  if (description) {
    parseTitlePatterns(description.split(/\.(\s|$)/)[0], candidates, SCORE.META_STRUCTURED - 20, 'meta-desc');
    const at = description.match(
      /\b(?:at|@|with)\s+([A-Z][\w&.\-']+(?:\s+[A-Z][\w&.\-']+){0,5})\b/
    );
    if (at && !isPlatformBrand(at[1], pageUrl)) {
      addCandidate(candidates.company, at[1], SCORE.META_STRUCTURED - 25, 'meta-desc', CONFIDENCE.LOW);
    }
    const loc = description.match(
      /\b(?:in|location[:\s]+|based in)\s*([A-Za-z][\w\s,.\-]{2,60}?)(?:\.|$)/i
    );
    if (loc && looksLikeLocation(loc[1])) {
      addCandidate(candidates.location, loc[1], SCORE.META_STRUCTURED - 20, 'meta-desc', CONFIDENCE.LOW);
    }
  }

  const posted =
    meta('meta[property="article:published_time"]') ||
    meta('meta[name="date"]') ||
    meta('meta[itemprop="datePosted"]') ||
    meta('meta[name="datePosted"]');
  addCandidate(
    candidates.postedDate,
    normalizeDate(posted),
    SCORE.META_STRUCTURED,
    'meta-date',
    CONFIDENCE.MEDIUM
  );
}

/**
 * Generic attribute / data-* / aria mining (no site-specific selectors).
 */
function collectAttributeHeuristicCandidates(document, candidates) {
  if (!document) return;
  const root = contentRoot(document);
  const nodes = root.querySelectorAll(
    '[class], [id], [data-testid], [data-test], [data-qa], [data-automation-id], [data-field], [aria-label], [itemprop], [name]'
  );

  let scanned = 0;
  for (const el of nodes) {
    if (scanned++ > 400) break; // bound work on huge DOMs
    if (isChromeRegion(el)) continue;

    const signal = attrBlob(el);
    if (!signal) continue;

    const direct = textOf(el);
    const content =
      el.getAttribute('content') ||
      el.getAttribute('value') ||
      el.getAttribute('datetime') ||
      '';
    const value = preferShortText(direct, content);
    if (!value || value.length > 140) continue;

    // Keyword sniffing on class/id/data-* names; the negative lookups below
    // exclude look-alikes (subtitle, relocation, user/session ids, ...).
    const roleHit =
      /(job[-_\s]?title|posting[-_\s]?title|position[-_\s]?title|opening[-_\s]?title|requisition[-_\s]?title|job[-_\s]?role|position[-_\s]?role)/i.test(
        signal
      ) && !/(subtitle|placeholder|error|tooltip)/i.test(signal);
    const companyHit =
      /(company[-_\s]?name|employer|organization[-_\s]?name|hiring[-_\s]?organization|\borg\b[-_\s]?name|client[-_\s]?name)/i.test(
        signal
      );
    const locationHit =
      /(job[-_\s]?location|locations?|office[-_\s]?location|work[-_\s]?location|city|workplace)/i.test(
        signal
      ) && !/(relocation|allocator)/i.test(signal);
    const dateHit = /(date[-_\s]?posted|posted[-_\s]?date|published|posting[-_\s]?date)/i.test(signal);
    const idHit =
      /(job[-_\s]?id|req(?:uisition)?[-_\s]?id|posting[-_\s]?id|requisition[-_\s]?number)/i.test(
        signal
      ) && !/(user|session|client|ga[-_])/i.test(signal);

    if (roleHit && !ROLE_NOISE.test(value) && !looksLikeSentence(value)) {
      addCandidate(candidates.role, value, SCORE.ATTR_HEURISTIC, 'attr-role', CONFIDENCE.HIGH);
    }
    if (companyHit && !looksLikeSentence(value) && wordCount(value) <= 8) {
      addCandidate(candidates.company, value, SCORE.ATTR_HEURISTIC, 'attr-company', CONFIDENCE.HIGH);
    }
    if (locationHit && looksLikeLocation(value)) {
      addCandidate(candidates.location, value, SCORE.ATTR_HEURISTIC, 'attr-location', CONFIDENCE.MEDIUM);
    }
    if (dateHit) {
      addCandidate(
        candidates.postedDate,
        normalizeDate(value),
        SCORE.ATTR_HEURISTIC,
        'attr-date',
        CONFIDENCE.MEDIUM
      );
    }
    if (idHit && looksLikeJobId(value)) {
      addCandidate(candidates.jobId, value, SCORE.ATTR_HEURISTIC, 'attr-job-id', CONFIDENCE.HIGH);
    }
  }
}

/**
 * "Company: X" / "Location: Y" style labels, both in flattened page text
 * (regexes) and in label/value DOM pairs (dt/dd, th/td, label+sibling).
 */
function collectLabeledFieldCandidates(document, candidates) {
  if (!document) return;
  const text = pageText(document, 24000);
  const patterns = [
    {
      field: 'company',
      re: /(?:company|employer|organization|organisation)\s*[:\-–]\s*([^\n|]{2,80})/gi,
      score: SCORE.LABELED_FIELD,
    },
    {
      field: 'role',
      re: /(?:job\s*title|position\s*title|position|role|requisition)\s*[:\-–]\s*([^\n|]{2,100})/gi,
      score: SCORE.LABELED_FIELD,
    },
    {
      field: 'location',
      re: /(?:location|based\s*in|office|work\s*location)\s*[:\-–]\s*([^\n|]{2,80})/gi,
      score: SCORE.LABELED_FIELD,
    },
    {
      field: 'postedDate',
      re: /(?:posted(?:\s*on)?|date\s*posted|published|listing\s*date)\s*[:\-–]\s*([^\n|]{2,40})/gi,
      score: SCORE.LABELED_FIELD,
    },
    {
      field: 'jobId',
      re: /(?:job\s*id|req(?:uisition)?\s*id|posting\s*id|requisition(?:\s*#|\s*number)?)\s*[:\-–#]?\s*([A-Za-z0-9][-A-Za-z0-9_.]{2,63})/gi,
      score: SCORE.LABELED_FIELD,
    },
  ];

  for (const { field, re, score } of patterns) {
    let match;
    const localRe = new RegExp(re.source, re.flags);
    while ((match = localRe.exec(text)) !== null) {
      const val = field === 'postedDate' ? normalizeDate(match[1]) : match[1];
      if (field === 'location' && !looksLikeLocation(val)) continue;
      if (field === 'role' && ROLE_NOISE.test(val)) continue;
      addCandidate(candidates[field], val, score, 'labeled-text', CONFIDENCE.MEDIUM);
    }
  }

  const labels = document.querySelectorAll(
    'dt, th, label, [class*="label" i], [class*="Label"], [class*="field-label" i]'
  );
  for (const labelEl of labels) {
    if (isChromeRegion(labelEl)) continue;
    const label = textOf(labelEl).toLowerCase().replace(/[:\s]+$/g, '');
    if (!label || label.length > 40) continue;

    let valueEl =
      labelEl.nextElementSibling ||
      labelEl.parentElement?.querySelector(
        'dd, td, [class*="value" i], [class*="Value"], [class*="field-value" i], span, p'
      );
    if (labelEl.htmlFor) {
      valueEl = document.getElementById(labelEl.htmlFor) || valueEl;
    }
    const value = textOf(valueEl);
    if (!value || value.length > 120 || value.toLowerCase() === label) continue;

    if (/^(company|employer|organization|organisation)$/.test(label)) {
      addCandidate(candidates.company, value, SCORE.LABELED_FIELD + 5, 'labeled-dom', CONFIDENCE.HIGH);
    } else if (/^(title|job title|position|role|requisition)$/.test(label)) {
      addCandidate(candidates.role, value, SCORE.LABELED_FIELD + 5, 'labeled-dom', CONFIDENCE.HIGH);
    } else if (/^(location|city|office|where|work location)$/.test(label)) {
      if (looksLikeLocation(value)) {
        addCandidate(candidates.location, value, SCORE.LABELED_FIELD + 5, 'labeled-dom', CONFIDENCE.HIGH);
      }
    } else if (/^(posted|date posted|date|published)$/.test(label)) {
      addCandidate(
        candidates.postedDate,
        normalizeDate(value),
        SCORE.LABELED_FIELD,
        'labeled-dom',
        CONFIDENCE.MEDIUM
      );
    } else if (/^(job id|req(?:uisition)? id|posting id|requisition(?: number|#)?)$/.test(label)) {
      if (looksLikeJobId(value)) {
        addCandidate(candidates.jobId, value, SCORE.LABELED_FIELD + 5, 'labeled-dom', CONFIDENCE.HIGH);
      }
    }
  }
}

/** Headings (H1 > H2) as role, logo/company links as company, location/date elements. */
function collectSemanticDomCandidates(document, candidates) {
  if (!document) return;
  const root = contentRoot(document);

  const headings = [...root.querySelectorAll('h1, h2')].filter((h) => !isChromeRegion(h)).slice(0, 10);
  for (const h of headings) {
    const t = textOf(h);
    if (!t || ROLE_NOISE.test(t) || t.length > 140 || looksLikeSentence(t)) continue;
    const score = h.tagName === 'H1' ? SCORE.SEMANTIC_DOM + 10 : SCORE.SEMANTIC_DOM;
    addCandidate(candidates.role, t, score, `heading-${h.tagName}`, CONFIDENCE.MEDIUM);
    parseTitlePatterns(t, candidates, score - 5, 'heading-pattern');
  }

  // Company-ish links/text near the title area
  const companyNodes = root.querySelectorAll(
    'a[href*="company" i], a[href*="companies" i], a[href*="employer" i], img[alt]'
  );
  for (const el of [...companyNodes].slice(0, 20)) {
    if (isChromeRegion(el)) continue;
    let t = textOf(el);
    if (el.tagName === 'IMG') t = (el.getAttribute('alt') || '').trim();
    if (!t || t.length > 80 || wordCount(t) > 7) continue;
    if (/logo/i.test(attrBlob(el)) || /logo/i.test(t) || el.tagName === 'IMG') {
      t = t.replace(/\slogo$/i, '').trim();
      if (t.length >= 2) {
        addCandidate(candidates.company, t, SCORE.SEMANTIC_DOM - 5, 'logo-alt', CONFIDENCE.MEDIUM);
      }
      continue;
    }
    addCandidate(candidates.company, t, SCORE.SEMANTIC_DOM - 8, 'company-link', CONFIDENCE.LOW);
  }

  const locEls = root.querySelectorAll(
    '[itemprop="address"], [itemprop="jobLocation"], [class*="location" i], [id*="location" i]'
  );
  for (const el of [...locEls].slice(0, 16)) {
    if (isChromeRegion(el)) continue;
    const t = textOf(el);
    if (t && t.length < 100 && looksLikeLocation(t)) {
      addCandidate(candidates.location, t, SCORE.SEMANTIC_DOM + 6, 'location-dom', CONFIDENCE.MEDIUM);
    }
  }

  const timeEls = root.querySelectorAll(
    'time[datetime], [itemprop="datePosted"], [datetime], [class*="posted" i], [class*="date" i]'
  );
  for (const el of [...timeEls].slice(0, 12)) {
    if (isChromeRegion(el)) continue;
    const raw = el.getAttribute('datetime') || el.getAttribute('content') || textOf(el);
    const normalized = normalizeDate(raw);
    if (normalized) {
      addCandidate(candidates.postedDate, normalized, SCORE.SEMANTIC_DOM, 'time-dom', CONFIDENCE.MEDIUM);
    }
  }
}

/**
 * Prefer values found near prominent apply CTAs and the main H1.
 */
function collectProximityCandidates(document, candidates) {
  if (!document) return;
  const root = contentRoot(document);
  const h1 = [...root.querySelectorAll('h1')].find((el) => !isChromeRegion(el) && textOf(el));
  const anchors = [];

  if (h1) anchors.push(h1);

  const applyBtns = [...document.querySelectorAll('a, button, input[type="submit"], [role="button"]')]
    .filter((el) => {
      const t = `${textOf(el)} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('value') || ''}`;
      return /\bapply\b|\bsubmit\b/i.test(t);
    })
    .slice(0, 8);
  anchors.push(...applyBtns);

  for (const anchor of anchors) {
    let node = anchor.parentElement;
    for (let depth = 0; depth < 6 && node; depth++) {
      for (const h of node.querySelectorAll('h1, h2, h3')) {
        const t = textOf(h);
        if (t && !ROLE_NOISE.test(t) && !looksLikeSentence(t)) {
          addCandidate(
            candidates.role,
            t,
            SCORE.PROXIMITY + (h.tagName === 'H1' ? 8 : 0),
            'near-cta',
            CONFIDENCE.MEDIUM
          );
        }
      }

      for (const el of node.querySelectorAll('a, span, p, div')) {
        const signal = attrBlob(el);
        const t = textOf(el);
        if (!t || t.length > 90) continue;
        if (/company|employer|org/i.test(signal) && wordCount(t) <= 7) {
          addCandidate(candidates.company, t, SCORE.PROXIMITY, 'near-cta-company', CONFIDENCE.MEDIUM);
        }
        if (/location|office|city|remote|hybrid/i.test(signal) && looksLikeLocation(t)) {
          addCandidate(candidates.location, t, SCORE.PROXIMITY, 'near-cta-location', CONFIDENCE.MEDIUM);
        }
      }
      node = node.parentElement;
    }
  }
}

/** Parse "<Role> at <Company>"-style <title>. */
function collectTitlePatternCandidates(document, candidates) {
  if (!document) return;
  parseTitlePatterns(document.title || '', candidates, SCORE.TITLE_PATTERN, 'document-title');
}

/**
 * Title patterns, tried in order; the first match wins.
 * `explicit` patterns ("Role at Company", "Role @ Company") state which side is
 * the company. The rest ("A | B", "A - B", "A (B)") are ambiguous, so both
 * orientations are added at lower scores and other signals break the tie.
 */
const TITLE_PATTERNS = [
  { re: /^(.+?)\s+at\s+(.+?)(?:\s*[-–|•].*)?$/i, explicit: true },
  { re: /^(.+?)\s+@\s+(.+?)(?:\s*[-–|•].*)?$/i, explicit: true },
  { re: /^(.+?)\s+[|•]\s+(.+?)(?:\s+[|•].*)?$/i, explicit: false },
  { re: /^(.+?)\s+[—–\-]\s+(.+?)(?:\s+[|•—–\-].*)?$/i, explicit: false },
  { re: /^(.+?)\s+\((.+?)\)\s*$/i, explicit: false },
];

/** Requisition-number shape: optional "R-" prefix plus 6-14 digits (Workday/RBC style). */
const REQ_ID_RE = /^(?:R-?)?(\d{6,14})$/i;

/**
 * Split a page/og title into role + company (+ job id) candidates.
 * @param {string} title
 * @param {object} candidates per-field buckets
 * @param {number} baseScore score for the strongest reading
 * @param {string} source label recorded on each candidate
 */
function parseTitlePatterns(title, candidates, baseScore, source) {
  if (!title) return;

  for (const { re, explicit } of TITLE_PATTERNS) {
    const m = title.match(re);
    if (!m) continue;
    const left = cleanValue(m[1]);
    let right = cleanValue(m[2]);
    if (!left || !right) continue;

    // RBC / Workday style: "Role – 0000050007 Royal Bank of Canada".
    // Peel the requisition id off the right side; what remains is the company.
    const peeledRight = right.match(/^(?:R-?)?(\d{6,14})(?:\s+(.+))?$/i);
    if (peeledRight) {
      addCandidate(
        candidates.jobId,
        peeledRight[1],
        baseScore + 10,
        `${source}-req`,
        CONFIDENCE.HIGH
      );
      right = peeledRight[2] ? cleanValue(peeledRight[2]) : '';
    }
    // "0000050007 – Role": the left side is only an id, nothing to use as a title.
    const leftReq = left.match(REQ_ID_RE);
    if (leftReq) {
      addCandidate(candidates.jobId, leftReq[1], baseScore + 10, `${source}-req`, CONFIDENCE.HIGH);
      continue;
    }

    if (explicit) {
      if (!ROLE_NOISE.test(left) && !looksLikeSentence(left)) {
        addCandidate(candidates.role, left, baseScore + 5, source, CONFIDENCE.MEDIUM);
      }
      if (right && wordCount(right) <= 8) {
        addCandidate(candidates.company, right, baseScore, source, CONFIDENCE.MEDIUM);
      }
    } else {
      // Ambiguous separators: score both orientations lower
      addCandidate(candidates.role, left, baseScore - 5, source, CONFIDENCE.LOW);
      if (right) {
        addCandidate(candidates.company, right, baseScore - 8, source, CONFIDENCE.LOW);
        // Only use right as a role alt when it looks like a title, not a req id / company
        if (!/^\d/.test(right) && wordCount(right) <= 6) {
          addCandidate(candidates.role, right, baseScore - 10, `${source}-alt`, CONFIDENCE.LOW);
        }
        addCandidate(candidates.company, left, baseScore - 12, `${source}-alt`, CONFIDENCE.LOW);
      }
    }
    break;
  }
}

/**
 * Last-resort guesses from the URL: brand from the hostname (skipping generic
 * "careers."/"jobs." labels), a title from the final path slugs, and a job id.
 */
function collectUrlHeuristicCandidates(url, candidates) {
  if (!url) return;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const labels = host.split('.');
    if (labels.length >= 2) {
      const brand = labels[0] === 'careers' || labels[0] === 'jobs' || labels[0] === 'job'
        ? labels[1]
        : labels[labels.length - 2];
      if (brand && brand.length > 2 && !isGenericHostLabel(brand)) {
        const pretty = brand.charAt(0).toUpperCase() + brand.slice(1);
        addCandidate(candidates.company, pretty, SCORE.URL_HEURISTIC, 'url-domain', CONFIDENCE.LOW);
      }
    }

    const segments = decodeURIComponent(u.pathname)
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const slug of segments.slice(-3)) {
      if (/^\d+$/.test(slug) || slug.length < 5) continue;
      const slugTitle = slug
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b(job|jobs|career|careers|opening|position|apply|req|id)\b/gi, ' ')
        .replace(/\d{4,}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (slugTitle.length > 4 && slugTitle.length < 90 && /[a-z]/i.test(slugTitle)) {
        const titleCase = slugTitle.replace(/\b\w/g, (c) => c.toUpperCase());
        if (!ROLE_NOISE.test(titleCase)) {
          addCandidate(candidates.role, titleCase, SCORE.URL_HEURISTIC - 5, 'url-slug', CONFIDENCE.LOW);
        }
      }
    }

    const fromUrl = extractJobId(url);
    if (fromUrl) {
      addCandidate(candidates.jobId, fromUrl, SCORE.URL_HEURISTIC + 5, 'url-job-id', CONFIDENCE.MEDIUM);
    }
  } catch {
    /* ignore bad URLs */
  }
}

/** Weakest signals: "Posted on ..." in body text and a "© 2026 Company" footer. */
function collectGenericDomCandidates(document, candidates) {
  if (!document) return;

  const bodySnippet = pageText(document, 6000);
  const dateMatch = bodySnippet.match(
    /(?:posted|published|listed)\s*(?:on\s*)?:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i
  );
  if (dateMatch) {
    addCandidate(
      candidates.postedDate,
      normalizeDate(dateMatch[1]),
      SCORE.GENERIC_DOM,
      'body-date',
      CONFIDENCE.LOW
    );
  }

  // Copyright / "© 2026 Company"
  const copy = bodySnippet.match(/©\s*\d{4}\s+([A-Z][\w&.\-']+(?:\s+[A-Z][\w&.\-']+){0,5})/);
  if (copy) {
    addCandidate(candidates.company, copy[1], SCORE.WEAK, 'copyright', CONFIDENCE.LOW);
  }
}

/**
 * Adjust candidate scores in place using cross-field knowledge: prefer
 * structured data, reward company names matching the host, and penalise
 * values that are obviously wrong (platform brands, bare requisition numbers,
 * sentences, cookie-banner text) or that duplicate the other field.
 */
function crossValidate(candidates, url, document) {
  const bestCompany = pickBest(candidates.company);
  const bestRole = pickBest(candidates.role);

  // Structured data wins over conflicting DOM guesses
  preferStructuredSources(candidates.role);
  preferStructuredSources(candidates.company);
  preferStructuredSources(candidates.location);
  preferStructuredSources(candidates.postedDate);
  preferStructuredSources(candidates.jobId);

  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const c of candidates.company) {
      const token = c.value.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (token.length >= 3 && host.replace(/[^a-z0-9]/g, '').includes(token.slice(0, Math.min(token.length, 14)))) {
        c.score += 14;
      }
      if (isPlatformBrand(c.value, url)) c.score -= 55;
    }
  } catch {
    /* ignore */
  }

  if (bestCompany && bestRole && normalizeKey(bestCompany.value) === normalizeKey(bestRole.value)) {
    for (const r of candidates.role) {
      if (normalizeKey(r.value) === normalizeKey(bestRole.value)) r.score -= 35;
    }
  }

  for (const r of candidates.role) {
    if (ROLE_NOISE.test(r.value)) r.score -= 55;
    if (looksLikeSentence(r.value)) r.score -= 25;
    if (wordCount(r.value) > 16) r.score -= 20;
    // Never treat a bare requisition number as the job title
    if (/^(?:R-?)?\d{5,14}$/i.test(r.value)) r.score -= 100;
    if (/^\d{6,14}\b/.test(r.value) && wordCount(r.value) <= 4) r.score -= 60;
  }

  for (const c of candidates.company) {
    if (looksLikeSentence(c.value)) c.score -= 30;
    if (wordCount(c.value) > 8) c.score -= 15;
    // "0000050007 Royal Bank…" → prefer peeling in Workday; penalize leading IDs
    if (/^(?:R-?)?\d{6,14}\b/i.test(c.value)) c.score -= 50;
  }

  for (const loc of candidates.location) {
    if (looksLikeLocation(loc.value)) loc.score += 12;
    else loc.score -= 20;
    if (/cookie|privacy|login|sign|subscribe|newsletter/i.test(loc.value)) loc.score -= 45;
  }

  const h1 = textOf(
    [...(document?.querySelectorAll('h1') || [])].find((el) => !isChromeRegion(el))
  );
  if (h1) {
    for (const r of candidates.role) {
      if (similar(r.value, h1)) r.score += 12;
    }
  }
}

/**
 * If any candidate came from structured data (JSON-LD, microdata, JSON blobs),
 * boost those and penalise DOM guesses that disagree with them.
 */
function preferStructuredSources(bucket) {
  const isStructured = (source) =>
    source === 'json-ld' ||
    source === 'microdata' ||
    source === 'next-data' ||
    /-(next|json|inline)$/.test(source || '');

  const structured = bucket.filter((c) => isStructured(c.source));
  if (!structured.length) return;
  const keys = new Set(structured.map((c) => normalizeKey(c.value)));
  for (const c of bucket) {
    if (isStructured(c.source)) {
      c.score += 15;
      continue;
    }
    if (!keys.has(normalizeKey(c.value))) {
      c.score -= 35;
    }
  }
}

/** Case-insensitive equal-or-contains. */
function similar(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
}

/** Prose, not a name/title: very long, or has sentence punctuation followed by more words. */
function looksLikeSentence(s) {
  const words = wordCount(s);
  return words > 14 || /[.!?].+\s/.test(s);
}

function wordCount(s) {
  return String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Plausible location: geo keyword, "City, ST", or a short Capitalised multi-word place. */
function looksLikeLocation(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 100) return false;
  if (/cookie|privacy|login|password|subscribe/i.test(s)) return false;
  if (GEO_LIKE.test(s)) return true;
  if (/^[A-Z][a-zA-Z.\-]+(?:[\s-][A-Z][a-zA-Z.\-]+)+$/.test(s) && wordCount(s) <= 6) return true;
  return false;
}

/** Of an element's text vs its value/content attribute, the shorter cleaned one (less likely to include noise). */
function preferShortText(a, b) {
  const left = cleanValue(a);
  const right = cleanValue(b);
  if (!left) return right;
  if (!right) return left;
  return left.length <= right.length ? left : right;
}

/** Hostname labels that name a platform/role rather than a company. */
function isGenericHostLabel(label) {
  return /^(www|careers|jobs|job|apply|app|boards|board|my|portal|go|team|workday|greenhouse|lever|ashby|icims|workable)$/i.test(
    label
  );
}

/**
 * Detect when a "company" candidate is actually the hosting platform brand.
 * Uses the page hostname — not a fixed ATS allowlist for extraction selectors.
 */
function isPlatformBrand(name, pageUrl) {
  if (!name || !pageUrl) return false;
  try {
    const host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, '');
    const token = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (token.length < 4) return false;
    const hostToken = host.replace(/[^a-z0-9]/g, '');
    // Only known job platforms count. A company on its own domain
    // (acme.com -> "Acme") must never be penalised as a "platform brand".
    return PLATFORM_BRANDS.some(
      (brand) =>
        hostToken.includes(brand) &&
        token.startsWith(brand) &&
        token.length <= brand.length + 8
    );
  } catch {
    return false;
  }
}

const PLATFORM_BRANDS = [
  'linkedin', 'indeed', 'glassdoor', 'greenhouse', 'lever', 'ashby', 'ashbyhq',
  'workday', 'myworkdayjobs', 'smartrecruiters', 'icims', 'workable', 'jobvite',
  'taleo', 'ziprecruiter', 'monster', 'wellfound', 'angellist', 'bamboohr',
  'breezy', 'recruitee', 'teamtailor', 'jazzhr', 'rippling', 'dayforce', 'ultipro',
  'successfactors', 'oraclecloud', 'paylocity', 'paycom', 'builtin', 'dice',
];

/** Strip "Careers at", "Join", trailing "Careers"/"Jobs"/"Career Site" noise from a company name. */
export function cleanCompanyName(value) {
  let s = String(value || '').trim();
  s = s.replace(/^(?:careers?|jobs?)\s+(?:at|with|@)\s+/i, '');
  s = s.replace(/^join\s+(?:the\s+)?(?:team\s+at\s+)?/i, '');
  s = s.replace(
    /\s*[|\-–—:]?\s*(?:careers?(?:\s+(?:site|page|portal))?|jobs?(?:\s+board)?|hiring|recruiting|employment|work\s+with\s+us)\s*$/i,
    ''
  );
  s = s.replace(/^[\s|\-–—:]+|[\s|\-–—:]+$/g, '').trim();
  return s.length >= 2 ? s : String(value || '').trim();
}

/** Remove "Apply" / "Apply now" button text that leaked into a title. */
export function cleanRoleTitle(value) {
  let s = String(value || '').trim();
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/(?<=[a-z\)])(?:Easy\s+)?Apply(?:\s+now)?$/, '') // "EngineerApply"
      .replace(/\s*[|\-–—•·]?\s*\b(?:Easy\s+Apply|Apply(?:\s+(?:now|here|today|for\s+this\s+job|to\s+this\s+job))?)\s*$/i, '')
      .replace(/^(?:Apply\s+(?:for|to)\s+(?:the\s+)?(?:job|position|role)?:?\s*)/i, '')
      .trim();
  }
  return s;
}

/* -------------------- Helpers -------------------- */

/** hiringOrganization may be a string, object, or array of either. */
function getOrganizationName(org) {
  if (!org) return '';
  if (typeof org === 'string') return org;
  if (Array.isArray(org)) {
    return org.map(getOrganizationName).filter(Boolean)[0] || '';
  }
  return org.name || org.legalName || '';
}

/** schema.org `identifier` may be a scalar, a PropertyValue object, or an array. */
function formatJobIdentifier(identifier) {
  if (!identifier) return '';
  if (typeof identifier === 'string' || typeof identifier === 'number') {
    return String(identifier);
  }
  if (Array.isArray(identifier)) {
    return formatJobIdentifier(identifier[0]);
  }
  if (typeof identifier === 'object') {
    return String(identifier.value || identifier.name || identifier['@value'] || '');
  }
  return '';
}

/** Short token-like id (no spaces/URLs). */
function looksLikeJobId(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 64) return false;
  if (looksLikeSentence(s) || /https?:/i.test(s)) return false;
  return /^[A-Za-z0-9][-A-Za-z0-9_./]{2,63}$/.test(s);
}

/**
 * Flatten schema.org jobLocation (Place / PostalAddress / array / string) to
 * "City, Region, Country"; multiple places are joined with "; ".
 */
export function formatJobLocation(loc) {
  if (!loc) return '';
  if (typeof loc === 'string') return loc;
  if (Array.isArray(loc)) {
    return loc.map(formatJobLocation).filter(Boolean).join('; ');
  }
  if (typeof loc !== 'object') return '';

  const addr = loc.address;
  if (addr) {
    if (typeof addr === 'string') return addr;
    return [addr.addressLocality, addr.addressRegion, addr.addressCountry]
      .filter(Boolean)
      .join(', ');
  }
  if (loc.name) return loc.name;
  if (loc['@type'] && /Place|PostalAddress|AdministrativeArea|Country/i.test(String(loc['@type']))) {
    return [loc.addressLocality, loc.addressRegion, loc.addressCountry, loc.name]
      .filter(Boolean)
      .join(', ');
  }
  return '';
}

/** Resolve a possibly-relative URL against the document's base URI. */
function absoluteUrl(maybeRelative, document) {
  try {
    return new URL(maybeRelative, document?.baseURI || undefined).toString();
  } catch {
    return String(maybeRelative || '');
  }
}

/** Visible body text truncated to `max` chars (bounds regex cost on huge pages). */
function pageText(document, max = 20000) {
  if (!document?.body) return '';
  const text = document.body.innerText || document.body.textContent || '';
  return text.slice(0, max);
}
