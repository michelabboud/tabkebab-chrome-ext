// core/ai/provider-gemini.js — Google Gemini API provider implementation

import {
  AIAbortError, AIAuthError, AIRateLimitError, AINetworkError, providerHttpError,
  PROVIDER_DEFAULTS, ProviderId,
} from './provider.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = PROVIDER_DEFAULTS[ProviderId.GEMINI].model;
// Thinking tokens count against maxOutputTokens. For models that think, keep
// enough headroom that reasoning cannot starve the JSON answer.
const THINKING_MIN_OUTPUT_TOKENS = 4096;

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

function normalizeGeminiModelId(model) {
  return model.trim().toLowerCase().replace(/^models\//, '');
}

/** Major version of a `gemini-N[.M]-...` model ID, or null. */
function geminiMajorVersion(id) {
  const match = /^gemini-(\d+)(?:\.\d+)?(?=$|-)/.exec(id);
  return match ? Number(match[1]) : null;
}

/**
 * Per-family thinking control for our short classification/JSON jobs.
 * - Gemini 2.5 Flash / Flash-Lite: thinking can be disabled -> thinkingBudget: 0.
 * - Gemini 2.5 Pro: cannot disable thinking; left at its default.
 * - Gemini 3+ (non-Lite): thinking cannot be fully disabled and the legacy
 *   thinkingBudget must not be combined with thinkingLevel; request the
 *   lowest level every 3.x Flash/Pro model accepts, "low".
 * - Gemini 3+ Flash-Lite: already defaults to minimal thinking; left alone.
 */
export function geminiThinkingConfig(model) {
  if (typeof model !== 'string') return null;
  const id = normalizeGeminiModelId(model);
  if (/^gemini-2\.5-flash/.test(id)) return { thinkingBudget: 0 };
  const major = geminiMajorVersion(id);
  if (major !== null && major >= 3) {
    if (/-flash-lite/.test(id)) return null;
    return { thinkingLevel: 'low' };
  }
  return null;
}

/** True when the model will spend output tokens on thinking with our config. */
export function geminiModelThinks(model) {
  if (typeof model !== 'string') return false;
  const id = normalizeGeminiModelId(model);
  if (/^gemini-2\.5-flash/.test(id)) return false;
  const major = geminiMajorVersion(id);
  return /^gemini-2\.5-pro/.test(id) || (major !== null && major >= 3);
}

/**
 * Gemini 3+ models are tuned for the default temperature (1.0); Google warns
 * lower values can cause looping, so we do not override it there.
 */
export function geminiAcceptsTemperatureOverride(model) {
  if (typeof model !== 'string') return true;
  const major = geminiMajorVersion(normalizeGeminiModelId(model));
  return major === null || major < 3;
}

function outputTokenBudget(model, requested) {
  return geminiModelThinks(model) ? Math.max(requested, THINKING_MIN_OUTPUT_TOKENS) : requested;
}

function withThinkingConfig(generationConfig, model) {
  const thinkingConfig = geminiThinkingConfig(model);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  return generationConfig;
}

/** Concatenates answer text, skipping any thought-summary parts. */
function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part && !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

export const GeminiProvider = {
  id: 'gemini',
  name: 'Google Gemini',

  async testConnection(config, signal) {
    ensureNotAborted(signal);
    try {
      const model = config.model || DEFAULT_MODEL;
      const url = `${BASE_URL}/models/${model}:generateContent`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Reply with the word "ok".' }] }],
          generationConfig: withThinkingConfig(
            { maxOutputTokens: outputTokenBudget(model, 5) },
            model,
          ),
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
    const model = config.model || DEFAULT_MODEL;
    const url = `${BASE_URL}/models/${model}:generateContent`;

    // Gemini uses systemInstruction for system prompts
    const body = {
      contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
      generationConfig: {
        maxOutputTokens: outputTokenBudget(model, request.maxTokens || 1024),
      },
    };

    if (geminiAcceptsTemperatureOverride(model)) {
      body.generationConfig.temperature = request.temperature ?? 0.3;
    }

    withThinkingConfig(body.generationConfig, model);

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
        signal,
      });
      ensureNotAborted(signal);
    } catch (err) {
      rethrowAbort(err, signal);
      throw new AINetworkError(`Network error: ${err.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AIAuthError('Invalid Gemini API key');
    }
    if (response.status === 429) {
      throw new AIRateLimitError('Gemini rate limit exceeded');
    }
    if (!response.ok) {
      const errText = await readErrorText(response, signal);
      throw providerHttpError('Gemini', response.status, errText);
    }

    const data = await abortAware(() => response.json(), signal);
    const text = extractGeminiText(data);
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
  async listModels(config, signal) {
    ensureNotAborted(signal);
    try {
      const response = await fetch(`${BASE_URL}/models`, {
        method: 'GET',
        headers: { 'x-goog-api-key': config.apiKey },
        signal,
      });
      ensureNotAborted(signal);
      if (!response.ok) return [];

      const data = await abortAware(() => response.json(), signal);
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
    } catch (error) {
      rethrowAbort(error, signal);
      return [];
    }
  },
};
