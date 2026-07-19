// chrome-ai-protocol.js — bounded JSON-only messages for the Chrome AI broker

import {
  AIAbortError,
  AIForegroundRequiredError,
  AIMalformedResultError,
  AINetworkError,
  AITimeoutError,
  AIUnavailableError,
} from './provider.js';

export const CHROME_AI_PORT_NAME = 'tabkebab:chrome-ai';
export const MAX_CHROME_AI_USER_PROMPT_CHARS = 200_000;
export const MAX_CHROME_AI_SYSTEM_PROMPT_CHARS = 50_000;
export const MAX_CHROME_AI_RESULT_BYTES = 2 * 1024 * 1024;

const MAX_CHROME_AI_ERROR_MESSAGE_CHARS = 1_000;
const MAX_JSON_CONTAINER_ENTRIES = Math.floor((MAX_CHROME_AI_RESULT_BYTES + 1) / 2);
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ALLOWED_ERROR_CODES = new Set([
  'AI_ABORTED',
  'AI_TIMEOUT',
  'AI_UNAVAILABLE',
  'AI_FOREGROUND_REQUIRED',
  'AI_NETWORK',
  'AI_MALFORMED_RESULT',
]);
const TYPED_ERROR_CODES = Object.freeze([
  [AIAbortError, 'AI_ABORTED'],
  [AITimeoutError, 'AI_TIMEOUT'],
  [AIUnavailableError, 'AI_UNAVAILABLE'],
  [AIForegroundRequiredError, 'AI_FOREGROUND_REQUIRED'],
  [AINetworkError, 'AI_NETWORK'],
  [AIMalformedResultError, 'AI_MALFORMED_RESULT'],
]);
const FALLBACK_ERROR = Object.freeze({
  code: 'AI_UNAVAILABLE',
  message: 'Chrome AI request failed.',
});
const textEncoder = new TextEncoder();

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataValue(value, key, { required = true, enumerable = true } = {}) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new TypeError('Chrome AI protocol value cannot be inspected safely');
  }
  if (!descriptor) {
    if (required) throw new TypeError(`Chrome AI protocol message is missing ${key}`);
    return undefined;
  }
  if (!Object.hasOwn(descriptor, 'value') || (enumerable && !descriptor.enumerable)) {
    throw new TypeError(`Chrome AI protocol field ${key} must be an own data property`);
  }
  return descriptor.value;
}

function ownStringKeys(value) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError('Chrome AI protocol value cannot be inspected safely');
  }
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Chrome AI protocol objects cannot contain symbol fields');
  }
  return keys;
}

function requireExactRecord(value, expectedKeys) {
  if (!isPlainRecord(value)) throw new TypeError('Chrome AI protocol value must be a plain object');
  const keys = ownStringKeys(value);
  const expected = new Set(expectedKeys);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new TypeError('Chrome AI protocol object contains unexpected or missing fields');
  }
  for (const key of expectedKeys) ownDataValue(value, key);
  return value;
}

function requireAllowedRecord(value, requiredKeys, optionalKeys) {
  if (!isPlainRecord(value)) throw new TypeError('Chrome AI protocol value must be a plain object');
  const keys = ownStringKeys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (keys.some((key) => !allowed.has(key))) {
    throw new TypeError('Chrome AI protocol object contains an unexpected field');
  }
  for (const key of requiredKeys) ownDataValue(value, key);
  for (const key of keys) ownDataValue(value, key);
  return value;
}

function isValidRequestId(value) {
  return typeof value === 'string' &&
    value.length <= 64 &&
    REQUEST_ID_PATTERN.test(value);
}

function safeRequestId(message) {
  if (!message || typeof message !== 'object') return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(message, 'requestId');
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    return isValidRequestId(descriptor.value) ? descriptor.value : null;
  } catch {
    return null;
  }
}

function malformed(requestId) {
  const error = new AIMalformedResultError('Chrome AI protocol message is malformed.');
  Object.defineProperty(error, 'requestId', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: requestId,
  });
  throw error;
}

function normalizeCompleteRequest(value) {
  requireAllowedRecord(
    value,
    ['userPrompt', 'maxTokens', 'temperature'],
    ['systemPrompt', 'responseFormat'],
  );

  const userPrompt = ownDataValue(value, 'userPrompt');
  if (
    typeof userPrompt !== 'string' ||
    userPrompt.length === 0 ||
    userPrompt.length > MAX_CHROME_AI_USER_PROMPT_CHARS
  ) {
    throw new TypeError('Chrome AI user prompt is invalid');
  }

  const maxTokens = ownDataValue(value, 'maxTokens');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
    throw new TypeError('Chrome AI maxTokens is invalid');
  }

  const temperature = ownDataValue(value, 'temperature');
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new TypeError('Chrome AI temperature is invalid');
  }

  const output = { userPrompt };
  if (Object.hasOwn(value, 'systemPrompt')) {
    const systemPrompt = ownDataValue(value, 'systemPrompt');
    if (
      typeof systemPrompt !== 'string' ||
      systemPrompt.length > MAX_CHROME_AI_SYSTEM_PROMPT_CHARS
    ) {
      throw new TypeError('Chrome AI system prompt is invalid');
    }
    output.systemPrompt = systemPrompt;
  }
  output.maxTokens = maxTokens;
  output.temperature = temperature;

  if (Object.hasOwn(value, 'responseFormat')) {
    const responseFormat = ownDataValue(value, 'responseFormat');
    if (responseFormat !== 'json') {
      throw new TypeError('Chrome AI responseFormat is invalid');
    }
    output.responseFormat = responseFormat;
  }
  return output;
}

function normalizeRequestMessage(message, requestId) {
  const type = ownDataValue(message, 'type');
  if (type === 'chrome-ai/cancel') {
    requireExactRecord(message, ['type', 'requestId']);
    return { type, requestId };
  }
  if (type !== 'chrome-ai/request') throw new TypeError('Unknown Chrome AI message type');

  requireExactRecord(message, ['type', 'requestId', 'method', 'payload']);
  const method = ownDataValue(message, 'method');
  const payload = ownDataValue(message, 'payload');

  if (method === 'availability') {
    requireExactRecord(payload, []);
    return { type, requestId, method, payload: {} };
  }
  if (method !== 'complete') throw new TypeError('Unknown Chrome AI request method');

  requireExactRecord(payload, ['request']);
  return {
    type,
    requestId,
    method,
    payload: { request: normalizeCompleteRequest(ownDataValue(payload, 'request')) },
  };
}

/**
 * Parse one worker-to-panel message. Messages without a safely readable UUID
 * cannot be correlated and are ignored. A valid ID makes malformed input an
 * actionable protocol error, exposed on the thrown error as `requestId`.
 */
export function parseChromeAIRequest(message) {
  const requestId = safeRequestId(message);
  if (!requestId) return null;
  try {
    return normalizeRequestMessage(message, requestId);
  } catch {
    return malformed(requestId);
  }
}

function addStructureBudget(budget, units = 1) {
  const remainingUnits = MAX_CHROME_AI_RESULT_BYTES - budget.used;
  if (!Number.isSafeInteger(units) || units < 0 || units > remainingUnits) {
    throw new TypeError('Chrome AI result exceeds its structural traversal budget');
  }
  budget.used += units;
}

function ensureStructureCapacity(budget, units) {
  const remainingUnits = MAX_CHROME_AI_RESULT_BYTES - budget.used;
  if (!Number.isSafeInteger(units) || units < 0 || units > remainingUnits) {
    throw new TypeError('Chrome AI result exceeds its structural traversal budget');
  }
}

function addStringBytes(value, budget) {
  const remainingBytes = MAX_CHROME_AI_RESULT_BYTES - budget.used;
  // UTF-8 never uses fewer bytes than a JavaScript string has UTF-16 code
  // units. Reject impossible candidates before TextEncoder allocates output.
  if (value.length > remainingBytes) {
    throw new TypeError('Chrome AI result exceeds its byte limit');
  }
  let bytes;
  try {
    bytes = textEncoder.encode(value).byteLength;
  } catch {
    throw new TypeError('Chrome AI result string cannot be encoded');
  }
  if (bytes > remainingBytes) {
    throw new TypeError('Chrome AI result exceeds its byte limit');
  }
  budget.used += bytes;
}

function normalizeJsonValue(value, depth, seen, budget) {
  if (depth > 12) throw new TypeError('Chrome AI parsed result exceeds its depth limit');
  addStructureBudget(budget);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    addStringBytes(value, budget);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Chrome AI parsed result has a non-finite number');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Chrome AI parsed result is not JSON-only');
  if (seen.has(value)) {
    throw new TypeError('Chrome AI parsed result contains a repeated object reference');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError('Chrome AI parsed result has a non-standard array');
    }
    if (value.length > MAX_JSON_CONTAINER_ENTRIES) {
      throw new TypeError('Chrome AI parsed result has too many array entries');
    }
    // Charge slots and prove room for at least one child node per slot before
    // allocating the normalized array. Recursive children may charge more.
    addStructureBudget(budget, value.length);
    ensureStructureCapacity(budget, value.length);
    const keys = ownStringKeys(value);
    const expected = new Set(['length']);
    for (let index = 0; index < value.length; index += 1) expected.add(String(index));
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
      throw new TypeError('Chrome AI parsed result has a sparse or extended array');
    }
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const child = ownDataValue(value, String(index));
      output.push(normalizeJsonValue(child, depth + 1, seen, budget));
    }
    return output;
  }

  if (!isPlainRecord(value)) throw new TypeError('Chrome AI parsed result is not a plain object');
  const keys = ownStringKeys(value);
  if (keys.length > MAX_JSON_CONTAINER_ENTRIES) {
    throw new TypeError('Chrome AI parsed result has too many object fields');
  }
  addStructureBudget(budget, keys.length);
  ensureStructureCapacity(budget, keys.length);
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new TypeError('Chrome AI parsed result contains a prototype-pollution key');
    }
    addStringBytes(key, budget);
  }
  const output = Object.create(null);
  for (const key of keys) {
    const child = ownDataValue(value, key);
    output[key] = normalizeJsonValue(child, depth + 1, seen, budget);
  }
  return output;
}

function normalizeCompletionResult(value) {
  requireExactRecord(value, ['text', 'parsed', 'tokensUsed']);
  const text = ownDataValue(value, 'text');
  if (typeof text !== 'string') throw new TypeError('Chrome AI result text must be a string');

  const tokensUsed = ownDataValue(value, 'tokensUsed');
  if (!Number.isSafeInteger(tokensUsed) || tokensUsed < 0) {
    throw new TypeError('Chrome AI tokensUsed must be a non-negative safe integer');
  }

  // One unit for each container, field/slot, and scalar plus exact UTF-8
  // key/string bytes is a lower bound on canonical JSON size. Capping this
  // single traversal budget cannot reject a value whose serialization fits,
  // while it rejects necessarily oversized high-node trees before cloning.
  const budget = { used: 0 };
  addStructureBudget(budget); // completion result container
  addStructureBudget(budget, 3); // text, parsed, and tokensUsed fields
  for (const key of ['text', 'parsed', 'tokensUsed']) addStringBytes(key, budget);
  addStructureBudget(budget); // text scalar
  addStringBytes(text, budget);
  const parsed = normalizeJsonValue(ownDataValue(value, 'parsed'), 0, new Set(), budget);
  addStructureBudget(budget); // tokensUsed scalar
  const output = { text, parsed, tokensUsed };

  let serialized;
  try {
    serialized = JSON.stringify(output);
  } catch {
    throw new TypeError('Chrome AI result cannot be serialized safely');
  }
  if (textEncoder.encode(serialized).byteLength > MAX_CHROME_AI_RESULT_BYTES) {
    throw new TypeError('Chrome AI result exceeds its byte limit');
  }
  return output;
}

function normalizeSerializedError(value) {
  requireExactRecord(value, ['code', 'message']);
  const code = ownDataValue(value, 'code');
  const message = ownDataValue(value, 'message');
  if (!ALLOWED_ERROR_CODES.has(code)) throw new TypeError('Chrome AI error code is not allowed');
  if (
    typeof message !== 'string' ||
    message.length > MAX_CHROME_AI_ERROR_MESSAGE_CHARS
  ) {
    throw new TypeError('Chrome AI error message is invalid');
  }
  return { code, message };
}

function normalizeResultMessage(message, requestId) {
  requireExactRecord(
    message,
    ownDataValue(message, 'ok') === true
      ? ['type', 'requestId', 'ok', 'value']
      : ['type', 'requestId', 'ok', 'error'],
  );
  if (ownDataValue(message, 'type') !== 'chrome-ai/result') {
    throw new TypeError('Unknown Chrome AI result type');
  }

  const ok = ownDataValue(message, 'ok');
  if (ok === true) {
    const value = ownDataValue(message, 'value');
    return {
      type: 'chrome-ai/result',
      requestId,
      ok: true,
      value: typeof value === 'boolean' ? value : normalizeCompletionResult(value),
    };
  }
  if (ok !== false) throw new TypeError('Chrome AI result ok flag must be boolean');
  return {
    type: 'chrome-ai/result',
    requestId,
    ok: false,
    error: normalizeSerializedError(ownDataValue(message, 'error')),
  };
}

/** Parse and normalize one panel-to-worker result message. */
export function parseChromeAIResult(message) {
  const requestId = safeRequestId(message);
  if (!requestId) return null;
  try {
    return normalizeResultMessage(message, requestId);
  } catch {
    return malformed(requestId);
  }
}

/**
 * Reduce a local typed provider error to the exact, user-safe wire shape.
 * Unknown and structurally hostile values never cross the port boundary.
 */
export function serializeChromeAIError(error) {
  try {
    for (const [ErrorType, code] of TYPED_ERROR_CODES) {
      if (!(error instanceof ErrorType)) continue;
      const message = ownDataValue(error, 'message', { enumerable: false });
      if (
        typeof message !== 'string' ||
        message.length > MAX_CHROME_AI_ERROR_MESSAGE_CHARS
      ) {
        return { ...FALLBACK_ERROR };
      }
      return { code, message };
    }
  } catch {
    // Fall through to the fixed safe error. Never inspect an unknown value again.
  }
  return { ...FALLBACK_ERROR };
}
