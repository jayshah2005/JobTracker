/**
 * Role-vs-company likelihood scoring for ambiguous title parts
 * ("A - B", "A | B", "A: B"). Pure functions, no DOM.
 *
 * roleScore() > 0 leans role, < 0 leans company. Plural nouns
 * ("Engineers Without Borders") and corporate-suffix endings
 * ("Lead Generation Inc") are deliberately not treated as roles.
 */

const ROLE_NOUNS = new Set([
  'engineer', 'developer', 'manager', 'analyst', 'designer', 'scientist', 'architect',
  'director', 'intern', 'internship', 'associate', 'specialist', 'consultant', 'coordinator',
  'administrator', 'technician', 'recruiter', 'representative', 'rep', 'officer', 'assistant',
  'accountant', 'nurse', 'driver', 'programmer', 'strategist', 'planner', 'auditor',
  'researcher', 'writer', 'editor', 'producer', 'supervisor', 'executive', 'advisor',
  'adviser', 'agent', 'operator', 'mechanic', 'electrician', 'technologist', 'therapist',
  'pharmacist', 'physician', 'teacher', 'instructor', 'tutor', 'cashier', 'clerk',
  'receptionist', 'paralegal', 'attorney', 'counsel', 'controller', 'president', 'founder',
  'sde', 'swe', 'sre', 'vp', 'cto', 'cfo', 'coo', 'ceo', 'evangelist', 'trainee',
  'apprentice', 'chef', 'cook', 'barista', 'bartender', 'server', 'warehouse', 'machinist',
  'underwriter', 'actuary', 'buyer', 'merchandiser', 'tester', 'qa', 'sdet', 'devops',
  'owner', 'lead', 'head',
]);
const WEAK_ROLE_WORDS = new Set([
  'senior', 'junior', 'staff', 'principal', 'sr', 'jr', 'entry', 'mid', 'level', 'chief',
  'software', 'data', 'product', 'backend', 'frontend', 'front-end', 'back-end', 'fullstack',
  'full', 'stack', 'mobile', 'cloud', 'machine', 'learning', 'security', 'network', 'systems',
  'sales', 'marketing', 'customer', 'success', 'support', 'operations', 'finance', 'hr',
  'ux', 'ui', 'web', 'platform', 'infrastructure', 'technical', 'business', 'account',
  'project', 'program', 'regional', 'general', 'lead', 'ii', 'iii', 'iv', 'contract',
  'part-time', 'full-time', 'temporary', 'seasonal',
]);
const COMPANY_SUFFIX = new Set([
  'inc', 'llc', 'ltd', 'corp', 'co', 'gmbh', 'ag', 'plc', 'llp', 'lp', 'limited',
  'corporation', 'company', 'sa', 'bv', 'pty', 'pvt', 'oy', 'ab', 'srl', 'kk',
]);
const COMPANY_TAIL_WORDS = new Set([
  'technologies', 'technology', 'labs', 'lab', 'group', 'holdings', 'systems', 'solutions',
  'industries', 'enterprises', 'partners', 'ventures', 'capital', 'bank', 'university',
  'foundation', 'studios', 'interactive', 'networks', 'international', 'global',
]);
const ROLE_ABBREVIATIONS = new Set(['VP', 'SDE', 'SWE', 'SRE', 'QA', 'PM', 'UX', 'UI', 'HR', 'CEO', 'CTO', 'CFO', 'COO', 'IT', 'BI', 'ML', 'AI', 'SDET']);

const CAREERS_SUFFIX_RE = /\b(careers?|jobs?|job (?:search|board|openings?)|hiring)$/i;
const CAREERS_ONLY_RE = /^(careers?|jobs?|job (?:search|board|openings?|details?|description|posting)|hiring|apply|home|work with us|join us|open positions?)$/i;
const LOCATION_RE =
  /^(?:remote|hybrid|on[- ]?site|onsite|worldwide|anywhere|work from home|wfh|(?:fully |100% )?remote(?: [-(].*)?|[A-Z][\p{L}.'-]+(?:\s[A-Z][\p{L}.'-]+)*,\s*(?:[A-Z]{2}|[A-Z][\p{L}.'-]+(?:\s[A-Z][\p{L}.'-]+)*)|united states|usa|us|uk|canada|india|remote\s*\(.*\)|\(?remote\)?)$/iu;

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#-]+/u)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
}

function alnum(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Evidence the text is a job role (>= 0). */
export function roleEvidence(text) {
  const toks = tokens(text);
  if (!toks.length) return 0;
  // Strip a trailing corporate suffix: the head noun before it is a name, not a role.
  const last = toks[toks.length - 1];
  const hasSuffix = toks.length > 1 && COMPANY_SUFFIX.has(last);
  const body = hasSuffix ? toks.slice(0, -1) : toks;

  let score = 0;
  let strong = 0;
  body.forEach((t, i) => {
    if (t === 'lead' && /^(gen|generation|gens)$/.test(body[i + 1] || '')) return;
    if (t === 'head' && body[i + 1] !== 'of' && i !== body.length - 1) return;
    if (ROLE_NOUNS.has(t)) {
      strong += 1;
      score += strong === 1 ? 3 : 1;
      if (i === body.length - 1) score += 1;
    } else if (WEAK_ROLE_WORDS.has(t)) {
      score += 1;
    }
  });
  return Math.min(score, 8);
}

/** Evidence the text is a company name (>= 0). `host` is the page hostname. */
export function companyEvidence(text, host = '') {
  const raw = String(text || '').trim();
  if (!raw) return 0;
  const toks = tokens(raw);
  let score = 0;
  const last = toks[toks.length - 1];
  if (toks.length > 1 && COMPANY_SUFFIX.has(last)) score += 4;
  else if (toks.length > 1 && COMPANY_TAIL_WORDS.has(last)) score += 3;
  if (CAREERS_SUFFIX_RE.test(raw) && toks.length >= 1) score += 3;

  const roleEv = roleEvidence(raw);
  if (/^[A-Z0-9&]{2,5}$/.test(raw) && !ROLE_ABBREVIATIONS.has(raw) && roleEv === 0) score += 2;
  if (toks.length === 1 && roleEv === 0 && /^[A-Z]/.test(raw)) score += 1;

  const token = alnum(raw.replace(CAREERS_SUFFIX_RE, ''));
  const hostToken = alnum(String(host).replace(/^www\./i, ''));
  if (token.length >= 3 && hostToken && hostToken.includes(token.slice(0, Math.min(token.length, 14)))) {
    score += 3;
  }
  return score;
}

/** Positive: reads like a role. Negative: reads like a company. */
export function roleScore(text, host = '') {
  return roleEvidence(text) - companyEvidence(text, host);
}

/** True when the text more likely names a job role than a company. */
export function looksLikeRole(text, host = '') {
  return roleScore(text, host) >= 2;
}

/** True when the text more likely names a company than a job role. */
export function looksLikeCompany(text, host = '') {
  return roleScore(text, host) <= -2;
}

/** Work-mode / place fragment ("Remote", "Austin, TX") that is neither role nor company. */
export function isLocationPart(text) {
  const s = String(text || '').trim().replace(/^\(|\)$/g, '');
  return !!s && roleEvidence(s) === 0 && LOCATION_RE.test(s);
}

/** Bare "Careers"/"Jobs" style fragment. */
export function isCareersNoise(text) {
  return CAREERS_ONLY_RE.test(String(text || '').trim());
}

/**
 * Split a multi-segment title on | • – — - (or a single ": ") and drop
 * location and careers-noise segments. Returns the remaining segments.
 */
export function splitTitleSegments(title) {
  let parts = String(title || '').split(/\s+[|•—–-]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1) {
    const m = parts[0].match(/^(.+?):\s+(.+)$/);
    if (m) parts = [m[1].trim(), m[2].trim()];
  }
  if (parts.length > 2) {
    const kept = parts.filter((p) => !isLocationPart(p) && !isCareersNoise(p));
    if (kept.length >= 2) parts = kept;
  }
  return parts;
}

/**
 * Decide orientation of "left / right". Returns 'left-role', 'right-role' or
 * 'unknown' (scores too close; caller keeps its default behaviour).
 */
export function classifyRoleCompany(left, right, host = '') {
  const diff = roleScore(left, host) - roleScore(right, host);
  if (diff >= 3) return 'left-role';
  if (diff <= -3) return 'right-role';
  return 'unknown';
}
