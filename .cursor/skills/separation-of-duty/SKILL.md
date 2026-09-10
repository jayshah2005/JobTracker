---
name: separation-of-duty
description: >-
  Enforces Job Tracker architecture: place code in the correct layer, reuse
  existing modules, and keep auth/Sheets/UI/chrome wiring separated. Use before
  writing or moving any code, when adding features, refactoring, fixing bugs, or
  deciding which file a change belongs in.
---

# Separation of Duty

Before writing or moving code in this repo, complete the checklist below. Do not
skip it for “small” changes.

## Mandatory preflight (every coding task)

1. **Name the duty** in one sentence (e.g. “open the tab-scoped side panel”,
   “exchange OAuth code”, “map job fields to sheet columns”).
2. **Find the home** using the architecture map — put new logic only where that
   duty already lives (or in a new module whose single duty matches).
3. **Search for reuse** — `Grep` / read `lib/`, `background/`, `sidepanel/`,
   `content/`, `options/`, `connect/` for existing helpers, message types, and
   UI patterns. Prefer extending or calling them over duplicating.
4. **Refuse wrong homes** — if the obvious edit file does not own that duty,
   extract or place the code in the correct module and keep the edit file as a
   thin caller/router.
5. **Only then write code.**

If placement is ambiguous, ask the user before inventing a new top-level folder.

## Architecture map

| Layer | Path | Owns | Must not own |
|-------|------|------|--------------|
| SW entry | `background/service-worker.js` | Message routing only | Auth flows, Sheets ops, side panel chrome, extraction |
| Google session | `background/google-session.js` | OAuth / identity / `withSheetAccess` | Sheets row writes; side panel; DOM |
| Sheets orchestration | `background/sheets-orchestrator.js` | Add/save/find/schema via `lib/*` + `withSheetAccess` | `chrome.sidePanel`; page DOM |
| Side panel chrome | `background/side-panel.js` | `chrome.sidePanel`, action click, `SIDE_PANEL_STATE` notify | Auth; Sheets; form UI |
| Page job data | `background/page-job-data.js` | `GET_TAB_JOB_DATA` (frames + extract) | Sheets; side panel chrome |
| Domain libs | `lib/*.js` | Auth helpers, Sheets HTTP, storage, extract, map, schema, duplicates | Extension UI markup; page injection chrome |
| Sidebar UI | `sidepanel/*` | Side panel HTML/CSS/JS, drafts, save form | Direct Sheets HTTP; `setOptions`; `executeScript` extract |
| Page UI | `content/*` | Job-page detection, floating launcher, `GET_PAGE_JOB_DATA` reply | `FIND_APPLICATION`; auth; Sheets writes; `sidePanel` API |
| Settings | `options/*` | Settings UI; use `lib/storage` for prefs | Background chrome wiring; raw Sheets HTTP |
| Connect | `connect/*` | First-time OAuth client setup UI | Side panel; job extraction |
| Tests | `tests/*` | Jest coverage for `lib/` | Duplicating production logic |

**Removed:** `popup/` — do not recreate. Toolbar opens the side panel.

Chrome MV3 allows **one** service worker entry (`manifest.background.service_worker`).
Split duties with **modules imported by that entry**, not a second worker.

## Placement rules

- **Auth / tokens / OAuth** → `lib/google-auth.js` + `lib/storage.js`; session orchestration in `background/google-session.js`.
- **Sheets read/write / headers** → `lib/sheets-api.js`; orchestration in `background/sheets-orchestrator.js`.
- **Job page parsing** → `lib/job-extractor.js`; multi-frame collection via `GET_TAB_JOB_DATA` / `page-job-data.js`.
- **Open/close sidebar** → `background/side-panel.js` only publishes `SIDE_PANEL_STATE`.
- **Settings prefs** → `getSettings` / `saveSettings` in `lib/storage.js` (not raw `chrome.storage.local` keys).
- **User-visible sidebar form** → `sidepanel/`; drafts via session storage OK.
- **Shared constants** → `lib/constants.js`.

## Canonical message types

**Auth / settings:** `GET_AUTH_STATUS`, `SAVE_OAUTH_CLIENT`, `SIGN_IN`, `SIGN_OUT`, `GET_SETTINGS`, `SAVE_SETTINGS`

**Sheets:** `ADD_SHEET`, `REMOVE_SHEET`, `REFRESH_SHEETS`, `GET_SHEETS`, `SAVE_JOB`, `FIND_APPLICATION`, `APPLY_SCHEMA_CHANGE`, `SYNC_TAB_COLUMN_UNIQUES`, `UNDO_SCHEMA_CHANGE`, `GET_UNDO_STACK`

**Page / panel:** `GET_TAB_JOB_DATA`, `GET_PAGE_JOB_DATA` (content reply), `OPEN_SIDE_PANEL`, `CLOSE_SIDE_PANEL`, `SIDE_PANEL_UNLOADED`, `SIDE_PANEL_STATE` (to content)

Do not reintroduce orphan types (`GET_OAUTH_SETUP`, `UPDATE_TAB_MAPPINGS`, `TOGGLE_PANEL`, `HIDE_PANEL`) without wiring callers.

## Reuse before invent

When implementing a behavior, search in this order:

1. Same folder (existing function / message handler)
2. `lib/` for domain helpers
3. Existing message types in the SW switch + side-panel handler
4. Similar UI in `sidepanel/` or `options/`

## Smell test

Stop and relocate if you notice:

- `chrome.sidePanel.*` outside `background/side-panel.js`
- `fetch` to `googleapis.com` outside `lib/sheets-api.js` / `lib/google-auth.js`
- Job extraction `executeScript` outside `background/page-job-data.js`
- `FIND_APPLICATION` (or other Sheets calls) from `content/`
- Raw `chrome.storage.local` settings keys instead of `lib/storage.js`
- Growing `service-worker.js` with subsystem logic (extract a `background/*.js` module)
- Recreating `popup/`

## After the change

- Keep modules single-purpose; update this map when a **new lasting layer** is introduced (ask user before new git-commit scopes).
- Prefer a one-sentence duty comment at the top of each background module.
