/**
 * Google OAuth session orchestration for the service worker.
 * Owns identity launch + token refresh; no Sheets row logic, no side panel.
 *
 * Token lifecycle: tokens live in chrome.storage.local. Access tokens last
 * ~1h; the long-lived refresh token is used to mint new ones silently. Only
 * when Google says the refresh token is dead (invalid_grant) do we drop it and
 * ask the user to sign in again — transient errors (offline, 5xx) never sign
 * the user out. `withSheetAccess` is the one entry point other modules use.
 */

import {
  getOAuthClientId,
  saveOAuthClientId,
  getOAuthClientSecret,
  saveOAuthClientSecret,
  getOauthPkce,
  saveOauthPkce,
  clearOauthPkce,
  getGoogleToken,
  saveGoogleToken,
  clearGoogleToken,
} from '../lib/storage.js';
import {
  sheetsAccessError,
  SIGN_IN_REQUIRED,
  effectiveClientId,
  effectiveClientSecret,
  hasPublishedOAuthDefaults,
  isValidClientId,
  isAccessTokenFresh,
  buildGoogleAuthUrl,
  parseOAuthRedirect,
  createPkcePair,
  exchangeCodeForToken,
  refreshAccessToken,
  normalizeRedirectUri,
} from '../lib/google-auth.js';

/** Redirect URI Google Cloud must allow (https://<ext-id>.chromiumapp.org/). */
export function getRedirectUri() {
  return normalizeRedirectUri(chrome.identity.getRedirectURL());
}

async function resolveClientId() {
  return effectiveClientId(await getOAuthClientId());
}

async function resolveClientSecret() {
  return effectiveClientSecret(await getOAuthClientSecret());
}

/** Snapshot of OAuth configuration + whether a session exists (no network). */
export async function getOauthSetup() {
  const storedId = await getOAuthClientId();
  const storedSecret = await getOAuthClientSecret();
  const clientId = effectiveClientId(storedId);
  const clientSecret = effectiveClientSecret(storedSecret);
  const token = await getGoogleToken();
  const hasSession = Boolean(token?.refreshToken) || isAccessTokenFresh(token);
  return {
    success: true,
    redirectUri: getRedirectUri(),
    clientId,
    hasSecret: Boolean(clientSecret),
    needsSetup: !clientId || !clientSecret,
    usingPublishedOAuth: hasPublishedOAuthDefaults(),
    usingCustomClient: Boolean(String(storedId || '').trim()),
    // Refresh token means the user already granted access; access tokens expire ~1h.
    signedIn: hasSession,
  };
}

/** Validate and persist a user-supplied Client ID (and optional secret). */
export async function saveOauthClient(clientId, clientSecret) {
  const trimmed = String(clientId || '').trim();
  if (!isValidClientId(trimmed)) {
    return {
      success: false,
      error: 'Paste the Client ID from Google Cloud. It ends with .apps.googleusercontent.com',
    };
  }
  await saveOAuthClientId(trimmed);
  if (typeof clientSecret === 'string' && clientSecret.trim()) {
    await saveOAuthClientSecret(clientSecret.trim());
  }
  return { success: true, ...(await getOauthSetup()) };
}

/**
 * Auth status for the UI. Silently refreshes an expired access token so
 * opening the side panel does not bounce signed-in users to Sign in.
 */
export async function getAuthStatus() {
  const setup = await getOauthSetup();
  if (setup.needsSetup) {
    return {
      success: true,
      signedIn: false,
      needsSetup: true,
      redirectUri: setup.redirectUri,
      clientId: setup.clientId,
      usingPublishedOAuth: setup.usingPublishedOAuth,
      usingCustomClient: setup.usingCustomClient,
    };
  }

  const token = await getGoogleToken();
  if (token?.refreshToken && !isAccessTokenFresh(token)) {
    try {
      await requestGoogleToken(false);
    } catch {
      // If the refresh token was revoked it has been cleared, so the re-read
      // below reports signed out. If the failure was transient (offline) the
      // refresh token is kept and we still report signed in.
    }
  }

  const fresh = await getOauthSetup();
  return {
    success: true,
    signedIn: fresh.signedIn,
    needsSetup: false,
    redirectUri: fresh.redirectUri,
    clientId: fresh.clientId,
    usingPublishedOAuth: fresh.usingPublishedOAuth,
    usingCustomClient: fresh.usingCustomClient,
  };
}

/** Promise wrapper for chrome.identity.launchWebAuthFlow (callback API). */
function launchAuthFlow(url, interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (responseUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(responseUrl);
    });
  });
}

/** Shared in-flight silent refresh so parallel callers don't race on the refresh token. */
let silentRefreshInFlight = null;

/**
 * Get a valid access token.
 * 1. If a refresh token exists, try a silent refresh.
 * 2. Otherwise (or if Google rejected the refresh token) and `interactive`,
 *    open the Google consent window; if not interactive, throw SIGN_IN_REQUIRED.
 */
async function requestGoogleToken(interactive) {
  if (!interactive) {
    // Many UI calls can ask at once; share one refresh request.
    silentRefreshInFlight ??= requestGoogleTokenUncached(false).finally(() => {
      silentRefreshInFlight = null;
    });
    return silentRefreshInFlight;
  }
  return requestGoogleTokenUncached(true);
}

async function requestGoogleTokenUncached(interactive) {
  const clientId = await resolveClientId();
  if (!clientId) {
    throw new Error('Finish Google connection in Job Tracker first (the extension shows the steps).');
  }

  const clientSecret = await resolveClientSecret();
  const existing = await getGoogleToken();

  if (existing?.refreshToken) {
    try {
      const refreshed = await refreshAccessToken({
        clientId,
        clientSecret: clientSecret || undefined,
        refreshToken: existing.refreshToken,
      });
      await saveGoogleToken(refreshed);
      return refreshed.accessToken;
    } catch (err) {
      // Only discard the session when Google says it is truly dead (revoked /
      // expired refresh token or bad client). Network blips must not sign the
      // user out. Errors without a `code` are fetch failures.
      if (err.code !== 'invalid_grant' && err.code !== 'invalid_client') {
        throw err;
      }
      await clearGoogleToken();
      if (!interactive) throw new Error(SIGN_IN_REQUIRED);
    }
  }

  if (!interactive) {
    throw new Error(SIGN_IN_REQUIRED);
  }

  const redirectUri = getRedirectUri();
  const pkce = await createPkcePair();
  // Persist the verifier: the service worker can be suspended while the
  // consent window is open and would otherwise lose it.
  await saveOauthPkce({ verifier: pkce.verifier, redirectUri, clientId });

  let parsed;
  try {
    const url = buildGoogleAuthUrl({
      clientId,
      redirectUri,
      codeChallenge: pkce.challenge,
    });
    parsed = parseOAuthRedirect(await launchAuthFlow(url, true));
  } catch (err) {
    await clearOauthPkce();
    throw err;
  }
  if (!parsed.ok) {
    await clearOauthPkce();
    throw new Error(parsed.error);
  }

  const pending = (await getOauthPkce()) || pkce;
  await clearOauthPkce();

  if (parsed.code) {
    const tokenInfo = await exchangeCodeForToken({
      clientId,
      clientSecret: clientSecret || undefined,
      code: parsed.code,
      redirectUri: pending.redirectUri || redirectUri,
      codeVerifier: pending.verifier,
    });
    await saveGoogleToken(tokenInfo);
    return tokenInfo.accessToken;
  }

  if (parsed.accessToken) {
    // Legacy implicit response: no refresh token, so the session ends in ~1h.
    await saveGoogleToken({
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      refreshToken: '',
    });
    return parsed.accessToken;
  }

  throw new Error('Google did not return a sign-in code.');
}

/** Interactive sign-in (opens Google's consent window). Never throws. */
export async function signIn() {
  try {
    const setup = await getOauthSetup();
    if (setup.needsSetup) {
      return { success: false, signedIn: false, needsSetup: true, ...setup };
    }
    const token = await requestGoogleToken(true);
    return { success: true, signedIn: Boolean(token), needsSetup: false };
  } catch (err) {
    return { success: false, signedIn: false, error: sheetsAccessError(err.message) };
  }
}

/** Forget the stored token (the Client ID/secret are kept). */
export async function signOut() {
  await clearGoogleToken();
  return { success: true, signedIn: false };
}

/**
 * Run `fn(accessToken)` with a valid Google token.
 * - Refreshes silently when the token is expired.
 * - On a 401 (token revoked/expired early) drops only the access token, retries
 *   once with a silent refresh, and falls back to the sign-in window.
 * - All failures are rethrown as Errors with user-friendly messages.
 */
export async function withSheetAccess(fn) {
  const tokenInfo = await getGoogleToken();
  let token = isAccessTokenFresh(tokenInfo) ? tokenInfo.accessToken : null;

  if (!token) {
    try {
      token = await requestGoogleToken(false);
    } catch (err) {
      // Keep transient network problems distinguishable from "sign in again".
      throw new Error(
        err.message === SIGN_IN_REQUIRED ? SIGN_IN_REQUIRED : sheetsAccessError(err.message)
      );
    }
  }

  try {
    return await fn(token);
  } catch (err) {
    const msg = err.message || '';
    if (err.status === 401 || /\b401\b|invalid.?token|unauthenticated/i.test(msg)) {
      // Keep the refresh token so the retry can be silent.
      const latest = await getGoogleToken();
      if (latest) await saveGoogleToken({ ...latest, accessToken: '', expiresAt: 0 });
      try {
        const fresh = await requestGoogleToken(true);
        // `await` is required: without it a failure of the retried call
        // escapes this try/catch and skips the friendly-message translation.
        return await fn(fresh);
      } catch (retryErr) {
        throw new Error(sheetsAccessError(retryErr.message));
      }
    }
    throw new Error(sheetsAccessError(msg));
  }
}
