#!/usr/bin/env node
/**
 * Build store/privacy/index.html from the privacy-policy draft in
 * store/LISTING_COPY.md (fenced block under "### Privacy policy draft").
 *
 * Usage: node scripts/build-privacy-page.mjs
 *    or: npm run privacy-page
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'store', 'LISTING_COPY.md');
const OUT_DIR = join(ROOT, 'store', 'privacy');
const OUT_FILE = join(OUT_DIR, 'index.html');

function fail(msg) {
  console.error(`build-privacy-page: ${msg}`);
  process.exit(1);
}

function extractDraft(markdown) {
  const marker = '### Privacy policy draft';
  const start = markdown.indexOf(marker);
  if (start === -1) fail(`missing "${marker}" in LISTING_COPY.md`);

  const afterHeading = markdown.slice(start + marker.length);
  const fenceOpen = afterHeading.indexOf('```');
  if (fenceOpen === -1) fail('missing opening ``` after privacy policy draft heading');

  const bodyStart = fenceOpen + 3;
  // Skip optional language tag on the opening fence line
  const afterOpen = afterHeading.slice(bodyStart).replace(/^[a-z]*\r?\n/, '');
  const fenceClose = afterOpen.indexOf('```');
  if (fenceClose === -1) fail('missing closing ``` for privacy policy draft');

  return afterOpen.slice(0, fenceClose).replace(/^\uFEFF/, '').trimEnd();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Turn the plain-text draft into simple semantic HTML.
 * Conventions in LISTING_COPY draft:
 *   line 1 → h1
 *   "Last updated: …" → p.meta
 *   "N. Title" → h2
 *   "• …" → list item
 *   other non-empty lines → paragraphs
 */
function draftToHtml(draft) {
  const lines = draft.replace(/\r\n/g, '\n').split('\n');
  if (!lines.length || !lines[0].trim()) fail('privacy policy draft is empty');

  const parts = [];
  parts.push(`<h1>${escapeHtml(lines[0].trim())}</h1>`);

  let i = 1;
  let listItems = [];

  const flushList = () => {
    if (!listItems.length) return;
    parts.push('<ul>');
    for (const item of listItems) {
      parts.push(`<li>${escapeHtml(item)}</li>`);
    }
    parts.push('</ul>');
    listItems = [];
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    i += 1;

    if (!line) {
      flushList();
      continue;
    }

    if (/^Last updated:/i.test(line)) {
      flushList();
      parts.push(`<p class="meta">${escapeHtml(line)}</p>`);
      continue;
    }

    const section = line.match(/^(\d+)\.\s+(.+)$/);
    if (section) {
      flushList();
      parts.push(`<h2>${escapeHtml(section[1] + '. ' + section[2])}</h2>`);
      continue;
    }

    if (line.startsWith('•') || line.startsWith('- ')) {
      const item = line.replace(/^[•\-]\s*/, '');
      listItems.push(item);
      continue;
    }

    flushList();
    parts.push(`<p>${escapeHtml(line)}</p>`);
  }

  flushList();
  return parts.join('\n    ');
}

function renderPage(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Privacy Policy — Job Tracker</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,500;8..60,600&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --ink: #1a2332;
      --muted: #5c6b7a;
      --line: #d8e0e8;
      --bg: #f7f9fb;
      --paper: #ffffff;
      --accent: #0f6b5c;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "IBM Plex Sans", system-ui, sans-serif;
      font-size: 1.05rem;
      line-height: 1.65;
      color: var(--ink);
      background:
        radial-gradient(1200px 500px at 10% -10%, #e4f0ec 0%, transparent 55%),
        radial-gradient(900px 400px at 100% 0%, #e8eef5 0%, transparent 50%),
        var(--bg);
    }

    main {
      max-width: 40rem;
      margin: 0 auto;
      padding: 3rem 1.25rem 4rem;
    }

    article {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 2.25rem 2rem;
      box-shadow: 0 1px 0 rgba(26, 35, 50, 0.04);
    }

    h1 {
      margin: 0 0 0.35rem;
      font-family: "Source Serif 4", Georgia, serif;
      font-weight: 600;
      font-size: clamp(1.65rem, 4vw, 2.1rem);
      line-height: 1.25;
      letter-spacing: -0.02em;
    }

    .meta {
      margin: 0 0 1.5rem;
      color: var(--muted);
      font-size: 0.95rem;
    }

    h2 {
      margin: 1.75rem 0 0.5rem;
      font-family: "Source Serif 4", Georgia, serif;
      font-weight: 600;
      font-size: 1.15rem;
      color: var(--accent);
    }

    p {
      margin: 0 0 0.85rem;
    }

    ul {
      margin: 0 0 0.85rem;
      padding-left: 1.2rem;
    }

    li {
      margin: 0.25rem 0;
    }

    li::marker {
      color: var(--accent);
    }

    footer {
      margin-top: 1.5rem;
      color: var(--muted);
      font-size: 0.85rem;
    }

    @media (max-width: 520px) {
      article {
        padding: 1.5rem 1.15rem;
        border-radius: 0;
        border-left: none;
        border-right: none;
      }
    }
  </style>
</head>
<body>
  <main>
    <article>
    ${bodyHtml}
    </article>
    <footer>Job Tracker Chrome extension</footer>
  </main>
</body>
</html>
`;
}

const markdown = readFileSync(SOURCE, 'utf8');
const draft = extractDraft(markdown);
const bodyHtml = draftToHtml(draft);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, renderPage(bodyHtml), 'utf8');
console.log(`build-privacy-page: wrote ${OUT_FILE}`);
