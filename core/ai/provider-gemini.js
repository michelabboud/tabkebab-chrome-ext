// core/ai/provider-gemini.js — Google Gemini API provider implementation

import { AIAuthError, AIRateLimitError, AINetworkError } from './provider.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export const GeminiProvider = {
  id: 'gemini',
  name: 'Google Gemini',

  async testConnection(config) {
    try {
      const url = `${BASE_URL}/models/${config.model || 'gemini-2.5-flash'}:generateContent`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Reply with the word "ok".' }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
      });

      if (response.status === 401 || response.status === 403) return false;
      return response.ok;
    } catch {
      return false;
    }
  },

  async complete(request, config) {
    const model = config.model || 'gemini-2.5-flash';
    const url = `${BASE_URL}/models/${model}:generateContent`;

    const contents = [];

    // Gemini uses systemInstruction for system prompts
    const body = {
      contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
      generationConfig: {
        maxOutputTokens: request.maxTokens || 1024,
        temperature: request.temperature ?? 0.3,
      },
    };

    if (request.systemPrompt) {
      body.systemInstruction = { parts: [{ text: request.systemPrompt }] };
    }

    if (request.responseFormat === 'json') {
      body.generationConfig.responseMimeType = 'application/json';
    }

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AINetworkError(`Network error: ${err.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AIAuthError('Invalid Gemini API key');
    }
    if (response.status === 429) {
      throw new AIRateLimitError('Gemini rate limit exceeded');
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new AINetworkError(`Gemini API error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const tokensUsed = (data.usageMetadata?.totalTokenCount) || 0;

    let parsed = null;
    if (request.responseFormat === 'json') {
      try {
        // Strip markdown code fences if present
        const cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        // Response wasn't valid JSON despite requesting it
      }
    }

    return { text, parsed, tokensUsed };
  },

  /**
   * List available Gemini models (text generation only).
   * @param {Object} config - { apiKey }
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async listModels(config) {
    try {
      const response = await fetch(`${BASE_URL}/models?key=${encodeURIComponent(config.apiKey)}`, {
        method: 'GET',
      });
      if (!response.ok) return [];

      const data = await response.json();
      return (data.models || [])
        .filter(m =>
          m.supportedGenerationMethods?.includes('generateContent') &&
          !m.name.includes('image') &&
          !m.name.includes('embedding') &&
          !m.name.includes('aqa')
        )
        .map(m => ({
          id: m.name.replace('models/', ''),
          name: m.displayName || m.name.replace('models/', ''),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      return [];
    }
  },
};
