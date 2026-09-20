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
• Open the Job Tracker sidebar (toolbar or the floating button on job pages)
• Review autofilled fields (company, role, URL, and more)
• Save — or update an existing row if you already tracked this job

Setup (once)
• Connect your Google account through the in-extension guide
• Paste a Google Sheets link you can edit
• Optionally map columns to match your spreadsheet

Privacy
• Job data is written only to spreadsheets you choose, using your Google account
• OAuth credentials and settings stay in Chrome storage on your device
• Job Tracker does not sell your data or show ads

Requirements
• A Google account and a spreadsheet you can edit
• Permission to use Google Sheets API with your own OAuth client (setup steps are included)
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

1) Google APIs — https://www.googleapis.com/*, https://accounts.google.com/*, https://oauth2.googleapis.com/*, and https://docs.google.com/* so the extension can complete OAuth and read/write the user’s Google Spreadsheets after they sign in.

2) Job posting pages — broad site access (<all_urls> / matching content scripts) so Job Tracker can show its optional launcher on pages that look like job postings and extract visible job details from the page the user has open. The extension does not collect browsing history, does not inject ads, and does not send page contents to any Job Tracker server. Extracted fields are shown to the user and, if they choose Save, written to their own Google Sheet.
```

If the form asks separately for **\<all_urls\>** / content script matches:

```
Required so users can track applications from any job board or company careers site. A content script detects likely job pages, shows an optional floating “Job Tracker” button, and helps autofill fields from the current page. Users control saving; nothing is written without their action.
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

The store requires a public privacy policy link for this permission set. Host a page (GitHub Pages, Notion public page, your site) and paste the URL.

### Privacy policy draft (publish this page)

```
Privacy Policy — Job Tracker Chrome Extension
Last updated: [DATE]

Job Tracker (“the Extension”) helps you save job application information from web pages into Google Spreadsheets that you control.

1. Who we are
[Your name or entity], publisher of Job Tracker. Contact: [YOUR EMAIL]

2. Data we handle
• Google OAuth tokens and client configuration you enter, stored in Chrome’s extension storage on your device
• Spreadsheet IDs, tab names, and column mappings you configure
• Job application fields you review and save (for example company, role, URL, location, status, notes)
• Optional UI preferences (for example whether to show the on-page button)

3. How data is used
• To authenticate with Google and read/write rows in spreadsheets you link
• To autofill and display job fields in the Extension UI
• We do not sell your data, use it for advertising, or share it with data brokers

4. Where data goes
• Chrome storage on your device
• Google’s servers, when you sign in and when Sheets API requests are made on your behalf
• The Extension does not send your job data to a separate Job Tracker backend

5. Third parties
Google (Accounts / OAuth / Sheets) under Google’s terms and privacy policy. You must use a Google account and grant access.

6. Retention
Local settings and tokens remain until you clear extension data, uninstall, or sign out (tokens removed on sign-out). Spreadsheet data remains in your Google Sheets under your control.

7. Children’s privacy
Not directed at children under 13.

8. Changes
We may update this policy; the “Last updated” date will change.

9. Contact
[YOUR EMAIL]
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
