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
  }
}

export class AIAuthError extends Error {
  constructor(msg = 'Authentication failed') {
    super(msg);
    this.name = 'AIAuthError';
  }
}

export class AIRateLimitError extends Error {
  constructor(msg = 'Rate limit exceeded') {
    super(msg);
    this.name = 'AIRateLimitError';
    this.retryAfterMs = 2000;
  }
}

export class AINetworkError extends Error {
  constructor(msg = 'Network error') {
    super(msg);
    this.name = 'AINetworkError';
  }
}

export class AITimeoutError extends Error {
  constructor(msg = 'Request timed out') {
    super(msg);
    this.name = 'AITimeoutError';
  }
}
