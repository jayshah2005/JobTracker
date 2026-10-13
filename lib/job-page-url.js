/**
 * URL-only job-page classification. Platform-general: rules describe URL
 * shapes (path segments, job-id params, jobs/careers hosts), never specific
 * employers or postings. Only pathname + query are read — never the #hash,
 * which web apps use for client-side routing.
 */

/** Path words that reliably mean jobs/careers. */
const STRONG_JOB_WORDS = new Set([
  'job',
  'jobs',
  'career',
  'careers',
  'opening',
  'openings',
  'vacancy',
  'vacancies',
  'requisition',
  'requisitions',
]);

/** Path words that are job-ish but also common elsewhere; never enough alone. */
const WEAK_JOB_WORDS = new Set([
  'position',
  'positions',
  'opportunity',
  'opportunities',
  'posting',
  'postings',
  'apply',
]);

/** Segments between the job word and the posting id that carry no meaning. */
const PASS_THROUGH = new Set(['view', 'details', 'detail', 'show', 'listing']);

/** Segments that mean a list/landing page rather than one posting. */
const LISTING_WORDS = new Set([
  'search',
  'all',
  'list',
  'index',
  'results',
  'department',
  'departments',
  'location',
  'locations',
  'team',
  'teams',
  'category',
  'categories',
  'filter',
  'saved',
  'alerts',
  'home',
  'overview',
  'benefits',
  'culture',
  'about',
  'faq',
  'students',
  'university',
]);

/** Query keys that identify a posting on any site. */
const GLOBAL_JOB_ID_PARAMS = new Set([
  'gh_jid',
  'jobid',
  'job_id',
  'jk',
  'vjk',
  'currentjobid',
  'jobreqid',
  'requisitionid',
  'postingid',
  'jobpostingid',
]);

/** Generic id keys that count only when the path already looks job-related. */
const SCOPED_ID_PARAMS = new Set(['id', 'token', 'jid', 'req', 'reqid', 'req_id']);

/** Hostname labels that mark a dedicated jobs/careers host. */
const JOB_HOST_LABELS = new Set([
  'jobs',
  'job',
  'careers',
  'career',
  'boards',
  'job-boards',
  'apply',
  'hiring',
  'recruiting',
  'talent',
]);

const LOCALE_RE = /^[a-z]{2}(-[a-z]{2,4})?$/i;

function pathSegments(pathname) {
  return String(pathname || '')
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s).toLowerCase();
      } catch {
        return s.toLowerCase();
      }
    })
    .filter((s) => !LOCALE_RE.test(s));
}

function segmentJobStrength(seg) {
  if (STRONG_JOB_WORDS.has(seg)) return 2;
  if (WEAK_JOB_WORDS.has(seg)) return 1;
  // Compound segments like `job_app` or `careers-portal`.
  const parts = seg.split(/[-_]/).filter(Boolean);
  if (parts.length > 1 && parts.some((p) => STRONG_JOB_WORDS.has(p))) return 2;
  return 0;
}

/** Slug/id after a job word: has digits or is a multi-word title slug. */
function looksLikePostingSlug(seg) {
  if (!seg || LISTING_WORDS.has(seg)) return false;
  if (/\d/.test(seg)) return true;
  return seg.split(/[-_]/).filter(Boolean).length >= 2;
}

/** Bare id on a jobs host (UUIDs, numeric ids). */
function looksLikeOpaqueId(seg) {
  return Boolean(seg) && (/\d/.test(seg) || seg.length >= 20);
}

function isJobHost(hostname) {
  const labels = String(hostname || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  labels.pop(); // TLD
  return labels.some(
    (l) => JOB_HOST_LABELS.has(l) || l.endsWith('jobs') || l.endsWith('careers')
  );
}

function queryHas(u, keys) {
  for (const [key, value] of u.searchParams) {
    if (keys.has(key.toLowerCase()) && String(value).trim()) return true;
  }
  return false;
}

/**
 * Classify a URL.
 * - `posting`: very likely a single job posting
 * - `careers`: job-related surface (careers home, listings) but not clearly one posting
 * - `none`: no URL signal
 *
 * @param {string} url
 * @returns {{ kind: 'posting'|'careers'|'none', jobHost: boolean }}
 */
export function classifyJobUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return { kind: 'none', jobHost: false };
  }
  if (!/^https?:$/i.test(u.protocol)) return { kind: 'none', jobHost: false };

  const jobHost = isJobHost(u.hostname);
  const segs = pathSegments(u.pathname);

  if (queryHas(u, GLOBAL_JOB_ID_PARAMS)) return { kind: 'posting', jobHost };

  const jobIdx = segs.findIndex((s) => segmentJobStrength(s) > 0);
  if (jobIdx >= 0) {
    const strength = segmentJobStrength(segs[jobIdx]);
    const rest = segs
      .slice(jobIdx + 1)
      .filter((s) => !PASS_THROUGH.has(s) && segmentJobStrength(s) === 0);
    const firstIsListing = rest.length > 0 && LISTING_WORDS.has(rest[0]);
    const hasSlug = !firstIsListing && rest.some(looksLikePostingSlug);
    const hasScopedId = queryHas(u, SCOPED_ID_PARAMS);

    if ((strength === 2 || jobHost) && (hasSlug || hasScopedId)) {
      return { kind: 'posting', jobHost };
    }
    return { kind: 'careers', jobHost };
  }

  // Dedicated jobs hosts often use /{board}/{id} with no job word in the path.
  if (jobHost && segs.length >= 2 && looksLikeOpaqueId(segs[segs.length - 1])) {
    return { kind: 'posting', jobHost };
  }

  return { kind: jobHost ? 'careers' : 'none', jobHost };
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function urlLooksLikeJobPosting(url) {
  return classifyJobUrl(url).kind === 'posting';
}

/** @deprecated Prefer urlLooksLikeJobPosting — same behavior. */
export function isKnownAtsJobUrl(url) {
  return urlLooksLikeJobPosting(url);
}
