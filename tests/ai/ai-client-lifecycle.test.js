import { describe, expect, test } from 'bun:test';

import { AIClient } from '../../core/ai/ai-client.js';
import {
  AIAbortError,
  AIAuthError,
  AIDisabledError,
  AIForegroundRequiredError,
  AIMalformedResultError,
  AINetworkError,
  AITimeoutError,
  AIUnavailableError,
  PROVIDER_DEFAULTS,
} from '../../core/ai/provider.js';
import { CustomProvider } from '../../core/ai/provider-custom.js';
import { deferred } from '../helpers/deferred.js';

function privateCustomSettings() {
  return {
    enabled: true,
    providerId: 'custom',
    providerConfigs: {
      openai: { model: PROVIDER_DEFAULTS.openai.model },
      claude: { model: PROVIDER_DEFAULTS.claude.model },
      gemini: { model: PROVIDER_DEFAULTS.gemini.model },
      'chrome-ai': { model: PROVIDER_DEFAULTS['chrome-ai'].model },
      custom: {
        model: 'task-13-model',
        baseUrl: 'http://localhost:11434/v1',
      },
    },
    usePassphrase: false,
  };
}

async function configureCustomProvider() {
  await chrome.storage.local.set({ aiSettings: privateCustomSettings() });
}

async function rejectionOf(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject');
}

function accelerateQueueDelays() {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (Number(delay) < 10_000) {
      queueMicrotask(() => callback(...args));
      return 0;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  return () => {
    globalThis.setTimeout = originalSetTimeout;
  };
}

function triggerRequestTimeoutImmediately() {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (Number(delay) > 0) {
      queueMicrotask(() => callback(...args));
      return 0;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  return () => {
    globalThis.setTimeout = originalSetTimeout;
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

describe('Task 13 AIClient abort lifecycle integration', () => {
  test('each queued retry invokes the provider with a fresh AbortSignal and caches only success', async () => {
    await configureCustomProvider();
    const originalComplete = CustomProvider.complete;
    const restoreDelays = accelerateQueueDelays();
    const signals = [];
    let calls = 0;

    CustomProvider.complete = async (_request, _config, signal) => {
      signals.push(signal);
      calls += 1;
      if (calls === 1) throw new AINetworkError('synthetic first-attempt failure');
      return { text: 'settled-success', parsed: null, tokensUsed: 1 };
    };

    const request = {
      systemPrompt: 'task-13-system',
      userPrompt: 'task-13-fresh-controller',
    };
    try {
      expect(await AIClient.complete(request)).toMatchObject({
        text: 'settled-success',
        fromCache: false,
      });
      expect(calls).toBe(2);
      expect(signals).toHaveLength(2);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).toBeInstanceOf(AbortSignal);
      expect(signals[0]).not.toBe(signals[1]);

      expect(await AIClient.complete(request)).toMatchObject({
        text: 'settled-success',
        fromCache: true,
      });
      expect(calls).toBe(2);
    } finally {
      CustomProvider.complete = originalComplete;
      restoreDelays();
    }
  });

  test('connection tests and model lists receive distinct explicit-attempt signals', async () => {
    await configureCustomProvider();
    const originalTest = CustomProvider.testConnection;
    const originalList = CustomProvider.listModels;
    const signals = [];

    CustomProvider.testConnection = async (_config, signal) => {
      signals.push(signal);
      return true;
    };
    CustomProvider.listModels = async (_config, signal) => {
      signals.push(signal);
      return [{ id: 'task-13-model', name: 'Task 13 model' }];
    };

    try {
      expect(await AIClient.testConnection('custom')).toBeTrue();
      expect(await AIClient.listModels('custom')).toEqual([
        { id: 'task-13-model', name: 'Task 13 model' },
      ]);
      expect(signals).toHaveLength(2);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).toBeInstanceOf(AbortSignal);
      expect(signals[0]).not.toBe(signals[1]);
    } finally {
      CustomProvider.testConnection = originalTest;
      CustomProvider.listModels = originalList;
    }
  });

  test('testConnection waits for timeout cleanup before returning false', async () => {
    await configureCustomProvider();
    const originalTest = CustomProvider.testConnection;
    const restoreTimeout = triggerRequestTimeoutImmediately();
    const cleanup = deferred();
    let providerSignal;
    let clientSettled = false;

    CustomProvider.testConnection = (_config, signal) => {
      providerSignal = signal;
      return cleanup.promise;
    };

    try {
      const resultPromise = AIClient.testConnection('custom');
      resultPromise.finally(() => {
        clientSettled = true;
      }).catch(() => {});
      await waitFor(() => providerSignal?.aborted === true, 'connection timeout did not abort provider');

      expect(providerSignal.aborted).toBeTrue();
      expect(clientSettled).toBeFalse();

      cleanup.reject(new DOMException('cleanup complete', 'AbortError'));
      expect(await resultPromise).toBeFalse();
      expect(clientSettled).toBeTrue();
    } finally {
      if (!cleanup.settled) cleanup.reject(new Error('test cleanup'));
      CustomProvider.testConnection = originalTest;
      restoreTimeout();
    }
  });

  test('listModels waits for timeout cleanup before returning an empty list', async () => {
    await configureCustomProvider();
    const originalList = CustomProvider.listModels;
    const restoreTimeout = triggerRequestTimeoutImmediately();
    const cleanup = deferred();
    let providerSignal;
    let clientSettled = false;

    CustomProvider.listModels = (_config, signal) => {
      providerSignal = signal;
      return cleanup.promise;
    };

    try {
      const resultPromise = AIClient.listModels('custom');
      resultPromise.finally(() => {
        clientSettled = true;
      }).catch(() => {});
      await waitFor(() => providerSignal?.aborted === true, 'model-list timeout did not abort provider');

      expect(providerSignal.aborted).toBeTrue();
      expect(clientSettled).toBeFalse();

      cleanup.resolve([{ id: 'late-model', name: 'Late model' }]);
      expect(await resultPromise).toEqual([]);
      expect(clientSettled).toBeTrue();
    } finally {
      if (!cleanup.settled) cleanup.reject(new Error('test cleanup'));
      CustomProvider.listModels = originalList;
      restoreTimeout();
    }
  });

  test('a late completion after timeout is rejected and never cached', async () => {
    await configureCustomProvider();
    const originalComplete = CustomProvider.complete;
    const restoreTimeout = triggerRequestTimeoutImmediately();
    const lateResult = deferred();
    let calls = 0;
    let providerSignal;

    CustomProvider.complete = (_request, _config, signal) => {
      calls += 1;
      providerSignal = signal;
      if (calls === 1) return lateResult.promise;
      return Promise.resolve({ text: 'fresh-success', parsed: null, tokensUsed: 1 });
    };

    const request = {
      systemPrompt: 'task-13-system',
      userPrompt: 'task-13-timeout-cache-boundary',
    };
    try {
      const timedOut = AIClient.complete(request);
      timedOut.catch(() => {});
      await waitFor(() => providerSignal?.aborted === true, 'completion timeout did not abort provider');
      expect(providerSignal.aborted).toBeTrue();

      lateResult.resolve({ text: 'late-success', parsed: null, tokensUsed: 1 });
      const error = await rejectionOf(() => timedOut);
      expect(error).toBeInstanceOf(AITimeoutError);
      expect(calls).toBe(1);

      restoreTimeout();
      expect(await AIClient.complete(request)).toMatchObject({
        text: 'fresh-success',
        fromCache: false,
      });
      expect(calls).toBe(2);
    } finally {
      if (!lateResult.settled) lateResult.reject(new Error('test cleanup'));
      CustomProvider.complete = originalComplete;
      restoreTimeout();
    }
  });

  test('a raw AbortError from a connection test returns the existing false fallback', async () => {
    await configureCustomProvider();
    const originalTest = CustomProvider.testConnection;
    CustomProvider.testConnection = async () => {
      throw new DOMException('provider cancelled', 'AbortError');
    };

    try {
      expect(await AIClient.testConnection('custom')).toBeFalse();
    } finally {
      CustomProvider.testConnection = originalTest;
    }
  });

  test('non-retryable typed failures keep their safe category and run exactly one attempt', async () => {
    await configureCustomProvider();
    const originalComplete = CustomProvider.complete;
    const restoreDelays = accelerateQueueDelays();
    const cases = [
      [AIAuthError, 'AI_AUTH'],
      [AIDisabledError, 'AI_DISABLED'],
      [AIUnavailableError, 'AI_UNAVAILABLE'],
      [AIForegroundRequiredError, 'AI_FOREGROUND_REQUIRED'],
      [AITimeoutError, 'AI_TIMEOUT'],
      [AIAbortError, 'AI_ABORTED'],
      [AIMalformedResultError, 'AI_MALFORMED_RESULT'],
    ];
    let calls = 0;

    try {
      for (const [ErrorClass, code] of cases) {
        CustomProvider.complete = async () => {
          calls += 1;
          throw new ErrorClass('provider-controlled private detail');
        };
        const before = calls;
        const error = await rejectionOf(() => AIClient.complete({
          systemPrompt: 'task-13-system',
          userPrompt: `task-13-${code}`,
        }));
        expect(calls - before).toBe(1);
        expect(error).toBeInstanceOf(ErrorClass);
        expect(error.code).toBe(code);
        expect(error.message).not.toContain('provider-controlled');
      }
    } finally {
      CustomProvider.complete = originalComplete;
      restoreDelays();
    }
  });

  test('an unknown provider failure is classified before sanitization and is not retried', async () => {
    await configureCustomProvider();
    const originalComplete = CustomProvider.complete;
    const restoreDelays = accelerateQueueDelays();
    let calls = 0;
    CustomProvider.complete = async () => {
      calls += 1;
      throw new Error('untrusted provider detail');
    };

    try {
      const error = await rejectionOf(() => AIClient.complete({
        systemPrompt: 'task-13-system',
        userPrompt: 'task-13-unknown-failure',
      }));
      expect(calls).toBe(1);
      expect(error).toBeInstanceOf(AINetworkError);
      expect(error.code).toBe('AI_NETWORK');
      expect(error.message).toBe('Network error');
    } finally {
      CustomProvider.complete = originalComplete;
      restoreDelays();
    }
  });
});
