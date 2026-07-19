import { describe, expect, test } from 'bun:test';

import {
  AIAbortError,
  AIAuthError,
  AIDisabledError,
  AIForegroundRequiredError,
  AIMalformedResultError,
  AINetworkError,
  AIRateLimitError,
  AITimeoutError,
  AIUnavailableError,
} from '../../core/ai/provider.js';
import { runAbortableAttempt } from '../../core/ai/request-lifecycle.js';
import { createDeferred } from '../helpers/deferred.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe('Task 13 abortable request lifecycle', () => {
  test('returns success, clears its timer, and never aborts the provider signal', async () => {
    let providerSignal;
    let abortCount = 0;

    const result = await runAbortableAttempt(async (signal) => {
      providerSignal = signal;
      signal.addEventListener('abort', () => {
        abortCount += 1;
      });
      return 'complete';
    }, 10);

    expect(result).toBe('complete');
    await wait(30);
    expect(providerSignal.aborted).toBeFalse();
    expect(abortCount).toBe(0);
  });

  test('aborts the exact provider signal on timeout and waits for settlement', async () => {
    const providerSettled = createDeferred();
    let providerSignal;
    let abortReason;

    const attempt = runAbortableAttempt((signal) => {
      providerSignal = signal;
      signal.addEventListener('abort', () => {
        abortReason = signal.reason;
      }, { once: true });
      return providerSettled.promise;
    }, 10);

    await wait(30);
    expect(providerSignal.aborted).toBeTrue();
    expect(abortReason).toBeDefined();

    let lifecycleSettled = false;
    attempt.finally(() => {
      lifecycleSettled = true;
    }).catch(() => {});
    await Promise.resolve();
    expect(lifecycleSettled).toBeFalse();

    providerSettled.reject(new DOMException('The operation was aborted', 'AbortError'));
    const error = await attempt.catch((reason) => reason);
    expect(error).toBeInstanceOf(AITimeoutError);
    expect(error.code).toBe('AI_TIMEOUT');
    expect(lifecycleSettled).toBeTrue();
  });

  test('maps external cancellation to AIAbortError after provider cleanup settles', async () => {
    const external = new AbortController();
    const providerSettled = createDeferred();
    let providerSignal;

    const attempt = runAbortableAttempt((signal) => {
      providerSignal = signal;
      signal.addEventListener('abort', () => {
        queueMicrotask(() => {
          providerSettled.reject(new DOMException('cancelled', 'AbortError'));
        });
      }, { once: true });
      return providerSettled.promise;
    }, 1_000, external.signal);

    external.abort('user-cancelled');

    const error = await attempt.catch((reason) => reason);
    expect(providerSignal.aborted).toBeTrue();
    expect(providerSignal.reason).toBe('user-cancelled');
    expect(providerSettled.settled).toBeTrue();
    expect(error).toBeInstanceOf(AIAbortError);
    expect(error.code).toBe('AI_ABORTED');
  });

  test('handles an already-aborted external signal before invoking the operation', async () => {
    const external = new AbortController();
    external.abort('navigation');
    let operationCalls = 0;

    const error = await runAbortableAttempt(async () => {
      operationCalls += 1;
      return 'must-not-run';
    }, 1_000, external.signal).catch((reason) => reason);

    expect(operationCalls).toBe(0);
    expect(error).toBeInstanceOf(AIAbortError);
    expect(error.code).toBe('AI_ABORTED');
  });

  test('maps a raw provider AbortError to AIAbortError', async () => {
    const error = await runAbortableAttempt(async () => {
      throw new DOMException('provider cancelled its operation', 'AbortError');
    }, 1_000).catch((reason) => reason);

    expect(error).toBeInstanceOf(AIAbortError);
    expect(error.code).toBe('AI_ABORTED');
  });

  test('cleans up its timer and external listener after a synchronous throw', async () => {
    const external = trackingSignal();
    const providerError = new Error('synchronous provider failure');
    let providerSignal;

    const error = await runAbortableAttempt((signal) => {
      providerSignal = signal;
      throw providerError;
    }, 10, external.signal).catch((reason) => reason);

    expect(error).toBe(providerError);
    expect(external.added).toBe(1);
    expect(external.removed).toBe(1);
    await wait(30);
    expect(providerSignal.aborted).toBeFalse();
  });

  test('keeps the first abort cause when external cancellation beats timeout', async () => {
    const external = new AbortController();
    const providerSettled = createDeferred();
    const attempt = runAbortableAttempt(
      () => providerSettled.promise,
      20,
      external.signal,
    );

    external.abort('navigation');
    await wait(30);
    providerSettled.resolve('provider swallowed cancellation');

    const error = await attempt.catch((reason) => reason);
    expect(error).toBeInstanceOf(AIAbortError);
    expect(error.code).toBe('AI_ABORTED');
  });

  test('keeps the first abort cause when timeout beats external cancellation', async () => {
    const external = new AbortController();
    const providerSettled = createDeferred();
    const attempt = runAbortableAttempt(
      () => providerSettled.promise,
      10,
      external.signal,
    );

    await wait(30);
    external.abort('too-late');
    providerSettled.resolve('provider ignored the signal');

    const error = await attempt.catch((reason) => reason);
    expect(error).toBeInstanceOf(AITimeoutError);
    expect(error.code).toBe('AI_TIMEOUT');
  });

  test('waits for a non-cooperative provider and rejects a swallowed-abort result', async () => {
    const providerSettled = createDeferred();
    let providerSignal;
    let lifecycleSettled = false;

    const attempt = runAbortableAttempt((signal) => {
      providerSignal = signal;
      return providerSettled.promise;
    }, 10);
    attempt.finally(() => {
      lifecycleSettled = true;
    }).catch(() => {});

    await wait(30);
    expect(providerSignal.aborted).toBeTrue();
    expect(lifecycleSettled).toBeFalse();

    providerSettled.resolve('late success');
    const error = await attempt.catch((reason) => reason);
    expect(error).toBeInstanceOf(AITimeoutError);
    expect(lifecycleSettled).toBeTrue();
  });

  test('removes the external abort listener after success and failure', async () => {
    const successfulExternal = trackingSignal();
    await runAbortableAttempt(async () => 'ok', 1_000, successfulExternal.signal);
    expect(successfulExternal.added).toBe(1);
    expect(successfulExternal.removed).toBe(1);

    const failedExternal = trackingSignal();
    const providerError = new AIAuthError('denied');
    const error = await runAbortableAttempt(async () => {
      throw providerError;
    }, 1_000, failedExternal.signal).catch((reason) => reason);

    expect(error).toBe(providerError);
    expect(failedExternal.added).toBe(1);
    expect(failedExternal.removed).toBe(1);
  });

  test('uses a fresh controller and signal for every explicit call', async () => {
    const signals = [];

    await runAbortableAttempt(async (signal) => {
      signals.push(signal);
    }, 1_000);
    await runAbortableAttempt(async (signal) => {
      signals.push(signal);
    }, 1_000);

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  test('does not translate an ordinary provider rejection', async () => {
    const providerError = new AINetworkError('offline');
    const error = await runAbortableAttempt(async () => {
      throw providerError;
    }, 1_000).catch((reason) => reason);

    expect(error).toBe(providerError);
  });

  test('validates operation, timeout, and external signal inputs', async () => {
    for (const operation of [null, {}, 'operation']) {
      expect(() => runAbortableAttempt(operation, 10)).toThrow(TypeError);
    }

    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => runAbortableAttempt(async () => {}, timeoutMs)).toThrow(RangeError);
    }

    for (const signal of [{}, { aborted: false }, { addEventListener() {} }]) {
      expect(() => runAbortableAttempt(async () => {}, 10, signal)).toThrow(TypeError);
    }
  });
});

describe('Task 13 stable AI error codes', () => {
  const errorCases = [
    [AIDisabledError, 'AIDisabledError', 'AI_DISABLED'],
    [AIAuthError, 'AIAuthError', 'AI_AUTH'],
    [AIRateLimitError, 'AIRateLimitError', 'AI_RATE_LIMIT'],
    [AINetworkError, 'AINetworkError', 'AI_NETWORK'],
    [AIAbortError, 'AIAbortError', 'AI_ABORTED'],
    [AITimeoutError, 'AITimeoutError', 'AI_TIMEOUT'],
    [AIForegroundRequiredError, 'AIForegroundRequiredError', 'AI_FOREGROUND_REQUIRED'],
    [AIUnavailableError, 'AIUnavailableError', 'AI_UNAVAILABLE'],
    [AIMalformedResultError, 'AIMalformedResultError', 'AI_MALFORMED_RESULT'],
  ];

  for (const [ErrorType, expectedName, expectedCode] of errorCases) {
    test(`${expectedName} exposes stable code ${expectedCode}`, () => {
      const error = new ErrorType();
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(expectedName);
      expect(error.code).toBe(expectedCode);
      expect(error.message.length).toBeGreaterThan(0);
    });
  }

  test('preserves custom user-safe messages and rate-limit retry metadata', () => {
    const customMessage = 'Please try again later';
    expect(new AIUnavailableError(customMessage).message).toBe(customMessage);
    expect(new AIRateLimitError().retryAfterMs).toBe(2_000);
  });
});
