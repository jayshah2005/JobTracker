#!/usr/bin/env node
/**
 * Build a Chrome Web Store ZIP from the extension source tree.
 *
 * - Copies only runtime files into dist/staging
 * - Strips manifest "key" (local extension ID; not for store upload)
 * - Zips so manifest.json is at the archive root
 *
 * Usage: node scripts/pack-extension.mjs
 *    or: npm run pack
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const STAGING = join(DIST, 'staging');

/** Top-level folders shipped in the extension package. */
const DIRS = [
  'background',
  'connect',
  'content',
  'icons',
  'lib',
  'options',
  'sidepanel',
];

/** Icon files referenced by (or useful for) the extension UI. */
const ICON_ALLOW = new Set([
  'icon16.png',
  'icon32.png',
  'icon48.png',
  'icon128.png',
  'logo.png',
]);

function fail(message) {
  console.error(`pack-extension: ${message}`);
  process.exit(1);
}

function readManifest() {
  const raw = readFileSync(join(ROOT, 'manifest.json'), 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    fail('manifest.json is not valid JSON');
  }
}

function writeStoreManifest(manifest) {
  const storeManifest = { ...manifest };
  delete storeManifest.key;
  writeFileSync(
    join(STAGING, 'manifest.json'),
    `${JSON.stringify(storeManifest, null, 2)}\n`,
    'utf8'
  );
}

/**
 * Inject published OAuth client into staging oauth-config.js.
 * Reads JT_OAUTH_CLIENT_ID / JT_OAUTH_CLIENT_SECRET from the environment
 * or from .env.oauth in the repo root (KEY=value lines).
 */
function injectPublishedOAuth() {
  const env = { ...process.env, ...readDotEnv(join(ROOT, '.env.oauth')) };
  const clientId = String(env.JT_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(env.JT_OAUTH_CLIENT_SECRET || '').trim();

  if (!clientId && !clientSecret) {
    console.warn(
      'pack-extension: no JT_OAUTH_CLIENT_ID/SECRET — ZIP will require BYO Cloud setup.'
    );
    return;
  }
  if (!clientId || !clientSecret) {
    fail(
      'Set both JT_OAUTH_CLIENT_ID and JT_OAUTH_CLIENT_SECRET (or both in .env.oauth).'
    );
  }
  if (!/\.apps\.googleusercontent\.com$/i.test(clientId)) {
    fail('JT_OAUTH_CLIENT_ID must end with .apps.googleusercontent.com');
  }

  const configPath = join(STAGING, 'lib', 'oauth-config.js');
  let source = readFileSync(configPath, 'utf8');
  source = source.replace(
    /export const DEFAULT_OAUTH_CLIENT_ID = '';/,
    `export const DEFAULT_OAUTH_CLIENT_ID = ${JSON.stringify(clientId)};`
  );
  source = source.replace(
    /export const DEFAULT_OAUTH_CLIENT_SECRET = '';/,
    `export const DEFAULT_OAUTH_CLIENT_SECRET = ${JSON.stringify(clientSecret)};`
  );
  if (
    !source.includes(JSON.stringify(clientId)) ||
    !source.includes(JSON.stringify(clientSecret))
  ) {
    fail('Could not inject OAuth defaults into oauth-config.js (pattern mismatch).');
  }
  writeFileSync(configPath, source, 'utf8');
  console.log('pack-extension: injected published OAuth client into store ZIP');
}

function readDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function copyRuntimeTree() {
  for (const dir of DIRS) {
    const src = join(ROOT, dir);
    if (!existsSync(src)) fail(`missing required folder: ${dir}/`);
    cpSync(src, join(STAGING, dir), { recursive: true });
  }
}

function pruneIcons() {
  const iconsDir = join(STAGING, 'icons');
  for (const name of readdirSync(iconsDir)) {
    if (!ICON_ALLOW.has(name)) rmSync(join(iconsDir, name));
  }
  for (const required of ['icon16.png', 'icon48.png', 'icon128.png']) {
    if (!existsSync(join(iconsDir, required))) {
      fail(`missing required icon: icons/${required}`);
    }
  }
}

function zipPackage(version) {
  const zipName = `job-tracker-${version}.zip`;
  const zipPath = join(DIST, zipName);
  if (existsSync(zipPath)) rmSync(zipPath);

  execFileSync('zip', ['-r', '-q', zipPath, '.'], {
    cwd: STAGING,
    stdio: 'inherit',
  });

  return { zipName, zipPath };
}

function main() {
  const manifest = readManifest();
  const version = manifest.version;
  if (!version) fail('manifest.json has no version');

  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  copyRuntimeTree();
  pruneIcons();
  injectPublishedOAuth();
  writeStoreManifest(manifest);

  const { zipName, zipPath } = zipPackage(version);
  rmSync(STAGING, { recursive: true, force: true });

  console.log(`Built ${zipPath}`);
  console.log(
    `Upload ${zipName} at https://chrome.google.com/webstore/devconsole`
  );
}

main();
