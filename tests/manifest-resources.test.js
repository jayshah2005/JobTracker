import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const exposed = manifest.web_accessible_resources.flatMap((r) => r.resources);

function isExposed(rel) {
  return exposed.some((pattern) =>
    pattern.endsWith('/*.js')
      ? rel.startsWith(pattern.slice(0, -4)) && rel.endsWith('.js')
      : pattern === rel
  );
}

/** Every module reachable from the content script's dynamic imports. */
function closure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      queue.push(resolve('/', dirname(rel), m[1]).slice(1));
    }
  }
  return [...seen];
}

describe('web_accessible_resources', () => {
  test('exposes every module the content script imports', () => {
    const entries = ['lib/job-page-url.js', 'lib/job-extractor.js', 'lib/storage.js'];
    for (const rel of closure(entries)) {
      expect(existsSync(join(ROOT, rel))).toBe(true);
      expect({ rel, exposed: isExposed(rel) }).toEqual({ rel, exposed: true });
    }
  });

  test('does not expose OAuth config or Sheets/auth modules to web pages', () => {
    for (const rel of ['lib/oauth-config.js', 'lib/google-auth.js', 'lib/sheets-api.js']) {
      expect(isExposed(rel)).toBe(false);
    }
  });
});

/*
 * Permission audit (keep in sync with real chrome.* usage; Web Store reviewers
 * penalise unused permissions):
 *  - storage:   chrome.storage.local/session
 *  - identity:  chrome.identity.launchWebAuthFlow (Google OAuth)
 *  - scripting: chrome.scripting.executeScript (extract job data on the tab)
 *  - sidePanel: chrome.sidePanel.open/setOptions
 * NOT needed: `tabs` (tab.url/title are readable on every http(s) page via
 * host_permissions; tabs.query/get/sendMessage/onUpdated/create need no
 * permission) and `activeTab` (redundant with <all_urls>).
 * host_permissions <all_urls> is kept deliberately: the content script runs on
 * every page to detect postings and drive the floating launcher/preload, and
 * activeTab + optional host permissions cannot replace that without breaking it.
 */
const ALLOWED_PERMISSIONS = ['storage', 'identity', 'scripting', 'sidePanel'];

describe('manifest permissions', () => {
  test('requests only permissions the code actually uses', () => {
    const extra = manifest.permissions.filter((p) => !ALLOWED_PERMISSIONS.includes(p));
    expect(extra).toEqual([]);
  });

  test('does not request redundant tabs/activeTab', () => {
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.permissions).not.toContain('activeTab');
  });
});
