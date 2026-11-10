# Publisher guide: published OAuth + Chrome Web Store

This is the checklist for **you** (the Job Tracker publisher), not for end users.

Goal: store users only click **Sign in with Google**, then **Create tracker sheet** or **Choose from Google Drive**.
They should not create a Google Cloud project.

The app uses the non-sensitive scope `https://www.googleapis.com/auth/drive.file` (only sheets the app creates or the user picks via Google Picker). The earlier broad `spreadsheets` scope was rejected by Google verification and is gone.

---

## What you’re setting up

| Piece | Purpose |
|-------|---------|
| Google Cloud project | Owns Sheets API, Picker API, OAuth clients and API key for Job Tracker |
| OAuth consent screen | Branding Google shows on “Sign in with Google” |
| OAuth client (Web application) | Client ID + secret the extension uses |
| Picker web client + API key | Used by the hosted Picker page `picker/` (section 6) |
| Redirect URI | Must match `chrome.identity.getRedirectURL()` for the **store** extension ID |
| Privacy policy URL | Required for store + OAuth verification |
| Chrome Web Store listing | ZIP upload, screenshots, privacy practices |
| Branding verification | `drive.file` is non-sensitive: no sensitive-scope review or demo video; Google may still verify branding/domain |

End users still sign in with **their** Google account. Writes still go to **their** sheets.

## Replying to Google (checklist)

- [ ] Cloud Console → Google Auth Platform → Data Access: **add** `.../auth/drive.file`.
- [ ] **Remove** `.../auth/spreadsheets` there, and confirm the code/manifest only request `drive.file` (`lib/oauth-config.js`).
- [ ] Reply to the verification email: “Confirming narrower scopes” (we now request only the non-sensitive `drive.file`).
- [ ] Test everything first in a **separate test Cloud project** (own OAuth client, Picker setup, `picker/config.js`) before touching production.
- [ ] Make sure the privacy policy (from `LISTING_COPY.md`) and store justifications mention `drive.file`.

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
   `https://www.googleapis.com/auth/drive.file`  
   (Non-sensitive: no sensitive-scope verification or demo video. Do **not** add `spreadsheets`.)
7. While status is **Testing**, add your own Google account(s) as test users so you can sign in before verification.
8. Save.

Click **Publish app** (In production) when ready; non-sensitive scopes don't need scope review. Until then only test users can sign in.

---

## 3. Create the OAuth client

1. [Credentials](https://console.cloud.google.com/apis/credentials) → **Create credentials** → **OAuth client ID**.
2. Application type: **Web application** (matches this extension’s `launchWebAuthFlow` + auth code + PKCE flow).
3. Name: e.g. `Job Tracker Chrome`.
4. **Authorized JavaScript origins:** leave empty (this client is for the extension's auth-code flow; the Picker uses its own Web client, section 6).
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

The pack script injects those values into `dist/staging` only (not into your git working tree), then zips `dist/job-tracker-<version>.zip`. `<version>` comes from `manifest.json`; `package.json` must have the same version. With no credentials set, the pack still succeeds but warns, and the resulting build makes users do the “Set up Google” Advanced steps themselves.

You can also pass env vars inline:

```bash
JT_OAUTH_CLIENT_ID='...' JT_OAUTH_CLIENT_SECRET='...' npm run pack
```

### Optional: temporary edit of `oauth-config.js`

For a one-off local test you may set `DEFAULT_OAUTH_CLIENT_ID` / `DEFAULT_OAUTH_CLIENT_SECRET` in `lib/oauth-config.js`. **Do not commit real values.** Prefer `.env.oauth`.

---

## 6. Google Picker (Choose from Google Drive)

Google's Picker script cannot run in an MV3 extension page, so it runs on a page we host: `https://jobtracker.jayshah.xyz/picker/?ext=<extension id>&ids=<optional spreadsheet ids>` (files in `picker/`, served by GitHub Pages). After the user picks, the page calls `chrome.runtime.sendMessage(<ext id>, {type: 'SHEETS_PICKED', files})` and the service worker accepts it only from origin `https://jobtracker.jayshah.xyz`.

In the **same Cloud project** as the extension's published OAuth client (required: `drive.file` grants are per project; a Picker from another project would not give the extension access):

1. Enable the [Google Picker API](https://console.cloud.google.com/apis/library/picker.googleapis.com) (and the Sheets API from section 1). The extension itself never calls the Drive API (only Sheets); if the Picker still reports an API-not-enabled error, enable the Google Drive API in the same project too.
2. Credentials → **Create credentials → API key**. Restrict it: API restriction = **Google Picker API**; Website restriction = HTTP referrer `https://jobtracker.jayshah.xyz/*`.
3. Credentials → **Create credentials → OAuth client ID → Web application** (separate from the extension client). **Authorized JavaScript origins:** `https://jobtracker.jayshah.xyz`. No redirect URI needed.
4. Note the **Project number** (Cloud Console → project Settings / Dashboard; digits, not the project ID).
5. Fill `picker/config.js`: `CLIENT_ID` (step 3), `API_KEY` (step 2), `PROJECT_NUMBER` (step 4). These are public identifiers, safe to commit. Push to deploy via GitHub Pages.
6. Test: open the picker URL (or use **Choose from Google Drive** in Settings, which fills in `?ext=` for you; store and unpacked builds have different IDs and the extension always passes its own) with your extension ID (`chrome://extensions`) in Chrome, click **Choose from Google Drive**, pick a sheet, confirm it appears in Job Tracker Settings.

Custom OAuth clients (Set up Google → Advanced) are in a different Cloud project, so those users only get **Create tracker sheet**; the Picker button is hidden for them.

---

## 7. Home page + privacy policy

GitHub Pages in this repo serves:

| OAuth Branding field | URL |
|----------------------|-----|
| Application home page | https://jobtracker.jayshah.xyz/ |
| Application privacy policy | https://jobtracker.jayshah.xyz/privacy.html |

Edit the privacy draft in `store/LISTING_COPY.md` and push — `privacy.html` reads it on load.
Authorized domain: `jayshah.xyz`.

Add the same URLs to:
- Chrome Web Store → Privacy practices (privacy URL)
- Google Auth Platform → **Branding** → App domain (home + privacy)

---

## 8. Chrome Web Store listing

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

## 9. OAuth app verification (for public users)

While the consent screen is **Testing**, only listed test users can finish sign-in.

To open it to everyone:

`drive.file` is non-sensitive, so there is no sensitive-scope verification and no demo video (see `DEMO_VIDEO.md`). To open sign-in to everyone:

1. Complete Branding (app name, logo, home page, privacy policy, authorized domain `jayshah.xyz`). Google may still run branding/domain verification.
2. Set publishing status to **In production**.

If Google asks for more, answer from this guide; the narrow scope is the whole story.

---

## 10. What end users see after this works

1. Install from the store  
2. Open Job Tracker → **Sign in with Google**  
3. Settings → **Create tracker sheet**, or **Choose from Google Drive** to pick existing sheets  
4. Save jobs from postings  

**Set up Google** still exists for troubleshooting and for **Advanced: use your own OAuth client** (BYO Cloud project).

---

## 11. Costs reminder

- No per-user OAuth fee  
- Sheets API and Picker API are free within Google’s usage quotas (see Google’s Sheets API limits docs)  
- Chrome Web Store: one-time $5 developer fee  
- Branding verification: time/process, not a Google “OAuth tax”

---

## 12. Security notes

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
# fill picker/config.js (section 6), push to GitHub Pages
# finish store privacy + branding
```
