import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromeBinary = '/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const extensionPath = '/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening';
const displayNumber = 100;
const display = `127.0.0.1:${displayNumber}.0`;
const timeoutMs = 20_000;
const expectedChromeVersion = 'Google Chrome for Testing 148.0.7778.96';
const expectedChromeSha256 = 'adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f';
const affectedLocalKeys = [
  'sessions',
  'manualGroups',
  'keepAwakeDomains',
  'tabkebabBookmarks',
  'tabkebabSettings',
  'focusProfilePrefs',
  'focusHistory',
  'aiSettings',
];

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
    this.onRequestPaused = null;
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
    if (message.method === 'Fetch.requestPaused') {
      this.onRequestPaused?.(message.sessionId, message.params);
    }
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

async function evaluate(cdp, sessionId, operation) {
  const response = await cdp.send('Runtime.evaluate', {
    expression: `(${operation.toString()})()`,
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
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed with exit ${result.exitCode}`);
  return new TextDecoder().decode(result.stdout).trim();
}

async function computeWorktreeTree() {
  const indexDirectory = await mkdtemp(join(tmpdir(), 'tabkebab-task10-index.'));
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

function collectForbiddenKeys(value, path = 'root', found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    const exact = new Set([
      'apikey', 'token', 'credential', 'password', 'secret', 'authorization',
      'installid', 'focusstate', 'drivesync', 'driveprofilename',
      'focusgroupownership', 'tabkebabsettingsprevious', 'usepassphrase',
    ]);
    const cache = lower === 'cache' || lower.startsWith('cache') ||
      lower.endsWith('cache') || lower.includes('cached') ||
      lower.startsWith('aidecryptedkey_');
    if (exact.has(lower) || cache) found.push(`${path}.${key}`);
    collectForbiddenKeys(child, `${path}.${key}`, found);
  }
  return found;
}

const testedTree = await computeWorktreeTree();
const requestedTree = process.env.TASK10_TREE_HASH;
if (requestedTree && requestedTree !== testedTree) {
  throw new Error('TASK10_TREE_HASH does not match the exact current worktree tree');
}

const chromeVersion = runChecked([chromeBinary, '--version']);
const chromeSha256 = runChecked(['sha256sum', chromeBinary]).split(/\s+/)[0];
if (chromeVersion !== expectedChromeVersion || chromeSha256 !== expectedChromeSha256) {
  throw new Error('Installed Chrome for Testing build/hash does not match the approved fixture');
}

const profile = await mkdtemp(join(tmpdir(), 'tabkebab-task10-browser.'));
const downloadDirectory = await mkdtemp(join(tmpdir(), 'tabkebab-task10-download.'));
let xvfb;
let chrome;
let cdp;
let extensionId = null;
let profileEntries = 0;
let interceptedExternalRequests = 0;
const chromeErrors = [];

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
  cdp.onRequestPaused = (sessionId, event) => {
    interceptedExternalRequests += 1;
    void cdp.send('Fetch.failRequest', {
      requestId: event.requestId,
      errorReason: 'BlockedByClient',
    }, sessionId).catch(() => {});
  };
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDirectory,
    eventsEnabled: true,
  });

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
      const name = await evaluate(cdp, attached.sessionId, () => {
        return globalThis.chrome?.runtime?.getManifest?.().name || null;
      }).catch(() => null);
      if (name === 'TabKebab') {
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
  await cdp.send('DOM.enable', {}, panelSession);
  await waitFor(
    () => evaluate(cdp, panelSession, () => document.readyState === 'complete'),
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

  const seeded = await evaluate(cdp, panelSession, async () => {
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
    const replaceStashes = async (records) => {
      const db = await openStashDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('stashes', 'readwrite');
        const store = tx.objectStore('stashes');
        store.clear();
        for (const record of records) store.put(record);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    };
    const tab = { title: 'Synthetic portable tab', url: 'https://portable.invalid/tab' };
    const session = {
      id: 'task10-session',
      name: 'Task 10 Session',
      version: 2,
      createdAt: 1_000,
      modifiedAt: 1_000,
      windows: [{ tabCount: 1, tabs: [tab] }],
    };
    const stash = {
      id: 'task10-stash',
      name: 'Task 10 Stash',
      createdAt: 2_000,
      tabCount: 1,
      windows: [{ tabCount: 1, tabs: [tab] }],
    };
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      sessions: [session],
      manualGroups: {
        'task10-group': {
          name: 'Task 10 Group',
          color: 'blue',
          createdAt: 3_000,
          modifiedAt: 3_000,
          tabUrls: [tab.url],
        },
      },
      keepAwakeDomains: ['portable.invalid'],
      tabkebabBookmarks: [{
        id: 'task10-bookmark',
        createdAt: 4_000,
        date: '2026-07-19',
        time: '12:00 PM',
      }],
      tabkebabSettings: { theme: 'dark' },
      focusProfilePrefs: { coding: { duration: 25, strictMode: true } },
      focusHistory: [{
        runId: 'task10-run',
        profileId: 'coding',
        startedAt: 5_000,
        endedAt: 6_000,
      }],
      aiSettings: {
        enabled: true,
        providerId: 'openai',
        usePassphrase: true,
        providerConfigs: {
          openai: {
            model: 'gpt-4.1-nano',
            apiKey: {
              ciphertext: 'synthetic-ciphertext',
              salt: 'synthetic-salt',
              iv: 'synthetic-iv',
              usesPassphrase: true,
            },
          },
        },
      },
      driveSync: { token: 'synthetic-excluded-token' },
      driveProfileName: 'synthetic-excluded-profile',
      focusState: { runId: 'synthetic-excluded-state' },
      installId: 'synthetic-excluded-install',
      aiDecryptedKey_openai: 'synthetic-excluded-cache',
      unrelatedSentinel: { value: 'preserve-me' },
    });
    await replaceStashes([stash]);
    return { affectedLocalKeyCount: 8, stashCount: 1 };
  });
  if (seeded.affectedLocalKeyCount !== 8 || seeded.stashCount !== 1) {
    throw new Error('Synthetic profile seeding did not complete');
  }

  await evaluate(cdp, panelSession, () => {
    document.querySelector('#btn-export').click();
    return true;
  });
  await waitFor(
    () => evaluate(cdp, panelSession, () => {
      return Array.from(document.querySelectorAll('.toast.success span'))
        .some((node) => node.textContent === 'Data exported');
    }),
    'real-panel export success',
  );

  const downloadedFile = await waitFor(async () => {
    const names = (await readdir(downloadDirectory))
      .filter((name) => /^tabkebab-export-\d+\.json$/.test(name));
    if (names.length !== 1) return null;
    const path = join(downloadDirectory, names[0]);
    return (await stat(path)).size > 0 ? path : null;
  }, 'portable export download');
  const exported = JSON.parse(await readFile(downloadedFile, 'utf8'));
  const forbiddenKeys = collectForbiddenKeys(exported);
  const expectedEnvelope = [
    'aiSettings', 'bookmarks', 'exportedAt', 'focusHistory', 'focusProfilePrefs',
    'keepAwakeDomains', 'kind', 'manualGroups', 'sessions', 'settings',
    'stashes', 'version',
  ];
  const envelopeKeys = Object.keys(exported).sort();
  if (JSON.stringify(envelopeKeys) !== JSON.stringify(expectedEnvelope) ||
      exported.version !== 2 || exported.kind !== 'full') {
    throw new Error('Downloaded document does not match the canonical full-v2 envelope');
  }
  if (forbiddenKeys.length > 0) {
    throw new Error(`Downloaded document exposed forbidden keys: ${forbiddenKeys.join(', ')}`);
  }

  await evaluate(cdp, panelSession, async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('TabKebabStash', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('stashes', 'readwrite');
      tx.objectStore('stashes').clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await chrome.storage.local.remove([
      'sessions',
      'manualGroups',
      'keepAwakeDomains',
      'tabkebabBookmarks',
      'tabkebabSettings',
      'focusProfilePrefs',
      'focusHistory',
      'aiSettings',
    ]);
    return true;
  });

  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, panelSession);
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '#btn-import',
  }, panelSession);
  if (!nodeId) throw new Error('Portable import file input was not found');
  await cdp.send('DOM.setFileInputFiles', { files: [downloadedFile], nodeId }, panelSession);

  const successText = await waitFor(
    () => evaluate(cdp, panelSession, () => {
      return Array.from(document.querySelectorAll('.toast.success span'))
        .map((node) => node.textContent)
        .find((text) => text === 'Data import complete — 5 new records, 0 duplicates skipped') || null;
    }),
    'real-panel import success summary',
  );

  const restored = await evaluate(cdp, panelSession, async () => {
    const state = await chrome.storage.local.get(null);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('TabKebabStash', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stashes = await new Promise((resolve, reject) => {
      const tx = db.transaction('stashes', 'readonly');
      const request = tx.objectStore('stashes').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const presentAffectedKeys = [
      'sessions',
      'manualGroups',
      'keepAwakeDomains',
      'tabkebabBookmarks',
      'tabkebabSettings',
      'focusProfilePrefs',
      'focusHistory',
      'aiSettings',
    ].filter((key) => Object.hasOwn(state, key));
    return {
      presentAffectedKeyCount: presentAffectedKeys.length,
      sessionRestored: state.sessions?.length === 1 &&
        state.sessions[0]?.id === 'task10-session',
      groupRestored: Object.hasOwn(state.manualGroups || {}, 'task10-group'),
      keepAwakeRestored: state.keepAwakeDomains?.length === 1 &&
        state.keepAwakeDomains[0] === 'portable.invalid',
      bookmarkRestored: state.tabkebabBookmarks?.length === 1 &&
        state.tabkebabBookmarks[0]?.id === 'task10-bookmark',
      settingsRestored: state.tabkebabSettings?.theme === 'dark',
      focusPrefsRestored: state.focusProfilePrefs?.coding?.strictMode === true,
      focusHistoryRestored: state.focusHistory?.length === 1 &&
        state.focusHistory[0]?.runId === 'task10-run',
      aiPublicConfigRestored: state.aiSettings?.enabled === true &&
        state.aiSettings?.providerId === 'openai' &&
        state.aiSettings?.providerConfigs?.openai?.model === 'gpt-4.1-nano',
      aiSecretAbsent: !Object.hasOwn(state.aiSettings || {}, 'usePassphrase') &&
        !Object.hasOwn(state.aiSettings?.providerConfigs?.openai || {}, 'apiKey'),
      stashRestored: stashes.length === 1 && stashes[0]?.id === 'task10-stash',
      unrelatedPreserved: state.unrelatedSentinel?.value === 'preserve-me' &&
        state.driveProfileName === 'synthetic-excluded-profile' &&
        state.installId === 'synthetic-excluded-install' &&
        state.focusState?.runId === 'synthetic-excluded-state' &&
        state.aiDecryptedKey_openai === 'synthetic-excluded-cache' &&
        state.driveSync?.token === 'synthetic-excluded-token',
    };
  });
  if (!Object.entries(restored).every(([, value]) => value === true || value === 8)) {
    throw new Error(`Restored state did not match the synthetic source: ${JSON.stringify(restored)}`);
  }

  profileEntries = await countEntries(profile);
  const finalTree = await computeWorktreeTree();
  if (finalTree !== testedTree) {
    throw new Error('Tracked worktree content changed during the browser smoke');
  }

  console.log(JSON.stringify({
    browser: chromeVersion,
    binarySha256: chromeSha256,
    testedTree,
    extensionId,
    boundary: 'Real unpacked extension, production service worker, side-panel export click, downloaded JSON file, side-panel file-input import, chrome.storage.local, and IndexedDB',
    export: {
      canonicalFullV2Envelope: true,
      recursiveForbiddenKeyCount: forbiddenKeys.length,
      affectedLocalSections: affectedLocalKeys.length,
      stashRecords: exported.stashes.length,
    },
    cleanImport: {
      successText,
      ...restored,
    },
    network: {
      policy: 'All extension HTTP(S) requests blocked at CDP request stage; host resolver also maps non-local hosts to NOTFOUND',
      interceptedBeforeNetwork: interceptedExternalRequests,
      externalRequestsReachedNetwork: 0,
    },
    exposedEvidence: 'Only key names, counts, booleans, build/hash, tree hash, and generated extension ID; no token, private URL, exported payload, or storage value',
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
  await rm(downloadDirectory, { recursive: true, force: true });
  let profileRemoved = false;
  let downloadRemoved = false;
  try { await stat(profile); } catch { profileRemoved = true; }
  try { await stat(downloadDirectory); } catch { downloadRemoved = true; }
  console.log(`CLEANUP_PROFILE_REMOVED=${profileRemoved ? 1 : 0}`);
  console.log(`CLEANUP_DOWNLOAD_REMOVED=${downloadRemoved ? 1 : 0}`);
  console.log(`CLEANUP_CHROME_PROCESS_EXITED=${chrome ? Number((await chrome.exited) !== null) : 1}`);
  console.log(`CLEANUP_XVFB_PROCESS_EXITED=${xvfb ? Number((await xvfb.exited) !== null) : 1}`);
}
