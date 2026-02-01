# Chrome Web Store Screenshot Plan

## Goal
Take 5 screenshots of TabKebab's side panel for the Chrome Web Store listing using Playwright.

## Setup
- WSL with Node.js 20 installed ✅
- Extension path in WSL: `/mnt/c/Users/michel/TabKebab`
- Output directory: `/mnt/c/Users/michel/TabKebab/store/screenshots/`
- Screenshot size: 1280x800 (Chrome Web Store requirement)

## Approach
1. Use Playwright with `chromium.launchPersistentContext` and `--load-extension` to load TabKebab
2. Open real URLs as tabs (GitHub + official Claude Code YouTube videos)
3. Get extension ID from `chrome://extensions` or service worker URL
4. Navigate to `chrome-extension://<id>/sidepanel/panel.html` in a sized viewport
5. Interact with the panel to switch views and take screenshots

## Mock Tabs to Open (real URLs)

### GitHub (work/dev cluster)
- https://github.com/anthropics/claude-code
- https://github.com/anthropics/anthropic-cookbook
- https://github.com/anthropics/courses
- https://github.com/anthropics/anthropic-sdk-python
- https://github.com/microsoft/vscode
- https://github.com/nicolo-ribaudo/tc39-proposal-structs

### YouTube — Official Claude Code content
- https://www.youtube.com/watch?v=GFfLCqnNPBo (Claude Code: Best practices for agentic coding)
- https://www.youtube.com/watch?v=_RFr9OFRZCU (Anthropic — Claude Code overview)
- https://www.youtube.com/watch?v=JGzCkaWpYGk (Claude Code Tips)

### Other tabs for variety
- https://developer.chrome.com/docs/extensions/develop
- https://news.ycombinator.com
- https://docs.anthropic.com/en/docs/welcome
- https://en.wikipedia.org/wiki/Kebab

## Screenshots to Capture (5)

1. **tabs-view.png** — Tabs > All Tabs view showing the full tab list with favicons, stats bar at top
2. **domain-view.png** — Tabs > By Domain view showing tabs grouped by domain
3. **groups-view.png** — Tabs > Groups view showing custom groups and Chrome tab groups
4. **sessions-view.png** — Sessions view showing Saved/Auto sub-tabs
5. **stash-view.png** — Stash view (will be empty but shows the UI) OR Windows view

## Viewport
- Panel rendered at ~400px wide (side panel width) centered in a 1280x800 canvas
- OR render the full Chrome window at 1280x800 with the side panel open
- Since Playwright can't open the actual side panel, we'll render panel.html full-page at 400x800, then composite or just submit 640x400 crops

## Script Location
`/mnt/c/Users/michel/TabKebab/store/screenshots/take-screenshots.js`

## Steps Remaining
- [x] Install Node.js in WSL
- [ ] Install Playwright in WSL (`npm init -y && npm i playwright`)
- [ ] Install Chromium browser for Playwright (`npx playwright install chromium`)
- [ ] Write the screenshot script
- [ ] Run it and verify output
- [ ] Check screenshots look good

## Notes
- The panel.html page relies on `chrome.runtime.sendMessage` to talk to the service worker
- With `--load-extension`, the service worker WILL be running, so tab data will be real
- We need to wait for tabs to finish loading before taking screenshots
- Sessions/stash will be empty (fresh profile) — we can save a session via the UI before screenshotting
