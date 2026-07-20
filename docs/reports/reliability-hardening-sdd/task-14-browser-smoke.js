import { chromium } from 'playwright';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromeBinary = '/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const extensionPath = '/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening';
const expectedChromeVersion = 'Google Chrome for Testing 148.0.7778.96';
const expectedChromeSha256 = 'adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f';
const displayNumber = 105;
const shortTimeoutMs = 20_000;

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
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${command[0]} failed with exit ${result.exitCode}${stderr ? `: ${stderr}` : ''}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function computeWorktreeTree() {
  const indexDirectory = await mkdtemp(join(tmpdir(), 'tabkebab-task14-index.'));
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

async function currentWorker(context) {
  return waitFor(
    () => context.serviceWorkers().find((candidate) =>
      candidate.url().startsWith('chrome-extension://') &&
      candidate.url().endsWith('/service-worker.js')),
    'TabKebab service worker',
  );
}

async function installBrokerProbe(context) {
  await context.addInitScript(() => {
    if (typeof globalThis.chrome?.runtime?.connect !== 'function') return;
    if (globalThis.__task14ReadBrokerProbe) return;

    const runtime = chrome.runtime;
    const originalConnect = runtime.connect;
    const state = {
      connectionAttempts: 0,
      activeConnections: 0,
      disconnects: 0,
      pendingAtDisconnect: 0,
      requestCount: 0,
      cancelCount: 0,
      resultCount: 0,
      pending: new Set(),
      lastResult: null,
      currentPort: null,
      currentDisconnect: null,
    };

    function summarizeResult(message) {
      if (message?.ok === false) {
        return {
          ok: false,
          code: typeof message.error?.code === 'string' ? message.error.code : 'UNKNOWN',
        };
      }
      const value = message?.value;
      return {
        ok: message?.ok === true,
        valueKeys: value && typeof value === 'object' ? Object.keys(value).sort() : [],
        textType: typeof value?.text,
        textLength: typeof value?.text === 'string' ? value.text.length : -1,
        parsedIsJson: value?.parsed === null ||
          ['boolean', 'number', 'string'].includes(typeof value?.parsed) ||
          (value?.parsed && typeof value.parsed === 'object'),
        tokensUsed: value?.tokensUsed,
      };
    }

    function connect(...args) {
      const port = Reflect.apply(originalConnect, runtime, args);
      const connectInfo = args.at(-1);
      if (connectInfo?.name !== 'tabkebab:chrome-ai') return port;

      state.connectionAttempts += 1;
      state.activeConnections += 1;
      let disconnected = false;
      const brokerDisconnectListeners = new Set();
      port.onMessage.addListener((message) => {
        if (message?.type === 'chrome-ai/request') {
          state.requestCount += 1;
          state.pending.add(message.requestId);
        } else if (message?.type === 'chrome-ai/cancel') {
          state.cancelCount += 1;
        }
      });
      function handleDisconnect(...eventArgs) {
        if (disconnected) return;
        disconnected = true;
        state.disconnects += 1;
        state.activeConnections -= 1;
        state.pendingAtDisconnect = state.pending.size;
        state.pending.clear();
        for (const listener of [...brokerDisconnectListeners]) listener(...eventArgs);
      }
      port.onDisconnect.addListener(handleDisconnect);

      const wrappedOnDisconnect = {
        addListener(listener) {
          brokerDisconnectListeners.add(listener);
        },
        removeListener(listener) {
          brokerDisconnectListeners.delete(listener);
        },
        hasListener(listener) {
          return brokerDisconnectListeners.has(listener);
        },
      };

      const wrapped = {
        name: port.name,
        onMessage: port.onMessage,
        onDisconnect: wrappedOnDisconnect,
        postMessage(message) {
          if (message?.type === 'chrome-ai/result') {
            state.resultCount += 1;
            state.pending.delete(message.requestId);
            state.lastResult = summarizeResult(message);
          }
          return port.postMessage(message);
        },
        disconnect() {
          return port.disconnect();
        },
      };
      state.currentPort = wrapped;
      state.currentDisconnect = handleDisconnect;
      return wrapped;
    }

    Object.defineProperty(runtime, 'connect', {
      configurable: true,
      value: connect,
    });
    globalThis.__task14ReadBrokerProbe = () => ({
      connectionAttempts: state.connectionAttempts,
      activeConnections: state.activeConnections,
      disconnects: state.disconnects,
      pendingAtDisconnect: state.pendingAtDisconnect,
      requestCount: state.requestCount,
      cancelCount: state.cancelCount,
      resultCount: state.resultCount,
      pending: state.pending.size,
      lastResult: state.lastResult,
      portName: state.currentPort?.name ?? null,
    });
    globalThis.__task14DisconnectBroker = () => {
      const disconnect = state.currentDisconnect;
      state.currentPort?.disconnect();
      disconnect?.();
    };
  });
}

async function brokerProbe(panel) {
  return panel.evaluate(() => globalThis.__task14ReadBrokerProbe?.() ?? null);
}

async function configureChromeAI(panel) {
  return panel.evaluate(async () => {
    await chrome.storage.local.set({
      aiSettings: {
        enabled: true,
        providerId: 'chrome-ai',
        providerConfigs: {
          'chrome-ai': { model: 'default' },
        },
        usePassphrase: false,
      },
    });
    await chrome.storage.local.remove('aiCache');
    return true;
  });
}

async function inspectPromptAPI(panel) {
  return panel.evaluate(async () => {
    const lockManager = globalThis.navigator?.locks;
    const webLocks = {
      available: typeof lockManager?.request === 'function',
      held: null,
      pending: null,
    };
    if (typeof lockManager?.query === 'function') {
      const snapshot = await lockManager.query();
      webLocks.held = snapshot.held.filter(
        ({ name }) => name === 'tabkebab:chrome-ai-provider',
      ).length;
      webLocks.pending = snapshot.pending.filter(
        ({ name }) => name === 'tabkebab:chrome-ai-provider',
      ).length;
    }
    const api = globalThis.LanguageModel ?? globalThis.ai?.languageModel ?? null;
    if (!api) return { apiPresent: false, status: 'api-unavailable', webLocks };
    try {
      if (typeof api.availability === 'function') {
        return { apiPresent: true, status: String(await api.availability()), webLocks };
      }
      if (typeof api.capabilities === 'function') {
        const capabilities = await api.capabilities();
        return {
          apiPresent: true,
          status: String(capabilities?.available ?? 'unknown'),
          webLocks,
        };
      }
      return { apiPresent: true, status: 'availability-method-unavailable', webLocks };
    } catch (error) {
      return {
        apiPresent: true,
        status: 'availability-threw',
        errorName: typeof error?.name === 'string' ? error.name : 'unknown',
        webLocks,
      };
    }
  });
}

async function productionConnection(control) {
  return control.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      action: 'testAIConnection',
      providerId: 'chrome-ai',
    });
    return {
      settled: true,
      value: response?.success === true,
      error: typeof response?.error === 'string' ? response.error : null,
    };
  });
}

async function productionCompletion(control, ownerPanel) {
  const before = await brokerProbe(ownerPanel);
  const response = await control.evaluate(async () => chrome.runtime.sendMessage({
    action: 'executeNLCommand',
    command: 'Describe the currently open synthetic tabs without changing them.',
  }));
  const after = await waitFor(async () => {
    const state = await brokerProbe(ownerPanel);
    return state.resultCount > before.resultCount ? state : null;
  }, 'bounded Chrome AI broker completion result');
  return {
    handlerSettled: response !== undefined,
    ...after.lastResult,
  };
}

async function productionForegroundFailure(control) {
  return control.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      action: 'executeNLCommand',
      command: 'Inspect only synthetic tabs.',
    });
    return {
      error: typeof response?.error === 'string' ? response.error : null,
    };
  });
}

async function beginCancellableCompletion(control) {
  return control.evaluate(async () => {
    globalThis.__task14CompletionOutcome = { state: 'pending' };
    void chrome.runtime.sendMessage({
      action: 'executeNLCommand',
      command: `Carefully inspect this synthetic input without changing tabs: ${'safe '.repeat(20_000)}`,
    }).then(
      (response) => {
        if (typeof response?.error === 'string') {
          globalThis.__task14CompletionOutcome = {
            state: 'rejected',
            code: response.error === 'AI requires an open side panel'
              ? 'AI_FOREGROUND_REQUIRED'
              : 'UNKNOWN',
            message: response.error,
          };
          return;
        }
        globalThis.__task14CompletionOutcome = { state: 'resolved' };
      },
      (error) => {
        globalThis.__task14CompletionOutcome = {
          state: 'rejected',
          code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
          message: typeof error?.message === 'string' ? error.message : 'Unknown error',
        };
      },
    );
    return true;
  });
}

async function completionOutcome(control) {
  return control.evaluate(() => globalThis.__task14CompletionOutcome ?? null);
}

const testedTree = await computeWorktreeTree();
const requestedTree = process.env.TASK14_TREE_HASH;
assert(requestedTree, 'TASK14_TREE_HASH is required for the terminal browser gate');
assert(requestedTree === testedTree, 'TASK14_TREE_HASH does not match the exact current worktree tree');

const chromeVersion = runChecked([chromeBinary, '--version']);
const chromeSha256 = runChecked(['sha256sum', chromeBinary]).split(/\s+/)[0];
assert(chromeVersion === expectedChromeVersion, 'Chrome fixture version mismatch');
assert(chromeSha256 === expectedChromeSha256, 'Chrome fixture hash mismatch');

const profile = await mkdtemp(join(tmpdir(), 'tabkebab-task14-browser.'));
const observations = {
  errors: [],
  logs: [],
  loopbackRequests: 0,
  otherExternalRequests: 0,
};
let xvfb;
let context;
let loopback;
let outcome;
let primaryError;
let profileRemoved = false;
let remainingProcesses = -1;
let xvfbExited = false;
let loopbackStopped = false;

try {
  loopback = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      return new Response(`<!doctype html><title>Task 14 ${url.pathname}</title><p>synthetic</p>`, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });
  const loopbackOrigin = `http://127.0.0.1:${loopback.port}`;

  xvfb = Bun.spawn([
    'Xvfb', `:${displayNumber}`, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-ac',
  ], { stdout: 'ignore', stderr: 'ignore' });
  await delay(500);
  assert(xvfb.exitCode === null, 'Xvfb exited before Chrome launch');

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
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    ],
  });
  await installBrokerProbe(context);

  context.on('console', (message) => observations.logs.push(message.text()));
  context.on('weberror', (webError) => observations.errors.push(webError.error().message));
  await context.route(/https?:\/\/.*/, async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === loopbackOrigin) {
      observations.loopbackRequests += 1;
      await route.continue();
      return;
    }
    observations.otherExternalRequests += 1;
    await route.abort('blockedbyclient');
  });

  const worker = await currentWorker(context);
  const extensionId = new URL(worker.url()).hostname;
  const panelUrl = `chrome-extension://${extensionId}/sidepanel/panel.html`;
  const controlUrl = `chrome-extension://${extensionId}/googlee4191267b781b2de.html`;
  const control = await context.newPage();
  await control.goto(controlUrl, { waitUntil: 'load' });
  let panel = await context.newPage();
  await panel.goto(panelUrl, { waitUntil: 'load' });
  await configureChromeAI(panel);

  const initialBroker = await waitFor(async () => {
    const state = await brokerProbe(panel);
    return state?.portName === 'tabkebab:chrome-ai' &&
      state.pending === 0 && state.activeConnections === 1
      ? state
      : null;
  }, 'initial named Chrome AI broker port');

  await panel.evaluate(() => globalThis.__task14DisconnectBroker());
  const reconnectedBroker = await waitFor(async () => {
    const state = await brokerProbe(panel);
    return state?.portName === 'tabkebab:chrome-ai' && state.pending === 0 &&
      state.activeConnections === 1 && state.connectionAttempts > initialBroker.connectionAttempts &&
      state.disconnects === 1
      ? state
      : null;
  }, 'panel reconnect after worker port loss');

  const promptAPI = await inspectPromptAPI(panel);
  assert(promptAPI.webLocks.available === true,
    'The real side-panel document does not expose Web Locks coordination');
  assert(promptAPI.webLocks.held === 0 && promptAPI.webLocks.pending === 0,
    'The Chrome AI provider lock was not idle before broker work');

  const connectionBefore = await brokerProbe(panel);
  const connectionOpen = await productionConnection(control);
  const connectionAfter = await brokerProbe(panel);
  const promptAvailable = promptAPI.status === 'available' || promptAPI.status === 'readily';
  assert(connectionOpen.value === promptAvailable,
    'Production broker availability does not match the panel Prompt API status');
  assert(connectionAfter.requestCount === connectionBefore.requestCount + 1 &&
    connectionAfter.resultCount === connectionBefore.resultCount + 1 &&
    connectionAfter.pending === 0,
  'Production connection check did not cross and settle the named panel port');

  const newestPanel = await context.newPage();
  await newestPanel.goto(panelUrl, { waitUntil: 'load' });
  const newestInitial = await waitFor(async () => {
    const state = await brokerProbe(newestPanel);
    return state?.portName === 'tabkebab:chrome-ai' && state.activeConnections === 1
      ? state
      : null;
  }, 'newest live panel connection');
  const oldBeforeOwnership = await brokerProbe(panel);
  const newestBeforeOwnership = await brokerProbe(newestPanel);
  const newestConnection = await productionConnection(control);
  const oldAfterOwnership = await brokerProbe(panel);
  const newestAfterOwnership = await brokerProbe(newestPanel);
  assert(newestConnection.value === promptAvailable,
    'Newest-panel production availability changed unexpectedly');
  assert(oldAfterOwnership.requestCount === oldBeforeOwnership.requestCount &&
    newestAfterOwnership.requestCount === newestBeforeOwnership.requestCount + 1 &&
    newestAfterOwnership.pending === 0,
  'Newest connected panel did not exclusively own broker work');

  await newestPanel.close({ runBeforeUnload: true });
  await delay(250);
  const standbyBefore = await brokerProbe(panel);
  const standbyConnection = await productionConnection(control);
  const standbyBroker = await brokerProbe(panel);
  assert(standbyConnection.value === promptAvailable,
    'Standby-panel production availability changed unexpectedly');
  assert(standbyBroker.requestCount === standbyBefore.requestCount + 1 &&
    standbyBroker.resultCount === standbyBefore.resultCount + 1 &&
    standbyBroker.pending === 0,
  'Older live panel was not promoted after the newest panel closed');

  let completion = { attempted: false, reason: `Prompt API status is ${promptAPI.status}` };
  let panelCloseDuringRequest = {
    attempted: false,
    reason: `Prompt API status is ${promptAPI.status}`,
  };
  if (promptAvailable) {
    const completionValue = await productionCompletion(control, panel);
    assert(completionValue.ok === true,
      'Chrome AI completion returned a broker error');
    assert(JSON.stringify(completionValue.valueKeys) ===
      JSON.stringify(['parsed', 'text', 'tokensUsed']),
    'Chrome AI completion crossed unexpected result fields');
    assert(completionValue.textType === 'string' && completionValue.textLength >= 0,
      'Chrome AI completion omitted bounded text');
    assert(completionValue.parsedIsJson === true,
      'Chrome AI completion returned a non-JSON parsed value');
    assert(Number.isSafeInteger(completionValue.tokensUsed) && completionValue.tokensUsed >= 0,
      'Chrome AI completion returned invalid tokensUsed');
    completion = { attempted: true, passed: true, ...completionValue };

    const requestOwner = await context.newPage();
    await requestOwner.goto(panelUrl, { waitUntil: 'load' });
    await waitFor(async () => (await brokerProbe(requestOwner))?.activeConnections === 1,
      'close-test owner panel connection');
    await beginCancellableCompletion(control);
    const activeObserved = await waitFor(async () => (await brokerProbe(requestOwner))?.pending === 1,
      'active Chrome AI request before panel close', 10_000).then(() => true, () => false);
    if (activeObserved) {
      const atClose = await brokerProbe(requestOwner);
      await requestOwner.close({ runBeforeUnload: true });
      const cancelled = await waitFor(async () => {
        const value = await completionOutcome(control);
        return value?.state !== 'pending' ? value : null;
      }, 'closed-panel completion settlement');
      assert(cancelled.state === 'rejected' && cancelled.code === 'AI_FOREGROUND_REQUIRED',
        'Closing the panel did not reject active work as foreground-required');
      const fallbackBefore = await brokerProbe(panel);
      const fallbackConnection = await productionConnection(control);
      const fallbackAfter = await brokerProbe(panel);
      assert(fallbackConnection.value === promptAvailable &&
        fallbackAfter.requestCount === fallbackBefore.requestCount + 1 &&
        fallbackAfter.pending === 0,
      'Standby panel did not recover after closed-owner cleanup');
      panelCloseDuringRequest = {
        attempted: true,
        passed: true,
        outcomeCode: cancelled.code,
        pendingAtClose: atClose.pending,
        standbyRecovered: true,
      };
    } else {
      panelCloseDuringRequest = {
        attempted: true,
        passed: false,
        reason: 'The installed model settled before an active request could be observed',
      };
      if (!requestOwner.isClosed()) await requestOwner.close({ runBeforeUnload: true });
    }
  }

  if (!panel.isClosed()) await panel.close({ runBeforeUnload: true });
  await waitFor(
    () => context.pages().filter((page) => page.url() === panelUrl).length === 0,
    'all panel documents to close',
  );
  const connectionClosed = await productionForegroundFailure(control);
  assert(connectionClosed.error === 'AI requires an open side panel',
    'Closed-panel production call did not require foreground');

  const target = await context.newPage();
  await target.goto(`${loopbackOrigin}/origin`, { waitUntil: 'load' });
  const focusRunId = `task14-${crypto.randomUUID()}`;
  const focusState = await (await currentWorker(context)).evaluate(async (runId) => {
    const state = {
      status: 'active',
      runId,
      startedAt: Date.now(),
      duration: 25,
      pausedAt: null,
      pausedElapsed: 0,
      profileId: 'coding',
      profileName: 'Coding',
      profileColor: 'cyan',
      tabAction: 'none',
      allowedDomains: [],
      blockedDomains: [],
      strictMode: false,
      blockedCategories: [],
      aiBlocking: true,
      stashId: null,
      focusGroupId: null,
      focusGroupOwnershipToken: null,
      distractionsBlocked: 0,
      focusTabCount: 1,
    };
    await chrome.storage.local.set({ focusState: state });
    await chrome.storage.local.remove('aiCache');
    return state;
  }, focusRunId);
  await delay(250);

  const destination = `${loopbackOrigin}/unknown-${crypto.randomUUID()}`;
  await target.goto(destination, { waitUntil: 'load' });
  await delay(2_500);

  const focusAfter = await (await currentWorker(context)).evaluate(async () => {
    const stored = await chrome.storage.local.get(['focusState', 'aiCache']);
    return {
      state: stored.focusState ?? null,
      cachePresent: Object.hasOwn(stored, 'aiCache'),
    };
  });
  assert(target.url() === destination, 'Closed-panel background Focus mutated the tab URL');
  assert(focusAfter.state?.runId === focusState.runId &&
    focusAfter.state?.status === 'active' &&
    focusAfter.state?.distractionsBlocked === 0,
  'Closed-panel background Focus mutated its run or counter');
  assert(focusAfter.cachePresent === false, 'Closed-panel background Focus wrote an AI cache entry');
  assert(context.pages().filter((page) => page.url() === panelUrl).length === 0,
    'Background Focus reopened the side panel');

  panel = await context.newPage();
  await panel.goto(panelUrl, { waitUntil: 'load' });
  const reopenedBroker = await waitFor(async () => {
    const state = await brokerProbe(panel);
    return state?.portName === 'tabkebab:chrome-ai' &&
      state.pending === 0 && state.activeConnections === 1
      ? state
      : null;
  }, 'foreground broker after panel reopen');
  const connectionReopened = await productionConnection(control);
  assert(connectionReopened.value === promptAvailable,
    'Reopened-panel production availability changed unexpectedly');
  const finalBroker = await brokerProbe(panel);
  assert(finalBroker.pending === 0,
    'Reopened panel retained broker work before terminal teardown');
  await panel.evaluate(async (runId) => {
    await chrome.runtime.sendMessage({ action: 'endFocus', expectedRunId: runId });
  }, focusRunId);
  await panel.close({ runBeforeUnload: true });
  await target.close();
  await control.close();
  const finalStorage = await (await currentWorker(context)).evaluate(async () => {
    const stored = await chrome.storage.local.get(['focusState', 'aiCache']);
    return {
      focusStatePresent: Object.hasOwn(stored, 'focusState'),
      aiCachePresent: Object.hasOwn(stored, 'aiCache'),
    };
  });
  assert(finalStorage.focusStatePresent === false, 'Focus state remained after cleanup');
  assert(observations.otherExternalRequests === 0, 'An external HTTP(S) request escaped the loopback gate');
  assert(observations.errors.length === 0, 'Chrome reported a runtime page/worker error');

  outcome = {
    testedTree,
    chromeVersion,
    chromeSha256,
    initialConnectionAttempts: initialBroker.connectionAttempts,
    reconnectedConnectionAttempts: reconnectedBroker.connectionAttempts,
    newestConnectionAttempts: newestInitial.connectionAttempts,
    newestOwnedRequest: true,
    standbyPromotionPassed: true,
    standbyRequestCount: standbyBroker.requestCount,
    reopenedConnectionAttempts: reopenedBroker.connectionAttempts,
    promptAPI,
    productionAvailabilityOpen: connectionOpen.value,
    completion,
    panelCloseDuringRequest,
    closedPanelError: connectionClosed.error,
    backgroundFocus: {
      destinationPreserved: true,
      counterPreserved: true,
      statePreserved: true,
      cacheWrite: false,
      panelOpened: false,
    },
    productionAvailabilityReopened: connectionReopened.value,
    finalPending: finalBroker.pending,
    finalFocusStatePresent: finalStorage.focusStatePresent,
    loopbackRequests: observations.loopbackRequests,
    otherExternalRequests: observations.otherExternalRequests,
    runtimeErrors: observations.errors.length,
  };
} catch (error) {
  primaryError = error;
} finally {
  if (context) {
    try { await context.close(); } catch { /* best effort */ }
  }
  if (loopback) {
    try {
      await loopback.stop(true);
      loopbackStopped = true;
    } catch { /* reported below */ }
  }
  if (xvfb) {
    try { xvfb.kill(); } catch { /* best effort */ }
    try {
      await xvfb.exited;
      xvfbExited = true;
    } catch { /* reported below */ }
  }
  try {
    await waitFor(async () => (await matchingProfileProcesses(profile)) === 0,
      'disposable Chrome processes to exit');
    remainingProcesses = await matchingProfileProcesses(profile);
  } catch {
    remainingProcesses = await matchingProfileProcesses(profile);
  }
  let profileEntriesBeforeCleanup = -1;
  try { profileEntriesBeforeCleanup = await countEntries(profile); } catch { /* already absent */ }
  if (profile.startsWith('/tmp/tabkebab-task14-browser.')) {
    await rm(profile, { recursive: true, force: true });
    profileRemoved = true;
  }
  outcome = {
    ...(outcome ?? {
      testedTree,
      chromeVersion,
      chromeSha256,
    }),
    profileEntriesBeforeCleanup,
    profileRemoved,
    remainingProcesses,
    xvfbExited,
    loopbackStopped,
  };
}

console.log(JSON.stringify(outcome, null, 2));
if (primaryError) throw primaryError;
assert(profileRemoved, 'Disposable profile was not removed');
assert(remainingProcesses === 0, 'Disposable Chrome processes remain');
assert(xvfbExited, 'Xvfb did not exit');
assert(loopbackStopped, 'Loopback fixture did not stop');
