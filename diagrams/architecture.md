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
    CS[content/content.js<br/>detect + launcher + preload trigger]
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
    PJD[page-job-data.js<br/>extract + session preload]
    Orch[sheets-orchestrator.js<br/>add/save/find/schema]
  end

  subgraph libs [Domain libs]
    Ext[job-extractor.js + extractors/*]
    API[sheets-api.js]
    Store[storage.js]
    Map[field-mapper / sheet-config<br/>duplicates / schema-editor]
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

**Rule of thumb:** UI and content never call Google directly. The service worker routes; modules own one duty each (`side-panel`, `google-session`, `page-job-data`, `sheets-orchestrator`).

---

## 2. What happens when you land on a job page

```mermaid
flowchart LR
  load[Tab loads / SPA navigates] --> top{Top frame?}
  top -->|no| idleFrame[Frame silent except extract replies]
  top -->|yes| url{classifyJobUrl<br/>path + query, never #hash}
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

  Panel->>Orch: REFRESH_SHEETS then FIND_APPLICATION
  alt Already in a sheet
    Orch-->>Panel: matched row
    Panel->>Panel: Edit mode for that destination
  else New application
    Panel->>Panel: Save form + destination picker
  end
```

**Still can wait on:** Google auth + refreshing sheet config + duplicate search. Preload only removes the **page scrape** wait.

---

## 4. Auth and Sheets access

```mermaid
flowchart TB
  UI[Side panel / Options / Connect] -->|GET_AUTH_STATUS or SIGN_IN| Auth[google-session.js]

  Auth --> setup{OAuth client configured?<br/>stored client or packed default}
  setup -->|no| Connect[Set up Google page<br/>SAVE_OAUTH_CLIENT]
  setup -->|yes| token{Access token fresh?}

  token -->|yes| call[withSheetAccess fn token]
  token -->|no| refresh[Silent refresh with refresh_token]
  refresh -->|ok| saveTok[save googleToken in local storage]
  saveTok --> call
  refresh -->|no refresh token or revoked| signin[Sign in required<br/>user clicks Sign in]
  signin --> interactive[launchWebAuthFlow<br/>auth code + PKCE]
  interactive --> saveTok

  call --> API[lib/sheets-api.js fetch]
  API -->|401| once[Drop access token, refresh once, retry]
  API --> Sheets[sheets.googleapis.com]
  interactive -.-> OAuth[accounts.google.com / oauth2.googleapis.com]
  refresh -.-> OAuth
```

- `SIGN_OUT` only clears the stored token. It does not revoke access at Google and keeps the OAuth client settings and connected sheets.
- The redirect URI is `https://<extension-id>.chromiumapp.org/` and must be listed exactly (trailing slash) on the Web-application OAuth client.

---

## 5. Saving / updating / copying to another sheet

```mermaid
flowchart TB
  save[User clicks Save / Update] --> dest{Destination matches<br/>existing match?}

  dest -->|yes editing| update[SAVE_JOB with existingRowIndex]
  update --> put[updateJobInTab]

  dest -->|no or new copy| append[SAVE_JOB append]
  append --> dupe[findExistingApplication<br/>THIS tab only]

  dupe -->|hit| block[alreadyApplied → enter edit]
  dupe -->|miss| build[buildRowFromMappings<br/>Role may be HYPERLINK]
  build --> write[saveJobToTab append]
  write --> unbold[Clear bold on data row]
```

- **Open-panel FIND** searches **all** connected sheets.
- **Append** duplicate check is **per destination**, so the same job can be copied to another sheet/tab.

---

## 6. Connecting a Google Sheet

```mermaid
flowchart LR
  paste[Paste Sheets URL] --> add[ADD_SHEET]
  add --> meta[fetchSpreadsheetMetadata]
  meta --> tabs[loadSpreadsheetTabs]
  tabs --> prep[prepareTabConfig per tab]

  prep --> seed{Empty or legacy<br/>header-only defaults?}
  seed -->|yes| headers[Write DEFAULT_HEADERS<br/>bold header / plain data rows]
  seed -->|no| map[Map existing headers + tags]

  headers --> local[saveConfiguredSheets]
  map --> local

  refresh[REFRESH_SHEETS / open Settings] --> tabs
```

Default columns: Date Applied, Job ID, Company Name, Role, Location, Application Status (URL lives in the Role hyperlink).

---

## 7. Where state lives

```mermaid
flowchart TB
  subgraph local [chrome.storage.local]
    sheets[configuredSheets<br/>spreadsheet + tabs + mappings]
    settings[settings<br/>autoShowPopup, embedRoleHyperlink,<br/>defaultDestination = sheetId:gid]
    token[googleToken, oauthPkce<br/>oauthClientId, oauthClientSecret]
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

## Mental model

| Piece | Job |
|--------|-----|
| **Content script** | Detect single postings (`classifyJobUrl` / `isLikelyJobPage`), show launcher, ask for preload, answer scrape requests |
| **job-extractor + extractors/\*** | ATS pipelines (incl. LinkedIn, Indeed) + general JSON-LD/DOM fusion |
| **Side panel** | Human form: review fields, pick sheet, save/update/delete |
| **Options** | Connect spreadsheets, edit columns/types/dropdown choices, undo/redo, sign in/out, prefs |
| **Connect** (“Set up Google”) | OAuth client setup (Advanced, only when no built-in client) and troubleshooting |
| **Service worker** | Traffic cop — routes messages, doesn’t own business logic |
| **page-job-data** | Scrape tabs + session preload cache |
| **google-session** | Sign-in and fresh tokens for Sheets |
| **sheets-orchestrator** | All spreadsheet workflows |
| **lib/\*** | Pure domain rules (extract, map, dupe, schema, HTTP) |

See also `.cursor/skills/separation-of-duty/SKILL.md` for the layer ownership map and canonical message types.
