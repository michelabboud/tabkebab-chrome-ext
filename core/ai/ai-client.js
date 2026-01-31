// core/ai/ai-client.js — AI orchestrator: provider selection + cache + queue + crypto

import { Storage } from '../storage.js';
import { AICache } from './cache.js';
import { AIQueue } from './queue.js';
import { encryptApiKey, decryptApiKey } from './crypto.js';
import { OpenAIProvider } from './provider-openai.js';
import { ClaudeProvider } from './provider-claude.js';
import { GeminiProvider } from './provider-gemini.js';
import { ChromeAIProvider } from './provider-chrome.js';
import { CustomProvider } from './provider-custom.js';
import {
  ProviderId, PROVIDER_DEFAULTS,
  AIDisabledError, AITimeoutError,
} from './provider.js';

const PROVIDERS = {
  [ProviderId.OPENAI]: OpenAIProvider,
  [ProviderId.CLAUDE]: ClaudeProvider,
  [ProviderId.GEMINI]: GeminiProvider,
  [ProviderId.CHROME_AI]: ChromeAIProvider,
  [ProviderId.CUSTOM]: CustomProvider,
};

// Providers that don't require an API key
const NO_KEY_PROVIDERS = new Set([ProviderId.CHROME_AI]);

const AI_SETTINGS_KEY = 'aiSettings';
const SESSION_KEY_PREFIX = 'aiDecryptedKey_';
const REQUEST_TIMEOUT_MS = 20_000;

const queue = new AIQueue();

/**
 * @typedef {Object} AISettings
 * @property {boolean} enabled
 * @property {string|null} providerId
 * @property {Object} providerConfigs - { openai: { apiKey: {...encrypted}, model }, claude: { ... } }
 * @property {boolean} usePassphrase
 */

export const AIClient = {
  // ── Settings ──

  async getSettings() {
    const settings = await Storage.get(AI_SETTINGS_KEY);
    return settings || {
      enabled: false,
      providerId: null,
      providerConfigs: {},
      usePassphrase: false,
    };
  },

  async saveSettings(settings) {
    return Storage.set(AI_SETTINGS_KEY, settings);
  },

  async isAvailable() {
    const settings = await this.getSettings();
    if (!settings.enabled || !settings.providerId) return false;
    // Some providers don't need an API key
    if (NO_KEY_PROVIDERS.has(settings.providerId)) return true;
    // Custom provider may not need a key either
    if (settings.providerId === ProviderId.CUSTOM) {
      const config = settings.providerConfigs[settings.providerId];
      return !!(config?.baseUrl);
    }
    // Other providers need an encrypted API key
    const config = settings.providerConfigs[settings.providerId];
    return !!(config?.apiKey);
  },

  // ── API Key Management ──

  /**
   * Encrypt and store an API key for a provider.
   * @param {string} providerId
   * @param {string} plainKey - The raw API key
   * @param {string} [passphrase] - Optional user passphrase
   */
  async setApiKey(providerId, plainKey, passphrase) {
    const settings = await this.getSettings();
    if (!settings.providerConfigs[providerId]) {
      settings.providerConfigs[providerId] = {};
    }

    const encrypted = await encryptApiKey(plainKey, passphrase || undefined);
    settings.providerConfigs[providerId].apiKey = encrypted;
    settings.usePassphrase = !!passphrase;

    await this.saveSettings(settings);

    // Cache decrypted key in session storage
    await chrome.storage.session.set({
      [SESSION_KEY_PREFIX + providerId]: plainKey,
    });
  },

  /**
   * Retrieve the decrypted API key for a provider.
   * Checks session cache first, then decrypts from storage.
   * @param {string} providerId
   * @param {string} [passphrase] - Required if usePassphrase is true and not in session
   * @returns {Promise<string|null>}
   */
  async getApiKey(providerId, passphrase) {
    // Check session cache first
    const sessionKey = SESSION_KEY_PREFIX + providerId;
    const session = await chrome.storage.session.get(sessionKey);
    if (session[sessionKey]) return session[sessionKey];

    // Decrypt from settings
    const settings = await this.getSettings();
    const config = settings.providerConfigs[providerId];
    if (!config?.apiKey) return null;

    try {
      const plainKey = await decryptApiKey(config.apiKey, passphrase || undefined);

      // Cache in session
      await chrome.storage.session.set({ [sessionKey]: plainKey });
      return plainKey;
    } catch {
      return null;
    }
  },

  /**
   * Check if a passphrase is needed to unlock the API key.
   */
  async needsPassphrase(providerId) {
    // If already in session, no passphrase needed
    const sessionKey = SESSION_KEY_PREFIX + providerId;
    const session = await chrome.storage.session.get(sessionKey);
    if (session[sessionKey]) return false;

    const settings = await this.getSettings();
    return settings.usePassphrase && !!settings.providerConfigs[providerId]?.apiKey?.usesPassphrase;
  },

  // ── Connection Test ──

  async testConnection(providerId, config) {
    const provider = PROVIDERS[providerId];
    if (!provider) return false;
    return provider.testConnection(config);
  },

  // ── AI Completion ──

  /**
   * Send a completion request through the cache + queue + provider pipeline.
   * @param {Object} request - { systemPrompt, userPrompt, maxTokens, temperature, responseFormat }
   * @returns {Promise<Object>} - { text, parsed, tokensUsed, fromCache }
   */
  async complete(request) {
    const settings = await this.getSettings();
    if (!settings.enabled || !settings.providerId) {
      throw new AIDisabledError();
    }

    const provider = PROVIDERS[settings.providerId];
    if (!provider) {
      throw new AIDisabledError(`Unknown provider: ${settings.providerId}`);
    }

    // Build provider config with decrypted API key
    const storedConfig = settings.providerConfigs[settings.providerId] || {};
    const defaults = PROVIDER_DEFAULTS[settings.providerId] || {};
    const config = {
      model: storedConfig.model || defaults.model,
    };

    // Get API key (not needed for Chrome AI; optional for Custom)
    if (!NO_KEY_PROVIDERS.has(settings.providerId)) {
      const apiKey = await this.getApiKey(settings.providerId);
      if (settings.providerId === ProviderId.CUSTOM) {
        config.baseUrl = storedConfig.baseUrl || defaults.baseUrl;
        if (apiKey) config.apiKey = apiKey;
      } else if (!apiKey) {
        throw new AIDisabledError('API key not available. Please unlock or re-enter your key.');
      } else {
        config.apiKey = apiKey;
      }
    }

    // Check cache
    const cacheKey = AICache.makeCacheKey(
      settings.providerId,
      config.model,
      request.systemPrompt || '',
      request.userPrompt
    );

    const cached = await AICache.get(cacheKey);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    // Send through queue with timeout
    const response = await queue.enqueue(() =>
      this._withTimeout(
        provider.complete(request, config),
        REQUEST_TIMEOUT_MS
      )
    );

    // Cache the result
    await AICache.set(cacheKey, response);

    return { ...response, fromCache: false };
  },

  // ── Model Listing ──

  /**
   * List available models for a provider (dynamically fetched from API).
   * @param {string} providerId
   * @param {Object} config - { apiKey, baseUrl?, model? }
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async listModels(providerId, config) {
    const provider = PROVIDERS[providerId];
    if (!provider?.listModels) return [];
    try {
      return await provider.listModels(config);
    } catch {
      return [];
    }
  },

  // ── Cache ──

  async clearCache() {
    return AICache.clear();
  },

  // ── Helpers ──

  _withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new AITimeoutError()), ms)
      ),
    ]);
  },
};
