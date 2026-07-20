import { chromium } from 'playwright';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromeBinary = '/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const extensionPath = '/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening';
const expectedChromeVersion = 'Google Chrome for Testing 148.0.7778.96';
const expectedChromeSha256 = 'adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f';
const displayNumber = 101;
const timeoutMs = 20_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(operation, description, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function runChecked(command, options = {}) {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', ...options });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${command[0]} failed with exit ${result.exitCode}${stderr ? `: ${stderr}` : ''}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function computeWorktreeTree() {
  const indexDirectory = await mkdtemp(join(tmpdir(), 'tabkebab-task11-index.'));
  const indexFile = join(indexDirectory, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    runChecked(['git', 'read-tree', 'HEAD'], { cwd: extensionPath, env });
    runChecked(['git', 'add', '-A', '--', '.'], { cwd: extensionPath, env });
    return runChecked(['git', 'write-tree'], { cwd: extensionPath, env });
  } finally {
    await rm(indexDirectory, { recursive: true, force: true });
  }
}

async function countEntries(path) {
  let count = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    count += 1;
    if (entry.isDirectory()) count += await countEntries(join(path, entry.name));
  }
  return count;
}

async function stopProcess(processHandle) {
  if (!processHandle) return;
  try { processHandle.kill('SIGTERM'); } catch {}
  await Promise.race([processHandle.exited.catch(() => {}), delay(2_000)]);
  try { processHandle.kill('SIGKILL'); } catch {}
  await processHandle.exited.catch(() => {});
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const testedTree = await computeWorktreeTree();
const requestedTree = process.env.TASK11_TREE_HASH;
if (requestedTree && requestedTree !== testedTree) {
  throw new Error('TASK11_TREE_HASH does not match the exact current worktree tree');
}

const chromeVersion = runChecked([chromeBinary, '--version']);
const chromeSha256 = runChecked(['sha256sum', chromeBinary]).split(/\s+/)[0];
if (chromeVersion !== expectedChromeVersion || chromeSha256 !== expectedChromeSha256) {
  throw new Error('Installed Chrome for Testing build/hash does not match the approved fixture');
}

const profile = await mkdtemp(join(tmpdir(), 'tabkebab-task11-browser.'));
let xvfb;
let context;
let profileEntries = 0;
let interceptedExternalRequests = 0;
let extensionId = null;
const pageErrors = [];
const processErrors = [];

try {
  xvfb = Bun.spawn([
    'Xvfb', `:${displayNumber}`, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-ac',
  ], { stdout: 'ignore', stderr: 'pipe' });
  void (async () => {
    for await (const chunk of xvfb.stderr) processErrors.push(new TextDecoder().decode(chunk));
  })();
  await delay(500);
  if (xvfb.exitCode !== null && xvfb.exitCode !== undefined) {
    throw new Error('Xvfb exited before Chrome launch');
  }

  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromeBinary,
    headless: false,
    viewport: { width: 1280, height: 900 },
    env: { ...process.env, DISPLAY: `:${displayNumber}` },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    ],
  });

  await context.route('http://**/*', async (route) => {
    interceptedExternalRequests += 1;
    await route.abort('blockedbyclient');
  });
  await context.route('https://**/*', async (route) => {
    interceptedExternalRequests += 1;
    await route.abort('blockedbyclient');
  });

  const worker = await waitFor(
    () => context.serviceWorkers().find((candidate) =>
      candidate.url().startsWith('chrome-extension://') &&
      candidate.url().endsWith('/service-worker.js')),
    'TabKebab service worker',
  );
  extensionId = new URL(worker.url()).hostname;

  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__task11Unhandled = [];
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      window.__task11Unhandled.push(reason?.message || String(reason));
    });
  });
  await page.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`, { waitUntil: 'load' });

  const seeded = await page.evaluate(async () => {
    const openStashDb = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('TabKebabStash', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('stashes')) {
          const store = db.createObjectStore('stashes', { keyPath: 'id' });
          store.createIndex('by-createdAt', 'createdAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tabFixture = { title: 'Task 11 archived tab', url: 'https://archive.invalid/item' };
    const stash = {
      id: 'task11-stash',
      name: 'Task 11 Stash',
      createdAt: 2_000,
      tabCount: 1,
      windows: [{ tabCount: 1, tabs: [tabFixture] }],
    };
    const session = {
      id: 'task11-session',
      name: 'Task 11 Session',
      version: 2,
      createdAt: 1_000,
      modifiedAt: 1_000,
      windows: [{ tabCount: 1, tabs: [tabFixture] }],
    };

    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      sessions: [session],
      driveSync: { connected: true, lastSync: 1234 },
      tabkebabSettings: { neverDeleteFromDrive: false, driveRetentionDays: 30 },
    });
    await chrome.storage.local.remove('driveProfileName');

    const db = await openStashDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('stashes', 'readwrite');
      const store = tx.objectStore('stashes');
      store.clear();
      store.put(stash);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const createdTabs = [];
    for (const url of [
      'https://alpha.invalid/first',
      'https://alpha.invalid/second',
      'https://beta.invalid/only',
    ]) {
      const tab = await chrome.tabs.create({ url, active: false });
      createdTabs.push({ id: tab.id, url });
    }
    return { createdTabs, stashCount: 1, sessionCount: 1 };
  });
  assert(seeded.createdTabs.length === 3, 'Synthetic tab seeding did not complete');

  await page.reload({ waitUntil: 'load' });
  await page.locator('#btn-settings').click();
  await page.locator('#view-settings:not(.hidden)').waitFor();
  await page.waitForFunction(() => {
    return document.querySelector('#drive-settings-connected')?.hidden === false;
  });

  const failureBefore = await page.evaluate(async () => {
    document.getElementById('toast-container').replaceChildren();
    const state = await chrome.storage.local.get([
      'driveSync', 'tabkebabSettings', 'driveProfileName',
    ]);
    return {
      driveSync: state.driveSync,
      settings: state.tabkebabSettings,
      profilePresent: Object.hasOwn(state, 'driveProfileName'),
      days: document.querySelector('#drive-cleanup-days').value,
    };
  });
  assert(failureBefore.profilePresent === false, 'Failure fixture unexpectedly had a Drive profile');

  await page.locator('#btn-clean-drive').click();
  await page.locator('#confirm-overlay .action-btn.danger').click();
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('.toast.error span'))
      .some((node) => node.textContent === 'Cleanup failed: Drive cleanup failed');
  });
  await delay(250);

  const failureAfter = await page.evaluate(async () => {
    const state = await chrome.storage.local.get([
      'driveSync', 'tabkebabSettings', 'driveProfileName',
    ]);
    return {
      errorTexts: Array.from(document.querySelectorAll('.toast.error span'))
        .map((node) => node.textContent),
      successTexts: Array.from(document.querySelectorAll('.toast.success span'))
        .map((node) => node.textContent),
      unhandled: [...window.__task11Unhandled],
      buttonText: document.querySelector('#btn-clean-drive').textContent,
      buttonDisabled: document.querySelector('#btn-clean-drive').disabled,
      confirmHidden: document.querySelector('#confirm-overlay').hidden,
      driveSync: state.driveSync,
      settings: state.tabkebabSettings,
      profilePresent: Object.hasOwn(state, 'driveProfileName'),
      days: document.querySelector('#drive-cleanup-days').value,
    };
  });
  assert(failureAfter.errorTexts.length === 1, 'Cleanup failure did not render exactly one error toast');
  assert(failureAfter.errorTexts[0] === 'Cleanup failed: Drive cleanup failed', 'Cleanup failure toast was not the safe message');
  assert(failureAfter.successTexts.length === 0, 'Cleanup failure rendered a success toast');
  assert(failureAfter.unhandled.length === 0, 'Cleanup failure produced an unhandled rejection');
  assert(pageErrors.length === 0, 'Panel produced a page error during the checked failure path');
  assert(failureAfter.buttonText === 'Clean Drive Files' && failureAfter.buttonDisabled === false,
    'Cleanup button did not return to its committed state');
  assert(failureAfter.confirmHidden === true, 'Cleanup confirmation did not close');
  assert(JSON.stringify(failureAfter.driveSync) === JSON.stringify(failureBefore.driveSync) &&
    JSON.stringify(failureAfter.settings) === JSON.stringify(failureBefore.settings) &&
    failureAfter.profilePresent === failureBefore.profilePresent &&
    failureAfter.days === failureBefore.days,
  'Cleanup failure optimistically mutated panel or storage state');

  const grouped = await page.evaluate(async () => {
    return chrome.runtime.sendMessage({ action: 'getGroupedTabs' });
  });
  assert(Array.isArray(grouped), 'Worker grouped-tab response was not an array');
  const groupedSynthetic = grouped
    .filter((group) => group.domain === 'alpha.invalid' || group.domain === 'beta.invalid')
    .map((group) => ({ label: group.domain === 'alpha.invalid' ? 'synthetic-alpha' : 'synthetic-beta', count: group.tabs.length }));
  assert(JSON.stringify(groupedSynthetic) === JSON.stringify([
    { label: 'synthetic-alpha', count: 2 },
    { label: 'synthetic-beta', count: 1 },
  ]), 'Worker did not return the expected synthetic grouped order');

  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
  });
  await page.locator('#search-overlay').waitFor();
  await page.waitForFunction(() => {
    const types = Array.from(document.querySelectorAll('#search-overlay .search-item'))
      .map((node) => node.dataset.type);
    return types.includes('tab') && types.includes('stash') && types.includes('session');
  });

  const search = await page.evaluate((createdTabs) => {
    const items = Array.from(document.querySelectorAll('#search-overlay .search-item'));
    const syntheticIds = new Set(createdTabs.map((tab) => String(tab.id)));
    const openTabIds = items
      .filter((node) => node.dataset.type === 'tab')
      .map((node) => node.dataset.tabId);
    const syntheticOrder = openTabIds.filter((id) => syntheticIds.has(id));
    const expectedOrder = createdTabs.map((tab) => String(tab.id));
    const sections = Array.from(document.querySelectorAll('.search-section-header'))
      .map((node) => ({ label: node.firstElementChild?.textContent, count: Number(node.lastElementChild?.textContent) }));
    return {
      sections,
      syntheticOrderMatches: JSON.stringify(syntheticOrder) === JSON.stringify(expectedOrder),
      stashPresent: items.some((node) => node.dataset.type === 'stash' &&
        node.querySelector('.search-item-title')?.textContent === 'Task 11 Stash'),
      sessionPresent: items.some((node) => node.dataset.type === 'session' &&
        node.querySelector('.search-item-title')?.textContent === 'Task 11 Session'),
      unavailableVisible: Array.from(document.querySelectorAll('.search-empty[role="alert"]'))
        .some((node) => node.textContent === 'Search unavailable — try again.'),
    };
  }, seeded.createdTabs);
  assert(search.syntheticOrderMatches, 'Global search did not preserve grouped synthetic tab order');
  assert(search.stashPresent && search.sessionPresent, 'Global search omitted the synthetic stash or session');
  assert(search.unavailableVisible === false, 'Valid grouped data rendered the unavailable state');

  await page.locator('#search-overlay .search-input').fill('Task 11 archived tab');
  await page.waitForFunction(() => {
    const types = Array.from(document.querySelectorAll('#search-overlay .search-item'))
      .map((node) => node.dataset.type);
    return types.includes('stash') && types.includes('session');
  });
  const nestedSavedMatch = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#search-overlay .search-item'));
    return {
      stash: items.some((node) => node.dataset.type === 'stash' &&
        node.querySelector('.search-item-title')?.textContent === 'Task 11 Stash'),
      session: items.some((node) => node.dataset.type === 'session' &&
        node.querySelector('.search-item-title')?.textContent === 'Task 11 Session'),
    };
  });
  assert(nestedSavedMatch.stash && nestedSavedMatch.session,
    'Global search did not match current nested stash/session tabs');

  await page.locator('#search-overlay .search-input').fill('task11-no-match-sentinel');
  await page.waitForFunction(() => {
    return document.querySelector('#search-overlay .search-empty')?.textContent === 'No results found';
  });
  const emptyState = await page.evaluate(() => {
    const node = document.querySelector('#search-overlay .search-empty');
    return {
      text: node?.textContent,
      alertRole: node?.getAttribute('role'),
      unavailableVisible: Array.from(document.querySelectorAll('.search-empty[role="alert"]'))
        .some((entry) => entry.textContent === 'Search unavailable — try again.'),
    };
  });
  assert(emptyState.text === 'No results found' && emptyState.alertRole === null && emptyState.unavailableVisible === false,
    'Valid no-match state was not distinct from search unavailable');

  profileEntries = await countEntries(profile);
  const finalTree = await computeWorktreeTree();
  assert(finalTree === testedTree, 'Tracked worktree content changed during the browser smoke');

  console.log(JSON.stringify({
    browser: chromeVersion,
    binarySha256: chromeSha256,
    testedTree,
    extensionId,
    boundary: 'Real unpacked extension, production service worker, side-panel settings cleanup UI, Ctrl+K global-search UI, chrome.tabs, chrome.storage.local, and IndexedDB',
    checkedFailure: {
      workerResponseChecked: true,
      safeFailureToastCount: failureAfter.errorTexts.length,
      safeFailureText: failureAfter.errorTexts[0],
      successToastCount: failureAfter.successTexts.length,
      optimisticMutationCount: 0,
      unhandledRejectionCount: failureAfter.unhandled.length,
      panelPageErrorCount: pageErrors.length,
      controlsRestored: failureAfter.buttonText === 'Clean Drive Files' && failureAfter.buttonDisabled === false,
    },
    groupedSearch: {
      groupedSynthetic,
      resultSections: search.sections,
      syntheticGroupedOrderPreserved: search.syntheticOrderMatches,
      stashPresent: search.stashPresent,
      sessionPresent: search.sessionPresent,
      nestedSavedMatch,
      validNoMatchText: emptyState.text,
      unavailableAlertVisibleForValidData: emptyState.unavailableVisible,
    },
    network: {
      policy: 'All context HTTP(S) requests aborted before network; host resolver also maps non-local hosts to NOTFOUND',
      interceptedBeforeNetwork: interceptedExternalRequests,
      externalRequestsReachedNetwork: 0,
    },
    exposedEvidence: 'Only synthetic labels, counts, booleans, safe UI text, build/hash, tree hash, and generated extension ID; no token, private URL, storage payload, or credential',
    profileEntriesBeforeCleanup: profileEntries,
  }, null, 2));
} catch (error) {
  console.error(error.stack || error);
  console.error(`PROCESS_ERROR_CHUNKS=${processErrors.length}`);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  const pkill = Bun.spawn(['pkill', '-TERM', '-f', profile], { stdout: 'ignore', stderr: 'ignore' });
  await pkill.exited.catch(() => {});
  await stopProcess(xvfb);
  await rm(profile, { recursive: true, force: true });
  let profileRemoved = false;
  try { await stat(profile); } catch { profileRemoved = true; }
  const remainingChromeProcesses = Bun.spawnSync(['pgrep', '-f', profile], {
    stdout: 'pipe', stderr: 'ignore',
  }).exitCode === 0 ? 1 : 0;
  console.log(`CLEANUP_PROFILE_REMOVED=${profileRemoved ? 1 : 0}`);
  console.log(`CLEANUP_CHROME_PROCESS_COUNT=${remainingChromeProcesses}`);
  console.log(`CLEANUP_XVFB_PROCESS_EXITED=${xvfb ? Number((await xvfb.exited) !== null) : 1}`);
}
