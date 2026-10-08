import { afterEach, describe, expect, test } from 'bun:test';

import { AIClient, isCacheableResponse } from '../../core/ai/ai-client.js';
import { AICache } from '../../core/ai/cache.js';
import {
  LEGACY_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
  decryptApiKey,
  encryptApiKey,
  getInstallId,
} from '../../core/ai/crypto.js';
import { GeminiProvider, geminiThinkingConfig } from '../../core/ai/provider-gemini.js';
import { OpenAIProvider, isOpenAIReasoningModel } from '../../core/ai/provider-openai.js';
import { ClaudeProvider } from '../../core/ai/provider-claude.js';
import { CustomProvider } from '../../core/ai/provider-custom.js';
import {
  AINetworkError,
  AIRequestError,
  AITimeoutError,
  PROVIDER_DEFAULTS,
  providerHttpError,
} from '../../core/ai/provider.js';
import { AIQueue } from '../../core/ai/queue.js';
import { runAbortableAttempt } from '../../core/ai/request-lifecycle.js';
import { installChromeMock, readStorageArea } from '../helpers/chrome-mock.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureFetch(responseBody, status = 200) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(
      typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  };
  return requests;
}

function customSettings() {
  return {
    enabled: true,
    providerId: 'custom',
    providerConfigs: {
      openai: { model: PROVIDER_DEFAULTS.openai.model },
      claude: { model: PROVIDER_DEFAULTS.claude.model },
      gemini: { model: PROVIDER_DEFAULTS.gemini.model },
      'chrome-ai': { model: PROVIDER_DEFAULTS['chrome-ai'].model },
      custom: { model: 'ws2-model', baseUrl: 'http://localhost:11434/v1' },
    },
    usePassphrase: false,
  };
}

// ── 2.3 cache only usable responses ──

describe('WS2 2.3 AI response caching', () => {
  test('isCacheableResponse requires parsed JSON or non-empty text', () => {
    expect(isCacheableResponse({ responseFormat: 'json' }, { text: '{"a":1}', parsed: { a: 1 } }))
      .toBeTrue();
    expect(isCacheableResponse({ responseFormat: 'json' }, { text: 'not json', parsed: null }))
      .toBeFalse();
    expect(isCacheableResponse({}, { text: '   ', parsed: null })).toBeFalse();
    expect(isCacheableResponse({}, { text: 'hello', parsed: null })).toBeTrue();
    expect(isCacheableResponse({}, null)).toBeFalse();
  });

  test('an unparseable JSON response is not replayed from cache', async () => {
    installChromeMock();
    await chrome.storage.local.set({ aiSettings: customSettings() });
    const original = CustomProvider.complete;
    let calls = 0;
    CustomProvider.complete = async () => {
      calls += 1;
      return calls === 1
        ? { text: 'garbage', parsed: null, tokensUsed: 1 }
        : { text: '{"ok":true}', parsed: { ok: true }, tokensUsed: 1 };
    };
    const request = {
      systemPrompt: 'ws2-cache',
      userPrompt: `ws2-cache-${crypto.randomUUID()}`,
      responseFormat: 'json',
    };
    try {
      expect(await AIClient.complete(request)).toMatchObject({ parsed: null, fromCache: false });
      expect(await AIClient.complete(request)).toMatchObject({ parsed: { ok: true }, fromCache: false });
      expect(await AIClient.complete(request)).toMatchObject({ parsed: { ok: true }, fromCache: true });
      expect(calls).toBe(2);
    } finally {
      CustomProvider.complete = original;
    }
  });
});

// ── 2.4 Gemini thinking budget ──

describe('WS2 2.4 Gemini thinking config', () => {
  test('disables thinking for 2.5 flash models only', () => {
    expect(geminiThinkingConfig('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig('gemini-2.5-flash-lite')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig('models/gemini-2.5-flash-preview-05-20')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig('gemini-2.5-pro')).toBeNull();
    expect(geminiThinkingConfig('gemini-2.0-flash')).toBeNull();
  });

  test('complete() sends thinkingConfig in generationConfig', async () => {
    const requests = captureFetch({
      candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }],
      usageMetadata: { totalTokenCount: 3 },
    });
    await GeminiProvider.complete(
      { userPrompt: 'hi', maxTokens: 64, responseFormat: 'json' },
      { apiKey: 'k', model: 'gemini-2.5-flash' },
    );
    expect(requests[0].body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(requests[0].body.generationConfig.maxOutputTokens).toBe(64);

    await GeminiProvider.complete({ userPrompt: 'hi' }, { apiKey: 'k', model: 'gemini-2.5-pro' });
    expect(requests[1].body.generationConfig.thinkingConfig).toBeUndefined();
  });
});

// ── 2.5 OpenAI reasoning models + non-retryable 4xx ──

describe('WS2 2.5 OpenAI reasoning models and 4xx handling', () => {
  test('detects o-series and gpt-5 reasoning models', () => {
    for (const model of ['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5.1']) {
      expect(isOpenAIReasoningModel(model)).toBeTrue();
    }
    for (const model of ['gpt-4.1-nano', 'gpt-4o', 'gpt-50x', 'omni']) {
      expect(isOpenAIReasoningModel(model)).toBeFalse();
    }
  });

  test('reasoning models use max_completion_tokens and omit temperature', async () => {
    const body = { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } };
    const requests = captureFetch(body);
    await OpenAIProvider.complete(
      { userPrompt: 'hi', maxTokens: 100, temperature: 0.1 },
      { apiKey: 'k', model: 'o4-mini' },
    );
    expect(requests[0].body.max_completion_tokens).toBe(100);
    expect(requests[0].body.max_tokens).toBeUndefined();
    expect(requests[0].body.temperature).toBeUndefined();

    await OpenAIProvider.complete(
      { userPrompt: 'hi', maxTokens: 100, temperature: 0.1 },
      { apiKey: 'k', model: 'gpt-4.1-nano' },
    );
    expect(requests[1].body.max_tokens).toBe(100);
    expect(requests[1].body.max_completion_tokens).toBeUndefined();
    expect(requests[1].body.temperature).toBe(0.1);
  });

  test('providerHttpError maps permanent 4xx to AIRequestError and others to AINetworkError', () => {
    expect(providerHttpError('X', 400, 'bad')).toBeInstanceOf(AIRequestError);
    expect(providerHttpError('X', 404, 'missing')).toBeInstanceOf(AIRequestError);
    expect(providerHttpError('X', 422, '')).toBeInstanceOf(AIRequestError);
    expect(providerHttpError('X', 408, '')).toBeInstanceOf(AINetworkError);
    expect(providerHttpError('X', 500, '')).toBeInstanceOf(AINetworkError);
    expect(providerHttpError('X', 503, '')).toBeInstanceOf(AINetworkError);
    expect(new AIRequestError().code).toBe('AI_REQUEST');
  });

  const providers = [
    ['openai', OpenAIProvider, { apiKey: 'k', model: 'gpt-4.1-nano' }],
    ['claude', ClaudeProvider, { apiKey: 'k', model: 'claude-haiku-4-5' }],
    ['gemini', GeminiProvider, { apiKey: 'k', model: 'gemini-2.5-flash' }],
    ['custom', CustomProvider, { apiKey: 'k', model: 'm', baseUrl: 'http://localhost:11434/v1' }],
  ];
  for (const [id, provider, config] of providers) {
    test(`${id} throws non-retryable AIRequestError for HTTP 400`, async () => {
      captureFetch('{"error":"bad request"}', 400);
      await expect(provider.complete({ userPrompt: 'hi' }, config)).rejects.toBeInstanceOf(AIRequestError);
    });
  }

  test('the queue does not retry an AIRequestError', async () => {
    const queue = new AIQueue({ minIntervalMs: 0, delay: async () => {} });
    let calls = 0;
    const error = await queue.enqueue(async () => {
      calls += 1;
      throw new AIRequestError('bad');
    }).catch((reason) => reason);
    expect(error).toBeInstanceOf(AIRequestError);
    expect(calls).toBe(1);
  });

  test('AIClient surfaces a provider 4xx as AIRequestError after one attempt', async () => {
    installChromeMock();
    await chrome.storage.local.set({ aiSettings: customSettings() });
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response('{"error":"unsupported parameter"}', { status: 400 });
    };
    const error = await AIClient.complete({
      userPrompt: `ws2-4xx-${crypto.randomUUID()}`,
    }).catch((reason) => reason);
    expect(error).toBeInstanceOf(AIRequestError);
    expect(calls).toBe(1);
  });
});

// ── 2.6 PBKDF2 iteration count per record ──

describe('WS2 2.6 API key encryption iterations', () => {
  async function legacyEncrypt(plainKey, secret) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: LEGACY_PBKDF2_ITERATIONS, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plainKey),
    );
    const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return { ciphertext: b64(ciphertext), salt: b64(salt), iv: b64(iv) };
  }

  test('new records store 600k iterations and round-trip', async () => {
    installChromeMock();
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    const blob = await encryptApiKey('sk-new', 'passphrase');
    expect(blob.iterations).toBe(600_000);
    expect(await decryptApiKey(blob, 'passphrase')).toBe('sk-new');

    const deviceBlob = await encryptApiKey('sk-device');
    expect(deviceBlob.iterations).toBe(600_000);
    expect(await decryptApiKey(deviceBlob)).toBe('sk-device');
  });

  test('legacy records without an iteration count decrypt with 100k', async () => {
    installChromeMock();
    const passphraseBlob = {
      ...(await legacyEncrypt('sk-legacy-pass', 'old passphrase')),
      usesPassphrase: true,
    };
    expect(await decryptApiKey(passphraseBlob, 'old passphrase')).toBe('sk-legacy-pass');

    const deviceBlob = {
      ...(await legacyEncrypt('sk-legacy-device', await getInstallId())),
      usesPassphrase: false,
    };
    expect(await decryptApiKey(deviceBlob)).toBe('sk-legacy-device');
  });

  test('rejects a record with a tampered iteration count', async () => {
    installChromeMock();
    const blob = await encryptApiKey('sk-x', 'pw');
    for (const iterations of [1, 99_999, 1e12, '600000', null]) {
      await expect(decryptApiKey({ ...blob, iterations }, 'pw')).rejects.toThrow();
    }
  });

  test('AIClient uses both legacy and current stored blobs', async () => {
    installChromeMock();
    const legacy = {
      ...(await legacyEncrypt('sk-legacy-openai', await getInstallId())),
      usesPassphrase: false,
    };
    const current = await encryptApiKey('sk-current-gemini');
    const settings = customSettings();
    settings.providerConfigs.openai.apiKey = legacy;
    settings.providerConfigs.gemini.apiKey = current;
    await chrome.storage.local.set({ aiSettings: settings });

    const publicSettings = await AIClient.getPublicSettings();
    expect(publicSettings.providerConfigs.openai.hasApiKey).toBeTrue();
    expect(publicSettings.providerConfigs.gemini.hasApiKey).toBeTrue();

    const seen = [];
    const originalOpenAI = OpenAIProvider.complete;
    const originalGemini = GeminiProvider.complete;
    OpenAIProvider.complete = async (_request, config) => {
      seen.push(config.apiKey);
      return { text: 'ok', parsed: null, tokensUsed: 1 };
    };
    GeminiProvider.complete = async (_request, config) => {
      seen.push(config.apiKey);
      return { text: 'ok', parsed: null, tokensUsed: 1 };
    };
    try {
      for (const providerId of ['openai', 'gemini']) {
        await chrome.storage.local.set({ aiSettings: { ...settings, providerId } });
        await AIClient.complete({ userPrompt: `ws2-iter-${providerId}-${crypto.randomUUID()}` });
      }
    } finally {
      OpenAIProvider.complete = originalOpenAI;
      GeminiProvider.complete = originalGemini;
    }
    expect(seen).toEqual(['sk-legacy-openai', 'sk-current-gemini']);
  });
});

// ── 2.8 timeout independent of settlement ──

describe('WS2 2.8 request timeout', () => {
  test('rejects with AITimeoutError even if the operation never settles', async () => {
    let providerSignal;
    const started = Date.now();
    const error = await runAbortableAttempt((signal) => {
      providerSignal = signal;
      return new Promise(() => {});
    }, 5, null, { cleanupGraceMs: 10 }).catch((reason) => reason);
    expect(error).toBeInstanceOf(AITimeoutError);
    expect(providerSignal.aborted).toBeTrue();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a cooperative provider still settles before the grace deadline', async () => {
    let cleaned = false;
    const error = await runAbortableAttempt((signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        cleaned = true;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }), 5, null, { cleanupGraceMs: 1_000 }).catch((reason) => reason);
    expect(error).toBeInstanceOf(AITimeoutError);
    expect(cleaned).toBeTrue();
  });

  test('validates cleanupGraceMs', () => {
    expect(() => runAbortableAttempt(async () => {}, 5, null, { cleanupGraceMs: -1 }))
      .toThrow(RangeError);
  });
});

// ── 2.9 cache serialization ──

describe('WS2 2.9 AI cache', () => {
  test('concurrent sets do not lose entries', async () => {
    installChromeMock();
    await AICache.clear();
    const keys = Array.from({ length: 20 }, (_, index) => `ws2-key-${index}`);
    await Promise.all(keys.map((key) => AICache.set(key, { text: key, parsed: null })));
    expect(await AICache.size()).toBe(20);
    for (const key of keys) {
      expect(await AICache.get(key)).toEqual({ text: key, parsed: null });
    }
  });

  test('a fresh cache hit does not rewrite storage', async () => {
    const harness = installChromeMock();
    await AICache.set('ws2-hit', { text: 'hit', parsed: null });
    const writesBefore = harness.calls.storage.local.set.length;
    for (let i = 0; i < 5; i++) {
      expect(await AICache.get('ws2-hit')).toEqual({ text: 'hit', parsed: null });
    }
    expect(harness.calls.storage.local.set.length).toBe(writesBefore);
    expect(Object.keys((await readStorageArea('local')).aiCache)).toEqual(['ws2-hit']);
  });

  test('a stale-touched entry gets its access time refreshed', async () => {
    installChromeMock();
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    await chrome.storage.local.set({
      aiCache: { old: { response: { text: 'x' }, timestamp: twoHoursAgo, accessedAt: twoHoursAgo } },
    });
    expect(await AICache.get('old')).toEqual({ text: 'x' });
    const stored = (await chrome.storage.local.get('aiCache')).aiCache.old;
    expect(stored.accessedAt).toBeGreaterThan(twoHoursAgo);
  });

  test('a clear queued behind a set is not undone by it', async () => {
    installChromeMock();
    const setPromise = AICache.set('ws2-race', { text: 'race' });
    const clearPromise = AICache.clear();
    await Promise.all([setPromise, clearPromise]);
    expect(await AICache.size()).toBe(0);
  });
});
