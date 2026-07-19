// core/ai/provider.js — Provider IDs, default models, and error classes

export const ProviderId = Object.freeze({
  OPENAI: 'openai',
  CLAUDE: 'claude',
  GEMINI: 'gemini',
  CHROME_AI: 'chrome-ai',
  CUSTOM: 'custom',
});

export const PROVIDER_DEFAULTS = Object.freeze({
  [ProviderId.OPENAI]:    { model: 'gpt-4.1-nano' },
  [ProviderId.CLAUDE]:    { model: 'claude-haiku-4-5' },
  [ProviderId.GEMINI]:    { model: 'gemini-2.5-flash' },
  [ProviderId.CHROME_AI]: { model: 'default' },
  [ProviderId.CUSTOM]:    { model: 'default', baseUrl: 'http://localhost:11434/v1' },
});

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
