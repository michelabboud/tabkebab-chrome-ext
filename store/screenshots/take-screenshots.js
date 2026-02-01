// take-screenshots.js — Playwright script to capture TabKebab store screenshots
// Run: cd /home/michel && DISPLAY=:0 node take-screenshots.js

const { chromium } = require('playwright');
const path = require('path');

const EXTENSION_PATH = '/mnt/c/Users/michel/TabKebab';
const OUTPUT_DIR = path.join(EXTENSION_PATH, 'store', 'screenshots');

const TABS = [
  // AI platforms
  'https://claude.ai',
  'https://chatgpt.com',
  'https://gemini.google.com',
  'https://copilot.microsoft.com',
  'https://docs.anthropic.com/en/docs/welcome',
  'https://platform.openai.com/docs',
  // GitHub repos
  'https://github.com/anthropics/claude-code',
  'https://github.com/anthropics/anthropic-cookbook',
  'https://github.com/anthropics/anthropic-sdk-python',
  'https://github.com/anthropics/courses',
  'https://github.com/microsoft/vscode',
  'https://github.com/nicolo-ribaudo/tc39-proposal-structs',
  'https://github.com/nicolo-ribaudo/tc39-proposal-structs/issues',
  'https://github.com/nicolo-ribaudo/tc39-proposal-structs/pulls',
  // YouTube — official Claude Code / Anthropic videos
  'https://www.youtube.com/watch?v=GFfLCqnNPBo',
  'https://www.youtube.com/watch?v=_RFr9OFRZCU',
  'https://www.youtube.com/watch?v=JGzCkaWpYGk',
  'https://www.youtube.com/@anthropic-ai',
  // Dev tools & docs
  'https://developer.chrome.com/docs/extensions/develop',
  'https://developer.chrome.com/docs/extensions/reference/api/sidePanel',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  'https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API',
  'https://stackoverflow.com/questions/tagged/chrome-extension',
  // News & reference
  'https://news.ycombinator.com',
  'https://www.reddit.com/r/programming',
  'https://en.wikipedia.org/wiki/Kebab',
  'https://en.wikipedia.org/wiki/Browser_extension',
  // Productivity
  'https://calendar.google.com',
  'https://mail.google.com',
  'https://drive.google.com',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function click(page, selector, waitMs = 1500) {
  try {
    await page.click(selector, { timeout: 5000 });
    await sleep(waitMs);
    return true;
  } catch (err) {
    console.log(`  (click ${selector} failed: ${err.message.split('\n')[0]})`);
    return false;
  }
}

// Send a message to the service worker via the panel page's chrome.runtime
async function sendMsg(page, msg) {
  return page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}

async function main() {
  console.log(`Launching Chrome with TabKebab + ${TABS.length} tabs...`);

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
      '--disable-popup-blocking',
    ],
    viewport: null,
  });

  console.log('Waiting for service worker...');
  await sleep(3000);

  // Find extension ID
  let extensionId = null;
  for (let attempt = 0; attempt < 5 && !extensionId; attempt++) {
    for (const sw of context.serviceWorkers()) {
      const match = sw.url().match(/chrome-extension:\/\/([a-z]+)\//);
      if (match) { extensionId = match[1]; break; }
    }
    if (!extensionId) await sleep(2000);
  }
  if (!extensionId) {
    console.error('FATAL: Cannot determine extension ID.');
    await context.close();
    process.exit(1);
  }
  console.log(`Extension ID: ${extensionId}`);

  // Open all mock tabs
  console.log('Opening tabs...');
  for (let i = 0; i < TABS.length; i++) {
    const page = await context.newPage();
    page.goto(TABS[i]).catch(() => {});
    await sleep(300);
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${TABS.length}`);
  }
  console.log('Waiting for pages to load...');
  await sleep(15000);

  // Open panel page
  const panelUrl = `chrome-extension://${extensionId}/sidepanel/panel.html`;
  const p = await context.newPage();
  await p.setViewportSize({ width: 400, height: 800 });
  await p.goto(panelUrl, { waitUntil: 'networkidle' });
  await sleep(3000);

  // ─────────────────────────────────────────────
  // PHASE 1: Save sessions before stashing
  // ─────────────────────────────────────────────
  console.log('Saving sessions...');
  try {
    await sendMsg(p, { action: 'saveSession', name: 'Morning Workflow — AI Research' });
    await sleep(1000);
    await sendMsg(p, { action: 'saveSession', name: 'Claude Code Deep Dive' });
    await sleep(1000);
    await sendMsg(p, { action: 'saveSession', name: 'Weekend Reading List' });
    await sleep(500);
    console.log('  ✓ 3 sessions saved');
  } catch (err) {
    console.log('  (session save failed:', err.message, ')');
  }

  // ─────────────────────────────────────────────
  // PHASE 2: Stash some domains to populate stash
  // ─────────────────────────────────────────────
  console.log('Stashing domains...');
  try {
    await sendMsg(p, { action: 'stashDomain', domain: 'www.youtube.com' });
    await sleep(1000);
    await sendMsg(p, { action: 'stashDomain', domain: 'en.wikipedia.org' });
    await sleep(1000);
    await sendMsg(p, { action: 'stashDomain', domain: 'www.reddit.com' });
    await sleep(500);
    console.log('  ✓ 3 domains stashed');
  } catch (err) {
    console.log('  (stash failed:', err.message, ')');
  }

  // Refresh the panel after stashing (tabs changed)
  await p.goto(panelUrl, { waitUntil: 'networkidle' });
  await sleep(3000);

  // ─────────────────────────────────────────────
  // PHASE 3: Take screenshots
  // ─────────────────────────────────────────────
  console.log('\nTaking screenshots...');

  // 1. Tabs > Domains (default)
  await p.screenshot({ path: path.join(OUTPUT_DIR, '01-tabs-domains.png') });
  console.log('  ✓ 01-tabs-domains.png');

  // 2. Tabs > Groups
  await click(p, '[data-subtab="groups"]');
  await p.screenshot({ path: path.join(OUTPUT_DIR, '02-tabs-groups.png') });
  console.log('  ✓ 02-tabs-groups.png');

  // 3. Windows view
  await click(p, '[data-view="windows"]');
  await p.screenshot({ path: path.join(OUTPUT_DIR, '03-windows.png') });
  console.log('  ✓ 03-windows.png');

  // 4. Stash view (should now have YouTube, Wikipedia, Reddit stashes)
  await click(p, '[data-view="stash"]', 2000);
  await p.screenshot({ path: path.join(OUTPUT_DIR, '04-stash.png') });
  console.log('  ✓ 04-stash.png');

  // 5. Sessions view (should have 3 saved sessions)
  await click(p, '[data-view="sessions"]', 2000);
  await p.screenshot({ path: path.join(OUTPUT_DIR, '05-sessions.png') });
  console.log('  ✓ 05-sessions.png');

  // 6. Settings view
  await click(p, '#btn-settings', 1500);
  await p.screenshot({ path: path.join(OUTPUT_DIR, '06-settings.png') });
  console.log('  ✓ 06-settings.png');

  // 7. Settings — scroll down to show more options
  await p.evaluate(() => {
    const el = document.getElementById('view-settings');
    if (el) el.scrollTop = 400;
  });
  await sleep(500);
  await p.screenshot({ path: path.join(OUTPUT_DIR, '07-settings-more.png') });
  console.log('  ✓ 07-settings-more.png');

  console.log('\nAll screenshots saved to:', OUTPUT_DIR);
  console.log('Closing browser...');
  await context.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
