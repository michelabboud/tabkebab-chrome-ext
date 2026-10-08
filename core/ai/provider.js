// core/ai/provider.js — Provider IDs, default models, and error classes

export const ProviderId = Object.freeze({
  OPENAI: 'openai',
  CLAUDE: 'claude',
  GEMINI: 'gemini',
  CHROME_AI: 'chrome-ai',
  CUSTOM: 'custom',
});

export const PROVIDER_DEFAULTS = Object.freeze({
  [ProviderId.OPENAI]:    { model: 'gpt-6-luna' },
  [ProviderId.CLAUDE]:    { model: 'claude-haiku-5-5' },
  [ProviderId.GEMINI]:    { model: 'gemini-3.8-flash' },
  [ProviderId.CHROME_AI]: { model: 'default' },
  [ProviderId.CUSTOM]:    { model: 'default', baseUrl: 'http://localhost:11434/v1' },
});

/**
 * Model IDs that the vendor has deprecated or shut down. A saved setting that
 * still names one is migrated to the provider default when settings are read;
 * any other saved model is left exactly as the user chose it.
 * (Gemini 2.5 models are access-restricted for new users but still served, so
 * they are intentionally not listed.)
 */
export const RETIRED_MODELS = Object.freeze({
  [ProviderId.OPENAI]: Object.freeze(['gpt-4.1-nano']),
  [ProviderId.CLAUDE]: Object.freeze(['claude-opus-4-20250514', 'claude-sonnet-4-20250514']),
  [ProviderId.GEMINI]: Object.freeze(['gemini-3-pro-preview']),
});

/** Returns the model to use for a saved model ID, migrating retired IDs. */
export function migrateRetiredModel(providerId, model) {
  const retired = RETIRED_MODELS[providerId];
  if (retired && typeof model === 'string' && retired.includes(model)) {
    return PROVIDER_DEFAULTS[providerId].model;
  }
  return model;
}

export const PROVIDER_NAMES = Object.freeze({
  [ProviderId.OPENAI]:    'OpenAI',
  [ProviderId.CLAUDE]:    'Claude (Anthropic)',
  [ProviderId.GEMINI]:    'Google Gemini',
  [ProviderId.CHROME_AI]: 'Chrome Built-in AI (Experimental)',
  [ProviderId.CUSTOM]:    'Custom (OpenAI-Compatible)',
});

// ── Error classes ──

export class AIDisabledError extends Error {
  constructor(msg = 'AI is not configured') {
    super(msg);
    this.name = 'AIDisabledError';
    this.code = 'AI_DISABLED';
  }
}

export class AIAuthError extends Error {
  constructor(msg = 'Authentication failed') {
    super(msg);
    this.name = 'AIAuthError';
    this.code = 'AI_AUTH';
  }
}

export class AIRateLimitError extends Error {
  constructor(msg = 'Rate limit exceeded') {
    super(msg);
    this.name = 'AIRateLimitError';
    this.code = 'AI_RATE_LIMIT';
    this.retryAfterMs = 2000;
  }
}

export class AINetworkError extends Error {
  constructor(msg = 'Network error') {
    super(msg);
    this.name = 'AINetworkError';
    this.code = 'AI_NETWORK';
  }
}

/**
 * A request the provider rejected as invalid (4xx other than auth/rate-limit).
 * Retrying the identical request cannot succeed, so the queue never retries it.
 */
export class AIRequestError extends Error {
  constructor(msg = 'AI provider rejected the request') {
    super(msg);
    this.name = 'AIRequestError';
    this.code = 'AI_REQUEST';
  }
}

/**
 * Map a non-OK HTTP status (after 401/403/429 handling) to a typed error.
 * Client errors are permanent; 408/5xx and anything else stay retryable.
 */
export function providerHttpError(label, status, detail = '') {
  const message = `${label} API error ${status}: ${String(detail).slice(0, 200)}`;
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408) {
    return new AIRequestError(message);
  }
  return new AINetworkError(message);
}

export class AIAbortError extends Error {
  constructor(msg = 'Request cancelled') {
    super(msg);
    this.name = 'AIAbortError';
    this.code = 'AI_ABORTED';
  }
}

export class AITimeoutError extends Error {
  constructor(msg = 'Request timed out') {
    super(msg);
    this.name = 'AITimeoutError';
    this.code = 'AI_TIMEOUT';
  }
}

export class AIForegroundRequiredError extends Error {
  constructor(msg = 'AI requires an open side panel') {
    super(msg);
    this.name = 'AIForegroundRequiredError';
    this.code = 'AI_FOREGROUND_REQUIRED';
  }
}

export class AIUnavailableError extends Error {
  constructor(msg = 'AI provider is unavailable') {
    super(msg);
    this.name = 'AIUnavailableError';
    this.code = 'AI_UNAVAILABLE';
  }
}

export class AIMalformedResultError extends Error {
  constructor(msg = 'AI provider returned a malformed result') {
    super(msg);
    this.name = 'AIMalformedResultError';
    this.code = 'AI_MALFORMED_RESULT';
  }
}
