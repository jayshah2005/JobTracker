# Job Tracker — how the application works

Detailed Mermaid diagrams of the Chrome MV3 extension architecture.
Render in any Mermaid-aware viewer (GitHub, VS Code preview, etc.).

Kept in sync with the codebase via
[`.cursor/skills/keep-diagrams-updated`](../.cursor/skills/keep-diagrams-updated/SKILL.md).

---

## 1. Big picture — surfaces → service worker → libs → Google

```mermaid
flowchart TB
  subgraph browser [Browser tab]
    Page[Job posting page DOM]
    CS[content/content.js<br/>detect + launcher + preload trigger<br/>guarded sendToBackground]
    WBF[content/workday-banner-fix.js<br/>collapse broken Workday banner]
  end

  subgraph ui [Extension UI]
    SP[sidepanel/sidepanel.js<br/>save form]
    OPT[options/options.js<br/>sheets + schema]
    CON[connect/connect.js<br/>OAuth client setup]
  end

  subgraph sw [Service worker MV3]
    SW[service-worker.js<br/>message router only]
    Side[side-panel.js<br/>chrome.sidePanel]
    Auth[google-session.js<br/>OAuth + withSheetAccess]
    PickerMsg[picker-messages.js<br/>OPEN_PICKER + SHEETS_PICKED]
    PJD[page-job-data.js<br/>extract + session preload]
    Orch[sheets-orchestrator.js<br/>add/save/find/schema]
  end

  subgraph libs [Domain libs]
    Ext[job-extractor.js + extractors/*]
    API[sheets-api.js]
    Store[storage.js]
    Map[field-mapper / sheet-config<br/>duplicates / schema-editor]
    Css[tokens.css + ui.css + dialog<br/>design system, dark mode]
  end

  subgraph google [Google]
    OAuth[OAuth token endpoint]
    Sheets[Sheets API]
  end

  Page --> CS
  WBF -->|layout fix only| Page
  CS -->|messages| SW
  SP -->|messages| SW
  OPT -->|messages| SW
  CON -->|messages| SW

  SW --> Side
  SW --> Auth
  SW --> PickerMsg
  PickerMsg --> Orch
  SW --> PJD
  SW --> Orch

  Side -->|SIDE_PANEL_STATE| CS
  PJD -->|GET_PAGE_JOB_DATA + executeScript| CS
  PJD --> Ext
  Orch --> API
  Orch --> Map
  Orch --> Auth
  Auth --> Store
  Orch --> Store
  Auth --> OAuth
  API --> Sheets
```

The hosted `picker/` page is outside the extension (diagram 6b). `sidepanel/sheet-access.js` is the shared add-sheet controller used by the side panel and Settings. Pages style themselves with `lib/tokens.css` / `lib/ui.css`; only the floating launcher keeps hard-coded light values.

**Rule of thumb:** UI and content never call Google directly. The service worker routes; modules own one duty each (`side-panel`, `google-session`, `page-job-data`, `sheets-orchestrator`).

---

## 2. What happens when you land on a job page

```mermaid
flowchart LR
  load[Tab loads / SPA navigates] --> top{Top frame?}
  top -->|no| idleFrame[Frame silent except extract replies]
  top -->|yes| url{classifyJobUrl<br/>path + query, never the URL hash}
  url -->|posting| jobPage[Likely job page]
  url -->|careers / none| ats{Host ATS + job id?}
  ats -->|yes| jobPage
  ats -->|no| schema{1–2 JobPosting<br/>JSON-LD / microdata?}
  schema -->|yes| jobPage
  schema -->|no| score[DOM score ≥ 4<br/>+apply control +JD headings<br/>+employment terms +careers URL/host<br/>−app-shell grid −editor −listing]
  score -->|yes| jobPage
  score -->|no| clear[CLEAR_TAB_JOB_PRELOAD]

  jobPage --> debounce[Debounce 400ms]
  debounce --> preload[PRELOAD_TAB_JOB_DATA]
  preload --> extract[getTabJobData bypassCache]
  extract --> frames[Content reply + allFrames executeScript]
  frames --> pick[pickBestExtraction]
  pick --> cache[(session jobPreload:tabId<br/>url + data + cachedAt)]

  jobPage -->|autoShow| launcher[Show floating launcher]
  launcher -->|click| open[OPEN_SIDE_PANEL]
```

- Detection (`isLikelyJobPage` / `jobPageSignals` in `lib/job-extractor.js`) is platform-general: URL shapes, schema.org JobPosting, and structural DOM signals — no site allow/block lists. Loose body keywords (“job”, “apply”) are never enough on their own, so inboxes and other app shells stay negative.
- Full extract is DOM-only (no network) but heavier — preload only runs on likely job pages. Pipelines: Greenhouse, Workday, Lever, Ashby, SmartRecruiters, LinkedIn, Indeed (`lib/extractors/`), plus the general JSON-LD/DOM strategies (one or two `JobPosting` nodes only) that fill whatever an ATS pipeline missed.
- Cache TTL is 5 minutes; tab close / URL change clears it.
- Launcher CSS is injected via `manifest.json` `content_scripts.css` (CSP-safe); AutoShow is Settings → “Show Job Tracker button on job pages”.
- Content script is a **classic** (non-module) bootstrap with dynamic `import()` of libs. A general URL helper (`lib/job-page-url.js` → `classifyJobUrl` / `urlLooksLikeJobPosting`) short-circuits on posting-shaped URLs (job word + id/slug, job-id query params, jobs/careers hosts + id), then full DOM detection refines.

---

## 3. Opening the side panel (preload fast path)

```mermaid
sequenceDiagram
  participant User
  participant CS as Content script
  participant SW as page-job-data
  participant Sess as storage.session
  participant Panel as Side panel
  participant Orch as sheets-orchestrator

  Note over CS,SW: Earlier: page looked like a job
  CS->>SW: PRELOAD_TAB_JOB_DATA
  SW->>CS: GET_PAGE_JOB_DATA + scrape all frames
  SW->>Sess: write jobPreload:tabId

  User->>Panel: Open Job Tracker
  Panel->>SW: GET_TAB_JOB_DATA
  SW->>Sess: read cache if URL matches and fresh
  SW-->>Panel: extracted fields immediately
  Note over SW: Also refreshes cache in background

  Panel->>Panel: Paint save form from cached sheets (no waiting)
  par In the background (loadToken guards stale results)
    Panel->>Orch: REFRESH_SHEETS
  and
    Panel->>Orch: FIND_APPLICATION (selected + default destination first)
  end
  Note over Panel: "Checking your sheets..." indicator
  alt Match and form untouched
    Orch-->>Panel: matched row + rowFingerprint
    Panel->>Panel: Edit mode for that destination
  else Match but user already typed
    Panel->>Panel: Banner "View entry"
  else New application
    Panel->>Panel: Keep save form + destination picker
  end
```

The form never waits on Google: only the match banner / edit mode depends on the search. Preload removes the **page scrape** wait. Rows are read in 500-row chunks.

---

## 4. Auth and Sheets access

```mermaid
flowchart TB
  UI[Side panel / Options / Connect] -->|GET_AUTH_STATUS or SIGN_IN| Auth[google-session.js]

  Auth --> setup{OAuth client configured?<br/>stored client or packed default}
  setup -->|no| Connect[Set up Google page<br/>SAVE_OAUTH_CLIENT]
  setup -->|yes| token{Access token fresh?}

  token -->|yes| run[withSheetAccess fn token]
  token -->|no| refresh[Silent refresh with refresh_token]
  refresh -->|ok| saveTok[save googleToken in local storage]
  saveTok --> run
  refresh -->|no refresh token or revoked| signin[Sign in required<br/>user clicks Sign in]
  signin --> interactive[launchWebAuthFlow<br/>auth code + PKCE, verifier kept in memory only]
  interactive --> saveTok

  run --> API[lib/sheets-api.js fetch]
  API -->|401| once[Drop access token, refresh once, retry]
  API --> Sheets[sheets.googleapis.com]
  interactive -.-> OAuth[accounts.google.com / oauth2.googleapis.com]
  refresh -.-> OAuth
```

- The PKCE verifier lives only in the service worker's memory for the duration of the sign-in; nothing PKCE-related is stored.
- `SIGN_OUT` only clears the stored token. It does not revoke access at Google and keeps the OAuth client settings and connected sheets.
- The redirect URI is `https://<extension-id>.chromiumapp.org/` and must be listed exactly (trailing slash) on the Web-application OAuth client.
- A stored token without `drive.file` (old broad scope) is dropped: `GET_AUTH_STATUS` returns `scopeOutdated: true` and the UI asks the user to sign in again.
- The only scope is `drive.file` (non-sensitive): the token can touch only spreadsheets the app created or the user picked.

---

## 5. Saving / updating / deleting / copying to another sheet

```mermaid
flowchart TB
  save[User clicks Save / Update] --> dest{Editing an<br/>existing match?}

  save --> q[Queue per spreadsheetId:tabId<br/>serializeByKey]
  q --> dest

  dest -->|yes| read[Re-read tab rows FORMULA]
  read --> fp{rowFingerprint equals<br/>expectedFingerprint?}
  fp -->|no| changed[ROW_CHANGED<br/>panel reloads and re-finds the job]
  fp -->|yes| put[updateJobInTab]
  put --> newfp[Best-effort read of the row,<br/>return rowFingerprint or null]

  dest -->|no or new copy| dupe[findExistingApplication<br/>THIS tab only]
  dupe -->|hit| block[alreadyApplied -> enter edit]
  dupe -->|miss| build[buildRowFromMappings<br/>Role may be HYPERLINK]
  build --> esc[neutralizeFormula: leading apostrophe<br/>except own HYPERLINK]
  esc --> write[saveJobToTab append]
  write --> newfp

  del[User confirms Delete] --> dfp[Read row, compare fingerprint]
  dfp -->|differs| changed
  dfp -->|same| rm[deleteJobRowInTab]
```

- Saves are serialized per `spreadsheetId:tabId`, so a double click or two panels cannot both pass the duplicate check. Schema apply/undo/redo share one separate queue. Rows read back have the apostrophe text marker stripped (`stripTextMarker`), including for duplicate matching.
- **Open-panel FIND** searches **all** connected sheets.
- **Append** duplicate check is **per destination**, so the same job can be copied to another sheet/tab.
- A match requires URL, then job id, then company + role; an id-only match is skipped when both companies are present and clearly different (`companiesClearlyDiffer`).
- A null `rowFingerprint` (read-back failed) means the panel sends no `expectedFingerprint` on its next Update, so that one check is skipped rather than failing.
- The header row (row 0) can never be updated or deleted.
- Saving to a destination flagged `needsAccess` is refused in the panel with a Grant access message (no request is sent).

---

## 6. Connecting a Google Sheet

```mermaid
flowchart LR
  create[Create tracker sheet] --> cs[CREATE_SHEET title?]
  paste[Paste sheet link] --> addSheet[ADD_SHEET url]
  addSheet -->|403/404 + picker available| grant[needsPicker: Grant access button<br/>OPEN_PICKER spreadsheetId]
  addSheet -->|ok| meta
  cs --> mk[Sheets API create spreadsheet<br/>default headers]
  mk --> add[connect sheet]

  pick[Choose from Google Drive] --> op[OPEN_PICKER spreadsheetId?]
  op -.-> bridge[Picker bridge, diagram 6b]
  bridge --> ext[SHEETS_PICKED files id,name]
  ext --> add

  add --> meta[fetchSpreadsheetMetadata]
  meta --> tabs[loadSpreadsheetTabs]
  tabs --> prep[prepareTabConfig per tab]

  prep --> seed{Empty or legacy<br/>header-only defaults?}
  seed -->|yes| headers[Write DEFAULT_HEADERS<br/>bold header / plain data rows]
  seed -->|no| map[Map existing headers + tags]

  headers --> local[saveConfiguredSheets]
  map --> local

  refresh[REFRESH_SHEETS / open Settings] --> tabs
  refresh -.->|access denied| na[needsAccess flag, config kept]
  refresh --> mergeLatest[Merge into LATEST stored sheets<br/>keep entries re-granted meanwhile, newer addedAt]
  schemaOps[Schema apply / undo / redo] --> commit[commitTabSchema into latest sheets]
```

`REFRESH_SHEETS` and the schema handlers never save their starting snapshot: they merge into the latest stored sheets (`addedAt` is strictly increasing on reconnect, so a sheet re-granted during a refresh is kept). In the side panel destination menu, `needsAccess` tabs show "(needs access)" and are skipped for the default or first selection.

Default columns: Date Applied, Job ID, Company Name, Role, Location, Application Status, Notes (URL lives in the Role hyperlink).

---

## 6b. Picker bridge (Choose from Google Drive)

Google Picker can't load in an MV3 extension page, so it runs on a hosted page and hands the result back with external messaging.

```mermaid
sequenceDiagram
  participant UI as Options / Side panel
  participant SW as service worker
  participant Tab as jobtracker.jayshah.xyz/picker/?ext=ID&ids=...
  participant G as GIS + Google Picker

  UI->>SW: OPEN_PICKER {spreadsheetId?}
  SW->>Tab: chrome.tabs.create (ext id, known sheet ids)
  Tab->>G: load gsi/client + api.js
  Note over Tab: user clicks Choose from Google Drive
  Tab->>G: initTokenClient scope drive.file
  G-->>Tab: access token
  Tab->>G: Picker (SPREADSHEETS, multiselect, setFileIds)
  G-->>Tab: PICKED docs
  Tab->>SW: chrome.runtime.sendMessage(extId, SHEETS_PICKED files)
  Note over SW: onMessageExternal, origin must be https://jobtracker.jayshah.xyz
  SW->>SW: connect sheets into configuredSheets
  SW-->>Tab: ok
  Tab-->>Tab: "Added X to Job Tracker. You can close this tab."
```

- Picker and extension must belong to the **same Cloud project**, or `drive.file` access is not granted to the extension's client.
- Custom OAuth clients only get **Create tracker sheet** (`pickerAvailable` is false in `GET_AUTH_STATUS`).
- Non-Chromium browsers have no `chrome.runtime`; the page shows a message and a **Try again** button.

---


## 7. Where state lives

```mermaid
flowchart TB
  subgraph local [chrome.storage.local]
    sheets[configuredSheets<br/>spreadsheet + tabs + mappings]
    settings[settings<br/>autoShowPopup, embedRoleHyperlink,<br/>defaultDestination = sheetId:gid]
    token[googleToken<br/>oauthClientId, oauthClientSecret]
    undo[schemaUndoStack / schemaRedoStack]
  end

  subgraph session [chrome.storage.session]
    preload[jobPreload:tabId<br/>pre-extracted job]
    draft[sidepanelDraft:tabId<br/>form fields + destination]
  end

  subgraph memory [Service worker RAM]
    enabled[sidePanelEnabledTabs<br/>side-panel.js]
    inflight[inflightExtracts dedupe<br/>page-job-data.js]
  end

  Orch[sheets-orchestrator] --> sheets
  Orch --> undo
  Auth[google-session] --> token
  Opt[options page] -->|getSettings / saveSettings| settings
  PJD[page-job-data] --> preload
  SP[sidepanel] --> draft
```

---

## 8. Design tokens and theming

```mermaid
flowchart LR
  tokens[lib/tokens.css<br/>--jt-* colour, type, radius, space, shadow<br/>light + prefers-color-scheme dark] --> ui[lib/ui.css<br/>buttons, fields, banners]
  tokens --> pages[sidepanel, options, connect,<br/>picker, index.html, privacy.html]
  ui --> pages
  dialog[lib/dialog.css + dialog.js] --> pages
  launcher[content/floating-panel.css<br/>light values hard-coded] -.->|kept in sync by hand| tokens
```

- Dark mode follows the system (`:root:not([data-theme='light'])`). The launcher runs inside host pages, cannot load the tokens file, and stays light.

---

## Mental model

| Piece | Job |
|--------|-----|
| **Content script** | Detect single postings (`classifyJobUrl` / `isLikelyJobPage`), show launcher, ask for preload, answer scrape requests |
| **job-extractor + extractors/\*** | ATS pipelines (incl. LinkedIn, Indeed) + general JSON-LD/DOM fusion |
| **Side panel** | Human form: review fields, pick sheet, save/update/delete |
| **Picker page** (`picker/`, hosted) | Google Picker + `SHEETS_PICKED` hand-off |
| **picker-messages** | `OPEN_PICKER`, validates and handles external `SHEETS_PICKED` |
| **sheet-access** (`sidepanel/`) | Shared Create / Choose / Grant access controller for panel and Settings |
| **Options** | Create/choose spreadsheets, edit columns/types/dropdown choices, undo/redo, sign in/out, prefs |
| **Connect** (“Set up Google”) | OAuth client setup (Advanced, only when no built-in client) and troubleshooting |
| **Service worker** | Traffic cop — routes messages, doesn’t own business logic |
| **page-job-data** | Scrape tabs + session preload cache |
| **google-session** | Sign-in and fresh tokens for Sheets (`drive.file`) |
| **sheets-orchestrator** | All spreadsheet workflows |
| **lib/\*** | Pure domain rules (extract, map, dupe, schema, HTTP) |

See also `.cursor/skills/separation-of-duty/SKILL.md` for the layer ownership map and canonical message types.
