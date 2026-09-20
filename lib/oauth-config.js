/**
 * OAuth defaults for store / published builds.
 *
 * Leave these empty in git. For a Chrome Web Store package, either:
 * 1) Set them temporarily before `npm run pack`, or
 * 2) Prefer env injection (recommended): see store/PUBLISHER_OAUTH.md
 *    JT_OAUTH_CLIENT_ID / JT_OAUTH_CLIENT_SECRET
 *
 * End users with a published build only click Sign in with Google — they do
 * not create a Cloud project. Advanced users can still paste their own client
 * in Set up Google (stored credentials override these defaults).
 */

export const DEFAULT_OAUTH_CLIENT_ID = '';

/** Required for the current Web-application + authorization-code flow. */
export const DEFAULT_OAUTH_CLIENT_SECRET = '';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export function hasPublishedOAuthDefaults() {
  const id = String(DEFAULT_OAUTH_CLIENT_ID || '').trim();
  const secret = String(DEFAULT_OAUTH_CLIENT_SECRET || '').trim();
  return Boolean(id && secret && /\.apps\.googleusercontent\.com$/i.test(id));
}
