// core/ai/request-lifecycle.js — One-controller lifecycle for provider attempts

import { AIAbortError, AITimeoutError } from './provider.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function validateTimeout(timeoutMs) {
  if (typeof timeoutMs !== 'number') {
    throw new TypeError('timeoutMs must be a number');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`timeoutMs must be an integer from 1 through ${MAX_TIMER_DELAY_MS}`);
  }
}

function validateExternalSignal(signal) {
  if (signal == null) return;
  if (
    typeof signal !== 'object' ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw new TypeError('externalSignal must be an AbortSignal');
  }
}

/**
 * Run one provider attempt with an isolated AbortController.
 *
 * Timeout and caller cancellation abort the same signal passed to the
 * provider. The provider operation is always allowed to finish its abort
 * cleanup before this lifecycle rejects, preventing a retry from overlapping
 * the timed-out attempt.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} operation
 * @param {number} timeoutMs
 * @param {AbortSignal | null} [externalSignal]
 * @returns {Promise<T>}
 */
export function runAbortableAttempt(operation, timeoutMs, externalSignal) {
  if (typeof operation !== 'function') {
    throw new TypeError('operation must be a function');
  }
  validateTimeout(timeoutMs);
  validateExternalSignal(externalSignal);

  if (externalSignal?.aborted) {
    return Promise.reject(new AIAbortError());
  }

  const controller = new AbortController();
  let abortSource = null;
  let externalListenerAttached = false;

  const abortFromExternal = () => {
    if (abortSource !== null || controller.signal.aborted) return;
    abortSource = 'external';
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal != null) {
    externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    externalListenerAttached = true;
  }

  const timerId = setTimeout(() => {
    if (abortSource !== null || controller.signal.aborted) return;
    abortSource = 'timeout';
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, timeoutMs);

  return (async () => {
    try {
      let result;
      try {
        result = await operation(controller.signal);
      } catch (error) {
        if (abortSource === 'timeout') throw new AITimeoutError();
        if (abortSource === 'external') throw new AIAbortError();
        if (error?.name === 'AbortError') throw new AIAbortError();
        throw error;
      }

      if (abortSource === 'timeout') throw new AITimeoutError();
      if (abortSource === 'external') throw new AIAbortError();
      return result;
    } finally {
      clearTimeout(timerId);
      if (externalListenerAttached) {
        externalSignal.removeEventListener('abort', abortFromExternal);
      }
    }
  })();
}
