import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { AICache } from '../../core/ai/cache.js';
import { AIClient } from '../../core/ai/ai-client.js';
import {
  ChromeAIBrokerClient,
  chromeAIBrokerClient,
} from '../../core/ai/chrome-ai-broker-client.js';
import { CHROME_AI_PORT_NAME } from '../../core/ai/chrome-ai-protocol.js';
import { AIAbortError, AITimeoutError } from '../../core/ai/provider.js';
import { runAbortableAttempt } from '../../core/ai/request-lifecycle.js';
import { startChromeAIBroker } from '../../sidepanel/chrome-ai-broker.js';
import { deferred } from '../helpers/deferred.js';
import {
  createRuntimePortPair,
  installChromeMock,
  installWebLocksMock,
  readStorageArea,
  resetChromeMock,
} from '../helpers/chrome-mock.js';

let importNonce = 0;
let webLocks;

const FOCUS_SYSTEM_PROMPT = `You are a productivity assistant. Categorize websites as either productive or distracting.
Distracting categories: social media, gaming, video streaming, entertainment, news, shopping.
Productive categories: work tools, documentation, education, development, communication (work).
Respond with JSON only: {"distraction": true/false, "category": "category name", "confidence": 0.0-1.0}`;

function activeFocusState(overrides = {}) {
  return {
    status: 'active',
    runId: 'chrome-ai-focus-run',
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
    distractionsBlocked: 0,
    focusTabCount: 1,
    ...overrides,
  };
}

function chromeAISettings() {
  return {
    enabled: true,
    providerId: 'chrome-ai',
    providerConfigs: {
      'chrome-ai': { model: 'default' },
    },
    usePassphrase: false,
  };
}

function focusRequest(hostname) {
  return {
    systemPrompt: FOCUS_SYSTEM_PROMPT,
    userPrompt: `Is "${hostname}" a distracting website? The user is in focus mode for: Coding`,
    maxTokens: 512,
    responseFormat: 'json',
    temperature: 0.1,
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(message);
}

beforeEach(() => {
  webLocks = installWebLocksMock();
});

afterEach(async () => {
  chromeAIBrokerClient.disconnect();
  await resetChromeMock();
  webLocks.restore();
});

describe('Chrome AI Focus foreground boundary', () => {
  test('a duplicate panel request aborts cleanup before rejecting the correlated worker promise', async () => {
    const { clientPort, workerPort } = createRuntimePortPair(CHROME_AI_PORT_NAME);
    const client = new ChromeAIBrokerClient();
    const completion = deferred();
    const cleanup = deferred();
    let active = 0;
    let signal;
    let outbound;
    clientPort.onMessage.addListener((message) => {
      if (message?.type === 'chrome-ai/request') outbound = structuredClone(message);
    });
    const broker = startChromeAIBroker({
      runtime: { connect: () => clientPort },
      createProvider: () => ({
        async complete(_request, _config, receivedSignal) {
          signal = receivedSignal;
          active += 1;
          try {
            return await completion.promise;
          } finally {
            await cleanup.promise;
            active -= 1;
          }
        },
      }),
    });
    client.attachPort(workerPort);

    try {
      const pending = client.complete({
        userPrompt: 'Keep the original request authoritative.',
        maxTokens: 64,
        temperature: 0,
      });
      await waitFor(() => outbound && active === 1, 'original broker request did not start');
      let settled = false;
      pending.finally(() => { settled = true; }).catch(() => {});

      await workerPort.postMessage(outbound);
      await workerPort.postMessage({ ...outbound, payload: {} });
      await Promise.resolve();

      expect(settled).toBeFalse();
      expect(signal.aborted).toBeTrue();
      expect(client.pending.size).toBe(1);
      expect(active).toBe(1);
      completion.resolve({ text: 'original', parsed: null, tokensUsed: 1 });
      await Promise.resolve();
      expect(settled).toBeFalse();
      cleanup.resolve();
      await expect(pending).rejects.toMatchObject({ code: 'AI_MALFORMED_RESULT' });
      expect(client.pending.size).toBe(0);
      expect(active).toBe(0);
    } finally {
      completion.resolve({ text: 'cleanup', parsed: null, tokensUsed: 1 });
      cleanup.resolve();
      client.disconnect();
      broker.disconnect();
    }
  });

  test('a newer panel port cannot overlap provider work from the replaced generation', async () => {
    const oldPair = createRuntimePortPair(CHROME_AI_PORT_NAME);
    const newPair = createRuntimePortPair(CHROME_AI_PORT_NAME);
    const client = new ChromeAIBrokerClient();
    const cleanupGate = deferred();
    let oldSignal;
    let active = 0;
    let maxActive = 0;
    let providerCount = 0;
    const createProvider = () => ({
      async complete(_request, _config, signal) {
        providerCount += 1;
        const attempt = providerCount;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (attempt > 1) return { text: 'new', parsed: null, tokensUsed: 1 };
          oldSignal = signal;
          return await new Promise((resolve, reject) => {
            signal.addEventListener('abort', async () => {
              await cleanupGate.promise;
              reject(new AIAbortError());
            }, { once: true });
          });
        } finally {
          active -= 1;
        }
      },
    });
    const oldBroker = startChromeAIBroker({
      runtime: { connect: () => oldPair.clientPort },
      createProvider,
      scheduleReconnect: () => 1,
    });
    const newBroker = startChromeAIBroker({
      runtime: { connect: () => newPair.clientPort },
      createProvider,
      scheduleReconnect: () => 1,
    });
    client.attachPort(oldPair.workerPort);

    try {
      const oldPending = client.complete({
        userPrompt: 'Cancel before switching documents.',
        maxTokens: 64,
        temperature: 0,
      });
      oldPending.catch(() => {});
      await waitFor(() => active === 1, 'old document provider did not start');

      client.attachPort(newPair.workerPort);
      await waitFor(() => oldSignal?.aborted === true,
        'replacement did not cancel the old document provider');
      expect(client.port).toBe(oldPair.workerPort);
      expect(client.pending.size).toBe(1);
      expect(active).toBe(1);
      expect(maxActive).toBe(1);

      cleanupGate.resolve();
      await expect(oldPending).rejects.toMatchObject({ code: 'AI_FOREGROUND_REQUIRED' });
      expect(client.port).toBe(newPair.workerPort);
      expect(active).toBe(0);

      await expect(client.complete({
        userPrompt: 'Run only after the old document settled.',
        maxTokens: 64,
        temperature: 0,
      })).resolves.toEqual({ text: 'new', parsed: null, tokensUsed: 1 });
      expect(maxActive).toBe(1);
      expect(active).toBe(0);
    } finally {
      cleanupGate.resolve();
      client.disconnect();
      oldBroker.disconnect();
      newBroker.disconnect();
    }
  });

  test('replacement plus old-port loss cannot overlap cleanup and keeps the candidate usable', async () => {
    const oldPair = createRuntimePortPair(CHROME_AI_PORT_NAME);
    const candidatePair = createRuntimePortPair(CHROME_AI_PORT_NAME);
    const reconnectPair = createRuntimePortPair(CHROME_AI_PORT_NAME);
    const client = new ChromeAIBrokerClient();
    const cleanupGate = deferred();
    const candidateReconnects = [];
    const candidatePairs = [candidatePair, reconnectPair];
    let oldSignal;
    let active = 0;
    let maxActive = 0;
    let providerCount = 0;

    const createProvider = () => ({
      async complete(_request, _config, signal) {
        providerCount += 1;
        const attempt = providerCount;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (attempt > 1) return { text: 'new', parsed: null, tokensUsed: 1 };
          oldSignal = signal;
          return await new Promise((resolve, reject) => {
            signal.addEventListener('abort', async () => {
              await cleanupGate.promise;
              reject(new AIAbortError());
            }, { once: true });
          });
        } finally {
          active -= 1;
        }
      },
    });

    const oldBroker = startChromeAIBroker({
      runtime: {
        connect() {
          client.attachPort(oldPair.workerPort);
          return oldPair.clientPort;
        },
      },
      createProvider,
      scheduleReconnect: () => 1,
    });
    let candidateBroker = null;

    try {
      const oldPending = client.complete({
        userPrompt: 'Hold cleanup while the owner port disappears.',
        maxTokens: 64,
        temperature: 0,
      });
      oldPending.catch(() => {});
      await waitFor(() => active === 1, 'old provider did not start');

      candidateBroker = startChromeAIBroker({
        runtime: {
          connect() {
            const pair = candidatePairs.shift();
            if (!pair) throw new Error('No candidate reconnect port available');
            client.attachPort(pair.workerPort);
            return pair.clientPort;
          },
        },
        createProvider,
        scheduleReconnect(callback, delay) {
          candidateReconnects.push({ callback, delay });
          return candidateReconnects.length;
        },
      });
      await waitFor(() => oldSignal?.aborted === true, 'replacement did not abort old work');
      await oldPair.workerPort.disconnect();
      await expect(oldPending).rejects.toMatchObject({ code: 'AI_FOREGROUND_REQUIRED' });

      if (candidateReconnects.length > 0) {
        expect(candidateReconnects[0].delay).toBe(100);
        await candidateReconnects.shift().callback();
      }
      await waitFor(() => client.port !== null, 'candidate was not available after old-port loss');

      let newSettled = false;
      const newer = client.complete({
        userPrompt: 'Wait behind the old document cleanup lock.',
        maxTokens: 64,
        temperature: 0,
      });
      newer.finally(() => { newSettled = true; }).catch(() => {});
      await Promise.resolve();
      await Promise.resolve();

      expect(newSettled).toBeFalse();
      expect(active).toBe(1);
      expect(maxActive).toBe(1);
      expect(webLocks.manager.maxActive).toBe(1);

      cleanupGate.resolve();
      await expect(newer).resolves.toEqual({ text: 'new', parsed: null, tokensUsed: 1 });
      expect(active).toBe(0);
      expect(maxActive).toBe(1);
      expect(client.pending.size).toBe(0);
    } finally {
      cleanupGate.resolve();
      client.disconnect();
      oldBroker.disconnect();
      candidateBroker?.disconnect();
    }
  });

  test('promotes an older standby while the closed newest panel finishes cleanup', async () => {
    const oldPair = createRuntimePortPair(CHROME_AI_PORT_NAME);
    const newestPair = createRuntimePortPair(CHROME_AI_PORT_NAME);
    const client = new ChromeAIBrokerClient();
    const cleanupGate = deferred();
    let newestSignal;
    let active = 0;
    let maxActive = 0;
    let oldStarts = 0;

    const oldBroker = startChromeAIBroker({
      runtime: {
        connect() {
          client.attachPort(oldPair.workerPort);
          return oldPair.clientPort;
        },
      },
      createProvider: () => ({
        async complete() {
          oldStarts += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          active -= 1;
          return { text: 'standby', parsed: null, tokensUsed: 1 };
        },
      }),
      scheduleReconnect: () => 1,
    });
    const newestBroker = startChromeAIBroker({
      runtime: {
        connect() {
          client.attachPort(newestPair.workerPort);
          return newestPair.clientPort;
        },
      },
      createProvider: () => ({
        async complete(_request, _config, signal) {
          newestSignal = signal;
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            return await new Promise((resolve, reject) => {
              signal.addEventListener('abort', async () => {
                await cleanupGate.promise;
                reject(new AIAbortError());
              }, { once: true });
            });
          } finally {
            active -= 1;
          }
        },
      }),
      scheduleReconnect: () => 1,
    });

    try {
      expect(client.port).toBe(newestPair.workerPort);
      const newest = client.complete({
        userPrompt: 'Hold the newest document cleanup.',
        maxTokens: 64,
        temperature: 0,
      });
      newest.catch(() => {});
      await waitFor(() => active === 1, 'newest provider did not start');

      await newestPair.workerPort.disconnect();
      await expect(newest).rejects.toMatchObject({ code: 'AI_FOREGROUND_REQUIRED' });
      expect(newestSignal.aborted).toBeTrue();
      expect(client.port).toBe(oldPair.workerPort);

      let fallbackSettled = false;
      const fallback = client.complete({
        userPrompt: 'Use the older live panel after cleanup.',
        maxTokens: 64,
        temperature: 0,
      });
      fallback.finally(() => { fallbackSettled = true; }).catch(() => {});
      await Promise.resolve();
      await Promise.resolve();

      expect(fallbackSettled).toBeFalse();
      expect(oldStarts).toBe(0);
      expect(active).toBe(1);
      expect(maxActive).toBe(1);

      cleanupGate.resolve();
      await expect(fallback).resolves.toEqual({ text: 'standby', parsed: null, tokensUsed: 1 });
      expect(oldStarts).toBe(1);
      expect(active).toBe(0);
      expect(maxActive).toBe(1);
    } finally {
      cleanupGate.resolve();
      client.disconnect();
      oldBroker.disconnect();
      newestBroker.disconnect();
    }
  });

  test('a worker disconnect cannot reconnect or start later work before panel cleanup settles', async () => {
    const firstPair = createRuntimePortPair(CHROME_AI_PORT_NAME);
    const secondPair = createRuntimePortPair(CHROME_AI_PORT_NAME);
    const client = new ChromeAIBrokerClient();
    const cleanupGate = deferred();
    const scheduled = [];
    const pairs = [firstPair, secondPair];
    let active = 0;
    let maxActive = 0;
    let providerCount = 0;
    const broker = startChromeAIBroker({
      runtime: {
        connect() {
          const pair = pairs.shift();
          if (!pair) throw new Error('No reconnect pair available');
          client.attachPort(pair.workerPort);
          return pair.clientPort;
        },
      },
      scheduleReconnect(callback, delay) {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      createProvider: () => ({
        async complete(_request, _config, signal) {
          providerCount += 1;
          const attempt = providerCount;
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            if (attempt > 1) return { text: 'later', parsed: null, tokensUsed: 1 };
            return await new Promise((resolve, reject) => {
              signal.addEventListener('abort', async () => {
                await cleanupGate.promise;
                reject(new AIAbortError());
              }, { once: true });
            });
          } finally {
            active -= 1;
          }
        },
      }),
    });

    try {
      const first = client.complete({
        userPrompt: 'Hold cleanup across the disconnect.',
        maxTokens: 64,
        temperature: 0,
      });
      first.catch(() => {});
      await waitFor(() => active === 1, 'first panel provider did not start');
      await firstPair.workerPort.disconnect();
      await expect(first).rejects.toMatchObject({ code: 'AI_FOREGROUND_REQUIRED' });
      expect(scheduled.map(({ delay }) => delay)).toEqual([100]);

      const reconnectFlight = scheduled.shift().callback();
      await Promise.resolve();
      expect(client.port).toBeNull();
      expect(active).toBe(1);
      expect(maxActive).toBe(1);

      cleanupGate.resolve();
      await reconnectFlight;
      await waitFor(() => client.port === secondPair.workerPort,
        'panel did not reconnect after cleanup');
      const later = await client.complete({
        userPrompt: 'Start only after old cleanup.',
        maxTokens: 64,
        temperature: 0,
      });
      expect(later).toEqual({ text: 'later', parsed: null, tokensUsed: 1 });
      expect(active).toBe(0);
      expect(maxActive).toBe(1);
    } finally {
      cleanupGate.resolve();
      client.disconnect();
      broker.disconnect();
    }
  });

  test('timeout waits for panel cleanup and leaves both broker generations reusable', async () => {
    const { clientPort, workerPort } = createRuntimePortPair(CHROME_AI_PORT_NAME);
    const client = new ChromeAIBrokerClient();
    const cleanupGate = deferred();
    const events = [];
    const outbound = [];
    const inbound = [];
    let active = 0;
    let maxActive = 0;
    let providerCount = 0;

    clientPort.onMessage.addListener((message) => outbound.push(message));
    workerPort.onMessage.addListener((message) => inbound.push(message));
    const broker = startChromeAIBroker({
      runtime: { connect: () => clientPort },
      createProvider: () => {
        providerCount += 1;
        const attempt = providerCount;
        return {
          async complete(_request, _config, signal) {
            active += 1;
            maxActive = Math.max(maxActive, active);
            events.push(`attempt-${attempt}-started`);
            if (attempt > 1) {
              active -= 1;
              events.push(`attempt-${attempt}-settled`);
              return { text: 'fresh', parsed: null, tokensUsed: 1 };
            }

            return new Promise((resolve, reject) => {
              signal.addEventListener('abort', async () => {
                events.push('attempt-1-aborted');
                await cleanupGate.promise;
                active -= 1;
                events.push('attempt-1-settled');
                reject(new AIAbortError());
              }, { once: true });
            });
          },
        };
      },
      scheduleReconnect: () => 0,
    });
    client.attachPort(workerPort);

    try {
      let exposed = false;
      const timed = runAbortableAttempt(
        (signal) => client.complete({
          userPrompt: 'Wait for panel cleanup.',
          maxTokens: 64,
          temperature: 0,
        }, {}, signal),
        10,
      ).finally(() => {
        exposed = true;
        events.push('timeout-exposed');
      });
      timed.catch(() => {});

      await waitFor(() => active === 1, 'first broker request did not start');
      await waitFor(
        () => events.includes('attempt-1-aborted'),
        'timeout did not reach the panel controller',
      );
      await Promise.resolve();
      expect(exposed).toBeFalse();
      expect(active).toBe(1);
      expect(client.pending.size).toBe(1);

      cleanupGate.resolve();
      const timeoutError = await timed.catch((error) => error);
      expect(timeoutError).toBeInstanceOf(AITimeoutError);
      expect(events.indexOf('attempt-1-settled'))
        .toBeLessThan(events.indexOf('timeout-exposed'));
      expect(client.pending.size).toBe(0);

      const firstRequestId = outbound.find(({ type }) => type === 'chrome-ai/request').requestId;
      await workerPort.postMessage({
        type: 'chrome-ai/request',
        requestId: firstRequestId,
        method: 'complete',
        payload: {
          request: {
            userPrompt: 'Start only after cleanup.',
            maxTokens: 64,
            temperature: 0,
          },
        },
      });
      await waitFor(
        () => inbound.some((message) =>
          message.requestId === firstRequestId && message.ok === true),
        'panel did not accept the cleaned request ID for a later attempt',
      );
      expect(events.indexOf('attempt-1-settled'))
        .toBeLessThan(events.indexOf('attempt-2-started'));
      expect(maxActive).toBe(1);
      expect(active).toBe(0);
      expect(client.pending.size).toBe(0);
      expect(outbound.filter(({ type }) => type === 'chrome-ai/cancel')).toHaveLength(1);
      expect(outbound.filter(({ type }) => type === 'chrome-ai/request')).toHaveLength(2);
    } finally {
      cleanupGate.resolve();
      client.disconnect();
      broker.disconnect();
    }
  });

  test('keeps the Prompt API executor out of the worker import graph', async () => {
    const [worker, aiClient, panelBroker, panel] = await Promise.all([
      Bun.file(new URL('../../service-worker.js', import.meta.url)).text(),
      Bun.file(new URL('../../core/ai/ai-client.js', import.meta.url)).text(),
      Bun.file(new URL('../../sidepanel/chrome-ai-broker.js', import.meta.url)).text(),
      Bun.file(new URL('../../sidepanel/panel.js', import.meta.url)).text(),
    ]);

    expect(worker).not.toContain('LanguageModel');
    expect(worker).not.toContain('provider-chrome.js');
    expect(aiClient).not.toContain('provider-chrome.js');
    expect(panelBroker).toContain("from '../core/ai/provider-chrome.js'");
    expect(panel.match(/const chromeAIBroker = startChromeAIBroker\(\);/g) || [])
      .toHaveLength(1);
  });

  test('the worker ignores unrelated ports and attaches the named panel port to the singleton', async () => {
    installChromeMock({ local: { aiSettings: chromeAISettings() } });
    chromeAIBrokerClient.disconnect();
    await import(`../../service-worker.js?chrome-ai-port=${++importNonce}`);

    const request = {
      userPrompt: 'Classify the attached panel connection.',
      maxTokens: 128,
      responseFormat: 'json',
      temperature: 0.1,
    };
    const unrelatedPort = chrome.runtime.connect({ name: 'not-tabkebab-chrome-ai' });
    const withoutPanel = await AIClient.complete(request).then(() => null, (error) => error);
    expect(withoutPanel?.code).toBe('AI_FOREGROUND_REQUIRED');

    const panelPort = chrome.runtime.connect({ name: CHROME_AI_PORT_NAME });
    panelPort.onMessage.addListener((message) => {
      if (message?.type !== 'chrome-ai/request') return;
      return panelPort.postMessage({
        type: 'chrome-ai/result',
        requestId: message.requestId,
        ok: true,
        value: {
          text: '{"distraction":false}',
          parsed: { distraction: false },
          tokensUsed: 7,
        },
      });
    });

    await expect(AIClient.complete(request)).resolves.toMatchObject({
      text: '{"distraction":false}',
      parsed: { distraction: false },
      tokensUsed: 7,
      fromCache: false,
    });
    expect(unrelatedPort.name).toBe('not-tabkebab-chrome-ai');
  });

  test('uncached background classification safely skips without a panel', async () => {
    const classifiedUrl = 'https://closed-panel.test/path';
    const harness = installChromeMock({
      local: {
        focusState: activeFocusState(),
        aiSettings: chromeAISettings(),
      },
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 11, windowId: 1, url: 'https://origin.test/', active: true }],
    });
    chromeAIBrokerClient.disconnect();

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      await import(`../../service-worker.js?chrome-ai-focus=${++importNonce}`);
      await waitFor(
        () => harness.calls.tabGroups.query.length === 1,
        'worker startup did not complete Focus group lookup',
      );

      await chrome.tabs.update(11, { url: classifiedUrl });

      expect(harness.calls.tabs.goBack).toEqual([]);
      expect(harness.calls.tabs.remove).toEqual([]);
      expect(harness.calls.sidePanel.open).toEqual([]);
      expect(harness.calls.runtime.sendMessage.filter(
        ([message]) => message?.type === 'focusDistraction',
      )).toEqual([]);
      expect(readStorageArea('local').aiCache).toBeUndefined();
      expect(readStorageArea('local').focusState).toMatchObject({
        runId: 'chrome-ai-focus-run',
        status: 'active',
        distractionsBlocked: 0,
      });
      expect(warnings.some(([prefix, message]) =>
        prefix === '[TabKebab] AI check failed:' &&
        message === 'AI requires an open side panel')).toBeTrue();
    } finally {
      console.warn = originalWarn;
    }
  });

  test('a valid cached Chrome AI classification still reaches the live Focus guard', async () => {
    const classifiedUrl = 'https://cached-chrome-ai.test/path';
    const hostname = 'cached-chrome-ai.test';
    const harness = installChromeMock({
      local: {
        focusState: activeFocusState(),
        aiSettings: chromeAISettings(),
      },
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 11, windowId: 1, url: 'https://origin.test/', active: true }],
    });
    chromeAIBrokerClient.disconnect();

    await import(`../../service-worker.js?chrome-ai-cache=${++importNonce}`);
    await waitFor(
      () => harness.calls.tabGroups.query.length === 1,
      'worker startup did not complete Focus group lookup',
    );

    const request = focusRequest(hostname);
    const cacheKey = await AICache.makeCacheKey(
      'chrome-ai',
      'default',
      request.systemPrompt,
      request.userPrompt,
      {
        credentialFingerprint: null,
        customBaseUrl: null,
        maxTokens: 512,
        temperature: 0.1,
        responseFormat: 'json',
      },
    );
    await AICache.set(cacheKey, {
      text: '{"distraction":true,"category":"news","confidence":0.99}',
      parsed: { distraction: true, category: 'news', confidence: 0.99 },
      tokensUsed: 12,
    });

    await chrome.tabs.update(11, { url: classifiedUrl });
    await waitFor(
      () => harness.calls.tabs.goBack.length === 1,
      'cached classification did not reach the live Focus guard',
    );

    expect(harness.calls.tabs.remove).toEqual([]);
    expect(harness.calls.runtime.connect).toEqual([]);
  });
});
