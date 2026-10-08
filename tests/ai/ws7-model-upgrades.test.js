import { afterEach, describe, expect, test } from 'bun:test';

import { AIClient } from '../../core/ai/ai-client.js';
import {
  ClaudeProvider,
  claudeModelTraits,
  extractClaudeText,
} from '../../core/ai/provider-claude.js';
import {
  GeminiProvider,
  geminiAcceptsTemperatureOverride,
  geminiThinkingConfig,
} from '../../core/ai/provider-gemini.js';
import {
  OpenAIProvider,
  isOpenAIReasoningModel,
  openAIReasoningEffort,
} from '../../core/ai/provider-openai.js';
import {
  PROVIDER_DEFAULTS,
  RETIRED_MODELS,
  migrateRetiredModel,
} from '../../core/ai/provider.js';
import { installChromeMock } from '../helpers/chrome-mock.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureFetch(responseBody) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return requests;
}

const OPENAI_OK = { choices: [{ message: { content: '{"a":1}' } }], usage: { total_tokens: 1 } };
const CLAUDE_OK = { content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 1, output_tokens: 1 } };
const GEMINI_OK = { candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }], usageMetadata: { totalTokenCount: 1 } };

describe('WS7 provider defaults', () => {
  test('defaults point at current low-cost models', () => {
    expect(PROVIDER_DEFAULTS.openai.model).toBe('gpt-6-luna');
    expect(PROVIDER_DEFAULTS.claude.model).toBe('claude-haiku-5-5');
    expect(PROVIDER_DEFAULTS.gemini.model).toBe('gemini-3.8-flash');
  });

  test('providers fall back to the shared default when no model is configured', async () => {
    let requests = captureFetch(OPENAI_OK);
    await OpenAIProvider.complete({ userPrompt: 'hi' }, { apiKey: 'k' });
    expect(requests[0].body.model).toBe('gpt-6-luna');

    requests = captureFetch(CLAUDE_OK);
    await ClaudeProvider.complete({ userPrompt: 'hi' }, { apiKey: 'k' });
    expect(requests[0].body.model).toBe('claude-haiku-5-5');

    requests = captureFetch(GEMINI_OK);
    await GeminiProvider.complete({ userPrompt: 'hi' }, { apiKey: 'k' });
    expect(requests[0].url).toContain('/models/gemini-3.8-flash:generateContent');
  });

  test('Claude fallback model list drops deprecated dated IDs', async () => {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const ids = (await ClaudeProvider.listModels({ apiKey: 'k' })).map((m) => m.id);
    expect(ids).toContain('claude-haiku-5-5');
    expect(ids).toContain('claude-sonnet-5-5');
    expect(ids).toContain('claude-opus-5-5');
    expect(ids.some((id) => id.endsWith('-20250514'))).toBeFalse();
  });
});

describe('WS7 OpenAI request bodies', () => {
  test('recognises gpt-5.x / gpt-6.x / o-series as reasoning models', () => {
    for (const model of ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.4-mini', 'gpt-5-nano', 'o3']) {
      expect(isOpenAIReasoningModel(model)).toBeTrue();
    }
    for (const model of ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-50x', 'gpt-oss-20b']) {
      expect(isOpenAIReasoningModel(model)).toBeFalse();
    }
  });

  test('-chat variants of gpt-5+ are not reasoning models', () => {
    for (const model of ['gpt-5-chat-latest', 'gpt-5-chat', 'gpt-5.1-chat-latest', 'openai/gpt-6-chat-latest']) {
      expect(isOpenAIReasoningModel(model)).toBeFalse();
      expect(openAIReasoningEffort(model)).toBeNull();
    }
  });

  test('reasoning effort is low except for non-reasoning and -pro models', () => {
    expect(openAIReasoningEffort('gpt-6-luna')).toBe('low');
    expect(openAIReasoningEffort('o3')).toBe('low');
    expect(openAIReasoningEffort('gpt-5-pro')).toBeNull();
    expect(openAIReasoningEffort('gpt-4.1')).toBeNull();
  });

  test('gpt-6-luna omits temperature and max_tokens, sends effort and a roomy budget', async () => {
    const requests = captureFetch(OPENAI_OK);
    await OpenAIProvider.complete(
      { userPrompt: 'hi', maxTokens: 512, temperature: 0.2, responseFormat: 'json' },
      { apiKey: 'k', model: 'gpt-6-luna' },
    );
    const body = requests[0].body;
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(4096);
    expect(body.reasoning_effort).toBe('low');
  });

  test('gpt-4.1 keeps temperature and max_tokens with no effort', async () => {
    const requests = captureFetch(OPENAI_OK);
    await OpenAIProvider.complete(
      { userPrompt: 'hi', maxTokens: 512, temperature: 0.2 },
      { apiKey: 'k', model: 'gpt-4.1' },
    );
    expect(requests[0].body).toMatchObject({ max_tokens: 512, temperature: 0.2 });
    expect(requests[0].body.reasoning_effort).toBeUndefined();
  });

  test('testConnection gives reasoning models room to answer', async () => {
    const requests = captureFetch(OPENAI_OK);
    expect(await OpenAIProvider.testConnection({ apiKey: 'k', model: 'gpt-6-luna' })).toBeTrue();
    expect(requests[0].body.max_completion_tokens).toBeGreaterThanOrEqual(4096);
    expect(requests[0].body.max_tokens).toBeUndefined();
  });
});

describe('WS7 Claude request bodies', () => {
  test('model traits per family', () => {
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1']) {
      expect(claudeModelTraits(model)).toEqual({ acceptsTemperature: false, effort: 'low', thinksByDefault: true });
    }
    expect(claudeModelTraits('claude-sonnet-4-6')).toEqual({ acceptsTemperature: true, effort: 'low', thinksByDefault: false });
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5']) {
      expect(claudeModelTraits(model)).toEqual({ acceptsTemperature: true, effort: null, thinksByDefault: false });
    }
  });

  test('Haiku 5.5: no temperature, no thinking param, no prefill, effort low, max_tokens >= 4096', async () => {
    const requests = captureFetch(CLAUDE_OK);
    const result = await ClaudeProvider.complete(
      { systemPrompt: 'sys', userPrompt: 'hi', maxTokens: 512, temperature: 0.2, responseFormat: 'json' },
      { apiKey: 'k', model: 'claude-haiku-5-5' },
    );
    const body = requests[0].body;
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(requests[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(result.parsed).toEqual({ a: 1 });
  });

  test('Haiku 4.5 keeps temperature and sends no effort', async () => {
    const requests = captureFetch(CLAUDE_OK);
    await ClaudeProvider.complete(
      { userPrompt: 'hi', maxTokens: 512, temperature: 0.2 },
      { apiKey: 'k', model: 'claude-haiku-4-5' },
    );
    expect(requests[0].body).toMatchObject({ max_tokens: 512, temperature: 0.2 });
    expect(requests[0].body.output_config).toBeUndefined();
    expect(requests[0].body.thinking).toBeUndefined();
  });

  test('testConnection on a 5.x model leaves room for thinking', async () => {
    const requests = captureFetch(CLAUDE_OK);
    expect(await ClaudeProvider.testConnection({ apiKey: 'k', model: 'claude-haiku-5-5' })).toBeTrue();
    expect(requests[0].body.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(requests[0].body.output_config).toEqual({ effort: 'low' });
  });

  test('text extraction skips leading thinking blocks', async () => {
    expect(extractClaudeText({
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: '{"groups":' },
        { type: 'text', text: '[]}' },
      ],
    })).toBe('{"groups":[]}');
    expect(extractClaudeText({})).toBe('');

    captureFetch({
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const result = await ClaudeProvider.complete(
      { userPrompt: 'hi', responseFormat: 'json' },
      { apiKey: 'k', model: 'claude-haiku-5-5' },
    );
    expect(result).toEqual({ text: '{"ok":true}', parsed: { ok: true }, tokensUsed: 3 });
  });
});

describe('WS7 Gemini request bodies', () => {
  test('thinking config per family', () => {
    expect(geminiThinkingConfig('gemini-3.8-flash')).toEqual({ thinkingLevel: 'low' });
    expect(geminiThinkingConfig('gemini-3.7-flash')).toEqual({ thinkingLevel: 'low' });
    expect(geminiThinkingConfig('gemini-3.1-pro-preview')).toEqual({ thinkingLevel: 'low' });
    expect(geminiThinkingConfig('models/gemini-3-flash-preview')).toEqual({ thinkingLevel: 'low' });
    expect(geminiThinkingConfig('gemini-3.5-flash-lite')).toBeNull();
    expect(geminiThinkingConfig('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig('gemini-2.5-pro')).toBeNull();
  });

  test('3.x request: thinkingLevel low, no thinkingBudget, no temperature, roomy budget', async () => {
    const requests = captureFetch(GEMINI_OK);
    await GeminiProvider.complete(
      { userPrompt: 'hi', maxTokens: 512, temperature: 0.2, responseFormat: 'json' },
      { apiKey: 'k', model: 'gemini-3.8-flash' },
    );
    const config = requests[0].body.generationConfig;
    expect(config.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(config.temperature).toBeUndefined();
    expect(config.maxOutputTokens).toBeGreaterThanOrEqual(4096);
    expect(config.responseMimeType).toBe('application/json');
  });

  test('2.5 flash keeps thinkingBudget 0, temperature and the requested budget', async () => {
    const requests = captureFetch(GEMINI_OK);
    await GeminiProvider.complete(
      { userPrompt: 'hi', maxTokens: 512, temperature: 0.2 },
      { apiKey: 'k', model: 'gemini-2.5-flash' },
    );
    expect(requests[0].body.generationConfig).toEqual({
      maxOutputTokens: 512,
      temperature: 0.2,
      thinkingConfig: { thinkingBudget: 0 },
    });
    expect(geminiAcceptsTemperatureOverride('gemini-2.5-flash')).toBeTrue();
    expect(geminiAcceptsTemperatureOverride('gemini-3.8-flash')).toBeFalse();
  });

  test('testConnection on 3.x leaves room for thinking', async () => {
    const requests = captureFetch(GEMINI_OK);
    expect(await GeminiProvider.testConnection({ apiKey: 'k', model: 'gemini-3.8-flash' })).toBeTrue();
    expect(requests[0].body.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(4096);
    expect(requests[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  test('response text skips thought parts', async () => {
    captureFetch({
      candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"ok":true}' }] } }],
      usageMetadata: { totalTokenCount: 4 },
    });
    const result = await GeminiProvider.complete(
      { userPrompt: 'hi', responseFormat: 'json' },
      { apiKey: 'k', model: 'gemini-3.8-flash' },
    );
    expect(result).toEqual({ text: '{"ok":true}', parsed: { ok: true }, tokensUsed: 4 });
  });
});

describe('WS7 saved-settings migration', () => {
  test('retired IDs map to the provider default; everything else is untouched', () => {
    expect(migrateRetiredModel('openai', 'gpt-4.1-nano')).toBe('gpt-6-luna');
    expect(migrateRetiredModel('claude', 'claude-opus-4-20250514')).toBe('claude-haiku-5-5');
    expect(migrateRetiredModel('claude', 'claude-sonnet-4-20250514')).toBe('claude-haiku-5-5');
    expect(migrateRetiredModel('gemini', 'gemini-3-pro-preview')).toBe('gemini-3.8-flash');

    expect(migrateRetiredModel('openai', 'gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(migrateRetiredModel('claude', 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(migrateRetiredModel('gemini', 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(migrateRetiredModel('custom', 'gpt-4.1-nano')).toBe('gpt-4.1-nano');
    expect(RETIRED_MODELS.gemini).not.toContain('gemini-2.5-flash');
  });

  test('AIClient.getPublicSettings migrates stored retired models on load', async () => {
    installChromeMock();
    await chrome.storage.local.set({
      aiSettings: {
        enabled: true,
        providerId: 'claude',
        providerConfigs: {
          openai: { model: 'gpt-4.1-nano' },
          claude: { model: 'claude-sonnet-4-20250514' },
          gemini: { model: 'gemini-3-pro-preview' },
          'chrome-ai': { model: 'default' },
          custom: { model: 'gpt-4.1-nano', baseUrl: 'http://localhost:11434/v1' },
        },
      },
    });
    const settings = await AIClient.getPublicSettings();
    expect(settings.providerConfigs.openai.model).toBe('gpt-6-luna');
    expect(settings.providerConfigs.claude.model).toBe('claude-haiku-5-5');
    expect(settings.providerConfigs.gemini.model).toBe('gemini-3.8-flash');
    // Custom endpoints may legitimately serve any model name.
    expect(settings.providerConfigs.custom.model).toBe('gpt-4.1-nano');
  });

  test('AIClient.getPublicSettings keeps non-retired user choices', async () => {
    installChromeMock();
    await chrome.storage.local.set({
      aiSettings: {
        enabled: true,
        providerId: 'gemini',
        providerConfigs: {
          openai: { model: 'gpt-4.1' },
          claude: { model: 'claude-opus-4-5' },
          gemini: { model: 'gemini-2.5-pro' },
          'chrome-ai': { model: 'default' },
          custom: { model: 'llama', baseUrl: 'http://localhost:11434/v1' },
        },
      },
    });
    const settings = await AIClient.getPublicSettings();
    expect(settings.providerConfigs.openai.model).toBe('gpt-4.1');
    expect(settings.providerConfigs.claude.model).toBe('claude-opus-4-5');
    expect(settings.providerConfigs.gemini.model).toBe('gemini-2.5-pro');
  });
});
