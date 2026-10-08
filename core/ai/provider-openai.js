// core/ai/provider-openai.js — OpenAI API provider implementation

import {
  AIAbortError, AIAuthError, AIRateLimitError, AINetworkError, providerHttpError,
  PROVIDER_DEFAULTS, ProviderId,
} from './provider.js';

const BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = PROVIDER_DEFAULTS[ProviderId.OPENAI].model;
// Reasoning tokens count against max_completion_tokens; leave room for them so
// a short JSON answer is not starved.
const REASONING_MIN_COMPLETION_TOKENS = 4096;

function ensureNotAborted(signal) {
  if (signal?.aborted) throw new AIAbortError();
}

function rethrowAbort(error, signal) {
  if (signal?.aborted) throw new AIAbortError();
  if (error instanceof AIAbortError) throw error;
  if (error?.name === 'AbortError') throw new AIAbortError();
}

async function abortAware(operation, signal) {
  ensureNotAborted(signal);
  try {
    const result = await operation();
    ensureNotAborted(signal);
    return result;
  } catch (error) {
    rethrowAbort(error, signal);
    throw error;
  }
}

async function readErrorText(response, signal) {
  try {
    return await abortAware(() => response.text(), signal);
  } catch (error) {
    rethrowAbort(error, signal);
    return '';
  }
}

function normalizeOpenAIModelId(model) {
  return model.trim().toLowerCase().replace(/^openai\//, '');
}

/**
 * o-series and gpt-5+ (gpt-5, gpt-5.x, gpt-6, gpt-6.x, ...) reasoning models
 * reject `max_tokens` and any non-default `temperature` on Chat Completions.
 * The `-chat` variants (gpt-5-chat-latest, ...) are non-reasoning chat models.
 */
export function isOpenAIReasoningModel(model) {
  if (typeof model !== 'string') return false;
  const id = normalizeOpenAIModelId(model);
  if (/^o\d/.test(id)) return true;
  if (/-chat(?:$|-)/.test(id)) return false;
  const match = /^gpt-(\d+)(?=$|[.-])/.exec(id);
  return Boolean(match) && Number(match[1]) >= 5;
}

/**
 * Reasoning effort to request for our short classification calls. `low` is
 * accepted across o-series, gpt-5.x and gpt-6.x; `-pro` variants only accept
 * their own default, so they are left alone.
 */
export function openAIReasoningEffort(model) {
  if (!isOpenAIReasoningModel(model)) return null;
  if (/-pro(?:$|-)/.test(normalizeOpenAIModelId(model))) return null;
  return 'low';
}

function applyTokenLimit(body, model, maxTokens) {
  if (isOpenAIReasoningModel(model)) {
    body.max_completion_tokens = Math.max(maxTokens, REASONING_MIN_COMPLETION_TOKENS);
    const effort = openAIReasoningEffort(model);
    if (effort) body.reasoning_effort = effort;
  } else {
    body.max_tokens = maxTokens;
  }
}

export const OpenAIProvider = {
  id: 'openai',
  name: 'OpenAI',

  async testConnection(config, signal) {
    ensureNotAborted(signal);
    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify((() => {
          const model = config.model || DEFAULT_MODEL;
          const testBody = {
            model,
            messages: [{ role: 'user', content: 'Reply with the word "ok".' }],
          };
          // Reasoning models spend hidden tokens before answering; applyTokenLimit
          // raises the cap for them.
          applyTokenLimit(testBody, model, 5);
          return testBody;
        })()),
        signal,
      });
      ensureNotAborted(signal);

      if (response.status === 401 || response.status === 403) return false;
      return response.ok;
    } catch (error) {
      rethrowAbort(error, signal);
      return false;
    }
  },

  async complete(request, config, signal) {
    ensureNotAborted(signal);
    const messages = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.userPrompt });

    const model = config.model || DEFAULT_MODEL;
    const body = { model, messages };
    applyTokenLimit(body, model, request.maxTokens || 1024);
    if (!isOpenAIReasoningModel(model)) {
      body.temperature = request.temperature ?? 0.3;
    }

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    let response;
    try {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      ensureNotAborted(signal);
    } catch (err) {
      rethrowAbort(err, signal);
      throw new AINetworkError(`Network error: ${err.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AIAuthError('Invalid OpenAI API key');
    }
    if (response.status === 429) {
      throw new AIRateLimitError('OpenAI rate limit exceeded');
    }
    if (!response.ok) {
      const text = await readErrorText(response, signal);
      throw providerHttpError('OpenAI', response.status, text);
    }

    const data = await abortAware(() => response.json(), signal);
    const text = data.choices?.[0]?.message?.content || '';
    const tokensUsed = (data.usage?.total_tokens) || 0;

    let parsed = null;
    if (request.responseFormat === 'json') {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Response wasn't valid JSON despite requesting it
      }
    }

    return { text, parsed, tokensUsed };
  },

  /**
   * List available OpenAI models (chat completions only).
   * @param {Object} config - { apiKey }
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async listModels(config, signal) {
    ensureNotAborted(signal);
    try {
      const response = await fetch(`${BASE_URL}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${config.apiKey}` },
        signal,
      });
      ensureNotAborted(signal);
      if (!response.ok) return [];

      const data = await abortAware(() => response.json(), signal);
      return (data.data || [])
        .filter(m => {
          const id = m.id;
          // Keep chat/completion models; exclude embeddings, tts, whisper, dall-e, moderation, image
          if (id.includes('embedding') || id.includes('tts') || id.includes('whisper')) return false;
          if (id.includes('dall-e') || id.includes('moderation') || id.includes('realtime')) return false;
          if (id.includes('image') || id.includes('audio') || id.includes('transcri')) return false;
          if (id.includes('codex') && id.includes('-5')) return false; // Codex agents, not chat
          return true;
        })
        .map(m => ({ id: m.id, name: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) {
      rethrowAbort(error, signal);
      return [];
    }
  },
};
