/**
 * Connect page (opened in a full tab): signs the user in with Google and,
 * when the build has no baked-in OAuth client, lets them paste their own
 * Client ID/secret ("Advanced"). All work is delegated to the service worker
 * via chrome.runtime messages: GET_AUTH_STATUS, SAVE_OAUTH_CLIENT, SIGN_IN,
 * SIGN_OUT. Tokens and secrets never live in this page.
 */

const $ = (sel) => document.querySelector(sel);

async function init() {
  $('#copy-redirect')?.addEventListener('click', copyRedirectUri);
  $('#save-oauth-btn')?.addEventListener('click', handleSave);
  $('#sign-in-btn')?.addEventListener('click', handleSignIn);
  $('#sign-out-btn')?.addEventListener('click', handleSignOut);
  await loadAuth();
}

/** Fetch auth state from the service worker and sync the whole page to it. */
async function loadAuth() {
  const res = await sendMessage({ type: 'GET_AUTH_STATUS' });
  if (res?.redirectUri) {
    const el = $('#redirect-uri');
    if (el) el.textContent = res.redirectUri;
  }
  if (res?.clientId) {
    const input = $('#oauth-client-id');
    if (input && !input.value) input.value = res.clientId;
  }

  const signedIn = !!res?.signedIn;
  // "published" = the build ships OAuth credentials; otherwise the user must
  // bring their own client (needsSetup stays true until ID + secret are saved).
  const published = !!res?.usingPublishedOAuth && !res?.needsSetup;
  applyMode(published, !!res?.needsSetup);

  $('#signed-in-default')?.classList.toggle('hidden', !signedIn);
  $('#signed-out-default')?.classList.toggle('hidden', signedIn);
}

/**
 * Swap hero/intro copy depending on whether credentials come from the build
 * (published), from the user's own client (custom, already saved), or are
 * still missing (needsSetup).
 */
function applyMode(published, needsSetup) {
  const advanced = $('#advanced-byo');
  const intro = $('#default-intro-text');
  const help = $('#sign-in-help');

  if (published || !needsSetup) {
    $('#hero-title').textContent = 'Connect Google';
    $('#hero-lede').textContent =
      'Sign in once so Job Tracker can save applications to your Google Sheets.';
    if (intro) {
      intro.innerHTML =
        'Job Tracker uses Google sign-in to write rows into <strong>your</strong> spreadsheets. ' +
        'Use the same Google account that can edit those sheets.' +
        (published ? ' No Google Cloud project is required.' : '');
    }
    if (help) {
      help.textContent =
        'Sign in with the account that can edit your job tracker spreadsheet. Then open Settings and paste a sheet link that account can edit.';
    }
    $('#problems-lede').textContent =
      'If sign-in fails, match what you see below. For sheet access errors, check Share → Editor on the spreadsheet.';
    if (advanced) advanced.open = false;
  } else {
    $('#hero-title').textContent = 'First-time Google setup';
    $('#hero-lede').textContent =
      'Complete the Advanced steps once, then sign in. You never need to edit project files.';
    if (intro) {
      intro.innerHTML =
        'This build does not include a published Google login yet. Open <strong>Advanced</strong> below, ' +
        'create an OAuth client in Google Cloud, save the Client ID and secret, then sign in here.';
    }
    if (help) {
      help.textContent =
        'After you save a Client ID and secret under Advanced, click Sign in with Google. Use an account that can edit your spreadsheet (and is a test user while the Cloud app is in Testing).';
    }
    $('#problems-lede').textContent =
      'If something fails, match what you see below. Almost every issue is fixed in Google Cloud settings — not by reinstalling the extension.';
    // Guide people into the setup they must complete.
    if (advanced) advanced.open = true;
  }
}

/** Save the pasted Client ID/secret, then point the user at Sign in. */
async function handleSave() {
  const btn = $('#save-oauth-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await sendMessage({
      type: 'SAVE_OAUTH_CLIENT',
      clientId: $('#oauth-client-id').value.trim(),
      clientSecret: $('#oauth-client-secret').value.trim(),
    });
    if (res.success && res.needsSetup) {
      // The service worker saves the ID even when the secret is empty.
      showStatus('Client ID saved, but the Client secret is still missing. Paste it and save again.', 'error');
      await loadAuth();
    } else if (res.success) {
      showStatus('Saved. Now click Sign in with Google above.', 'success');
      await loadAuth();
      $('#sign-in-btn')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#sign-in-btn')?.focus();
    } else {
      showStatus(res.error || 'Could not save connection.', 'error');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save connection';
  }
}

/** Start the interactive Google OAuth flow (opens Google's own popup). */
async function handleSignIn() {
  const btn = $('#sign-in-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await sendMessage({ type: 'SIGN_IN' });
    if (res.needsSetup) {
      const advanced = $('#advanced-byo');
      if (advanced) advanced.open = true;
      showStatus(
        'Open Advanced, paste your Client ID and secret, Save connection, then try again.',
        'error'
      );
      return;
    }
    if (res.success && res.signedIn) {
      await loadAuth();
      showStatus('Google is connected. You can close this tab.', 'success');
    } else {
      showStatus(
        res.error || 'Sign-in failed. See Common problems and fixes below.',
        'error'
      );
      $('#problems')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in with Google';
  }
}

/** Sign out clears local tokens only; access can also be revoked in your Google account. */
async function handleSignOut() {
  const res = await sendMessage({ type: 'SIGN_OUT' });
  await loadAuth();
  if (res?.success === false) showStatus(res.error || 'Could not sign out.', 'error');
  else showStatus('Signed out. Sign in again to keep saving jobs.', 'success');
}

async function copyRedirectUri() {
  const value = $('#redirect-uri')?.textContent.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showStatus('Redirect URI copied.', 'success');
  } catch {
    showStatus(`Could not copy automatically. Select and copy this manually: ${value}`, 'error');
  }
}

/** Show a message in the aria-live region ('success' | 'error' | 'info'). */
function showStatus(msg, type) {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status status-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.classList.remove('hidden');
}

/**
 * Promise wrapper for chrome.runtime.sendMessage. Never rejects: a missing
 * response (e.g. service worker error) resolves to { success: false, error }
 * so callers can always read res.success / res.error.
 */
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError || res == null) {
        resolve({
          success: false,
          error: chrome.runtime.lastError?.message || 'No response from the extension. Reload this page and try again.',
        });
        return;
      }
      resolve(res);
    });
  });
}

init();
