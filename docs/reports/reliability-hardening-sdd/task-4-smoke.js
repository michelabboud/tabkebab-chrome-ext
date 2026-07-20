import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromeBinary = '/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const extensionPath = '/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening';
const displayNumber = 94;
const display = `127.0.0.1:${displayNumber}.0`;
const timeoutMs = 15_000;

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
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => this._handleMessage(event.data));
    this.socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  _handleMessage(data) {
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
      if (waiter.method !== message.method) continue;
      if (waiter.sessionId && waiter.sessionId !== message.sessionId) continue;
      if (!waiter.predicate(message.params || {})) continue;
      this.eventWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params || {});
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitForEvent(method, predicate, sessionId = undefined, timeout = timeoutMs) {
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

const profile = await mkdtemp(join(tmpdir(), 'tabkebab-task4-focus.'));
let xvfb;
let chrome;
let cdp;
let profileEntries = 0;
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

  const worker = await waitFor(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((target) =>
      target.type === 'service_worker' &&
      target.url.startsWith('chrome-extension://') &&
      target.url.endsWith('/service-worker.js'));
  }, 'TabKebab service worker target');
  const extensionId = new URL(worker.url).hostname;
  const { sessionId: workerSession } = await cdp.send('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  });
  await cdp.send('Runtime.enable', {}, workerSession);
  await cdp.send('Network.enable', {}, workerSession);
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: 'https://api.openai.com/*', requestStage: 'Request' }],
  }, workerSession);

  const { targetId: pageTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/sidepanel/panel.html`,
  });
  const { sessionId: pageSession } = await cdp.send('Target.attachToTarget', {
    targetId: pageTargetId,
    flatten: true,
  });
  await cdp.send('Runtime.enable', {}, pageSession);
  await waitFor(
    () => evaluate(cdp, pageSession, 'return document.readyState === "complete";'),
    'side-panel document load',
  );

  await evaluate(cdp, pageSession, `
    globalThis.__focusSmokeEvents = [];
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'focusDistraction' || message?.type === 'focusEnded') {
        globalThis.__focusSmokeEvents.push(structuredClone(message));
      }
    });
    await chrome.runtime.sendMessage({
      action: 'saveAISettings',
      settings: {
        enabled: true,
        providerId: 'custom',
        providerConfigs: {
          custom: {
            baseUrl: 'https://api.openai.com/v1',
            model: 'task4-cdp-synthetic',
          },
        },
        usePassphrase: false,
      },
    });
    return true;
  `);

  const completionBody = Buffer.from(JSON.stringify({
    id: 'task4-cdp-synthetic',
    object: 'chat.completion',
    choices: [{
      message: {
        role: 'assistant',
        content: JSON.stringify({
          distraction: true,
          category: 'synthetic-smoke',
          confidence: 0.99,
        }),
      },
    }],
    usage: { total_tokens: 1 },
  })).toString('base64');

  async function send(message) {
    return evaluate(cdp, pageSession, `
      return await chrome.runtime.sendMessage(${JSON.stringify(message)});
    `);
  }

  async function createHistoryTab(caseName) {
    const baseUrl = `https://task4-${caseName}-base.invalid/history`;
    const tab = await evaluate(cdp, pageSession, `
      return await chrome.tabs.create({ url: ${JSON.stringify(baseUrl)}, active: false });
    `);
    await waitFor(async () => {
      const current = await evaluate(cdp, pageSession, `return await chrome.tabs.get(${tab.id});`);
      return current?.url === baseUrl;
    }, `${caseName} base history URL`);
    await delay(200);
    return tab.id;
  }

  async function startRun(allowedDomains = []) {
    return send({
      action: 'startFocus',
      profileId: 'coding',
      duration: 25,
      tabAction: 'none',
      allowedDomains,
      blockedDomains: [],
      strictMode: false,
      blockedCategories: [],
      aiBlocking: true,
    });
  }

  async function navigate(tabId, url) {
    const request = cdp.waitForEvent(
      'Fetch.requestPaused',
      (event) => event.request?.url === 'https://api.openai.com/v1/chat/completions',
      workerSession,
    );
    await evaluate(cdp, pageSession, `
      return await chrome.tabs.update(${tabId}, { url: ${JSON.stringify(url)} });
    `);
    return request;
  }

  async function fulfill(requestId) {
    await cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responsePhrase: 'OK',
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Access-Control-Allow-Origin', value: '*' },
      ],
      body: completionBody,
    }, workerSession);
    await delay(1_200);
  }

  async function inspect(tabId) {
    return evaluate(cdp, pageSession, `
      const [tab, state, badgeText, badgeColor] = await Promise.all([
        chrome.tabs.get(${tabId}).catch(() => null),
        chrome.runtime.sendMessage({ action: 'getFocusState' }),
        chrome.action.getBadgeText({}),
        chrome.action.getBadgeBackgroundColor({}),
      ]);
      return {
        tab,
        state,
        badgeText,
        badgeColor,
        events: structuredClone(globalThis.__focusSmokeEvents),
      };
    `);
  }

  const results = {};

  {
    const tabId = await createHistoryTab('pause');
    const run = await startRun();
    await evaluate(cdp, pageSession, 'globalThis.__focusSmokeEvents = []; return true;');
    const classifiedUrl = 'https://task4-pause-classified.invalid/path';
    const held = await navigate(tabId, classifiedUrl);
    const paused = await send({ action: 'pauseFocus', expectedRunId: run.runId });
    if (paused?.status !== 'paused' || paused.runId !== run.runId) {
      throw new Error('Pause case did not establish paused authority before release');
    }
    await fulfill(held.requestId);
    const observed = await inspect(tabId);
    results.pause = {
      requestHeld: true,
      runPreserved: observed.state?.runId === run.runId,
      status: observed.state?.status,
      tabExists: Boolean(observed.tab),
      urlPreserved: observed.tab?.url === classifiedUrl,
      distractionsBlocked: observed.state?.distractionsBlocked,
      badgeText: observed.badgeText,
      staleEventCount: observed.events.length,
    };
    if (!results.pause.runPreserved || results.pause.status !== 'paused' ||
        !results.pause.tabExists || !results.pause.urlPreserved ||
        results.pause.distractionsBlocked !== 0 || results.pause.badgeText !== '||' ||
        results.pause.staleEventCount !== 0) {
      throw new Error(`Pause case failed: ${JSON.stringify(results.pause)}`);
    }
  }

  {
    const tabId = await createHistoryTab('end');
    const endedRun = await startRun();
    await evaluate(cdp, pageSession, 'globalThis.__focusSmokeEvents = []; return true;');
    const classifiedUrl = 'https://task4-end-classified.invalid/path';
    const held = await navigate(tabId, classifiedUrl);
    const record = await send({ action: 'endFocus', expectedRunId: endedRun.runId });
    if (record?.runId !== endedRun.runId) {
      throw new Error('End case did not finish the originating run before release');
    }
    const replacement = await startRun();
    const pausedReplacement = await send({
      action: 'pauseFocus',
      expectedRunId: replacement.runId,
    });
    if (pausedReplacement?.runId !== replacement.runId) {
      throw new Error('End case did not establish replacement authority before release');
    }
    await fulfill(held.requestId);
    const observed = await inspect(tabId);
    results.end = {
      requestHeld: true,
      endedRunRecorded: record.runId === endedRun.runId,
      replacementPreserved: observed.state?.runId === replacement.runId,
      replacementStatus: observed.state?.status,
      tabExists: Boolean(observed.tab),
      urlPreserved: observed.tab?.url === classifiedUrl,
      replacementDistractionsBlocked: observed.state?.distractionsBlocked,
      badgeText: observed.badgeText,
      staleEventCount: observed.events.length,
    };
    if (!results.end.endedRunRecorded || !results.end.replacementPreserved ||
        results.end.replacementStatus !== 'paused' || !results.end.tabExists ||
        !results.end.urlPreserved || results.end.replacementDistractionsBlocked !== 0 ||
        results.end.badgeText !== '||' || results.end.staleEventCount !== 0) {
      throw new Error(`End case failed: ${JSON.stringify(results.end)}`);
    }
  }

  {
    const tabId = await createHistoryTab('pause-resume');
    const run = await startRun();
    await evaluate(cdp, pageSession, 'globalThis.__focusSmokeEvents = []; return true;');
    const classifiedUrl = 'https://task4-pause-resume-classified.invalid/path';
    const held = await navigate(tabId, classifiedUrl);
    const paused = await send({ action: 'pauseFocus', expectedRunId: run.runId });
    if (paused?.status !== 'paused' || paused.runId !== run.runId) {
      throw new Error('Pause-resume case did not establish paused authority');
    }
    const resumed = await send({ action: 'resumeFocus', expectedRunId: run.runId });
    if (resumed?.status !== 'active' || resumed.runId !== run.runId) {
      throw new Error('Pause-resume case did not re-establish active authority');
    }
    await fulfill(held.requestId);
    const observed = await inspect(tabId);
    results.pauseResume = {
      requestHeld: true,
      runPreserved: observed.state?.runId === run.runId,
      status: observed.state?.status,
      tabExists: Boolean(observed.tab),
      urlPreserved: observed.tab?.url === classifiedUrl,
      distractionsBlocked: observed.state?.distractionsBlocked,
      badgeText: observed.badgeText,
      staleEventCount: observed.events.length,
    };
    if (!results.pauseResume.runPreserved || results.pauseResume.status !== 'active' ||
        !results.pauseResume.tabExists || !results.pauseResume.urlPreserved ||
        results.pauseResume.distractionsBlocked !== 0 ||
        results.pauseResume.badgeText === '!' || results.pauseResume.staleEventCount !== 0) {
      throw new Error(`Pause-resume case failed: ${JSON.stringify(results.pauseResume)}`);
    }
  }

  {
    const tabId = await createHistoryTab('navigate');
    const safeUrl = 'https://task4-safe-navigation.invalid/landing';
    const run = await startRun([{ type: 'url', value: safeUrl }]);
    await evaluate(cdp, pageSession, 'globalThis.__focusSmokeEvents = []; return true;');
    const classifiedUrl = 'https://task4-navigate-classified.invalid/path';
    const held = await navigate(tabId, classifiedUrl);
    await evaluate(cdp, pageSession, `
      return await chrome.tabs.update(${tabId}, { url: ${JSON.stringify(safeUrl)} });
    `);
    await waitFor(async () => {
      const tab = await evaluate(cdp, pageSession, `return await chrome.tabs.get(${tabId});`);
      return tab?.url === safeUrl;
    }, 'navigation-away URL');
    await fulfill(held.requestId);
    const observed = await inspect(tabId);
    results.navigateAway = {
      requestHeld: true,
      runPreserved: observed.state?.runId === run.runId,
      status: observed.state?.status,
      tabExists: Boolean(observed.tab),
      newUrlPreserved: observed.tab?.url === safeUrl,
      distractionsBlocked: observed.state?.distractionsBlocked,
      badgeText: observed.badgeText,
      staleEventCount: observed.events.length,
    };
    if (!results.navigateAway.runPreserved || results.navigateAway.status !== 'active' ||
        !results.navigateAway.tabExists || !results.navigateAway.newUrlPreserved ||
        results.navigateAway.distractionsBlocked !== 0 || results.navigateAway.badgeText === '!' ||
        results.navigateAway.staleEventCount !== 0) {
      throw new Error(`Navigate-away case failed: ${JSON.stringify(results.navigateAway)}`);
    }
  }

  const cleanupRun = await send({ action: 'getFocusState' });
  if (cleanupRun?.runId) {
    await send({ action: 'endFocus', expectedRunId: cleanupRun.runId });
  }
  profileEntries = await countEntries(profile);
  console.log(JSON.stringify({
    browser: 'Google Chrome for Testing 148.0.7778.96',
    binarySha256: 'adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f',
    providerBoundary: 'CDP-synthetic OpenAI-compatible response',
    extensionId,
    results,
    profileEntriesBeforeCleanup: profileEntries,
  }, null, 2));
} catch (error) {
  console.error(error.stack || error);
  if (chromeErrors.length) console.error(chromeErrors.join('').slice(-8_000));
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
