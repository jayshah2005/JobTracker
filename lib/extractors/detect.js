/**
 * Detect which ATS / job-board host a page belongs to.
 */

export function detectAts(url = '', document = null) {
  const href = String(url || '');
  const host = safeHost(href);
  const htmlHint = documentHint(document);

  if (
    /boards\.greenhouse\.io$/i.test(host) ||
    /job-boards\.greenhouse\.io$/i.test(host) ||
    /greenhouse\.io$/i.test(host) ||
    htmlHint.greenhouse
  ) {
    return { ats: 'greenhouse', ...parseGreenhouse(href, document) };
  }

  if (
    /myworkdayjobs\.com$/i.test(host) ||
    /\.workday\.com$/i.test(host) ||
    htmlHint.workday
  ) {
    return { ats: 'workday', ...parseWorkday(href) };
  }

  if (/jobs\.lever\.co$/i.test(host) || /lever\.co$/i.test(host) || htmlHint.lever) {
    return { ats: 'lever', ...parseLever(href) };
  }

  if (
    /jobs\.ashbyhq\.com$/i.test(host) ||
    /ashbyhq\.com$/i.test(host) ||
    htmlHint.ashby
  ) {
    return { ats: 'ashby', ...parseAshby(href) };
  }

  if (
    /smartrecruiters\.com$/i.test(host) ||
    /jobs\.smartrecruiters\.com$/i.test(host) ||
    htmlHint.smartrecruiters
  ) {
    return { ats: 'smartrecruiters', ...parseSmartRecruiters(href) };
  }

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

function documentHint(document) {
  if (!document) {
    return {
      greenhouse: false,
      greenhouseEmbed: false,
      workday: false,
      lever: false,
      ashby: false,
      smartrecruiters: false,
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
    ashby: /jobs\.ashbyhq\.com|ashbyhq/i.test(html),
    smartrecruiters: /smartrecruiters\.com|data-test=["']job-title/i.test(html),
  };
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
    let site = filtered[0] || '';
    let jobId = '';
    const jobIdx = filtered.findIndex((p) => /^jobs?$/i.test(p));
    if (jobIdx >= 0 && filtered[jobIdx + 1]) {
      jobId = filtered[jobIdx + 1];
      if (!site) site = filtered[0];
    } else {
      // .../job/Location/Title_ReqId
      const j = filtered.findIndex((p) => /^job$/i.test(p));
      if (j >= 0) {
        jobId = filtered[filtered.length - 1] || '';
      }
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
    };
  } catch {
    return { company: '', jobId: '' };
  }
}
