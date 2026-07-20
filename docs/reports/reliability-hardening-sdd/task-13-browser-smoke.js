import { chromium } from 'playwright';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromeBinary = '/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const extensionPath = '/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening';
const fixturePath = join(extensionPath, 'tests/fixtures/hanging-ai-server.js');
const expectedChromeVersion = 'Google Chrome for Testing 148.0.7778.96';
const expectedChromeSha256 = 'adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f';
const displayNumber = 104;
const shortTimeoutMs = 20_000;
const providerTimeoutFloorMs = 118_000;
const providerTimeoutCeilingMs = 140_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(operation, description, timeoutMs = shortTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function runChecked(command, options = {}) {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', ...options });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed with exit ${result.exitCode}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function computeWorktreeTree() {
  const indexDirectory = await mkdtemp(join(tmpdir(), 'tabkebab-task13-index.'));
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

async function readFirstJsonLine(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Hanging fixture exited before its ready line');
      buffered += decoder.decode(value, { stream: true });
      const newline = buffered.indexOf('\n');
      if (newline >= 0) return JSON.parse(buffered.slice(0, newline));
    }
  } finally {
    reader.releaseLock();
  }
}

async function startFixture(captureProcess) {
  const process = Bun.spawn(['bun', fixturePath], {
    cwd: extensionPath,
    env: { ...Bun.env, TABKEBAB_HANG_PORT: '0' },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  captureProcess(process);
  const ready = await Promise.race([
    readFirstJsonLine(process.stdout),
    delay(5_000).then(() => {
      throw new Error('Timed out waiting for hanging fixture readiness');
    }),
  ]);
  assert(ready?.ready === true, 'Hanging fixture returned an invalid ready envelope');
  assert(typeof ready.baseUrl === 'string', 'Hanging fixture omitted its base URL');
  assert(typeof ready.metricsUrl === 'string', 'Hanging fixture omitted its metrics URL');
  return { process, ...ready };
}

async function readMetrics(metricsUrl) {
  const response = await fetch(metricsUrl, { cache: 'no-store' });
  assert(response.ok, 'Could not read hanging fixture metrics');
  const metrics = await response.json();
  for (const name of [
    'requestStarts',
    'connectionAborts',
    'completedRequests',
    'activeRequests',
    'maxActiveRequests',
  ]) {
    assert(Number.isSafeInteger(metrics[name]) && metrics[name] >= 0,
      `Hanging fixture returned invalid ${name}`);
  }
  return metrics;
}

async function launchProfile(profile, display, baseUrl, observations, captureContext) {
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
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    ],
  });
  captureContext(context);

  context.on('console', (message) => observations.logs.push(message.text()));
  context.on('weberror', (webError) => observations.errors.push(webError.error().message));
  const fixtureOrigin = new URL(baseUrl).origin;
  await context.route(/https?:\/\/.*/, async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === fixtureOrigin) {
      observations.fixtureRequests += 1;
      await route.continue();
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
const requestedTree = process.env.TASK13_TREE_HASH;
if (requestedTree && requestedTree !== testedTree) {
  throw new Error('TASK13_TREE_HASH does not match the exact current worktree tree');
}

const chromeVersion = runChecked([chromeBinary, '--version']);
const chromeSha256 = runChecked(['sha256sum', chromeBinary]).split(/\s+/)[0];
assert(chromeVersion === expectedChromeVersion, 'Chrome fixture version mismatch');
assert(chromeSha256 === expectedChromeSha256, 'Chrome fixture hash mismatch');

const profile = await mkdtemp(join(tmpdir(), 'tabkebab-task13-browser.'));
const observations = {
  logs: [],
  errors: [],
  fixtureRequests: 0,
  otherExternalRequests: 0,
};
let xvfb;
let fixture;
let context;
let outcome;
let primaryError;
let profileRemoved = false;
let remainingProcesses = -1;
let xvfbExited = false;
let fixtureExited = false;

try {
  fixture = await startFixture((process) => {
    fixture = { process };
  });
  xvfb = Bun.spawn([
    'Xvfb', `:${displayNumber}`, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-ac',
  ], { stdout: 'ignore', stderr: 'ignore' });
  await delay(500);
  assert(xvfb.exitCode === null, 'Xvfb exited before Chrome launch');

  let extensionId;
  ({ context, extensionId } = await launchProfile(
    profile,
    `:${displayNumber}`,
    fixture.baseUrl,
    observations,
    (launchedContext) => {
      context = launchedContext;
    },
  ));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`, {
    waitUntil: 'load',
  });
  await page.locator('#btn-settings').click();
  await page.locator('#view-settings:not(.hidden)').waitFor();
  await page.locator('#ai-enabled').check();
  await page.locator('#ai-provider').selectOption('custom');
  await page.locator('#ai-config-custom:not([hidden])').waitFor();
  await page.waitForFunction(() => !document.querySelector('#ai-provider')?.disabled);
  await page.locator('#custom-base-url').fill(fixture.baseUrl);
  await page.locator('#btn-save-ai').click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('.toast.success span'))
      .some((node) => node.textContent === 'AI settings saved'));

  const saved = await page.evaluate(async (expectedBaseUrl) => {
    const local = await chrome.storage.local.get('aiSettings');
    return {
      enabled: local.aiSettings?.enabled === true,
      providerId: local.aiSettings?.providerId,
      baseUrlMatches: local.aiSettings?.providerConfigs?.custom?.baseUrl === expectedBaseUrl,
    };
  }, fixture.baseUrl);
  assert(saved.enabled && saved.providerId === 'custom' && saved.baseUrlMatches,
    'Custom hanging fixture configuration was not committed');

  await page.evaluate(() => {
    window.__task13ConnectionResponses = [];
    const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (...args) => {
      const response = await originalSend(...args);
      if (args[0]?.action === 'testAIConnection') {
        window.__task13ConnectionResponses.push(response);
      }
      return response;
    };
  });

  const connectionActionStartedAt = performance.now();
  await page.locator('#btn-test-ai').click();
  const firstRequestMetrics = await waitFor(async () => {
    const metrics = await readMetrics(fixture.metricsUrl);
    return metrics.requestStarts === 1 && metrics.activeRequests === 1 && metrics;
  }, 'first hanging provider request');
  const firstStartedAt = performance.now();
  assert(
    firstRequestMetrics.connectionAborts === 0 &&
      firstRequestMetrics.completedRequests === 0 &&
      firstRequestMetrics.maxActiveRequests === 1,
    'First request metrics were not exact at request start',
  );
  console.log(JSON.stringify({ checkpoint: 'first-request-started', testedTree }));

  const progress = setInterval(() => {
    const elapsedSeconds = Math.floor((performance.now() - firstStartedAt) / 1_000);
    console.log(JSON.stringify({ checkpoint: 'waiting-for-production-timeout', elapsedSeconds }));
  }, 30_000);
  try {
    await page.waitForFunction(() => {
      const result = document.querySelector('#ai-test-result');
      return result && result.textContent === 'Connection failed — check your settings' &&
        !document.querySelector('#btn-test-ai')?.disabled;
    }, null, { timeout: providerTimeoutCeilingMs });
  } finally {
    clearInterval(progress);
  }
  const firstElapsedMs = performance.now() - firstStartedAt;
  const connectionActionElapsedMs = performance.now() - connectionActionStartedAt;
  assert(connectionActionElapsedMs >= providerTimeoutFloorMs,
    `Connection action settled before the shipped 120-second boundary: ${connectionActionElapsedMs}ms`);

  const timeoutEvidence = await page.evaluate(() => {
    const responses = window.__task13ConnectionResponses || [];
    const response = responses[0];
    return {
      count: responses.length,
      keys: response && typeof response === 'object' ? Object.keys(response).sort() : [],
      success: response?.success,
    };
  });
  const timeoutFallbackObserved = timeoutEvidence.count === 1 &&
    JSON.stringify(timeoutEvidence.keys) === JSON.stringify(['success']) &&
    timeoutEvidence.success === false;
  assert(timeoutFallbackObserved,
    'Connection test did not expose the exact safe false fallback');

  const firstMetrics = await waitFor(async () => {
    const metrics = await readMetrics(fixture.metricsUrl);
    return metrics.connectionAborts === 1 &&
      metrics.completedRequests === 0 &&
      metrics.activeRequests === 0 && metrics;
  }, 'first connection abort cleanup');
  assert(firstMetrics.requestStarts === 1, 'Timed-out attempt started an automatic retry');
  assert(firstMetrics.maxActiveRequests === 1, 'Timed-out attempt overlapped another request');

  await delay(1_000);
  const stableMetrics = await readMetrics(fixture.metricsUrl);
  assert(
    stableMetrics.requestStarts === 1 &&
      stableMetrics.connectionAborts === 1 &&
      stableMetrics.completedRequests === 0 &&
      stableMetrics.activeRequests === 0 &&
      stableMetrics.maxActiveRequests === 1,
    'An automatic retry appeared after timeout cleanup');

  await page.locator('#btn-test-ai').click();
  const retryMetrics = await waitFor(async () => {
    const metrics = await readMetrics(fixture.metricsUrl);
    return metrics.requestStarts === 2 &&
      metrics.completedRequests === 0 &&
      metrics.activeRequests === 1 && metrics;
  }, 'explicit retry request');
  assert(retryMetrics.connectionAborts === 1, 'Explicit retry started before prior cleanup');
  assert(retryMetrics.maxActiveRequests === 1, 'Explicit retry overlapped the prior attempt');

  const profileEntriesBeforeCleanup = await countEntries(profile);
  await context.close();
  context = null;
  const finalMetrics = await waitFor(async () => {
    const metrics = await readMetrics(fixture.metricsUrl);
    return metrics.connectionAborts === 2 &&
      metrics.activeRequests === 0 && metrics;
  }, 'explicit retry disconnect cleanup');
  assert(
    finalMetrics.requestStarts === 2 &&
      finalMetrics.connectionAborts === 2 &&
      finalMetrics.completedRequests === 0 &&
      finalMetrics.activeRequests === 0 &&
      finalMetrics.maxActiveRequests === 1,
    'Final metrics did not preserve exactly two non-overlapping requests',
  );

  const logText = [...observations.logs, ...observations.errors].join('\n');
  assert(!/authorization|api[-_ ]?key/i.test(logText), 'Browser logs exposed credential metadata');
  assert(observations.errors.length === 0, 'The panel or worker reported a runtime error');
  assert(observations.fixtureRequests > 0,
    'Chrome request interception did not observe the loopback fixture');
  assert(observations.otherExternalRequests === 0, 'Unexpected external requests were observed');

  outcome = {
    testedTree,
    chromeVersion,
    chromeSha256,
    extensionId,
    productionConnectionActionElapsedMs: connectionActionElapsedMs,
    productionTimeoutElapsedMs: firstElapsedMs,
    timeoutFallbackObserved,
    firstRequestStarts: firstMetrics.requestStarts,
    firstConnectionAborts: firstMetrics.connectionAborts,
    completedRequests: finalMetrics.completedRequests,
    firstActiveRequests: firstMetrics.activeRequests,
    maxActiveRequests: finalMetrics.maxActiveRequests,
    explicitRetryObserved: finalMetrics.requestStarts === 2,
    explicitRetryDisconnected: finalMetrics.connectionAborts === 2,
    finalActiveRequests: finalMetrics.activeRequests,
    fixtureRequestsObservedByChrome: observations.fixtureRequests,
    otherExternalRequests: observations.otherExternalRequests,
    runtimeErrors: observations.errors.length,
    profileEntriesBeforeCleanup,
  };
} catch (error) {
  primaryError = error;
} finally {
  await context?.close().catch(() => {});
  if (fixture?.process) {
    try { fixture.process.kill('SIGTERM'); } catch {}
    await Promise.race([fixture.process.exited.catch(() => {}), delay(2_000)]);
    try { fixture.process.kill('SIGKILL'); } catch {}
    await fixture.process.exited.catch(() => {});
    fixtureExited = fixture.process.exitCode !== null;
  }
  if (xvfb) {
    try { xvfb.kill('SIGTERM'); } catch {}
    await Promise.race([xvfb.exited.catch(() => {}), delay(2_000)]);
    try { xvfb.kill('SIGKILL'); } catch {}
    await xvfb.exited.catch(() => {});
    xvfbExited = xvfb.exitCode !== null;
  }
  await rm(profile, { recursive: true, force: true });
  profileRemoved = await stat(profile).then(() => false).catch(() => true);
  remainingProcesses = await matchingProfileProcesses(profile).catch(() => -1);
}

const cleanupErrors = [];
if (!profileRemoved) cleanupErrors.push(new Error('Disposable Chrome profile was not removed'));
if (remainingProcesses !== 0) {
  cleanupErrors.push(new Error('Disposable Chrome processes remained after cleanup'));
}
if (xvfb && !xvfbExited) cleanupErrors.push(new Error('Xvfb did not exit during cleanup'));
if (fixture?.process && !fixtureExited) {
  cleanupErrors.push(new Error('Hanging provider fixture did not exit during cleanup'));
}
if (primaryError && cleanupErrors.length > 0) {
  throw new AggregateError([primaryError, ...cleanupErrors], 'Task 13 smoke and cleanup failed');
}
if (primaryError) throw primaryError;
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, 'Task 13 smoke cleanup failed');
}

console.log(JSON.stringify({
  ...outcome,
  profileRemoved,
  remainingProcesses,
  xvfbExited,
  fixtureExited,
}, null, 2));
