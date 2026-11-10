# OAuth demo video (only if Google asks)

Job Tracker requests only `https://www.googleapis.com/auth/drive.file`, a non-sensitive scope, so
Google should not require a demo video. If they ask anyway, record about 2 minutes with the packed
build in a clean Chrome profile.

## Setup

1. `npm test && npm run pack`, unzip `dist/job-tracker-<version>.zip`, load it unpacked in a new Chrome profile.
2. The unpacked copy has no `"key"`, so add its `https://<id>.chromiumapp.org/` redirect URI to the OAuth client and wait a few minutes.
3. Use a Google account that never granted Job Tracker (or remove it at https://myaccount.google.com/connections) so the consent screen shows. Set Google's language to English.
4. Have a job posting with working autofill ready.

## Script

1. **Intro.** Show https://jobtracker.jayshah.xyz/. Say: "Job Tracker saves job applications to Google Sheets the user owns. It requests only the drive.file scope, which covers files the app creates or the user picks."
2. **Consent.** Open the side panel, click **Sign in with Google**. Show the consent screen with the app name, the Drive "files you use with this app" permission, and the `client_id` in the address bar.
3. **Create tracker sheet.** Settings → **Create tracker sheet**. Switch to Google Drive and show the new sheet with its default columns.
4. **Choose from Google Drive.** Settings → **Choose from Google Drive**. Show the Picker on jobtracker.jayshah.xyz, pick a sheet, and show it appearing in Settings.
5. **Save, update, delete.** On a job posting, review the autofilled form and click **Save**; show the new row in the sheet. Edit a field and **Update**; show the change. **Delete**; show the row gone.
6. **Columns.** Add, move, hide and delete a column; show each effect in the sheet.
7. **Privacy.** Show https://jobtracker.jayshah.xyz/privacy.html. Say: "The extension can only access sheets it created or the user picked, and nothing goes to a Job Tracker server."

## Reply text

> Job Tracker now requests only the non-sensitive drive.file scope. Steps to test: install the extension, click Sign in with Google, then Create tracker sheet or Choose from Google Drive, open a job posting and click Save. No login, payment or phone check is needed on our side.
