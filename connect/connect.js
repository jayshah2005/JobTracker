const $ = (sel) => document.querySelector(sel);

async function init() {
  $('#copy-redirect').addEventListener('click', copyRedirectUri);
  $('#save-oauth-btn').addEventListener('click', handleSave);
  $('#sign-in-btn').addEventListener('click', handleSignIn);
  $('#sign-out-btn').addEventListener('click', handleSignOut);
  await loadAuth();
}

async function loadAuth() {
  const res = await sendMessage({ type: 'GET_AUTH_STATUS' });
  if (res?.redirectUri) {
    $('#redirect-uri').textContent = res.redirectUri;
  }
  if (res?.clientId) {
    $('#oauth-client-id').value = res.clientId;
  }
  const signedIn = !!res?.signedIn;
  $('#signed-in').classList.toggle('hidden', !signedIn);
  $('#signed-out').classList.toggle('hidden', signedIn);
}

async function handleSave() {
  const btn = $('#save-oauth-btn');
  btn.disabled = true;
  try {
    const res = await sendMessage({
      type: 'SAVE_OAUTH_CLIENT',
      clientId: $('#oauth-client-id').value.trim(),
      clientSecret: $('#oauth-client-secret').value.trim(),
    });
    if (res.success) {
      showStatus('Saved. Sign in with Google below.', 'success');
      await loadAuth();
      $('#sign-in-btn')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      showStatus(res.error || 'Could not save connection.', 'error');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function handleSignIn() {
  const btn = $('#sign-in-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await sendMessage({ type: 'SIGN_IN' });
    if (res.needsSetup) {
      showStatus('Save your Client ID and secret in step 4 first.', 'error');
      return;
    }
    if (res.success && res.signedIn) {
      await loadAuth();
      showStatus('Google is connected. You can close this tab.', 'success');
    } else {
      showStatus(
        res.error ||
          'Sign-in failed. See Common problems and fixes below.',
        'error'
      );
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in with Google';
  }
}

async function handleSignOut() {
  await sendMessage({ type: 'SIGN_OUT' });
  await loadAuth();
  showStatus('Signed out.', 'success');
}

async function copyRedirectUri() {
  const value = $('#redirect-uri').textContent.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showStatus('Redirect link copied.', 'success');
  } catch {
    showStatus(value, 'error');
  }
}

function showStatus(msg, type) {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status status-${type}`;
  el.classList.remove('hidden');
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

init();
