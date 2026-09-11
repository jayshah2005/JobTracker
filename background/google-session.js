/**
 * Google OAuth session orchestration for the service worker.
 * Owns identity launch + token refresh; no Sheets row logic, no side panel.
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
  isValidClientId,
  isAccessTokenFresh,
  buildGoogleAuthUrl,
  parseOAuthRedirect,
  createPkcePair,
  exchangeCodeForToken,
  refreshAccessToken,
  normalizeRedirectUri,
} from '../lib/google-auth.js';

export function getRedirectUri() {
  return normalizeRedirectUri(chrome.identity.getRedirectURL());
}

async function resolveClientId() {
  return effectiveClientId(await getOAuthClientId());
}

export async function getOauthSetup() {
  const stored = await getOAuthClientId();
  const clientId = effectiveClientId(stored);
  const clientSecret = await getOAuthClientSecret();
  const token = await getGoogleToken();
  return {
    success: true,
    redirectUri: getRedirectUri(),
    clientId,
    hasSecret: Boolean(clientSecret),
    needsSetup: !clientId || !clientSecret,
    signedIn: isAccessTokenFresh(token),
  };
}

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

export async function getAuthStatus() {
  const setup = await getOauthSetup();
  return {
    success: true,
    signedIn: setup.signedIn,
    needsSetup: setup.needsSetup,
    redirectUri: setup.redirectUri,
    clientId: setup.clientId,
  };
}

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

async function requestGoogleToken(interactive) {
  const clientId = await resolveClientId();
  if (!clientId) {
    throw new Error('Finish Google connection in Job Tracker first (the extension shows the steps).');
  }

  const clientSecret = await getOAuthClientSecret();
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
    } catch {
      await clearGoogleToken();
      if (!interactive) throw new Error(SIGN_IN_REQUIRED);
    }
  }

  if (!interactive) {
    throw new Error(SIGN_IN_REQUIRED);
  }

  const redirectUri = getRedirectUri();
  const pkce = await createPkcePair();
  await saveOauthPkce({ verifier: pkce.verifier, redirectUri, clientId });

  const url = buildGoogleAuthUrl({
    clientId,
    redirectUri,
    codeChallenge: pkce.challenge,
  });
  const responseUrl = await launchAuthFlow(url, true);
  const parsed = parseOAuthRedirect(responseUrl);
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
    await saveGoogleToken({
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      refreshToken: '',
    });
    return parsed.accessToken;
  }

  throw new Error('Google did not return a sign-in code.');
}

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

export async function signOut() {
  await clearGoogleToken();
  return { success: true, signedIn: false };
}

export async function withSheetAccess(fn) {
  let tokenInfo = await getGoogleToken();
  let token = isAccessTokenFresh(tokenInfo) ? tokenInfo.accessToken : null;

  if (!token) {
    try {
      token = await requestGoogleToken(false);
    } catch {
      throw new Error(SIGN_IN_REQUIRED);
    }
  }

  try {
    return await fn(token);
  } catch (err) {
    const msg = err.message || '';
    if (/401|invalid.?token|unauthenticated/i.test(msg)) {
      await clearGoogleToken();
      try {
        const fresh = await requestGoogleToken(true);
        return fn(fresh);
      } catch (refreshErr) {
        throw new Error(sheetsAccessError(refreshErr.message));
      }
    }
    throw new Error(sheetsAccessError(msg));
  }
}

