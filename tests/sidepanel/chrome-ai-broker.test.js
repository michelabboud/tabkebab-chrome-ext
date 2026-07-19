import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { CHROME_AI_PORT_NAME } from '../../core/ai/chrome-ai-protocol.js';
import { AIAbortError, AITimeoutError } from '../../core/ai/provider.js';
import { startChromeAIBroker } from '../../sidepanel/chrome-ai-broker.js';
import { installWebLocksMock } from '../helpers/chrome-mock.js';

const MALFORMED_MESSAGE = 'Chrome AI protocol message is malformed.';

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    async dispatch(...args) {
      await Promise.all([...listeners].map((listener) => listener(...args)));
    },
  };
}

function createPort(name = CHROME_AI_PORT_NAME) {
  const onMessage = createEvent();
  const onDisconnect = createEvent();
  const sent = [];
  let disconnectCalls = 0;

  return {
    name,
    onMessage,
    onDisconnect,
    sent,
    get disconnectCalls() {
      return disconnectCalls;
    },
    postMessage(message) {
      sent.push(structuredClone(message));
    },
    async disconnect() {
      disconnectCalls += 1;
      await onDisconnect.dispatch();
    },
  };
}

function createRuntime(...ports) {
  const connections = [];
  return {
    connections,
    connect(connectInfo) {
      connections.push(structuredClone(connectInfo));
      const next = ports.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('No test port available');
      return next;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createScheduler() {
  const scheduled = [];
  let nextHandle = 1;
  return {
    scheduled,
    scheduleReconnect(callback, delay) {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.push({ callback, delay, handle });
      return handle;
    },
    async runNext() {
      const task = scheduled.shift();
      if (!task) throw new Error('No reconnect is scheduled');
      await task.callback();
      await settle();
      return task.delay;
    },
  };
}

async function settle() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

let webLocks;

beforeEach(() => {
  webLocks = installWebLocksMock();
});

afterEach(() => {
  webLocks.restore();
});

describe('side-panel Chrome AI broker', () => {
  test('connects the named port and serves availability with one provider instance', async () => {
    const port = createPort();
    const runtime = createRuntime(port);
    const calls = [];
    const broker = startChromeAIBroker({
      runtime,
      createProvider: () => {
        calls.push('create');
        return {
          async testConnection(config, signal) {
            calls.push(['availability', config, signal]);
            return true;
          },
        };
      },
    });

    expect(runtime.connections).toEqual([{ name: CHROME_AI_PORT_NAME }]);
    expect(broker.port).toBe(port);

    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: 'd69d4cd8-5b27-4c0c-bf16-41ec34d8a356',
      method: 'availability',
      payload: {},
    });
    await settle();

    expect(calls[0]).toBe('create');
    expect(calls[1][0]).toBe('availability');
    expect(calls[1][1]).toEqual({});
    expect(calls[1][2]).toBeInstanceOf(AbortSignal);
    expect(calls).toHaveLength(2);
    expect(port.sent).toEqual([{
      type: 'chrome-ai/result',
      requestId: 'd69d4cd8-5b27-4c0c-bf16-41ec34d8a356',
      ok: true,
      value: true,
    }]);

    broker.disconnect();
  });

  test('fails closed before provider construction when Web Locks are unavailable', async () => {
    webLocks.restore();
    webLocks = { restore() {} };
    const port = createPort();
    let providersCreated = 0;
    const broker = startChromeAIBroker({
      runtime: createRuntime(port),
      createProvider: () => {
        providersCreated += 1;
        return { testConnection: async () => true };
      },
    });

    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: '95163136-4a11-43d4-a8d9-21b85f29de7f',
      method: 'availability',
      payload: {},
    });
    await settle();

    expect(providersCreated).toBe(0);
    expect(port.sent).toEqual([{
      type: 'chrome-ai/result',
      requestId: '95163136-4a11-43d4-a8d9-21b85f29de7f',
      ok: false,
      error: {
        code: 'AI_UNAVAILABLE',
        message: 'Chrome AI coordination is unavailable.',
      },
    }]);

    broker.disconnect();
  });

  test('completes with an exact whitelisted serializable result', async () => {
    const port = createPort();
    const runtime = createRuntime(port);
    const request = {
      userPrompt: 'Group these tabs',
      systemPrompt: 'Return JSON',
      maxTokens: 512,
      temperature: 0.2,
      responseFormat: 'json',
    };
    const observed = [];
    const broker = startChromeAIBroker({
      runtime,
      createProvider: () => ({
        async complete(receivedRequest, config, signal) {
          observed.push({ receivedRequest, config, signal });
          return {
            text: '{"groups":[]}',
            parsed: { groups: [] },
            tokensUsed: 7,
            internalMetadata: 'must not cross the port',
          };
        },
      }),
    });

    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: 'ce10894b-69d4-42c2-8ac7-d53b1583d773',
      method: 'complete',
      payload: { request },
    });
    await settle();

    expect(observed).toHaveLength(1);
    expect(observed[0].receivedRequest).toEqual(request);
    expect(observed[0].receivedRequest).not.toBe(request);
    expect(observed[0].config).toEqual({});
    expect(observed[0].signal).toBeInstanceOf(AbortSignal);
    expect(port.sent).toEqual([{
      type: 'chrome-ai/result',
      requestId: 'ce10894b-69d4-42c2-8ac7-d53b1583d773',
      ok: true,
      value: {
        text: '{"groups":[]}',
        parsed: { groups: [] },
        tokensUsed: 7,
      },
    }]);

    broker.disconnect();
  });

  test('creates one provider for each accepted request and none for ignored input', async () => {
    const port = createPort();
    let providersCreated = 0;
    const broker = startChromeAIBroker({
      runtime: createRuntime(port),
      createProvider: () => {
        providersCreated += 1;
        return {
          testConnection: async () => true,
          complete: async () => ({ text: 'ok', parsed: null, tokensUsed: 1 }),
        };
      },
    });

    await port.onMessage.dispatch({ type: 'unrelated' });
    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: 'not-a-uuid',
      method: 'availability',
      payload: {},
    });
    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: '551acee6-fe77-4787-aaeb-ea832f7613fc',
      method: 'availability',
      payload: {},
    });
    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: '5ab76feb-f8a5-4a35-86a0-c5f742b51dd5',
      method: 'complete',
      payload: {
        request: {
          userPrompt: 'Sort tabs',
          maxTokens: 128,
          temperature: 0,
        },
      },
    });
    await settle();

    expect(providersCreated).toBe(2);
    expect(port.sent.map(({ requestId }) => requestId)).toEqual([
      '551acee6-fe77-4787-aaeb-ea832f7613fc',
      '5ab76feb-f8a5-4a35-86a0-c5f742b51dd5',
    ]);

    broker.disconnect();
  });

  test('marks a duplicate active request malformed, aborts once, and waits for cleanup before replying', async () => {
    const port = createPort();
    const completion = deferred();
    const cleanup = deferred();
    let providersCreated = 0;
    let signal;
    const broker = startChromeAIBroker({
      runtime: createRuntime(port),
      createProvider: () => {
        providersCreated += 1;
        return {
          complete: async (_request, _config, receivedSignal) => {
            signal = receivedSignal;
            try {
              return await completion.promise;
            } finally {
              await cleanup.promise;
            }
          },
        };
      },
    });
    const requestId = '7d66a2b2-2a93-43cf-b08c-79cfba1931bc';
    const message = {
      type: 'chrome-ai/request',
      requestId,
      method: 'complete',
      payload: {
        request: { userPrompt: 'Sort tabs', maxTokens: 128, temperature: 0 },
      },
    };

    await port.onMessage.dispatch(message);
    await settle();
    await port.onMessage.dispatch(message);
    await settle();

    expect(providersCreated).toBe(1);
    expect(signal.aborted).toBeTrue();
    expect(port.sent).toEqual([]);

    completion.resolve({ text: 'original', parsed: null, tokensUsed: 1 });
    await settle();
    expect(port.sent).toEqual([]);

    cleanup.resolve();
    await settle();
    expect(port.sent[0]).toEqual({
      type: 'chrome-ai/result',
      requestId,
      ok: false,
      error: { code: 'AI_MALFORMED_RESULT', message: MALFORMED_MESSAGE },
    });
    expect(port.sent).toHaveLength(1);

    broker.disconnect();
  });

  test('marks a malformed duplicate ID malformed and preserves its cleanup barrier', async () => {
    const port = createPort();
    const completion = deferred();
    const cleanup = deferred();
    let providersCreated = 0;
    let signal;
    const broker = startChromeAIBroker({
      runtime: createRuntime(port),
      createProvider: () => {
        providersCreated += 1;
        return {
          complete: async (_request, _config, receivedSignal) => {
            signal = receivedSignal;
            try {
              return await completion.promise;
            } finally {
              await cleanup.promise;
            }
          },
        };
      },
    });
    const requestId = '0dc5cc86-7662-44dc-aed5-3143ce9b6665';

    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId,
      method: 'complete',
      payload: {
        request: { userPrompt: 'Original', maxTokens: 128, temperature: 0 },
      },
    });
    await settle();
    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId,
      method: 'complete',
      payload: {},
    });
    await settle();

    expect(providersCreated).toBe(1);
    expect(signal.aborted).toBeTrue();
    expect(port.sent).toEqual([]);

    completion.resolve({ text: 'original', parsed: null, tokensUsed: 1 });
    await settle();
    expect(port.sent).toEqual([]);

    cleanup.resolve();
    await settle();
    expect(port.sent[0]).toEqual({
      type: 'chrome-ai/result',
      requestId,
      ok: false,
      error: { code: 'AI_MALFORMED_RESULT', message: MALFORMED_MESSAGE },
    });
    expect(port.sent).toHaveLength(1);

    broker.disconnect();
  });

  test('keeps cancellation as the first terminal cause when a duplicate arrives later', async () => {
    const port = createPort();
    const completion = deferred();
    const cleanup = deferred();
    let signal;
    const broker = startChromeAIBroker({
      runtime: createRuntime(port),
      createProvider: () => ({
        async complete(_request, _config, receivedSignal) {
          signal = receivedSignal;
          try {
            return await completion.promise;
          } finally {
            await cleanup.promise;
          }
        },
      }),
    });
    const requestId = 'f3fd9fc6-122c-423e-b806-0fd73e65ef8c';
    const message = {
      type: 'chrome-ai/request',
      requestId,
      method: 'complete',
      payload: {
        request: { userPrompt: 'Keep first cause', maxTokens: 64, temperature: 0 },
      },
    };

    await port.onMessage.dispatch(message);
    await settle();
    await port.onMessage.dispatch({ type: 'chrome-ai/cancel', requestId });
    await port.onMessage.dispatch(message);
    expect(signal.aborted).toBeTrue();
    expect(port.sent).toEqual([]);

    completion.resolve({ text: 'late', parsed: null, tokensUsed: 1 });
    cleanup.resolve();
    await settle();
    expect(port.sent).toEqual([{
      type: 'chrome-ai/result',
      requestId,
      ok: false,
      error: { code: 'AI_ABORTED', message: new AIAbortError().message },
    }]);

    broker.disconnect();
  });

  test('returns a safe malformed error only when malformed input has a valid request ID', async () => {
    const port = createPort();
    let providersCreated = 0;
    const broker = startChromeAIBroker({
      runtime: createRuntime(port),
      createProvider: () => {
        providersCreated += 1;
        return {};
      },
    });

    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: 'missing-or-invalid',
      method: 'complete',
      payload: {},
    });
    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: 'f8e66674-3305-48c0-907f-2fba88c66ded',
      method: 'complete',
      payload: {},
    });
    await settle();

    expect(providersCreated).toBe(0);
    expect(port.sent).toEqual([{
      type: 'chrome-ai/result',
      requestId: 'f8e66674-3305-48c0-907f-2fba88c66ded',
      ok: false,
      error: {
        code: 'AI_MALFORMED_RESULT',
        message: MALFORMED_MESSAGE,
      },
    }]);

    broker.disconnect();
  });

  test('preserves allowed provider errors and redacts unrecognized exceptions', async () => {
    const port = createPort();
    const typed = new AITimeoutError('Chrome AI timed out safely.');
    typed.stack = 'sensitive typed stack';
    const secret = new Error('API key leaked in raw message');
    secret.code = 'SECRET_INTERNAL_CODE';
    secret.stack = 'sensitive unknown stack';
    const errors = [typed, secret];
    const broker = startChromeAIBroker({
      runtime: createRuntime(port),
      createProvider: () => ({
        async testConnection() {
          throw errors.shift();
        },
      }),
    });

    for (const requestId of [
      '34cdf17d-cf1b-4532-918a-24ff4d4602d8',
      'ba34bb87-2d3a-4ac2-91f6-1b13da96e30e',
    ]) {
      await port.onMessage.dispatch({
        type: 'chrome-ai/request',
        requestId,
        method: 'availability',
        payload: {},
      });
    }
    await settle();

    expect(port.sent).toEqual([
      {
        type: 'chrome-ai/result',
        requestId: '34cdf17d-cf1b-4532-918a-24ff4d4602d8',
        ok: false,
        error: { code: 'AI_TIMEOUT', message: 'Chrome AI timed out safely.' },
      },
      {
        type: 'chrome-ai/result',
        requestId: 'ba34bb87-2d3a-4ac2-91f6-1b13da96e30e',
        ok: false,
        error: { code: 'AI_UNAVAILABLE', message: 'Chrome AI request failed.' },
      },
    ]);
    expect(JSON.stringify(port.sent)).not.toContain('sensitive');
    expect(JSON.stringify(port.sent)).not.toContain('API key');
    expect(Object.keys(port.sent[0].error)).toEqual(['code', 'message']);
    expect(Object.keys(port.sent[1].error)).toEqual(['code', 'message']);

    broker.disconnect();
  });

  test('rejects malformed provider output without crossing unsafe values over the port', async () => {
    const port = createPort();
    const broker = startChromeAIBroker({
      runtime: createRuntime(port),
      createProvider: () => ({
        async complete() {
          return {
            text: 'unsafe',
            parsed: { callback() {} },
            tokensUsed: 1,
            stack: 'must not cross',
          };
        },
      }),
    });

    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: '03e6b204-715f-445d-be9b-1d707b5cbb74',
      method: 'complete',
      payload: {
        request: { userPrompt: 'Sort tabs', maxTokens: 128, temperature: 0 },
      },
    });
    await settle();

    expect(port.sent).toEqual([{
      type: 'chrome-ai/result',
      requestId: '03e6b204-715f-445d-be9b-1d707b5cbb74',
      ok: false,
      error: {
        code: 'AI_MALFORMED_RESULT',
        message: MALFORMED_MESSAGE,
      },
    }]);
    expect(JSON.stringify(port.sent)).not.toContain('stack');

    broker.disconnect();
  });

  test('rejects a completion-shaped value returned by the availability method', async () => {
    const port = createPort();
    const broker = startChromeAIBroker({
      runtime: createRuntime(port),
      createProvider: () => ({
        async testConnection() {
          return { text: 'wrong union member', parsed: null, tokensUsed: 1 };
        },
      }),
    });

    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: '60feafda-af83-4b04-ad96-d8e7c7e7eea7',
      method: 'availability',
      payload: {},
    });
    await settle();

    expect(port.sent).toEqual([{
      type: 'chrome-ai/result',
      requestId: '60feafda-af83-4b04-ad96-d8e7c7e7eea7',
      ok: false,
      error: { code: 'AI_MALFORMED_RESULT', message: MALFORMED_MESSAGE },
    }]);

    broker.disconnect();
  });

  test('cancel aborts its controller, awaits cleanup, and acknowledges once instead of leaking a late success', async () => {
    const port = createPort();
    const completion = deferred();
    const cleanup = deferred();
    let signal;
    const broker = startChromeAIBroker({
      runtime: createRuntime(port),
      createProvider: () => ({
        complete: async (_request, _config, receivedSignal) => {
          signal = receivedSignal;
          try {
            return await completion.promise;
          } finally {
            await cleanup.promise;
          }
        },
      }),
    });
    const requestId = '5415d15f-b27e-49ed-af97-14a56a2fb725';

    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId,
      method: 'complete',
      payload: {
        request: { userPrompt: 'Sort tabs', maxTokens: 128, temperature: 0 },
      },
    });
    await settle();
    expect(signal.aborted).toBeFalse();

    await port.onMessage.dispatch({ type: 'chrome-ai/cancel', requestId });
    expect(signal.aborted).toBeTrue();
    expect(port.sent).toEqual([]);

    completion.resolve({ text: 'too late', parsed: null, tokensUsed: 2 });
    await settle();
    expect(port.sent).toEqual([]);

    cleanup.resolve();
    await settle();
    expect(port.sent).toEqual([{
      type: 'chrome-ai/result',
      requestId,
      ok: false,
      error: {
        code: 'AI_ABORTED',
        message: new AIAbortError().message,
      },
    }]);

    broker.disconnect();
  });

  test('disconnect aborts every active request and suppresses every late result', async () => {
    const port = createPort();
    const first = deferred();
    const second = deferred();
    const completions = [first, second];
    const signals = [];
    const scheduler = createScheduler();
    const broker = startChromeAIBroker({
      runtime: createRuntime(port),
      scheduleReconnect: scheduler.scheduleReconnect,
      createProvider: () => ({
        complete: async (_request, _config, signal) => {
          signals.push(signal);
          return completions.shift().promise;
        },
      }),
    });

    for (const requestId of [
      '5e193eed-2d4b-43b0-98d8-b8c4b78c95a6',
      '9a05f888-0b7c-4ac5-933c-642433c8dc25',
    ]) {
      await port.onMessage.dispatch({
        type: 'chrome-ai/request',
        requestId,
        method: 'complete',
        payload: {
          request: { userPrompt: 'Sort tabs', maxTokens: 128, temperature: 0 },
        },
      });
    }
    await settle();

    await port.onDisconnect.dispatch();
    // The origin-wide exclusive lock prevents the queued request from
    // constructing a provider before disconnect aborts its lock wait.
    expect(signals).toHaveLength(1);
    expect(signals.every(({ aborted }) => aborted)).toBeTrue();
    expect(scheduler.scheduled.map(({ delay }) => delay)).toEqual([100]);

    first.resolve({ text: 'late one', parsed: null, tokensUsed: 1 });
    second.resolve({ text: 'never started', parsed: null, tokensUsed: 1 });
    await settle();
    expect(port.sent).toEqual([]);

    broker.disconnect();
  });

  test('reconnects after worker restarts with bounded backoff and resets it after success', async () => {
    const firstPort = createPort();
    const replacementPort = createPort();
    const afterSecondRestart = createPort();
    const runtime = createRuntime(
      firstPort,
      new Error('worker still starting'),
      new Error('worker still starting'),
      replacementPort,
      afterSecondRestart,
    );
    const scheduler = createScheduler();
    let providerCalls = 0;
    const broker = startChromeAIBroker({
      runtime,
      scheduleReconnect: scheduler.scheduleReconnect,
      createProvider: () => ({
        async testConnection() {
          providerCalls += 1;
          return true;
        },
      }),
    });

    await firstPort.onDisconnect.dispatch();
    expect(scheduler.scheduled.map(({ delay }) => delay)).toEqual([100]);
    expect(await scheduler.runNext()).toBe(100);
    expect(scheduler.scheduled.map(({ delay }) => delay)).toEqual([500]);
    expect(await scheduler.runNext()).toBe(500);
    expect(scheduler.scheduled.map(({ delay }) => delay)).toEqual([1000]);
    expect(await scheduler.runNext()).toBe(1000);
    expect(broker.port).toBe(replacementPort);

    await replacementPort.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: '2072fb02-69a5-4532-b1ef-2d4437b8f158',
      method: 'availability',
      payload: {},
    });
    await settle();
    expect(providerCalls).toBe(1);
    expect(replacementPort.sent).toHaveLength(1);

    await replacementPort.onDisconnect.dispatch();
    expect(scheduler.scheduled.map(({ delay }) => delay)).toEqual([100]);
    expect(await scheduler.runNext()).toBe(100);
    expect(broker.port).toBe(afterSecondRestart);
    expect(runtime.connections).toEqual(Array.from({ length: 5 }, () => ({
      name: CHROME_AI_PORT_NAME,
    })));

    broker.disconnect();
  });

  test('caps repeated reconnect failures at 1000 ms', async () => {
    const port = createPort();
    const runtime = createRuntime(
      port,
      new Error('restart 1'),
      new Error('restart 2'),
      new Error('restart 3'),
      new Error('restart 4'),
    );
    const scheduler = createScheduler();
    const broker = startChromeAIBroker({
      runtime,
      scheduleReconnect: scheduler.scheduleReconnect,
      createProvider: () => ({}),
    });

    await port.onDisconnect.dispatch();
    const delays = [];
    for (let index = 0; index < 4; index += 1) {
      delays.push(await scheduler.runNext());
    }

    expect(delays).toEqual([100, 500, 1000, 1000]);
    broker.disconnect();
  });

  test('explicit disconnect is idempotent, aborts work, and permanently disables reconnect', async () => {
    const port = createPort();
    const replacement = createPort();
    const runtime = createRuntime(port, replacement);
    const scheduler = createScheduler();
    const completion = deferred();
    let signal;
    const broker = startChromeAIBroker({
      runtime,
      scheduleReconnect: scheduler.scheduleReconnect,
      createProvider: () => ({
        complete: async (_request, _config, receivedSignal) => {
          signal = receivedSignal;
          return completion.promise;
        },
      }),
    });

    await port.onMessage.dispatch({
      type: 'chrome-ai/request',
      requestId: '9c86c181-f206-487e-88d5-7c1b51da06a6',
      method: 'complete',
      payload: {
        request: { userPrompt: 'Sort tabs', maxTokens: 128, temperature: 0 },
      },
    });
    await settle();

    broker.disconnect();
    broker.disconnect();
    await settle();
    expect(signal.aborted).toBeTrue();
    expect(port.disconnectCalls).toBe(1);
    expect(scheduler.scheduled).toEqual([]);

    completion.resolve({ text: 'late', parsed: null, tokensUsed: 1 });
    await settle();
    expect(port.sent).toEqual([]);
    expect(runtime.connections).toHaveLength(1);

    await port.onDisconnect.dispatch();
    expect(scheduler.scheduled).toEqual([]);
    expect(runtime.connections).toHaveLength(1);
  });

  test('explicit disconnect physically cancels an already-scheduled reconnect timer', async () => {
    const port = createPort();
    const replacement = createPort();
    const runtime = createRuntime(port, replacement);
    const scheduledDelays = [];
    let callbacksRun = 0;
    const broker = startChromeAIBroker({
      runtime,
      scheduleReconnect(callback, delay) {
        scheduledDelays.push(delay);
        return setTimeout(() => {
          callbacksRun += 1;
          callback();
        }, 5);
      },
      createProvider: () => ({}),
    });

    await port.onDisconnect.dispatch();
    expect(scheduledDelays).toEqual([100]);
    broker.disconnect();
    await Bun.sleep(20);

    expect(callbacksRun).toBe(0);
    expect(runtime.connections).toHaveLength(1);
    expect(broker.port).toBeNull();
  });
});
