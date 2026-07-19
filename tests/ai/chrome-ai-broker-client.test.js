import { describe, expect, test } from 'bun:test';

import * as brokerModule from '../../core/ai/chrome-ai-broker-client.js';
import {
  AIAbortError,
  AIForegroundRequiredError,
  AIMalformedResultError,
  AINetworkError,
  AITimeoutError,
  AIUnavailableError,
} from '../../core/ai/provider.js';
import { createRuntimePortPair } from '../helpers/chrome-mock.js';

const { ChromeAIBrokerClient } = brokerModule;

const PORT_NAME = 'tabkebab:chrome-ai';

function completionRequest(label) {
  return {
    userPrompt: `Classify ${label}`,
    systemPrompt: 'Return a concise result.',
    maxTokens: 64,
    temperature: 0.2,
    responseFormat: 'json',
  };
}

function completionValue(label) {
  return {
    text: `Result ${label}`,
    parsed: { label },
    tokensUsed: 7,
  };
}

function trackingSignal() {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;

  return {
    controller,
    signal: {
      get aborted() {
        return controller.signal.aborted;
      },
      get reason() {
        return controller.signal.reason;
      },
      addEventListener(type, listener, options) {
        added += 1;
        controller.signal.addEventListener(type, listener, options);
      },
      removeEventListener(type, listener, options) {
        removed += 1;
        controller.signal.removeEventListener(type, listener, options);
      },
    },
    get added() {
      return added;
    },
    get removed() {
      return removed;
    },
  };
}

describe('ChromeAIBrokerClient foreground requirement', () => {
  test('rejects availability checks when no side-panel broker is attached', async () => {
    const client = new ChromeAIBrokerClient();
    const error = await client.testConnection({}, undefined).catch((reason) => reason);

    expect(error?.name).toBe('AIForegroundRequiredError');
    expect(error?.code).toBe('AI_FOREGROUND_REQUIRED');
  });

  test('exports one reusable broker-client singleton', () => {
    expect(brokerModule.chromeAIBrokerClient).toBeInstanceOf(ChromeAIBrokerClient);
  });
});

describe('ChromeAIBrokerClient request correlation', () => {
  test('ignores an unrelated port and still reports that foreground is required', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair('some-other-feature');
    const outbound = [];
    clientPort.onMessage.addListener((message) => outbound.push(message));

    client.attachPort(workerPort);
    const error = await client.testConnection({}, undefined).catch((reason) => reason);

    expect(error?.code).toBe('AI_FOREGROUND_REQUIRED');
    expect(outbound).toEqual([]);
  });

  test('attaches the named port and resolves an availability response', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    clientPort.onMessage.addListener((message) => {
      outbound.push(message);
      return clientPort.postMessage({
        type: 'chrome-ai/result',
        requestId: message.requestId,
        ok: true,
        value: true,
      });
    });

    client.attachPort(workerPort);

    await expect(client.testConnection({ ignored: true }, undefined)).resolves.toBeTrue();
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toEqual({
      type: 'chrome-ai/request',
      requestId: outbound[0].requestId,
      method: 'availability',
      payload: {},
    });
  });

  test('uses crypto.randomUUID for every request and correlates out-of-order responses', async () => {
    const requestIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const originalRandomUUID = crypto.randomUUID;
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    clientPort.onMessage.addListener((message) => outbound.push(message));
    crypto.randomUUID = () => requestIds.shift();

    try {
      client.attachPort(workerPort);
      const first = client.complete(completionRequest('first'), {}, undefined);
      const second = client.complete(completionRequest('second'), {}, undefined);

      expect(outbound.map((message) => message.requestId)).toEqual([
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ]);
      expect(outbound.map((message) => message.payload)).toEqual([
        { request: completionRequest('first') },
        { request: completionRequest('second') },
      ]);

      await clientPort.postMessage({
        type: 'chrome-ai/result',
        requestId: outbound[1].requestId,
        ok: true,
        value: completionValue('second'),
      });
      await expect(second).resolves.toEqual(completionValue('second'));

      let firstSettled = false;
      first.finally(() => {
        firstSettled = true;
      }).catch(() => {});
      await Promise.resolve();
      expect(firstSettled).toBeFalse();

      await clientPort.postMessage({
        type: 'chrome-ai/result',
        requestId: outbound[0].requestId,
        ok: true,
        value: completionValue('first'),
      });
      await expect(first).resolves.toEqual(completionValue('first'));
    } finally {
      crypto.randomUUID = originalRandomUUID;
      client.disconnect();
    }
  });

  test('does not overwrite pending work if the UUID source repeats a value', async () => {
    const repeatedId = '33333333-3333-4333-8333-333333333333';
    const replacementId = '44444444-4444-4444-8444-444444444444';
    const generated = [repeatedId, repeatedId, replacementId];
    const originalRandomUUID = crypto.randomUUID;
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    clientPort.onMessage.addListener((message) => outbound.push(message));
    crypto.randomUUID = () => generated.shift();

    try {
      client.attachPort(workerPort);
      const first = client.complete(completionRequest('first-collision'), {}, undefined);
      const second = client.complete(completionRequest('second-collision'), {}, undefined);

      expect(outbound.map((message) => message.requestId)).toEqual([
        repeatedId,
        replacementId,
      ]);

      await clientPort.postMessage({
        type: 'chrome-ai/result',
        requestId: repeatedId,
        ok: true,
        value: completionValue('first-collision'),
      });
      await clientPort.postMessage({
        type: 'chrome-ai/result',
        requestId: replacementId,
        ok: true,
        value: completionValue('second-collision'),
      });
      await expect(first).resolves.toEqual(completionValue('first-collision'));
      await expect(second).resolves.toEqual(completionValue('second-collision'));
    } finally {
      crypto.randomUUID = originalRandomUUID;
      client.disconnect();
    }
  });
});

describe('ChromeAIBrokerClient response handling', () => {
  for (const [code, ErrorType] of [
    ['AI_ABORTED', AIAbortError],
    ['AI_TIMEOUT', AITimeoutError],
    ['AI_UNAVAILABLE', AIUnavailableError],
    ['AI_FOREGROUND_REQUIRED', AIForegroundRequiredError],
    ['AI_NETWORK', AINetworkError],
    ['AI_MALFORMED_RESULT', AIMalformedResultError],
  ]) {
    test(`rehydrates ${code} without losing its safe message`, async () => {
      const client = new ChromeAIBrokerClient();
      const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
      let outbound;
      clientPort.onMessage.addListener((message) => {
        outbound = message;
      });
      client.attachPort(workerPort);

      const pending = client.complete(completionRequest(code), {}, undefined);
      await clientPort.postMessage({
        type: 'chrome-ai/result',
        requestId: outbound.requestId,
        ok: false,
        error: { code, message: `Safe ${code} detail.` },
      });
      const error = await pending.catch((reason) => reason);

      expect(error).toBeInstanceOf(ErrorType);
      expect(error.code).toBe(code);
      expect(error.message).toBe(`Safe ${code} detail.`);
    });
  }

  test('ignores unknown IDs and duplicate results without disturbing another request', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    let outbound;
    clientPort.onMessage.addListener((message) => {
      outbound = message;
    });
    client.attachPort(workerPort);

    const pending = client.complete(completionRequest('kept'), {}, undefined);
    let settled = false;
    pending.finally(() => {
      settled = true;
    }).catch(() => {});

    await clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      ok: true,
      value: completionValue('unknown'),
    });
    await Promise.resolve();
    expect(settled).toBeFalse();

    await clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: outbound.requestId,
      ok: true,
      value: completionValue('kept'),
    });
    await expect(pending).resolves.toEqual(completionValue('kept'));

    await expect(clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: outbound.requestId,
      ok: false,
      error: { code: 'AI_UNAVAILABLE', message: 'duplicate must be ignored' },
    })).resolves.toBeDefined();
  });

  test('rejects and clears a matching malformed result', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    const external = trackingSignal();
    clientPort.onMessage.addListener((message) => outbound.push(message));
    client.attachPort(workerPort);

    const pending = client.complete(completionRequest('malformed'), {}, external.signal);
    await clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: outbound[0].requestId,
      ok: true,
      value: { text: 'missing parsed and token fields' },
    });
    const error = await pending.catch((reason) => reason);

    expect(error).toBeInstanceOf(AIMalformedResultError);
    expect(error.code).toBe('AI_MALFORMED_RESULT');
    expect(external.removed).toBe(1);
    external.controller.abort('settled-request');
    expect(outbound.filter((message) => message.type === 'chrome-ai/cancel')).toEqual([]);
  });

  test('safely ignores an uninspectable request ID while keeping the matching work pending', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    let outbound;
    clientPort.onMessage.addListener((message) => {
      outbound = message;
    });
    client.attachPort(workerPort);

    const pending = client.complete(completionRequest('safe-inspection'), {}, undefined);
    let settled = false;
    pending.finally(() => {
      settled = true;
    }).catch(() => {});
    const hostile = { type: 'chrome-ai/result', ok: true, value: true };
    Object.defineProperty(hostile, 'requestId', {
      enumerable: true,
      get() {
        throw new Error('must not execute');
      },
    });

    await expect(workerPort.onMessage.dispatch(hostile, workerPort)).resolves.toBeDefined();
    await Promise.resolve();
    expect(settled).toBeFalse();

    await clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: outbound.requestId,
      ok: true,
      value: completionValue('safe-inspection'),
    });
    await expect(pending).resolves.toEqual(completionValue('safe-inspection'));
  });

  test('rejects success values that do not match the pending request method', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    clientPort.onMessage.addListener((message) => outbound.push(message));
    client.attachPort(workerPort);

    const availability = client.testConnection({}, undefined);
    await clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: outbound[0].requestId,
      ok: true,
      value: completionValue('wrong-availability-shape'),
    });
    await expect(availability).rejects.toBeInstanceOf(AIMalformedResultError);

    const completion = client.complete(completionRequest('wrong-shape'), {}, undefined);
    await clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: outbound[1].requestId,
      ok: true,
      value: true,
    });
    await expect(completion).rejects.toBeInstanceOf(AIMalformedResultError);
  });

  test('validates outgoing completion payloads before posting them', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    clientPort.onMessage.addListener((message) => outbound.push(message));
    client.attachPort(workerPort);

    const error = await client.complete({
      ...completionRequest('invalid'),
      maxTokens: 0,
    }, {}, undefined).catch((reason) => reason);

    expect(error).toBeInstanceOf(AIMalformedResultError);
    expect(error.code).toBe('AI_MALFORMED_RESULT');
    expect(outbound).toEqual([]);
  });
});

describe('ChromeAIBrokerClient cancellation', () => {
  test('rejects an invalid signal without retaining or posting a request', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    clientPort.onMessage.addListener((message) => outbound.push(message));
    client.attachPort(workerPort);

    const error = await client.complete(
      completionRequest('bad-signal'),
      {},
      { aborted: false },
    ).catch((reason) => reason);

    expect(error).toBeInstanceOf(TypeError);
    expect(client.pending.size).toBe(0);
    expect(outbound).toEqual([]);
  });

  test('rejects a pre-aborted request without posting work or a cancel message', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    clientPort.onMessage.addListener((message) => outbound.push(message));
    const controller = new AbortController();
    controller.abort('navigation');
    client.attachPort(workerPort);

    const error = await client.complete(
      completionRequest('pre-aborted'),
      {},
      controller.signal,
    ).catch((reason) => reason);

    expect(error).toBeInstanceOf(AIAbortError);
    expect(error.code).toBe('AI_ABORTED');
    expect(outbound).toEqual([]);
  });

  test('posts exactly one cancel and waits for the panel cleanup result before rejecting', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    clientPort.onMessage.addListener((message) => outbound.push(message));
    const external = trackingSignal();
    client.attachPort(workerPort);

    const pending = client.complete(completionRequest('cancel'), {}, external.signal);
    const requestId = outbound[0].requestId;
    let settled = false;
    pending.finally(() => {
      settled = true;
    }).catch(() => {});
    external.controller.abort('timeout');
    external.controller.abort('duplicate');
    expect(outbound).toEqual([
      {
        type: 'chrome-ai/request',
        requestId,
        method: 'complete',
        payload: { request: completionRequest('cancel') },
      },
      { type: 'chrome-ai/cancel', requestId },
    ]);
    await Promise.resolve();
    expect(settled).toBeFalse();

    await clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId,
      ok: false,
      error: { code: 'AI_ABORTED', message: 'Panel cleanup completed.' },
    });
    const error = await pending.catch((reason) => reason);
    expect(error).toBeInstanceOf(AIAbortError);
    expect(error.code).toBe('AI_ABORTED');
    expect(external.added).toBe(1);
    expect(external.removed).toBe(1);
    expect(outbound.filter((message) => message.type === 'chrome-ai/cancel')).toHaveLength(1);
  });

  test('uses a result racing with cancel as the cleanup barrier while abort still wins', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    clientPort.onMessage.addListener((message) => outbound.push(message));
    const controller = new AbortController();
    client.attachPort(workerPort);

    const pending = client.complete(completionRequest('late-success'), {}, controller.signal);
    let settled = false;
    pending.finally(() => {
      settled = true;
    }).catch(() => {});
    controller.abort('navigation');
    await clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: outbound[0].requestId,
      ok: true,
      value: completionValue('must-not-win'),
    });

    const error = await Promise.race([
      pending.catch((reason) => reason),
      Bun.sleep(20).then(() => new Error('cancel/result race did not settle')),
    ]);
    expect(error).toBeInstanceOf(AIAbortError);
    expect(error.code).toBe('AI_ABORTED');
    expect(settled).toBeTrue();
    expect(client.pending.size).toBe(0);
    expect(outbound.filter((message) => message.type === 'chrome-ai/cancel')).toHaveLength(1);
  });

  test('uses a malformed matching result as the cleanup barrier while abort still wins', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    clientPort.onMessage.addListener((message) => outbound.push(message));
    const controller = new AbortController();
    client.attachPort(workerPort);

    const pending = client.complete(completionRequest('malformed-after-cancel'), {}, controller.signal);
    controller.abort('navigation');
    await clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: outbound[0].requestId,
      ok: true,
      value: { text: 'missing parsed and token fields' },
    });

    const error = await Promise.race([
      pending.catch((reason) => reason),
      Bun.sleep(20).then(() => new Error('cancel/malformed-result race did not settle')),
    ]);
    expect(error).toBeInstanceOf(AIAbortError);
    expect(error.code).toBe('AI_ABORTED');
    expect(client.pending.size).toBe(0);
    expect(outbound.filter((message) => message.type === 'chrome-ai/cancel')).toHaveLength(1);
  });

  test('removes the abort listener after a response and never cancels settled work', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    const external = trackingSignal();
    clientPort.onMessage.addListener((message) => outbound.push(message));
    client.attachPort(workerPort);

    const pending = client.complete(completionRequest('settled'), {}, external.signal);
    await clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: outbound[0].requestId,
      ok: true,
      value: completionValue('settled'),
    });
    await expect(pending).resolves.toEqual(completionValue('settled'));

    expect(external.added).toBe(1);
    expect(external.removed).toBe(1);
    external.controller.abort('too-late');
    expect(outbound.filter((message) => message.type === 'chrome-ai/cancel')).toEqual([]);
  });
});

describe('ChromeAIBrokerClient port lifecycle', () => {
  test('rejects every pending request when the attached port disconnects', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    const outbound = [];
    const firstSignal = trackingSignal();
    const secondSignal = trackingSignal();
    clientPort.onMessage.addListener((message) => outbound.push(message));
    client.attachPort(workerPort);

    const first = client.complete(completionRequest('first'), {}, firstSignal.signal);
    const second = client.testConnection({}, secondSignal.signal);
    await workerPort.disconnect();
    const [firstError, secondError] = await Promise.all([
      first.catch((reason) => reason),
      second.catch((reason) => reason),
    ]);

    expect(firstError).toBeInstanceOf(AIForegroundRequiredError);
    expect(secondError).toBeInstanceOf(AIForegroundRequiredError);
    expect(firstSignal.removed).toBe(1);
    expect(secondSignal.removed).toBe(1);
    firstSignal.controller.abort('too-late');
    secondSignal.controller.abort('too-late');
    expect(outbound.filter((message) => message.type === 'chrome-ai/cancel')).toEqual([]);
  });

  test('explicit disconnect rejects pending work and closes the active port', async () => {
    const client = new ChromeAIBrokerClient();
    const { clientPort, workerPort } = createRuntimePortPair(PORT_NAME);
    let panelDisconnects = 0;
    clientPort.onDisconnect.addListener(() => {
      panelDisconnects += 1;
    });
    client.attachPort(workerPort);

    const pending = client.complete(completionRequest('explicit'), {}, undefined);
    client.disconnect();

    const error = await pending.catch((reason) => reason);
    expect(error).toBeInstanceOf(AIForegroundRequiredError);
    await Promise.resolve();
    expect(panelDisconnects).toBe(1);
    await expect(client.testConnection({}, undefined)).rejects.toBeInstanceOf(
      AIForegroundRequiredError,
    );
  });

  test('replacement cancels and settles old work before activating the new generation', async () => {
    const client = new ChromeAIBrokerClient();
    const oldPair = createRuntimePortPair(PORT_NAME);
    const newPair = createRuntimePortPair(PORT_NAME);
    const oldOutbound = [];
    const newOutbound = [];
    oldPair.clientPort.onMessage.addListener((message) => oldOutbound.push(message));
    newPair.clientPort.onMessage.addListener((message) => newOutbound.push(message));
    client.attachPort(oldPair.workerPort);

    const oldPending = client.complete(completionRequest('old'), {}, undefined);
    let oldSettled = false;
    oldPending.finally(() => { oldSettled = true; }).catch(() => {});
    client.attachPort(newPair.workerPort);
    expect(oldSettled).toBeFalse();
    expect(client.port).toBe(oldPair.workerPort);
    expect(oldOutbound.map(({ type }) => type)).toEqual([
      'chrome-ai/request',
      'chrome-ai/cancel',
    ]);
    await expect(client.complete(completionRequest('too-early'), {}, undefined))
      .rejects.toBeInstanceOf(AIForegroundRequiredError);

    await oldPair.clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: oldOutbound[0].requestId,
      ok: false,
      error: { code: 'AI_ABORTED', message: 'Old provider cleanup completed.' },
    });
    const oldError = await oldPending.catch((reason) => reason);
    expect(oldError).toBeInstanceOf(AIForegroundRequiredError);
    expect(client.port).toBe(newPair.workerPort);

    const current = client.complete(completionRequest('new'), {}, undefined);
    let currentSettled = false;
    current.finally(() => {
      currentSettled = true;
    }).catch(() => {});

    await oldPair.workerPort.onMessage.dispatch({
      type: 'chrome-ai/result',
      requestId: newOutbound[0].requestId,
      ok: true,
      value: completionValue('stale-old-port'),
    }, oldPair.workerPort);
    await oldPair.workerPort.onDisconnect.dispatch(oldPair.workerPort);
    await Promise.resolve();
    expect(currentSettled).toBeFalse();

    await newPair.clientPort.postMessage({
      type: 'chrome-ai/result',
      requestId: newOutbound[0].requestId,
      ok: true,
      value: completionValue('new'),
    });
    await expect(current).resolves.toEqual(completionValue('new'));
    expect(oldOutbound).toHaveLength(2);
    expect(newOutbound).toHaveLength(1);
  });

  test('promotes a still-open standby when the newest panel disconnects', async () => {
    const client = new ChromeAIBrokerClient();
    const oldPair = createRuntimePortPair(PORT_NAME);
    const newPair = createRuntimePortPair(PORT_NAME);
    const oldOutbound = [];
    oldPair.clientPort.onMessage.addListener((message) => {
      oldOutbound.push(message);
      if (message.type !== 'chrome-ai/request') return;
      return oldPair.clientPort.postMessage({
        type: 'chrome-ai/result',
        requestId: message.requestId,
        ok: true,
        value: completionValue('standby'),
      });
    });

    client.attachPort(oldPair.workerPort);
    client.attachPort(newPair.workerPort);
    expect(client.port).toBe(newPair.workerPort);

    await newPair.workerPort.disconnect();
    expect(client.port).toBe(oldPair.workerPort);

    await expect(client.complete(completionRequest('standby'), {}, undefined))
      .resolves.toEqual(completionValue('standby'));
    expect(oldOutbound).toHaveLength(1);

    client.disconnect();
  });
});
