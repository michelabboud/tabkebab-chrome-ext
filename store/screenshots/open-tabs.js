// open-tabs.js — Launch Chrome with TabKebab + 30 real tabs
// Run: cd /home/michel && DISPLAY=:0 node /mnt/c/Users/michel/TabKebab/store/screenshots/open-tabs.js

const { chromium } = require('playwright');

const EXTENSION_PATH = '/mnt/c/Users/michel/TabKebab';

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
  // Misc productivity
  'https://calendar.google.com',
  'https://mail.google.com',
  'https://drive.google.com',
];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Launching Chrome with TabKebab + ${TABS.length} tabs...`);
  console.log('The browser will stay open — take your screenshots manually.');
  console.log('Press Ctrl+C in the terminal when done.\n');

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
      '--disable-popup-blocking',
      '--start-maximized',
    ],
    viewport: null,
  });

  // Wait for service worker
  await sleep(2000);

  console.log('Opening tabs...');
  for (let i = 0; i < TABS.length; i++) {
    const page = await context.newPage();
    page.goto(TABS[i]).catch(() => {});
    await sleep(300);
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${TABS.length} tabs opened`);
  }

  console.log(`\nAll ${TABS.length} tabs open.`);
  console.log('Open the TabKebab side panel and take screenshots.');
  console.log('Press Ctrl+C when done.\n');

  // Keep the process alive until user kills it
  await new Promise(() => {});
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
