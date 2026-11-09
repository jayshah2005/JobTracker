# Changelog

## What changed in this release (branch `feat/auth-drive-file-scope`)

### Scope and permissions
- Requests only the non-sensitive `drive.file` scope; the broad `spreadsheets` scope is gone. Sessions granted under the old scope are dropped and the user signs in again (`scopeOutdated`).
- Removed the `tabs` and `activeTab` permissions and the unused `docs.google.com` / `www.googleapis.com` hosts. Permissions are now `storage`, `identity`, `scripting`, `sidePanel`, plus the Google API hosts and `<all_urls>` for the content script. On `chrome://` and Web Store pages the side panel opens but shows no job data.
- `web_accessible_resources` narrowed from `lib/*.js` to the specific files the content script imports.
- `externally_connectable` added for `https://jobtracker.jayshah.xyz/*`; the service worker also checks the sender origin and `/picker/` path.

### Connecting sheets
- **Create tracker sheet** (`CREATE_SHEET`) with default columns (Date Applied, Job ID, Company Name, Role, Location, Application Status, Notes).
- **Choose from Google Drive** (`OPEN_PICKER`) via the hosted `picker/` page, which returns `SHEETS_PICKED` to the extension. `GET_AUTH_STATUS` reports `pickerAvailable` (false with a custom OAuth client).
- **Grant access** for pasted links and for sheets flagged **Needs access**.
- Default sheet setting; destination picker only with more than one tab.

### Saving and searching
- The side panel no longer blocks on the sheet search: the form shows first, "Checking your sheets…" runs in the background, selected and default sheets first.
- Row-change protection: Update and Delete send a row fingerprint and get `ROW_CHANGED` if the row was edited or moved.
- Rows are read in 500-row chunks (A:ZZ), so large sheets are searched fully.
- Duplicate matching skips an id-only match when both companies are present and clearly different (`companiesClearlyDiffer`).

### Columns and dialogs
- Removing a column offers **Hide from the form** or **Delete column and its data**; moves carry data with them; undo/redo for column edits.
- In-page accessible dialogs (`lib/dialog.js`) replace native confirm/prompt/alert.

### Reliability
- The post-write fingerprint read is best-effort: if it fails, `rowFingerprint` is null and the next update skips the row-change check instead of erroring.
- `REFRESH_SHEETS` keeps sheets re-granted during the refresh (strictly increasing `addedAt`); schema apply, undo and redo merge into the latest stored sheets via `commitTabSchema`.
- The PKCE verifier is held in memory only; no PKCE value is persisted.
- The content script's `sendToBackground` survives "extension context invalidated" after an extension reload.
- Ctrl/Cmd+Z is ignored while a dialog is open.
- Saves are queued per spreadsheet + tab, so a double click or two panels cannot both pass the duplicate check and append twice. Schema apply, undo and redo share one queue. `REFRESH_SHEETS` merge keeps concurrent schema edits.
- Errors are classified by HTTP status, not message text: a tab named "401" no longer triggers sign-in. `FIND_APPLICATION` rethrows 401 so the token refreshes and retries.
- Delete uses the matched row's own sheet and tab and is guarded against a save or delete already in progress. Save snapshots the form at click time; stale search or save results are ignored; stale status is cleared on a new job page.
- Settings background sync no longer overwrites what you are typing.
- Content script tears down cleanly on reload (instance id); `collectProximityCandidates` is capped.
- Tabs flagged **Needs access** show "(needs access)" in the destination menu, are skipped for the default/first selection, and saving to one is refused with a Grant access message.

### Security
- Formula-injection protection: scraped or typed values starting with `=`, `+`, `-` or `@` (plain numbers excepted) are stored as text with a leading apostrophe (`neutralizeFormula`). Only our own Role `HYPERLINK` is ever written as a formula. The apostrophe is stripped when rows are read back (`stripTextMarker`) and in duplicate matching.
- Canonical-link spoof guard: LinkedIn and Indeed ignore a page `canonical` link that points at a different site.
- The floating launcher is hardened against host-page CSS.

### Extraction
- Posted dates: relative ("3 days ago") and year-less ("Jan 5") dates are resolved against today; ambiguous or multi-date text is left blank.
- Relative dates are DST-safe; JSON-LD country objects are read; SmartRecruiters company pages are not treated as jobs.
- Role/company split for "A | B" style titles uses keyword scoring (`lib/role-likelihood.js`).

### Design
- Shared design tokens (`lib/tokens.css`) and UI primitives (`lib/ui.css`) with dark mode (dark primary `#6a61ee`) across the side panel, Settings, connect page, picker, home and privacy pages. The floating launcher stays light and mirrors the light tokens by hand. Side panel body uses the background token; spinner pulses under reduced-motion; text aligns to start (RTL); coarse-pointer devices get 32px touch targets. Text-zoom and min-width fixes; Settings dark-mode contrast fix.

### Fixes and docs
- Many bug fixes across add, save, delete, refresh and schema flows (see the new Jest suites).
- README, store listing, privacy policy, publisher guide and diagrams updated to match; policy text now says "Google Sheets".
