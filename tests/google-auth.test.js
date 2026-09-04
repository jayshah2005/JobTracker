import {
  sheetsAccessError,
  SIGN_IN_REQUIRED,
  isValidClientId,
  effectiveClientId,
  isAccessTokenFresh,
  normalizeRedirectUri,
  buildGoogleAuthUrl,
  parseOAuthRedirect,
  tokenFromResponse,
  exchangeCodeForToken,
  refreshAccessToken,
} from '../lib/google-auth.js';
import { SHEETS_SCOPE } from '../lib/oauth-config.js';

describe('sheetsAccessError', () => {
  test('points people to in-extension Google setup', () => {
    const msg = sheetsAccessError('bad client id OAuth2');
    expect(msg.toLowerCase()).toContain('job tracker');
    expect(msg.toLowerCase()).not.toContain('manifest');
  });

  test('explains permission errors in terms of the signed-in account', () => {
    const msg = sheetsAccessError('Google Sheets API error: 403');
    expect(msg.toLowerCase()).toContain('edit');
    expect(msg.toLowerCase()).not.toContain('service account');
  });

  test('asks to sign in when no token', () => {
    expect(sheetsAccessError('not signed in')).toBe(SIGN_IN_REQUIRED);
  });

  test('explains missing client secret', () => {
    const msg = sheetsAccessError('client_secret is missing');
    expect(msg.toLowerCase()).toContain('client secret');
  });

  test('passes through unrelated errors', () => {
    expect(sheetsAccessError('Network failed')).toBe('Network failed');
  });
});

describe('client ID helpers', () => {
  test('accepts googleusercontent client ids', () => {
    expect(isValidClientId('123-abc.apps.googleusercontent.com')).toBe(true);
    expect(isValidClientId('')).toBe(false);
    expect(isValidClientId('not-a-client')).toBe(false);
  });

  test('prefers stored client id over empty default', () => {
    expect(effectiveClientId('123-abc.apps.googleusercontent.com')).toBe(
      '123-abc.apps.googleusercontent.com'
    );
    expect(effectiveClientId('')).toBe('');
  });
});

describe('normalizeRedirectUri', () => {
  test('adds trailing slash for chromiumapp origins', () => {
    expect(normalizeRedirectUri('https://foebhcdboejpmibcjecefijgmkhkcoll.chromiumapp.org')).toBe(
      'https://foebhcdboejpmibcjecefijgmkhkcoll.chromiumapp.org/'
    );
  });

  test('keeps an existing trailing slash', () => {
    const uri = 'https://foebhcdboejpmibcjecefijgmkhkcoll.chromiumapp.org/';
    expect(normalizeRedirectUri(uri)).toBe(uri);
  });
});

describe('buildGoogleAuthUrl', () => {
  const clientId = '123-abc.apps.googleusercontent.com';
  const redirectUri = 'https://foebhcdboejpmibcjecefijgmkhkcoll.chromiumapp.org/';

  test('uses authorization code + PKCE, not implicit grant', () => {
    const url = buildGoogleAuthUrl({
      clientId,
      redirectUri,
      codeChallenge: 'challenge123',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth'
    );
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge123');
    expect(parsed.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(parsed.searchParams.get('scope')).toBe(SHEETS_SCOPE);
    expect(parsed.searchParams.get('include_granted_scopes')).toBeNull();
    expect(parsed.searchParams.get('access_type')).toBe('offline');
  });

  test('refuses to build a URL without a client id', () => {
    expect(() =>
      buildGoogleAuthUrl({
        clientId: '',
        redirectUri,
        codeChallenge: 'x',
      })
    ).toThrow(/client id/i);
  });
});

describe('parseOAuthRedirect', () => {
  test('reads authorization code from the query string', () => {
    const result = parseOAuthRedirect(
      'https://ext.chromiumapp.org/?code=4/0Axxx&scope=https://www.googleapis.com/auth/spreadsheets'
    );
    expect(result.ok).toBe(true);
    expect(result.code).toBe('4/0Axxx');
  });

  test('maps access_denied to a cancelled sign-in', () => {
    const result = parseOAuthRedirect(
      'https://ext.chromiumapp.org/?error=access_denied'
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cancelled/i);
    expect(result.error).toMatch(/common problems/i);
  });

  test('maps org_internal to an Audience fix hint', () => {
    const result = parseOAuthRedirect(
      'https://ext.chromiumapp.org/?error=org_internal'
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/external/i);
  });

  test('treats missing redirect as cancelled', () => {
    expect(parseOAuthRedirect(undefined).ok).toBe(false);
  });
});

describe('tokenFromResponse', () => {
  test('maps Google token JSON', () => {
    const token = tokenFromResponse({
      access_token: 'ya29.a',
      refresh_token: '1//r',
      expires_in: 3600,
    });
    expect(token.accessToken).toBe('ya29.a');
    expect(token.refreshToken).toBe('1//r');
    expect(token.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('isAccessTokenFresh', () => {
  test('rejects expired or missing tokens', () => {
    expect(isAccessTokenFresh(null)).toBe(false);
    expect(isAccessTokenFresh({ accessToken: 'x', expiresAt: Date.now() - 1000 })).toBe(
      false
    );
    expect(
      isAccessTokenFresh({ accessToken: 'x', expiresAt: Date.now() + 120_000 })
    ).toBe(true);
  });
});

describe('token HTTP helpers', () => {
  test('exchangeCodeForToken posts PKCE fields', async () => {
    const fetchImpl = async (url, options) => {
      expect(url).toContain('oauth2.googleapis.com/token');
      const body = new URLSearchParams(options.body);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code_verifier')).toBe('verifier');
      expect(body.get('redirect_uri')).toBe(
        'https://foebhcdboejpmibcjecefijgmkhkcoll.chromiumapp.org/'
      );
      expect(body.get('client_secret')).toBe('s3cret');
      return {
        ok: true,
        json: async () => ({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600 }),
      };
    };

    const token = await exchangeCodeForToken(
      {
        clientId: '123-abc.apps.googleusercontent.com',
        clientSecret: 's3cret',
        code: '4/abc',
        redirectUri: 'https://foebhcdboejpmibcjecefijgmkhkcoll.chromiumapp.org',
        codeVerifier: 'verifier',
      },
      fetchImpl
    );
    expect(token.accessToken).toBe('tok');
    expect(token.refreshToken).toBe('ref');
  });

  test('refreshAccessToken keeps the previous refresh token', async () => {
    const fetchImpl = async (_url, options) => {
      const body = new URLSearchParams(options.body);
      expect(body.get('grant_type')).toBe('refresh_token');
      return {
        ok: true,
        json: async () => ({ access_token: 'new', expires_in: 3600 }),
      };
    };
    const token = await refreshAccessToken(
      {
        clientId: '123-abc.apps.googleusercontent.com',
        refreshToken: '1//old',
      },
      fetchImpl
    );
    expect(token.accessToken).toBe('new');
    expect(token.refreshToken).toBe('1//old');
  });
});
