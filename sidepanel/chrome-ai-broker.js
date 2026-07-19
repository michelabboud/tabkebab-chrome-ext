// sidepanel/chrome-ai-broker.js — foreground executor for Chrome's Prompt API

import {
  CHROME_AI_PORT_NAME,
  parseChromeAIRequest,
  parseChromeAIResult,
  serializeChromeAIError,
} from '../core/ai/chrome-ai-protocol.js';
import { ChromeAIProvider } from '../core/ai/provider-chrome.js';
import {
  AIAbortError,
  AIMalformedResultError,
  AIUnavailableError,
} from '../core/ai/provider.js';

const RECONNECT_DELAYS_MS = Object.freeze([100, 500, 1000]);
const CHROME_AI_PROVIDER_LOCK_NAME = 'tabkebab:chrome-ai-provider';
const MALFORMED_PROTOCOL_MESSAGE = 'Chrome AI protocol message is malformed.';

async function runWithProviderLock(signal, operation) {
  const lockManager = globalThis.navigator?.locks;
  if (!lockManager || typeof lockManager.request !== 'function') {
    throw new AIUnavailableError('Chrome AI coordination is unavailable.');
  }

  try {
    return await lockManager.request(
      CHROME_AI_PROVIDER_LOCK_NAME,
      { mode: 'exclusive', signal },
      async () => {
        if (signal.aborted) throw new AIAbortError();
        return operation();
      },
    );
  } catch (error) {
    if (signal.aborted) throw new AIAbortError();
    throw error;
  }
}

/**
 * Start the side-panel half of the Chrome AI request broker.
 *
 * A fresh provider owns each accepted request. Keeping that lifecycle inside
 * the request lets cancellation wait for the provider's `finally` cleanup
 * before acknowledging the worker, so a retry cannot overlap the old Prompt
 * API session.
 */
export function startChromeAIBroker({
  runtime = chrome.runtime,
  createProvider = () => new ChromeAIProvider(),
  scheduleReconnect = setTimeout,
} = {}) {
  const activeRequests = new Map();
  let activeAttachment = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let stopped = false;

  function isCurrentRequest(state) {
    return activeRequests.get(state.requestId) === state;
  }

  function safePost(port, message) {
    if (stopped || activeAttachment?.port !== port) return;
    try {
      port.postMessage(message);
    } catch {
      // Chrome dispatches onDisconnect for a dead port. The matching handler
      // owns request cleanup and reconnection; a transport exception must not
      // become an unhandled side-panel rejection.
    }
  }

  function errorResult(requestId, error) {
    return parseChromeAIResult({
      type: 'chrome-ai/result',
      requestId,
      ok: false,
      error: serializeChromeAIError(error),
    });
  }

  function abortRequestsForPort(port) {
    const settlements = [];
    for (const state of activeRequests.values()) {
      if (state.port !== port) continue;
      state.disconnected = true;
      state.terminalError ??= new AIAbortError();
      if (!state.controller.signal.aborted) state.controller.abort();
      settlements.push(state.settled);
    }
    return Promise.allSettled(settlements);
  }

  function terminateRequest(state, error) {
    if (state.terminalError) return false;
    state.terminalError = error;
    if (!state.controller.signal.aborted) state.controller.abort();
    return true;
  }

  async function executeRequest(message, port) {
    const { requestId } = message;
    const duplicate = activeRequests.get(requestId);
    if (duplicate) {
      // The request ID is the correlation boundary. Mark the original request
      // malformed, abort it once, and retain it until provider cleanup settles
      // before emitting the single terminal result for that ID.
      if (duplicate.port === port) {
        terminateRequest(
          duplicate,
          new AIMalformedResultError(MALFORMED_PROTOCOL_MESSAGE),
        );
      }
      return;
    }

    let resolveSettled;
    const state = {
      requestId,
      port,
      controller: new AbortController(),
      terminalError: null,
      disconnected: false,
      settled: new Promise((resolve) => { resolveSettled = resolve; }),
    };
    activeRequests.set(requestId, state);

    try {
      let outgoing;
      try {
        const providerValue = await runWithProviderLock(
          state.controller.signal,
          async () => {
            const provider = createProvider();
            return message.method === 'availability'
              ? provider.testConnection({}, state.controller.signal)
              : provider.complete(message.payload.request, {}, state.controller.signal);
          },
        );

        if (!isCurrentRequest(state)) return;
        const value = message.method === 'availability'
          ? (typeof providerValue === 'boolean' ? providerValue : undefined)
          : {
              text: providerValue?.text,
              parsed: providerValue?.parsed,
              tokensUsed: providerValue?.tokensUsed,
            };
        outgoing = state.terminalError
          ? errorResult(requestId, state.terminalError)
          : parseChromeAIResult({
              type: 'chrome-ai/result',
              requestId,
              ok: true,
              value,
            });
      } catch (error) {
        if (!isCurrentRequest(state)) return;
        outgoing = errorResult(
          requestId,
          state.terminalError ?? error,
        );
      }

      if (isCurrentRequest(state)) {
        activeRequests.delete(requestId);
        safePost(port, outgoing);
      }
    } finally {
      resolveSettled();
    }
  }

  function handleMessage(rawMessage, port) {
    if (stopped || activeAttachment?.port !== port) return;

    let message;
    try {
      message = parseChromeAIRequest(rawMessage);
    } catch (error) {
      const requestId = error?.requestId;
      if (requestId) {
        const active = activeRequests.get(requestId);
        if (active?.port === port) terminateRequest(active, error);
        else if (!active) safePost(port, errorResult(requestId, error));
      }
      return;
    }

    if (!message) return;
    if (message.type === 'chrome-ai/cancel') {
      const state = activeRequests.get(message.requestId);
      if (!state || state.port !== port) return;
      terminateRequest(state, new AIAbortError());
      return;
    }

    void executeRequest(message, port);
  }

  function detach(attachment) {
    attachment.port.onMessage.removeListener(attachment.onMessage);
    attachment.port.onDisconnect.removeListener(attachment.onDisconnect);
  }

  function scheduleNextReconnect(cleanup = Promise.resolve()) {
    if (stopped || activeAttachment || reconnectTimer !== null) return;

    const delay = RECONNECT_DELAYS_MS[
      Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    reconnectAttempt += 1;
    reconnectTimer = scheduleReconnect(async () => {
      reconnectTimer = null;
      await cleanup;
      if (stopped || activeAttachment) return;
      connect();
    }, delay);
  }

  function attach(port) {
    const attachment = {
      port,
      onMessage: (message) => handleMessage(message, port),
      onDisconnect: null,
    };
    attachment.onDisconnect = () => {
      if (stopped || activeAttachment !== attachment) return;
      detach(attachment);
      activeAttachment = null;
      const cleanup = abortRequestsForPort(port);
      scheduleNextReconnect(cleanup);
    };

    activeAttachment = attachment;
    reconnectAttempt = 0;
    port.onMessage.addListener(attachment.onMessage);
    port.onDisconnect.addListener(attachment.onDisconnect);
  }

  function connect() {
    if (stopped || activeAttachment) return;
    try {
      attach(runtime.connect({ name: CHROME_AI_PORT_NAME }));
    } catch {
      scheduleNextReconnect();
    }
  }

  function disconnect() {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const attachment = activeAttachment;
    activeAttachment = null;
    if (!attachment) return;

    detach(attachment);
    void abortRequestsForPort(attachment.port);
    try {
      attachment.port.disconnect();
    } catch {
      // The port may already have been invalidated by a worker restart.
    }
  }

  connect();

  return {
    get port() {
      return activeAttachment?.port ?? null;
    },
    disconnect,
  };
}
