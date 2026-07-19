// core/ai/provider-chrome.js — Chrome built-in Prompt API provider
// Uses the LanguageModel global (Chrome 138+ for extensions)
// Falls back to self.ai.languageModel for older Chrome versions

import { AIAbortError, AIUnavailableError } from './provider.js';

/**
 * Get the LanguageModel API, supporting both new global and legacy namespace.
 */
function getLanguageModelAPI() {
  if (typeof LanguageModel !== 'undefined') return LanguageModel;
  if (typeof self !== 'undefined' && self.ai?.languageModel) return self.ai.languageModel;
  return null;
}

function ensureNotAborted(signal) {
  if (signal?.aborted) throw new AIAbortError();
}

function rethrowAbort(error, signal) {
  if (signal?.aborted) throw new AIAbortError();
  if (error instanceof AIAbortError) throw error;
  if (error?.name === 'AbortError') throw new AIAbortError();
}

async function requireAvailable(api, signal) {
  ensureNotAborted(signal);
  let status;
  try {
    if (typeof api.availability === 'function') {
      status = await api.availability();
    } else if (typeof api.capabilities === 'function') {
      const capabilities = await api.capabilities();
      status = capabilities?.available === 'readily'
        ? 'available'
        : capabilities?.available;
    }
    ensureNotAborted(signal);
  } catch (error) {
    rethrowAbort(error, signal);
    throw new AIUnavailableError('Chrome AI availability could not be determined.');
  }

  if (status === 'available') return;
  if (status === 'downloadable' || status === 'downloading' || status === 'after-download') {
    throw new AIUnavailableError('Chrome AI model must be downloaded before use.');
  }
  throw new AIUnavailableError('Chrome AI model is not available on this device.');
}

export class ChromeAIProvider {
  static id = 'chrome-ai';
  static name = 'Chrome Built-in AI (Experimental)';

  id = ChromeAIProvider.id;
  name = ChromeAIProvider.name;

  // Keep the Task 13 object-style entry points compatible while the side-panel
  // broker creates a fresh executor instance for each accepted request.
  static testConnection(config, signal) {
    return new ChromeAIProvider().testConnection(config, signal);
  }

  static complete(request, config, signal) {
    return new ChromeAIProvider().complete(request, config, signal);
  }

  async testConnection(_config, signal) {
    ensureNotAborted(signal);
    try {
      const api = getLanguageModelAPI();
      if (!api) return false;

      await requireAvailable(api, signal);
      return true;
    } catch (error) {
      rethrowAbort(error, signal);
      return false;
    }
  }

  async complete(request, _config, signal) {
    ensureNotAborted(signal);
    const api = getLanguageModelAPI();
    if (!api) {
      throw new AIUnavailableError('Chrome Built-in AI is not available on this device.');
    }

    await requireAvailable(api, signal);

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
      if (signal !== undefined) options.signal = signal;

      session = await api.create(options);
      ensureNotAborted(signal);
      const text = signal === undefined
        ? await session.prompt(request.userPrompt)
        : await session.prompt(request.userPrompt, { signal });
      ensureNotAborted(signal);

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
      rethrowAbort(err, signal);
      // Chrome Prompt API failures are local provider failures, not network
      // transport errors. Preserve the unknown type so the queue will not
      // automatically retry and overlap a potentially expensive local call.
      throw err;
    } finally {
      if (session && typeof session.destroy === 'function') {
        try { await session.destroy(); } catch { /* best-effort cleanup */ }
      }
    }
  }
}
