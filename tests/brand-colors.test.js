import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const tokensCss = read('lib/tokens.css');

/** Token map from a CSS block body. */
function parseVars(body) {
  const out = {};
  for (const m of body.matchAll(/(--jt-[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const lightBody = tokensCss.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
const darkBody = tokensCss.match(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?\{([\s\S]*?)\n  \}/)[1];
const light = parseVars(lightBody);
const dark = { ...light, ...parseVars(darkBody) };

function resolve(vars, name, depth = 0) {
  let v = vars[name];
  const ref = v && v.match(/^var\((--jt-[\w-]+)\)$/);
  if (ref && depth < 5) v = resolve(vars, ref[1], depth + 1);
  return v;
}

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const PAIRS = [
  ['--jt-on-primary', '--jt-primary'],
  ['--jt-primary-text', '--jt-card'],
  ['--jt-primary-text', '--jt-bg'],
  ['--jt-primary-text', '--jt-primary-soft'],
  ['--jt-text', '--jt-card'],
  ['--jt-text', '--jt-bg'],
  ['--jt-text', '--jt-sunken'],
  ['--jt-muted', '--jt-card'],
  ['--jt-muted', '--jt-bg'],
  ['--jt-muted', '--jt-sunken'],
  ['--jt-danger-fg', '--jt-danger-bg'],
  ['--jt-success-fg', '--jt-success-bg'],
  ['--jt-warning-fg', '--jt-warning-bg'],
  ['--jt-info-fg', '--jt-info-bg'],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('tokens.css WCAG AA (%s)', (_name, vars) => {
  test.each(PAIRS)('%s on %s >= 4.5:1', (fg, bg) => {
    const f = resolve(vars, fg);
    const b = resolve(vars, bg);
    expect(f).toMatch(/^#[0-9a-f]{6}$/i);
    expect(b).toMatch(/^#[0-9a-f]{6}$/i);
    expect({ fg, bg, ratio: contrast(f, b) >= 4.5 }).toEqual({ fg, bg, ratio: true });
  });
});

describe('floating launcher stays in sync with tokens.css', () => {
  const css = read('content/floating-panel.css').toLowerCase();
  const js = read('content/content.js').toLowerCase();
  const expected = {
    '--jt-primary': light['--jt-primary'],
    '--jt-primary-soft': light['--jt-primary-soft'],
    '--jt-primary-soft-border': light['--jt-primary-soft-border'],
    '--jt-border': light['--jt-border'],
    '--jt-text': light['--jt-text'],
    '--jt-muted': light['--jt-muted'],
    '--jt-sunken': light['--jt-sunken'],
    '--jt-card': light['--jt-card'],
  };

  test('floating-panel.css uses the token hex values', () => {
    for (const k of ['--jt-primary', '--jt-primary-soft', '--jt-border', '--jt-text', '--jt-muted', '--jt-sunken']) {
      expect({ k, found: css.includes(expected[k].toLowerCase()) }).toEqual({ k, found: true });
    }
  });

  test('content.js launcher fallbacks use the token hex values', () => {
    for (const k of ['--jt-primary-soft-border', '--jt-border', '--jt-text', '--jt-muted', '--jt-card']) {
      expect({ k, found: js.includes(expected[k].toLowerCase()) }).toEqual({ k, found: true });
    }
  });

  test('every hex in the launcher CSS and content.js style block is a known token value', () => {
    const known = new Set(
      Object.values(light)
        .concat(Object.values(dark))
        .filter((v) => /^#[0-9a-f]{3,6}$/i.test(v))
        .map((v) => v.toLowerCase())
    );
    known.add('#fff');
    const styleBlock = js.slice(js.indexOf('jt-launcher-btn') - 400, js.indexOf('jt-launcher-dismiss') + 600);
    const hexes = [...(css + styleBlock).matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/g)].map((m) => m[0]);
    expect(hexes.filter((h) => !known.has(h))).toEqual([]);
  });
});
