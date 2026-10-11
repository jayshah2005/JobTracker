/**
 * Fast URL-only heuristics for “looks like a job posting”.
 * Platform-general (any board / company) — never posting- or employer-specific.
 * Used by the content-script launcher before full DOM extraction.
 */

/** Career/job segments that usually mean a posting or careers surface. */
const JOB_PATH_RE =
  /\/(jobs?|careers?|positions?|openings?|vacancies|vacancy|apply|requisitions?|hiring|opportunit(?:y|ies))\b/i;

/**
 * Hosts that are job boards even when the path shape varies by vendor.
 * Patterns match the whole platform, not a single employer.
 */
const ATS_HOST_RE =
  /(^|\.)(job-boards\.greenhouse\.io|boards\.greenhouse\.io|greenhouse\.io|jobs\.lever\.co|lever\.co|myworkdayjobs\.com|workday\.com|jobs\.ashbyhq\.com|ashbyhq\.com|smartrecruiters\.com)$/i;

/**
 * @param {string} url
 * @returns {boolean}
 */
export function urlLooksLikeJobPosting(url) {
  try {
    const u = new URL(String(url || ''));
    const host = u.hostname.replace(/^www\./i, '');
    const path = u.pathname || '';

    // Generic: any site whose path looks like a job/careers URL.
    if (JOB_PATH_RE.test(path)) return true;

    // Known ATS hosts: treat job-id query params as a posting.
    if (ATS_HOST_RE.test(host) && /[?&](token|gh_jid|jobId|job_id|currentJobId)=/i.test(u.search)) {
      return true;
    }

    // Known ATS hosts with at least board + slug path (e.g. /acme/abc-def).
    if (ATS_HOST_RE.test(host) && path.split('/').filter(Boolean).length >= 2) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/** @deprecated Prefer urlLooksLikeJobPosting — same behavior. */
export function isKnownAtsJobUrl(url) {
  return urlLooksLikeJobPosting(url);
}
