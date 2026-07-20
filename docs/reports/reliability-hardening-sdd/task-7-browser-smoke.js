import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromeBinary = '/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const extensionPath = '/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening';
const displayNumber = 97;
const display = `127.0.0.1:${displayNumber}.0`;
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

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Set();
    this.eventBacklog = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
    this.socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  handleMessage(data) {
    const message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }

    for (const waiter of [...this.eventWaiters]) {
      if (!this.matchesEvent(message, waiter.method, waiter.sessionId, waiter.predicate)) continue;
      this.eventWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params || {});
      return;
    }
    this.eventBacklog.push(message);
  }

  matchesEvent(message, method, sessionId, predicate) {
    return message.method === method &&
      (!sessionId || message.sessionId === sessionId) &&
      predicate(message.params || {});
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitForEvent(method, predicate = () => true, sessionId = undefined, timeout = timeoutMs) {
    const backlogIndex = this.eventBacklog.findIndex((message) =>
      this.matchesEvent(message, method, sessionId, predicate));
    if (backlogIndex >= 0) {
      const [message] = this.eventBacklog.splice(backlogIndex, 1);
      return Promise.resolve(message.params || {});
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        predicate,
        sessionId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.eventWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for CDP event ${method}`));
        }, timeout),
      };
      this.eventWaiters.add(waiter);
    });
  }

  close() {
    this.socket?.close();
  }
}

async function evaluate(cdp, sessionId, source) {
  const response = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { ${source} })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text || 'Runtime.evaluate failed';
    throw new Error(detail);
  }
  return response.result?.value;
}

async function countEntries(path) {
  let count = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    count++;
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

function encodedJson(value) {
  const text = JSON.stringify(value);
  return {
    body: btoa(text),
    responseHeaders: [
      { name: 'Content-Type', value: 'application/json; charset=utf-8' },
      { name: 'Content-Length', value: String(new TextEncoder().encode(text).byteLength) },
      { name: 'Access-Control-Allow-Origin', value: '*' },
    ],
  };
}

const profile = await mkdtemp(join(tmpdir(), 'tabkebab-task7-browser.'));
let xvfb;
let chrome;
let cdp;
let profileEntries = 0;
const chromeErrors = [];
const driveRequestEvidence = [];

try {
  xvfb = Bun.spawn([
    'Xvfb', `:${displayNumber}`, '-screen', '0', '1280x900x24',
    '-nolisten', 'unix', '-listen', 'tcp', '-ac',
  ], { stdout: 'ignore', stderr: 'pipe' });
  void (async () => {
    for await (const chunk of xvfb.stderr) chromeErrors.push(`XVFB ${new TextDecoder().decode(chunk)}`);
  })();
  await delay(500);
  if (xvfb.exitCode !== null) throw new Error('Xvfb exited before Chrome launch');

  chrome = Bun.spawn([
    chromeBinary,
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    'about:blank',
  ], {
    env: { ...process.env, DISPLAY: display },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  void (async () => {
    for await (const chunk of chrome.stderr) chromeErrors.push(new TextDecoder().decode(chunk));
  })();

  const devtools = await waitFor(async () => {
    const value = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
    const [port, browserPath] = value.trim().split('\n');
    return port && browserPath ? { port, browserPath } : null;
  }, 'Chrome DevToolsActivePort');

  cdp = new CdpClient(`ws://127.0.0.1:${devtools.port}${devtools.browserPath}`);
  await cdp.connect();
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  let workerSession;
  const worker = await waitFor(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const candidates = targetInfos.filter((target) =>
      target.type === 'service_worker' &&
      target.url.startsWith('chrome-extension://') &&
      target.url.endsWith('/service-worker.js'));
    for (const candidate of candidates) {
      const attached = await cdp.send('Target.attachToTarget', {
        targetId: candidate.targetId,
        flatten: true,
      });
      await cdp.send('Runtime.enable', {}, attached.sessionId);
      const manifestName = await evaluate(cdp, attached.sessionId, `
        return globalThis.chrome?.runtime?.getManifest?.().name || null;
      `).catch(() => null);
      if (manifestName === 'TabKebab') {
        workerSession = attached.sessionId;
        return candidate;
      }
      await cdp.send('Target.detachFromTarget', { sessionId: attached.sessionId });
    }
    return null;
  }, 'TabKebab service worker target');
  const extensionId = new URL(worker.url).hostname;
  await cdp.send('Network.enable', {}, workerSession);
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: 'https://www.googleapis.com/*', requestStage: 'Request' }],
  }, workerSession);

  const identityOverrideInstalled = await evaluate(cdp, workerSession, `
    const replacement = (_details, callback) => queueMicrotask(() => callback('task7-cdp-synthetic'));
    try {
      chrome.identity.getAuthToken = replacement;
    } catch {}
    if (chrome.identity.getAuthToken !== replacement) {
      try {
        Object.defineProperty(chrome.identity, 'getAuthToken', {
          configurable: true,
          value: replacement,
        });
      } catch {}
    }
    return chrome.identity.getAuthToken === replacement;
  `);
  if (!identityOverrideInstalled) throw new Error('Could not install credential-free identity boundary');

  const { targetId: panelTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/sidepanel/panel.html`,
  });
  const { sessionId: panelSession } = await cdp.send('Target.attachToTarget', {
    targetId: panelTargetId,
    flatten: true,
  });
  await cdp.send('Runtime.enable', {}, panelSession);
  await waitFor(
    () => evaluate(cdp, panelSession, 'return document.readyState === "complete";'),
    'side-panel document load',
  );

  await evaluate(cdp, panelSession, `
    const blanks = (await chrome.tabs.query({})).filter((tab) => tab.url === 'about:blank');
    if (blanks.length) await chrome.tabs.remove(blanks.map((tab) => tab.id));
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      driveProfileName: 'Task7Browser',
      driveSync: { connected: true, lastSyncedAt: null, driveFileId: null },
      sessions: [],
      manualGroups: {
        baseline: {
          name: 'Baseline',
          color: 'blue',
          tabUrls: ['https://example.test/baseline'],
          createdAt: 1000,
          modifiedAt: 1000,
        },
      },
      driveSyncTombstones: { sessions: {}, manualGroups: {} },
    });
    document.querySelector('#btn-settings').click();
    return true;
  `);
  await waitFor(
    () => evaluate(cdp, panelSession, `
      const button = document.querySelector('#btn-sync-now');
      return button && !button.disabled && button.textContent === 'Sync Now';
    `),
    'connected Drive Sync button',
  );

  async function fulfill(request, value, status = 200) {
    const encoded = encodedJson(value);
    await cdp.send('Fetch.fulfillRequest', {
      requestId: request.requestId,
      responseCode: status,
      responsePhrase: status === 200 ? 'OK' : 'Synthetic',
      ...encoded,
    }, workerSession);
  }

  async function fulfillPreflight(request) {
    await cdp.send('Fetch.fulfillRequest', {
      requestId: request.requestId,
      responseCode: 204,
      responsePhrase: 'No Content',
      responseHeaders: [
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PATCH, DELETE, OPTIONS' },
        { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' },
        { name: 'Access-Control-Max-Age', value: '600' },
      ],
    }, workerSession);
  }

  function listingFor(requestUrl) {
    const query = new URL(requestUrl).searchParams.get('q') || '';
    if (query.includes("name='TabKebab'") && query.includes("'root' in parents")) {
      return { files: [{ id: 'task7root', name: 'TabKebab' }] };
    }
    if (query.includes("name='Task7Browser'") && query.includes("'task7root' in parents")) {
      return { files: [{ id: 'task7profile', name: 'Task7Browser' }] };
    }
    if (query.includes("name='tabkebab-sync.json'")) return { files: [] };
    if (query.includes("name='tabkebab-settings.json'")) return { files: [] };
    return { files: [] };
  }

  async function nextDriveRequest() {
    return cdp.waitForEvent('Fetch.requestPaused', () => true, workerSession);
  }

  async function fulfillNonUpload(request) {
    const url = new URL(request.request.url);
    driveRequestEvidence.push({ method: request.request.method, path: url.pathname });
    if (request.request.method === 'OPTIONS') {
      await fulfillPreflight(request);
      return;
    }
    if (request.request.method === 'GET' && url.pathname === '/drive/v3/files') {
      await fulfill(request, listingFor(request.request.url));
      return;
    }
    if (request.request.method === 'POST' && url.pathname === '/drive/v3/files') {
      await fulfill(request, { id: 'task7folder' });
      return;
    }
    throw new Error(`Unexpected synthetic Drive request: ${request.request.method} ${url.pathname}`);
  }

  const firstRequestPromise = nextDriveRequest();
  await evaluate(cdp, panelSession, `
    globalThis.__task7QueuedMutation = { settled: false, response: null, error: null };
    document.querySelector('#btn-sync-now').click();
    return true;
  `);

  let request = await firstRequestPromise;
  let canonicalUpload;
  while (!canonicalUpload) {
    const url = new URL(request.request.url);
    if (request.request.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      canonicalUpload = request;
      driveRequestEvidence.push({ method: request.request.method, path: url.pathname, role: 'canonical' });
      break;
    }
    await fulfillNonUpload(request);
    request = await nextDriveRequest();
  }

  const canonicalPostData = canonicalUpload.request.postData || '';
  await evaluate(cdp, panelSession, `
    chrome.runtime.sendMessage({
      action: 'createManualGroup',
      name: 'Queued Browser Group',
      color: 'green',
    }).then(
      (response) => { globalThis.__task7QueuedMutation = { settled: true, response, error: null }; },
      (error) => { globalThis.__task7QueuedMutation = { settled: true, response: null, error: error.message }; },
    );
    return true;
  `);
  await delay(250);

  const heldState = await evaluate(cdp, panelSession, `
    const state = await chrome.storage.local.get([
      'manualGroups', 'driveSync', 'driveSyncTombstones',
    ]);
    return {
      queuedSettled: globalThis.__task7QueuedMutation.settled,
      groupNames: Object.values(state.manualGroups || {}).map((group) => group.name).sort(),
      lastSyncedAt: state.driveSync?.lastSyncedAt ?? null,
      syncButtonText: document.querySelector('#btn-sync-now').textContent,
      syncButtonDisabled: document.querySelector('#btn-sync-now').disabled,
    };
  `);
  if (heldState.queuedSettled || heldState.groupNames.includes('Queued Browser Group') ||
      heldState.lastSyncedAt !== null || heldState.syncButtonText !== 'Syncing...' ||
      !heldState.syncButtonDisabled) {
    throw new Error(`Mutation did not remain queued behind held upload: ${JSON.stringify(heldState)}`);
  }

  const afterCanonicalPromise = nextDriveRequest();
  await fulfill(canonicalUpload, { id: 'task7sync' });
  let sawSettingsUpload = false;
  request = await afterCanonicalPromise;
  while (!sawSettingsUpload) {
    const url = new URL(request.request.url);
    if (request.request.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      driveRequestEvidence.push({ method: request.request.method, path: url.pathname, role: 'settings' });
      await fulfill(request, { id: 'task7settings' });
      sawSettingsUpload = true;
      break;
    }
    await fulfillNonUpload(request);
    request = await nextDriveRequest();
  }

  const finalState = await waitFor(async () => {
    const state = await evaluate(cdp, panelSession, `
      const stored = await chrome.storage.local.get([
        'sessions', 'manualGroups', 'driveSyncTombstones', 'driveSync',
      ]);
      const queued = globalThis.__task7QueuedMutation;
      return {
        queued,
        sessionCount: (stored.sessions || []).length,
        groupNames: Object.values(stored.manualGroups || {}).map((group) => group.name).sort(),
        tombstoneKinds: Object.keys(stored.driveSyncTombstones || {}).sort(),
        tombstoneCounts: {
          sessions: Object.keys(stored.driveSyncTombstones?.sessions || {}).length,
          manualGroups: Object.keys(stored.driveSyncTombstones?.manualGroups || {}).length,
        },
        lastSyncedAt: stored.driveSync?.lastSyncedAt ?? null,
        driveFileId: stored.driveSync?.driveFileId ?? null,
        syncButtonText: document.querySelector('#btn-sync-now').textContent,
        syncButtonDisabled: document.querySelector('#btn-sync-now').disabled,
        statusText: document.querySelector('#drive-status').textContent,
        toastSummaries: Array.from(document.querySelectorAll('.toast'), (node) => ({
          type: node.className,
          text: node.querySelector('span')?.textContent || '',
        })),
      };
    `);
    return state.queued.settled && state.syncButtonText === 'Sync Now' ? state : null;
  }, 'sync and queued group completion');

  if (finalState.queued.error ||
      !finalState.groupNames.includes('Baseline') ||
      !finalState.groupNames.includes('Queued Browser Group') ||
      finalState.groupNames.length !== 2 ||
      finalState.sessionCount !== 0 ||
      !Number.isSafeInteger(finalState.lastSyncedAt) ||
      finalState.lastSyncedAt <= 0 ||
      finalState.driveFileId !== 'task7sync' ||
      JSON.stringify(finalState.tombstoneKinds) !== JSON.stringify(['manualGroups', 'sessions']) ||
      finalState.tombstoneCounts.sessions !== 0 ||
      finalState.tombstoneCounts.manualGroups !== 0 ||
      finalState.syncButtonDisabled ||
      !finalState.statusText.startsWith('Connected. Last synced:') ||
      !finalState.toastSummaries.some(({ type, text }) =>
        type.includes('success') && text === 'Synced with Google Drive')) {
    throw new Error(`Final real-browser state mismatch: ${JSON.stringify(finalState)}`);
  }

  profileEntries = await countEntries(profile);
  console.log(JSON.stringify({
    browser: 'Google Chrome for Testing 148.0.7778.96',
    binarySha256: 'adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f',
    testedTree: process.env.TASK7_TREE_HASH || null,
    extensionId,
    boundary: 'Real unpacked extension, service worker, side-panel DOM, Chrome storage/runtime APIs, and worker FIFO lock; Google requests were fulfilled synthetically at CDP and never reached a network',
    liveDrivePassed: false,
    oauthBlocker: 'Unpacked extension identity has no registered matching client and the disposable profile has no operator-authenticated Google test-user session',
    heldUpload: {
      v2MarkerObserved: canonicalPostData.includes('"version": 2'),
      tombstoneMarkerObserved: canonicalPostData.includes('"tombstones"'),
      queuedMutationSettledBeforeRelease: heldState.queuedSettled,
      queuedGroupPersistedBeforeRelease: heldState.groupNames.includes('Queued Browser Group'),
      lastSyncedBeforeRelease: heldState.lastSyncedAt,
    },
    settledOrder: {
      canonicalUploadReleasedBeforeQueuedMutation: true,
      queuedMutationSucceeded: finalState.queued.error === null,
      queuedGroupPersistedAfterRelease: finalState.groupNames.includes('Queued Browser Group'),
      lastSyncedAfterFullPath: Number.isSafeInteger(finalState.lastSyncedAt),
    },
    finalCounts: {
      sessions: finalState.sessionCount,
      manualGroups: finalState.groupNames.length,
      sessionTombstones: finalState.tombstoneCounts.sessions,
      manualGroupTombstones: finalState.tombstoneCounts.manualGroups,
    },
    panel: {
      buttonReset: finalState.syncButtonText === 'Sync Now' && !finalState.syncButtonDisabled,
      connectedTimestampRendered: finalState.statusText.startsWith('Connected. Last synced:'),
      successRendered: finalState.toastSummaries.some(({ type, text }) =>
        type.includes('success') && text === 'Synced with Google Drive'),
    },
    syntheticDriveRequestCount: driveRequestEvidence.length,
    profileEntriesBeforeCleanup: profileEntries,
  }, null, 2));
} catch (error) {
  console.error(error.stack || error);
  console.error(`CHROME_ERROR_CHUNKS=${chromeErrors.length}`);
  process.exitCode = 1;
} finally {
  cdp?.close();
  await stopProcess(chrome);
  const pkill = Bun.spawn(['pkill', '-TERM', '-f', profile], { stdout: 'ignore', stderr: 'ignore' });
  await pkill.exited.catch(() => {});
  await stopProcess(xvfb);
  await rm(profile, { recursive: true, force: true });
  let profileRemoved = false;
  try { await stat(profile); } catch { profileRemoved = true; }
  console.log(`CLEANUP_PROFILE_REMOVED=${profileRemoved ? 1 : 0}`);
  console.log(`CLEANUP_CHROME_PROCESS_EXITED=${chrome ? Number((await chrome.exited) !== null) : 1}`);
  console.log(`CLEANUP_XVFB_PROCESS_EXITED=${xvfb ? Number((await xvfb.exited) !== null) : 1}`);
}
