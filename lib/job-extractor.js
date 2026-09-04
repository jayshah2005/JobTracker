/**
 * Advanced local job-posting extractor.
 *
 * Runs independent strategies, scores candidates, then fuses the best value
 * per field. No site-specific selectors — only schema, labels, attributes,
 * layout, and text patterns that work across career sites and ATS pages.
 */

import { extractJobId } from './job-url.js';

const CONFIDENCE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

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

const JOB_PATH_RE =
  /\/(jobs?|careers?|positions?|openings?|vacancies|vacancy|apply|requisitions?|hiring|opportunit(?:y|ies))\b/i;

const JOB_KEYWORDS = [
  'job',
  'career',
  'position',
  'opening',
  'vacancy',
  'apply',
  'hiring',
  'recruit',
  'employment',
  'internship',
  'intern',
];

const ROLE_NOISE =
  /^(jobs?|careers?|home|search|filter|login|sign\s*in|apply(\s+now)?|back|menu|skip|cookies?|close|share|save|saved|next|previous|loading|error)$/i;

const DATE_RE =
  /(\d{4}-\d{2}-\d{2})|(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})|(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}/i;

const GEO_LIKE =
  /\b(remote|hybrid|on[- ]?site|onsite|worldwide|work from home|wfh)\b|\b[A-Z][a-zA-Z.(]+(?:[\s-][A-Z][a-zA-Z.]+)*,\s*(?:[A-Z]{2}\b|[A-Z][a-z]+)/;

/**
 * Heuristic: does this page look like a job posting?
 */
export function isLikelyJobPage(url, document) {
  const urlLower = (url || '').toLowerCase();
  if (JOB_PATH_RE.test(urlLower)) return true;
  if (!document) return false;
  if (extractJsonLdJobPosting(document)) return true;
  if (findMicrodataJobPosting(document)) return true;

  const title = (document.title || '').toLowerCase();
  const bodyText = pageText(document, 8000).toLowerCase();
  const hasKeyword = JOB_KEYWORDS.some((kw) => title.includes(kw) || bodyText.includes(kw));
  const hasApply = /\bapply\b|\bsubmit\s+(an\s+)?application\b|\bstart\s+application\b/i.test(
    bodyText
  );
  return (
    hasKeyword &&
    (hasApply ||
      /\sat\s/.test(title) ||
      /hiring|we're hiring|we are hiring|join (our|the) team/i.test(bodyText))
  );
}

/**
 * Parse JSON-LD JobPosting schema from page (deep graph walk).
 */
export function extractJsonLdJobPosting(document) {
  if (!document) return null;
  const found = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      walkJsonLd(JSON.parse(script.textContent), found);
    } catch {
      /* skip invalid / truncated JSON-LD */
    }
  }
  return found[0] || null;
}

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
    if (key === '@type' || key === '@context') continue;
    const val = node[key];
    if (val && typeof val === 'object') walkJsonLd(val, out, depth + 1);
  }
}

function isJobPostingType(type) {
  if (!type) return false;
  if (typeof type === 'string') return /JobPosting/i.test(type);
  if (Array.isArray(type)) return type.some((t) => /JobPosting/i.test(String(t)));
  return false;
}

/**
 * Score an extraction result (for multi-frame merge).
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
 * Main extraction — multi-strategy candidate fusion.
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

  collectJsonLdCandidates(document, candidates);
  collectMicrodataCandidates(document, candidates);
  collectMetaCandidates(document, candidates, pageUrl);
  collectAttributeHeuristicCandidates(document, candidates);
  collectLabeledFieldCandidates(document, candidates);
  collectSemanticDomCandidates(document, candidates);
  collectProximityCandidates(document, candidates);
  collectTitlePatternCandidates(document, candidates);
  collectUrlHeuristicCandidates(pageUrl, candidates);
  collectGenericDomCandidates(document, candidates);
  crossValidate(candidates, pageUrl, document);

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

  return result;
}

function addCandidate(bucket, value, score, source, confidence) {
  const cleaned = cleanValue(value);
  if (!cleaned) return;
  bucket.push({ value: cleaned, score, source, confidence });
}

function cleanValue(value) {
  if (value == null) return '';
  let s = String(value).replace(/\s+/g, ' ').trim();
  s = s.replace(/^[\-–—•·|]+/, '').replace(/[\-–—•·|]+$/, '').trim();
  // Drop common trailing site suffixes from titles
  s = s.replace(/\s*[|\-–—]\s*(careers?|jobs?|home)\s*$/i, '').trim();
  if (s.length < 2 || s.length > 220) return '';
  return s;
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

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

function scoreToConfidence(score, hint) {
  if (hint && score >= 50) return hint;
  if (score >= 85) return CONFIDENCE.HIGH;
  if (score >= 55) return CONFIDENCE.MEDIUM;
  return CONFIDENCE.LOW;
}

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

function isChromeRegion(el) {
  return !!el?.closest?.(
    'header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]'
  );
}

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
  const jobs = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      walkJsonLd(JSON.parse(script.textContent), jobs);
    } catch {
      /* ignore */
    }
  }

  for (const job of jobs) {
    addCandidate(candidates.role, job.title, SCORE.JSON_LD, 'json-ld', CONFIDENCE.HIGH);
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

function remoteFromJob(job) {
  const type = String(job.jobLocationType || job.jobLocationTypes || '');
  if (/TELECOMMUTE|REMOTE/i.test(type)) return 'Remote';
  return '';
}

function findMicrodataJobPosting(document) {
  if (!document) return null;
  return (
    document.querySelector('[itemtype*="JobPosting" i]') ||
    document.querySelector('[typeof*="JobPosting" i]') ||
    document.querySelector('[itemtype*="schema.org/JobPosting"]')
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
    if (scanned++ > 400) break;
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

function collectTitlePatternCandidates(document, candidates) {
  if (!document) return;
  parseTitlePatterns(document.title || '', candidates, SCORE.TITLE_PATTERN, 'document-title');
}

function parseTitlePatterns(title, candidates, baseScore, source) {
  if (!title) return;
  const patterns = [
    /^(.+?)\s+at\s+(.+?)(?:\s*[-–|•].*)?$/i,
    /^(.+?)\s+@\s+(.+?)(?:\s*[-–|•].*)?$/i,
    /^(.+?)\s+[|•]\s+(.+?)(?:\s+[|•].*)?$/i,
    /^(.+?)\s+[—–\-]\s+(.+?)(?:\s+[|•—–\-].*)?$/i,
    /^(.+?)\s+\((.+?)\)\s*$/i,
  ];

  for (const re of patterns) {
    const m = title.match(re);
    if (!m) continue;
    const left = cleanValue(m[1]);
    const right = cleanValue(m[2]);
    if (!left || !right) continue;

    if (/at/i.test(re.source) || /@/.test(re.source)) {
      if (!ROLE_NOISE.test(left) && !looksLikeSentence(left)) {
        addCandidate(candidates.role, left, baseScore + 5, source, CONFIDENCE.MEDIUM);
      }
      if (wordCount(right) <= 8) {
        addCandidate(candidates.company, right, baseScore, source, CONFIDENCE.MEDIUM);
      }
    } else {
      // Ambiguous separators: score both orientations lower
      addCandidate(candidates.role, left, baseScore - 5, source, CONFIDENCE.LOW);
      addCandidate(candidates.company, right, baseScore - 8, source, CONFIDENCE.LOW);
      addCandidate(candidates.role, right, baseScore - 10, `${source}-alt`, CONFIDENCE.LOW);
      addCandidate(candidates.company, left, baseScore - 12, `${source}-alt`, CONFIDENCE.LOW);
    }
    break;
  }
}

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
  }

  for (const c of candidates.company) {
    if (looksLikeSentence(c.value)) c.score -= 30;
    if (wordCount(c.value) > 8) c.score -= 15;
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

function preferStructuredSources(bucket) {
  const structured = bucket.filter((c) => c.source === 'json-ld' || c.source === 'microdata');
  if (!structured.length) return;
  const keys = new Set(structured.map((c) => normalizeKey(c.value)));
  for (const c of bucket) {
    if (c.source === 'json-ld' || c.source === 'microdata') {
      c.score += 15;
      continue;
    }
    if (!keys.has(normalizeKey(c.value))) {
      c.score -= 35;
    }
  }
}

function similar(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
}

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

function looksLikeLocation(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 100) return false;
  if (/cookie|privacy|login|password|subscribe/i.test(s)) return false;
  if (GEO_LIKE.test(s)) return true;
  if (/^[A-Z][a-zA-Z.\-]+(?:[\s-][A-Z][a-zA-Z.\-]+)+$/.test(s) && wordCount(s) <= 6) return true;
  return false;
}

function preferShortText(a, b) {
  const left = cleanValue(a);
  const right = cleanValue(b);
  if (!left) return right;
  if (!right) return left;
  return left.length <= right.length ? left : right;
}

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
    // "LinkedIn" on linkedin.com, "Indeed" on indeed.com, etc.
    if (hostToken.startsWith(token) || token.startsWith(hostToken.slice(0, token.length))) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/* -------------------- Helpers -------------------- */

function getOrganizationName(org) {
  if (!org) return '';
  if (typeof org === 'string') return org;
  if (Array.isArray(org)) {
    return org.map(getOrganizationName).filter(Boolean)[0] || '';
  }
  return org.name || org.legalName || '';
}

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

function looksLikeJobId(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 64) return false;
  if (looksLikeSentence(s) || /https?:/i.test(s)) return false;
  return /^[A-Za-z0-9][-A-Za-z0-9_./]{2,63}$/.test(s);
}

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

export function normalizeDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      if (y > 1990 && y < 2100) {
        return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
    }
  } catch {
    /* ignore */
  }
  const m = s.match(DATE_RE);
  if (m) {
    try {
      const d = new Date(m[0]);
      if (!isNaN(d.getTime())) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
    } catch {
      /* ignore */
    }
  }
  return '';
}

function absoluteUrl(maybeRelative, document) {
  try {
    return new URL(maybeRelative, document?.baseURI || undefined).toString();
  } catch {
    return String(maybeRelative || '');
  }
}

function pageText(document, max = 20000) {
  if (!document?.body) return '';
  const text = document.body.innerText || document.body.textContent || '';
  return text.slice(0, max);
}

function textOf(el) {
  return el?.textContent?.replace(/\s+/g, ' ').trim() || '';
}
