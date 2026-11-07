# OAuth demo video — Google Sheets scope

Script and checklist for the video Google's Third Party Data Safety Team asked for.
Scope under review: `https://www.googleapis.com/auth/spreadsheets` (the only scope Job Tracker requests).

Target length: 3–5 minutes. Record in one take if you can; cuts are fine, but don't cut out
the consent screen or the moment a change appears in the sheet.

---

## What Google's email requires

| Requirement | What it means for this video |
|-------------|------------------------------|
| Hosting | Upload to YouTube as **Unlisted** (or Public). Not Private. |
| Language | English. Narrate out loud or use on-screen captions. Set the consent screen language (bottom-left of the Google page) to **English**. |
| Consent screen | Show the full Google consent screen. The Sheets permission text must be readable. If Google collapses it, click **Show all services** / expand it. |
| App identity | Consent screen shows the app name **Job Tracker**. The browser address bar on that screen shows your OAuth **client_id** — zoom or pause there for 2–3 seconds. |
| Scope matching | The consent screen should show only the Sheets permission, matching Cloud Console. |
| Full functionality | Show every feature that uses the scope: reading the sheet, adding a row, updating a row, deleting a row, and changing the sheet's columns. |
| Source account impact | After each write or delete, switch to the real Google Sheet and show the change there. |
| Least privilege | Say why `spreadsheets.readonly` and `drive.file` are not enough (script below). |
| Test access | No login of ours, no payment, no phone check. Put step-by-step instructions in your email reply (template at the bottom). |

---

## Before you hit record

1. **Record with the packed build in a clean Chrome profile.** The repo folder has no
   built-in OAuth client (`lib/oauth-config.js` is empty on purpose); `npm run pack` is
   what bakes in the client from `.env.oauth`. A Client ID saved earlier in the extension
   (Advanced setup) overrides the built-in one, so use a fresh profile.
   - `npm test && npm run pack` → `dist/job-tracker-<version>.zip`
   - Unzip it to a folder you'll keep, e.g. `~/JobTrackerDemo/`
   - Chrome → profile icon → **Add** → new profile (no saved Job Tracker settings)
   - In that profile: `chrome://extensions` → **Developer mode** → **Load unpacked** →
     pick the unzipped folder (the one containing `manifest.json`)
   - Open the side panel. It should go straight to **Sign in with Google**, not to
     "Set up Google". If it asks for a Client ID, the build has no client — re-check
     `.env.oauth` and re-pack.
2. **Add that build's redirect URI.** The packed build has no `"key"`, so it gets a new
   extension ID.
   - `chrome://extensions` → copy the **ID** under Job Tracker
   - Cloud Console → Google Auth Platform → **Clients** → your Web client →
     **Authorized redirect URIs** → **+ Add URI** →
     `https://<THAT_ID>.chromiumapp.org/` (with the trailing slash) → **Save**
   - Wait about 5 minutes, then try a sign-in before recording. `redirect_uri_mismatch`
     means the URI isn't saved or doesn't match.
3. **Make Google show the consent screen.** Google skips it for an account that already
   granted access.
   - Easiest: use a Google account that has never used Job Tracker.
   - Or, for your own account: https://myaccount.google.com/connections → **Job Tracker** →
     **Delete all connections you have with Job Tracker**.
   - Until verification passes, Google shows "Google hasn't verified this app" first.
     That's expected — click **Advanced** → **Go to Job Tracker** on camera.
   - If the consent screen has a checkbox next to the Sheets permission, tick it.
   - Do one dry run, then revoke again so the recording shows the consent screen.
   - Check the client ID: the consent page URL contains
     `client_id=….apps.googleusercontent.com`. It must match the Client ID on the
     **Clients** page of project `genial-analyzer-509116-p5`.
4. **Prepare a demo spreadsheet.** New Google Sheet named `Job Tracker Demo`, with a header
   row like: `Company | Role | Location | URL | Status | Date Applied | Notes`.
   Leave it open in a second tab.
5. **Pick a real job posting** (Greenhouse, Lever, Workday, LinkedIn, etc.) where autofill
   works. Try it once before recording.
6. **Remove the demo sheet from the extension** if it's already linked (Settings), so you
   can show linking it on camera.
7. Close unrelated tabs, hide bookmarks with personal info, turn off notifications.
   Window around 1280×800 is fine. Use a screen recorder (QuickTime / OBS / Loom).

---

## Script

Say the lines in quotes. Actions are in plain text.

### 1. Intro (15 s)

Show: the Job Tracker home page, https://jobtracker.jayshah.xyz/

> "This is Job Tracker, a Chrome extension that saves job applications into a Google Sheet
> the user owns. It requests one scope: the Google Sheets scope,
> googleapis.com/auth/spreadsheets. I'll show the sign-in and consent flow, then every
> feature that uses that scope, and the result in the user's Google Sheet each time."

### 2. Sign in and consent (45 s)

1. Click the Job Tracker toolbar icon to open the side panel.
2. Click **Sign in with Google**.
3. Pick the Google account.

> "Here is Google's consent screen. The app name is Job Tracker."

4. Point to (or zoom on) the address bar.

> "The address bar shows our OAuth client ID."

5. Expand the permission list if it's collapsed (**Show all services** / the arrow).

> "The only permission requested is See, edit, create and delete all your Google Sheets
> spreadsheets. That is the spreadsheets scope we submitted for verification."

6. Click **Continue** / **Allow**.

> "I'm granting access. The extension is now signed in."

### 3. Link a spreadsheet — reads the sheet (30 s)

1. Open the Google Sheet tab and copy its URL.

> "This is my own Google Sheet with a header row."

2. Back in the side panel (or Settings), paste the link and click **Add sheet**.

> "I paste the link to a spreadsheet I own. Job Tracker uses the Sheets API to read this
> spreadsheet's tabs and header row so it can map job fields to my columns."

3. Show the columns/tab now listed in the extension.

### 4. Save a job — creates a row (45 s)

1. Open the job posting tab. Open the side panel.

> "I'm on a job posting. Job Tracker reads the page I have open and fills in company,
> role, location and URL. I can edit anything before saving."

2. Change one field (for example set Status to `Applied`, add a note).
3. Click **Save to tracker**.

> "I click Save. The extension writes a new row to my sheet with the Sheets API."

4. Switch to the Google Sheet tab (refresh if needed). Point at the new row.

> "And here is the new row in my Google Sheet."

### 5. Update the same job — edits a row (30 s)

1. Go back to the job posting and open the side panel again.

> "When I come back to the same posting, Job Tracker reads my sheet, finds the existing row,
> and shows it's already in my tracker, so I don't create a duplicate."

2. Change Status (for example `Interviewing`) and click **Update tracker**.
3. Switch to the sheet and show the changed cell.

> "The update is written to the same row in my sheet."

### 6. Change the sheet's columns — writes the header (30 s)

1. Open **Settings**. Rename one column, or add a column (for example `Salary`).
2. Save / confirm the warning.

> "From Settings I can change the sheet's columns. This rewrites the header row in my
> spreadsheet through the Sheets API."

3. Switch to the sheet and show the header changed.
4. Optional: click **Undo** in Settings and show the header go back.

### 7. Delete a job — removes a row (30 s)

1. Back on the job posting, open the side panel. Click **Delete from tracker** and confirm.

> "Users can also delete a tracked job."

2. Switch to the sheet and show the row is gone.

> "The row is removed from my Google Sheet."

### 8. Why this scope, and not a narrower one (30 s)

Show: the extension or the sheet; this part is just narration.

> "Job Tracker needs to read the sheet's header and existing rows, and to create, update
> and delete rows and header cells, in spreadsheets the user already owns and links by URL.
> The read-only Sheets scope can't write. The drive.file scope only covers files the app
> created or the user opened through a Google file picker, so it doesn't cover an existing
> spreadsheet the user links by pasting its address. The spreadsheets scope is the narrowest
> scope that supports these features. We don't request Gmail, Drive, or any other scope."

### 9. Data handling + close (20 s)

Show: https://jobtracker.jayshah.xyz/privacy.html

> "Data is only sent between the extension and Google's APIs. There is no Job Tracker
> server. Tokens stay in Chrome on the user's device and are deleted on sign out. Our
> privacy policy describes data protection, retention and deletion. Thank you."

---

## After recording

1. Upload to YouTube → Visibility **Unlisted**. Title: `Job Tracker — Google Sheets OAuth demo`.
2. Open the link in a private window to confirm it plays without signing in.
3. Cloud Console → Google Auth Platform → **Verification Center** / **Data access** →
   replace the demo video link → Save / resubmit.
4. Reply to Google's email (below).

### Reply template

```
Hello Third Party Data Safety Team,

I have addressed the items for project 144987510262 (genial-analyzer-509116-p5).

Updated privacy policy (data protection in section 5, retention and deletion in section 6):
https://jobtracker.jayshah.xyz/privacy.html

New demo video (unlisted):
[YOUTUBE LINK]

The video shows the consent screen with the spreadsheets scope expanded, and each feature
that uses it — reading the sheet header, adding a row, updating a row, changing the header
columns, and deleting a row — with each change shown in the user's Google Sheet.

Scope: https://www.googleapis.com/auth/spreadsheets only (matches Cloud Console).
Narrower scopes: spreadsheets.readonly cannot write; drive.file does not cover existing
spreadsheets the user links by URL.

Test access (no test credentials needed — no Job Tracker account, payment, or phone check):
1. Install Job Tracker in Chrome.
2. Click the Job Tracker toolbar icon → Sign in with Google → allow access.
3. Create any Google Sheet with a header row, copy its URL, paste it into Job Tracker → Add sheet.
4. Open any job posting (for example a Greenhouse or Lever job page) → open the side panel →
   Save to tracker. The row appears in the sheet.
5. Revisit the posting → change Status → Update tracker. The row updates.
6. Settings → rename or add a column. The header row updates.
7. Revisit the posting → Delete from tracker. The row is removed.

Please continue the verification review.

Best regards,
Jay
jayshah3616@gmail.com
```
