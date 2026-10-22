/**
 * Job URL helpers — normalize links and pull a posting ID from the URL.
 *
 * Pure string/URL logic with no DOM or Chrome APIs. Used by the extractor (job
 * id fallback), duplicates.js (is this URL already in the sheet?) and
 * field-mapper.js (job id column).
 */

/** Query params that only track where a click came from (never identify a posting). */
const TRACKING_PARAM =
  /^(utm_|fbclid|gclid|gclsrc|mc_|ref$|refid$|source$|src$|gh_src$|lever-|trk|trackingid$|tracking_id$|si$|igsh|mkt_tok|wickedid|ebp$|lipi$|midtoken$|originalsubdomain$|_ga|msclkid|dclid|yclid|cid$|campaign$)/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hostname minus "www.", lower-cased ('' when unparsable). */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Last two hostname labels ("uk.indeed.com" -> "indeed.com"). */
function hostSuffix(url) {
  return hostOf(url).split('.').slice(-2).join('.');
}

/**
 * Normalize a job URL so tracking params and trailing slashes do not cause duplicates.
 * Lower-cases the host, drops "www.", the #hash and tracking params, forces
 * https and sorts the remaining params. Non-URL input falls back to a
 * trimmed, lower-cased string.
 */
export function normalizeJobUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.protocol = 'https:';
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    }
    // Boards whose canonical posting URL is derivable from the job id.
    if (u.hostname === 'linkedin.com' || u.hostname.endsWith('.linkedin.com')) {
      const id = extractJobId(url);
      if (/^\d{6,}$/.test(id) && /^\/jobs\/(view|collections|search)/i.test(u.pathname)) {
        return `https://linkedin.com/jobs/view/${id}`;
      }
    }
    if (/(^|\.)indeed\.[a-z.]+$/.test(u.hostname)) {
      const jk = u.searchParams.get('jk') || u.searchParams.get('vjk');
      if (jk && /^[\w-]{6,}$/.test(jk)) return `https://${u.hostname}/viewjob?jk=${jk}`;
    }
    if (u.hostname.endsWith('.myworkdayjobs.com')) u.search = '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, '');
  }
}

/** decodeURIComponent that returns the raw text on malformed escapes (e.g. "%E0%A4%A"). */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Best-effort job / requisition ID from a posting URL (no site-specific hardcoding).
 */
export function extractJobId(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    // Known id query params, in priority order. Looked up case-insensitively below.
    const paramKeys = [
      'jobId',
      'job_id',
      'jobid',
      'currentJobId',
      'reqId',
      'req_id',
      'requisitionId',
      'requisition_id',
      'gh_jid',
      'jk',
      'vjk',
      'postingId',
      'posting_id',
    ];
    const lowered = new Map();
    for (const [k, v] of u.searchParams) {
      if (!lowered.has(k.toLowerCase())) lowered.set(k.toLowerCase(), v);
    }
    for (const key of paramKeys) {
      const value = lowered.get(key.toLowerCase());
      if (value && /^[\w.-]{3,64}$/.test(value)) return value;
    }

    const parts = u.pathname.split('/').filter(Boolean);

    // Lever / Ashby style UUID posting ids (/company/<uuid>[/apply]).
    const uuid = parts.map(safeDecode).find((p) => UUID_RE.test(p));
    if (uuid) return uuid;

    // Workday: .../job/<Location>/<Title>_<ReqId>[/apply]
    const jobIdx = parts.findIndex((p) => /^job$/i.test(p));
    if (jobIdx >= 0 && /\.myworkdayjobs\.com$/i.test(u.hostname)) {
      const rest = parts.slice(jobIdx + 1);
      const applyAt = rest.findIndex((p) => /^apply/i.test(p));
      const slug = safeDecode((applyAt >= 0 ? rest.slice(0, applyAt) : rest).pop() || '');
      const req = slug.match(/_((?:R-?)?\d[\w-]*|[A-Z]{1,4}-?\d[\w-]*)$/);
      if (req) return req[1];
    }

    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = safeDecode(parts[i]);
      if (
        /^(jobs?|careers?|view|apply|opening|position|posting|requisition|opportunit(?:y|ies))$/i.test(
          seg
        )
      ) {
        // Structural path words, never an id themselves.
        continue;
      }
      if (/^\d{4,}$/.test(seg)) return seg; // long numeric segment = posting id
      // Slug with an embedded long numeric id: "senior-engineer-3812345678",
      // "743999876543210-senior-engineer".
      const slugId = seg.match(/-(\d{6,})$/) || seg.match(/^(\d{6,})-/);
      if (slugId) return slugId[1];
      // Otherwise accept an id-like slug only right after a job-ish word
      // (/jobs/abc-123), so plain words like /about-us/team are not ids.
      const prev = parts[i - 1] || '';
      if (
        /^[A-Za-z0-9][-A-Za-z0-9_.]{3,63}$/.test(seg) &&
        /jobs?|view|opening|requisition|position|posting|careers?/i.test(prev)
      ) {
        return seg;
      }
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * Do two job URLs point at the same posting? Equal after normalization, or
 * sharing the same extracted job id (e.g. same `jk=` on different Indeed paths).
 */
export function urlsMatch(a, b) {
  if (!a || !b) return false;
  if (normalizeJobUrl(a) === normalizeJobUrl(b)) return true;
  const idA = extractJobId(a);
  const idB = extractJobId(b);
  // Same id only counts on the same site (numeric ids collide across boards).
  return Boolean(idA && idB && idA === idB && hostSuffix(a) === hostSuffix(b));
}
