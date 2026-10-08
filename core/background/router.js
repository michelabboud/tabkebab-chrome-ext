// core/background/router.js — Runtime message routing for the service worker.
//
// Each feature module exports a plain `{ action: async (msg, ctx) => … }`
// handler map. The worker entry point creates one router, registers every
// map, and dispatches `chrome.runtime.onMessage` traffic through it. A router
// refuses to register the same action twice, so one feature cannot silently
// shadow another feature's handler.

const UNKNOWN_ACTION_RESPONSE = Object.freeze({ error: 'Unknown action' });

export function createRouter() {
  const handlers = new Map();

  function registerHandlers(map) {
    for (const [action, handler] of Object.entries(map)) {
      if (typeof handler !== 'function') {
        throw new TypeError(`Handler for ${action} must be a function`);
      }
      if (handlers.has(action)) {
        throw new Error(`Duplicate message handler: ${action}`);
      }
      handlers.set(action, handler);
    }
  }

  /**
   * Run the handler for `msg.action`. Always returns a promise: synchronous
   * failures (a non-object message, malformed options) become rejections,
   * matching the former single async switch.
   */
  function dispatch(msg, options = {}, runtime = {}) {
    try {
      const { ...overrides } = options;
      const handler = handlers.get(msg.action);
      if (!handler) return Promise.resolve({ ...UNKNOWN_ACTION_RESPONSE });
      return handler(msg, { ...overrides, ...runtime });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return {
    registerHandlers,
    dispatch,
    has: (action) => handlers.has(action),
    actions: () => [...handlers.keys()],
  };
}

/**
 * The `chrome.runtime.onMessage` listener body: resolve `handle(message)` and
 * send it back, or send a `{ error }` envelope. Returns true to keep the
 * channel open for the async response.
 */
export function createRuntimeMessageListener(handle) {
  return (message, _sender, sendResponse) => {
    handle(message).then(sendResponse).catch(err => {
      if (message?.action === 'cleanDriveFiles') {
        console.warn('[TabKebab] Drive cleanup handler failed');
        sendResponse({ error: 'Drive cleanup failed' });
        return;
      }
      console.warn(`[TabKebab] handler error (${message?.action}):`, err);
      sendResponse({ error: err?.message || String(err) });
    });
    return true; // keep channel open for async response
  };
}

// ── Shared runtime-message validation ──

export const MAX_RUNTIME_PORTABLE_STRING = 16_384;

export function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function requireRuntimeString(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RUNTIME_PORTABLE_STRING ||
    value !== value.trim()
  ) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  if (value === '__proto__' || value === 'constructor' || value === 'prototype') {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function requirePortableRecordId(value, label) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.length > MAX_RUNTIME_PORTABLE_STRING) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  if (value === '__proto__' || value === 'constructor' || value === 'prototype') {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function requireRuntimeUrl(value, label) {
  const url = requireRuntimeString(value, label);
  try {
    new URL(url);
  } catch {
    throw new TypeError(`${label} must be a valid URL`);
  }
  return url;
}

export function requireExactRuntimeFields(message, expectedFields, label) {
  if (!isPlainRecord(message)) throw new TypeError(`${label} must be an object`);
  const expected = new Set(expectedFields);
  const keys = Object.keys(message);
  const unexpected = keys.filter((key) => !expected.has(key));
  if (unexpected.length > 0) {
    // Field names are untrusted too. Do not reflect them into runtime errors or
    // service-worker logs because a caller could place credential material in a key.
    throw new TypeError(`${label} has unexpected fields`);
  }
  const missing = expectedFields.filter((key) => !Object.hasOwn(message, key));
  if (missing.length > 0) {
    throw new TypeError(`${label} is missing required fields`);
  }
}
