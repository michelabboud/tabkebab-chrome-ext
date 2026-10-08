// core/background/router.js — Runtime message routing for the service worker.
//
// Each feature module exports a plain `{ action: async (msg, ctx) => … }`
// handler map. The worker entry point creates one router, registers every
// map, and dispatches `chrome.runtime.onMessage` traffic through it. A router
// refuses to register the same action twice, so one feature cannot silently
// shadow another feature's handler.

import { createLogger } from '../log.js';
const log = createLogger('router');

const UNKNOWN_ACTION_RESPONSE = Object.freeze({ error: 'Unknown action' });

// ── Feature gating ──
//
// Settings → Features can switch a feature off. Every runtime action that
// *uses* a feature is listed here with the feature(s) it needs; the router
// refuses it while any of them is off. Gating lives only here: handlers stay
// feature-agnostic.
//
// Deliberately NOT gated (always allowed, so data stays recoverable and the
// panel can still read state while a feature is hidden):
//   - listing/reading: listSessions, listStashes, getFocusState,
//     getFocusHistory, getFocusProfiles, getAISettings, needsAIPassphrase,
//     listLocalBookmarks, getWindowStats, getTabs, getGroupedTabs
//   - recovery: restoreSession, restoreStash, undoDeleteSession,
//     undoDeleteStash, undoDriveSettings
//   - exports / backup: buildPortableExport, buildPortableSessionExport,
//     buildPortableStashExport, importPortableData
//   - a running Focus session: endFocus, pauseFocus, resumeFocus,
//     extendFocus (switching Focus off never strands a live session)
//   - housekeeping: clearAICache, getSettings, saveSettings
export const ACTION_FEATURES = Object.freeze({
  // Focus: block starting new sessions.
  startFocus: Object.freeze(['focus']),
  saveFocusProfilePrefs: Object.freeze(['focus']),
  // AI
  unlockAIApiKey: Object.freeze(['ai']),
  saveAISettings: Object.freeze(['ai']),
  isAIAvailable: Object.freeze(['ai']),
  testAIConnection: Object.freeze(['ai']),
  listModels: Object.freeze(['ai']),
  summarizeTabs: Object.freeze(['ai']),
  classifyKeepAwake: Object.freeze(['ai']),
  applySmartGroups: Object.freeze(['ai']),
  // AI command bar (natural-language commands need both switches)
  executeNLCommand: Object.freeze(['ai', 'commandBar']),
  confirmNLCommand: Object.freeze(['ai', 'commandBar']),
  // Google Drive
  exportStashToDrive: Object.freeze(['drive']),
  syncStashesToDrive: Object.freeze(['drive']),
  syncDriveState: Object.freeze(['drive']),
  syncAllToDrive: Object.freeze(['drive']),
  cleanDriveFiles: Object.freeze(['drive']),
  importDriveSettings: Object.freeze(['drive']),
  // Bookmarks
  createBookmarks: Object.freeze(['bookmarks']),
  // Duplicates
  findDuplicates: Object.freeze(['duplicates']),
  findEmptyPages: Object.freeze(['duplicates']),
  // Sessions (create/delete only)
  saveSession: Object.freeze(['sessions']),
  deleteSession: Object.freeze(['sessions']),
  // Stash (create/delete/import only)
  stashWindow: Object.freeze(['stash']),
  stashGroup: Object.freeze(['stash']),
  stashDomain: Object.freeze(['stash']),
  deleteStash: Object.freeze(['stash']),
  importStashes: Object.freeze(['stash']),
  // Windows
  consolidateWindows: Object.freeze(['windows']),
});

export function featureOffResponse(feature) {
  return { error: `Feature "${feature}" is turned off in Settings` };
}

/** First feature `action` needs that is off in `features`, or null. */
export function disabledFeatureForAction(action, features) {
  const needed = Object.hasOwn(ACTION_FEATURES, action) ? ACTION_FEATURES[action] : null;
  if (!needed) return null;
  for (const feature of needed) {
    if (features?.[feature] === false) return feature;
  }
  return null;
}

/**
 * Cached view of `settings.features` for synchronous gating. Gating from a
 * cache keeps the router's dispatch synchronous for every message once the
 * switches are known, so messages enter their handlers (and the shared state
 * lock) in arrival order. `get()` returns the features object, or a promise
 * while the first load (or an explicit refresh) is in flight.
 *
 * @param {() => Promise<object|null>} load resolves the current features
 */
export function createFeatureCache(load) {
  let value = null;
  let loaded = false;
  let pending = null;

  function refresh() {
    const attempt = Promise.resolve()
      .then(load)
      .then((features) => features ?? null, () => null) // unreadable: never gate
      .then((features) => {
        if (pending === attempt) {
          value = features;
          loaded = true;
          pending = null;
        }
        return features;
      });
    pending = attempt;
    return attempt;
  }

  return {
    refresh,
    set(features) {
      value = features ?? null;
      loaded = true;
      pending = null;
    },
    get() {
      if (pending) return pending;
      if (!loaded) return refresh();
      return value;
    },
  };
}

/**
 * @param {object} [options]
 * @param {() => (object|null|Promise<object|null>)} [options.getFeatures]
 *   returns the current `settings.features` (or a promise of it). Only called
 *   for gated actions. Without it the router never gates.
 */
export function createRouter({ getFeatures = null } = {}) {
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
      const ctx = { ...overrides, ...runtime };
      if (!getFeatures || !Object.hasOwn(ACTION_FEATURES, msg.action)) {
        return handler(msg, ctx);
      }
      const gate = (features) => {
        const off = disabledFeatureForAction(msg.action, features);
        if (off) return Promise.resolve(featureOffResponse(off));
        return handler(msg, ctx);
      };
      const features = getFeatures();
      if (features && typeof features.then === 'function') return features.then(gate);
      return gate(features);
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
        log.warn('Drive cleanup handler failed');
        sendResponse({ error: 'Drive cleanup failed' });
        return;
      }
      log.warn(`handler error (${message?.action}):`, err);
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
