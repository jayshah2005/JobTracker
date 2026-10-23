# Job Tracker

A Chrome (Manifest V3) extension that saves job applications to your own Google Sheets. Open a job posting, review the autofilled fields in the side panel, and click **Save**. There is no backend: everything runs in your browser and talks only to Google.

## Install (from source)

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and choose this folder
4. Pin **Job Tracker** on the toolbar

The checked-in `manifest.json` contains a `"key"`, so the unpacked extension always gets the same ID (and therefore the same OAuth redirect URI).

## First-time setup

Google sign-in needs an OAuth client. Store builds ship with one built in; a build from this repo does not (see [Developing](#developing)), so you create your own once.

1. Click the Job Tracker toolbar icon, then **Sign in with Google**. If the build has no built-in OAuth client it opens **Set up Google** (`connect/connect.html`) instead.
2. In **Set up Google**, open **Advanced** and follow the steps in order: enable the Google Sheets API, set Audience to **External** (and add your email as a test user), create a **Web application** OAuth client with the shown redirect URI, then paste the Client ID and secret and click **Save connection**.
3. Click **Sign in with Google**.
4. Open **Settings** (gear in the side panel), paste a Google Sheets link you can edit, and click **Add Sheet**.
5. Open a job posting, click the Job Tracker icon (or the floating button), review the fields, and click **Save**.

If you have already saved that job you will see **Already in tracker** and can update the existing row instead of adding a duplicate.

The **Set up Google** page also has a **Common problems and fixes** section.

## Features and tips

- **Settings** is for extra sheets, column mapping (rename, reorder, add, delete, field types, dropdown choices with defaults), undo/redo of column edits, and Google sign-out.
- Share extra sheets with the same Google account, then paste more links. No extra sign-in.
- The destination picker in the side panel appears only when you have more than one sheet tab connected.
- Removing a column offers **Hide from the form** (column and data stay in the sheet) or **Delete column and its data** (removes the real column from Google Sheets; other columns stay lined up). Moving a column moves its data too. Renaming and adding only change the header. Undo/Redo (Ctrl/⌘Z, Ctrl/⌘⇧Z) is in Settings; undoing a delete brings back an empty column, not the old data.
- The floating **Job Tracker** button appears only on a **single job posting** (not careers indexes, search results, or inboxes). The toolbar icon opens the side panel on any tab. Turn the button off with **Show Job Tracker button on job pages** in Settings.
- **Default sheet** (Settings → General) picks which spreadsheet tab is pre-selected in the side panel when saving a job. It is disabled with one sheet; removing the default sheet (or a missing tab) falls back to the first one.
- **Link Role / Title to the job posting URL** (Settings) saves the title as a clickable link; there is no separate URL column in the default layout.
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
| Can’t edit spreadsheet | Sign in with an account that already has Editor access on that sheet. |
| Autofill missing | Fill the field in the side panel. Some sites don’t expose job data. |
| Floating button missing | Open a single posting URL (not a jobs search or careers home), or use the toolbar icon. Enable “Show Job Tracker button on job pages” in Settings. |

## How it works

```text
job page ──► content/content.js ──┐            ┌─► lib/sheets-api.js ─► Google Sheets
             (detect, launcher)   │            │
sidepanel/ ───────────────────────┼─ messages ─► background/service-worker.js (router)
options/   ───────────────────────┤            ├─► google-session.js   (OAuth, tokens)
connect/   ───────────────────────┘            ├─► sheets-orchestrator.js (add/save/find/schema)
                                               ├─► page-job-data.js    (extract + preload)
                                               └─► side-panel.js       (chrome.sidePanel)
```

- UI pages and the content script never call Google directly; they send `chrome.runtime` messages to the service worker, which delegates to one module per duty.
- Sign-in uses the OAuth authorization-code flow with PKCE via `chrome.identity.launchWebAuthFlow` (scope: `https://www.googleapis.com/auth/spreadsheets`). The redirect URI is `https://<extension-id>.chromiumapp.org/`.
- Tokens, OAuth client settings, connected-sheet config, preferences, and undo history live in `chrome.storage.local`. Short-lived page-extraction caches and side-panel drafts live in `chrome.storage.session`.
- Diagrams of each flow: [`diagrams/architecture.md`](diagrams/architecture.md).

### Project structure

| Path | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest (permissions, content script, side panel, options page) |
| `background/` | Service worker entry and its modules (see above) |
| `content/` | Job-page detection, floating launcher, page-scrape replies |
| `sidepanel/` | Side panel save form |
| `options/` | Settings page (sheets, columns, preferences) |
| `connect/` | “Set up Google” page: OAuth client setup and troubleshooting |
| `lib/` | Pure domain code: extractors (`lib/extractors/*`), Sheets API, auth helpers, storage, field mapping, duplicates, schema editing |
| `tests/` | Jest unit tests for `lib/` and background helpers |
| `scripts/pack-extension.mjs` | Builds the Chrome Web Store ZIP |
| `store/` | Store listing copy and publisher guide (not shipped in the ZIP) |
| `index.html`, `privacy.html` | Public home and privacy pages (GitHub Pages) |
| `.cursor/` | Contributor rules and skills (commit format, architecture ownership) |

## Developing

Requirements: Node.js and npm (only for tests and packing; the extension itself has no build step).

```bash
npm install
npm test          # Jest: runs unit tests in tests/
npm run test:watch
```

After editing code, click the reload icon on the extension at `chrome://extensions`. Reload any open job pages too, so the content script updates.

A source checkout leaves `DEFAULT_OAUTH_CLIENT_ID` / `DEFAULT_OAUTH_CLIENT_SECRET` in `lib/oauth-config.js` empty, so you use **Set up Google → Advanced** with your own OAuth client. Where to put things (which file owns which duty) is described in `.cursor/skills/separation-of-duty/SKILL.md`.

## Publish (Chrome Web Store)

Publisher setup (OAuth app, redirect URI, packing secrets):
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
