# TabKebab — Project Context

## Overview
TabKebab is a Chrome Manifest V3 side-panel extension for tab management. Zero dependencies, zero telemetry, everything local unless the user opts in to AI or Google Drive.

## Repos
- **Extension**: https://github.com/michelabboud/tabkebab-chrome-ext
- **Website**: https://github.com/michelabboud/tabkebab-website

## Extension IDs
- **Published (new)**: `cgfnjdcioainbclbbihglaopbhikhdob` — Chrome Web Store preview, pending full publish
- **Dev/old**: `hkoaofhkpegahjncjckadmhiafnnpgkh` — keep until publish process is complete

## Live URLs
- **Website**: https://tabkebab.com (deployed via Cloudflare Workers, static assets)
- **Chrome Web Store**: https://chromewebstore.google.com/detail/tabkebab/cgfnjdcioainbclbbihglaopbhikhdob
- **Privacy Policy**: https://tabkebab.com/privacy
- **Terms of Service**: https://tabkebab.com/terms

## Architecture
- Manifest V3 with ES modules, no bundler
- Service worker (`service-worker.js`) is the message hub
- Side panel UI in `sidepanel/` — vanilla HTML/CSS/JS, no framework
- Core logic in `core/` — tabs API, sessions, stash (IndexedDB), grouping engine, AI providers, Drive client
- 4-phase grouping engine: snapshot → solver → planner → executor
- AI: 5 providers (OpenAI, Claude, Gemini, Chrome Built-in, Custom), AES-GCM 256-bit encrypted key storage
- Google Drive sync with OAuth2 (`drive.file` scope), profile-scoped folders

## Website (`tabkebab-website` repo)
- Static site: `index.html`, `style.css`, `script.js`, `img/`
- Deployed via Cloudflare Workers with `wrangler.jsonc` (`assets.directory: "."`)
- Reuses extension's CSS design tokens (colors, radii, fonts)
- Guide content pre-rendered from `GUIDE.md`
- Features: dark mode toggle, accordion, lightbox, smooth scroll, mobile hamburger nav

## Key Files
- `manifest.json` — extension manifest
- `service-worker.js` — background script
- `sidepanel/panel.html` — main UI
- `sidepanel/panel.css` — design system / tokens
- `core/` — all business logic
- `GUIDE.md` — full user guide
- `store/listing.txt` — Chrome Web Store copy
- `store/screenshots/` — raw screenshots + `store/` subfolder with high-res store assets

## Design Tokens
- Light: white bg, #111827 text, #2563eb accent
- Dark: #0f0f10 bg, #f3f4f6 text, #3b82f6 accent
- Brand: Red #ef4444, Amber #f59e0b, Teal #14b8a6, Purple #8b5cf6
- Font: 'Segoe UI', system-ui, sans-serif
- Radii: 6px sm, 10px default, 14px lg, 100px pill
