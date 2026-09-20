# Chrome Web Store

Listing assets and publish notes. These files are **not** included in the
extension ZIP — use `npm run pack` for the upload package.

## Package

```bash
npm run pack
```

Creates `dist/job-tracker-<version>.zip` with:

- Runtime folders only (`background`, `connect`, `content`, `icons`, `lib`,
  `options`, `sidepanel`)
- A store `manifest.json` **without** the local `"key"` field
- No `tests/`, `node_modules/`, `.git/`, or promo art

Upload that ZIP in the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).

## Listing assets

Put store-only images here (not in the ZIP):

| File | Use |
|------|-----|
| `promo-marquee.png` | 1400×560 (optional) |
| `promo-small.png` | 440×280 (optional) |
| `screenshot-1.png` … | 1280×800 or 640×400 |
| `logo.png` | Store branding / marketing (same mark as extension icons) |

Store icon: use `icons/icon128.png` (generated from the brand mark).

## Before first publish

1. Bump `version` in `manifest.json` (must increase on every upload).
2. Run `npm test` and `npm run pack`.
3. Copy answers from [`LISTING_COPY.md`](LISTING_COPY.md) into the Privacy practices and Store listing tabs.
4. In Google Cloud Console, set the OAuth client to **Production** (or keep
   Testing with listed testers) and add the **store** extension ID redirect URI
   once Chrome assigns an ID (`https://<EXTENSION_ID>.chromiumapp.org/`).
5. Host a privacy policy URL (draft text is in `LISTING_COPY.md`).
6. Verify publisher contact email under Dashboard → Settings.

## Local vs store ID

`manifest.json` keeps a `"key"` so **Load unpacked** stays on a stable ID.
The pack script strips it for upload. After the first store listing exists, the
dashboard ID is permanent — update your OAuth redirect URI to match.
