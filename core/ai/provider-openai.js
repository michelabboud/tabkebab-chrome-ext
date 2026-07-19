// core/ai/provider-openai.js — OpenAI API provider implementation

import { AIAbortError, AIAuthError, AIRateLimitError, AINetworkError } from './provider.js';

const BASE_URL = 'https://api.openai.com/v1';

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
        body: JSON.stringify({
          model: config.model || 'gpt-4.1-nano',
          messages: [{ role: 'user', content: 'Reply with the word "ok".' }],
          max_tokens: 5,
        }),
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

    const body = {
      model: config.model || 'gpt-4.1-nano',
      messages,
      max_tokens: request.maxTokens || 1024,
      temperature: request.temperature ?? 0.3,
    };

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
      throw new AINetworkError(`OpenAI API error ${response.status}: ${text.slice(0, 200)}`);
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
