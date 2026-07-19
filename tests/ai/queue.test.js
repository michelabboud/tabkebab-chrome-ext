import { describe, expect, test } from 'bun:test';

import { AIQueue } from '../../core/ai/queue.js';
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
import { createDeferred } from '../helpers/deferred.js';
import { createProviderDouble } from '../helpers/provider-double.js';

function createFastQueue(options = {}) {
  return new AIQueue({
    maxConcurrent: 1,
    minIntervalMs: 0,
    delay: async () => {},
    ...options,
  });
}

function throwingBehavior(error) {
  return async () => {
    throw error;
  };
}

describe('AIQueue retry classification', () => {
  for (const [label, ErrorType] of [
    ['network', AINetworkError],
    ['rate-limit', AIRateLimitError],
  ]) {
    test(`retries a typed ${label} failure twice for exactly three total attempts`, async () => {
      const failure = new ErrorType(`${label} failed`);
      const provider = createProviderDouble([
        throwingBehavior(failure),
        throwingBehavior(failure),
        throwingBehavior(failure),
      ]);
      const queue = createFastQueue();

      await expect(queue.enqueue(() => provider.complete())).rejects.toBe(failure);

      expect(provider.attemptCount).toBe(3);
      expect(provider.activeCount).toBe(0);
      expect(provider.maxActiveCount).toBe(1);
    });
  }

  for (const [label, makeError] of [
    ['authentication', () => new AIAuthError()],
    ['disabled', () => new AIDisabledError()],
    ['unavailable-provider', () => new AIUnavailableError()],
    ['foreground-required', () => new AIForegroundRequiredError()],
    ['timeout', () => new AITimeoutError()],
    ['abort', () => new AIAbortError()],
    ['malformed-result', () => new AIMalformedResultError()],
    ['unknown', () => new Error('unknown failure')],
  ]) {
    test(`does not retry a ${label} failure`, async () => {
      const failure = makeError();
      const provider = createProviderDouble([throwingBehavior(failure)]);
      const queue = createFastQueue();

      await expect(queue.enqueue(() => provider.complete())).rejects.toBe(failure);

      expect(provider.attemptCount).toBe(1);
      expect(provider.maxActiveCount).toBe(1);
    });
  }

  test('honors maxRetries zero as one total attempt', async () => {
    const failure = new AINetworkError('do not retry');
    const provider = createProviderDouble([throwingBehavior(failure)]);
    const queue = createFastQueue({ maxRetries: 0 });

    await expect(queue.enqueue(() => provider.complete())).rejects.toBe(failure);
    expect(provider.attemptCount).toBe(1);
  });

  test('stops retrying when a later attempt becomes non-retryable', async () => {
    const retryable = new AINetworkError('retry once');
    const terminal = new AIAuthError('credentials rejected');
    const provider = createProviderDouble([
      throwingBehavior(retryable),
      throwingBehavior(terminal),
    ]);
    const queue = createFastQueue();

    await expect(queue.enqueue(() => provider.complete())).rejects.toBe(terminal);
    expect(provider.attemptCount).toBe(2);
  });
});

describe('AIQueue retry configuration', () => {
  for (const invalid of [
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '2',
    null,
  ]) {
    test(`rejects invalid maxRetries value ${String(invalid)}`, () => {
      expect(() => new AIQueue({ maxRetries: invalid })).toThrow(RangeError);
    });
  }

  for (const [option, value] of [
    ['backoff', 1],
    ['clock', null],
    ['delay', 'later'],
  ]) {
    test(`rejects a non-function ${option} dependency`, () => {
      expect(() => new AIQueue({ [option]: value })).toThrow(TypeError);
    });
  }

  for (const invalidDelay of [-1, NaN, Infinity]) {
    test(`rejects invalid backoff result ${String(invalidDelay)} before another attempt`, async () => {
      const failure = new AINetworkError('transient');
      let delayCalls = 0;
      const provider = createProviderDouble([
        throwingBehavior(failure),
        async () => 'must not run',
      ]);
      const queue = new AIQueue({
        maxConcurrent: 1,
        minIntervalMs: 0,
        maxRetries: 1,
        backoff: () => invalidDelay,
        delay: async () => {
          delayCalls++;
        },
      });

      await expect(queue.enqueue(() => provider.complete())).rejects.toThrow(RangeError);
      expect(provider.attemptCount).toBe(1);
      expect(delayCalls).toBe(0);
    });
  }

  test('injects backoff and delay without wall-clock waiting', async () => {
    const failure = new AINetworkError('transient');
    const backoffCalls = [];
    const delays = [];
    const provider = createProviderDouble([
      throwingBehavior(failure),
      async () => 'recovered',
    ]);
    const queue = new AIQueue({
      maxConcurrent: 1,
      minIntervalMs: 0,
      maxRetries: 1,
      backoff(error, retryNumber) {
        backoffCalls.push([error, retryNumber]);
        return 37;
      },
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(queue.enqueue(() => provider.complete())).resolves.toBe('recovered');
    expect(backoffCalls).toEqual([[failure, 1]]);
    expect(delays).toEqual([37]);
    expect(provider.attemptCount).toBe(2);
  });

  test('injects the clock used by minimum-interval pacing', async () => {
    let now = 100;
    const delays = [];
    const queue = new AIQueue({
      maxConcurrent: 1,
      minIntervalMs: 10,
      maxRetries: 0,
      clock: () => now,
      delay: async (ms) => {
        delays.push(ms);
        now += ms;
      },
    });

    await queue.enqueue(async () => 'first');
    now += 4;
    await queue.enqueue(async () => 'second');

    expect(delays).toEqual([6]);
  });
});

describe('AIQueue attempt settlement', () => {
  test('settles a deferred first attempt before starting its retry', async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secondStarted = createDeferred();
    const events = [];
    const provider = createProviderDouble([
      async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        throw new AINetworkError('retry after settlement');
      },
      async () => {
        secondStarted.resolve();
        return 'complete';
      },
    ], { events });
    const queue = createFastQueue({
      maxRetries: 1,
      backoff: () => 0,
    });

    const result = queue.enqueue(() => provider.complete());
    await firstStarted.promise;
    expect(secondStarted.settled).toBeFalse();

    releaseFirst.resolve();
    await secondStarted.promise;
    await expect(result).resolves.toBe('complete');

    expect(events).toEqual([
      'attempt1-started',
      'attempt1-settled',
      'attempt2-started',
      'attempt2-settled',
    ]);
    expect(provider.maxActiveCount).toBe(1);
    expect(provider.activeCount).toBe(0);
  });
});
