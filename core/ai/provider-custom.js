// core/ai/provider-custom.js — OpenAI-compatible custom provider
// Works with: Ollama, LM Studio, vLLM, LocalAI, Together AI, Groq, etc.

import { AIAuthError, AIRateLimitError, AINetworkError } from './provider.js';

export const CustomProvider = {
  id: 'custom',
  name: 'Custom (OpenAI-Compatible)',

  async testConnection(config) {
    const baseUrl = (config.baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model || 'default',
          messages: [{ role: 'user', content: 'Reply with the word "ok".' }],
          max_tokens: 5,
        }),
      });

      if (response.status === 401 || response.status === 403) return false;
      return response.ok;
    } catch {
      return false;
    }
  },

  async complete(request, config) {
    const baseUrl = (config.baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
    const model = config.model || 'default';

    const messages = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.userPrompt });

    const body = {
      model,
      messages,
      max_tokens: request.maxTokens || 1024,
      temperature: request.temperature ?? 0.3,
    };

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AINetworkError(`Network error: ${err.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AIAuthError('Authentication failed');
    }
    if (response.status === 429) {
      throw new AIRateLimitError('Rate limit exceeded');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AINetworkError(`API error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    const tokensUsed = (data.usage?.total_tokens) || 0;

    let parsed = null;
    if (request.responseFormat === 'json') {
      try {
        const cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        // Response wasn't valid JSON
      }
    }

    return { text, parsed, tokensUsed };
  },

  /**
   * List models from the custom endpoint.
   * @param {Object} config - { baseUrl, apiKey? }
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async listModels(config) {
    const baseUrl = (config.baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
    try {
      const headers = {};
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      const response = await fetch(`${baseUrl}/models`, { method: 'GET', headers });
      if (!response.ok) return [];

      const data = await response.json();
      return (data.data || [])
        .map(m => ({
          id: m.id,
          name: m.id,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      return [];
    }
  },
};
