# Chrome Web Store — copy/paste answers

Use these on the item edit page (Privacy practices, Store listing, Account settings).
Edit the bracketed bits if needed. Keep answers factual; reviewers check them against the package.

---

## Account settings (required before publish)

1. Open [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole) → **Settings** (or Account).
2. Enter your **publisher contact email**.
3. Click **Verify** and complete the email verification link Google sends.
4. Save. Publish stays blocked until the email is verified.

---

## Store listing — single purpose & short copy

### Single purpose description (Privacy practices)

```
Job Tracker helps users save job application details from job posting pages into their own Google Spreadsheets. It autofills fields from the current page when possible, lets the user review or edit them, and writes or updates a row in a sheet the user chooses. It does not browse the web on its own, run ads, or provide unrelated features.
```

### Short description (≤132 characters — matches manifest)

```
Track job applications in Google Sheets with smart autofill from job postings.
```

### Detailed description (Store listing)

```
Job Tracker saves job applications to Google Sheets you already own.

How it works
• Open a job posting in Chrome
• Open the Job Tracker sidebar (toolbar icon anytime, or the floating button on a single job posting)
• Review autofilled fields (company, role, URL, and more)
• Save — or update an existing row if you already tracked this job

Setup (once)
• Sign in with Google (the in-extension “Set up Google” guide helps if anything goes wrong)
• Paste a Google Sheets link you can edit
• Optionally map columns to match your spreadsheet

Privacy
• Job data is written only to spreadsheets you choose, using your Google account
• OAuth credentials and settings stay in Chrome storage on your device
• Job Tracker does not sell your data or show ads

Requirements
• A Google account and a spreadsheet you can edit
• Google sign-in that grants Job Tracker access to Google Sheets (only the spreadsheets scope is requested)
```

### Category

Productivity (or Workflow & planning)

### Language

English

---

## Privacy practices — permission justifications

Paste each into the matching field on the Privacy practices tab.

### storage

```
Used to store the user’s extension settings on their device: Google OAuth client configuration, access/refresh tokens for Google Sheets, linked spreadsheet configuration (IDs, tab mappings, column settings), and UI preferences. Also used for short-lived side-panel drafts in session storage so form input is not lost while editing. This data is not uploaded to Job Tracker servers — the extension has no backend. Spreadsheet contents are written only to the user’s Google Sheets via Google’s APIs.
```

### activeTab

```
Used when the user opens Job Tracker on the tab they are viewing so the extension can read that tab’s URL and page content (with scripting) to autofill job fields for the save form. Access is limited to the active tab in response to the user’s action (opening the sidebar or saving), not continuous background scraping of unrelated sites.
```

### identity

```
Used for Google OAuth sign-in via chrome.identity (launchWebAuthFlow and the extension redirect URL). This lets the user authorize Job Tracker to call the Google Sheets API with their account so applications can be saved to spreadsheets they own. Identity is not used for unrelated Google products or for signing the user into third-party sites.
```

### scripting

```
Used to run the extension’s packaged job-extraction script in the frames of the active job page so company, role, location, URL, and similar fields can be autofilled. Scripts are shipped inside the extension package (for example lib/job-extractor.js loaded via chrome.runtime.getURL). Scripting is not used to inject third-party or remotely hosted code.
```

### sidePanel

```
Used to show Job Tracker’s main UI as a Chrome side panel attached to the tab where the user is viewing a job posting. The panel is where users review autofilled fields, choose a destination sheet, and save or update applications. The side panel is opened only when the user clicks the extension action or the on-page launcher.
```

### tabs

```
Used to identify the tab the sidebar is bound to, open the Google setup and settings pages, and coordinate opening/closing the side panel for that tab. Tab metadata (such as URL) supports matching the current posting to rows already in the user’s sheet and keeping drafts scoped per tab. Tabs are not used to open or monitor browsing history in the background.
```

### Host permission use

Chrome may show one field covering host permissions. Use this:

```
Host access is required for two purposes only:

1) Google APIs — https://www.googleapis.com/*, https://accounts.google.com/*, https://oauth2.googleapis.com/*, and https://docs.google.com/* (plus the Sheets API endpoint sheets.googleapis.com, which is covered by the broad access below) so the extension can complete OAuth and read/write the user’s Google Spreadsheets after they sign in.

2) Job posting pages — broad site access (<all_urls> / matching content scripts) so Job Tracker can show its optional launcher on pages that look like job postings and extract visible job details from the page the user has open. The extension does not collect browsing history, does not inject ads, and does not send page contents to any Job Tracker server. Extracted fields are shown to the user and, if they choose Save, written to their own Google Sheet.
```

If the form asks separately for **\<all_urls\>** / content script matches:

```
Required so users can track applications from any job board or company careers site. A content script detects single job posting pages (URL shape, schema.org JobPosting, or application-page structure — not careers indexes or inboxes), shows an optional floating “Job Tracker” button, and helps autofill fields from the current page. Dedicated extractors cover common ATS and boards (including Greenhouse, Workday, LinkedIn, and Indeed). Users control saving; nothing is written without their action.
```

If asked separately for **Google API hosts**:

```
Required to authenticate with Google and call the Google Sheets API so application rows can be created or updated in spreadsheets the user links in Settings.
```

### Remote code use

Select **No** — this extension does **not** use remote code.

Justification / certification text:

```
All JavaScript, CSS, and HTML run from files packaged in the extension. Dynamic import/executeScript only loads local extension resources (for example chrome.runtime.getURL('lib/job-extractor.js')). Network requests go to Google OAuth and Google Sheets APIs and exchange JSON data only; the extension does not download or execute scripts from the internet, and it does not use eval or new Function on remote strings.
```

---

## Data usage certification (Privacy practices)

Check/certify that you comply with the Developer Programme Policies.

Suggested answers if the form asks what data is collected / used:

| Question (typical) | Answer |
|--------------------|--------|
| Personally identifiable information | Yes — Google account identity as provided by OAuth (email may appear via Google sign-in); job application details the user saves |
| Health / financial / auth credentials | Auth: OAuth tokens stored locally for Google Sheets access. No health/financial product features |
| Personal communications | No |
| Location | Only if present on the job posting and saved as a field by the user; not device GPS |
| Web history | No (only the current page when the user uses Job Tracker) |
| User activity | Extension usage limited to save/update flows; not sold or used for ads |

**Data usage disclosure (short paragraph):**

```
Job Tracker processes job-related fields the user chooses to save (such as company, role, URL, location, status, and custom column values) and Google OAuth tokens needed to access Sheets. Data is stored in Chrome storage on the user’s device and in Google Spreadsheets the user selects. The developer does not operate a Job Tracker server that receives this data. We do not sell user data or use it for advertising.
```

**Certification checkbox:** check that your use complies with Chrome Web Store Developer Programme Policies.

---

## Privacy policy URL

The store and Google OAuth branding require public URLs:

| Field | URL |
|-------|-----|
| Application home page | https://jobtracker.jayshah.xyz/ |
| Privacy policy | https://jobtracker.jayshah.xyz/privacy.html |

Home page is root `index.html`. Privacy page (`privacy.html`) loads the draft
below from this file on page load — edit the fenced block and push.

### Privacy policy draft (publish this page)


```
Privacy Policy — Job Tracker Chrome Extension
Last updated: Oct 21, 2026

Job Tracker (“the Extension”) helps you save job application information from web pages into Google Spreadsheets that you control.

1. Who we are
Jay, publisher of Job Tracker. Contact: jayshah3616@gmail.com

2. Google user data we access
• Google OAuth access and refresh tokens used to call the Google Sheets API on your behalf
• Spreadsheet identifiers, tab names, and header/column mappings for sheets you explicitly link
• Spreadsheet cell values the Extension reads or writes when you save or update a job application (for example company, role, URL, location, status, notes)
• Optional UI preferences stored only on your device (for example whether to show the on-page button)
• Job details read from the posting page you have open (for example title, company, location, URL). They are kept in temporary browser session storage so the side panel opens quickly and keeps your unsaved edits, and are written to a spreadsheet only when you click Save
• If you use your own Google Cloud OAuth client, the Client ID and secret you paste, stored on your device

We do not request access to Gmail, Google Drive file libraries beyond Sheets API calls for spreadsheets you link, Contacts, Calendar, or other Google products.

3. How Google user data is used
• To authenticate with Google and read/write rows in spreadsheets you link
• To autofill and display job fields in the Extension UI for you to review before saving
• Only to provide or improve these user-facing Job Tracker features

We do not sell Google user data, use it for advertising or credit decisions, or share it with data brokers. Raw or derived Google user data from Workspace APIs (including Sheets) is not used to develop, improve, or train generalized AI/ML models, and is not transferred to third-party AI/ML services for model training. Use of data received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.

4. Where data goes / transfer
• Chrome extension storage on your device (tokens, sheet configuration, UI preferences)
• Google’s servers, when you sign in and when Sheets API requests are made on your behalf
• The Extension does not send your job data or Google user data to a separate Job Tracker backend or other third-party application servers

5. Data protection
• OAuth tokens and configuration are stored in Chrome’s extension storage on your device and are not uploaded to Job Tracker servers (there is no Job Tracker backend)
• Communication with Google OAuth and the Google Sheets API uses HTTPS
• Access to your spreadsheets requires your Google sign-in and your grant of the Spreadsheets scope; the Extension only operates on spreadsheet links you paste and that your Google account can edit
• We do not maintain a separate cloud database of your sheet contents

6. Retention and deletion of Google user data
• OAuth tokens: kept in local Chrome storage until you sign out of Job Tracker, clear the Extension’s data in Chrome, or uninstall the Extension. Signing out removes stored tokens from the Extension; it does not by itself revoke Job Tracker’s access at Google (you can revoke access in your Google Account permissions, as described below).
• Sheet configuration (IDs, tabs, column mappings) and UI preferences: kept locally until you remove them in Settings, clear Extension data, or uninstall
• Spreadsheet contents: retained in your Google Sheets under your Google account’s retention controls. Deleting a row via Job Tracker (when you use delete) removes or updates that data in your sheet; uninstalling Job Tracker does not delete your Google Sheet. You can revoke Job Tracker’s access at any time in your Google Account permissions (Third-party access / Data & privacy) and delete sheet data directly in Google Sheets

7. Third parties
Google (Accounts / OAuth / Sheets) under Google’s terms and privacy policy. You must use a Google account and grant access. No other third parties receive your Google user data from Job Tracker.

8. Children’s privacy
Not directed at children under 13.

9. Changes
We may update this policy; the “Last updated” date will change.

10. Contact
jayshah3616@gmail.com
```

---

## Screenshot or video (required)

You need **at least one** screenshot (1280×800 or 640×400 recommended).

### What to capture

1. Side panel open on a real job posting with autofilled fields visible  
2. (Optional) Settings page with a linked sheet  
3. (Optional) “Already in tracker” / edit flow  

### Quick way to create one

1. Load the packed/unpacked extension in Chrome  
2. Open a public job posting  
3. Open the Job Tracker sidebar  
4. Resize the window to ~1280×800  
5. Screenshot → save as `store/screenshot-1.png`  
6. Upload under **Store listing → Screenshots**

A short Loom/MP4 of open → fill → Save also satisfies “screenshot or video.”

---

## Checklist before “Submit for review”

- [ ] Publisher contact email entered and **verified** (Settings)  
- [ ] Privacy policy URL live and linked  
- [ ] Single purpose description pasted  
- [ ] All permission justifications pasted  
- [ ] Remote code = **No**, with justification above  
- [ ] Data usage certified  
- [ ] ≥1 screenshot or video uploaded  
- [ ] Store icon (128px) set — use `icons/icon128.png`  
- [ ] Draft **saved**  
- [ ] OAuth redirect URI in Google Cloud includes  
  `https://<STORE_EXTENSION_ID>.chromiumapp.org/`  
  (and trailing slash if your setup page shows one)

---

## Notes reviewers often flag

- **\<all_urls\>**: justified by “any job board”; do not claim you only run on 2–3 sites unless you narrow the manifest.  
- **Remote code**: answer No; dynamic `import` of packaged files is not remote code.  
- **Identity + Sheets**: say clearly data goes to the **user’s** spreadsheet, not your servers.  
- Keep the live ZIP matching these claims (`npm run pack`).
