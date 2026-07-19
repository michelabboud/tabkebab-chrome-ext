// core/ai/chrome-ai-broker-client.js — Worker-side Chrome AI port broker client

import {
  AIAbortError,
  AIForegroundRequiredError,
  AIMalformedResultError,
  AINetworkError,
  AITimeoutError,
  AIUnavailableError,
} from './provider.js';
import {
  CHROME_AI_PORT_NAME,
  parseChromeAIRequest,
  parseChromeAIResult,
} from './chrome-ai-protocol.js';

const ERROR_TYPES = Object.freeze({
  AI_ABORTED: AIAbortError,
  AI_TIMEOUT: AITimeoutError,
  AI_UNAVAILABLE: AIUnavailableError,
  AI_FOREGROUND_REQUIRED: AIForegroundRequiredError,
  AI_NETWORK: AINetworkError,
  AI_MALFORMED_RESULT: AIMalformedResultError,
});
// A conforming randomUUID() collision is vanishingly unlikely; bounding retries
// prevents a broken runtime or test double from hanging the service worker.
const MAX_REQUEST_ID_ATTEMPTS = 8;

function rehydrateError(serialized) {
  const ErrorType = ERROR_TYPES[serialized.code];
  return new ErrorType(serialized.message);
}

function removeAbortListener(request) {
  if (!request.signal || !request.abortListener) return;
  const listener = request.abortListener;
  request.abortListener = null;
  request.signal.removeEventListener('abort', listener);
}

function isPortEvent(event) {
  return event &&
    typeof event.addListener === 'function' &&
    typeof event.removeListener === 'function';
}

function isBrokerPort(port) {
  return port?.name === CHROME_AI_PORT_NAME &&
    typeof port.postMessage === 'function' &&
    typeof port.disconnect === 'function' &&
    isPortEvent(port.onMessage) &&
    isPortEvent(port.onDisconnect);
}

function validateSignal(signal) {
  if (signal == null) return;
  if (
    typeof signal !== 'object' ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw new TypeError('signal must be an AbortSignal');
  }
}

export class ChromeAIBrokerClient {
  constructor() {
    this.port = null;
    this.pending = new Map();
    this.onMessage = null;
    this.onDisconnect = null;
    this.generation = 0;
    this.connections = [];
    this.activeConnection = null;
    this.replacementConnection = null;
    this.switching = false;
    this.nextConnectionSequence = 0;
  }

  attachPort(port) {
    if (!isBrokerPort(port)) return;
    if (this.connections.some((connection) => connection.port === port)) return;

    const connection = {
      port,
      sequence: ++this.nextConnectionSequence,
      onMessage: null,
      onDisconnect: null,
    };
    connection.onDisconnect = () => this.handlePortDisconnect(connection);
    this.connections.push(connection);
    port.onDisconnect.addListener(connection.onDisconnect);

    if (!this.activeConnection) {
      this.promoteConnection(connection);
      return;
    }

    if (this.hasPendingForGeneration(this.generation)) {
      this.stageReplacement(connection);
      return;
    }

    this.promoteConnection(connection);
  }

  promoteConnection(connection) {
    if (!connection || !this.connections.includes(connection)) return;
    if (this.activeConnection === connection) return;

    if (this.activeConnection?.onMessage) {
      this.activeConnection.port.onMessage.removeListener(this.activeConnection.onMessage);
      this.activeConnection.onMessage = null;
    }
    const generation = ++this.generation;
    connection.onMessage = (message) => this.handleMessage(message, connection, generation);
    connection.port.onMessage.addListener(connection.onMessage);
    this.activeConnection = connection;
    this.port = connection.port;
    this.onMessage = connection.onMessage;
    this.onDisconnect = connection.onDisconnect;
  }

  handleMessage(message, connection, generation) {
    if (this.activeConnection !== connection || this.generation !== generation) return;
    let result;
    try {
      result = parseChromeAIResult(message);
    } catch (error) {
      const request = error instanceof AIMalformedResultError
        ? this.pending.get(error.requestId)
        : null;
      if (
        !request ||
        request.connection !== connection ||
        request.generation !== generation
      ) return;
      this.pending.delete(error.requestId);
      removeAbortListener(request);
      // A matching terminal result is posted only after panel cleanup. If a
      // cancellation already owns the outcome, preserve that first cause.
      request.reject(request.cancelling
        ? (request.cancelError ?? new AIAbortError())
        : error);
      this.finishSwitchIfReady(generation);
      return;
    }
    if (!result) return;

    const request = this.pending.get(result.requestId);
    if (
      !request ||
      request.connection !== connection ||
      request.generation !== generation
    ) return;
    this.pending.delete(result.requestId);
    removeAbortListener(request);
    if (request.cancelling) {
      request.reject(request.cancelError ?? new AIAbortError());
    } else if (result.ok === false) {
      request.reject(rehydrateError(result.error));
    } else if (
      (request.method === 'availability' && typeof result.value !== 'boolean') ||
      (request.method === 'complete' && typeof result.value === 'boolean')
    ) {
      request.reject(new AIMalformedResultError());
    } else {
      request.resolve(result.value);
    }
    this.finishSwitchIfReady(generation);
  }

  stageReplacement(connection) {
    this.replacementConnection = connection;
    this.switching = true;
    const generation = this.generation;
    for (const [requestId, request] of this.pending) {
      if (request.generation !== generation || request.cancelling) continue;
      request.cancelling = true;
      request.cancelError = new AIForegroundRequiredError();
      removeAbortListener(request);
      try {
        request.port.postMessage(parseChromeAIRequest({
          type: 'chrome-ai/cancel',
          requestId,
        }));
      } catch {
        this.dropConnection(request.connection, true);
        return;
      }
    }
    this.finishSwitchIfReady(generation);
  }

  finishSwitchIfReady(generation) {
    if (!this.switching || this.generation !== generation) return;
    for (const request of this.pending.values()) {
      if (request.generation === generation) return;
    }

    this.switching = false;
    const target = this.connections.includes(this.replacementConnection)
      ? this.replacementConnection
      : this.newestConnection(this.activeConnection);
    this.replacementConnection = null;
    if (target && target !== this.activeConnection) this.promoteConnection(target);
  }

  hasPendingForGeneration(generation) {
    for (const request of this.pending.values()) {
      if (request.generation === generation) return true;
    }
    return false;
  }

  newestConnection(exclude = null) {
    let newest = null;
    for (const connection of this.connections) {
      if (connection === exclude) continue;
      if (!newest || connection.sequence > newest.sequence) newest = connection;
    }
    return newest;
  }

  handlePortDisconnect(connection) {
    this.dropConnection(connection, false);
  }

  dropConnection(connection, disconnect) {
    const index = this.connections.indexOf(connection);
    if (index < 0) return;

    this.connections.splice(index, 1);
    if (connection.onMessage) {
      connection.port.onMessage.removeListener(connection.onMessage);
      connection.onMessage = null;
    }
    connection.port.onDisconnect.removeListener(connection.onDisconnect);
    if (this.replacementConnection === connection) this.replacementConnection = null;

    if (this.activeConnection === connection) {
      this.activeConnection = null;
      this.port = null;
      this.onMessage = null;
      this.onDisconnect = null;
      this.generation += 1;
      this.switching = false;
      this.rejectPending(new AIForegroundRequiredError());
      this.replacementConnection = null;
      const standby = this.newestConnection();
      if (standby) this.promoteConnection(standby);
    }

    if (disconnect) {
      try { connection.port.disconnect(); } catch { /* local ownership is already removed */ }
    }
  }

  testConnection(_config, signal) {
    return this.sendRequest('availability', {}, signal);
  }

  complete(request, _config, signal) {
    return this.sendRequest('complete', { request }, signal);
  }

  disconnect() {
    const connections = [...this.connections];
    for (const connection of connections) {
      if (connection.onMessage) {
        connection.port.onMessage.removeListener(connection.onMessage);
        connection.onMessage = null;
      }
      connection.port.onDisconnect.removeListener(connection.onDisconnect);
    }
    this.connections = [];
    this.activeConnection = null;
    this.replacementConnection = null;
    this.switching = false;
    this.port = null;
    this.onMessage = null;
    this.onDisconnect = null;
    this.generation += 1;
    this.rejectPending(new AIForegroundRequiredError());
    for (const connection of connections) {
      try {
        connection.port.disconnect();
      } catch {
        // The local state and pending promises are already cleaned up.
      }
    }
  }

  rejectPending(error) {
    for (const [requestId, request] of this.pending) {
      this.pending.delete(requestId);
      removeAbortListener(request);
      request.reject(new AIForegroundRequiredError(error.message));
    }
  }

  sendRequest(method, payload, signal) {
    try {
      validateSignal(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal?.aborted) return Promise.reject(new AIAbortError());
    if (!this.activeConnection || this.switching) {
      return Promise.reject(new AIForegroundRequiredError());
    }

    let requestId = null;
    for (let attempt = 0; attempt < MAX_REQUEST_ID_ATTEMPTS; attempt += 1) {
      const candidate = crypto.randomUUID();
      if (!this.pending.has(candidate)) {
        requestId = candidate;
        break;
      }
    }
    if (requestId === null) {
      return Promise.reject(new AIMalformedResultError('Could not allocate an AI request ID'));
    }
    let message;
    try {
      message = parseChromeAIRequest({
        type: 'chrome-ai/request',
        requestId,
        method,
        payload,
      });
      if (!message) throw new AIMalformedResultError();
    } catch (error) {
      return Promise.reject(
        error instanceof AIMalformedResultError
          ? error
          : new AIMalformedResultError(),
      );
    }

    return new Promise((resolve, reject) => {
      const request = {
        resolve,
        reject,
        signal,
        abortListener: null,
        cancelling: false,
        cancelError: null,
        port: this.port,
        connection: this.activeConnection,
        generation: this.generation,
        method,
      };
      request.abortListener = () => {
        if (this.pending.get(requestId) !== request) return;
        if (request.cancelling) return;
        request.cancelling = true;
        request.cancelError = new AIAbortError();
        removeAbortListener(request);
        try {
          request.port.postMessage(parseChromeAIRequest({
            type: 'chrome-ai/cancel',
            requestId,
          }));
        } catch {
          if (this.pending.get(requestId) === request) {
            this.pending.delete(requestId);
            removeAbortListener(request);
            reject(new AIForegroundRequiredError());
            this.dropConnection(request.connection, true);
          }
        }
      };

      this.pending.set(requestId, request);
      if (signal) signal.addEventListener('abort', request.abortListener, { once: true });

      try {
        this.port.postMessage(message);
      } catch {
        this.pending.delete(requestId);
        removeAbortListener(request);
        reject(new AIForegroundRequiredError());
        this.dropConnection(request.connection, true);
      }
    });
  }
}

export const chromeAIBrokerClient = new ChromeAIBrokerClient();
