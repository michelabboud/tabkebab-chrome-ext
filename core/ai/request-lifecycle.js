// core/ai/request-lifecycle.js — One-controller lifecycle for provider attempts

import { AIAbortError, AITimeoutError } from './provider.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
// After a timeout aborts the provider signal, a cooperative provider gets this
// long to finish its abort cleanup. A provider that never settles (e.g. a
// Chrome AI panel that stopped answering) must not hang the caller forever.
export const DEFAULT_TIMEOUT_CLEANUP_GRACE_MS = 5_000;

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
 * provider. A cooperative provider is allowed to finish its abort cleanup
 * before this lifecycle rejects. On timeout, rejection is additionally bounded
 * by `cleanupGraceMs`: if the operation still has not settled by then, the
 * attempt rejects with AITimeoutError regardless of the operation.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} operation
 * @param {number} timeoutMs
 * @param {AbortSignal | null} [externalSignal]
 * @param {{ cleanupGraceMs?: number }} [options]
 * @returns {Promise<T>}
 */
export function runAbortableAttempt(operation, timeoutMs, externalSignal, {
  cleanupGraceMs = DEFAULT_TIMEOUT_CLEANUP_GRACE_MS,
} = {}) {
  if (typeof operation !== 'function') {
    throw new TypeError('operation must be a function');
  }
  validateTimeout(timeoutMs);
  validateExternalSignal(externalSignal);
  if (
    !Number.isInteger(cleanupGraceMs) || cleanupGraceMs < 0 ||
    cleanupGraceMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError('cleanupGraceMs must be a non-negative integer');
  }

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

  let graceTimerId = null;
  let rejectOnGrace;
  const graceExpired = new Promise((_, reject) => { rejectOnGrace = reject; });
  // Never surface as an unhandled rejection when the operation wins the race.
  graceExpired.catch(() => {});

  const timerId = setTimeout(() => {
    if (abortSource !== null || controller.signal.aborted) return;
    abortSource = 'timeout';
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
    graceTimerId = setTimeout(() => rejectOnGrace(new AITimeoutError()), cleanupGraceMs);
  }, timeoutMs);

  const settleOperation = async () => {
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
  };

  return (async () => {
    try {
      return await Promise.race([settleOperation(), graceExpired]);
    } finally {
      clearTimeout(timerId);
      if (graceTimerId !== null) clearTimeout(graceTimerId);
      if (externalListenerAttached) {
        externalSignal.removeEventListener('abort', abortFromExternal);
      }
    }
  })();
}
