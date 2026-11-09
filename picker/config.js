// Public identifiers for the hosted Google Picker. None of these are secrets,
// but they must be filled in before the Picker works. See store/PUBLISHER_OAUTH.md.
//
// All three MUST come from the SAME Google Cloud project as the extension's
// published OAuth client (drive.file access is granted per project).

// Cloud Console -> APIs & Services -> Credentials -> Create credentials ->
// OAuth client ID -> "Web application". Add Authorized JavaScript origin:
// https://jobtracker.jayshah.xyz  (no redirect URI is needed).
export const CLIENT_ID = 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com';

// Credentials -> Create credentials -> API key. Restrict it to the
// "Google Picker API" and to HTTP referrer https://jobtracker.jayshah.xyz/*
export const API_KEY = 'YOUR_API_KEY';

// Cloud Console -> Dashboard / project settings -> "Project number" (digits only).
export const PROJECT_NUMBER = 'YOUR_PROJECT_NUMBER';
