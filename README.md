# Job Tracker

Save job applications to Google Sheets from any posting. Sign in once, paste a sheet link, and click Save. You never need to edit project files.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and choose this folder
4. Pin **Job Tracker** on the toolbar

## First-time setup

1. Click the Job Tracker icon.
2. Open **Set up Google** (full-page guide).
3. Follow the steps in order: enable Sheets API, set Audience to External, create a Web application OAuth client, paste the Client ID and secret, then sign in.
4. Paste a Google Sheets link you can edit → **Add Sheet**.
5. Open a job posting → click Job Tracker → **Save**.

If you’ve already saved that job, you’ll see **Already applied** and it won’t be added twice.

**Settings** is for extra sheets, column mapping, and Google sign-out. The setup page also has a **Common problems and fixes** section.

## Tips

- Share extra sheets with the same Google account, then paste more links. No extra sign-in.
- The destination picker appears only when you have more than one tab.
- Changing column names in Settings rewrites the sheet header — you’ll get a warning, and Undo is available.

## Troubleshooting

| What you see | What to do |
|--------------|------------|
| Access blocked / organisation | Audience is Internal. Change it to External and add your email as a test user. |
| Google 400 / redirect / malformed | Paste the redirect URI from setup under **Authorized redirect URIs** exactly (including the trailing slash). Use **Web application**. |
| App not verified warning | Normal in Testing. Use Advanced → continue. |
| Access denied for your account | Add that exact email under Audience test users. |
| Client secret / invalid client | Re-copy Client ID and secret from the same OAuth client into Job Tracker and save. |
| Can’t edit spreadsheet | Sign in with an account that already has Editor access on that sheet. |
| Autofill missing | Fill the field in the sidebar — some sites don’t expose job data. |
| Panel doesn’t appear | Enable “Show Job Tracker button on job pages” in Settings. |

## License

MIT
