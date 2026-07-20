import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromeBinary = '/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const extensionPath = '/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening';
const displayNumber = 95;
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
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
    else pending.resolve(message.result || {});
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

const profile = await mkdtemp(join(tmpdir(), 'tabkebab-task5.'));
const tlsDirectory = await mkdtemp(join(tmpdir(), 'tabkebab-task5-tls.'));
const keyPath = join(tlsDirectory, 'key.pem');
const certPath = join(tlsDirectory, 'cert.pem');
let fixtureServer;
let xvfb;
let chrome;
let cdp;
let profileEntries = 0;
const chromeErrors = [];
const fixtureRequests = [];

try {
  const openssl = Bun.spawn([
    'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=github.com',
    '-addext', 'subjectAltName=DNS:github.com,DNS:docs.github.com,DNS:notgithub.com,DNS:github.com.evil.test,DNS:app.test,IP:127.0.0.1',
  ], { stdout: 'ignore', stderr: 'ignore' });
  if (await openssl.exited !== 0) throw new Error('Failed to create disposable TLS certificate');

  const completion = {
    id: 'task5-loopback-synthetic',
    object: 'chat.completion',
    choices: [{
      message: {
        role: 'assistant',
        content: JSON.stringify({
          action: 'close',
          filter: { domain: 'github.com' },
          confirmation: 'Close synthetic GitHub fixtures?',
        }),
      },
    }],
    usage: { total_tokens: 1 },
  };
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Private-Network': 'true',
  };
  fixtureServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: {
      key: await readFile(keyPath, 'utf8'),
      cert: await readFile(certPath, 'utf8'),
    },
    async fetch(request) {
      const url = new URL(request.url);
      fixtureRequests.push({ method: request.method, host: url.host, path: url.pathname });
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      if (url.pathname === '/v1/chat/completions') {
        return Response.json(completion, { headers: corsHeaders });
      }
      return new Response(
        `<!doctype html><title>${url.hostname}${url.pathname}</title><h1>${url.href}</h1>`,
        { headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' } },
      );
    },
  });

  xvfb = Bun.spawn([
    'Xvfb', `:${displayNumber}`, '-screen', '0', '1280x900x24',
    '-nolisten', 'unix', '-listen', 'tcp', '-ac',
  ], { stdout: 'ignore', stderr: 'pipe' });
  void (async () => {
    for await (const chunk of xvfb.stderr) chromeErrors.push(`XVFB ${new TextDecoder().decode(chunk)}`);
  })();
  await delay(500);
  if (xvfb.exitCode !== null) throw new Error('Xvfb exited before Chrome launch');

  const mappedHosts = [
    'github.com',
    'docs.github.com',
    'notgithub.com',
    'github.com.evil.test',
    'app.test',
  ];
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
    '--ignore-certificate-errors',
    '--allow-insecure-localhost',
    `--host-resolver-rules=${mappedHosts.map((host) => `MAP ${host} 127.0.0.1`).join(', ')}`,
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

  async function send(message) {
    return evaluate(cdp, panelSession, `
      return await chrome.runtime.sendMessage(${JSON.stringify(message)});
    `);
  }

  await evaluate(cdp, panelSession, `
    const blanks = (await chrome.tabs.query({})).filter((tab) => tab.url === 'about:blank');
    if (blanks.length) await chrome.tabs.remove(blanks.map((tab) => tab.id));
    await chrome.runtime.sendMessage({ action: 'clearAICache' });
    await chrome.runtime.sendMessage({
      action: 'saveAISettings',
      settings: {
        enabled: true,
        providerId: 'custom',
        providerConfigs: {
          custom: {
            baseUrl: ${JSON.stringify(`https://127.0.0.1:${fixtureServer.port}/v1`)},
            model: 'task5-loopback-synthetic',
          },
        },
        usePassphrase: false,
      },
    });
    return true;
  `);

  async function createFixture(url) {
    const tab = await evaluate(cdp, panelSession, `
      return await chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false });
    `);
    await waitFor(async () => {
      const current = await evaluate(cdp, panelSession, `
        return await chrome.tabs.get(${tab.id}).catch(() => null);
      `);
      return current?.url === url && current?.status === 'complete';
    }, `fixture tab ${url}`);
    return tab.id;
  }

  const port = fixtureServer.port;
  const domainUrls = {
    exact: `https://github.com:${port}/exact`,
    subdomain: `https://docs.github.com:${port}/subdomain`,
    suffixLookalike: `https://notgithub.com:${port}/suffix`,
    siblingLookalike: `https://github.com.evil.test:${port}/sibling`,
  };
  const domainIds = {};
  for (const [name, url] of Object.entries(domainUrls)) domainIds[name] = await createFixture(url);

  const nlPreview = await send({
    action: 'executeNLCommand',
    command: `task5-${Date.now()}: close GitHub fixtures`,
  });
  const previewIds = [...(nlPreview?.parsedCommand?.tabIds || [])].sort((a, b) => a - b);
  const expectedPreviewIds = [domainIds.exact, domainIds.subdomain].sort((a, b) => a - b);
  if (JSON.stringify(previewIds) !== JSON.stringify(expectedPreviewIds)) {
    throw new Error(`NL preview identity mismatch: ${JSON.stringify({ nlPreview, domainIds })}`);
  }

  const duplicateUrls = {
    ordinary: `https://app.test:${port}/ordinary?view=all#anchor`,
    routeOne: `https://app.test:${port}/#/one`,
    routeTwo: `https://app.test:${port}/#/two`,
  };
  const duplicateIds = {};
  for (const [name, url] of Object.entries(duplicateUrls)) {
    duplicateIds[name] = [await createFixture(url), await createFixture(url)];
  }
  const newTabIds = [
    await createFixture('chrome://newtab/'),
    await createFixture('chrome://newtab/'),
  ];

  const actualNewTabs = await evaluate(cdp, panelSession, `
    return await Promise.all(${JSON.stringify(newTabIds)}.map((id) => chrome.tabs.get(id)));
  `);
  const directScan = await evaluate(cdp, panelSession, `
    const [duplicates, emptyPages] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'findDuplicates' }),
      chrome.runtime.sendMessage({ action: 'findEmptyPages' }),
    ]);
    return { duplicates, emptyPages };
  `);
  const directDuplicateIds = directScan.duplicates.flatMap((group) => group.tabs.map((tab) => tab.id));
  const directEmptyIds = directScan.emptyPages.map((tab) => tab.id);
  if (newTabIds.some((id) => directDuplicateIds.includes(id) || directEmptyIds.includes(id))) {
    throw new Error(`Chrome new-tab fixture leaked into cleanup results: ${JSON.stringify(directScan)}`);
  }
  const expectedGroupUrls = Object.values(duplicateUrls).sort();
  const directGroupUrls = directScan.duplicates.map((group) => group.url).sort();
  if (JSON.stringify(directGroupUrls) !== JSON.stringify(expectedGroupUrls)) {
    throw new Error(`Direct duplicate groups mismatch: ${JSON.stringify(directGroupUrls)}`);
  }

  await evaluate(cdp, panelSession, `
    document.querySelector('[data-subtab="duplicates"]').click();
    return true;
  `);
  await waitFor(
    () => evaluate(cdp, panelSession, `
      return document.querySelectorAll('#duplicate-list .duplicate-group').length === 3;
    `),
    'initial duplicate UI refresh',
  );
  await evaluate(cdp, panelSession, `
    document.querySelector('#btn-scan-dupes').click();
    return true;
  `);
  await waitFor(
    () => evaluate(cdp, panelSession, `
      const groups = document.querySelectorAll('#duplicate-list .duplicate-group');
      const button = document.querySelector('#btn-close-all-dupes');
      return groups.length === 3 && button?.textContent === 'Close All Duplicates (3)';
    `),
    'explicit duplicate UI scan',
  );
  const uiScan = await evaluate(cdp, panelSession, `
    return {
      groupUrls: Array.from(document.querySelectorAll('#duplicate-list .dupe-url'), (node) => node.textContent),
      selectedIds: Array.from(document.querySelectorAll('#duplicate-list input:checked'), (node) => Number(node.dataset.tabId)),
      emptyRowHidden: document.querySelector('#empty-pages-row').hidden,
      emptyCount: document.querySelector('#empty-pages-count').textContent,
    };
  `);
  if (JSON.stringify([...uiScan.groupUrls].sort()) !== JSON.stringify(expectedGroupUrls) ||
      uiScan.selectedIds.length !== 3 ||
      newTabIds.some((id) => uiScan.selectedIds.includes(id))) {
    throw new Error(`Duplicate UI scan mismatch: ${JSON.stringify(uiScan)}`);
  }

  const countDuplicateFixtures = () => evaluate(cdp, panelSession, `
    const expected = ${JSON.stringify(duplicateUrls)};
    const tabs = await chrome.tabs.query({});
    return Object.fromEntries(Object.entries(expected).map(([name, url]) => [
      name,
      tabs.filter((tab) => tab.url === url).length,
    ]));
  `);

  await evaluate(cdp, panelSession, `
    document.querySelector('#btn-close-all-dupes').click();
    return true;
  `);
  const countsAfterClose = await waitFor(async () => {
    const counts = await countDuplicateFixtures();
    return Object.values(counts).every((count) => count === 1) ? counts : null;
  }, 'one preserved copy of every duplicate URL');
  await waitFor(
    () => evaluate(cdp, panelSession, `
      const action = document.querySelector('.toast-action');
      return action?.textContent === 'Undo';
    `),
    'duplicate Undo toast',
  );
  await evaluate(cdp, panelSession, `
    document.querySelector('.toast-action').click();
    return true;
  `);
  const countsAfterUndo = await waitFor(async () => {
    const counts = await countDuplicateFixtures();
    return Object.values(counts).every((count) => count === 2) ? counts : null;
  }, 'two exact copies of every duplicate URL after Undo');

  const finalNewTabs = await evaluate(cdp, panelSession, `
    return await Promise.all(${JSON.stringify(newTabIds)}.map((id) => chrome.tabs.get(id).catch(() => null)));
  `);
  if (finalNewTabs.some((tab) => !tab)) {
    throw new Error(`Chrome new-tab fixtures did not survive duplicate cleanup: ${JSON.stringify(finalNewTabs)}`);
  }

  profileEntries = await countEntries(profile);
  console.log(JSON.stringify({
    browser: 'Google Chrome for Testing 148.0.7778.96',
    binarySha256: 'adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f',
    providerBoundary: 'Loopback-only OpenAI-compatible server with a synthetic NL parse; no external model or network call',
    extensionId,
    fixtureServerPort: fixtureServer.port,
    nlDomainPreview: {
      exactAccepted: previewIds.includes(domainIds.exact),
      subdomainAccepted: previewIds.includes(domainIds.subdomain),
      suffixLookalikeRejected: !previewIds.includes(domainIds.suffixLookalike),
      siblingLookalikeRejected: !previewIds.includes(domainIds.siblingLookalike),
      previewIds,
      fixtureIds: domainIds,
    },
    duplicates: {
      directGroupUrls,
      uiScan,
      countsAfterClose,
      countsAfterUndo,
    },
    chromeNewTab: {
      ids: newTabIds,
      actualUrls: actualNewTabs.map((tab) => tab.url),
      excludedFromDuplicates: newTabIds.every((id) => !directDuplicateIds.includes(id)),
      excludedFromEmptyCleanup: newTabIds.every((id) => !directEmptyIds.includes(id)),
      survivedCleanup: finalNewTabs.every(Boolean),
    },
    fixtureRequests,
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
  fixtureServer?.stop(true);
  await rm(profile, { recursive: true, force: true });
  await rm(tlsDirectory, { recursive: true, force: true });
  let profileRemoved = false;
  let tlsRemoved = false;
  try { await stat(profile); } catch { profileRemoved = true; }
  try { await stat(tlsDirectory); } catch { tlsRemoved = true; }
  console.log(`CLEANUP_PROFILE_REMOVED=${profileRemoved ? 1 : 0}`);
  console.log(`CLEANUP_TLS_REMOVED=${tlsRemoved ? 1 : 0}`);
  console.log(`CLEANUP_CHROME_PROCESS_EXITED=${chrome ? Number((await chrome.exited) !== null) : 1}`);
  console.log(`CLEANUP_XVFB_PROCESS_EXITED=${xvfb ? Number((await xvfb.exited) !== null) : 1}`);
}
