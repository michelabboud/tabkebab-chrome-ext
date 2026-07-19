import { describe, expect, test } from 'bun:test';

import {
  CHROME_AI_PORT_NAME,
  MAX_CHROME_AI_RESULT_BYTES,
  MAX_CHROME_AI_SYSTEM_PROMPT_CHARS,
  MAX_CHROME_AI_USER_PROMPT_CHARS,
  parseChromeAIRequest,
  parseChromeAIResult,
  serializeChromeAIError,
} from '../../core/ai/chrome-ai-protocol.js';
import {
  AIAbortError,
  AIForegroundRequiredError,
  AIMalformedResultError,
  AINetworkError,
  AITimeoutError,
  AIUnavailableError,
} from '../../core/ai/provider.js';

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_REQUEST_ID = '123e4567-e89b-42d3-a456-426614174001';

function completeRequest(overrides = {}) {
  return {
    userPrompt: 'Group these tabs',
    maxTokens: 512,
    temperature: 0.2,
    ...overrides,
  };
}

function requestMessage(overrides = {}) {
  return {
    type: 'chrome-ai/request',
    requestId: REQUEST_ID,
    method: 'complete',
    payload: { request: completeRequest() },
    ...overrides,
  };
}

function resultMessage(value, overrides = {}) {
  return {
    type: 'chrome-ai/result',
    requestId: REQUEST_ID,
    ok: true,
    value,
    ...overrides,
  };
}

function expectMalformed(operation, requestId = REQUEST_ID) {
  let received;
  try {
    operation();
  } catch (error) {
    received = error;
  }
  expect(received).toBeInstanceOf(AIMalformedResultError);
  expect(received.code).toBe('AI_MALFORMED_RESULT');
  expect(received.requestId).toBe(requestId);
}

function nestedArray(depth) {
  let value = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function nullRecord(entries) {
  return Object.assign(Object.create(null), entries);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

describe('Chrome AI protocol constants', () => {
  test('exports the fixed broker name and resource limits', () => {
    expect(CHROME_AI_PORT_NAME).toBe('tabkebab:chrome-ai');
    expect(MAX_CHROME_AI_USER_PROMPT_CHARS).toBe(200_000);
    expect(MAX_CHROME_AI_SYSTEM_PROMPT_CHARS).toBe(50_000);
    expect(MAX_CHROME_AI_RESULT_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('parseChromeAIRequest', () => {
  test('accepts and normalizes availability, complete, and cancel messages', () => {
    expect(parseChromeAIRequest({
      type: 'chrome-ai/request',
      requestId: REQUEST_ID,
      method: 'availability',
      payload: {},
    })).toEqual({
      type: 'chrome-ai/request',
      requestId: REQUEST_ID,
      method: 'availability',
      payload: {},
    });

    expect(parseChromeAIRequest(requestMessage({
      requestId: OTHER_REQUEST_ID,
      payload: {
        request: completeRequest({
          systemPrompt: '',
          userPrompt: 'x'.repeat(MAX_CHROME_AI_USER_PROMPT_CHARS),
          maxTokens: 8192,
          temperature: 2,
          responseFormat: 'json',
        }),
      },
    }))).toEqual({
      type: 'chrome-ai/request',
      requestId: OTHER_REQUEST_ID,
      method: 'complete',
      payload: {
        request: {
          systemPrompt: '',
          userPrompt: 'x'.repeat(MAX_CHROME_AI_USER_PROMPT_CHARS),
          maxTokens: 8192,
          temperature: 2,
          responseFormat: 'json',
        },
      },
    });

    expect(parseChromeAIRequest({
      type: 'chrome-ai/cancel',
      requestId: REQUEST_ID,
    })).toEqual({ type: 'chrome-ai/cancel', requestId: REQUEST_ID });
  });

  test('returns fresh request snapshots and accepts deeply frozen input', () => {
    const rawRequest = completeRequest({ systemPrompt: 'system', responseFormat: 'json' });
    const rawPayload = { request: rawRequest };
    const rawMessage = requestMessage({ payload: rawPayload });
    const parsed = parseChromeAIRequest(rawMessage);

    expect(parsed).not.toBe(rawMessage);
    expect(parsed.payload).not.toBe(rawPayload);
    expect(parsed.payload.request).not.toBe(rawRequest);

    rawMessage.method = 'availability';
    rawPayload.request = null;
    rawRequest.userPrompt = 'mutated';
    expect(parsed).toEqual(requestMessage({
      payload: {
        request: completeRequest({ systemPrompt: 'system', responseFormat: 'json' }),
      },
    }));

    const frozen = deepFreeze(requestMessage({
      payload: { request: completeRequest({ systemPrompt: 'frozen' }) },
    }));
    const frozenParsed = parseChromeAIRequest(frozen);
    expect(frozenParsed).not.toBe(frozen);
    expect(frozenParsed.payload).not.toBe(frozen.payload);
    expect(frozenParsed.payload.request).not.toBe(frozen.payload.request);
  });

  test('accepts null-prototype request envelope, payload, and request records', () => {
    const request = nullRecord({
      userPrompt: 'hello',
      systemPrompt: '',
      maxTokens: 32,
      temperature: 0,
      responseFormat: 'json',
    });
    const payload = nullRecord({ request });
    const message = nullRecord({
      type: 'chrome-ai/request',
      requestId: REQUEST_ID,
      method: 'complete',
      payload,
    });

    const parsed = parseChromeAIRequest(message);
    expect(parsed).toEqual({
      type: 'chrome-ai/request',
      requestId: REQUEST_ID,
      method: 'complete',
      payload: {
        request: {
          userPrompt: 'hello',
          systemPrompt: '',
          maxTokens: 32,
          temperature: 0,
          responseFormat: 'json',
        },
      },
    });
    expect(parsed).not.toBe(message);
    expect(parsed.payload).not.toBe(payload);
    expect(parsed.payload.request).not.toBe(request);
  });

  test('ignores messages that do not contain a valid UUID request ID', () => {
    const invalidMessages = [
      null,
      [],
      {},
      { requestId: 42 },
      { requestId: '' },
      { requestId: 'not-a-uuid' },
      { requestId: '123e4567-e89b-42d3-a456-426614174000'.padEnd(65, '0') },
      { requestId: REQUEST_ID.toUpperCase() },
      { requestId: '123e4567-e89b-12d3-a456-426614174000' },
      { requestId: '00000000-0000-0000-0000-000000000000' },
      { requestId: '123e4567-e89b-42d3-7456-426614174000' },
      Object.defineProperty({}, 'requestId', { enumerable: true, get() { throw new Error('no'); } }),
    ];

    for (const message of invalidMessages) {
      expect(parseChromeAIRequest(message)).toBeNull();
    }
  });

  test('rejects malformed top-level request and cancel envelopes when the ID is valid', () => {
    const invalidMessages = [
      { type: 'unknown', requestId: REQUEST_ID },
      { type: 'chrome-ai/cancel', requestId: REQUEST_ID, extra: true },
      { type: 'chrome-ai/request', requestId: REQUEST_ID },
      { ...requestMessage(), extra: true },
      { ...requestMessage(), method: 'unknown' },
      Object.assign(Object.create({ inherited: true }), requestMessage()),
    ];

    for (const message of invalidMessages) {
      expectMalformed(() => parseChromeAIRequest(message));
    }
  });

  test('requires the availability payload to be exactly an empty plain object', () => {
    const base = {
      type: 'chrome-ai/request',
      requestId: REQUEST_ID,
      method: 'availability',
    };
    for (const payload of [null, [], { extra: true }, '']) {
      expectMalformed(() => parseChromeAIRequest({ ...base, payload }));
    }
  });

  test('requires complete payload and request records to have only the specified fields', () => {
    const invalidMessages = [
      requestMessage({ payload: null }),
      requestMessage({ payload: completeRequest() }),
      requestMessage({ payload: { request: completeRequest(), extra: true } }),
      requestMessage({ payload: { request: null } }),
      requestMessage({ payload: { request: { ...completeRequest(), extra: true } } }),
      requestMessage({ payload: { request: { userPrompt: 'hello', maxTokens: 32 } } }),
      requestMessage({ payload: { request: { userPrompt: 'hello', temperature: 0.2 } } }),
    ];

    for (const message of invalidMessages) {
      expectMalformed(() => parseChromeAIRequest(message));
    }
  });

  test('enforces user and system prompt types and character limits', () => {
    const invalidRequests = [
      completeRequest({ userPrompt: '' }),
      completeRequest({ userPrompt: 42 }),
      completeRequest({ userPrompt: 'x'.repeat(MAX_CHROME_AI_USER_PROMPT_CHARS + 1) }),
      completeRequest({ systemPrompt: null }),
      completeRequest({ systemPrompt: 42 }),
      completeRequest({ systemPrompt: 'x'.repeat(MAX_CHROME_AI_SYSTEM_PROMPT_CHARS + 1) }),
    ];

    for (const request of invalidRequests) {
      expectMalformed(() => parseChromeAIRequest(requestMessage({ payload: { request } })));
    }

    expect(parseChromeAIRequest(requestMessage({
      payload: {
        request: completeRequest({
          userPrompt: 'x'.repeat(MAX_CHROME_AI_USER_PROMPT_CHARS),
          systemPrompt: 'x'.repeat(MAX_CHROME_AI_SYSTEM_PROMPT_CHARS),
        }),
      },
    }))).not.toBeNull();
  });

  test('enforces maxTokens as an integer from 1 through 8192', () => {
    for (const maxTokens of [0, 8193, 1.5, NaN, Infinity, '32', null]) {
      expectMalformed(() => parseChromeAIRequest(requestMessage({
        payload: { request: completeRequest({ maxTokens }) },
      })));
    }

    for (const maxTokens of [1, 8192]) {
      expect(parseChromeAIRequest(requestMessage({
        payload: { request: completeRequest({ maxTokens }) },
      })).payload.request.maxTokens).toBe(maxTokens);
    }
  });

  test('enforces temperature as a finite number from 0 through 2', () => {
    for (const temperature of [-0.01, 2.01, NaN, Infinity, '0.2', null]) {
      expectMalformed(() => parseChromeAIRequest(requestMessage({
        payload: { request: completeRequest({ temperature }) },
      })));
    }

    for (const temperature of [0, 2]) {
      expect(parseChromeAIRequest(requestMessage({
        payload: { request: completeRequest({ temperature }) },
      })).payload.request.temperature).toBe(temperature);
    }
  });

  test("allows responseFormat to be absent or 'json' only", () => {
    expect(parseChromeAIRequest(requestMessage()).payload.request.responseFormat).toBeUndefined();
    expect(parseChromeAIRequest(requestMessage({
      payload: { request: completeRequest({ responseFormat: 'json' }) },
    })).payload.request.responseFormat).toBe('json');

    for (const responseFormat of ['text', '', null, true]) {
      expectMalformed(() => parseChromeAIRequest(requestMessage({
        payload: { request: completeRequest({ responseFormat }) },
      })));
    }
  });

  test('rejects symbol, accessor, and prototype-pollution request fields', () => {
    const withSymbol = requestMessage();
    withSymbol[Symbol('extra')] = true;

    const withAccessor = requestMessage();
    Object.defineProperty(withAccessor, 'method', {
      enumerable: true,
      get() { return 'complete'; },
    });

    const requestWithDangerousKey = completeRequest();
    Object.defineProperty(requestWithDangerousKey, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 'pollution',
    });

    for (const message of [
      withSymbol,
      withAccessor,
      requestMessage({ payload: { request: requestWithDangerousKey } }),
    ]) {
      expectMalformed(() => parseChromeAIRequest(message));
    }
  });
});

describe('parseChromeAIResult', () => {
  test('accepts availability booleans and normalizes bounded completion results', () => {
    expect(parseChromeAIResult(resultMessage(true))).toEqual(resultMessage(true));
    expect(parseChromeAIResult(resultMessage(false))).toEqual(resultMessage(false));

    const parsed = { groups: [{ name: 'Work', score: 1 }], empty: null };
    const received = parseChromeAIResult(resultMessage({
      text: '{"groups":[]}',
      parsed,
      tokensUsed: 0,
    }));
    expect(received).toEqual(resultMessage({
      text: '{"groups":[]}',
      parsed,
      tokensUsed: 0,
    }));
    expect(received.value.parsed).not.toBe(parsed);
    expect(Object.getPrototypeOf(received.value.parsed)).toBeNull();
  });

  test('returns fresh success snapshots and accepts deeply frozen input', () => {
    const rawParsed = { nested: { label: 'original' } };
    const rawValue = { text: 'answer', parsed: rawParsed, tokensUsed: 4 };
    const rawMessage = resultMessage(rawValue);
    const parsed = parseChromeAIResult(rawMessage);

    expect(parsed).not.toBe(rawMessage);
    expect(parsed.value).not.toBe(rawValue);
    expect(parsed.value.parsed).not.toBe(rawParsed);
    expect(parsed.value.parsed.nested).not.toBe(rawParsed.nested);

    rawMessage.ok = false;
    rawValue.text = 'mutated';
    rawParsed.nested.label = 'mutated';
    expect(parsed.value).toEqual({
      text: 'answer',
      parsed: { nested: { label: 'original' } },
      tokensUsed: 4,
    });

    const frozen = deepFreeze(resultMessage({
      text: 'frozen',
      parsed: { nested: ['value'] },
      tokensUsed: 1,
    }));
    const frozenParsed = parseChromeAIResult(frozen);
    expect(frozenParsed).not.toBe(frozen);
    expect(frozenParsed.value).not.toBe(frozen.value);
    expect(frozenParsed.value.parsed).not.toBe(frozen.value.parsed);
  });

  test('returns fresh error snapshots and accepts frozen and null-prototype records', () => {
    const rawError = nullRecord({ code: 'AI_TIMEOUT', message: '' });
    const rawMessage = nullRecord({
      type: 'chrome-ai/result',
      requestId: REQUEST_ID,
      ok: false,
      error: rawError,
    });
    deepFreeze(rawMessage);

    const parsed = parseChromeAIResult(rawMessage);
    expect(parsed).toEqual({
      type: 'chrome-ai/result',
      requestId: REQUEST_ID,
      ok: false,
      error: { code: 'AI_TIMEOUT', message: '' },
    });
    expect(parsed).not.toBe(rawMessage);
    expect(parsed.error).not.toBe(rawError);

    const mutableError = { code: 'AI_NETWORK', message: 'original' };
    const mutable = {
      type: 'chrome-ai/result',
      requestId: REQUEST_ID,
      ok: false,
      error: mutableError,
    };
    const snapshot = parseChromeAIResult(mutable);
    mutable.ok = true;
    mutableError.message = 'mutated';
    expect(snapshot.error).toEqual({ code: 'AI_NETWORK', message: 'original' });
  });

  test('accepts null-prototype success envelope, value, and parsed records', () => {
    const parsedValue = nullRecord({ nested: nullRecord({ value: true }) });
    const value = nullRecord({ text: 'ok', parsed: parsedValue, tokensUsed: 1 });
    const message = nullRecord({
      type: 'chrome-ai/result',
      requestId: REQUEST_ID,
      ok: true,
      value,
    });

    const parsed = parseChromeAIResult(message);
    expect(parsed).not.toBe(message);
    expect(parsed.value).not.toBe(value);
    expect(parsed.value.parsed).not.toBe(parsedValue);
    expect(parsed.value).toEqual({
      text: 'ok',
      parsed: { nested: { value: true } },
      tokensUsed: 1,
    });
  });

  test('ignores result messages without a valid UUID request ID', () => {
    for (const message of [
      null,
      {},
      { type: 'chrome-ai/result', requestId: 'bad', ok: true, value: true },
      { type: 'chrome-ai/result', requestId: 42, ok: true, value: true },
      { type: 'chrome-ai/result', requestId: REQUEST_ID.toUpperCase(), ok: true, value: true },
      {
        type: 'chrome-ai/result',
        requestId: '123e4567-e89b-12d3-a456-426614174000',
        ok: true,
        value: true,
      },
      {
        type: 'chrome-ai/result',
        requestId: '123e4567-e89b-42d3-7456-426614174000',
        ok: true,
        value: true,
      },
    ]) {
      expect(parseChromeAIResult(message)).toBeNull();
    }
  });

  test('rejects malformed result envelopes with a valid request ID', () => {
    const invalidMessages = [
      { type: 'unknown', requestId: REQUEST_ID, ok: true, value: true },
      { type: 'chrome-ai/result', requestId: REQUEST_ID, value: true },
      { type: 'chrome-ai/result', requestId: REQUEST_ID, ok: 'true', value: true },
      { ...resultMessage(true), error: { code: 'AI_ABORTED', message: 'cancelled' } },
      { ...resultMessage(true), extra: true },
      Object.assign(Object.create({ inherited: true }), resultMessage(true)),
    ];

    for (const message of invalidMessages) {
      expectMalformed(() => parseChromeAIResult(message));
    }
  });

  test('requires completion success to contain exactly text, parsed, and tokensUsed', () => {
    const invalidValues = [
      null,
      [],
      { text: 'ok', parsed: null },
      { text: 'ok', tokensUsed: 1 },
      { parsed: null, tokensUsed: 1 },
      { text: 'ok', parsed: null, tokensUsed: 1, extra: true },
      { text: 42, parsed: null, tokensUsed: 1 },
    ];

    for (const value of invalidValues) {
      expectMalformed(() => parseChromeAIResult(resultMessage(value)));
    }
  });

  test('requires tokensUsed to be a non-negative safe integer', () => {
    for (const tokensUsed of [-1, 0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expectMalformed(() => parseChromeAIResult(resultMessage({
        text: 'ok', parsed: null, tokensUsed,
      })));
    }

    expect(parseChromeAIResult(resultMessage({
      text: 'ok', parsed: null, tokensUsed: Number.MAX_SAFE_INTEGER,
    })).value.tokensUsed).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('accepts JSON-only parsed values through depth 12', () => {
    const values = [null, true, false, 'text', 0, -1.5, [], {}, nestedArray(12)];
    for (const parsed of values) {
      expect(parseChromeAIResult(resultMessage({ text: 'ok', parsed, tokensUsed: 1 }))).not.toBeNull();
    }
  });

  test('rejects parsed values deeper than 12 or outside JSON semantics', () => {
    const cycle = {};
    cycle.self = cycle;
    const sparse = [];
    sparse.length = 2;
    sparse[1] = 'present';
    const withSymbol = { valid: true };
    withSymbol[Symbol('extra')] = true;
    const withAccessor = {};
    Object.defineProperty(withAccessor, 'value', { enumerable: true, get() { return 1; } });
    const polluted = {};
    Object.defineProperty(polluted, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 'pollution',
    });

    const values = [
      nestedArray(13),
      undefined,
      1n,
      Symbol('value'),
      () => {},
      NaN,
      Infinity,
      new Date(),
      cycle,
      sparse,
      withSymbol,
      withAccessor,
      polluted,
    ];

    for (const parsed of values) {
      expectMalformed(() => parseChromeAIResult(resultMessage({
        text: 'ok', parsed, tokensUsed: 1,
      })));
    }
  });

  test('rejects repeated object or array identities even when they are acyclic', () => {
    const sharedObject = { leaf: true };
    const sharedArray = ['leaf'];

    for (const parsed of [
      { left: sharedObject, right: sharedObject },
      [sharedArray, sharedArray],
    ]) {
      expectMalformed(() => parseChromeAIResult(resultMessage({
        text: 'ok', parsed, tokensUsed: 1,
      })));
    }

    let sharedDag = { leaf: true };
    for (let depth = 0; depth < 12; depth += 1) {
      sharedDag = { left: sharedDag, right: sharedDag };
    }
    expectMalformed(() => parseChromeAIResult(resultMessage({
      text: 'ok', parsed: sharedDag, tokensUsed: 1,
    })));
  });

  test('accepts low-byte high-node results while their canonical JSON stays below 2 MiB', () => {
    const parsed = Array.from({ length: 70_000 }, () => null);
    expect(new TextEncoder().encode(JSON.stringify({
      text: 'ok', parsed, tokensUsed: 1,
    })).byteLength).toBeLessThan(MAX_CHROME_AI_RESULT_BYTES);

    const result = parseChromeAIResult(resultMessage({
      text: 'ok', parsed, tokensUsed: 1,
    }));
    expect(result.value.parsed).toHaveLength(parsed.length);
  });

  test('rejects a necessarily oversized shortest-node structure before copy allocation', () => {
    const parsed = Array.from({ length: 1_048_576 }, () => 0);
    expect(new TextEncoder().encode(JSON.stringify(parsed)).byteLength)
      .toBeGreaterThan(MAX_CHROME_AI_RESULT_BYTES);

    const originalPush = Array.prototype.push;
    let normalizedPushes = 0;
    let received;
    Array.prototype.push = function push(...values) {
      normalizedPushes += 1;
      return originalPush.apply(this, values);
    };
    try {
      parseChromeAIResult(resultMessage({ text: '', parsed, tokensUsed: 0 }));
    } catch (error) {
      received = error;
    } finally {
      Array.prototype.push = originalPush;
    }

    expect(received).toBeInstanceOf(AIMalformedResultError);
    expect(received.requestId).toBe(REQUEST_ID);
    expect(normalizedPushes).toBe(0);
  });

  test('rejects impossible oversized strings and keys before UTF-8 allocation', () => {
    const oversized = 'x'.repeat(MAX_CHROME_AI_RESULT_BYTES + 1);
    const parsedWithOversizedKey = {};
    Object.defineProperty(parsedWithOversizedKey, oversized, {
      configurable: true,
      enumerable: true,
      value: null,
    });
    const originalEncode = TextEncoder.prototype.encode;
    let oversizedEncodeCalls = 0;
    TextEncoder.prototype.encode = function encode(value) {
      if (value === oversized) oversizedEncodeCalls += 1;
      return originalEncode.call(this, value);
    };

    try {
      expectMalformed(() => parseChromeAIResult(resultMessage({
        text: oversized, parsed: null, tokensUsed: 1,
      })));
      expectMalformed(() => parseChromeAIResult(resultMessage({
        text: '', parsed: parsedWithOversizedKey, tokensUsed: 1,
      })));
    } finally {
      TextEncoder.prototype.encode = originalEncode;
    }
    expect(oversizedEncodeCalls).toBe(0);
  });

  test('enforces the 2 MiB UTF-8 serialized completion-result limit exactly', () => {
    const emptyValue = { text: '', parsed: null, tokensUsed: 0 };
    const overhead = new TextEncoder().encode(JSON.stringify(emptyValue)).byteLength;
    const exactValue = {
      ...emptyValue,
      text: 'x'.repeat(MAX_CHROME_AI_RESULT_BYTES - overhead),
    };
    const oversizedValue = { ...exactValue, text: `${exactValue.text}x` };

    expect(new TextEncoder().encode(JSON.stringify(exactValue)).byteLength)
      .toBe(MAX_CHROME_AI_RESULT_BYTES);
    expect(parseChromeAIResult(resultMessage(exactValue)).value.text.length)
      .toBe(exactValue.text.length);
    expectMalformed(() => parseChromeAIResult(resultMessage(oversizedValue)));

    expectMalformed(() => parseChromeAIResult(resultMessage({
      text: '€'.repeat(Math.ceil(MAX_CHROME_AI_RESULT_BYTES / 3)),
      parsed: null,
      tokensUsed: 0,
    })));
  });

  test('accepts only allowlisted structured error codes and bounded messages', () => {
    const codes = [
      'AI_ABORTED',
      'AI_TIMEOUT',
      'AI_UNAVAILABLE',
      'AI_FOREGROUND_REQUIRED',
      'AI_NETWORK',
      'AI_MALFORMED_RESULT',
    ];
    for (const code of codes) {
      const message = 'x'.repeat(1000);
      expect(parseChromeAIResult({
        type: 'chrome-ai/result',
        requestId: REQUEST_ID,
        ok: false,
        error: { code, message },
      })).toEqual({
        type: 'chrome-ai/result',
        requestId: REQUEST_ID,
        ok: false,
        error: { code, message },
      });
    }

    expect(parseChromeAIResult({
      type: 'chrome-ai/result',
      requestId: REQUEST_ID,
      ok: false,
      error: { code: 'AI_ABORTED', message: '' },
    })).toEqual({
      type: 'chrome-ai/result',
      requestId: REQUEST_ID,
      ok: false,
      error: { code: 'AI_ABORTED', message: '' },
    });

    const invalidErrors = [
      null,
      { code: 'AI_AUTH', message: 'no' },
      { code: 'AI_TIMEOUT', message: 42 },
      { code: 'AI_TIMEOUT', message: 'x'.repeat(1001) },
      { code: 'AI_TIMEOUT', message: 'no', stack: 'secret' },
    ];
    for (const error of invalidErrors) {
      expectMalformed(() => parseChromeAIResult({
        type: 'chrome-ai/result', requestId: REQUEST_ID, ok: false, error,
      }));
    }
  });
});

describe('serializeChromeAIError', () => {
  test('preserves each allowlisted typed code and safe message only', () => {
    const typedErrors = [
      new AIAbortError('cancelled safely'),
      new AITimeoutError('timed out safely'),
      new AIUnavailableError('unavailable safely'),
      new AIForegroundRequiredError('open the panel safely'),
      new AINetworkError('network failed safely'),
      new AIMalformedResultError('malformed safely'),
    ];

    for (const error of typedErrors) {
      error.stack = 'private stack';
      error.extra = 'private detail';
      expect(serializeChromeAIError(error)).toEqual({
        code: error.code,
        message: error.message,
      });
      expect(Object.keys(serializeChromeAIError(error))).toEqual(['code', 'message']);
    }

    expect(serializeChromeAIError(new AIAbortError(''))).toEqual({
      code: 'AI_ABORTED',
      message: '',
    });
  });

  test('falls back safely for unknown, spoofed, hostile, or oversized exceptions', () => {
    const hostile = new Proxy({}, { get() { throw new Error('private getter'); } });
    const expected = {
      code: 'AI_UNAVAILABLE',
      message: 'Chrome AI request failed.',
    };

    for (const error of [
      new Error('private details'),
      { code: 'AI_TIMEOUT', message: 'spoofed typed error' },
      new AITimeoutError('x'.repeat(1001)),
      hostile,
      null,
    ]) {
      expect(serializeChromeAIError(error)).toEqual(expected);
    }
  });
});
