// core/ai/provider-claude.js — Anthropic Claude API provider implementation

import { AIAuthError, AIRateLimitError, AINetworkError } from './provider.js';

const BASE_URL = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

export const ClaudeProvider = {
  id: 'claude',
  name: 'Claude (Anthropic)',

  async testConnection(config) {
    try {
      const response = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: config.model || 'claude-haiku-4-5',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Reply with the word "ok".' }],
        }),
      });

      if (response.status === 401 || response.status === 403) return false;
      return response.ok;
    } catch {
      return false;
    }
  },

  async complete(request, config) {
    let systemPrompt = request.systemPrompt || '';
    if (request.responseFormat === 'json') {
      systemPrompt += '\n\nRespond ONLY with valid JSON. No markdown, no explanation.';
    }

    const body = {
      model: config.model || 'claude-haiku-4-5',
      max_tokens: request.maxTokens || 1024,
      messages: [{ role: 'user', content: request.userPrompt }],
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    // Anthropic doesn't have a temperature=0 but supports 0.0-1.0
    if (request.temperature != null) {
      body.temperature = request.temperature;
    }

    let response;
    try {
      response = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AINetworkError(`Network error: ${err.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AIAuthError('Invalid Anthropic API key');
    }
    if (response.status === 429) {
      throw new AIRateLimitError('Anthropic rate limit exceeded');
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new AINetworkError(`Anthropic API error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

    let parsed = null;
    if (request.responseFormat === 'json') {
      try {
        // Claude sometimes wraps JSON in markdown code blocks
        const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        // Response wasn't valid JSON
      }
    }

    return { text, parsed, tokensUsed };
  },

  /**
   * List available Claude models.
   * Anthropic has a /v1/models endpoint (requires API key).
   * Falls back to a hardcoded list on failure.
   */
  async listModels(config) {
    // Try the API endpoint first
    try {
      const response = await fetch(`${BASE_URL}/models`, {
        method: 'GET',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      });
      if (response.ok) {
        const data = await response.json();
        if (data.data?.length > 0) {
          return data.data
            .filter(m => m.type === 'model')
            .map(m => ({ id: m.id, name: m.display_name || m.id }))
            .sort((a, b) => a.id.localeCompare(b.id));
        }
      }
    } catch {
      // Fall through to hardcoded list
    }

    // Hardcoded fallback — current models as of Jan 2026
    return [
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    ];
  },
};
