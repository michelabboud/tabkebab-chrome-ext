// core/ai/provider-chrome.js — Chrome built-in Prompt API provider
// Uses the LanguageModel global (Chrome 138+ origin trial)
// Falls back to self.ai.languageModel for older Chrome versions

import { AINetworkError } from './provider.js';

/**
 * Get the LanguageModel API, supporting both new global and legacy namespace.
 */
function getLanguageModelAPI() {
  if (typeof LanguageModel !== 'undefined') return LanguageModel;
  if (typeof self !== 'undefined' && self.ai?.languageModel) return self.ai.languageModel;
  return null;
}

export const ChromeAIProvider = {
  id: 'chrome-ai',
  name: 'Chrome Built-in AI (Experimental)',

  async testConnection(_config) {
    try {
      const api = getLanguageModelAPI();
      if (!api) return false;

      // New API uses availability(), legacy uses capabilities()
      if (typeof api.availability === 'function') {
        const status = await api.availability();
        return status === 'available' || status === 'downloadable';
      }
      if (typeof api.capabilities === 'function') {
        const caps = await api.capabilities();
        return caps.available === 'readily' || caps.available === 'after-download';
      }
      return false;
    } catch {
      return false;
    }
  },

  async complete(request, _config) {
    const api = getLanguageModelAPI();
    if (!api) {
      throw new AINetworkError('Chrome Built-in AI is not available. Requires Chrome 138+ with the Prompt API origin trial enabled.');
    }

    let session;
    try {
      const options = {};
      if (request.systemPrompt) {
        options.systemPrompt = request.systemPrompt;
      }
      // Chrome AI requires both topK and temperature, or neither
      if (request.temperature != null) {
        options.temperature = request.temperature;
        options.topK = 40; // reasonable default
      }

      session = await api.create(options);
      const text = await session.prompt(request.userPrompt);

      // Approximate token count (no exact count available from Chrome AI)
      const tokensUsed = Math.ceil((request.userPrompt.length + text.length) / 4);

      let parsed = null;
      if (request.responseFormat === 'json') {
        try {
          const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
          parsed = JSON.parse(cleaned);
        } catch {
          // Response wasn't valid JSON
        }
      }

      return { text, parsed, tokensUsed };
    } catch (err) {
      throw new AINetworkError(`Chrome AI error: ${err.message}`);
    } finally {
      if (session) {
        try { session.destroy(); } catch { /* ignore */ }
      }
    }
  },
};
