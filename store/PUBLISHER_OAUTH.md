# Publisher guide: published OAuth + Chrome Web Store

This is the checklist for **you** (the Job Tracker publisher), not for end users.

Goal: store users only click **Sign in with Google** and paste a spreadsheet.
They should not create a Google Cloud project.

---

## What you’re setting up

| Piece | Purpose |
|-------|---------|
| Google Cloud project | Owns Sheets API + OAuth client for Job Tracker |
| OAuth consent screen | Branding Google shows on “Sign in with Google” |
| OAuth client (Web application) | Client ID + secret the extension uses |
| Redirect URI | Must match `chrome.identity.getRedirectURL()` for the **store** extension ID |
| Privacy policy URL | Required for store + OAuth verification |
| Chrome Web Store listing | ZIP upload, screenshots, privacy practices |
| OAuth verification | Removes “unverified app” warnings for the public |

End users still sign in with **their** Google account. Writes still go to **their** sheets.

---

## 1. Create the Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/) with the Google account that will own the product.
2. Create a project (e.g. `Job Tracker Extension`).
3. Enable **Google Sheets API**:  
   [Enable Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)

---

## 2. Configure the OAuth consent screen

1. Open [Google Auth Platform → Audience / OAuth consent](https://console.cloud.google.com/auth/audience).
2. User type: **External**.
3. App name: `Job Tracker` (or your store listing name).
4. Support / developer email: your contact email.
5. App logo (optional): use `icons/icon128.png` / `store/logo.png`.
6. Scopes: add  
   `https://www.googleapis.com/auth/spreadsheets`  
   (Sensitive — verification will be required for broad production use.)
7. While status is **Testing**, add your own Google account(s) as test users so you can sign in before verification.
8. Save.

Later you will click **Publish app** (In production) after verification. Until then only test users can sign in.

---

## 3. Create the OAuth client

1. [Credentials](https://console.cloud.google.com/apis/credentials) → **Create credentials** → **OAuth client ID**.
2. Application type: **Web application** (matches this extension’s `launchWebAuthFlow` + auth code + PKCE flow).
3. Name: e.g. `Job Tracker Chrome`.
4. **Authorized JavaScript origins:** leave empty (not used by this flow).
5. **Authorized redirect URIs:** add the extension redirect URI (see next section).
6. Create → copy **Client ID** and **Client secret**.

Treat the client secret as sensitive in git, even though anything shipped inside a Chrome extension can be extracted. Prefer injecting at pack time (below), not committing secrets to the repo.

---

## 4. Redirect URI (local vs store)

The extension uses:

```text
https://<EXTENSION_ID>.chromiumapp.org/
```

(trailing slash required)

### While developing (Load unpacked)

1. Open `chrome://extensions` → Job Tracker → copy the **ID**.
2. Or open **Set up Google** in the extension and click **Copy** under the redirect URI.
3. Paste that exact URI into the OAuth client’s Authorized redirect URIs.

Your unpacked ID stays stable if `manifest.json` keeps the `"key"` field (local only; stripped from the store ZIP).

### For the Chrome Web Store listing

1. Upload a ZIP once (even as draft) so Chrome assigns the **public extension ID**.
2. Dashboard → your item → copy the extension ID.
3. Add this redirect URI to the **same** OAuth client:

```text
https://<STORE_EXTENSION_ID>.chromiumapp.org/
```

4. Keep the unpacked URI too if you still develop locally, or use a second OAuth client for local vs store.

Mismatch here is the #1 cause of Google **400 / redirect_uri_mismatch**.

---

## 5. Put credentials into store builds (do not commit secrets)

Repo defaults in `lib/oauth-config.js` stay **empty** on purpose.

### Recommended: `.env.oauth` + pack

1. Copy the example file:

```bash
cp .env.oauth.example .env.oauth
```

2. Edit `.env.oauth` (gitignored):

```bash
JT_OAUTH_CLIENT_ID=123456789-xxxx.apps.googleusercontent.com
JT_OAUTH_CLIENT_SECRET=GOCSPX-xxxx
```

3. Build the store ZIP:

```bash
npm test
npm run pack
```

The pack script injects those values into `dist/staging` only (not into your git working tree), then zips `dist/job-tracker-<version>.zip`.

You can also pass env vars inline:

```bash
JT_OAUTH_CLIENT_ID='...' JT_OAUTH_CLIENT_SECRET='...' npm run pack
```

### Optional: temporary edit of `oauth-config.js`

For a one-off local test you may set `DEFAULT_OAUTH_CLIENT_ID` / `DEFAULT_OAUTH_CLIENT_SECRET` in `lib/oauth-config.js`. **Do not commit real values.** Prefer `.env.oauth`.

---

## 6. Privacy policy

Host a public page (GitHub Pages, Notion, your site). Draft text: `store/LISTING_COPY.md`.

Add the URL to:
- Chrome Web Store → Privacy practices  
- Google Cloud OAuth consent screen → Application home / privacy policy fields  

---

## 7. Chrome Web Store listing

Follow `store/README.md` and `store/LISTING_COPY.md`.

Minimum:
- [ ] `npm run pack` with OAuth env set  
- [ ] Upload ZIP  
- [ ] Screenshots  
- [ ] Privacy practices justifications  
- [ ] Verified publisher email  
- [ ] Privacy policy URL  
- [ ] Single purpose description  

After the store ID exists, update the OAuth redirect URI (section 4).

---

## 8. OAuth app verification (for public users)

While the consent screen is **Testing**, only listed test users can finish sign-in.

To open it to everyone:

1. OAuth consent screen → prepare for verification (scopes, policy, domains as Google asks).
2. Submit for verification for the Spreadsheets scope.
3. When approved, set publishing status to **In production**.

Until verified, Google may show “unverified app” / limit who can sign in. That is expected.

---

## 9. What end users see after this works

1. Install from the store  
2. Open Job Tracker → **Sign in with Google**  
3. Settings → paste a Google Sheets link **that account can edit**  
4. Save jobs from postings  

**Set up Google** still exists for troubleshooting and for **Advanced: use your own OAuth client** (BYO Cloud project).

---

## 10. Costs reminder

- No per-user OAuth fee  
- Sheets API free within quotas (see earlier notes / Google’s limits docs)  
- Chrome Web Store: one-time $5 developer fee  
- Verification: time/process, not a Google “OAuth tax”

---

## 11. Security notes

- Client secret inside a public extension is recoverable; still don’t put it in git history.  
- Prefer the pack-time inject path.  
- Users’ sheet data stays in their Google account; you are not hosting their spreadsheet contents.  
- Rotate the client secret in Cloud Console if it leaks, then ship a new extension version with the new secret injected at pack time.

---

## Quick command cheat sheet

```bash
# one-time
cp .env.oauth.example .env.oauth
# edit .env.oauth with Client ID + secret

npm test
npm run pack
# upload dist/job-tracker-*.zip
# add https://<STORE_ID>.chromiumapp.org/ to OAuth redirect URIs
# finish store privacy + OAuth verification
```
