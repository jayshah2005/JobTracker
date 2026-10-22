/**
 * Google sign-in helpers (pure logic + token HTTP calls; no chrome.* APIs).
 *
 * Flow: authorization code + PKCE via chrome.identity.launchWebAuthFlow (the
 * launch itself lives in background/google-session.js). This module builds the
 * auth URL, parses the redirect, exchanges/refreshes tokens, and translates
 * low-level errors into messages a non-technical user can act on.
 * The Client ID is saved from the UI — users never edit source files.
 */

import {
  DEFAULT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_CLIENT_SECRET,
  SHEETS_SCOPE,
  hasPublishedOAuthDefaults,
} from './oauth-config.js';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export const SIGN_IN_REQUIRED =
  'Sign in with Google. That account is used for every spreadsheet you add.';

/** True when `id` looks like a Google OAuth Web client ID. */
export function isValidClientId(id) {
  return typeof id === 'string' && /\.apps\.googleusercontent\.com$/.test(id.trim());
}

export function effectiveClientId(storedId) {
  const fromStore = String(storedId || '').trim();
  if (isValidClientId(fromStore)) return fromStore;
  const baked = String(DEFAULT_OAUTH_CLIENT_ID || '').trim();
  return isValidClientId(baked) ? baked : '';
}

/** Stored secret wins; otherwise use published default from oauth-config. */
export function effectiveClientSecret(storedSecret) {
  const fromStore = String(storedSecret || '').trim();
  if (fromStore) return fromStore;
  return String(DEFAULT_OAUTH_CLIENT_SECRET || '').trim();
}

export { hasPublishedOAuthDefaults };

/** Access token is usable if present and not within 60s of expiry (clock-skew margin). */
export function isAccessTokenFresh(tokenInfo, now = Date.now()) {
  if (!tokenInfo?.accessToken || !tokenInfo.expiresAt) return false;
  return tokenInfo.expiresAt - 60_000 > now;
}

/**
 * chrome.identity.getRedirectURL() must match Google Cloud exactly.
 * Google rejects a missing/extra trailing slash.
 */
export function normalizeRedirectUri(uri) {
  if (!uri || typeof uri !== 'string') return '';
  const trimmed = uri.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.hostname.endsWith('.chromiumapp.org') && url.pathname === '') {
      url.pathname = '/';
    }
    return url.toString();
  } catch {
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  }
}

/** Base64url (RFC 4648 §5, no padding) as required for PKCE. */
export function base64UrlEncode(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Generate a PKCE verifier and its S256 challenge. */
export async function createPkcePair() {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(random);
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return { verifier, challenge: base64UrlEncode(hash) };
}

/**
 * Build the Google consent URL. `prompt=consent` + `access_type=offline`
 * guarantees Google returns a refresh token on every interactive sign-in.
 */
export function buildGoogleAuthUrl({ clientId, redirectUri, codeChallenge }) {
  if (!isValidClientId(clientId)) {
    throw new Error('A valid Google Client ID is required before signing in.');
  }
  const redirect = normalizeRedirectUri(redirectUri);
  if (!redirect) {
    throw new Error('Missing redirect URI.');
  }
  if (!codeChallenge) {
    throw new Error('Missing PKCE challenge.');
  }

  const params = new URLSearchParams({
    client_id: clientId.trim(),
    redirect_uri: redirect,
    response_type: 'code',
    scope: SHEETS_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Parse authorization code (PKCE) or legacy implicit token from the redirect URL.
 */
export function parseOAuthRedirect(responseUrl) {
  if (!responseUrl || typeof responseUrl !== 'string') {
    return { ok: false, error: 'Sign-in was cancelled.' };
  }

  const hashIndex = responseUrl.indexOf('#');
  const queryIndex = responseUrl.indexOf('?');
  const hashParams =
    hashIndex >= 0 ? new URLSearchParams(responseUrl.slice(hashIndex + 1)) : new URLSearchParams();
  const queryParams =
    queryIndex >= 0
      ? new URLSearchParams(responseUrl.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined))
      : new URLSearchParams();

  const error = queryParams.get('error') || hashParams.get('error');
  if (error) {
    return { ok: false, error: friendlyOAuthError(error) };
  }

  const code = queryParams.get('code') || hashParams.get('code');
  if (code) {
    return { ok: true, code };
  }

  const accessToken = hashParams.get('access_token') || queryParams.get('access_token');
  if (accessToken) {
    const expiresIn = parseInt(hashParams.get('expires_in') || queryParams.get('expires_in') || '3600', 10);
    return {
      ok: true,
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  return { ok: false, error: 'Google did not return a sign-in code.' };
}

/** Map an OAuth `error` query value to guidance for the Set up Google screen. */
export function friendlyOAuthError(error) {
  const code = String(error || '').toLowerCase();
  if (code === 'access_denied') {
    return 'Sign-in was cancelled. If Google showed an error first, open Set up Google → Common problems and fixes.';
  }
  if (code.includes('org_internal') || code.includes('organisation') || code.includes('organization')) {
    return 'Google blocked this account (organisation restriction). Open Set up Google → Common problems and fixes → change Audience to External.';
  }
  if (code.includes('redirect') || code.includes('invalid_request')) {
    return 'Google rejected the redirect link. Open Set up Google → Common problems and fixes for the redirect URI steps.';
  }
  return error;
}

/** Normalize a token-endpoint response into the shape we persist. */
export function tokenFromResponse(data, previousRefreshToken) {
  if (!data?.access_token) {
    throw new Error(data?.error_description || data?.error || 'Token exchange failed.');
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previousRefreshToken || '',
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

/**
 * Build an Error from a token-endpoint failure. `code` carries Google's
 * machine-readable error (e.g. "invalid_grant") so callers can tell a revoked
 * refresh token (sign in again) from a transient failure (keep the token).
 */
function tokenError(data, status, fallback) {
  const err = new Error(data.error_description || data.error || `${fallback} (${status})`);
  err.code = data.error || '';
  err.status = status;
  return err;
}

/** Exchange an authorization code (+ PKCE verifier) for access/refresh tokens. */
export async function exchangeCodeForToken(
  { clientId, clientSecret, code, redirectUri, codeVerifier },
  fetchImpl = fetch
) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: normalizeRedirectUri(redirectUri),
    code_verifier: codeVerifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw tokenError(data, res.status, 'Token exchange failed');
  }
  return tokenFromResponse(data);
}

/** Get a new access token from a refresh token. Keeps the old refresh token if Google omits one. */
export async function refreshAccessToken(
  { clientId, clientSecret, refreshToken },
  fetchImpl = fetch
) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw tokenError(data, res.status, 'Token refresh failed');
  }
  return tokenFromResponse(data, refreshToken);
}

/**
 * Translate a raw auth/Sheets error message into plain-language guidance.
 * Order matters: more specific patterns come first. Unknown messages pass
 * through unchanged so no information is lost.
 */
export function sheetsAccessError(originalMessage = '') {
  const msg = String(originalMessage || '');
  if (/did not approve|user (closed|cancel)|window was closed|cancell?ed/i.test(msg)) {
    return 'Sign-in was cancelled. Click Sign in with Google to try again.';
  }
  if (/failed to fetch|networkerror|load failed|err_internet|err_network/i.test(msg)) {
    return 'Could not reach Google. Check your internet connection and try again.';
  }
  if (/429|quota|rate.?limit|too many requests/i.test(msg)) {
    return 'Google is limiting requests right now. Wait a minute and try again.';
  }
  if (/client_secret is missing|invalid_client/i.test(msg)) {
    return (
      'Google needs the Client secret from the same Web application OAuth client. ' +
      'Paste it in Job Tracker (shown next to the Client ID in Google Cloud).'
    );
  }
  if (/redirect_uri|unauthorized_client/i.test(msg)) {
    return (
      'The redirect link in Google Cloud must match the one Job Tracker shows, exactly ' +
      '(including the trailing slash). Copy it from the extension and add it under Authorized redirect URIs.'
    );
  }
  if (/OAuth2|client_id|bad client/i.test(msg)) {
    return 'Google sign-in is not finished yet. Complete the connection steps shown in Job Tracker.';
  }
  if (/not signed in|sign.in required|user is not signed in/i.test(msg)) {
    return SIGN_IN_REQUIRED;
  }
  if (/401|invalid.?token|unauthenticated|invalid_grant/i.test(msg)) {
    return 'Google access expired. Sign in again — it will still be reused for all of your sheets.';
  }
  if (/403|permission|forbidden|caller does not have/i.test(msg)) {
    return 'Could not edit this spreadsheet. It must be editable by the Google account you signed in with.';
  }
  if (/not found|404/i.test(msg)) {
    return 'Spreadsheet not found. Check the link, and that the signed-in account can open it.';
  }
  return originalMessage || 'Could not access Google Sheets.';
}
