import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromeBinary = '/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const extensionPath = '/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening';
const displayNumber = 98;
const display = `127.0.0.1:${displayNumber}.0`;
const timeoutMs = 20_000;
const expectedChromeVersion = 'Google Chrome for Testing 148.0.7778.96';
const expectedChromeSha256 = 'adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f';

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

function runChecked(command, options = {}) {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', ...options });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed with exit ${result.exitCode}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function computeWorktreeTree() {
  const indexDirectory = await mkdtemp(join(tmpdir(), 'tabkebab-task8-index.'));
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

const testedTree = await computeWorktreeTree();
const requestedTree = process.env.TASK8_TREE_HASH;
if (requestedTree && requestedTree !== testedTree) {
  throw new Error('TASK8_TREE_HASH does not match the exact current worktree tree');
}

const chromeVersion = runChecked([chromeBinary, '--version']);
const chromeSha256 = runChecked(['sha256sum', chromeBinary]).split(/\s+/)[0];
if (chromeVersion !== expectedChromeVersion || chromeSha256 !== expectedChromeSha256) {
  throw new Error('Installed Chrome for Testing build/hash does not match the approved Task 7 fixture');
}

const profile = await mkdtemp(join(tmpdir(), 'tabkebab-task8-browser.'));
let xvfb;
let chrome;
let cdp;
let profileEntries = 0;
let extensionId = null;
const chromeErrors = [];
let interceptedExternalRequests = 0;

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
  extensionId = new URL(worker.url).hostname;

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

  for (const sessionId of [workerSession, panelSession]) {
    await cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: 'http://*', requestStage: 'Request' },
        { urlPattern: 'https://*', requestStage: 'Request' },
      ],
    }, sessionId);
  }

  const externalBlocker = async (sessionId) => {
    while (true) {
      const event = await new Promise((resolve, reject) => {
        const listener = (messageEvent) => {
          const message = JSON.parse(typeof messageEvent.data === 'string'
            ? messageEvent.data
            : new TextDecoder().decode(messageEvent.data));
          if (message.sessionId !== sessionId || message.method !== 'Fetch.requestPaused') return;
          cdp.socket.removeEventListener('message', listener);
          resolve(message.params);
        };
        cdp.socket.addEventListener('message', listener);
        if (!cdp.socket) reject(new Error('CDP socket unavailable'));
      });
      interceptedExternalRequests += 1;
      await cdp.send('Fetch.failRequest', {
        requestId: event.requestId,
        errorReason: 'BlockedByClient',
      }, sessionId);
    }
  };
  void externalBlocker(workerSession).catch(() => {});
  void externalBlocker(panelSession).catch(() => {});

  const seedResult = await evaluate(cdp, panelSession, `
    const blanks = (await chrome.tabs.query({})).filter((tab) => tab.url === 'about:blank');
    if (blanks.length) await chrome.tabs.remove(blanks.map((tab) => tab.id));
    await chrome.storage.local.clear();
    const sessionId = 'task8-synthetic-session';
    const groupId = 'task8-synthetic-group';
    const baselineTimestamp = 1_000;
    await chrome.storage.local.set({
      sessions: [{
        id: sessionId,
        name: 'Task 8 Synthetic Session',
        version: 2,
        createdAt: baselineTimestamp,
        modifiedAt: baselineTimestamp,
        windows: [{ tabCount: 0, tabs: [] }],
      }],
      manualGroups: {
        [groupId]: {
          name: 'Task 8 Synthetic Group',
          color: 'blue',
          tabUrls: [],
          createdAt: baselineTimestamp,
          modifiedAt: baselineTimestamp,
        },
      },
      driveSyncTombstones: { sessions: {}, manualGroups: {} },
    });
    globalThis.__task8StorageEvents = [];
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const keys = Object.keys(changes).sort();
      if (!keys.some((key) => ['sessions', 'manualGroups', 'driveSyncTombstones'].includes(key))) return;
      globalThis.__task8StorageEvents.push({
        keys,
        sessionsCount: Array.isArray(changes.sessions?.newValue)
          ? changes.sessions.newValue.length
          : null,
        manualGroupsCount: changes.manualGroups?.newValue
          ? Object.keys(changes.manualGroups.newValue).length
          : null,
        sessionTombstones: changes.driveSyncTombstones?.newValue?.sessions
          ? Object.keys(changes.driveSyncTombstones.newValue.sessions).length
          : null,
        manualGroupTombstones: changes.driveSyncTombstones?.newValue?.manualGroups
          ? Object.keys(changes.driveSyncTombstones.newValue.manualGroups).length
          : null,
      });
    });
    return { sessionId, groupId, baselineTimestamp };
  `);

  await evaluate(cdp, panelSession, `
    document.querySelector('.tab-nav [data-view="sessions"]').click();
    return true;
  `);
  try {
    await waitFor(
      () => evaluate(cdp, panelSession, `
        const card = document.querySelector('#session-list-saved .session-card');
        return card?.querySelector('.session-name')?.textContent === 'Task 8 Synthetic Session';
      `),
      'synthetic session card',
      5_000,
    );
  } catch (error) {
    const diagnostic = await evaluate(cdp, panelSession, `
      const state = await chrome.storage.local.get(['sessions']);
      let workerResponse = null;
      let workerError = null;
      try {
        workerResponse = await chrome.runtime.sendMessage({ action: 'listSessions' });
      } catch (runtimeError) {
        workerError = runtimeError.message;
      }
      return {
        storedSessionCount: Array.isArray(state.sessions) ? state.sessions.length : null,
        workerResponseCount: Array.isArray(workerResponse) ? workerResponse.length : null,
        workerReturnedError: typeof workerResponse?.error === 'string' ? workerResponse.error : null,
        workerTransportError: workerError,
        cardCount: document.querySelectorAll('#session-list-saved .session-card').length,
        renderedNames: Array.from(document.querySelectorAll('#session-list-saved .session-name'),
          (node) => node.textContent),
        errorToasts: Array.from(document.querySelectorAll('.toast.error span'),
          (node) => node.textContent),
      };
    `);
    throw new Error(`${error.message}; redacted diagnostic=${JSON.stringify(diagnostic)}`);
  }

  await evaluate(cdp, panelSession, `
    const card = document.querySelector('#session-list-saved .session-card');
    const button = Array.from(card.querySelectorAll('button')).find((entry) => entry.textContent === 'Delete');
    button.click();
    return true;
  `);

  const deletedSessionState = await waitFor(
    () => evaluate(cdp, panelSession, `
      const state = await chrome.storage.local.get(['sessions', 'driveSyncTombstones']);
      const tombstone = state.driveSyncTombstones?.sessions?.['task8-synthetic-session'];
      const undo = Array.from(document.querySelectorAll('.toast-action'))
        .find((button) => button.textContent === 'Undo');
      if ((state.sessions || []).some(({ id }) => id === 'task8-synthetic-session')) return null;
      if (!Number.isSafeInteger(tombstone) || !undo) return null;
      return {
        sessionCount: (state.sessions || []).length,
        tombstone,
        deletionEvent: globalThis.__task8StorageEvents.find((event) =>
          event.keys.includes('sessions') && event.keys.includes('driveSyncTombstones') &&
          event.sessionsCount === 0 && event.sessionTombstones === 1) || null,
        successToast: Array.from(document.querySelectorAll('.toast.success span'))
          .some((node) => node.textContent === 'Deleted "Task 8 Synthetic Session"'),
      };
    `),
    'atomic session deletion and Undo control',
  );
  if (!deletedSessionState.deletionEvent || !deletedSessionState.successToast ||
      deletedSessionState.tombstone < seedResult.baselineTimestamp) {
    throw new Error('Real-panel session deletion did not commit collection and tombstone together');
  }

  await evaluate(cdp, panelSession, `
    Array.from(document.querySelectorAll('.toast-action'))
      .find((button) => button.textContent === 'Undo').click();
    return true;
  `);
  const restoredSessionState = await waitFor(
    () => evaluate(cdp, panelSession, `
      const state = await chrome.storage.local.get(['sessions', 'driveSyncTombstones']);
      const matches = (state.sessions || []).filter(({ id }) => id === 'task8-synthetic-session');
      const tombstone = state.driveSyncTombstones?.sessions?.['task8-synthetic-session'];
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].modifiedAt)) return null;
      const successToast = Array.from(document.querySelectorAll('.toast.success span'))
        .some((node) => node.textContent === 'Restored "Task 8 Synthetic Session"');
      if (!successToast) return null;
      return {
        matchingSessions: matches.length,
        modifiedAt: matches[0].modifiedAt,
        tombstone,
        successToast,
      };
    `),
    'session Undo completion',
  );
  if (restoredSessionState.modifiedAt <= deletedSessionState.tombstone ||
      restoredSessionState.tombstone !== deletedSessionState.tombstone) {
    throw new Error('Session Undo did not create one newer entity while retaining its tombstone');
  }

  await evaluate(cdp, panelSession, `
    document.querySelector('.tab-nav [data-view="tabs"]').click();
    document.querySelector('#view-tabs [data-subtab="groups"]').click();
    return true;
  `);
  await waitFor(
    () => evaluate(cdp, panelSession, `
      const name = document.querySelector('#manual-groups-container .group-name');
      return name?.textContent === 'Task 8 Synthetic Group';
    `),
    'synthetic manual-group card',
  );
  await evaluate(cdp, panelSession, `
    const button = Array.from(document.querySelectorAll('#manual-groups-container button'))
      .find((entry) => entry.textContent === 'Delete Group');
    button.click();
    return true;
  `);
  await waitFor(
    () => evaluate(cdp, panelSession, `
      return !document.querySelector('#confirm-overlay').hidden &&
        document.querySelector('#confirm-overlay .confirm-title')?.textContent === 'Delete group?';
    `),
    'manual-group confirmation dialog',
  );
  await evaluate(cdp, panelSession, `
    const button = Array.from(document.querySelectorAll('#confirm-overlay button'))
      .find((entry) => entry.textContent === 'Delete');
    button.click();
    return true;
  `);

  const deletedGroupState = await waitFor(
    () => evaluate(cdp, panelSession, `
      const state = await chrome.storage.local.get(['manualGroups', 'driveSyncTombstones']);
      const tombstone = state.driveSyncTombstones?.manualGroups?.['task8-synthetic-group'];
      if (Object.hasOwn(state.manualGroups || {}, 'task8-synthetic-group')) return null;
      if (!Number.isSafeInteger(tombstone)) return null;
      const successToast = Array.from(document.querySelectorAll('.toast.success span'))
        .some((node) => node.textContent === 'Group "Task 8 Synthetic Group" deleted');
      if (!successToast) return null;
      return {
        groupCount: Object.keys(state.manualGroups || {}).length,
        tombstone,
        deletionEvent: globalThis.__task8StorageEvents.find((event) =>
          event.keys.includes('manualGroups') && event.keys.includes('driveSyncTombstones') &&
          event.manualGroupsCount === 0 && event.manualGroupTombstones === 1) || null,
        successToast,
      };
    `),
    'atomic manual-group deletion',
  );
  if (!deletedGroupState.deletionEvent || deletedGroupState.tombstone < seedResult.baselineTimestamp) {
    throw new Error('Real-panel group deletion did not commit collection and tombstone together');
  }

  profileEntries = await countEntries(profile);
  const finalTree = await computeWorktreeTree();
  if (finalTree !== testedTree) {
    throw new Error('Tracked worktree content changed during the browser smoke; rerun on a stable tree');
  }
  console.log(JSON.stringify({
    browser: chromeVersion,
    binarySha256: chromeSha256,
    testedTree,
    extensionId,
    boundary: 'Real unpacked extension, production service worker, side-panel DOM actions, Chrome runtime messaging, and chrome.storage.local',
    liveDrivePassed: false,
    oauthBlocker: 'The disposable unpacked extension profile has no operator-authenticated Google test-user session and its generated extension ID has no registered matching OAuth client',
    sessionDeletion: {
      absentAfterDelete: deletedSessionState.sessionCount === 0,
      tombstoneSafeInteger: Number.isSafeInteger(deletedSessionState.tombstone),
      collectionAndTombstoneOneChangeEvent: Boolean(deletedSessionState.deletionEvent),
      successRenderedAfterCommit: deletedSessionState.successToast,
    },
    sessionUndo: {
      restoredExactlyOnce: restoredSessionState.matchingSessions === 1,
      modifiedAtStrictlyNewerThanTombstone: restoredSessionState.modifiedAt > restoredSessionState.tombstone,
      tombstoneRetainedUnchanged: restoredSessionState.tombstone === deletedSessionState.tombstone,
      successRenderedAfterCommit: restoredSessionState.successToast,
    },
    manualGroupDeletion: {
      absentAfterDelete: deletedGroupState.groupCount === 0,
      tombstoneSafeInteger: Number.isSafeInteger(deletedGroupState.tombstone),
      collectionAndTombstoneOneChangeEvent: Boolean(deletedGroupState.deletionEvent),
      successRenderedAfterCommit: deletedGroupState.successToast,
    },
    network: {
      policy: 'All extension HTTP(S) requests blocked at CDP request stage; host resolver also maps non-local hosts to NOTFOUND',
      interceptedBeforeNetwork: interceptedExternalRequests,
      externalRequestsReachedNetwork: 0,
    },
    exposedEvidence: 'Only key names, counts, timestamp comparisons, booleans, build/hash, tree hash, and generated extension ID; no token, authorization header, private URL, payload, or Drive response body',
    profileEntriesBeforeCleanup: profileEntries,
  }, null, 2));
} catch (error) {
  console.error(error.stack || error);
  console.error(`CHROME_ERROR_CHUNKS=${chromeErrors.length}`);
  process.exitCode = 1;
} finally {
  cdp?.close();
  await stopProcess(chrome);
  if (chrome) {
    const pkill = Bun.spawn(['pkill', '-TERM', '-f', profile], { stdout: 'ignore', stderr: 'ignore' });
    await pkill.exited.catch(() => {});
  }
  await stopProcess(xvfb);
  await rm(profile, { recursive: true, force: true });
  let profileRemoved = false;
  try { await stat(profile); } catch { profileRemoved = true; }
  console.log(`CLEANUP_PROFILE_REMOVED=${profileRemoved ? 1 : 0}`);
  console.log(`CLEANUP_CHROME_PROCESS_EXITED=${chrome ? Number((await chrome.exited) !== null) : 1}`);
  console.log(`CLEANUP_XVFB_PROCESS_EXITED=${xvfb ? Number((await xvfb.exited) !== null) : 1}`);
}
