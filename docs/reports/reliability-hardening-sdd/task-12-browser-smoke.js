import { chromium } from 'playwright';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromeBinary = '/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const extensionPath = '/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening';
const expectedChromeVersion = 'Google Chrome for Testing 148.0.7778.96';
const expectedChromeSha256 = 'adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f';
const displayNumber = 102;
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runChecked(command, options = {}) {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', ...options });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed with exit ${result.exitCode}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function computeWorktreeTree() {
  const indexDirectory = await mkdtemp(join(tmpdir(), 'tabkebab-task12-index.'));
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

async function matchingProfileProcesses(profile) {
  const result = Bun.spawnSync(['pgrep', '-af', profile], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode === 1) return 0;
  if (result.exitCode !== 0) throw new Error('Could not inspect disposable Chrome processes');
  const output = new TextDecoder().decode(result.stdout).trim();
  return output ? output.split('\n').length : 0;
}

async function launchProfile(profile, display, observations, secrets) {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromeBinary,
    headless: false,
    viewport: { width: 1280, height: 900 },
    env: { ...process.env, DISPLAY: display },
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

  context.on('console', (message) => observations.logs.push(message.text()));
  context.on('weberror', (error) => observations.errors.push(error.message));
  await context.route(/https?:\/\/.*/, async (route) => {
    const request = route.request();
    const url = request.url();
    const body = request.postData() || '';
    const headers = request.headers();
    const isProviderTest = url === 'https://api.openai.com/v1/chat/completions';
    const secretInUrlOrBody = secrets.some((secret) => url.includes(secret) || body.includes(secret));
    if (secretInUrlOrBody) observations.secretInNetworkPayload = true;

    if (isProviderTest) {
      observations.providerRequests += 1;
      observations.providerAuthorizationMatched =
        headers.authorization === `Bearer ${secrets[0]}`;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      });
      return;
    }

    observations.otherExternalRequests += 1;
    await route.abort('blockedbyclient');
  });

  const worker = await waitFor(
    () => context.serviceWorkers().find((candidate) =>
      candidate.url().startsWith('chrome-extension://') &&
      candidate.url().endsWith('/service-worker.js')),
    'TabKebab service worker',
  );
  return { context, extensionId: new URL(worker.url()).hostname };
}

const testedTree = await computeWorktreeTree();
const requestedTree = process.env.TASK12_TREE_HASH;
if (requestedTree && requestedTree !== testedTree) {
  throw new Error('TASK12_TREE_HASH does not match the exact current worktree tree');
}

const chromeVersion = runChecked([chromeBinary, '--version']);
const chromeSha256 = runChecked(['sha256sum', chromeBinary]).split(/\s+/)[0];
assert(chromeVersion === expectedChromeVersion, 'Chrome fixture version mismatch');
assert(chromeSha256 === expectedChromeSha256, 'Chrome fixture hash mismatch');

const profile = await mkdtemp(join(tmpdir(), 'tabkebab-task12-browser.'));
const key = `task12-key-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const passphrase = `task12-pass-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const wrongPassphrase = `task12-wrong-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const secrets = [key, passphrase, wrongPassphrase];
const observations = {
  logs: [],
  errors: [],
  providerRequests: 0,
  providerAuthorizationMatched: false,
  otherExternalRequests: 0,
  secretInNetworkPayload: false,
};
let xvfb;
let firstContext;
let secondContext;
let profileEntries = 0;
let firstExitProcesses = -1;
let extensionId;

try {
  xvfb = Bun.spawn([
    'Xvfb', `:${displayNumber}`, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-ac',
  ], { stdout: 'ignore', stderr: 'ignore' });
  await delay(500);
  assert(xvfb.exitCode === null, 'Xvfb exited before Chrome launch');
  const display = `:${displayNumber}`;

  ({ context: firstContext, extensionId } = await launchProfile(
    profile,
    display,
    observations,
    secrets,
  ));
  const firstPage = await firstContext.newPage();
  await firstPage.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`, {
    waitUntil: 'load',
  });
  await firstPage.locator('#btn-settings').click();
  await firstPage.locator('#view-settings:not(.hidden)').waitFor();
  await firstPage.locator('#ai-enabled').check();
  await firstPage.locator('#ai-provider').selectOption('openai');
  await firstPage.locator('#openai-api-key').fill(key);
  await firstPage.locator('#ai-passphrase-enabled').check();
  await firstPage.locator('#ai-passphrase').fill(passphrase);
  await firstPage.locator('#btn-save-ai').click();
  await firstPage.waitForFunction(() =>
    Array.from(document.querySelectorAll('.toast.success span'))
      .some((node) => node.textContent === 'AI settings saved'));

  const saved = await firstPage.evaluate(async ([keyValue, passphraseValue]) => {
    const local = await chrome.storage.local.get(['aiSettings', 'installId']);
    const session = await chrome.storage.session.get(null);
    const publicSettings = await chrome.runtime.sendMessage({ action: 'getAISettings' });
    const serializedLocal = JSON.stringify(local.aiSettings);
    const serializedPublic = JSON.stringify(publicSettings);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(serializedLocal),
    );
    const blobHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return {
      blobHash,
      localHasCiphertext: typeof local.aiSettings?.providerConfigs?.openai?.apiKey?.ciphertext === 'string',
      localHasPlaintext: serializedLocal.includes(keyValue) || serializedLocal.includes(passphraseValue),
      installIdPresent: typeof local.installId === 'string',
      sessionHasPlaintext: JSON.stringify(session).includes(keyValue),
      publicHasPrivateMaterial: serializedPublic.includes(keyValue) ||
        serializedPublic.includes(passphraseValue) ||
        serializedPublic.includes('ciphertext') || serializedPublic.includes('apiKey'),
      available: (await chrome.runtime.sendMessage({ action: 'isAIAvailable' })).available,
    };
  }, [key, passphrase]);
  assert(saved.localHasCiphertext, 'Passphrase save did not persist ciphertext');
  assert(!saved.localHasPlaintext, 'Passphrase save persisted plaintext locally');
  assert(!saved.installIdPresent, 'Passphrase-only save unexpectedly provisioned an install ID');
  assert(saved.sessionHasPlaintext, 'Passphrase save did not establish the session cache');
  assert(!saved.publicHasPrivateMaterial, 'Public settings exposed private material');
  assert(saved.available, 'Saved provider was not available before restart');

  await firstContext.close();
  firstContext = null;
  await waitFor(async () => (await matchingProfileProcesses(profile)) === 0,
    'first Chrome process exit');
  firstExitProcesses = await matchingProfileProcesses(profile);

  let secondExtensionId;
  ({ context: secondContext, extensionId: secondExtensionId } = await launchProfile(
    profile,
    display,
    observations,
    secrets,
  ));
  assert(secondExtensionId === extensionId, 'Extension identity changed across profile restart');
  const secondPage = await secondContext.newPage();
  await secondPage.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`, {
    waitUntil: 'load',
  });
  await secondPage.locator('#btn-settings').click();
  await secondPage.locator('#view-settings:not(.hidden)').waitFor();
  await secondPage.locator('#ai-unlock-section:not([hidden])').waitFor();

  const restarted = await secondPage.evaluate(async ([keyValue, passphraseValue, expectedHash]) => {
    const local = await chrome.storage.local.get('aiSettings');
    const session = await chrome.storage.session.get(null);
    const publicSettings = await chrome.runtime.sendMessage({ action: 'getAISettings' });
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(local.aiSettings)),
    );
    const blobHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const publicText = JSON.stringify(publicSettings);
    return {
      blobUnchanged: blobHash === expectedHash,
      sessionEmpty: Object.keys(session).filter((name) => name.startsWith('aiDecryptedKey_')).length === 0,
      publicHasPrivateMaterial: publicText.includes(keyValue) ||
        publicText.includes(passphraseValue) || publicText.includes('ciphertext') ||
        publicText.includes('apiKey'),
      needsPassphrase: (await chrome.runtime.sendMessage({
        action: 'needsAIPassphrase', providerId: 'openai',
      })).needsPassphrase,
      available: (await chrome.runtime.sendMessage({ action: 'isAIAvailable' })).available,
    };
  }, [key, passphrase, saved.blobHash]);
  assert(restarted.blobUnchanged, 'Encrypted settings changed across browser restart');
  assert(restarted.sessionEmpty, 'Session key survived a complete browser restart');
  assert(!restarted.publicHasPrivateMaterial, 'Restart public projection exposed private material');
  assert(restarted.needsPassphrase, 'Restart did not require the provider passphrase');
  assert(!restarted.available, 'Locked provider remained available after restart');

  await secondPage.locator('#ai-unlock-passphrase').fill(wrongPassphrase);
  await secondPage.locator('#btn-unlock-ai').click();
  await secondPage.waitForFunction(() =>
    document.querySelector('#ai-unlock-result')?.textContent === 'Incorrect passphrase.');
  const wrong = await secondPage.evaluate(async () => ({
    cachePresent: Object.hasOwn(
      await chrome.storage.session.get('aiDecryptedKey_openai'),
      'aiDecryptedKey_openai',
    ),
    available: (await chrome.runtime.sendMessage({ action: 'isAIAvailable' })).available,
  }));
  assert(!wrong.cachePresent && !wrong.available, 'Wrong passphrase changed provider authority');

  await secondPage.locator('#ai-unlock-passphrase').fill(passphrase);
  await secondPage.locator('#btn-unlock-ai').click();
  await secondPage.waitForFunction(() =>
    document.querySelector('#ai-unlock-result')?.textContent === 'Provider unlocked.' &&
    document.querySelector('#ai-unlock-result')?.hidden === false &&
    document.querySelector('#ai-unlock-section')?.hidden === true &&
    document.querySelector('#btn-ai-status')?.classList.contains('connected') &&
    document.querySelector('#command-bar')?.hidden === false);

  await secondPage.evaluate(() => {
    window.__task12RuntimeRequests = [];
    const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message) => {
      if (message?.action) {
        window.__task12RuntimeRequests.push({
          action: message.action,
          keys: Object.keys(message).sort(),
        });
      }
      return originalSend(message);
    };
  });
  await secondPage.locator('#btn-test-ai').click();
  await secondPage.waitForFunction(() =>
    document.querySelector('#ai-test-result')?.textContent === 'Connection successful!');
  const unlocked = await secondPage.evaluate(async () => {
    const runtimeRequests = window.__task12RuntimeRequests || [];
    const providerRequests = runtimeRequests.filter(({ action }) =>
      action === 'testAIConnection');
    const cache = await chrome.storage.session.get('aiDecryptedKey_openai');
    return {
      available: (await chrome.runtime.sendMessage({ action: 'isAIAvailable' })).available,
      providerRequests,
      cachePresent: Object.hasOwn(cache, 'aiDecryptedKey_openai'),
      unlockVisible: document.querySelector('#ai-unlock-section')?.hidden === false,
      successVisible: document.querySelector('#ai-unlock-result')?.hidden === false &&
        document.querySelector('#ai-unlock-result')?.textContent === 'Provider unlocked.',
    };
  });
  assert(unlocked.available && unlocked.cachePresent, 'Correct unlock did not restore authority');
  assert(!unlocked.unlockVisible && unlocked.successVisible, 'Unlock UI did not retain safe success state');
  assert(unlocked.providerRequests.length === 1, 'UI did not send exactly one provider-test action');
  assert(JSON.stringify(unlocked.providerRequests[0].keys) ===
    JSON.stringify(['action', 'providerId']), 'Provider-test runtime request carried private fields');
  assert(observations.providerRequests === 1, 'Expected exactly one intercepted provider request');
  assert(observations.providerAuthorizationMatched, 'Provider request did not use the unlocked key');
  assert(!observations.secretInNetworkPayload, 'A credential entered a provider URL or request body');

  const logText = [...observations.logs, ...observations.errors].join('\n');
  assert(!secrets.some((secret) => logText.includes(secret)), 'A credential appeared in browser logs');
  assert(observations.errors.length === 0, 'The panel or worker reported a runtime error');
  assert(observations.otherExternalRequests === 0, 'Unexpected external requests were observed');

  await secondPage.evaluate(async () => {
    await chrome.storage.session.clear();
    await chrome.storage.local.clear();
  });
  profileEntries = await countEntries(profile);

  console.log(JSON.stringify({
    testedTree,
    chromeVersion,
    chromeSha256,
    extensionId,
    fullExitBeforeRelaunch: firstExitProcesses === 0,
    encryptedBlobUnchanged: restarted.blobUnchanged,
    localPlaintextAbsent: !saved.localHasPlaintext,
    installIdAbsentForPassphraseOnly: !saved.installIdPresent,
    restartSessionEmpty: restarted.sessionEmpty,
    restartLocked: restarted.needsPassphrase && !restarted.available,
    wrongPassphraseRejected: !wrong.cachePresent && !wrong.available,
    correctPassphraseUnlocked: unlocked.cachePresent && unlocked.available,
    unlockSuccessVisible: unlocked.successVisible,
    providerRuntimeFieldsExact: JSON.stringify(unlocked.providerRequests[0].keys) ===
      JSON.stringify(['action', 'providerId']),
    providerRequests: observations.providerRequests,
    authorizationMatched: observations.providerAuthorizationMatched,
    credentialAbsentFromUrlBodyLogs: !observations.secretInNetworkPayload &&
      !secrets.some((secret) => logText.includes(secret)),
    otherExternalRequests: observations.otherExternalRequests,
    runtimeErrors: observations.errors.length,
    profileEntriesBeforeCleanup: profileEntries,
  }, null, 2));
} finally {
  await firstContext?.close().catch(() => {});
  await secondContext?.close().catch(() => {});
  if (xvfb) {
    try { xvfb.kill('SIGTERM'); } catch {}
    await Promise.race([xvfb.exited.catch(() => {}), delay(2_000)]);
    try { xvfb.kill('SIGKILL'); } catch {}
    await xvfb.exited.catch(() => {});
  }
  await rm(profile, { recursive: true, force: true });
  const profileRemoved = await stat(profile).then(() => false).catch(() => true);
  const remainingProcesses = await matchingProfileProcesses(profile).catch(() => -1);
  if (profileRemoved === false || remainingProcesses !== 0) {
    throw new Error('Task 12 browser fixture cleanup failed');
  }
}
