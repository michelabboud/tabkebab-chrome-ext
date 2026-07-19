import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ClaudeProvider } from '../../core/ai/provider-claude.js';
import { ChromeAIProvider } from '../../core/ai/provider-chrome.js';
import { CustomProvider } from '../../core/ai/provider-custom.js';
import { GeminiProvider } from '../../core/ai/provider-gemini.js';
import { OpenAIProvider } from '../../core/ai/provider-openai.js';
import {
  AIAbortError,
  AINetworkError,
  AIUnavailableError,
} from '../../core/ai/provider.js';

const REQUEST = Object.freeze({
  systemPrompt: 'System',
  userPrompt: 'hello',
  maxTokens: 32,
  temperature: 0.2,
});

const HTTP_PROVIDERS = Object.freeze([
  {
    id: 'openai',
    provider: OpenAIProvider,
    config: { apiKey: 'openai-test-key', model: 'gpt-4.1-nano' },
    completionBody: {
      choices: [{ message: { content: 'answer' } }],
      usage: { total_tokens: 2 },
    },
    modelsBody: { data: [{ id: 'gpt-4.1-nano' }] },
  },
  {
    id: 'claude',
    provider: ClaudeProvider,
    config: { apiKey: 'claude-test-key', model: 'claude-haiku-4-5' },
    completionBody: {
      content: [{ text: 'answer' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    modelsBody: {
      data: [{ type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' }],
    },
  },
  {
    id: 'gemini',
    provider: GeminiProvider,
    config: { apiKey: 'gemini-test-key', model: 'gemini-2.5-flash' },
    completionBody: {
      candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      usageMetadata: { totalTokenCount: 2 },
    },
    modelsBody: {
      models: [{
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        supportedGenerationMethods: ['generateContent'],
      }],
    },
  },
  {
    id: 'custom',
    provider: CustomProvider,
    config: {
      apiKey: 'custom-test-key',
      model: 'local-model',
      baseUrl: 'http://localhost:11434/v1',
    },
    completionBody: {
      choices: [{ message: { content: 'answer' } }],
      usage: { total_tokens: 2 },
    },
    modelsBody: { data: [{ id: 'local-model' }] },
  },
]);

let originalFetch;
let originalLanguageModelDescriptor;
let originalAiDescriptor;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalLanguageModelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'LanguageModel');
  originalAiDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ai');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreGlobal('LanguageModel', originalLanguageModelDescriptor);
  restoreGlobal('ai', originalAiDescriptor);
});

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

function installLanguageModel(api) {
  Object.defineProperty(globalThis, 'LanguageModel', {
    configurable: true,
    writable: true,
    value: api,
  });
  delete globalThis.ai;
}

function removeLanguageModelAPIs() {
  delete globalThis.LanguageModel;
  delete globalThis.ai;
}

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() { return body; },
  };
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}

async function rejectionOf(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error;
  }
}

function invokeHttpMethod(provider, method, config, signal) {
  if (method === 'complete') return provider.complete(REQUEST, config, signal);
  return provider[method](config, signal);
}

describe('Task 13 HTTP provider signal propagation', () => {
  for (const providerCase of HTTP_PROVIDERS) {
    test(`${providerCase.id} passes one identical signal to complete, test, and model fetches`, async () => {
      const controller = new AbortController();
      const observedSignals = [];
      globalThis.fetch = async (url, options = {}) => {
        observedSignals.push(options.signal);
        return okResponse(String(url).endsWith('/models')
          ? providerCase.modelsBody
          : providerCase.completionBody);
      };

      expect(await providerCase.provider.complete(
        REQUEST,
        providerCase.config,
        controller.signal,
      )).toMatchObject({ text: 'answer', parsed: null, tokensUsed: 2 });
      expect(await providerCase.provider.testConnection(
        providerCase.config,
        controller.signal,
      )).toBeTrue();
      expect((await providerCase.provider.listModels(
        providerCase.config,
        controller.signal,
      )).length).toBeGreaterThan(0);

      expect(observedSignals).toHaveLength(3);
      expect(observedSignals.every((signal) => signal === controller.signal)).toBeTrue();
    });

    for (const method of ['complete', 'testConnection', 'listModels']) {
      test(`${providerCase.id} ${method} maps a fetch AbortError to AIAbortError`, async () => {
        const controller = new AbortController();
        let observedSignal;
        globalThis.fetch = async (_url, options = {}) => {
          observedSignal = options.signal;
          throw abortError();
        };

        const error = await rejectionOf(() => invokeHttpMethod(
          providerCase.provider,
          method,
          providerCase.config,
          controller.signal,
        ));

        expect(observedSignal).toBe(controller.signal);
        expect(error).toBeInstanceOf(AIAbortError);
        expect(error).not.toBeInstanceOf(AINetworkError);
        expect(error.code).toBe('AI_ABORTED');
      });

      test(`${providerCase.id} ${method} maps an aborted signal with a custom rejection reason`, async () => {
        const controller = new AbortController();
        const customReason = new Error('custom cancellation reason');
        globalThis.fetch = async (_url, options = {}) => {
          expect(options.signal).toBe(controller.signal);
          controller.abort(customReason);
          throw customReason;
        };

        const error = await rejectionOf(() => invokeHttpMethod(
          providerCase.provider,
          method,
          providerCase.config,
          controller.signal,
        ));

        expect(error).toBeInstanceOf(AIAbortError);
        expect(error).not.toBeInstanceOf(AINetworkError);
        expect(error.code).toBe('AI_ABORTED');
      });
    }

    for (const method of ['complete', 'listModels']) {
      test(`${providerCase.id} ${method} maps a response-body AbortError to AIAbortError`, async () => {
        const controller = new AbortController();
        globalThis.fetch = async (_url, options = {}) => {
          expect(options.signal).toBe(controller.signal);
          return {
            ok: true,
            status: 200,
            async json() { throw abortError(); },
          };
        };

        const error = await rejectionOf(() => invokeHttpMethod(
          providerCase.provider,
          method,
          providerCase.config,
          controller.signal,
        ));

        expect(error).toBeInstanceOf(AIAbortError);
        expect(error).not.toBeInstanceOf(AINetworkError);
      });

      test(`${providerCase.id} ${method} maps a body abort with a custom rejection reason`, async () => {
        const controller = new AbortController();
        const customReason = new Error('custom body cancellation reason');
        globalThis.fetch = async (_url, options = {}) => {
          expect(options.signal).toBe(controller.signal);
          return {
            ok: true,
            status: 200,
            async json() {
              controller.abort(customReason);
              throw customReason;
            },
          };
        };

        const error = await rejectionOf(() => invokeHttpMethod(
          providerCase.provider,
          method,
          providerCase.config,
          controller.signal,
        ));

        expect(error).toBeInstanceOf(AIAbortError);
        expect(error).not.toBeInstanceOf(AINetworkError);
      });
    }

    test(`${providerCase.id} complete preserves abort while reading an HTTP error body`, async () => {
      const controller = new AbortController();
      globalThis.fetch = async (_url, options = {}) => {
        expect(options.signal).toBe(controller.signal);
        return {
          ok: false,
          status: 500,
          async text() { throw abortError(); },
        };
      };

      const error = await rejectionOf(() => providerCase.provider.complete(
        REQUEST,
        providerCase.config,
        controller.signal,
      ));

      expect(error).toBeInstanceOf(AIAbortError);
      expect(error).not.toBeInstanceOf(AINetworkError);
    });

    for (const bodyCase of [
      { name: 'JSON body', ok: true, status: 200, method: 'json' },
      { name: 'HTTP error body', ok: false, status: 500, method: 'text' },
    ]) {
      test(`${providerCase.id} complete does not start the ${bodyCase.name} after cancellation`, async () => {
        const controller = new AbortController();
        let bodyReads = 0;
        globalThis.fetch = async (_url, options = {}) => {
          expect(options.signal).toBe(controller.signal);
          return {
            get ok() {
              controller.abort();
              return bodyCase.ok;
            },
            status: bodyCase.status,
            async [bodyCase.method]() {
              bodyReads += 1;
              return bodyCase.method === 'json' ? providerCase.completionBody : 'server error';
            },
          };
        };

        const error = await rejectionOf(() => providerCase.provider.complete(
          REQUEST,
          providerCase.config,
          controller.signal,
        ));

        expect(error).toBeInstanceOf(AIAbortError);
        expect(bodyReads).toBe(0);
      });
    }
  }
});

describe('Task 13 Chrome Prompt API signal and cleanup contract', () => {
  test('passes the identical signal to create and prompt, destroys, and keeps the response shape', async () => {
    const controller = new AbortController();
    let createOptions;
    let promptOptions;
    let destroyCalls = 0;
    installLanguageModel({
      async availability() { return 'available'; },
      async create(options) {
        createOptions = options;
        return {
          async prompt(input, optionsForPrompt) {
            expect(input).toBe(REQUEST.userPrompt);
            promptOptions = optionsForPrompt;
            return 'answer';
          },
          async destroy() { destroyCalls += 1; },
        };
      },
    });

    const result = await ChromeAIProvider.complete(REQUEST, {}, controller.signal);

    expect(createOptions.signal).toBe(controller.signal);
    expect(promptOptions.signal).toBe(controller.signal);
    expect(destroyCalls).toBe(1);
    expect(result).toEqual({ text: 'answer', parsed: null, tokensUsed: 3 });
  });

  test('waits for session destruction before exposing a prompt abort', async () => {
    const controller = new AbortController();
    let releaseDestroy;
    let markDestroyStarted;
    let destroyStarted = false;
    const destroyGate = new Promise((resolve) => { releaseDestroy = resolve; });
    const destroyStartedGate = new Promise((resolve) => { markDestroyStarted = resolve; });
    installLanguageModel({
      async availability() { return 'available'; },
      async create(options) {
        expect(options.signal).toBe(controller.signal);
        return {
          async prompt(_input, promptOptions) {
            expect(promptOptions.signal).toBe(controller.signal);
            throw abortError();
          },
          async destroy() {
            destroyStarted = true;
            markDestroyStarted();
            await destroyGate;
          },
        };
      },
    });

    const pending = rejectionOf(() => ChromeAIProvider.complete(REQUEST, {}, controller.signal));
    await destroyStartedGate;
    expect(destroyStarted).toBeTrue();
    let settled = false;
    pending.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBeFalse();

    releaseDestroy();
    const error = await pending;
    expect(error).toBeInstanceOf(AIAbortError);
    expect(error).not.toBeInstanceOf(AINetworkError);
    expect(settled).toBeTrue();
  });

  test('maps create AbortError without wrapping it as a network failure', async () => {
    const controller = new AbortController();
    installLanguageModel({
      async availability() { return 'available'; },
      async create(options) {
        expect(options.signal).toBe(controller.signal);
        throw abortError();
      },
    });

    const error = await rejectionOf(() =>
      ChromeAIProvider.complete(REQUEST, {}, controller.signal));
    expect(error).toBeInstanceOf(AIAbortError);
    expect(error).not.toBeInstanceOf(AINetworkError);
  });

  for (const stage of ['availability', 'create', 'prompt']) {
    test(`maps an aborted signal with a custom ${stage} rejection reason`, async () => {
      const controller = new AbortController();
      const customReason = new Error(`custom ${stage} cancellation reason`);
      let destroyCalls = 0;
      installLanguageModel({
        async availability() {
          if (stage === 'availability') {
            controller.abort(customReason);
            throw customReason;
          }
          return 'available';
        },
        async create(options) {
          expect(options.signal).toBe(controller.signal);
          if (stage === 'create') {
            controller.abort(customReason);
            throw customReason;
          }
          return {
            async prompt(_input, promptOptions) {
              expect(promptOptions.signal).toBe(controller.signal);
              controller.abort(customReason);
              throw customReason;
            },
            async destroy() { destroyCalls += 1; },
          };
        },
      });

      const error = await rejectionOf(() =>
        ChromeAIProvider.complete(REQUEST, {}, controller.signal));
      expect(error).toBeInstanceOf(AIAbortError);
      expect(error).not.toBeInstanceOf(AINetworkError);
      expect(destroyCalls).toBe(stage === 'prompt' ? 1 : 0);
    });
  }

  test('testConnection maps an aborted signal with a custom availability rejection reason', async () => {
    const controller = new AbortController();
    const customReason = new Error('custom availability cancellation reason');
    installLanguageModel({
      async availability() {
        controller.abort(customReason);
        throw customReason;
      },
    });

    const error = await rejectionOf(() =>
      ChromeAIProvider.testConnection({}, controller.signal));
    expect(error).toBeInstanceOf(AIAbortError);
    expect(error).not.toBeInstanceOf(AINetworkError);
  });

  test('does not relabel an unknown local prompt failure as retryable network transport', async () => {
    const failure = new Error('local prompt failed');
    let destroyCalls = 0;
    installLanguageModel({
      async availability() { return 'available'; },
      async create() {
        return {
          async prompt() { throw failure; },
          async destroy() { destroyCalls += 1; },
        };
      },
    });

    const error = await rejectionOf(() =>
      ChromeAIProvider.complete(REQUEST, {}, new AbortController().signal));
    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(AINetworkError);
    expect(destroyCalls).toBe(1);
  });

  test('maps an absent Prompt API to AIUnavailableError', async () => {
    removeLanguageModelAPIs();

    const error = await rejectionOf(() =>
      ChromeAIProvider.complete(REQUEST, {}, new AbortController().signal));
    expect(error).toBeInstanceOf(AIUnavailableError);
    expect(error.code).toBe('AI_UNAVAILABLE');
  });

  for (const status of ['downloadable', 'downloading']) {
    test(`maps ${status} model availability to AIUnavailableError without creating`, async () => {
      let createCalls = 0;
      installLanguageModel({
        async availability() { return status; },
        async create() { createCalls += 1; },
      });

      const error = await rejectionOf(() =>
        ChromeAIProvider.complete(REQUEST, {}, new AbortController().signal));
      expect(error).toBeInstanceOf(AIUnavailableError);
      expect(createCalls).toBe(0);
    });
  }

  test('maps legacy after-download availability to AIUnavailableError without creating', async () => {
    let createCalls = 0;
    installLanguageModel({
      async capabilities() { return { available: 'after-download' }; },
      async create() { createCalls += 1; },
    });

    const error = await rejectionOf(() =>
      ChromeAIProvider.complete(REQUEST, {}, new AbortController().signal));
    expect(error).toBeInstanceOf(AIUnavailableError);
    expect(createCalls).toBe(0);
  });

  test('fails closed with AIUnavailableError for an unknown availability value', async () => {
    let createCalls = 0;
    installLanguageModel({
      async availability() { return 'future-unknown-state'; },
      async create() { createCalls += 1; },
    });

    const error = await rejectionOf(() =>
      ChromeAIProvider.complete(REQUEST, {}, new AbortController().signal));
    expect(error).toBeInstanceOf(AIUnavailableError);
    expect(createCalls).toBe(0);
  });

  test('testConnection preserves boolean fallback but does not swallow cancellation', async () => {
    const controller = new AbortController();
    installLanguageModel({
      async availability() { return 'downloadable'; },
    });
    expect(await ChromeAIProvider.testConnection({}, controller.signal)).toBeFalse();

    controller.abort();
    const error = await rejectionOf(() =>
      ChromeAIProvider.testConnection({}, controller.signal));
    expect(error).toBeInstanceOf(AIAbortError);
  });
});
