# Job Tracker

Job Tracker is a Chrome extension that saves job applications into your own Google Sheet.
Open a job posting, check the autofilled fields in the side panel, and click **Save**.
It has no server and only touches sheets it created or that you pick in Google Drive (the narrow `drive.file` permission).

## Contents

- [Install (from source)](#install-from-source)
- [First-time setup](#first-time-setup)
- [Features and tips](#features-and-tips)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Developing](#developing)
- [Publish (Chrome Web Store)](#publish-chrome-web-store)
- [Permissions](#permissions-from-manifestjson)
- [Next steps (what only you can do)](#next-steps-what-only-you-can-do)
- [Smoke test checklist](#smoke-test-checklist)

## Install (from source)

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and choose this folder
4. Pin **Job Tracker** on the toolbar

The checked-in `manifest.json` contains a `"key"`, so the unpacked extension always gets the same ID (and therefore the same OAuth redirect URI).

## First-time setup

Google sign-in needs an OAuth client. Store builds ship with one built in; a build from this repo does not (see [Developing](#developing)), so you create your own once.

1. Click the Job Tracker toolbar icon, then **Sign in with Google**. If the build has no built-in OAuth client, the panel shows **Set up Google** instead of the sign-in button; it opens `connect/connect.html`.
2. In **Set up Google**, open **Advanced** and follow the steps in order: enable the Google Drive and Google Sheets APIs, set Audience to **External** (and add your email as a test user), create a **Web application** OAuth client with the shown redirect URI, then paste the Client ID and secret and click **Save connection**.
3. Click **Sign in with Google**.
4. Open **Settings** (gear in the side panel) and click **Create tracker sheet** to make a new spreadsheet with the default columns (Date Applied, Job ID, Company Name, Role, Location, Application Status, Notes). Or click **Choose from Google Drive** to pick existing sheets in Google's file picker (published builds only; see below). You can also paste a sheet link under **Or paste a sheet link**; if Job Tracker has no access yet it offers **Grant access to this sheet**.
5. Open a job posting, click the Job Tracker icon (or the floating button), review the fields, and click **Save**.

If you have already saved that job you will see **Already in tracker** and can update the existing row instead of adding a duplicate.

The **Set up Google** page also has a **Common problems and fixes** section.

## Features and tips

- **Settings** is for extra sheets, column mapping (rename, reorder, add, hide or delete, field types, dropdown choices with defaults), undo/redo of column edits, and Google sign-out.
- **Disconnect** (Settings) removes a sheet from Job Tracker only; the Google Sheet itself is untouched.
- Add more sheets any time with **Create tracker sheet**, **Choose from Google Drive**, or a pasted link. No extra sign-in. Job Tracker only sees sheets it created or you picked.
- A sheet marked **Needs access** (for example one added before the `drive.file` change) stays in your list; click **Grant access** to choose it again in the Google picker. People upgrading from the old scope are asked to sign in again once.
- **Removing a column** asks you to choose: **Hide from the form** (column and data stay in the sheet) or **Delete column and its data** (removes the real column from Google Sheets; other columns stay lined up). Moving a column moves its data too. Renaming and adding only change the header. Undo/Redo (Ctrl/⌘Z, Ctrl/⌘⇧Z; ignored while typing in a field or while a dialog is open) is in Settings; undoing a delete brings back an empty column, not the old data. Confirmations use in-page dialogs, not browser pop-ups.
- **Opening the side panel never waits on your sheets.** The form shows straight away; "Checking your sheets…" runs in the background, searching the selected and default sheet first. If the job is already saved you get **Already in tracker** and can update that row (or, if you already started typing, a banner offers **View entry**).
- **Row-change protection.** Update and Delete compare a fingerprint of the row with what the side panel loaded. If someone edited or moved that row in Google Sheets meanwhile, Job Tracker refuses and asks you to reopen it rather than overwrite the wrong data. After a write the new fingerprint is read back on a best-effort basis; if that read fails the panel has no fingerprint for that row and the next Update skips the check instead of failing.
- **Dates.** Posted dates handle ISO, "Aug 15, 2025", and unambiguous d/m/y. Relative dates ("3 days ago", "yesterday") and year-less dates ("Jan 5") are resolved against today. Anything ambiguous (for example 03/04/2025) or containing several different dates is left blank instead of guessed.
- **Role vs company.** For titles like "A | B" or "A - B", keyword scoring (role nouns such as Engineer or Manager, company suffixes such as Inc or Labs, the page host) decides which side is the role and which the company.
- **Big sheets.** Rows are read in 500-row chunks (columns A:ZZ) until the data ends (a short chunk, an empty chunk, or 100 blank rows in a row).
- The floating **Job Tracker** button appears only on a **single job posting** (not careers indexes, search results, or inboxes). The toolbar icon opens the side panel on any tab. Turn the button off with **Show Job Tracker button on job pages** in Settings.
- **Default sheet** (Settings) picks which spreadsheet tab is pre-selected in the side panel when saving a job. It is disabled with one sheet; removing the default sheet (or a missing tab) falls back to the first one. The destination picker in the side panel appears only with more than one tab connected.
- **Link Role / Title to the job posting URL** (Settings) saves the title as a clickable link; there is no separate URL column in the default layout.
- **Accessibility.** Text aligns to the start edge (RTL-safe), the saving spinner pulses instead of spinning under reduced-motion, and touch devices get 32px tap targets.
- **Light and dark.** All extension pages follow your system theme. The floating button is always light so it reads on any page.
- Dedicated extractors cover Greenhouse, Workday, Lever, Ashby, SmartRecruiters, LinkedIn, and Indeed. Other sites use schema.org `JobPosting` data and DOM heuristics.
- Sign-out removes the stored Google token from this browser only. It does not revoke access at Google (do that in your Google Account's third-party access page) and keeps your connected sheets listed.

## Troubleshooting

| What you see | What to do |
|--------------|------------|
| Access blocked / organisation | Audience is Internal. Change it to External and add your email as a test user. |
| Google 400 / redirect / malformed | Paste the redirect URI from **Set up Google** under **Authorized redirect URIs** exactly (including the trailing slash, and not under JavaScript origins). Use **Web application**. |
| App not verified warning | Normal in Testing. Use Advanced → continue. |
| Access denied for your account | Add that exact email under Audience test users. |
| Client secret / invalid client | Re-copy Client ID and secret from the same OAuth client into **Set up Google → Advanced** and click **Save connection**. |
| Can’t edit spreadsheet / 403 / “file not found” | With `drive.file`, Job Tracker only sees sheets it created or you picked. Choose the sheet again with **Choose from Google Drive** (or **Grant access**), signed in as the account that can edit it. |
| **Choose from Google Drive** is missing | Custom OAuth client builds (Set up Google → Advanced) only get **Create tracker sheet**; the Picker works only with the published client. |
| Picker says it can't reach Job Tracker | Use Chrome/Chromium with Job Tracker installed and enabled, then click **Try again**. Other browsers can't deliver the result to the extension. |
| Picker says it is not configured | Fill in `picker/config.js` (see `store/PUBLISHER_OAUTH.md`). |
| A sheet shows **Needs access** (or "(needs access)" in the destination menu) | Click **Grant access** and pick that sheet in Google's picker. Until then it is skipped for the default destination and saving to it is refused with a Grant access message. Pick another destination meanwhile. |
| "This row changed in Google Sheets" (`ROW_CHANGED`) | The row was edited or moved after the panel loaded it. Reopen Job Tracker on the page to reload it. |
| Autofill missing | Fill the field in the side panel. Some sites don’t expose job data. |
| Floating button missing | Open a single posting URL (not a jobs search or careers home), or use the toolbar icon. Enable “Show Job Tracker button on job pages” in Settings. |

## How it works

```text
job page ──► content/content.js ──┐            ┌─► lib/sheets-api.js ─► Google Sheets
             (detect, launcher)   │            │
sidepanel/ ───────────────────────┼─ messages ─► background/service-worker.js (router)
options/   ───────────────────────┤            ├─► google-session.js    (OAuth, tokens)
connect/   ───────────────────────┘            ├─► sheets-orchestrator.js (create/add/save/find/delete/schema)
                                               ├─► picker-messages.js   (OPEN_PICKER, SHEETS_PICKED)
hosted picker/ ─ SHEETS_PICKED (external) ───► ├─► page-job-data.js     (extract + preload)
                                               └─► side-panel.js        (chrome.sidePanel)
```

- UI pages and the content script never call Google directly; they send `chrome.runtime` messages to the service worker, which delegates to one module per duty.
- Sign-in uses the OAuth authorization-code flow with PKCE via `chrome.identity.launchWebAuthFlow` (the PKCE verifier stays in memory only and is never stored; scope: `https://www.googleapis.com/auth/drive.file`, non-sensitive and per-file). The redirect URI is `https://<extension-id>.chromiumapp.org/`. A stored token that was granted the old broad scope is dropped and `GET_AUTH_STATUS` returns `scopeOutdated: true`, so the UI asks the user to sign in again.
- **Create tracker sheet** (`CREATE_SHEET`) creates a spreadsheet via the Sheets API; `drive.file` grants access to files the app creates automatically.
- **Choose from Google Drive** (`OPEN_PICKER`, optionally with a `spreadsheetId` for **Grant access**) opens the hosted page `https://jobtracker.jayshah.xyz/picker/?ext=<id>` in a new tab (Google's Picker can't load inside MV3 extension pages). The page gets a `drive.file` token via Google Identity Services, shows the Picker, then calls `chrome.runtime.sendMessage(<extension id>, {type: 'SHEETS_PICKED', files})`. The service worker accepts that external message only from that origin and `/picker/` path, validates ids (at most 20 sheets), and connects the sheets. `GET_AUTH_STATUS` reports `pickerAvailable`, which is false with a custom OAuth client (a different Cloud project cannot grant the picked files to the extension's client).
- Update and Delete send an `expectedFingerprint` of the row; the service worker re-reads the row and answers `code: 'ROW_CHANGED'` if it differs. Saves and updates return the new `rowFingerprint` (null if the best-effort read-back failed, in which case the next update skips the check).
- Saves are queued per spreadsheet + tab (no double saves); schema edits, undo and redo share one queue.
- Values from pages or inputs that start with `=`, `+`, `-` or `@` are written as text with a leading apostrophe (formula-injection protection); only the Role `HYPERLINK` is a formula. The apostrophe is stripped when rows are read back and when matching duplicates.
- Errors are handled by HTTP status (only a real 401 prompts sign-in); `FIND_APPLICATION` rethrows 401 so the token refreshes.
- `REFRESH_SHEETS` and the schema handlers (apply, undo, redo via `commitTabSchema`) merge into the latest stored sheets, so a sheet re-granted or edited mid-refresh is kept (each reconnect stamps a strictly increasing `addedAt`).
- The content script sends messages through a guarded `sendToBackground`, so a reloaded or updated extension never throws "extension context invalidated" on an open page.
- Tokens, OAuth client settings, connected-sheet config, preferences, and undo history live in `chrome.storage.local`. Short-lived page-extraction caches and side-panel drafts live in `chrome.storage.session`.
- Styling: `lib/tokens.css` holds the design tokens (colour, type, radius, spacing, shadow, light and dark via `prefers-color-scheme`); `lib/ui.css` holds shared buttons, fields and banners; `lib/dialog.css` the dialogs. The side panel, Settings, connect page, hosted picker, `index.html` and `privacy.html` load them. The floating launcher runs inside host pages and cannot load them, so `content/floating-panel.css` hard-codes the light values (keep in sync by hand).
- Diagrams of each flow: [`diagrams/architecture.md`](diagrams/architecture.md).

### Project structure

| Path | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest (permissions, content script, side panel, options page, `externally_connectable`, narrowed `web_accessible_resources`) |
| `background/` | Service worker entry (`service-worker.js`) and one module per duty: `google-session.js`, `sheets-orchestrator.js`, `picker-messages.js`, `page-job-data.js`, `side-panel.js` |
| `content/` | Job-page detection, floating launcher, page-scrape replies |
| `sidepanel/` | Side panel save form; `sheet-access.js` is the shared add-sheet / Grant access controller (also used by Settings) |
| `options/` | Settings page (sheets, columns, preferences) |
| `connect/` | “Set up Google” page: OAuth client setup and troubleshooting |
| `picker/` | Hosted Google Picker page (GitHub Pages, not shipped in the ZIP): `index.html`, `picker.js`, `helpers.js`, `config.js` |
| `lib/` | Pure domain code: extractors (`lib/extractors/*`), Sheets API, auth helpers, storage, field mapping, duplicates, schema editing, role/company scoring |
| `lib/tokens.css`, `lib/ui.css`, `lib/dialog.css`, `lib/dialog.js` | Design tokens (light and dark), shared buttons/fields/banners, accessible in-page dialogs |
| `tests/` | Jest unit tests. Key suites: `google-auth`, `google-session`, `drive-file-migration` (scope), `add-flows`, `sheet-access`, `picker`, `picker-helpers`, `schema-delete-flow`, `find-application`, `manifest-resources`, `brand-colors` |
| `scripts/pack-extension.mjs` | Builds the Chrome Web Store ZIP |
| `store/` | Store listing copy and publisher guide (not shipped in the ZIP) |
| `index.html`, `privacy.html` | Public home and privacy pages (GitHub Pages); `privacy.html` renders the policy from `store/LISTING_COPY.md` |
| `CHANGELOG.md` | What changed in this release |
| `diagrams/architecture.md` | Mermaid diagrams of every flow |
| `.cursor/` | Contributor rules and skills (commit format, architecture ownership) |

## Developing

Requirements: Node.js and npm (only for tests and packing; the extension itself has no build step).

```bash
npm install
npm test          # Jest: runs unit tests in tests/
npm run test:watch
```

After editing code, click the reload icon on the extension at `chrome://extensions`. Reload any open job pages too, so the content script updates.

The Picker needs the published OAuth client's Cloud project, so source builds with a custom client only use **Create tracker sheet**. A source checkout leaves `DEFAULT_OAUTH_CLIENT_ID` / `DEFAULT_OAUTH_CLIENT_SECRET` in `lib/oauth-config.js` empty, so you use **Set up Google → Advanced** with your own OAuth client. Where to put things (which file owns which duty) is described in `.cursor/skills/separation-of-duty/SKILL.md`.

## Publish (Chrome Web Store)

Publisher setup (OAuth app, Picker, redirect URI, packing secrets):
[`store/PUBLISHER_OAUTH.md`](store/PUBLISHER_OAUTH.md).

```bash
cp .env.oauth.example .env.oauth   # add Client ID + secret (gitignored)
npm test
npm run pack
```

Upload `dist/job-tracker-<version>.zip` in the
[Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).
`<version>` comes from `manifest.json`; `package.json` must carry the same version or `npm run pack` stops. See [`store/README.md`](store/README.md) for listing assets and privacy notes.

Load unpacked still uses this repo folder (with the local `"key"` in
`manifest.json`). The pack script strips that key for the store ZIP only, and injects the OAuth client into the staged copy of `lib/oauth-config.js` (never into your working tree).

## Permissions (from `manifest.json`)

| Permission | Why |
|------------|-----|
| `storage` | Tokens, OAuth client, connected-sheet config, preferences, undo history (local); page caches and drafts (session) |
| `identity` | Google sign-in via `chrome.identity.launchWebAuthFlow` (`drive.file` scope) |
| `scripting` | Run the packaged `lib/job-extractor.js` in the frames of the job page |
| `sidePanel` | The main UI, opened from the toolbar icon or floating button |
| Host `https://sheets.googleapis.com/*`, `https://accounts.google.com/*`, `https://oauth2.googleapis.com/*` | Sheets API calls and OAuth sign-in / token exchange |
| Host `<all_urls>` (and the content script on all pages) | Detect a job posting on any site, show the launcher, extract fields, read the tab URL |
| `externally_connectable`: `https://jobtracker.jayshah.xyz/*` | Lets the hosted Picker page send `SHEETS_PICKED`; the service worker also checks the sender origin and `/picker/` path |

There is no `tabs` or `activeTab` permission. On `chrome://` pages and the Web Store the tab URL is not visible, so the side panel opens there but shows no job data. `web_accessible_resources` lists only the specific `lib/` files and icons the content script imports (not `lib/*.js`).

Duplicate matching: URL first, then job id, then company + role. An id-only match is ignored when both rows name a company and the companies are clearly different (`companiesClearlyDiffer` in `lib/duplicates.js`), because ids collide across employers.

## Next steps (what only you can do)

Code is done. These steps need a browser, a Google account, GitHub and the Chrome Web Store, and nothing here has run against live Google yet. Extra background: [`store/PUBLISHER_OAUTH.md`](store/PUBLISHER_OAUTH.md).

Plan: do steps 1 to 4 once in a throwaway **test** Cloud project, then repeat steps 1, 3 and 4 with your **production** project, and do step 2 and step 5 for production only. "Hosted page" below means `https://jobtracker.jayshah.xyz/picker/`; it is served from `main` by GitHub Pages and always reads `picker/config.js`, so whichever project's values are on `main` are the ones under test.

### 0. Prerequisites (once per project)

1. Open [console.cloud.google.com](https://console.cloud.google.com), project picker (top bar) → **New project**. Note the **Project ID**.
2. **Google Auth Platform → Branding**: fill app name (`Job Tracker`), support email, developer email, Save. **Audience**: User type **External**, publishing status **Testing**, **Test users → Add users** → your own Google email, Save.
3. Find your unpacked extension ID: do **Install (from source)**, then copy the ID shown on the extension card at `chrome://extensions` (32 letters).
4. **Google Auth Platform → Clients → Create client**: type **Web application**, name `Job Tracker Extension`, leave JavaScript origins empty, **Authorized redirect URIs → Add URI** `https://<unpacked-id>.chromiumapp.org/` (keep the trailing slash). Create, then copy the **Client ID** and **Client secret**.

If any menu name differs from your console, `store/PUBLISHER_OAUTH.md` sections 1 to 4 describe the same setup.

### 1. Google Cloud Console (same project as step 0)

1. **APIs & Services → Library**: search and **Enable** `Google Sheets API` and `Google Picker API`. Also enable `Google Drive API` if a later screen says an API is not enabled.
2. **Google Auth Platform → Clients → Create client**: type **Web application**, name `Job Tracker Picker`, **Authorized JavaScript origins → Add URI** `https://jobtracker.jayshah.xyz`. Leave redirect URIs empty. Create and copy the **Client ID** (this is a different client from step 0.4).
3. **APIs & Services → Credentials → Create credentials → API key**. Open the new key: **Application restrictions → Websites → Add** `https://jobtracker.jayshah.xyz/*`; **API restrictions → Restrict key** → tick **Google Picker API** only; **Save**. Copy the key.
4. **Project number**: **Cloud overview → Dashboard → Project info** (digits only, not the Project ID).
5. Open `picker/config.js` and set `CLIENT_ID` (step 2), `API_KEY` (step 3), `PROJECT_NUMBER` (step 4). They are public identifiers.
6. **Google Auth Platform → Data Access → Add or remove scopes**: tick `https://www.googleapis.com/auth/drive.file`; make sure `https://www.googleapis.com/auth/spreadsheets` is **not** listed; **Update**, **Save**. Expected: only a non-sensitive scope is listed.
7. **Clients → your extension client (step 0.4) → Authorized redirect URIs**: keep `https://<unpacked-id>.chromiumapp.org/`; later (step 5) add `https://<store-id>.chromiumapp.org/`.

### 2. Reply to Google's verification email (production only)

Skip this if Google has not emailed you. Reply on the same thread with one line: `Confirming narrower scopes`. `drive.file` is non-sensitive so a demo video should not be needed; `store/DEMO_VIDEO.md` has a short script if they ask anyway.

### 3. Publish the hosted site

1. Commit `picker/config.js` on a branch, open a PR, merge to `main`. Wait for the GitHub Pages deployment (repo **Actions** tab, or **Settings → Pages**) to finish.
2. Open `https://jobtracker.jayshah.xyz/picker/`. Expected: the page loads and says the link is incomplete (no `?ext=`). If it says "not configured", `config.js` still has placeholders; if you get a 404, Pages has not deployed or the custom domain is not set (**Settings → Pages**).
3. Open `https://jobtracker.jayshah.xyz/privacy.html`. Expected: the privacy policy text renders.

### 4. End-to-end test (Chrome, extension loaded unpacked)

1. In `lib/oauth-config.js` temporarily set `DEFAULT_OAUTH_CLIENT_ID` and `DEFAULT_OAUTH_CLIENT_SECRET` to the step 0.4 values (never commit them). At `chrome://extensions` click the reload icon on Job Tracker. If you ever pasted a client under **Set up Google → Advanced**, clear it, because a custom client hides **Choose from Google Drive**.
2. Click the toolbar icon, **Sign in with Google**, pick your test user. Expected: consent asks only for "files you use with this app". If you see "Access blocked", add your email under Audience test users.
3. Gear icon (Settings) → **Create tracker sheet**. Expected: an "Added ..." message and a new spreadsheet in Google Drive with 7 columns.
4. Settings → **Choose from Google Drive**. Expected: a new tab on `jobtracker.jayshah.xyz/picker/`; choose a sheet; the tab says "Added ... You can close this tab"; the sheet is listed in Settings. If the tab says it can't reach Job Tracker, use Chrome with the extension enabled and click **Try again**.
5. Paste the link of a sheet you did not pick into **Or paste a sheet link**. Expected: **Grant access to this sheet** appears; click it, pick the sheet, it connects.
6. Open a real job posting, click the toolbar icon, **Save**. Expected: a row in the sheet; reopening the panel shows **Already in tracker**.
7. Edit that row in Google Sheets, then click **Update** in the side panel that was already open. Expected: "This row changed in Google Sheets..." and no overwrite.
8. Settings → remove a column. **Hide from the form** keeps the data; **Delete column and its data** removes the real column.
9. Only if you have a pre-`drive.file` install: expect one sign-in-again prompt and **Needs access** on old sheets.
10. Run the [Smoke test checklist](#smoke-test-checklist), then revert `lib/oauth-config.js` (`git diff lib/oauth-config.js` must show no credentials).

If anything fails, fix it before step 5. To go to production, repeat steps 0 (production project), 1 and 3 with production values, and do step 2.

### 5. Build and upload

1. Bump `version` in `manifest.json` **and** `package.json` (must match; `npm run pack` stops otherwise).
2. `cp .env.oauth.example .env.oauth`, fill `JT_OAUTH_CLIENT_ID` and `JT_OAUTH_CLIENT_SECRET` with the production extension client, then run `npm test` and `npm run pack`. Expected: `dist/job-tracker-<version>.zip`.
3. [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole) → **Add new item** (or your item → **Package → Upload new package**), upload the ZIP, fill the listing from `store/LISTING_COPY.md` and the privacy answers, submit for review.
4. Once the item exists, copy its **store ID** (item URL or dashboard) and add `https://<store-id>.chromiumapp.org/` under the production extension client's **Authorized redirect URIs** (step 1.7). Without it, store-installed sign-in fails with a redirect error.
5. After approval, install from the store and run the smoke test below.

## Smoke test checklist

Run after **Load unpacked** (with a client configured) and again on the store-installed build. Tick each line.

1. Toolbar icon opens the side panel on a job posting; fields are autofilled.
2. Sign in with Google works; consent shows only "files you use with this app".
3. Settings → **Create tracker sheet** adds a sheet with 7 columns (store build: **Choose from Google Drive** also appears).
4. **Choose from Google Drive** (store build) returns to Settings with the sheet listed.
5. **Save** adds a row; reopening the panel shows **Already in tracker**.
6. Edit the row in Google Sheets, **Update** from the stale panel: "This row changed" and no overwrite.
7. A sheet marked **Needs access** shows "(needs access)" in the destination menu and **Grant access** reconnects it.
8. Remove a column: **Hide** keeps data, **Delete** removes it; Ctrl/Cmd+Z undoes in Settings.
9. The floating button shows on a single posting and not on a search results page.
10. Dark mode (system theme) looks right in the side panel and Settings; Sign out then sign in again works.

### What was verified vs needs a real browser

- **Verified**: Jest suite (auth and scope migration, picker helpers and messages, sheet-access, add flows, schema delete, duplicates, dates, role/company scoring, manifest resources) and a code read of every flow above.
- **Needs a real-browser check**: step 4 and the smoke test, the Picker round trip, dark mode, and the launcher on real job sites.

### Known limits

- Custom OAuth clients can only **Create tracker sheet**; the Picker needs the published client's project.
- Deleting a column that formulas elsewhere refer to breaks those formulas.
- If creating a tracker sheet fails after Google creates the file, it stays in Drive unconnected and a retry makes a second one.
