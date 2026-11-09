/**
 * Hosted Google Picker page (served by GitHub Pages at /picker/, not shipped in the extension ZIP).
 * Flow: parse ?ext=<extension id>&ids=<optional sheet ids> -> load Google Identity Services + Picker ->
 * on click request a drive.file token -> show the Picker (spreadsheets, multiselect) -> send
 * chrome.runtime.sendMessage(extId, {type: 'SHEETS_PICKED', files: [{id, name}]}) to the extension,
 * which validates the sender origin. This page stores nothing. IDs come from picker/config.js and must
 * belong to the same Cloud project as the extension's OAuth client.
 */

import { CLIENT_ID, API_KEY, PROJECT_NUMBER } from './config.js';
import { parsePickerQuery, toPickedFiles } from './helpers.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const $ = (id) => document.getElementById(id);
const btn = $('choose');
const retry = $('retry');
const statusEl = $('status');

const { extId, ids, error } = parsePickerQuery(location.search);
let tokenClient = null;
let pickedFiles = null;

/** Disable the button while sign-in / the Picker is open so a double-click can't start two flows. */
function setBusy(busy) {
  btn.disabled = busy || !tokenClient;
}

function setStatus(kind, text) {
  statusEl.className = 'status ' + kind;
  statusEl.textContent = text;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

function isConfigured() {
  return ![CLIENT_ID, API_KEY, PROJECT_NUMBER].some((v) => !v || v.startsWith('YOUR_'));
}

async function init() {
  if (error) {
    btn.disabled = true;
    setStatus('error', 'This link is incomplete. Open the picker from the Job Tracker extension.');
    return;
  }
  if (!isConfigured()) {
    btn.disabled = true;
    setStatus('error', 'The picker is not configured yet.');
    return;
  }
  try {
    await Promise.all([
      loadScript('https://accounts.google.com/gsi/client'),
      loadScript('https://apis.google.com/js/api.js'),
    ]);
    await new Promise((resolve, reject) =>
      gapi.load('picker', { callback: resolve, onerror: reject }),
    );
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: onToken,
      error_callback: (e) => {
        setBusy(false);
        const type = e && e.type;
        setStatus(
          'error',
          type === 'popup_closed'
            ? 'Sign-in was closed. Try again.'
            : type === 'popup_failed_to_open'
              ? 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.'
              : 'Google sign-in failed. Try again.',
        );
      },
    });
    setBusy(false);
  } catch (e) {
    setStatus('error', 'Could not load Google. Check your connection and reload.');
  }
}

function onToken(resp) {
  if (!resp || resp.error || !resp.access_token) {
    setBusy(false);
    setStatus('error', 'Google did not grant access. Try again.');
    return;
  }
  try {
    openPicker(resp.access_token);
  } catch (e) {
    setBusy(false);
    setStatus('error', 'Could not open Google Picker. Check the picker configuration and try again.');
  }
}

function openPicker(token) {
  const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
    .setMimeTypes('application/vnd.google-apps.spreadsheet');
  if (ids.length) view.setFileIds(ids.join(','));
  new google.picker.PickerBuilder()
    .addView(view)
    .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
    .setAppId(PROJECT_NUMBER)
    .setDeveloperKey(API_KEY)
    .setOAuthToken(token)
    .setCallback(onPicked)
    .build()
    .setVisible(true);
}

function onPicked(data) {
  const action = data[google.picker.Response.ACTION];
  if (action === google.picker.Action.CANCEL) {
    setBusy(false);
    return;
  }
  if (action !== google.picker.Action.PICKED) return;
  setBusy(false);
  pickedFiles = toPickedFiles(
    (data[google.picker.Response.DOCUMENTS] || []).map((d) => ({
      id: d[google.picker.Document.ID],
      name: d[google.picker.Document.NAME],
    })),
  );
  if (pickedFiles.length) sendToExtension();
  else setStatus('error', 'No spreadsheets were selected. Try again.');
}

function sendToExtension() {
  retry.hidden = true;
  const fail = (msg) => {
    setStatus('error', msg);
    retry.hidden = false;
  };
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    return fail('Open this page in Chrome (or another Chromium browser) with Job Tracker installed.');
  }
  try {
    chrome.runtime.sendMessage(extId, { type: 'SHEETS_PICKED', files: pickedFiles }, (res) => {
      if (chrome.runtime.lastError || !res) {
        return fail('Could not reach Job Tracker. Make sure it is installed and enabled, then retry.');
      }
      // The extension replies { success, added, error? }; `added` counts only newly connected sheets.
      if (!res.success && !res.added) {
        return fail(res.error || 'Job Tracker could not add that sheet. Try again.');
      }
      const names = pickedFiles.map((f) => '“' + f.name + '”').join(', ');
      if (!res.success) {
        return setStatus('error', 'Some sheets were added, but not all. ' + (res.error || '') + ' You can close this tab.');
      }
      setStatus('ok', 'Added ' + names + ' to Job Tracker. You can close this tab.');
    });
  } catch (e) {
    fail('Could not reach Job Tracker. Make sure it is installed and enabled, then retry.');
  }
}

btn.addEventListener('click', () => {
  if (!tokenClient || btn.disabled) return;
  setStatus('', '');
  setBusy(true);
  tokenClient.requestAccessToken({ prompt: '' });
});
retry.addEventListener('click', sendToExtension);

init();
