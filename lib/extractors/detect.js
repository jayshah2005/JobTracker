/**
 * Detect which ATS / job-board a page belongs to, from its URL host first and
 * (when a document is supplied) embedded-markup hints second. Also extracts
 * the ATS-specific ids that can be read from the URL (job id, board/tenant).
 *
 * Used by extractors/index.js to pick a collector and by job-extractor.js
 * (URL-only, document = null) to treat "known ATS host + job id" as a job page.
 */

/** True when `host` is `domain` or one of its subdomains (not "notdomain"). */
function hostIs(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * @param {string} [url]
 * @param {Document|null} [document] enables HTML-hint detection for embeds
 * @returns {{ ats: string, jobId?: string, [k: string]: string }} `ats` is
 *   'general' when nothing matched.
 */
export function detectAts(url = '', document = null) {
  const href = String(url || '');
  const host = safeHost(href);
  const htmlHint = documentHint(document);

  // A recognised ATS/board host always wins over markup hints (a Greenhouse
  // page that links to LinkedIn is still Greenhouse).
  if (!hostIsKnownPlatform(host)) return detectByHints(href, document, htmlHint);

  return detectByHost(href, host, document);
}

function hostIsKnownPlatform(host) {
  return (
    hostIs(host, 'linkedin.com') ||
    /(^|\.)indeed\.[a-z.]+$/i.test(host) ||
    hostIs(host, 'greenhouse.io') ||
    hostIs(host, 'myworkdayjobs.com') ||
    hostIs(host, 'workday.com') ||
    hostIs(host, 'lever.co') ||
    hostIs(host, 'ashbyhq.com') ||
    hostIs(host, 'smartrecruiters.com')
  );
}

function detectByHost(href, host, document) {
  return detectByHints(href, document, NO_HINTS, host);
}

const NO_HINTS = {};

function detectByHints(href, document, htmlHint, hostArg) {
  const host = hostArg ?? safeHost(href);
  if (hostIs(host, 'linkedin.com') || htmlHint.linkedin) {
    return { ats: 'linkedin', ...parseLinkedIn(href) };
  }

  if (/(^|\.)indeed\.[a-z.]+$/i.test(host) || htmlHint.indeed) {
    return { ats: 'indeed', ...parseIndeed(href) };
  }

  if (
    hostIs(host, 'greenhouse.io') ||
    htmlHint.greenhouse
  ) {
    return { ats: 'greenhouse', ...parseGreenhouse(href, document) };
  }

  if (
    hostIs(host, 'myworkdayjobs.com') ||
    hostIs(host, 'workday.com') ||
    htmlHint.workday
  ) {
    return { ats: 'workday', ...parseWorkday(href) };
  }

  if (hostIs(host, 'lever.co') || htmlHint.lever) {
    return { ats: 'lever', ...parseLever(href) };
  }

  if (
    hostIs(host, 'ashbyhq.com') ||
    htmlHint.ashby
  ) {
    return { ats: 'ashby', ...parseAshby(href) };
  }

  if (
    hostIs(host, 'smartrecruiters.com') ||
    htmlHint.smartrecruiters
  ) {
    return { ats: 'smartrecruiters', ...parseSmartRecruiters(href) };
  }

  // Last resort: a Greenhouse short link / embed URL on a non-Greenhouse host.
  if (/greenhouse\.io|grnh\.se/i.test(href) || htmlHint.greenhouseEmbed) {
    return { ats: 'greenhouse', ...parseGreenhouse(href, document) };
  }

  return { ats: 'general' };
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Cheap regex scan of the first 120KB of page HTML for ATS fingerprints.
 * Lets us recognise ATS pages embedded on a company's own domain.
 */
function documentHint(document) {
  if (!document) {
    return {
      greenhouse: false,
      greenhouseEmbed: false,
      workday: false,
      lever: false,
      ashby: false,
      smartrecruiters: false,
      linkedin: false,
      indeed: false,
    };
  }
  const html = String(document.documentElement?.innerHTML || '').slice(0, 120000);
  return {
    greenhouse:
      /boards\.greenhouse\.io|job-boards\.greenhouse\.io|greenhouse-job-board|data-greenhouse/i.test(
        html
      ),
    greenhouseEmbed: /boards\.greenhouse\.io\/embed|grnh\.se/i.test(html),
    workday: /myworkdayjobs\.com|data-automation-id=["']jobPostingHeader/i.test(html),
    lever: /jobs\.lever\.co|lever-jobs-embed|posting-headline/i.test(html),
    ashby: /jobs\.ashbyhq\.com\/[^\s"']*|ashby_jid|ashby-job-posting-brief/i.test(html),
    smartrecruiters: /(?:jobs|careers)\.smartrecruiters\.com|oneclick-ui|data-test=["']job-title/i.test(html),
    linkedin: /jobs-unified-top-card|job-details-jobs-unified/i.test(html),
    indeed: /jobsearch-JobInfoHeader|data-jk=/i.test(html),
  };
}

function parseLinkedIn(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const viewIdx = parts.findIndex((p) => p.toLowerCase() === 'view');
    let jobId = '';
    if (viewIdx >= 0 && parts[viewIdx + 1]) {
      // /jobs/view/3812345678 or /jobs/view/senior-engineer-at-acme-3812345678
      const seg = parts[viewIdx + 1];
      jobId = (seg.match(/^(\d+)$/) || seg.match(/-(\d{6,})$/) || [])[1] || '';
    }
    if (!jobId) {
      const cur = new URL(url).searchParams.get('currentJobId') || '';
      if (/^\d+$/.test(cur)) jobId = cur;
    }
    return { jobId };
  } catch {
    return { jobId: '' };
  }
}

function parseIndeed(url) {
  try {
    const u = new URL(url);
    const jk = u.searchParams.get('jk') || u.searchParams.get('vjk') || '';
    return { jobId: jk };
  } catch {
    return { jobId: '' };
  }
}

function parseGreenhouse(url, document) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    // /{board}/jobs/{id} or /embed/job_app?for=board&token=id
    let board = '';
    let jobId = '';
    const jobsIdx = parts.findIndex((p) => p.toLowerCase() === 'jobs');
    if (jobsIdx > 0) {
      board = parts[jobsIdx - 1];
      jobId = parts[jobsIdx + 1] || '';
    } else if (parts.length >= 1 && !/embed|job_app/i.test(parts[0])) {
      board = parts[0];
    }
    const forParam = u.searchParams.get('for');
    const token = u.searchParams.get('token') || u.searchParams.get('gh_jid');
    if (forParam) board = forParam;
    if (token) jobId = token;
    if (!board && document) {
      const embed = document.querySelector?.(
        'iframe[src*="greenhouse"], a[href*="boards.greenhouse.io"]'
      );
      const src = embed?.src || embed?.href || '';
      const m = src.match(/greenhouse\.io\/([^/?#]+)/i);
      if (m) board = m[1];
    }
    return { board, jobId };
  } catch {
    return { board: '', jobId: '' };
  }
}

function parseWorkday(url) {
  try {
    const u = new URL(url);
    const hostM = u.hostname.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
    const tenant = hostM?.[1] || '';
    const pod = hostM?.[2] || '';
    const parts = u.pathname.split('/').filter(Boolean);
    // Skip locale prefixes like en-US
    const filtered = parts.filter((p) => !/^[a-z]{2}(-[A-Za-z]{2,4})?$/i.test(p));
    const site = filtered[0] || '';
    let jobId = '';
    // .../job/[Location/]Title_ReqId[/apply[/...]] — the slug is the segment
    // right before any "apply" tail (the location segment is NOT the id).
    const jobIdx = filtered.findIndex((p) => /^jobs?$/i.test(p));
    if (jobIdx >= 0) {
      const rest = filtered.slice(jobIdx + 1);
      const applyAt = rest.findIndex((p) => /^apply/i.test(p));
      jobId = (applyAt >= 0 ? rest.slice(0, applyAt) : rest).pop() || '';
    }
    return { tenant, pod, site, jobId };
  } catch {
    return { tenant: '', pod: '', site: '', jobId: '' };
  }
}

function parseLever(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return { company: parts[0] || '', jobId: parts[1] || '' };
  } catch {
    return { company: '', jobId: '' };
  }
}

function parseAshby(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return { org: parts[0] || '', jobId: parts[1] || '' };
  } catch {
    return { org: '', jobId: '' };
  }
}

function parseSmartRecruiters(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    // /Company/job-title-id or /Company/Id
    return {
      company: parts[0] || '',
      jobId: parts[parts.length - 1] || '',
      numericId: (parts[parts.length - 1] || '').match(/^(\d{6,})/)?.[1] || '',
    };
  } catch {
    return { company: '', jobId: '' };
  }
}
