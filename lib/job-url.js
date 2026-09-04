/**
 * Job URL helpers — normalize links and pull a posting ID from the URL.
 */

const TRACKING_PARAM =
  /^(utm_|fbclid|gclid|gclsrc|mc_|ref$|source$|trk|si$|igsh|mkt_tok|wickedid)/i;

/**
 * Normalize a job URL so tracking params and trailing slashes do not cause duplicates.
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
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Best-effort job / requisition ID from a posting URL (no site-specific hardcoding).
 */
export function extractJobId(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
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
    for (const key of paramKeys) {
      const value = u.searchParams.get(key);
      if (value && /^[\w.-]{3,64}$/.test(value)) return value;
    }

    const parts = u.pathname.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = decodeURIComponent(parts[i]);
      if (
        /^(jobs?|careers?|view|apply|opening|position|posting|requisition|opportunit(?:y|ies))$/i.test(
          seg
        )
      ) {
        continue;
      }
      if (/^\d{4,}$/.test(seg)) return seg;
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

export function urlsMatch(a, b) {
  if (!a || !b) return false;
  if (normalizeJobUrl(a) === normalizeJobUrl(b)) return true;
  const idA = extractJobId(a);
  const idB = extractJobId(b);
  return Boolean(idA && idB && idA === idB);
}
