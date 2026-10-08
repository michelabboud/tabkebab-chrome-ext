// core/ai/provider-claude.js — Anthropic Claude API provider implementation

import {
  AIAbortError, AIAuthError, AIRateLimitError, AINetworkError, providerHttpError,
  PROVIDER_DEFAULTS, ProviderId,
} from './provider.js';

const BASE_URL = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = PROVIDER_DEFAULTS[ProviderId.CLAUDE].model;
// Thinking (on by default on current models) counts against max_tokens; keep
// enough headroom that it cannot truncate the JSON answer.
const THINKING_MIN_MAX_TOKENS = 4096;

/**
 * Request traits per Claude model family.
 * - Current models (Haiku/Sonnet/Opus 5+, Opus 4.7/4.8, Fable, Mythos) reject
 *   non-default sampling parameters (temperature/top_p) with a 400, think by
 *   default, and take `output_config.effort` to control thinking depth.
 * - Opus 4.6 / Sonnet 4.6 accept temperature and effort; thinking is off unless
 *   requested.
 * - Haiku 4.5, Sonnet 4.5 and older accept temperature; effort errors on
 *   Sonnet/Haiku 4.5, so it is not sent.
 * We never send `thinking` (budget_tokens 400s on current models) and never
 * prefill the assistant turn (400 on 4.6+).
 */
export function claudeModelTraits(model) {
  const id = typeof model === 'string' ? model.trim().toLowerCase() : '';
  let current = /^claude-(fable|mythos)\b/.test(id) || /^claude-opus-4-[78](?=$|-)/.test(id);
  const versioned = /^claude-(?:opus|sonnet|haiku)-(\d+)(?=$|-)/.exec(id);
  if (versioned && Number(versioned[1]) >= 5) current = true;
  const gen46 = /^claude-(?:opus|sonnet)-4-6(?=$|-)/.test(id);
  return {
    acceptsTemperature: !current,
    effort: current || gen46 ? 'low' : null,
    thinksByDefault: current,
  };
}

/** Joins the text blocks of a Messages API response, skipping thinking blocks. */
export function extractClaudeText(data) {
  const blocks = data?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function buildMessagesBody(model, { maxTokens, userContent, system, temperature }) {
  const traits = claudeModelTraits(model);
  const body = {
    model,
    max_tokens: traits.thinksByDefault ? Math.max(maxTokens, THINKING_MIN_MAX_TOKENS) : maxTokens,
    messages: [{ role: 'user', content: userContent }],
  };
  if (system) body.system = system;
  if (traits.acceptsTemperature && temperature != null) body.temperature = temperature;
  if (traits.effort) body.output_config = { effort: traits.effort };
  return body;
}

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

export const ClaudeProvider = {
  id: 'claude',
  name: 'Claude (Anthropic)',

  async testConnection(config, signal) {
    ensureNotAborted(signal);
    try {
      const response = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(buildMessagesBody(config.model || DEFAULT_MODEL, {
          maxTokens: 10,
          userContent: 'Reply with the word "ok".',
        })),
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
    let systemPrompt = request.systemPrompt || '';
    if (request.responseFormat === 'json') {
      systemPrompt += '\n\nRespond ONLY with valid JSON. No markdown, no explanation.';
    }

    const body = buildMessagesBody(config.model || DEFAULT_MODEL, {
      maxTokens: request.maxTokens || 1024,
      userContent: request.userPrompt,
      system: systemPrompt,
      temperature: request.temperature,
    });

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
        signal,
      });
      ensureNotAborted(signal);
    } catch (err) {
      rethrowAbort(err, signal);
      throw new AINetworkError(`Network error: ${err.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AIAuthError('Invalid Anthropic API key');
    }
    if (response.status === 429) {
      throw new AIRateLimitError('Anthropic rate limit exceeded');
    }
    if (!response.ok) {
      const errText = await readErrorText(response, signal);
      throw providerHttpError('Anthropic', response.status, errText);
    }

    const data = await abortAware(() => response.json(), signal);
    const text = extractClaudeText(data);
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
  async listModels(config, signal) {
    ensureNotAborted(signal);
    // Try the API endpoint first
    try {
      const response = await fetch(`${BASE_URL}/models`, {
        method: 'GET',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        signal,
      });
      ensureNotAborted(signal);
      if (response.ok) {
        const data = await abortAware(() => response.json(), signal);
        if (data.data?.length > 0) {
          return data.data
            .filter(m => m.type === 'model')
            .map(m => ({ id: m.id, name: m.display_name || m.id }))
            .sort((a, b) => a.id.localeCompare(b.id));
        }
      }
    } catch (error) {
      rethrowAbort(error, signal);
      // Fall through to hardcoded list
    }

    // Hardcoded fallback — current models as of Oct 2026
    return [
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
    ];
  },
};
