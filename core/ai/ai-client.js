// core/ai/ai-client.js — AI orchestrator: provider selection + cache + queue + crypto

import { Storage } from '../storage.js';
import { AICache } from './cache.js';
import { AIQueue } from './queue.js';
import { runAbortableAttempt } from './request-lifecycle.js';
import { encryptApiKey, decryptApiKey } from './crypto.js';
import { OpenAIProvider } from './provider-openai.js';
import { ClaudeProvider } from './provider-claude.js';
import { GeminiProvider } from './provider-gemini.js';
import { chromeAIBrokerClient } from './chrome-ai-broker-client.js';
import { CustomProvider } from './provider-custom.js';
import {
  ProviderId,
  PROVIDER_DEFAULTS,
  AIAbortError,
  AIAuthError,
  AIDisabledError,
  AIForegroundRequiredError,
  AIMalformedResultError,
  AINetworkError,
  AIRateLimitError,
  AITimeoutError,
  AIUnavailableError,
} from './provider.js';

const PROVIDERS = Object.freeze({
  [ProviderId.OPENAI]: OpenAIProvider,
  [ProviderId.CLAUDE]: ClaudeProvider,
  [ProviderId.GEMINI]: GeminiProvider,
  [ProviderId.CHROME_AI]: chromeAIBrokerClient,
  [ProviderId.CUSTOM]: CustomProvider,
});

const PROVIDER_IDS = Object.freeze(Object.values(ProviderId));
const PROVIDER_ID_SET = new Set(PROVIDER_IDS);
const KEY_PROVIDER_IDS = Object.freeze([
  ProviderId.OPENAI,
  ProviderId.CLAUDE,
  ProviderId.GEMINI,
  ProviderId.CUSTOM,
]);
const KEY_PROVIDER_ID_SET = new Set(KEY_PROVIDER_IDS);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const AI_SETTINGS_KEY = 'aiSettings';
const SESSION_KEY_PREFIX = 'aiDecryptedKey_';
const SESSION_ENTRY_VERSION = 1;
const MAX_AI_FIELD_LENGTH = 16_384;
const REQUEST_TIMEOUT_MS = 120_000; // On-device model loading can be slow.
const REENTER_ALL_KEYS_MESSAGE =
  'Re-enter every saved API key before changing key protection.';

const queue = new AIQueue();
const textEncoder = new TextEncoder();

function defaultPrivateSettings() {
  return {
    enabled: false,
    providerId: null,
    providerConfigs: {},
    usePassphrase: false,
  };
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function inspectOwnKeys(value, label) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(`${label} cannot be inspected safely`);
  }
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError(`${label} contains a symbol field`);
  }
  if (keys.some((key) => DANGEROUS_KEYS.has(key))) {
    throw new TypeError(`${label} contains a dangerous field`);
  }
  return keys;
}

function ownDataValue(value, key, label, { required = false } = {}) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new TypeError(`${label} cannot be inspected safely`);
  }
  if (!descriptor) {
    if (required) throw new TypeError(`${label} is missing a required field`);
    return undefined;
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(`${label} fields must be enumerable own data properties`);
  }
  return descriptor.value;
}

function safeOwnDataValue(value, key) {
  if (!isPlainRecord(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function requireExactRecord(value, expectedKeys, label) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be an object`);
  const keys = inspectOwnKeys(value, label);
  const expected = new Set(expectedKeys);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new TypeError(`${label} contains unexpected or missing fields`);
  }
  for (const key of expectedKeys) ownDataValue(value, key, label, { required: true });
  return value;
}

function requireBoundedString(value, label, { trim = true } = {}) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_AI_FIELD_LENGTH ||
    (trim && value !== value.trim())
  ) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function requireProviderId(providerId) {
  if (typeof providerId !== 'string' || !PROVIDER_ID_SET.has(providerId)) {
    throw new TypeError('Unknown AI provider');
  }
  return providerId;
}

function requireKeyProviderId(providerId) {
  requireProviderId(providerId);
  if (!KEY_PROVIDER_ID_SET.has(providerId)) {
    throw new TypeError('This AI provider does not accept an API key');
  }
  return providerId;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (normalized === '[::1]' || normalized === '::1') return true;
  const octets = normalized.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) =>
    /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function requireCustomBaseUrl(value) {
  const baseUrl = requireBoundedString(value, 'Custom AI base URL');
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError('Custom AI base URL must be a valid HTTP(S) endpoint');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError('Custom AI base URL must be a valid HTTP(S) endpoint');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new TypeError('Custom AI base URL must use HTTPS unless it is local');
  }
  return baseUrl;
}

function sanitizeProviderFailure(error) {
  if (error instanceof AIAuthError) return new AIAuthError();
  if (error instanceof AIRateLimitError) return new AIRateLimitError();
  if (error instanceof AIAbortError) return new AIAbortError();
  if (error instanceof AITimeoutError) return new AITimeoutError();
  if (error instanceof AIForegroundRequiredError) return new AIForegroundRequiredError();
  if (error instanceof AIUnavailableError) return new AIUnavailableError();
  if (error instanceof AIMalformedResultError) return new AIMalformedResultError();
  if (error instanceof AIDisabledError) return new AIDisabledError();
  return new AINetworkError();
}

function containsPrivatePlaintext(value, plaintext, state = { seen: new Set(), visited: 0 }) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return false;
  if (typeof value === 'string') return value.includes(plaintext);
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (state.seen.has(value)) return false;
  state.seen.add(value);
  state.visited += 1;
  if (state.visited > 10_000) return true;

  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return true;
  }
  for (const key of keys) {
    if (typeof key !== 'string' || key.includes(plaintext)) return true;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return true;
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return true;
    if (containsPrivatePlaintext(descriptor.value, plaintext, state)) return true;
  }
  return false;
}

function validatePublicSettings(settings) {
  requireExactRecord(
    settings,
    ['enabled', 'providerId', 'providerConfigs', 'protectionMode'],
    'AI settings',
  );
  const enabled = ownDataValue(settings, 'enabled', 'AI settings', { required: true });
  const providerId = ownDataValue(settings, 'providerId', 'AI settings', { required: true });
  const providerConfigs = ownDataValue(
    settings,
    'providerConfigs',
    'AI settings',
    { required: true },
  );
  const protectionMode = ownDataValue(
    settings,
    'protectionMode',
    'AI settings',
    { required: true },
  );

  if (typeof enabled !== 'boolean') throw new TypeError('AI enabled must be a boolean');
  if (providerId !== null) requireProviderId(providerId);
  if (enabled && providerId === null) {
    throw new TypeError('Enabled AI settings require a provider');
  }
  if (!['device', 'passphrase', 'mixed'].includes(protectionMode)) {
    throw new TypeError('AI protection mode is invalid');
  }

  requireExactRecord(providerConfigs, PROVIDER_IDS, 'AI provider settings');
  const canonicalConfigs = {};
  for (const id of PROVIDER_IDS) {
    const config = ownDataValue(providerConfigs, id, 'AI provider settings', { required: true });
    const expectedFields = id === ProviderId.CUSTOM ? ['model', 'baseUrl'] : ['model'];
    requireExactRecord(config, expectedFields, `${id} AI settings`);
    const model = requireBoundedString(
      ownDataValue(config, 'model', `${id} AI settings`, { required: true }),
      `${id} AI model`,
    );
    canonicalConfigs[id] = { model };
    if (id === ProviderId.CUSTOM) {
      canonicalConfigs[id].baseUrl = requireCustomBaseUrl(
        ownDataValue(config, 'baseUrl', `${id} AI settings`, { required: true }),
      );
    }
  }

  return { enabled, providerId, providerConfigs: canonicalConfigs, protectionMode };
}

function validateKeyUpdates(keyUpdates) {
  if (!Array.isArray(keyUpdates) || keyUpdates.length > KEY_PROVIDER_IDS.length) {
    throw new TypeError('AI key updates must be a bounded array');
  }
  const keys = inspectOwnKeys(keyUpdates, 'AI key updates');
  const expectedKeys = new Set([
    ...Array.from({ length: keyUpdates.length }, (_, index) => String(index)),
    'length',
  ]);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw new TypeError('AI key updates must be a dense array');
  }

  const seen = new Set();
  const canonical = [];
  for (let index = 0; index < keyUpdates.length; index += 1) {
    if (!Object.hasOwn(keyUpdates, index)) {
      throw new TypeError('AI key updates must be a dense array');
    }
    const update = keyUpdates[index];
    requireExactRecord(update, ['providerId', 'plainKey'], `AI key update ${index}`);
    const providerId = requireProviderId(
      ownDataValue(update, 'providerId', `AI key update ${index}`, { required: true }),
    );
    if (!KEY_PROVIDER_ID_SET.has(providerId)) {
      throw new TypeError('This AI provider does not accept an API key');
    }
    if (seen.has(providerId)) throw new TypeError('AI key updates contain a duplicate provider');
    seen.add(providerId);
    const plainKey = requireBoundedString(
      ownDataValue(update, 'plainKey', `AI key update ${index}`, { required: true }),
      'AI API key',
      { trim: false },
    );
    canonical.push({ providerId, plainKey });
  }
  return canonical;
}

function validatePassphraseValue(passphrase) {
  if (passphrase === null) return null;
  return requireBoundedString(passphrase, 'AI passphrase', { trim: false });
}

function storedProviderConfig(settings, providerId) {
  const configs = safeOwnDataValue(settings, 'providerConfigs');
  return safeOwnDataValue(configs, providerId);
}

function storedApiKeyValue(settings, providerId) {
  return safeOwnDataValue(storedProviderConfig(settings, providerId), 'apiKey');
}

function isEncryptedBlob(value) {
  if (!isPlainRecord(value)) return false;
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  if (
    keys.some((key) => typeof key !== 'string') ||
    keys.length !== 4 ||
    !['ciphertext', 'salt', 'iv', 'usesPassphrase'].every((key) => keys.includes(key))
  ) {
    return false;
  }
  const ciphertext = safeOwnDataValue(value, 'ciphertext');
  const salt = safeOwnDataValue(value, 'salt');
  const iv = safeOwnDataValue(value, 'iv');
  const usesPassphrase = safeOwnDataValue(value, 'usesPassphrase');
  return (
    typeof ciphertext === 'string' && ciphertext.length > 0 &&
    ciphertext.length <= MAX_AI_FIELD_LENGTH &&
    typeof salt === 'string' && salt.length > 0 && salt.length <= MAX_AI_FIELD_LENGTH &&
    typeof iv === 'string' && iv.length > 0 && iv.length <= MAX_AI_FIELD_LENGTH &&
    typeof usesPassphrase === 'boolean'
  );
}

function storedBlob(settings, providerId, { rejectMalformed = false } = {}) {
  const value = storedApiKeyValue(settings, providerId);
  if (value === undefined) return null;
  if (!isEncryptedBlob(value)) {
    if (rejectMalformed) throw new TypeError('Stored AI credential is invalid');
    return null;
  }
  return value;
}

function collectStoredBlobs(settings, options) {
  const blobs = new Map();
  for (const providerId of KEY_PROVIDER_IDS) {
    const blob = storedBlob(settings, providerId, options);
    if (blob) blobs.set(providerId, blob);
  }
  return blobs;
}

function protectionModeFromBlobs(blobs) {
  if (blobs.size === 0) return 'device';
  let passphraseCount = 0;
  for (const blob of blobs.values()) {
    if (blob.usesPassphrase) passphraseCount++;
  }
  if (passphraseCount === 0) return 'device';
  if (passphraseCount === blobs.size) return 'passphrase';
  return 'mixed';
}

function storedModel(settings, providerId) {
  const value = safeOwnDataValue(storedProviderConfig(settings, providerId), 'model');
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_AI_FIELD_LENGTH &&
    value === value.trim()
  ) {
    return value;
  }
  return PROVIDER_DEFAULTS[providerId].model;
}

function storedCustomBaseUrl(settings, { allowDefault = false } = {}) {
  const value = safeOwnDataValue(storedProviderConfig(settings, ProviderId.CUSTOM), 'baseUrl');
  if (value === undefined && allowDefault) return PROVIDER_DEFAULTS.custom.baseUrl;
  try {
    return requireCustomBaseUrl(value);
  } catch {
    return null;
  }
}

function credentialAuthority(settings, providerId) {
  if (providerId !== ProviderId.CUSTOM) return null;
  const baseUrl = storedCustomBaseUrl(settings);
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

async function fingerprintBlob(providerId, blob, settings) {
  const canonical = JSON.stringify([
    'tabkebab-ai-key-v1',
    providerId,
    credentialAuthority(settings, providerId),
    blob.usesPassphrase,
    blob.ciphertext,
    blob.salt,
    blob.iv,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(canonical));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createSessionEntry(blobFingerprint, plainKey) {
  return {
    version: SESSION_ENTRY_VERSION,
    blobFingerprint,
    plainKey,
  };
}

function readSessionEntryKey(entry, expectedFingerprint) {
  if (!isPlainRecord(entry)) return null;
  let keys;
  try {
    keys = Reflect.ownKeys(entry);
  } catch {
    return null;
  }
  if (
    keys.some((key) => typeof key !== 'string') ||
    keys.length !== 3 ||
    !['version', 'blobFingerprint', 'plainKey'].every((key) => keys.includes(key))
  ) {
    return null;
  }
  const version = safeOwnDataValue(entry, 'version');
  const fingerprint = safeOwnDataValue(entry, 'blobFingerprint');
  const plainKey = safeOwnDataValue(entry, 'plainKey');
  if (
    version !== SESSION_ENTRY_VERSION ||
    fingerprint !== expectedFingerprint ||
    typeof plainKey !== 'string' ||
    plainKey.length === 0 ||
    plainKey.length > MAX_AI_FIELD_LENGTH
  ) {
    return null;
  }
  return plainKey;
}

async function readFingerprintValidSessionKey(providerId, blob, settings) {
  const sessionKey = SESSION_KEY_PREFIX + providerId;
  const expectedFingerprint = await fingerprintBlob(providerId, blob, settings);
  const result = await chrome.storage.session.get(sessionKey);
  return readSessionEntryKey(result[sessionKey], expectedFingerprint);
}

async function getApiKeyFromSettings(settings, providerId) {
  const blob = storedBlob(settings, providerId);
  if (!blob) return null;

  try {
    const cached = await readFingerprintValidSessionKey(providerId, blob, settings);
    if (cached) return cached;
  } catch {
    if (blob.usesPassphrase) return null;
  }

  if (blob.usesPassphrase) return null;

  let plainKey;
  try {
    plainKey = await decryptApiKey(blob);
  } catch {
    return null;
  }
  if (typeof plainKey !== 'string' || plainKey.length === 0) return null;

  try {
    const blobFingerprint = await fingerprintBlob(providerId, blob, settings);
    await chrome.storage.session.set({
      [SESSION_KEY_PREFIX + providerId]: createSessionEntry(blobFingerprint, plainKey),
    });
  } catch {
    // Device-protected material remains usable even when its optional session cache fails.
  }
  return plainKey;
}

function ensureAllStoredKeysReplaced(storedBlobs, updateMap) {
  for (const providerId of storedBlobs.keys()) {
    if (!updateMap.has(providerId)) throw new Error(REENTER_ALL_KEYS_MESSAGE);
  }
}

function validateProtectionTransition(currentMode, storedBlobs, requestedMode, updates, passphrase) {
  const updateMap = new Map(updates.map((update) => [update.providerId, update]));
  const hasUpdates = updates.length > 0;

  if (requestedMode === 'mixed') {
    if (currentMode !== 'mixed' || hasUpdates || passphrase !== null) {
      throw new TypeError('Mixed key protection can only be preserved without key changes');
    }
    return updateMap;
  }

  if (requestedMode === 'passphrase') {
    if (hasUpdates && typeof passphrase !== 'string') {
      throw new TypeError('A passphrase is required for protected key updates');
    }
    if (!hasUpdates && passphrase !== null) {
      throw new TypeError('A passphrase is not accepted when no key is encrypted');
    }
  } else if (passphrase !== null) {
    throw new TypeError('Device-protected settings do not accept a passphrase');
  }

  if (currentMode === 'mixed') {
    ensureAllStoredKeysReplaced(storedBlobs, updateMap);
  } else if (storedBlobs.size > 0 && currentMode !== requestedMode) {
    ensureAllStoredKeysReplaced(storedBlobs, updateMap);
  }

  if (requestedMode === 'passphrase' && storedBlobs.size === 0 && !hasUpdates) {
    throw new TypeError('Passphrase protection requires at least one API key');
  }
  return updateMap;
}

function buildNextPrivateSettings(publicSettings, storedBlobs, replacements) {
  const providerConfigs = {};
  for (const providerId of PROVIDER_IDS) {
    providerConfigs[providerId] = {
      model: publicSettings.providerConfigs[providerId].model,
    };
    if (providerId === ProviderId.CUSTOM) {
      providerConfigs[providerId].baseUrl = publicSettings.providerConfigs[providerId].baseUrl;
    }
    if (KEY_PROVIDER_ID_SET.has(providerId)) {
      const blob = replacements.get(providerId)?.blob || storedBlobs.get(providerId);
      if (blob) providerConfigs[providerId].apiKey = blob;
    }
  }
  return {
    enabled: publicSettings.enabled,
    providerId: publicSettings.providerId,
    providerConfigs,
    usePassphrase: publicSettings.protectionMode === 'mixed'
      ? null
      : publicSettings.protectionMode === 'passphrase',
  };
}

function editablePublicFieldsContainSecret(publicSettings, secrets) {
  const nonDefaultValues = [];
  for (const providerId of PROVIDER_IDS) {
    const model = publicSettings.providerConfigs[providerId].model;
    if (model !== PROVIDER_DEFAULTS[providerId].model) nonDefaultValues.push(model);
  }
  const baseUrl = publicSettings.providerConfigs[ProviderId.CUSTOM].baseUrl;
  if (baseUrl !== PROVIDER_DEFAULTS.custom.baseUrl) nonDefaultValues.push(baseUrl);

  return secrets.some((secret) =>
    nonDefaultValues.some((value) => value.includes(secret)));
}

function customCredentialChangesOrigin(currentSettings, publicSettings, storedBlobs, updateMap) {
  if (!storedBlobs.has(ProviderId.CUSTOM) || updateMap.has(ProviderId.CUSTOM)) return false;
  const currentOrigin = credentialAuthority(currentSettings, ProviderId.CUSTOM);
  const nextOrigin = credentialAuthority(publicSettings, ProviderId.CUSTOM);
  return currentOrigin === null || nextOrigin === null || currentOrigin !== nextOrigin;
}

async function responseCacheScope(settings, providerId, request) {
  const blob = storedBlob(settings, providerId);
  let customBaseUrl = null;
  if (providerId === ProviderId.CUSTOM) {
    const storedBaseUrl = storedCustomBaseUrl(settings);
    if (storedBaseUrl) customBaseUrl = new URL(storedBaseUrl).href.replace(/\/+$/, '');
  }
  return {
    credentialFingerprint: blob ? await fingerprintBlob(providerId, blob, settings) : null,
    customBaseUrl,
    maxTokens: request.maxTokens ?? null,
    temperature: request.temperature ?? null,
    responseFormat: request.responseFormat ?? null,
  };
}

async function completeWithResolvedProvider(request, {
  providerId,
  config,
  settings,
}) {
  const cacheKey = await AICache.makeCacheKey(
    providerId,
    config.model,
    request.systemPrompt || '',
    request.userPrompt,
    await responseCacheScope(settings, providerId, request),
  );

  const cached = await AICache.get(cacheKey);
  if (cached) {
    if (config.apiKey && containsPrivatePlaintext(cached, config.apiKey)) {
      await AICache.clear();
    } else {
      return { ...cached, fromCache: true };
    }
  }

  const provider = PROVIDERS[providerId];
  let response;
  try {
    response = await queue.enqueue(() =>
      runAbortableAttempt(
        (signal) => provider.complete(request, config, signal),
        REQUEST_TIMEOUT_MS,
      ));
  } catch (error) {
    // Provider/server/browser errors are untrusted and may reflect request
    // headers or prompts. Preserve only the typed category across the core boundary.
    throw sanitizeProviderFailure(error);
  }
  if (config.apiKey && containsPrivatePlaintext(response, config.apiKey)) {
    throw new AINetworkError();
  }
  await AICache.set(cacheKey, response);
  return { ...response, fromCache: false };
}

async function selectedProviderIsUnlocked(settings) {
  const providerId = safeOwnDataValue(settings, 'providerId');
  if (!PROVIDER_ID_SET.has(providerId) || providerId === ProviderId.CHROME_AI) return true;
  const blob = storedBlob(settings, providerId);
  if (!blob || !blob.usesPassphrase) return true;
  try {
    return Boolean(await readFingerprintValidSessionKey(providerId, blob, settings));
  } catch {
    return false;
  }
}

async function buildPrivateProviderConfig(settings, providerId) {
  requireProviderId(providerId);
  const config = { model: storedModel(settings, providerId) };
  if (providerId === ProviderId.CHROME_AI) return config;

  let blob;
  try {
    blob = storedBlob(settings, providerId, { rejectMalformed: true });
  } catch {
    throw new AIDisabledError('Stored API key is unavailable');
  }
  if (providerId === ProviderId.CUSTOM) {
    const baseUrl = storedCustomBaseUrl(settings);
    if (!baseUrl) throw new AIDisabledError('Custom AI endpoint is not configured');
    config.baseUrl = baseUrl;
    if (!blob) return config;
  } else if (!blob) {
    throw new AIDisabledError('API key not available. Please unlock or re-enter your key.');
  }

  const apiKey = await getApiKeyFromSettings(settings, providerId);
  if (!apiKey) {
    throw new AIDisabledError('API key not available. Please unlock or re-enter your key.');
  }
  config.apiKey = apiKey;
  return config;
}

function normalizeModelList(value) {
  if (!Array.isArray(value)) return [];
  const models = [];
  for (const item of value.slice(0, 1_000)) {
    if (!isPlainRecord(item)) continue;
    const id = safeOwnDataValue(item, 'id');
    const name = safeOwnDataValue(item, 'name');
    if (
      typeof id !== 'string' || id.length === 0 || id.length > MAX_AI_FIELD_LENGTH ||
      typeof name !== 'string' || name.length === 0 || name.length > MAX_AI_FIELD_LENGTH
    ) {
      continue;
    }
    models.push({ id, name });
  }
  return models;
}

export const AIClient = {
  // ── Settings ──

  async getSettings() {
    const settings = await Storage.get(AI_SETTINGS_KEY);
    return isPlainRecord(settings) ? settings : defaultPrivateSettings();
  },

  async getPublicSettings() {
    const settings = await this.getSettings();
    const blobs = collectStoredBlobs(settings);
    const providerConfigs = {};
    for (const providerId of PROVIDER_IDS) {
      const blob = blobs.get(providerId);
      providerConfigs[providerId] = {
        model: storedModel(settings, providerId),
        hasApiKey: Boolean(blob),
        usesPassphrase: Boolean(blob?.usesPassphrase),
      };
      if (providerId === ProviderId.CUSTOM) {
        providerConfigs[providerId].baseUrl =
          storedCustomBaseUrl(settings, { allowDefault: true }) || PROVIDER_DEFAULTS.custom.baseUrl;
      }
    }

    const storedProviderId = safeOwnDataValue(settings, 'providerId');
    return {
      enabled: safeOwnDataValue(settings, 'enabled') === true,
      providerId: PROVIDER_ID_SET.has(storedProviderId) ? storedProviderId : null,
      providerConfigs,
      protectionMode: protectionModeFromBlobs(blobs),
    };
  },

  async saveConfiguration(settings, keyUpdates, passphrase) {
    const publicSettings = validatePublicSettings(settings);
    const updates = validateKeyUpdates(keyUpdates);
    const validatedPassphrase = validatePassphraseValue(passphrase);
    const submittedSecrets = [
      ...updates.map(({ plainKey }) => plainKey),
      ...(validatedPassphrase === null ? [] : [validatedPassphrase]),
    ];

    const current = await this.getSettings();
    if (editablePublicFieldsContainSecret(publicSettings, submittedSecrets)) {
      throw new TypeError('AI settings cannot contain submitted credential material');
    }
    const storedBlobs = collectStoredBlobs(current, { rejectMalformed: true });
    const currentMode = protectionModeFromBlobs(storedBlobs);
    const updateMap = validateProtectionTransition(
      currentMode,
      storedBlobs,
      publicSettings.protectionMode,
      updates,
      validatedPassphrase,
    );
    if (customCredentialChangesOrigin(current, publicSettings, storedBlobs, updateMap)) {
      throw new TypeError('Re-enter the Custom API key before changing endpoint origin');
    }

    const replacements = new Map();
    try {
      for (const update of updates) {
        const blob = await encryptApiKey(
          update.plainKey,
          publicSettings.protectionMode === 'passphrase' ? validatedPassphrase : undefined,
        );
        if (!isEncryptedBlob(blob)) throw new Error('Encryption returned an invalid blob');
        const blobFingerprint = await fingerprintBlob(update.providerId, blob, publicSettings);
        replacements.set(update.providerId, {
          blob,
          sessionEntry: createSessionEntry(blobFingerprint, update.plainKey),
        });
      }
    } catch {
      throw new Error('Could not encrypt AI API key');
    }

    const next = buildNextPrivateSettings(publicSettings, storedBlobs, replacements);
    const resultingMode = protectionModeFromBlobs(collectStoredBlobs(next));
    if (publicSettings.protectionMode !== resultingMode) {
      throw new TypeError('Requested AI key protection cannot be represented');
    }

    try {
      await Storage.set(AI_SETTINGS_KEY, next);
    } catch {
      throw new Error('Could not save AI settings');
    }

    if (replacements.size > 0) {
      const sessionBatch = {};
      for (const [providerId, replacement] of replacements) {
        sessionBatch[SESSION_KEY_PREFIX + providerId] = replacement.sessionEntry;
      }
      try {
        await chrome.storage.session.set(sessionBatch);
      } catch {
        return { saved: true, unlocked: false };
      }
    }

    return {
      saved: true,
      unlocked: await selectedProviderIsUnlocked(next),
    };
  },

  async isAvailable() {
    try {
      const settings = await this.getSettings();
      const enabled = safeOwnDataValue(settings, 'enabled') === true;
      const providerId = safeOwnDataValue(settings, 'providerId');
      if (!enabled || !PROVIDER_ID_SET.has(providerId)) return false;
      if (providerId === ProviderId.CHROME_AI) return true;

      const config = storedProviderConfig(settings, providerId);
      if (providerId === ProviderId.CUSTOM && !storedCustomBaseUrl(settings)) return false;
      if (!isPlainRecord(config)) return false;
      const blob = storedBlob(settings, providerId, { rejectMalformed: true });
      if (providerId === ProviderId.CUSTOM && !blob) return true;
      if (!blob) return false;
      return Boolean(await getApiKeyFromSettings(settings, providerId));
    } catch {
      return false;
    }
  },

  // ── API Key Management ──

  async getApiKey(providerId) {
    requireKeyProviderId(providerId);
    const settings = await this.getSettings();
    return getApiKeyFromSettings(settings, providerId);
  },

  async needsPassphrase(providerId) {
    requireProviderId(providerId);
    if (!KEY_PROVIDER_ID_SET.has(providerId)) return false;
    const settings = await this.getSettings();
    const blob = storedBlob(settings, providerId);
    if (!blob?.usesPassphrase) return false;
    try {
      return !(await readFingerprintValidSessionKey(providerId, blob, settings));
    } catch {
      return true;
    }
  },

  async unlockApiKey(providerId, passphrase) {
    requireKeyProviderId(providerId);
    const validatedPassphrase = requireBoundedString(
      passphrase,
      'AI passphrase',
      { trim: false },
    );
    const settings = await this.getSettings();
    const blob = storedBlob(settings, providerId, { rejectMalformed: true });
    if (!blob) throw new AIAuthError('No passphrase-protected API key');
    if (!blob.usesPassphrase) {
      throw new AIAuthError('API key is not passphrase-protected');
    }

    const blobFingerprint = await fingerprintBlob(providerId, blob, settings);
    const sessionKey = SESSION_KEY_PREFIX + providerId;
    try {
      const session = await chrome.storage.session.get(sessionKey);
      if (readSessionEntryKey(session[sessionKey], blobFingerprint)) return;
    } catch {
      throw new Error('Could not access AI session storage');
    }

    let plainKey;
    try {
      plainKey = await decryptApiKey(blob, validatedPassphrase);
      requireBoundedString(plainKey, 'AI API key', { trim: false });
    } catch {
      throw new AIAuthError('Incorrect passphrase');
    }

    try {
      await chrome.storage.session.set({
        [sessionKey]: createSessionEntry(blobFingerprint, plainKey),
      });
    } catch {
      throw new Error('Could not cache unlocked API key');
    }
  },

  // ── Connection Test ──

  async testConnection(providerId) {
    requireProviderId(providerId);
    const provider = PROVIDERS[providerId];
    const settings = await this.getSettings();
    const config = await buildPrivateProviderConfig(settings, providerId);
    try {
      return Boolean(await runAbortableAttempt(
        (signal) => provider.testConnection(config, signal),
        REQUEST_TIMEOUT_MS,
      ));
    } catch (error) {
      if (error instanceof AIAbortError || error instanceof AITimeoutError) return false;
      throw sanitizeProviderFailure(error);
    }
  },

  // ── AI Completion ──

  async complete(request) {
    const settings = await this.getSettings();
    const enabled = safeOwnDataValue(settings, 'enabled') === true;
    const providerId = safeOwnDataValue(settings, 'providerId');
    if (!enabled || !PROVIDER_ID_SET.has(providerId)) {
      throw new AIDisabledError();
    }

    const config = await buildPrivateProviderConfig(settings, providerId);
    return completeWithResolvedProvider(request, { providerId, config, settings });
  },

  /**
   * Run Chrome's document-brokered provider without saving or changing AI
   * settings. It shares the normal queue, timeout/abort lifecycle, cache, and
   * sanitized error boundary.
   */
  async completeWithChromeAI(request) {
    const providerId = ProviderId.CHROME_AI;
    const settings = defaultPrivateSettings();
    const config = { model: PROVIDER_DEFAULTS[providerId].model };
    return completeWithResolvedProvider(request, { providerId, config, settings });
  },

  // ── Model Listing ──

  async listModels(providerId) {
    requireProviderId(providerId);
    const provider = PROVIDERS[providerId];
    if (!provider.listModels) return [];
    const settings = await this.getSettings();
    const config = await buildPrivateProviderConfig(settings, providerId);
    try {
      const models = await runAbortableAttempt(
        (signal) => provider.listModels(config, signal),
        REQUEST_TIMEOUT_MS,
      );
      if (config.apiKey && containsPrivatePlaintext(models, config.apiKey)) return [];
      return normalizeModelList(models);
    } catch {
      return [];
    }
  },

  // ── Cache ──

  async clearCache() {
    return AICache.clear();
  },

};
