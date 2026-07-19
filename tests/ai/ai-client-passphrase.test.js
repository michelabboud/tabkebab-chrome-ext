import { describe, expect, spyOn, test } from 'bun:test';

import { AIClient } from '../../core/ai/ai-client.js';
import { decryptApiKey, encryptApiKey } from '../../core/ai/crypto.js';
import {
  AIAuthError,
  AIDisabledError,
  AINetworkError,
  PROVIDER_DEFAULTS,
} from '../../core/ai/provider.js';
import { ClaudeProvider } from '../../core/ai/provider-claude.js';
import { CustomProvider } from '../../core/ai/provider-custom.js';
import { GeminiProvider } from '../../core/ai/provider-gemini.js';
import { OpenAIProvider } from '../../core/ai/provider-openai.js';
import { AISettings } from '../../sidepanel/components/ai-settings.js';
import {
  installChromeMock,
  readStorageArea,
} from '../helpers/chrome-mock.js';

const PROVIDER_IDS = Object.freeze([
  'openai',
  'claude',
  'gemini',
  'chrome-ai',
  'custom',
]);
const KEY_PROVIDER_IDS = Object.freeze(['openai', 'claude', 'gemini', 'custom']);
const SESSION_KEY_PREFIX = 'aiDecryptedKey_';
const MAX_AI_FIELD_LENGTH = 16_384;

let workerNonce = 0;

function syntheticSecret(label) {
  return `${label}-${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

function publicSettings(protectionMode = 'device', overrides = {}) {
  const providerConfigs = {
    openai: { model: PROVIDER_DEFAULTS.openai.model },
    claude: { model: PROVIDER_DEFAULTS.claude.model },
    gemini: { model: PROVIDER_DEFAULTS.gemini.model },
    'chrome-ai': { model: PROVIDER_DEFAULTS['chrome-ai'].model },
    custom: {
      model: PROVIDER_DEFAULTS.custom.model,
      baseUrl: PROVIDER_DEFAULTS.custom.baseUrl,
    },
  };

  for (const [providerId, config] of Object.entries(overrides.providerConfigs || {})) {
    providerConfigs[providerId] = { ...providerConfigs[providerId], ...config };
  }

  return {
    enabled: true,
    providerId: 'openai',
    providerConfigs,
    protectionMode,
    ...overrides,
    providerConfigs,
  };
}

function privateSettings(overrides = {}) {
  const providerConfigs = {
    openai: { model: PROVIDER_DEFAULTS.openai.model },
    claude: { model: PROVIDER_DEFAULTS.claude.model },
    gemini: { model: PROVIDER_DEFAULTS.gemini.model },
    'chrome-ai': { model: PROVIDER_DEFAULTS['chrome-ai'].model },
    custom: {
      model: PROVIDER_DEFAULTS.custom.model,
      baseUrl: PROVIDER_DEFAULTS.custom.baseUrl,
    },
  };

  for (const [providerId, config] of Object.entries(overrides.providerConfigs || {})) {
    providerConfigs[providerId] = { ...providerConfigs[providerId], ...config };
  }

  return {
    enabled: true,
    providerId: 'openai',
    providerConfigs,
    usePassphrase: false,
    ...overrides,
    providerConfigs,
  };
}

async function passphraseFixture(providerId = 'openai') {
  const plainKey = syntheticSecret(`${providerId}-key`);
  const passphrase = syntheticSecret(`${providerId}-passphrase`);
  const blob = await encryptApiKey(plainKey, passphrase);
  return { providerId, plainKey, passphrase, blob };
}

async function deviceFixture(providerId = 'openai', installId = syntheticSecret('install')) {
  installChromeMock({ local: { installId } });
  const plainKey = syntheticSecret(`${providerId}-key`);
  const blob = await encryptApiKey(plainKey);
  return { providerId, plainKey, installId, blob };
}

function storageFixture(settings, { installId, session = {} } = {}) {
  const local = { aiSettings: settings };
  if (installId !== undefined) local.installId = installId;
  return installChromeMock({ local, session });
}

function clearStorageCalls(harness) {
  for (const area of ['local', 'session']) {
    for (const calls of Object.values(harness.calls.storage[area])) calls.length = 0;
  }
}

function cloneBytes(value) {
  return JSON.stringify(value);
}

function sessionEntry(providerId) {
  return readStorageArea('session')[SESSION_KEY_PREFIX + providerId];
}

function containsSecret(value, secrets, seen = new Set()) {
  if (typeof value === 'string') {
    return secrets.some((secret) => value.includes(secret));
  }
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (value instanceof Error) {
    if (containsSecret(value.message, secrets, seen)) return true;
    if (containsSecret(value.cause, secrets, seen)) return true;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && containsSecret(key, secrets, seen)) return true;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return true;
    }
    if (descriptor && Object.hasOwn(descriptor, 'value') &&
        containsSecret(descriptor.value, secrets, seen)) return true;
  }
  return false;
}

function findForbiddenPublicField(value, path = 'settings', seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  const forbidden = new Set([
    'apiKey',
    'plainKey',
    'passphrase',
    'ciphertext',
    'salt',
    'iv',
    'installId',
    'usePassphrase',
    'blobFingerprint',
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return `${path}.[symbol]`;
    if (forbidden.has(key) || key.startsWith(SESSION_KEY_PREFIX)) return `${path}.${key}`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return `${path}.${key}`;
    const nested = findForbiddenPublicField(descriptor.value, `${path}.${key}`, seen);
    if (nested) return nested;
  }
  return null;
}

async function rejectionOf(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return null;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function freshWorker(label) {
  return import(`../../service-worker.js?task12=${label}-${++workerNonce}`);
}

async function settleWorkerStartup() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
}

function runtimeResponseShapeIsSecretFree(response, secrets) {
  return !containsSecret(response, secrets) && !findForbiddenPublicField(response);
}

describe('Task 12 passphrase truth and restart unlock', () => {
  test('derives passphrase need from the selected blob, not stale global metadata', async () => {
    const protectedFixture = await passphraseFixture();
    storageFixture(privateSettings({
      usePassphrase: false,
      providerConfigs: { openai: { apiKey: protectedFixture.blob } },
    }));

    expect(typeof AIClient.needsPassphrase).toBe('function');
    expect(await AIClient.needsPassphrase('openai')).toBeTrue();

    const device = await deviceFixture();
    storageFixture(privateSettings({
      usePassphrase: true,
      providerConfigs: { openai: { apiKey: device.blob } },
    }), { installId: device.installId });
    expect(await AIClient.needsPassphrase('openai')).toBeFalse();
  });

  test('ignores raw, orphaned, malformed, and stale session cache values', async () => {
    const first = await passphraseFixture();
    const staleRaw = syntheticSecret('legacy-session-key');
    storageFixture(privateSettings({
      providerConfigs: { openai: { apiKey: first.blob } },
      usePassphrase: true,
    }), { session: { [SESSION_KEY_PREFIX + 'openai']: staleRaw } });

    expect(typeof AIClient.needsPassphrase).toBe('function');
    expect(await AIClient.needsPassphrase('openai')).toBeTrue();
    expect(await AIClient.getApiKey('openai')).toBeNull();

    await AIClient.unlockApiKey('openai', first.passphrase);
    expect(await AIClient.needsPassphrase('openai')).toBeFalse();

    const second = await passphraseFixture();
    await chrome.storage.local.set({
      aiSettings: privateSettings({
        providerConfigs: { openai: { apiKey: second.blob } },
        usePassphrase: true,
      }),
    });
    expect(await AIClient.needsPassphrase('openai')).toBeTrue();
    expect(await AIClient.getApiKey('openai')).toBeNull();
  });

  test('returns false for no-key and Chrome providers even with orphaned session data', async () => {
    const orphan = syntheticSecret('orphan-key');
    storageFixture(privateSettings({ providerId: 'chrome-ai' }), {
      session: {
        [SESSION_KEY_PREFIX + 'openai']: orphan,
        [SESSION_KEY_PREFIX + 'chrome-ai']: orphan,
      },
    });

    expect(typeof AIClient.needsPassphrase).toBe('function');
    expect(await AIClient.needsPassphrase('openai')).toBeFalse();
    expect(await AIClient.needsPassphrase('chrome-ai')).toBeFalse();
  });

  test('ignores a legacy Chrome AI blob and rejects key operations before storage access', async () => {
    const phantom = await passphraseFixture('openai');
    const harness = storageFixture(privateSettings({
      providerId: 'chrome-ai',
      providerConfigs: {
        'chrome-ai': { apiKey: phantom.blob },
      },
      usePassphrase: true,
    }), {
      session: {
        [SESSION_KEY_PREFIX + 'chrome-ai']: syntheticSecret('phantom-session'),
      },
    });

    expect(await AIClient.needsPassphrase('chrome-ai')).toBeFalse();
    clearStorageCalls(harness);

    const getError = await rejectionOf(() => AIClient.getApiKey('chrome-ai'));
    const unlockError = await rejectionOf(() => AIClient.unlockApiKey(
      'chrome-ai',
      phantom.passphrase,
    ));

    expect(getError instanceof TypeError).toBeTrue();
    expect(unlockError instanceof TypeError).toBeTrue();
    expect(harness.calls.storage.local.get).toHaveLength(0);
    expect(harness.calls.storage.session.get).toHaveLength(0);
    expect(harness.calls.storage.session.set).toHaveLength(0);
  });

  test('rejects an unknown provider before local or session storage', async () => {
    const harness = installChromeMock();
    clearStorageCalls(harness);

    expect(typeof AIClient.needsPassphrase).toBe('function');
    const error = await rejectionOf(() => AIClient.needsPassphrase('not-a-provider'));
    expect(error instanceof TypeError).toBeTrue();
    expect(harness.calls.storage.local.get).toHaveLength(0);
    expect(harness.calls.storage.session.get).toHaveLength(0);
  });

  test('unlocks correctly after a complete session reset and returns no key', async () => {
    const fixture = await passphraseFixture();
    storageFixture(privateSettings({
      providerConfigs: { openai: { apiKey: fixture.blob } },
      usePassphrase: true,
    }));

    expect(typeof AIClient.unlockApiKey).toBe('function');
    await chrome.storage.session.clear();
    const result = await AIClient.unlockApiKey('openai', fixture.passphrase);
    expect(result).toBeUndefined();
    expect(sessionEntry('openai') && typeof sessionEntry('openai') === 'object').toBeTrue();
    expect(containsSecret(result, [fixture.plainKey, fixture.passphrase])).toBeFalse();
    expect(await AIClient.needsPassphrase('openai')).toBeFalse();
    expect((await AIClient.getApiKey('openai')) === fixture.plainKey).toBeTrue();
  });

  test('maps a wrong passphrase to the exact typed error without session mutation', async () => {
    const fixture = await passphraseFixture();
    const unrelatedSession = { proof: syntheticSecret('unrelated-session') };
    storageFixture(privateSettings({
      providerConfigs: { openai: { apiKey: fixture.blob } },
      usePassphrase: true,
    }), { session: { unrelatedSession } });
    const before = cloneBytes(readStorageArea('session'));

    expect(typeof AIClient.unlockApiKey).toBe('function');
    const error = await rejectionOf(() => AIClient.unlockApiKey(
      'openai',
      syntheticSecret('wrong-passphrase'),
    ));
    expect(error instanceof AIAuthError).toBeTrue();
    expect(error?.message).toBe('Incorrect passphrase');
    expect(Object.hasOwn(error || {}, 'cause')).toBeFalse();
    expect(cloneBytes(readStorageArea('session'))).toBe(before);
    expect(await AIClient.isAvailable()).toBeFalse();
  });

  test('rejects a passphrase blob that authenticates to an empty API key', async () => {
    const passphrase = syntheticSecret('empty-key-passphrase');
    const emptyBlob = await encryptApiKey('', passphrase);
    storageFixture(privateSettings({
      providerConfigs: { openai: { apiKey: emptyBlob } },
      usePassphrase: true,
    }));

    const error = await rejectionOf(() => AIClient.unlockApiKey('openai', passphrase));
    expect(error instanceof AIAuthError).toBeTrue();
    expect(error?.message).toBe('Incorrect passphrase');
    expect(sessionEntry('openai')).toBeUndefined();
    expect(await AIClient.needsPassphrase('openai')).toBeTrue();
  });

  test('rejects a legacy device blob that decrypts beyond the key bound', async () => {
    const installId = syntheticSecret('oversized-device-install');
    installChromeMock({ local: { installId } });
    const oversizedBlob = await encryptApiKey('x'.repeat(MAX_AI_FIELD_LENGTH + 1));
    storageFixture(privateSettings({
      providerConfigs: { openai: { apiKey: oversizedBlob } },
    }), { installId });

    expect(await AIClient.getApiKey('openai')).toBeNull();
    expect(await AIClient.isAvailable()).toBeFalse();
    expect(sessionEntry('openai')).toBeUndefined();
  });

  test('is idempotent for a fingerprint-valid cache entry', async () => {
    const fixture = await passphraseFixture();
    const harness = storageFixture(privateSettings({
      providerConfigs: { openai: { apiKey: fixture.blob } },
      usePassphrase: true,
    }));

    expect(typeof AIClient.unlockApiKey).toBe('function');
    await AIClient.unlockApiKey('openai', fixture.passphrase);
    const before = cloneBytes(readStorageArea('session'));
    clearStorageCalls(harness);
    await expect(AIClient.unlockApiKey(
      'openai',
      syntheticSecret('unused-after-unlock'),
    )).resolves.toBeUndefined();
    expect(cloneBytes(readStorageArea('session'))).toBe(before);
    expect(harness.calls.storage.local.set).toHaveLength(0);
    expect(harness.calls.storage.session.set).toHaveLength(0);
  });

  test('replaces a stale cache entry only after authenticating the current blob', async () => {
    const first = await passphraseFixture();
    storageFixture(privateSettings({
      providerConfigs: { openai: { apiKey: first.blob } },
      usePassphrase: true,
    }));
    expect(typeof AIClient.unlockApiKey).toBe('function');
    await AIClient.unlockApiKey('openai', first.passphrase);
    const staleBytes = cloneBytes(sessionEntry('openai'));

    const replacement = await passphraseFixture();
    await chrome.storage.local.set({
      aiSettings: privateSettings({
        providerConfigs: { openai: { apiKey: replacement.blob } },
        usePassphrase: true,
      }),
    });
    const wrongError = await rejectionOf(() => AIClient.unlockApiKey(
      'openai',
      first.passphrase,
    ));
    expect(wrongError instanceof AIAuthError).toBeTrue();
    expect(cloneBytes(sessionEntry('openai'))).toBe(staleBytes);

    await AIClient.unlockApiKey('openai', replacement.passphrase);
    expect(cloneBytes(sessionEntry('openai')) === staleBytes).toBeFalse();
    expect((await AIClient.getApiKey('openai')) === replacement.plainKey).toBeTrue();
  });

  test('rejects malformed unlock input and non-passphrase blobs without mutation', async () => {
    const device = await deviceFixture();
    const harness = storageFixture(privateSettings({
      providerConfigs: { openai: { apiKey: device.blob } },
    }), { installId: device.installId });
    clearStorageCalls(harness);

    expect(typeof AIClient.unlockApiKey).toBe('function');
    for (const passphrase of [undefined, null, '', 1, {}, []]) {
      const error = await rejectionOf(() => AIClient.unlockApiKey('openai', passphrase));
      expect(error).not.toBeNull();
    }
    const deviceError = await rejectionOf(() => AIClient.unlockApiKey(
      'openai',
      syntheticSecret('unneeded-passphrase'),
    ));
    expect(deviceError).not.toBeNull();
    expect(harness.calls.storage.local.set).toHaveLength(0);
    expect(harness.calls.storage.session.set).toHaveLength(0);
  });
});

describe('Task 12 public AI settings projection', () => {
  test('returns the complete allowlisted shape and recursively excludes private material', async () => {
    const openai = await passphraseFixture('openai');
    const custom = await deviceFixture('custom');
    const privateValue = privateSettings({
      providerId: 'custom',
      usePassphrase: null,
      providerConfigs: {
        openai: { model: 'stored-openai-model', apiKey: openai.blob },
        custom: {
          model: 'stored-custom-model',
          baseUrl: 'https://custom.example.test/v1',
          apiKey: custom.blob,
        },
      },
    });
    privateValue.privateMarker = syntheticSecret('private-root');
    privateValue.providerConfigs.openai.privateMarker = syntheticSecret('private-config');
    storageFixture(privateValue, { installId: custom.installId });

    expect(typeof AIClient.getPublicSettings).toBe('function');
    const result = await AIClient.getPublicSettings();
    expect(Object.keys(result).sort()).toEqual([
      'enabled', 'protectionMode', 'providerConfigs', 'providerId',
    ]);
    expect(Object.keys(result.providerConfigs).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(result.protectionMode).toBe('mixed');
    expect(result.providerConfigs.openai).toEqual({
      model: 'stored-openai-model',
      hasApiKey: true,
      usesPassphrase: true,
    });
    expect(result.providerConfigs.custom).toEqual({
      model: 'stored-custom-model',
      baseUrl: 'https://custom.example.test/v1',
      hasApiKey: true,
      usesPassphrase: false,
    });
    expect(result.providerConfigs['chrome-ai'].hasApiKey).toBeFalse();
    expect(result.providerConfigs['chrome-ai'].usesPassphrase).toBeFalse();
    expect(findForbiddenPublicField(result)).toBeNull();
    expect(containsSecret(result, [
      openai.plainKey,
      openai.passphrase,
      openai.blob.ciphertext,
      custom.plainKey,
      custom.blob.ciphertext,
      privateValue.privateMarker,
      privateValue.providerConfigs.openai.privateMarker,
    ])).toBeFalse();
  });

  test('derives zero, uniform device, and uniform passphrase modes from blobs', async () => {
    expect(typeof AIClient.getPublicSettings).toBe('function');

    storageFixture(privateSettings({ usePassphrase: true }));
    expect((await AIClient.getPublicSettings()).protectionMode).toBe('device');

    const device = await deviceFixture();
    storageFixture(privateSettings({
      usePassphrase: true,
      providerConfigs: { openai: { apiKey: device.blob } },
    }), { installId: device.installId });
    expect((await AIClient.getPublicSettings()).protectionMode).toBe('device');

    const protectedFixture = await passphraseFixture();
    storageFixture(privateSettings({
      usePassphrase: false,
      providerConfigs: { openai: { apiKey: protectedFixture.blob } },
    }));
    expect((await AIClient.getPublicSettings()).protectionMode).toBe('passphrase');
  });

  test('returns fresh values without mutating or sharing the private stored object', async () => {
    const fixture = await passphraseFixture();
    const stored = privateSettings({
      providerConfigs: { openai: { model: 'preserved-model', apiKey: fixture.blob } },
      usePassphrase: true,
    });
    storageFixture(stored);
    const before = cloneBytes(readStorageArea('local').aiSettings);

    expect(typeof AIClient.getPublicSettings).toBe('function');
    const first = await AIClient.getPublicSettings();
    const second = await AIClient.getPublicSettings();
    expect(first).not.toBe(second);
    expect(first.providerConfigs).not.toBe(second.providerConfigs);
    expect(first.providerConfigs.openai).not.toBe(second.providerConfigs.openai);
    first.providerConfigs.openai.model = 'mutated-public-copy';
    expect(second.providerConfigs.openai.model).toBe('preserved-model');
    expect(cloneBytes(readStorageArea('local').aiSettings)).toBe(before);
  });
});

describe('Task 12 save request validation and protection transitions', () => {
  test('rejects malformed public settings before crypto or any storage access', async () => {
    const harness = installChromeMock();
    expect(typeof AIClient.saveConfiguration).toBe('function');

    const inherited = Object.create({ enabled: true });
    Object.assign(inherited, publicSettings());
    const accessor = publicSettings();
    Object.defineProperty(accessor, 'enabled', {
      enumerable: true,
      get() { throw new Error('must not invoke accessors'); },
    });
    const polluted = JSON.parse(JSON.stringify(publicSettings()));
    Object.defineProperty(polluted, '__proto__', { enumerable: true, value: {} });
    const withSymbol = publicSettings();
    withSymbol[Symbol('private')] = true;

    const invalid = [
      null,
      [],
      inherited,
      accessor,
      polluted,
      withSymbol,
      { ...publicSettings(), enabled: 'true' },
      { ...publicSettings(), providerId: 'unknown' },
      { ...publicSettings(), protectionMode: 'legacy' },
      { ...publicSettings(), apiKey: syntheticSecret('injected-key') },
      { ...publicSettings(), usePassphrase: true },
      { ...publicSettings(), providerConfigs: [] },
      {
        ...publicSettings(),
        providerConfigs: { ...publicSettings().providerConfigs, unknown: { model: 'x' } },
      },
      {
        ...publicSettings(),
        providerConfigs: {
          ...publicSettings().providerConfigs,
          openai: { model: 'x', hasApiKey: true },
        },
      },
      {
        ...publicSettings(),
        providerConfigs: {
          ...publicSettings().providerConfigs,
          openai: { model: 'x', usesPassphrase: true },
        },
      },
    ];

    for (const settings of invalid) {
      clearStorageCalls(harness);
      const error = await rejectionOf(() => AIClient.saveConfiguration(settings, [], null));
      expect(error).not.toBeNull();
      expect(harness.calls.storage.local.get).toHaveLength(0);
      expect(harness.calls.storage.local.set).toHaveLength(0);
      expect(harness.calls.storage.session.get).toHaveLength(0);
      expect(harness.calls.storage.session.set).toHaveLength(0);
    }
  });

  test('rejects malformed, sparse, duplicate, unknown, and no-key-provider updates before storage', async () => {
    const harness = installChromeMock();
    expect(typeof AIClient.saveConfiguration).toBe('function');
    const key = syntheticSecret('update-key');
    const sparse = new Array(2);
    sparse[1] = { providerId: 'openai', plainKey: key };
    const inherited = Object.create({ providerId: 'openai' });
    inherited.plainKey = key;
    const accessor = { providerId: 'openai' };
    Object.defineProperty(accessor, 'plainKey', {
      enumerable: true,
      get() { throw new Error('must not invoke accessors'); },
    });

    const invalid = [
      null,
      {},
      sparse,
      [inherited],
      [accessor],
      [{ providerId: 'openai' }],
      [{ providerId: 'openai', plainKey: '' }],
      [{ providerId: 'openai', plainKey: 'x'.repeat(MAX_AI_FIELD_LENGTH + 1) }],
      [{ providerId: 'unknown', plainKey: key }],
      [{ providerId: 'chrome-ai', plainKey: key }],
      [
        { providerId: 'openai', plainKey: key },
        { providerId: 'openai', plainKey: syntheticSecret('duplicate-key') },
      ],
      [{ providerId: 'openai', plainKey: key, trusted: true }],
    ];

    for (const updates of invalid) {
      clearStorageCalls(harness);
      const error = await rejectionOf(() => AIClient.saveConfiguration(
        publicSettings('device'),
        updates,
        null,
      ));
      expect(error).not.toBeNull();
      expect(harness.calls.storage.local.get).toHaveLength(0);
      expect(harness.calls.storage.local.set).toHaveLength(0);
      expect(harness.calls.storage.session.set).toHaveLength(0);
    }
  });

  test('rejects malformed and credential-bearing Custom endpoints without echoing them', async () => {
    const harness = installChromeMock();
    expect(typeof AIClient.saveConfiguration).toBe('function');
    const endpointMarker = syntheticSecret('endpoint-marker');
    const invalidUrls = [
      '',
      'not-a-url',
      'file:///tmp/provider',
      'javascript:alert(1)',
      'ftp://provider.example.test/v1',
      'http://provider.example.test/v1',
      `https://${endpointMarker}:password@provider.example.test/v1`,
      'https://provider.example.test/v1?token=value',
      'https://provider.example.test/v1#fragment',
      `https://provider.example.test/${'x'.repeat(MAX_AI_FIELD_LENGTH)}`,
    ];

    for (const baseUrl of invalidUrls) {
      clearStorageCalls(harness);
      const settings = publicSettings('device', {
        providerConfigs: { custom: { baseUrl } },
      });
      const error = await rejectionOf(() => AIClient.saveConfiguration(settings, [], null));
      expect(error).not.toBeNull();
      expect(containsSecret(error, [endpointMarker])).toBeFalse();
      expect(harness.calls.storage.local.get).toHaveLength(0);
      expect(harness.calls.storage.local.set).toHaveLength(0);
      expect(harness.calls.storage.session.set).toHaveLength(0);
    }
  });

  test('rejects submitted keys or passphrases copied into public settings before persistence', async () => {
    const harness = installChromeMock();
    const key = syntheticSecret('cross-field-key');
    const passphrase = syntheticSecret('cross-field-passphrase');
    const attempts = [
      {
        settings: publicSettings('device', {
          providerConfigs: { openai: { model: key } },
        }),
        updates: [{ providerId: 'openai', plainKey: key }],
        passphrase: null,
      },
      {
        settings: publicSettings('device', {
          providerConfigs: {
            custom: { baseUrl: `https://provider.example.test/${key}` },
          },
        }),
        updates: [{ providerId: 'openai', plainKey: key }],
        passphrase: null,
      },
      {
        settings: publicSettings('passphrase', {
          providerConfigs: { openai: { model: passphrase } },
        }),
        updates: [{ providerId: 'openai', plainKey: key }],
        passphrase,
      },
    ];

    for (const attempt of attempts) {
      clearStorageCalls(harness);
      const error = await rejectionOf(() => AIClient.saveConfiguration(
        attempt.settings,
        attempt.updates,
        attempt.passphrase,
      ));
      expect(error).not.toBeNull();
      expect(containsSecret(error, [key, passphrase])).toBeFalse();
      expect(harness.calls.storage.local.get).toHaveLength(1);
      expect(harness.calls.storage.local.set).toHaveLength(0);
      expect(harness.calls.storage.session.set).toHaveLength(0);
    }
  });

  test('allows valid weak secrets that only coincide with fixed public metadata', async () => {
    installChromeMock();
    expect(await AIClient.saveConfiguration(
      publicSettings('passphrase'),
      [{ providerId: 'openai', plainKey: 'default' }],
      'passphrase',
    )).toEqual({ saved: true, unlocked: true });
    const stored = readStorageArea('local').aiSettings;
    expect(JSON.stringify(stored)).not.toContain('"apiKey":"default"');
    expect(stored.providerConfigs.openai.apiKey.usesPassphrase).toBeTrue();
  });

  test('rejects a submitted credential previously staged in an unchanged public field', async () => {
    const harness = installChromeMock();
    const stagedCredential = syntheticSecret('staged-public-credential');
    const stagedSettings = publicSettings('device', {
      providerConfigs: { openai: { model: stagedCredential } },
    });

    expect(await AIClient.saveConfiguration(stagedSettings, [], null)).toEqual({
      saved: true,
      unlocked: true,
    });
    const beforeLocal = cloneBytes(readStorageArea('local'));
    const beforeSession = cloneBytes(readStorageArea('session'));
    clearStorageCalls(harness);

    const error = await rejectionOf(() => AIClient.saveConfiguration(
      stagedSettings,
      [{ providerId: 'openai', plainKey: stagedCredential }],
      null,
    ));

    expect(error instanceof TypeError).toBeTrue();
    expect(containsSecret(error, [stagedCredential])).toBeFalse();
    expect(cloneBytes(readStorageArea('local'))).toBe(beforeLocal);
    expect(cloneBytes(readStorageArea('session'))).toBe(beforeSession);
    expect(harness.calls.storage.local.set).toHaveLength(0);
    expect(harness.calls.storage.session.set).toHaveLength(0);
  });

  test('allows HTTPS endpoints and HTTP only on the local loopback host', async () => {
    const allowedUrls = [
      'https://provider.example.test/v1',
      'http://localhost:11434/v1',
      'http://api.localhost:11434/v1',
      'http://127.0.0.1:11434/v1',
      'http://127.8.9.10:11434/v1',
      'http://[::1]:11434/v1',
    ];
    for (const baseUrl of allowedUrls) {
      installChromeMock();
      const result = await AIClient.saveConfiguration(publicSettings('device', {
        providerConfigs: { custom: { baseUrl } },
      }), [], null);
      expect(result.saved).toBeTrue();
      expect(readStorageArea('local').aiSettings.providerConfigs.custom.baseUrl).toBe(baseUrl);
    }
  });

  test('requires Custom key re-entry before moving a stored credential to another origin', async () => {
    const fixture = await passphraseFixture('custom');
    const oldBaseUrl = 'https://old-provider.example.test/v1';
    const newBaseUrl = 'https://new-provider.example.test/v1';
    const stored = privateSettings({
      providerId: 'custom',
      providerConfigs: {
        custom: { baseUrl: oldBaseUrl, apiKey: fixture.blob },
      },
      usePassphrase: true,
    });
    const harness = storageFixture(stored);
    await AIClient.unlockApiKey('custom', fixture.passphrase);
    const beforeLocal = cloneBytes(readStorageArea('local'));
    const beforeSession = cloneBytes(readStorageArea('session'));
    clearStorageCalls(harness);

    const movedSettings = publicSettings('passphrase', {
      providerId: 'custom',
      providerConfigs: { custom: { baseUrl: newBaseUrl } },
    });
    const error = await rejectionOf(() => AIClient.saveConfiguration(
      movedSettings,
      [],
      null,
    ));

    expect(error instanceof TypeError).toBeTrue();
    expect(cloneBytes(readStorageArea('local'))).toBe(beforeLocal);
    expect(cloneBytes(readStorageArea('session'))).toBe(beforeSession);
    expect(harness.calls.storage.local.set).toHaveLength(0);
    expect(harness.calls.storage.session.set).toHaveLength(0);

    const replacementKey = syntheticSecret('moved-custom-key');
    const replacementPassphrase = syntheticSecret('moved-custom-passphrase');
    expect(await AIClient.saveConfiguration(
      movedSettings,
      [{ providerId: 'custom', plainKey: replacementKey }],
      replacementPassphrase,
    )).toEqual({ saved: true, unlocked: true });
    expect(readStorageArea('local').aiSettings.providerConfigs.custom.baseUrl).toBe(newBaseUrl);
    expect(await AIClient.getApiKey('custom')).toBe(replacementKey);
  });

  test('binds a passphrase session entry to the Custom endpoint origin', async () => {
    const fixture = await passphraseFixture('custom');
    const settings = privateSettings({
      providerId: 'custom',
      providerConfigs: {
        custom: {
          baseUrl: 'https://provider.example.test/v1',
          apiKey: fixture.blob,
        },
      },
      usePassphrase: true,
    });
    storageFixture(settings);
    await AIClient.unlockApiKey('custom', fixture.passphrase);
    expect(await AIClient.needsPassphrase('custom')).toBeFalse();

    settings.providerConfigs.custom.baseUrl = 'https://redirect.example.test/v1';
    await chrome.storage.local.set({ aiSettings: settings });

    expect(await AIClient.needsPassphrase('custom')).toBeTrue();
    expect(await AIClient.getApiKey('custom')).toBeNull();
  });

  test('preserves every blob byte-for-byte for same-mode public-only edits', async () => {
    const openai = await passphraseFixture('openai');
    const claude = await passphraseFixture('claude');
    const stored = privateSettings({
      usePassphrase: false,
      providerConfigs: {
        openai: { model: 'old-openai', apiKey: openai.blob },
        claude: { model: 'old-claude', apiKey: claude.blob },
      },
    });
    const harness = storageFixture(stored);
    clearStorageCalls(harness);
    const openaiBytes = cloneBytes(openai.blob);
    const claudeBytes = cloneBytes(claude.blob);

    expect(typeof AIClient.saveConfiguration).toBe('function');
    const result = await AIClient.saveConfiguration(publicSettings('passphrase', {
      providerId: 'openai',
      providerConfigs: {
        openai: { model: 'new-openai' },
        claude: { model: 'new-claude' },
      },
    }), [], null);
    expect(result).toEqual({ saved: true, unlocked: false });
    const after = readStorageArea('local').aiSettings;
    expect(cloneBytes(after.providerConfigs.openai.apiKey)).toBe(openaiBytes);
    expect(cloneBytes(after.providerConfigs.claude.apiKey)).toBe(claudeBytes);
    expect(after.usePassphrase).toBeTrue();
    expect(harness.calls.storage.local.set).toHaveLength(1);
    expect(harness.calls.storage.session.set).toHaveLength(0);
  });

  test('allows same-mode subset replacement while preserving other blobs', async () => {
    const first = await passphraseFixture('openai');
    const second = await passphraseFixture('claude');
    const replacementKey = syntheticSecret('replacement-openai-key');
    const replacementPassphrase = syntheticSecret('replacement-passphrase');
    const harness = storageFixture(privateSettings({
      usePassphrase: true,
      providerConfigs: {
        openai: { apiKey: first.blob },
        claude: { apiKey: second.blob },
      },
    }));
    clearStorageCalls(harness);
    const preservedBytes = cloneBytes(second.blob);

    expect(typeof AIClient.saveConfiguration).toBe('function');
    const result = await AIClient.saveConfiguration(
      publicSettings('passphrase'),
      [{ providerId: 'openai', plainKey: replacementKey }],
      replacementPassphrase,
    );
    expect(result).toEqual({ saved: true, unlocked: true });
    const after = readStorageArea('local').aiSettings;
    expect(cloneBytes(after.providerConfigs.claude.apiKey)).toBe(preservedBytes);
    expect(after.providerConfigs.openai.apiKey.usesPassphrase).toBeTrue();
    expect((await decryptApiKey(
      after.providerConfigs.openai.apiKey,
      replacementPassphrase,
    )) === replacementKey).toBeTrue();
    expect(harness.calls.storage.local.set).toHaveLength(1);
    expect(harness.calls.storage.session.set).toHaveLength(1);
  });

  test('requires every stored key for either uniform protection-mode change', async () => {
    const deviceOpenAI = await deviceFixture('openai');
    installChromeMock({ local: { installId: deviceOpenAI.installId } });
    const deviceClaudeKey = syntheticSecret('claude-device-key');
    const deviceClaudeBlob = await encryptApiKey(deviceClaudeKey);
    let harness = storageFixture(privateSettings({
      providerConfigs: {
        openai: { apiKey: deviceOpenAI.blob },
        claude: { apiKey: deviceClaudeBlob },
      },
    }), { installId: deviceOpenAI.installId });
    clearStorageCalls(harness);

    expect(typeof AIClient.saveConfiguration).toBe('function');
    const missingForPassphrase = await rejectionOf(() => AIClient.saveConfiguration(
      publicSettings('passphrase'),
      [{ providerId: 'openai', plainKey: syntheticSecret('new-openai') }],
      syntheticSecret('new-passphrase'),
    ));
    expect(missingForPassphrase?.message).toBe(
      'Re-enter every saved API key before changing key protection.',
    );
    expect(harness.calls.storage.local.set).toHaveLength(0);
    expect(harness.calls.storage.session.set).toHaveLength(0);

    const protectedOpenAI = await passphraseFixture('openai');
    const protectedClaude = await passphraseFixture('claude');
    harness = storageFixture(privateSettings({
      usePassphrase: true,
      providerConfigs: {
        openai: { apiKey: protectedOpenAI.blob },
        claude: { apiKey: protectedClaude.blob },
      },
    }));
    clearStorageCalls(harness);
    const missingForDevice = await rejectionOf(() => AIClient.saveConfiguration(
      publicSettings('device'),
      [{ providerId: 'openai', plainKey: syntheticSecret('device-openai') }],
      null,
    ));
    expect(missingForDevice?.message).toBe(
      'Re-enter every saved API key before changing key protection.',
    );
    expect(harness.calls.storage.local.set).toHaveLength(0);
    expect(harness.calls.storage.session.set).toHaveLength(0);
  });

  test('normalizes all stored providers atomically in both protection directions', async () => {
    const deviceOpenAI = await deviceFixture('openai');
    installChromeMock({ local: { installId: deviceOpenAI.installId } });
    const originalClaudeKey = syntheticSecret('original-claude-device');
    const deviceClaudeBlob = await encryptApiKey(originalClaudeKey);
    let harness = storageFixture(privateSettings({
      providerConfigs: {
        openai: { apiKey: deviceOpenAI.blob },
        claude: { apiKey: deviceClaudeBlob },
      },
    }), { installId: deviceOpenAI.installId });
    clearStorageCalls(harness);
    const passphrase = syntheticSecret('normalize-passphrase');
    const passphraseKeys = {
      openai: syntheticSecret('normalized-openai'),
      claude: syntheticSecret('normalized-claude'),
    };

    expect(typeof AIClient.saveConfiguration).toBe('function');
    expect(await AIClient.saveConfiguration(
      publicSettings('passphrase'),
      Object.entries(passphraseKeys).map(([providerId, plainKey]) => ({ providerId, plainKey })),
      passphrase,
    )).toEqual({ saved: true, unlocked: true });
    let after = readStorageArea('local').aiSettings;
    expect(after.usePassphrase).toBeTrue();
    expect(after.providerConfigs.openai.apiKey.usesPassphrase).toBeTrue();
    expect(after.providerConfigs.claude.apiKey.usesPassphrase).toBeTrue();
    expect(harness.calls.storage.local.set).toHaveLength(1);
    expect(harness.calls.storage.session.set).toHaveLength(1);

    const deviceKeys = {
      openai: syntheticSecret('renormalized-openai'),
      claude: syntheticSecret('renormalized-claude'),
    };
    clearStorageCalls(harness);
    expect(await AIClient.saveConfiguration(
      publicSettings('device'),
      Object.entries(deviceKeys).map(([providerId, plainKey]) => ({ providerId, plainKey })),
      null,
    )).toEqual({ saved: true, unlocked: true });
    after = readStorageArea('local').aiSettings;
    expect(after.usePassphrase).toBeFalse();
    expect(after.providerConfigs.openai.apiKey.usesPassphrase).toBeFalse();
    expect(after.providerConfigs.claude.apiKey.usesPassphrase).toBeFalse();
    expect((await decryptApiKey(after.providerConfigs.openai.apiKey)) === deviceKeys.openai).toBeTrue();
    expect((await decryptApiKey(after.providerConfigs.claude.apiKey)) === deviceKeys.claude).toBeTrue();
  });

  test('preserves mixed blobs only for a public-only mixed save', async () => {
    const protectedFixture = await passphraseFixture('openai');
    const device = await deviceFixture('claude');
    const harness = storageFixture(privateSettings({
      usePassphrase: false,
      providerConfigs: {
        openai: { apiKey: protectedFixture.blob },
        claude: { apiKey: device.blob },
      },
    }), { installId: device.installId });
    const beforeOpenAI = cloneBytes(protectedFixture.blob);
    const beforeClaude = cloneBytes(device.blob);
    clearStorageCalls(harness);

    expect(typeof AIClient.saveConfiguration).toBe('function');
    expect(await AIClient.saveConfiguration(
      publicSettings('mixed', { providerId: 'custom' }),
      [],
      null,
    )).toEqual({ saved: true, unlocked: true });
    let after = readStorageArea('local').aiSettings;
    expect(after.usePassphrase).toBeNull();
    expect(cloneBytes(after.providerConfigs.openai.apiKey)).toBe(beforeOpenAI);
    expect(cloneBytes(after.providerConfigs.claude.apiKey)).toBe(beforeClaude);

    clearStorageCalls(harness);
    const error = await rejectionOf(() => AIClient.saveConfiguration(
      publicSettings('mixed'),
      [{ providerId: 'openai', plainKey: syntheticSecret('mixed-replacement') }],
      null,
    ));
    expect(error).not.toBeNull();
    expect(harness.calls.storage.local.set).toHaveLength(0);
    expect(harness.calls.storage.session.set).toHaveLength(0);
    after = readStorageArea('local').aiSettings;
    expect(cloneBytes(after.providerConfigs.openai.apiKey)).toBe(beforeOpenAI);
  });

  test('requires every stored provider when normalizing a mixed set', async () => {
    const protectedFixture = await passphraseFixture('openai');
    const device = await deviceFixture('claude');
    const harness = storageFixture(privateSettings({
      usePassphrase: null,
      providerConfigs: {
        openai: { apiKey: protectedFixture.blob },
        claude: { apiKey: device.blob },
      },
    }), { installId: device.installId });
    clearStorageCalls(harness);

    expect(typeof AIClient.saveConfiguration).toBe('function');
    const incomplete = await rejectionOf(() => AIClient.saveConfiguration(
      publicSettings('device'),
      [{ providerId: 'openai', plainKey: syntheticSecret('partial-normalization') }],
      null,
    ));
    expect(incomplete?.message).toBe(
      'Re-enter every saved API key before changing key protection.',
    );
    expect(harness.calls.storage.local.set).toHaveLength(0);
    expect(harness.calls.storage.session.set).toHaveLength(0);

    clearStorageCalls(harness);
    const replacements = {
      openai: syntheticSecret('mixed-device-openai'),
      claude: syntheticSecret('mixed-device-claude'),
    };
    expect(await AIClient.saveConfiguration(
      publicSettings('device'),
      Object.entries(replacements).map(([providerId, plainKey]) => ({ providerId, plainKey })),
      null,
    )).toEqual({ saved: true, unlocked: true });
    const after = readStorageArea('local').aiSettings;
    expect(after.usePassphrase).toBeFalse();
    expect(after.providerConfigs.openai.apiKey.usesPassphrase).toBeFalse();
    expect(after.providerConfigs.claude.apiKey.usesPassphrase).toBeFalse();
    expect(harness.calls.storage.local.set).toHaveLength(1);
    expect(harness.calls.storage.session.set).toHaveLength(1);
  });

  test('rejects unrealizable or inconsistent passphrase combinations before writing', async () => {
    const harness = storageFixture(privateSettings({ enabled: false, providerId: null }));
    expect(typeof AIClient.saveConfiguration).toBe('function');
    const key = syntheticSecret('new-key');
    const passphrase = syntheticSecret('new-passphrase');
    const invalid = [
      [publicSettings('passphrase'), [], null],
      [publicSettings('passphrase'), [{ providerId: 'openai', plainKey: key }], null],
      [publicSettings('passphrase'), [{ providerId: 'openai', plainKey: key }], ''],
      [publicSettings('device'), [{ providerId: 'openai', plainKey: key }], passphrase],
      [publicSettings('device'), [], passphrase],
      [publicSettings('mixed'), [], passphrase],
      [publicSettings('device'), [], undefined],
    ];
    for (const args of invalid) {
      clearStorageCalls(harness);
      const error = await rejectionOf(() => AIClient.saveConfiguration(...args));
      expect(error).not.toBeNull();
      expect(harness.calls.storage.local.set).toHaveLength(0);
      expect(harness.calls.storage.session.set).toHaveLength(0);
    }
  });
});

describe('Task 12 atomic persistence and session failure semantics', () => {
  test('finishes every encryption before one canonical local write and then one session batch', async () => {
    const harness = storageFixture(privateSettings(), {
      installId: syntheticSecret('seeded-install'),
    });
    clearStorageCalls(harness);
    const updates = KEY_PROVIDER_IDS.slice(0, 3).map((providerId) => ({
      providerId,
      plainKey: syntheticSecret(`${providerId}-new-key`),
    }));
    const order = [];
    const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const encryption = spyOn(crypto.subtle, 'encrypt');
    encryption.mockImplementation(async (...args) => {
      order.push('encrypt');
      return originalEncrypt(...args);
    });
    const originalLocalSet = chrome.storage.local.set.bind(chrome.storage.local);
    const originalSessionSet = chrome.storage.session.set.bind(chrome.storage.session);
    chrome.storage.local.set = async (items) => {
      if (Object.hasOwn(items, 'aiSettings')) order.push('local:aiSettings');
      return originalLocalSet(items);
    };
    chrome.storage.session.set = async (items) => {
      order.push('session:batch');
      return originalSessionSet(items);
    };
    let result;
    try {
      expect(typeof AIClient.saveConfiguration).toBe('function');
      result = await AIClient.saveConfiguration(
        publicSettings('device'),
        updates,
        null,
      );
    } finally {
      chrome.storage.local.set = originalLocalSet;
      chrome.storage.session.set = originalSessionSet;
      encryption.mockRestore();
    }
    expect(result).toEqual({ saved: true, unlocked: true });
    expect(order).toEqual([
      'encrypt',
      'encrypt',
      'encrypt',
      'local:aiSettings',
      'session:batch',
    ]);
    expect(harness.calls.storage.local.set).toHaveLength(1);
    expect(Object.keys(harness.calls.storage.local.set[0][0])).toEqual(['aiSettings']);
    expect(harness.calls.storage.session.set).toHaveLength(1);
    expect(Object.keys(harness.calls.storage.session.set[0][0]).sort()).toEqual(
      updates.map(({ providerId }) => SESSION_KEY_PREFIX + providerId).sort(),
    );
  });

  test('writes nothing when any encryption fails', async () => {
    const harness = storageFixture(privateSettings(), {
      installId: syntheticSecret('seeded-install'),
    });
    clearStorageCalls(harness);
    const encryption = spyOn(crypto.subtle, 'encrypt');
    encryption.mockRejectedValue(new Error('synthetic encryption failure'));
    try {
      expect(typeof AIClient.saveConfiguration).toBe('function');
      const error = await rejectionOf(() => AIClient.saveConfiguration(
        publicSettings('device'),
        [{ providerId: 'openai', plainKey: syntheticSecret('encryption-failure-key') }],
        null,
      ));
      expect(error).not.toBeNull();
      expect(harness.calls.storage.local.set).toHaveLength(0);
      expect(harness.calls.storage.session.set).toHaveLength(0);
    } finally {
      encryption.mockRestore();
    }
  });

  test('leaves the prior session byte-identical when the local settings write fails', async () => {
    const fixture = await passphraseFixture();
    const oldSession = { proof: syntheticSecret('old-session-proof') };
    const stored = privateSettings({
      providerConfigs: { openai: { apiKey: fixture.blob } },
      usePassphrase: true,
    });
    const harness = installChromeMock({
      local: { aiSettings: stored },
      session: { [SESSION_KEY_PREFIX + 'openai']: oldSession },
      failures: { 'storage.local.set': new Error('synthetic local failure') },
    });
    clearStorageCalls(harness);
    const beforeLocal = cloneBytes(readStorageArea('local'));
    const beforeSession = cloneBytes(readStorageArea('session'));

    expect(typeof AIClient.saveConfiguration).toBe('function');
    const error = await rejectionOf(() => AIClient.saveConfiguration(
      publicSettings('passphrase'),
      [{ providerId: 'openai', plainKey: syntheticSecret('replacement-key') }],
      syntheticSecret('replacement-passphrase'),
    ));
    expect(error).not.toBeNull();
    expect(cloneBytes(readStorageArea('local'))).toBe(beforeLocal);
    expect(cloneBytes(readStorageArea('session'))).toBe(beforeSession);
    expect(harness.calls.storage.session.set).toHaveLength(0);
  });

  test('keeps a valid local commit locked when the session batch fails and later unlock recovers it', async () => {
    const original = await passphraseFixture();
    storageFixture(privateSettings({
      providerConfigs: { openai: { apiKey: original.blob } },
      usePassphrase: true,
    }));
    expect(typeof AIClient.unlockApiKey).toBe('function');
    await AIClient.unlockApiKey('openai', original.passphrase);
    const staleEntry = sessionEntry('openai');

    const harness = installChromeMock({
      local: {
        aiSettings: privateSettings({
          providerConfigs: { openai: { apiKey: original.blob } },
          usePassphrase: true,
        }),
      },
      session: { [SESSION_KEY_PREFIX + 'openai']: staleEntry },
      failures: { 'storage.session.set': new Error('synthetic session failure') },
    });
    clearStorageCalls(harness);
    const replacementKey = syntheticSecret('committed-key');
    const replacementPassphrase = syntheticSecret('committed-passphrase');

    expect(typeof AIClient.saveConfiguration).toBe('function');
    const result = await AIClient.saveConfiguration(
      publicSettings('passphrase'),
      [{ providerId: 'openai', plainKey: replacementKey }],
      replacementPassphrase,
    );
    expect(result).toEqual({ saved: true, unlocked: false });
    const committed = readStorageArea('local').aiSettings.providerConfigs.openai.apiKey;
    expect(cloneBytes(committed) === cloneBytes(original.blob)).toBeFalse();
    expect((await decryptApiKey(committed, replacementPassphrase)) === replacementKey).toBeTrue();
    expect(await AIClient.getApiKey('openai')).toBeNull();
    expect(await AIClient.needsPassphrase('openai')).toBeTrue();
    expect(await AIClient.isAvailable()).toBeFalse();

    await AIClient.unlockApiKey('openai', replacementPassphrase);
    expect((await AIClient.getApiKey('openai')) === replacementKey).toBeTrue();
    expect(await AIClient.isAvailable()).toBeTrue();
  });

  test('uses one install ID for a fresh-profile multi-provider device save', async () => {
    const harness = storageFixture(privateSettings());
    clearStorageCalls(harness);
    const keys = {
      openai: syntheticSecret('fresh-openai-key'),
      claude: syntheticSecret('fresh-claude-key'),
      gemini: syntheticSecret('fresh-gemini-key'),
    };

    expect(typeof AIClient.saveConfiguration).toBe('function');
    expect(await AIClient.saveConfiguration(
      publicSettings('device'),
      Object.entries(keys).map(([providerId, plainKey]) => ({ providerId, plainKey })),
      null,
    )).toEqual({ saved: true, unlocked: true });

    const local = readStorageArea('local');
    expect(typeof local.installId).toBe('string');
    expect(local.installId.length > 0).toBeTrue();
    for (const [providerId, plainKey] of Object.entries(keys)) {
      expect((await decryptApiKey(
        local.aiSettings.providerConfigs[providerId].apiKey,
      )) === plainKey).toBeTrue();
    }
    const installWrites = harness.calls.storage.local.set.filter(
      ([items]) => Object.hasOwn(items, 'installId'),
    );
    const settingsWrites = harness.calls.storage.local.set.filter(
      ([items]) => Object.hasOwn(items, 'aiSettings'),
    );
    expect(installWrites).toHaveLength(1);
    expect(settingsWrites).toHaveLength(1);
  });

  test('defines public-only unlocked from the selected provider lock state', async () => {
    const fixture = await passphraseFixture();
    storageFixture(privateSettings({
      providerId: 'openai',
      providerConfigs: { openai: { apiKey: fixture.blob } },
      usePassphrase: true,
    }));

    expect(typeof AIClient.saveConfiguration).toBe('function');
    expect(await AIClient.saveConfiguration(
      publicSettings('passphrase', { providerId: 'openai' }),
      [],
      null,
    )).toEqual({ saved: true, unlocked: false });

    await AIClient.unlockApiKey('openai', fixture.passphrase);
    expect(await AIClient.saveConfiguration(
      publicSettings('passphrase', { providerId: 'openai' }),
      [],
      null,
    )).toEqual({ saved: true, unlocked: true });
  });
});

describe('Task 12 lock-aware availability and private provider reconstruction', () => {
  test('implements the complete provider availability truth table', async () => {
    const protectedFixture = await passphraseFixture();
    storageFixture(privateSettings({
      providerId: 'openai',
      providerConfigs: { openai: { apiKey: protectedFixture.blob } },
      usePassphrase: false,
    }));
    expect(await AIClient.isAvailable()).toBeFalse();
    await AIClient.unlockApiKey('openai', protectedFixture.passphrase);
    expect(await AIClient.isAvailable()).toBeTrue();

    const device = await deviceFixture();
    storageFixture(privateSettings({
      providerId: 'openai',
      providerConfigs: { openai: { apiKey: device.blob } },
    }), { installId: device.installId });
    expect(await AIClient.isAvailable()).toBeTrue();

    storageFixture(privateSettings({ providerId: 'openai' }));
    expect(await AIClient.isAvailable()).toBeFalse();

    storageFixture(privateSettings({ providerId: 'custom' }));
    expect(await AIClient.isAvailable()).toBeTrue();

    const customProtected = await passphraseFixture('custom');
    storageFixture(privateSettings({
      providerId: 'custom',
      providerConfigs: { custom: { apiKey: customProtected.blob } },
      usePassphrase: true,
    }));
    expect(await AIClient.isAvailable()).toBeFalse();
    await AIClient.unlockApiKey('custom', customProtected.passphrase);
    expect(await AIClient.isAvailable()).toBeTrue();

    storageFixture(privateSettings({ providerId: 'chrome-ai' }));
    expect(await AIClient.isAvailable()).toBeTrue();

    storageFixture(privateSettings({ enabled: false, providerId: 'chrome-ai' }));
    expect(await AIClient.isAvailable()).toBeFalse();
  });

  test('wrong unlock cannot flip availability and correct unlock can', async () => {
    const fixture = await passphraseFixture();
    storageFixture(privateSettings({
      providerId: 'openai',
      providerConfigs: { openai: { apiKey: fixture.blob } },
      usePassphrase: true,
    }));
    expect(typeof AIClient.unlockApiKey).toBe('function');
    await rejectionOf(() => AIClient.unlockApiKey(
      'openai',
      syntheticSecret('wrong-passphrase'),
    ));
    expect(await AIClient.isAvailable()).toBeFalse();
    await AIClient.unlockApiKey('openai', fixture.passphrase);
    expect(await AIClient.isAvailable()).toBeTrue();
  });

  test('reconstructs test-connection configuration from one private snapshot', async () => {
    const device = await deviceFixture();
    storageFixture(privateSettings({
      providerId: 'openai',
      providerConfigs: {
        openai: { model: 'stored-model-for-test', apiKey: device.blob },
      },
    }), { installId: device.installId });
    const original = OpenAIProvider.testConnection;
    let received;
    OpenAIProvider.testConnection = async (config) => {
      received = config;
      return true;
    };
    try {
      const result = await AIClient.testConnection('openai');
      expect(result).toBeTrue();
      expect(received?.model).toBe('stored-model-for-test');
      expect(received?.apiKey === device.plainKey).toBeTrue();
    } finally {
      OpenAIProvider.testConnection = original;
    }
  });

  test('reconstructs list-model configuration and keeps Custom keys optional', async () => {
    const device = await deviceFixture('claude');
    storageFixture(privateSettings({
      providerId: 'claude',
      providerConfigs: {
        claude: { model: 'stored-claude-model', apiKey: device.blob },
        custom: {
          model: 'stored-custom-model',
          baseUrl: 'https://custom.example.test/v1',
        },
      },
    }), { installId: device.installId });
    const originalClaude = ClaudeProvider.listModels;
    const originalCustom = CustomProvider.listModels;
    let claudeConfig;
    let customConfig;
    ClaudeProvider.listModels = async (config) => {
      claudeConfig = config;
      return [{ id: 'model-a', name: 'Model A' }];
    };
    CustomProvider.listModels = async (config) => {
      customConfig = config;
      return [{ id: 'model-b', name: 'Model B' }];
    };
    try {
      expect(await AIClient.listModels('claude')).toEqual([
        { id: 'model-a', name: 'Model A' },
      ]);
      expect(claudeConfig?.model).toBe('stored-claude-model');
      expect(claudeConfig?.apiKey === device.plainKey).toBeTrue();

      expect(await AIClient.listModels('custom')).toEqual([
        { id: 'model-b', name: 'Model B' },
      ]);
      expect(customConfig?.baseUrl).toBe('https://custom.example.test/v1');
      expect(Object.hasOwn(customConfig || {}, 'apiKey')).toBeFalse();
    } finally {
      ClaudeProvider.listModels = originalClaude;
      CustomProvider.listModels = originalCustom;
    }
  });

  test('never calls a cloud or keyed Custom provider while its key is locked', async () => {
    const openai = await passphraseFixture('openai');
    const custom = await passphraseFixture('custom');
    const originalOpenAI = OpenAIProvider.testConnection;
    const originalCustom = CustomProvider.listModels;
    let providerCalls = 0;
    OpenAIProvider.testConnection = async () => { providerCalls++; return true; };
    CustomProvider.listModels = async () => { providerCalls++; return []; };
    try {
      storageFixture(privateSettings({
        providerId: 'openai',
        providerConfigs: { openai: { apiKey: openai.blob } },
        usePassphrase: true,
      }));
      const openAIError = await rejectionOf(() => AIClient.testConnection('openai'));
      expect(openAIError instanceof AIDisabledError).toBeTrue();

      storageFixture(privateSettings({
        providerId: 'custom',
        providerConfigs: { custom: { apiKey: custom.blob } },
        usePassphrase: true,
      }));
      const customError = await rejectionOf(() => AIClient.listModels('custom'));
      expect(customError instanceof AIDisabledError).toBeTrue();
      expect(providerCalls).toBe(0);
    } finally {
      OpenAIProvider.testConnection = originalOpenAI;
      CustomProvider.listModels = originalCustom;
    }
  });

  test('fails closed when Custom has a malformed stored key instead of treating it as keyless', async () => {
    const malformedBlob = {
      ciphertext: 'synthetic-ciphertext',
      salt: 'synthetic-salt',
      iv: 'synthetic-iv',
      usesPassphrase: 'not-a-boolean',
    };
    storageFixture(privateSettings({
      providerId: 'custom',
      providerConfigs: {
        custom: {
          baseUrl: 'https://custom.example.test/v1',
          apiKey: malformedBlob,
        },
      },
    }));

    let providerCalls = 0;
    const originalTest = CustomProvider.testConnection;
    CustomProvider.testConnection = async () => {
      providerCalls++;
      return true;
    };
    try {
      expect(await AIClient.isAvailable()).toBeFalse();
      const error = await rejectionOf(() => AIClient.testConnection('custom'));
      expect(error instanceof AIDisabledError).toBeTrue();
      expect(providerCalls).toBe(0);
    } finally {
      CustomProvider.testConnection = originalTest;
    }
  });

  test('sanitizes provider failures before an echoed private key can escape', async () => {
    const device = await deviceFixture('custom');
    storageFixture(privateSettings({
      providerId: 'custom',
      providerConfigs: {
        custom: {
          apiKey: device.blob,
          baseUrl: 'https://provider.example.test/v1',
        },
      },
    }), { installId: device.installId });

    const originalComplete = CustomProvider.complete;
    const originalWithTimeout = AIClient._withTimeout;
    const originalSetTimeout = globalThis.setTimeout;
    let providerSawPrivateKey = false;
    CustomProvider.complete = async (_request, config) => {
      providerSawPrivateKey = config.apiKey === device.plainKey;
      throw new AINetworkError(`Provider echoed ${config.apiKey}`);
    };
    AIClient._withTimeout = (promise) => promise;
    globalThis.setTimeout = (callback) => {
      queueMicrotask(callback);
      return 0;
    };
    try {
      const error = await rejectionOf(() => AIClient.complete({
        systemPrompt: 'system',
        userPrompt: 'user',
      }));
      expect(providerSawPrivateKey).toBeTrue();
      expect(error instanceof AINetworkError).toBeTrue();
      expect(error?.message).toBe('Network error');
      expect(containsSecret(error, [device.plainKey])).toBeFalse();
    } finally {
      CustomProvider.complete = originalComplete;
      AIClient._withTimeout = originalWithTimeout;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('sanitizes connection-test exceptions before the private key can escape', async () => {
    const device = await deviceFixture('openai');
    storageFixture(privateSettings({
      providerId: 'openai',
      providerConfigs: { openai: { apiKey: device.blob } },
    }), { installId: device.installId });
    const originalTest = OpenAIProvider.testConnection;
    OpenAIProvider.testConnection = async (config) => {
      throw new AINetworkError(`Provider echoed ${config.apiKey}`);
    };
    try {
      const error = await rejectionOf(() => AIClient.testConnection('openai'));
      expect(error instanceof AINetworkError).toBeTrue();
      expect(error?.message).toBe('Network error');
      expect(containsSecret(error, [device.plainKey])).toBeFalse();
    } finally {
      OpenAIProvider.testConnection = originalTest;
    }
  });

  test('rejects a successful provider response that echoes the decrypted key before caching', async () => {
    const device = await deviceFixture('custom');
    storageFixture(privateSettings({
      providerId: 'custom',
      providerConfigs: {
        custom: {
          apiKey: device.blob,
          baseUrl: 'https://provider.example.test/v1',
        },
      },
    }), { installId: device.installId });
    const originalComplete = CustomProvider.complete;
    const originalWithTimeout = AIClient._withTimeout;
    const originalSetTimeout = globalThis.setTimeout;
    CustomProvider.complete = async (_request, config) => ({
      text: `echo ${config.apiKey}`,
      parsed: { reflected: config.apiKey },
      tokensUsed: 1,
    });
    AIClient._withTimeout = (promise) => promise;
    globalThis.setTimeout = (callback) => {
      queueMicrotask(callback);
      return 0;
    };
    try {
      const error = await rejectionOf(() => AIClient.complete({
        systemPrompt: 'system',
        userPrompt: 'user',
      }));
      expect(error instanceof AINetworkError).toBeTrue();
      expect(error?.message).toBe('Network error');
      expect(containsSecret(error, [device.plainKey])).toBeFalse();
      expect(containsSecret(readStorageArea('local').aiCache, [device.plainKey])).toBeFalse();
    } finally {
      CustomProvider.complete = originalComplete;
      AIClient._withTimeout = originalWithTimeout;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('does not reuse a Custom response cache entry after the endpoint changes', async () => {
    const firstBaseUrl = 'https://first-provider.example.test/v1';
    const secondBaseUrl = 'https://second-provider.example.test/v1';
    storageFixture(privateSettings({
      providerId: 'custom',
      providerConfigs: { custom: { baseUrl: firstBaseUrl } },
    }));

    const originalComplete = CustomProvider.complete;
    const originalWithTimeout = AIClient._withTimeout;
    const originalSetTimeout = globalThis.setTimeout;
    let providerCalls = 0;
    CustomProvider.complete = async (_request, config) => {
      providerCalls++;
      return {
        text: config.baseUrl === firstBaseUrl ? 'first-endpoint' : 'second-endpoint',
        parsed: null,
        tokensUsed: 1,
      };
    };
    AIClient._withTimeout = (promise) => promise;
    globalThis.setTimeout = (callback) => {
      queueMicrotask(callback);
      return 0;
    };
    const request = { systemPrompt: 'same-system', userPrompt: 'same-user' };
    try {
      expect(await AIClient.complete(request)).toMatchObject({
        text: 'first-endpoint',
        fromCache: false,
      });
      await chrome.storage.local.set({
        aiSettings: privateSettings({
          providerId: 'custom',
          providerConfigs: { custom: { baseUrl: secondBaseUrl } },
        }),
      });

      expect(await AIClient.complete(request)).toMatchObject({
        text: 'second-endpoint',
        fromCache: false,
      });
      expect(providerCalls).toBe(2);
    } finally {
      CustomProvider.complete = originalComplete;
      AIClient._withTimeout = originalWithTimeout;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('does not reuse a response cache entry after replacing a provider credential', async () => {
    const first = await passphraseFixture('custom');
    const baseUrl = 'https://provider.example.test/v1';
    storageFixture(privateSettings({
      providerId: 'custom',
      providerConfigs: { custom: { baseUrl, apiKey: first.blob } },
      usePassphrase: true,
    }));
    await AIClient.unlockApiKey('custom', first.passphrase);

    const originalComplete = CustomProvider.complete;
    const originalWithTimeout = AIClient._withTimeout;
    const originalSetTimeout = globalThis.setTimeout;
    let providerCalls = 0;
    CustomProvider.complete = async (_request, config) => {
      providerCalls++;
      return {
        text: config.apiKey === first.plainKey ? 'first-account' : 'second-account',
        parsed: null,
        tokensUsed: 1,
      };
    };
    AIClient._withTimeout = (promise) => promise;
    globalThis.setTimeout = (callback) => {
      queueMicrotask(callback);
      return 0;
    };
    const request = { systemPrompt: 'same-system', userPrompt: 'same-user' };
    try {
      expect(await AIClient.complete(request)).toMatchObject({
        text: 'first-account',
        fromCache: false,
      });
      const replacementKey = syntheticSecret('second-account-key');
      const replacementPassphrase = syntheticSecret('second-account-passphrase');
      expect(await AIClient.saveConfiguration(
        publicSettings('passphrase', {
          providerId: 'custom',
          providerConfigs: { custom: { baseUrl } },
        }),
        [{ providerId: 'custom', plainKey: replacementKey }],
        replacementPassphrase,
      )).toEqual({ saved: true, unlocked: true });

      expect(await AIClient.complete(request)).toMatchObject({
        text: 'second-account',
        fromCache: false,
      });
      expect(providerCalls).toBe(2);
    } finally {
      CustomProvider.complete = originalComplete;
      AIClient._withTimeout = originalWithTimeout;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('Gemini model listing keeps its API key out of the request URL', async () => {
    const key = syntheticSecret('gemini-model-list-key');
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let requestHeaders = {};
    globalThis.fetch = async (url, options = {}) => {
      requestUrl = String(url);
      requestHeaders = options.headers || {};
      return { ok: true, async json() { return { models: [] }; } };
    };
    try {
      expect(await GeminiProvider.listModels({ apiKey: key })).toEqual([]);
      expect(requestUrl).not.toContain(key);
      expect(requestUrl).not.toContain('?key=');
      expect(requestHeaders['x-goog-api-key']).toBe(key);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('filters a keyed provider model list that reflects the decrypted key', async () => {
    const device = await deviceFixture('openai');
    storageFixture(privateSettings({
      providerId: 'openai',
      providerConfigs: { openai: { apiKey: device.blob } },
    }), { installId: device.installId });
    const originalList = OpenAIProvider.listModels;
    OpenAIProvider.listModels = async (config) => [{
      id: config.apiKey,
      name: `echo ${config.apiKey}`,
    }];
    try {
      const models = await AIClient.listModels('openai');
      expect(models).toEqual([]);
      expect(containsSecret(models, [device.plainKey])).toBeFalse();
    } finally {
      OpenAIProvider.listModels = originalList;
    }
  });

  test('keeps keyless Custom model listing available under the plaintext filter', async () => {
    storageFixture(privateSettings({
      providerId: 'custom',
      providerConfigs: {
        custom: { baseUrl: 'https://provider.example.test/v1' },
      },
    }));
    const originalList = CustomProvider.listModels;
    CustomProvider.listModels = async () => [{ id: 'safe-model', name: 'Safe model' }];
    try {
      expect(await AIClient.listModels('custom')).toEqual([
        { id: 'safe-model', name: 'Safe model' },
      ]);
    } finally {
      CustomProvider.listModels = originalList;
    }
  });
});

describe('Task 12 worker message and lock boundary', () => {
  test('returns exact secret-free public response shapes for all new actions', async () => {
    const fixture = await passphraseFixture();
    installChromeMock({
      local: {
        aiSettings: privateSettings({
          providerId: 'openai',
          providerConfigs: { openai: { apiKey: fixture.blob } },
          usePassphrase: true,
        }),
      },
    });
    const worker = await freshWorker('exact-responses');
    await settleWorkerStartup();
    const secrets = [fixture.plainKey, fixture.passphrase, fixture.blob.ciphertext];

    const settings = await worker.handleMessage({ action: 'getAISettings' });
    expect(settings.protectionMode).toBe('passphrase');
    expect(runtimeResponseShapeIsSecretFree(settings, secrets)).toBeTrue();

    expect(await worker.handleMessage({
      action: 'needsAIPassphrase',
      providerId: 'openai',
    })).toEqual({ needsPassphrase: true });

    expect(await worker.handleMessage({
      action: 'unlockAIApiKey',
      providerId: 'openai',
      passphrase: fixture.passphrase,
    })).toEqual({ unlocked: true });

    expect(await worker.handleMessage({
      action: 'saveAISettings',
      settings: publicSettings('passphrase'),
      keyUpdates: [],
      passphrase: null,
    })).toEqual({ saved: true, unlocked: true });
  });

  test('removes the split setAIApiKey route', async () => {
    const fixture = await passphraseFixture();
    installChromeMock();
    const worker = await freshWorker('removed-split-route');
    await settleWorkerStartup();
    const response = await worker.handleMessage({
      action: 'setAIApiKey',
      providerId: 'openai',
      plainKey: fixture.plainKey,
      passphrase: fixture.passphrase,
    });
    expect(response).toEqual({ error: 'Unknown action' });
    expect(readStorageArea('local').aiSettings).toBeUndefined();
    expect(readStorageArea('session')[SESSION_KEY_PREFIX + 'openai']).toBeUndefined();
  });

  test('rejects private test/list fields before provider or network work', async () => {
    installChromeMock();
    const worker = await freshWorker('private-provider-input');
    await settleWorkerStartup();
    const originalTest = OpenAIProvider.testConnection;
    const originalList = GeminiProvider.listModels;
    let providerCalls = 0;
    OpenAIProvider.testConnection = async () => { providerCalls++; return true; };
    GeminiProvider.listModels = async () => { providerCalls++; return []; };
    try {
      const privateFields = ['config', 'apiKey', 'passphrase', 'baseUrl', 'endpoint'];
      for (const field of privateFields) {
        const value = syntheticSecret(`injected-${field}`);
        const testError = await rejectionOf(() => worker.handleMessage({
          action: 'testAIConnection',
          providerId: 'openai',
          [field]: value,
        }));
        expect(testError).not.toBeNull();
        expect(containsSecret(testError, [value])).toBeFalse();

        const listError = await rejectionOf(() => worker.handleMessage({
          action: 'listModels',
          providerId: 'gemini',
          [field]: value,
        }));
        expect(listError).not.toBeNull();
        expect(containsSecret(listError, [value])).toBeFalse();
      }
      expect(providerCalls).toBe(0);
    } finally {
      OpenAIProvider.testConnection = originalTest;
      GeminiProvider.listModels = originalList;
    }
  });

  test('validates every new AI action as an exact untrusted message', async () => {
    installChromeMock({ local: { aiSettings: privateSettings() } });
    const worker = await freshWorker('strict-ai-messages');
    await settleWorkerStartup();
    const passphrase = syntheticSecret('runtime-validation-passphrase');
    const key = syntheticSecret('runtime-validation-key');
    const malformed = [
      { action: 'getAISettings', passphrase },
      { action: 'needsAIPassphrase' },
      { action: 'needsAIPassphrase', providerId: 'unknown' },
      { action: 'needsAIPassphrase', providerId: 'openai', config: {} },
      { action: 'unlockAIApiKey', providerId: 'openai' },
      { action: 'unlockAIApiKey', providerId: 'openai', passphrase: 1 },
      { action: 'unlockAIApiKey', providerId: 'openai', passphrase, apiKey: key },
      {
        action: 'saveAISettings',
        settings: publicSettings('device'),
        keyUpdates: [],
      },
      {
        action: 'saveAISettings',
        settings: publicSettings('device'),
        keyUpdates: [{ providerId: 'openai', plainKey: key }],
        passphrase: null,
        trusted: true,
      },
    ];

    for (const message of malformed) {
      const error = await rejectionOf(() => worker.handleMessage(message));
      expect(error).not.toBeNull();
      expect(containsSecret(error, [passphrase, key])).toBeFalse();
    }
  });

  test('returns exact test/list envelopes from privately reconstructed config', async () => {
    const device = await deviceFixture();
    installChromeMock({
      local: {
        installId: device.installId,
        aiSettings: privateSettings({
          providerId: 'openai',
          providerConfigs: { openai: { apiKey: device.blob } },
        }),
      },
    });
    const worker = await freshWorker('provider-envelopes');
    await settleWorkerStartup();
    const originalTest = OpenAIProvider.testConnection;
    const originalList = OpenAIProvider.listModels;
    OpenAIProvider.testConnection = async () => true;
    OpenAIProvider.listModels = async () => [{ id: 'model-a', name: 'Model A' }];
    try {
      expect(await worker.handleMessage({
        action: 'testAIConnection', providerId: 'openai',
      })).toEqual({ success: true });
      expect(await worker.handleMessage({
        action: 'listModels', providerId: 'openai',
      })).toEqual({ models: [{ id: 'model-a', name: 'Model A' }] });
    } finally {
      OpenAIProvider.testConnection = originalTest;
      OpenAIProvider.listModels = originalList;
    }
  });

  test('rejects a sparse provider model list instead of serializing holes as null', async () => {
    installChromeMock();
    const worker = await freshWorker('sparse-model-envelope');
    await settleWorkerStartup();
    const models = new Array(2);
    models[1] = { id: 'model-b', name: 'Model B' };
    const aiClient = {
      async listModels() {
        return models;
      },
    };

    const error = await rejectionOf(() => worker.handleMessage({
      action: 'listModels',
      providerId: 'openai',
    }, { aiClient }));
    expect(error instanceof TypeError).toBeTrue();
  });

  test('keeps every AI runtime error and log free of submitted secrets', async () => {
    const fixture = await passphraseFixture();
    installChromeMock({
      local: {
        aiSettings: privateSettings({
          providerId: 'openai',
          providerConfigs: { openai: { apiKey: fixture.blob } },
          usePassphrase: true,
        }),
      },
    });
    await freshWorker('secret-free-runtime');
    await settleWorkerStartup();
    const wrong = syntheticSecret('wrong-runtime-passphrase');
    const logs = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args) => logs.push(args);
    console.error = (...args) => logs.push(args);
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'unlockAIApiKey',
        providerId: 'openai',
        passphrase: wrong,
      });
      expect(response).toEqual({ error: 'Incorrect passphrase' });
      expect(containsSecret(response, [fixture.plainKey, fixture.passphrase, wrong])).toBeFalse();
      expect(containsSecret(logs, [fixture.plainKey, fixture.passphrase, wrong])).toBeFalse();
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  test('keeps reflected provider-test failures out of runtime errors and logs', async () => {
    const device = await deviceFixture('openai');
    installChromeMock({
      local: {
        installId: device.installId,
        aiSettings: privateSettings({
          providerId: 'openai',
          providerConfigs: { openai: { apiKey: device.blob } },
        }),
      },
    });
    await freshWorker('provider-test-secret-runtime');
    await settleWorkerStartup();
    const originalTest = OpenAIProvider.testConnection;
    const originalWarn = console.warn;
    const logs = [];
    OpenAIProvider.testConnection = async (config) => {
      throw new AINetworkError(`Provider echoed ${config.apiKey}`);
    };
    console.warn = (...args) => logs.push(args);
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'testAIConnection',
        providerId: 'openai',
      });
      expect(response).toEqual({ error: 'Network error' });
      expect(containsSecret(response, [device.plainKey])).toBeFalse();
      expect(containsSecret(logs, [device.plainKey])).toBeFalse();
    } finally {
      OpenAIProvider.testConnection = originalTest;
      console.warn = originalWarn;
    }
  });

  test('does not echo an untrusted secret-bearing field name in runtime errors or logs', async () => {
    installChromeMock();
    await freshWorker('secret-field-name');
    await settleWorkerStartup();
    const secretFieldName = syntheticSecret('private-field-name');
    const logs = [];
    const originalWarn = console.warn;
    console.warn = (...args) => logs.push(args);
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'testAIConnection',
        providerId: 'openai',
        [secretFieldName]: true,
      });
      expect(response && typeof response.error === 'string').toBeTrue();
      expect(containsSecret(response, [secretFieldName])).toBeFalse();
      expect(containsSecret(logs, [secretFieldName])).toBeFalse();
    } finally {
      console.warn = originalWarn;
    }
  });

  test('does not echo a secret-bearing unknown action in runtime errors or logs', async () => {
    installChromeMock();
    await freshWorker('secret-action-name');
    await settleWorkerStartup();
    const secretAction = syntheticSecret('private-action-name');
    const logs = [];
    const originalWarn = console.warn;
    console.warn = (...args) => logs.push(args);
    try {
      const response = await chrome.runtime.sendMessage({ action: secretAction });
      expect(response).toEqual({ error: 'Unknown action' });
      expect(containsSecret(response, [secretAction])).toBeFalse();
      expect(containsSecret(logs, [secretAction])).toBeFalse();
    } finally {
      console.warn = originalWarn;
    }
  });

  test('clears legacy AI response cache on extension update', async () => {
    const legacySecret = syntheticSecret('legacy-cached-key');
    installChromeMock({
      local: {
        aiCache: {
          unrelatedPrompt: {
            response: { text: legacySecret, parsed: null, tokensUsed: 1 },
            timestamp: Date.now(),
            accessedAt: Date.now(),
          },
        },
      },
    });
    await freshWorker('legacy-ai-cache-update');
    await settleWorkerStartup();
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = () => 0;
    try {
      await chrome.runtime.onInstalled.dispatch({ reason: 'update' });
      expect(readStorageArea('local').aiCache).toBeUndefined();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('gives save and unlock exactly one outer worker mutation-lock boundary', async () => {
    const source = await Bun.file(new URL('../../service-worker.js', import.meta.url)).text();
    const actionBody = (action) => {
      const start = source.indexOf(`case '${action}'`);
      expect(start).toBeGreaterThan(-1);
      const nextCase = source.indexOf("case '", start + 6);
      const nextDefault = source.indexOf('default:', start + 6);
      const candidates = [nextCase, nextDefault].filter((index) => index >= 0);
      return source.slice(start, Math.min(...candidates));
    };

    for (const action of ['saveAISettings', 'unlockAIApiKey']) {
      const body = actionBody(action);
      expect(body.match(/withStateMutationLock/g) || []).toHaveLength(1);
    }
    expect(source.includes("case 'setAIApiKey'")).toBeFalse();

    const clientSource = await Bun.file(
      new URL('../../core/ai/ai-client.js', import.meta.url),
    ).text();
    expect(clientSource.includes('withStateMutationLock')).toBeFalse();
  });
});

describe('Task 12 side-panel plaintext boundary without a DOM emulator', () => {
  test('retains the one checked sendOrThrow adapter', () => {
    expect(AISettings.prototype.send.toString()).toContain('sendOrThrow');
  });

  test('dirty key input produces exact save-first copy and zero runtime calls', async () => {
    const submittedKey = syntheticSecret('dirty-ui-key');
    const testResult = { hidden: true, textContent: '', className: '' };
    const elements = {
      '#openai-api-key': { value: submittedKey },
      '#openai-model': { value: PROVIDER_DEFAULTS.openai.model },
      '#custom-base-url': { value: PROVIDER_DEFAULTS.custom.baseUrl },
    };
    const manager = Object.create(AISettings.prototype);
    manager.root = {
      querySelector(selector) { return elements[selector] || null; },
    };
    manager.providerSelect = { value: 'openai' };
    manager.testResultEl = testResult;
    manager.currentSettings = publicSettings('device');
    manager.settings = manager.currentSettings;
    manager.providerSettings = manager.currentSettings.providerConfigs;
    const messages = [];
    manager.send = async (message) => {
      messages.push(message);
      throw new Error('dirty configuration must not cross runtime');
    };

    await manager.testConnection();
    expect(messages).toHaveLength(0);
    expect(testResult.textContent).toBe(
      'Save AI settings before testing or loading models.',
    );
  });

  test('an unsaved provider selection blocks both provider actions before runtime', async () => {
    const saveFirst = 'Save AI settings before testing or loading models.';
    const testResult = { hidden: true, textContent: '', className: '' };
    const elements = {
      '#gemini-api-key': { value: '' },
      '#gemini-model': { value: PROVIDER_DEFAULTS.gemini.model },
      '.btn-load-models[data-provider="gemini"]': { textContent: 'Load', disabled: false },
    };
    const manager = Object.create(AISettings.prototype);
    manager.root = {
      querySelector(selector) { return elements[selector] || null; },
      querySelectorAll() { return []; },
    };
    manager.providerSelect = { value: 'gemini', disabled: false };
    manager.testButton = { disabled: false };
    manager.saveButton = { disabled: false };
    manager.testResultEl = testResult;
    manager.currentSettings = publicSettings('device', { providerId: 'openai' });
    manager.providerSettings = manager.currentSettings.providerConfigs;
    const messages = [];
    manager.send = async (message) => {
      messages.push(message);
      throw new Error('unsaved provider selection must not cross runtime');
    };

    const toastMessages = [];
    const originalDocument = globalThis.document;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.document = {
      getElementById: () => ({
        appendChild(toast) { toastMessages.push(toast.children[0]?.textContent); },
      }),
      createElement: () => ({
        children: [],
        style: {},
        appendChild(child) { this.children.push(child); },
        addEventListener() {},
        remove() {},
      }),
    };
    globalThis.setTimeout = () => 0;
    try {
      expect(await manager.testConnection()).toBeFalse();
      expect(await manager.loadModels('gemini')).toBeFalse();
      expect(testResult.textContent).toBe(saveFirst);
      expect(toastMessages).toEqual([saveFirst]);
      expect(messages).toEqual([]);
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('locked provider produces exact unlock-first copy and zero provider actions', async () => {
    const unlockFirst = 'Unlock this provider before testing or loading models.';
    const testResult = { hidden: true, textContent: '', className: '' };
    const modelSelect = { value: PROVIDER_DEFAULTS.openai.model };
    const elements = {
      '#openai-api-key': { value: '' },
      '#openai-model': modelSelect,
      '.btn-load-models[data-provider="openai"]': {
        textContent: 'Load',
        disabled: false,
      },
    };
    const manager = Object.create(AISettings.prototype);
    manager.root = {
      querySelector(selector) { return elements[selector] || null; },
    };
    manager.providerSelect = { value: 'openai' };
    manager.testResultEl = testResult;
    manager.currentSettings = publicSettings('passphrase', {
      providerConfigs: {
        openai: { hasApiKey: true, usesPassphrase: true },
      },
    });
    manager.settings = manager.currentSettings;
    manager.providerSettings = manager.currentSettings.providerConfigs;

    const messages = [];
    manager.send = async (message) => {
      messages.push(message);
      if (message.action === 'needsAIPassphrase') {
        return { needsPassphrase: true };
      }
      throw new Error('locked provider action must not cross runtime');
    };

    const toastMessages = [];
    const toastContainer = {
      appendChild(toast) {
        toastMessages.push(toast.children[0]?.textContent);
      },
    };
    const originalDocument = globalThis.document;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.document = {
      getElementById: (id) => id === 'toast-container' ? toastContainer : null,
      createElement: () => ({
        children: [],
        style: {},
        appendChild(child) { this.children.push(child); },
        addEventListener() {},
        remove() {},
      }),
    };
    globalThis.setTimeout = () => 0;

    try {
      expect(await manager.testConnection()).toBeFalse();
      await manager.loadModels('openai');

      expect(testResult.textContent).toBe(unlockFirst);
      expect(toastMessages).toEqual([unlockFirst]);
      expect(messages).toEqual([
        { action: 'needsAIPassphrase', providerId: 'openai' },
        { action: 'needsAIPassphrase', providerId: 'openai' },
      ]);
      expect(messages.filter(({ action }) =>
        action === 'testAIConnection' || action === 'listModels')).toHaveLength(0);
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('a provider action rechecks dirty state after the async lock-status query', async () => {
    const readiness = deferred();
    const keyInput = { value: '' };
    const testResult = { hidden: true, textContent: '', className: '' };
    const elements = {
      '#openai-api-key': keyInput,
      '#openai-model': { value: PROVIDER_DEFAULTS.openai.model },
    };
    const manager = Object.create(AISettings.prototype);
    manager.root = {
      querySelector(selector) { return elements[selector] || null; },
    };
    manager.providerSelect = { value: 'openai' };
    manager.testResultEl = testResult;
    manager.currentSettings = publicSettings('device');
    manager.providerSettings = manager.currentSettings.providerConfigs;
    const messages = [];
    manager.send = async (message) => {
      messages.push(message);
      if (message.action === 'needsAIPassphrase') return readiness.promise;
      if (message.action === 'testAIConnection') return { success: true };
      throw new Error('unexpected action');
    };

    const pending = manager.testConnection();
    await Promise.resolve();
    keyInput.value = syntheticSecret('late-dirty-key');
    readiness.resolve({ needsPassphrase: false });

    expect(await pending).toBeFalse();
    expect(messages).toEqual([
      { action: 'needsAIPassphrase', providerId: 'openai' },
    ]);
    expect(testResult.textContent).toBe(
      'Save AI settings before testing or loading models.',
    );
  });

  test('test connection accepts only the exact boolean response envelope', async () => {
    const manager = Object.create(AISettings.prototype);
    manager.root = {
      querySelector(selector) {
        if (selector === '#openai-api-key') return { value: '' };
        if (selector === '#openai-model') return { value: PROVIDER_DEFAULTS.openai.model };
        return null;
      },
      querySelectorAll() { return []; },
    };
    manager.providerSelect = { value: 'openai', disabled: false };
    manager.testResultEl = { hidden: true, textContent: '', className: '' };
    manager.testButton = { disabled: false };
    manager.saveButton = { disabled: false };
    manager.currentSettings = publicSettings('device');
    manager.providerSettings = manager.currentSettings.providerConfigs;
    manager.send = async ({ action }) => action === 'needsAIPassphrase'
      ? { needsPassphrase: false }
      : { success: 'yes', private: syntheticSecret('malformed-test-response') };

    expect(await manager.testConnection()).toBeFalse();
    expect(manager.testResultEl.textContent).toBe('Connection test failed.');
  });

  test('model loading rejects non-exact model envelopes without rendering private fields', async () => {
    const secret = syntheticSecret('private-model-response');
    const options = [];
    const select = {
      value: PROVIDER_DEFAULTS.openai.model,
      innerHTML: 'unchanged',
      appendChild(option) { options.push(option); },
    };
    const button = { textContent: 'Load', disabled: false };
    const manager = Object.create(AISettings.prototype);
    manager.root = {
      querySelector(selector) {
        if (selector === '#openai-api-key') return { value: '' };
        if (selector === '#openai-model') return select;
        if (selector.includes('.btn-load-models')) return button;
        return null;
      },
      querySelectorAll() { return []; },
    };
    manager.providerSelect = { value: 'openai', disabled: false };
    manager.testButton = { disabled: false };
    manager.saveButton = { disabled: false };
    manager.currentSettings = publicSettings('device');
    manager.providerSettings = manager.currentSettings.providerConfigs;
    manager.send = async ({ action }) => action === 'needsAIPassphrase'
      ? { needsPassphrase: false }
      : { models: [{ id: 'model', name: 'Model', private: secret }] };

    const toastText = [];
    const originalDocument = globalThis.document;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.document = {
      getElementById: () => ({
        appendChild(toast) { toastText.push(toast.children[0]?.textContent); },
      }),
      createElement: () => ({
        children: [],
        style: {},
        appendChild(child) { this.children.push(child); },
        addEventListener() {},
        remove() {},
      }),
    };
    globalThis.setTimeout = () => 0;
    try {
      expect(await manager.loadModels('openai')).toBeFalse();
      expect(select.innerHTML).toBe('unchanged');
      expect(options).toEqual([]);
      expect(containsSecret(toastText, [secret])).toBeFalse();
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('a stale provider response cannot render after the selection changes', async () => {
    const resultGate = deferred();
    const manager = Object.create(AISettings.prototype);
    manager.root = {
      querySelector(selector) {
        if (selector === '#openai-api-key') return { value: '' };
        if (selector === '#openai-model') return { value: PROVIDER_DEFAULTS.openai.model };
        return null;
      },
      querySelectorAll() { return []; },
    };
    manager.providerSelect = { value: 'openai', disabled: false };
    manager.providerPanels = {};
    manager.testResultEl = { hidden: true, textContent: '', className: '' };
    manager.testButton = { disabled: false };
    manager.saveButton = { disabled: false };
    manager.currentSettings = publicSettings('device');
    manager.providerSettings = manager.currentSettings.providerConfigs;
    manager.refreshUnlockState = async () => false;
    manager.send = async ({ action }) => action === 'needsAIPassphrase'
      ? { needsPassphrase: false }
      : resultGate.promise;

    const pending = manager.testConnection();
    await Promise.resolve();
    await Promise.resolve();
    manager.providerSelect.value = 'gemini';
    await manager.handleProviderChange();
    resultGate.resolve({ success: true });

    expect(await pending).toBeFalse();
    expect(manager.testResultEl.textContent).not.toBe('Connection successful!');
  });

  test('repeated full refreshes cannot overlap or clear newly typed keys', async () => {
    const first = deferred();
    const keyInput = { value: '', placeholder: '' };
    const modelInput = {
      value: PROVIDER_DEFAULTS.openai.model,
      options: [{ value: PROVIDER_DEFAULTS.openai.model }],
      appendChild() {},
    };
    const manager = Object.create(AISettings.prototype);
    manager.root = {
      querySelector(selector) {
        if (selector === '#openai-api-key') return keyInput;
        if (selector === '#openai-model') return modelInput;
        if (selector.endsWith('-api-key')) return { value: '', placeholder: '' };
        if (selector.endsWith('-model')) return null;
        if (selector === '#custom-base-url') return { value: '' };
        return null;
      },
      querySelectorAll() { return [keyInput, modelInput]; },
    };
    manager.enabledCheckbox = { checked: false };
    manager.configSection = { hidden: true };
    manager.providerSelect = { value: '' };
    manager.providerPanels = {};
    manager.passphraseToggle = { checked: false, indeterminate: false };
    manager.passphraseSection = { hidden: true };
    manager.passphraseInput = { value: '' };
    manager.testResultEl = { hidden: true };
    manager.showProviderConfig = () => {};
    manager.refreshUnlockState = async () => false;
    manager.checkChromeAI = async () => {};
    manager.refreshKeepAwakeList = async () => {};
    let call = 0;
    manager.send = async () => { call++; return first.promise; };

    const current = manager.refresh();
    expect(await manager.refresh()).toBeFalse();
    expect(call).toBe(1);
    expect(keyInput.disabled).toBeTrue();
    first.resolve(publicSettings('device', { providerId: 'gemini' }));
    expect(await current).toBeTrue();
    const typed = syntheticSecret('typed-after-current-refresh');
    keyInput.value = typed;
    expect(manager.providerSelect.value).toBe('gemini');
    expect(keyInput.value).toBe(typed);
    expect(keyInput.disabled).toBeFalse();
  });

  test('an external refresh cannot erase plaintext owned by an active save', async () => {
    const key = syntheticSecret('save-owned-key');
    const keyInput = { value: key, placeholder: '', disabled: true };
    const manager = Object.create(AISettings.prototype);
    manager.activeOperation = Symbol('save');
    manager.saveInFlight = true;
    manager.root = {
      querySelector(selector) {
        if (selector === '#openai-api-key') return keyInput;
        return null;
      },
      querySelectorAll() { return [keyInput]; },
    };
    manager.send = async () => publicSettings('device');

    expect(await manager.refresh()).toBeFalse();
    expect(keyInput.value).toBe(key);
  });

  test('save, unlock, and provider actions share one non-overlapping UI owner', () => {
    const controls = [
      { disabled: false },
      { disabled: false },
      { disabled: false },
      { disabled: false },
    ];
    const manager = Object.create(AISettings.prototype);
    manager.root = { querySelectorAll: () => controls };
    [manager.providerSelect, manager.unlockPassphraseInput,
      manager.unlockButton, manager.saveButton] = controls;
    manager.testButton = { disabled: false };

    const releaseUnlock = manager.beginUnlockOwnership();
    expect(typeof releaseUnlock).toBe('function');
    expect(manager.beginSaveOwnership()).toBeNull();
    expect(controls.every(({ disabled }) => disabled)).toBeTrue();
    releaseUnlock();
    expect(controls.every(({ disabled }) => !disabled)).toBeTrue();
  });

  test('a stale lock-status response cannot mutate the newly selected provider UI', async () => {
    const readiness = deferred();
    const manager = Object.create(AISettings.prototype);
    manager.providerSelect = { value: 'openai' };
    manager.unlockSection = { hidden: true };
    manager.unlockPassphraseInput = { value: '' };
    manager.unlockResultEl = { hidden: true, textContent: '', className: '' };
    manager.send = async (message) => {
      expect(message).toEqual({ action: 'needsAIPassphrase', providerId: 'openai' });
      return readiness.promise;
    };

    const pending = manager.refreshUnlockState();
    manager.providerSelect.value = 'chrome-ai';
    readiness.resolve({ needsPassphrase: true });
    expect(await pending).toBeFalse();
    expect(manager.unlockSection.hidden).toBeTrue();
  });

  test('a superseded same-provider lock-status response cannot reopen the unlock UI', async () => {
    const first = deferred();
    const second = deferred();
    const manager = Object.create(AISettings.prototype);
    manager.providerSelect = { value: 'openai' };
    manager.unlockSection = { hidden: true };
    manager.unlockPassphraseInput = { value: '' };
    manager.unlockResultEl = { hidden: true, textContent: '', className: '' };
    let call = 0;
    manager.send = async () => (++call === 1 ? first.promise : second.promise);

    const stale = manager.refreshUnlockState();
    const current = manager.refreshUnlockState();
    second.resolve({ needsPassphrase: false });
    expect(await current).toBeFalse();
    first.resolve({ needsPassphrase: true });
    expect(await stale).toBeFalse();
    expect(manager.unlockSection.hidden).toBeTrue();
  });

  test('a pending provider switch cannot send the prior provider passphrase', async () => {
    const readiness = deferred();
    const priorPassphrase = syntheticSecret('prior-provider-passphrase');
    const manager = Object.create(AISettings.prototype);
    manager.providerSelect = { value: 'gemini' };
    manager.providerPanels = {};
    manager.unlockSection = { hidden: false };
    manager.unlockPassphraseInput = { value: priorPassphrase, disabled: false };
    manager.unlockButton = { disabled: false };
    manager.unlockResultEl = { hidden: false, textContent: 'Old provider', className: 'drive-status' };
    const messages = [];
    manager.send = async (message) => {
      messages.push(message);
      if (message.action === 'needsAIPassphrase') return readiness.promise;
      if (message.action === 'unlockAIApiKey') return { unlocked: true };
      throw new Error('unexpected action');
    };

    const switching = manager.handleProviderChange();
    expect(manager.unlockSection.hidden).toBeTrue();
    expect(manager.unlockPassphraseInput.value).toBe('');
    expect(manager.unlockPassphraseInput.disabled).toBeTrue();
    expect(manager.unlockButton.disabled).toBeTrue();
    expect(await manager.unlockSelectedProvider()).toBeFalse();
    expect(messages.filter(({ action }) => action === 'unlockAIApiKey')).toEqual([]);

    readiness.resolve({ needsPassphrase: true });
    await switching;
    expect(manager.unlockSection.hidden).toBeFalse();
    expect(manager.unlockPassphraseInput.value).toBe('');
    expect(manager.unlockPassphraseInput.disabled).toBeFalse();
    expect(manager.unlockButton.disabled).toBeFalse();
    expect(messages).toEqual([
      { action: 'needsAIPassphrase', providerId: 'gemini' },
    ]);
    expect(containsSecret(messages, [priorPassphrase])).toBeFalse();
  });

  test('a stale provider-status rejection cannot clear the current provider unlock UI', async () => {
    const staleStatus = deferred();
    const currentStatus = deferred();
    const manager = Object.create(AISettings.prototype);
    manager.providerSelect = { value: 'openai' };
    manager.providerPanels = {};
    manager.unlockSection = { hidden: true };
    manager.unlockPassphraseInput = { value: '', disabled: false };
    manager.unlockButton = { disabled: false };
    manager.unlockResultEl = { hidden: true, textContent: '', className: 'drive-status' };
    manager.send = async ({ providerId }) => (
      providerId === 'openai' ? staleStatus.promise : currentStatus.promise
    );
    let currentFailureHandlers = 0;
    const launchChange = () => manager.handleProviderChange().catch(() => {
      currentFailureHandlers++;
      manager.hideUnlockSection();
    });

    const stale = launchChange();
    manager.providerSelect.value = 'gemini';
    expect(await launchChange()).toBeFalse();

    staleStatus.reject(new Error('stale provider status failure'));
    expect(await stale).toBeFalse();
    expect(currentFailureHandlers).toBe(0);

    const current = launchChange();
    currentStatus.resolve({ needsPassphrase: true });
    expect(await current).toBeTrue();
    const currentPassphrase = syntheticSecret('current-provider-passphrase');
    manager.unlockPassphraseInput.value = currentPassphrase;
    expect(manager.unlockSection.hidden).toBeFalse();
    expect(manager.unlockPassphraseInput.value).toBe(currentPassphrase);
  });

  test('a stale same-provider status rejection cannot clear a newer unlock prompt', async () => {
    const staleStatus = deferred();
    const currentStatus = deferred();
    const manager = Object.create(AISettings.prototype);
    manager.providerSelect = { value: 'openai' };
    manager.unlockSection = { hidden: true };
    manager.unlockPassphraseInput = { value: '', disabled: false };
    manager.unlockButton = { disabled: false };
    manager.unlockResultEl = { hidden: true, textContent: '', className: 'drive-status' };
    let request = 0;
    manager.send = async () => (++request === 1 ? staleStatus.promise : currentStatus.promise);

    const stale = manager.refreshUnlockState();
    const current = manager.refreshUnlockState();
    currentStatus.resolve({ needsPassphrase: true });
    expect(await current).toBeTrue();
    const currentPassphrase = syntheticSecret('newer-same-provider-passphrase');
    manager.unlockPassphraseInput.value = currentPassphrase;

    staleStatus.reject(new Error('stale same-provider status failure'));
    expect(await stale).toBeFalse();
    expect(manager.unlockSection.hidden).toBeFalse();
    expect(manager.unlockPassphraseInput.value).toBe(currentPassphrase);
    expect(manager.unlockPassphraseInput.disabled).toBeFalse();
    expect(manager.unlockButton.disabled).toBeFalse();
  });

  test('provider-change status owns the form until a current locked result is usable', async () => {
    const status = deferred();
    const controls = [
      { disabled: false },
      { disabled: false },
      { disabled: false },
      { disabled: false },
      { disabled: false },
    ];
    const manager = Object.create(AISettings.prototype);
    manager.root = { querySelectorAll: () => controls };
    [manager.providerSelect, manager.unlockPassphraseInput, manager.unlockButton,
      manager.testButton, manager.saveButton] = controls;
    manager.providerSelect.value = 'openai';
    manager.providerPanels = {};
    manager.unlockPassphraseInput.value = '';
    manager.unlockSection = { hidden: true };
    manager.unlockResultEl = { hidden: true, textContent: '', className: 'drive-status' };
    manager.send = async () => status.promise;

    const pending = manager.handleProviderChange();
    expect(manager.activeOperation).not.toBeNull();
    expect(controls.every(({ disabled }) => disabled)).toBeTrue();
    expect(manager.beginSaveOwnership()).toBeNull();

    status.resolve({ needsPassphrase: true });
    await pending;
    expect(manager.activeOperation).toBeNull();
    expect(manager.unlockSection.hidden).toBeFalse();
    expect(manager.unlockPassphraseInput.disabled).toBeFalse();
    expect(manager.unlockButton.disabled).toBeFalse();
    expect(controls.every(({ disabled }) => !disabled)).toBeTrue();
  });

  test('a failed full-refresh lock query cannot expose old unlock plaintext to a new provider', async () => {
    const status = deferred();
    const oldPassphrase = syntheticSecret('refresh-old-provider-passphrase');
    const elements = {};
    const controls = [];
    for (const providerId of PROVIDER_IDS) {
      const model = {
        value: PROVIDER_DEFAULTS[providerId].model,
        disabled: false,
        options: [{ value: PROVIDER_DEFAULTS[providerId].model }],
        appendChild() {},
      };
      elements[`#${providerId}-model`] = model;
      controls.push(model);
    }
    elements['#custom-base-url'] = {
      value: PROVIDER_DEFAULTS.custom.baseUrl,
      disabled: false,
    };
    for (const providerId of KEY_PROVIDER_IDS) {
      elements[`#${providerId}-api-key`] = { value: '', placeholder: '', disabled: false };
    }

    const manager = Object.create(AISettings.prototype);
    manager.root = {
      querySelector(selector) { return elements[selector] || null; },
      querySelectorAll() { return controls; },
    };
    manager.enabledCheckbox = { checked: true, disabled: false };
    manager.configSection = { hidden: false };
    manager.providerSelect = { value: 'openai', disabled: false };
    manager.providerPanels = {};
    manager.passphraseToggle = { checked: true, indeterminate: false, disabled: false };
    manager.passphraseSection = { hidden: false };
    manager.passphraseInput = { value: '', disabled: false };
    manager.unlockSection = { hidden: false };
    manager.unlockPassphraseInput = { value: oldPassphrase, disabled: false };
    manager.unlockButton = { disabled: false };
    manager.unlockResultEl = { hidden: false, textContent: 'Old provider', className: 'drive-status' };
    manager.testButton = { disabled: false };
    manager.saveButton = { disabled: false };
    manager.testResultEl = { hidden: true };
    manager.showProviderConfig = () => {};
    manager.checkChromeAI = async () => {};
    manager.refreshKeepAwakeList = async () => {};
    const messages = [];
    manager.send = async (message) => {
      messages.push(message);
      if (message.action === 'getAISettings') {
        return publicSettings('passphrase', { providerId: 'gemini' });
      }
      if (message.action === 'needsAIPassphrase') return status.promise;
      if (message.action === 'unlockAIApiKey') return { unlocked: true };
      throw new Error('unexpected action');
    };

    const refreshing = manager.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.providerSelect.value).toBe('gemini');
    expect(manager.unlockSection.hidden).toBeTrue();
    expect(manager.unlockPassphraseInput.value).toBe('');
    expect(manager.unlockButton.disabled).toBeTrue();
    expect(await manager.unlockSelectedProvider()).toBeFalse();
    expect(messages.filter(({ action }) => action === 'unlockAIApiKey')).toEqual([]);

    status.reject(new Error('current provider status unavailable'));
    expect(await rejectionOf(() => refreshing)).not.toBeNull();
    expect(manager.unlockSection.hidden).toBeTrue();
    expect(manager.unlockPassphraseInput.value).toBe('');
    expect(await manager.unlockSelectedProvider()).toBeFalse();
    expect(messages.filter(({ action }) => action === 'unlockAIApiKey')).toEqual([]);
    expect(messages).toEqual([
      { action: 'getAISettings' },
      { action: 'needsAIPassphrase', providerId: 'gemini' },
    ]);
    expect(containsSecret(messages, [oldPassphrase])).toBeFalse();
  });

  test('successful unlock clears the input, refreshes availability, hides the prompt, and retains success', async () => {
    const passphrase = syntheticSecret('ui-unlock-passphrase');
    const manager = Object.create(AISettings.prototype);
    manager.providerSelect = { value: 'openai' };
    manager.unlockSection = { hidden: false };
    manager.unlockPassphraseInput = { value: passphrase };
    manager.unlockButton = { disabled: false };
    manager.unlockResultEl = { hidden: true, textContent: '', className: '' };
    let availabilityRefreshes = 0;
    manager.onAvailabilityChanged = async () => { availabilityRefreshes++; };
    const messages = [];
    manager.send = async (message) => {
      messages.push(message);
      if (message.action === 'unlockAIApiKey') return { unlocked: true };
      if (message.action === 'needsAIPassphrase') return { needsPassphrase: false };
      throw new Error('unexpected provider action');
    };

    expect(await manager.unlockSelectedProvider()).toBeTrue();
    expect(messages).toEqual([
      { action: 'unlockAIApiKey', providerId: 'openai', passphrase },
      { action: 'needsAIPassphrase', providerId: 'openai' },
    ]);
    expect(manager.unlockPassphraseInput.value).toBe('');
    expect(manager.unlockSection.hidden).toBeTrue();
    expect(manager.unlockResultEl.hidden).toBeFalse();
    expect(manager.unlockResultEl.textContent).toBe('Provider unlocked.');
    expect(availabilityRefreshes).toBe(1);
  });

  test('unlock owns provider and passphrase controls until its response settles', async () => {
    const responseGate = deferred();
    const passphrase = syntheticSecret('owned-unlock-passphrase');
    const manager = Object.create(AISettings.prototype);
    manager.providerSelect = { value: 'openai', disabled: false };
    manager.unlockSection = { hidden: false };
    manager.unlockPassphraseInput = { value: passphrase, disabled: false };
    manager.unlockButton = { disabled: false };
    manager.unlockResultEl = { hidden: true, textContent: '', className: '' };
    manager.onAvailabilityChanged = async () => {};
    manager.refreshUnlockState = async () => false;
    manager.send = async () => responseGate.promise;

    const pending = manager.unlockSelectedProvider();
    await Promise.resolve();
    expect(manager.providerSelect.disabled).toBeTrue();
    expect(manager.unlockPassphraseInput.disabled).toBeTrue();
    expect(manager.unlockButton.disabled).toBeTrue();
    responseGate.resolve({ unlocked: true });
    expect(await pending).toBeTrue();
    expect(manager.providerSelect.disabled).toBeFalse();
    expect(manager.unlockPassphraseInput.disabled).toBeFalse();
    expect(manager.unlockButton.disabled).toBeFalse();
  });

  test('switching to device protection immediately clears a hidden passphrase', () => {
    const manager = Object.create(AISettings.prototype);
    manager.passphraseToggle = { checked: false, indeterminate: true };
    manager.passphraseSection = { hidden: false };
    manager.passphraseInput = { value: syntheticSecret('stale-hidden-passphrase') };

    manager.togglePassphrase();
    expect(manager.passphraseToggle.indeterminate).toBeFalse();
    expect(manager.passphraseSection.hidden).toBeTrue();
    expect(manager.passphraseInput.value).toBe('');
  });

  test('atomic save owns its form controls and performs a final availability refresh', async () => {
    const responseGate = deferred();
    const elements = {};
    const controls = [];
    for (const providerId of PROVIDER_IDS) {
      const model = { value: PROVIDER_DEFAULTS[providerId].model, disabled: false };
      elements[`#${providerId}-model`] = model;
      controls.push(model);
    }
    for (const providerId of KEY_PROVIDER_IDS) {
      const key = {
        value: providerId === 'openai' ? syntheticSecret('submitted-ui-key') : '',
        disabled: false,
      };
      elements[`#${providerId}-api-key`] = key;
      controls.push(key);
    }
    elements['#custom-base-url'] = {
      value: PROVIDER_DEFAULTS.custom.baseUrl,
      disabled: false,
    };
    controls.push(elements['#custom-base-url']);

    const manager = Object.create(AISettings.prototype);
    manager.root = {
      querySelector(selector) { return elements[selector] || null; },
      querySelectorAll() { return controls; },
    };
    manager.enabledCheckbox = { checked: true, disabled: false };
    manager.providerSelect = { value: 'openai', disabled: false };
    manager.passphraseToggle = { checked: false, indeterminate: false, disabled: false };
    manager.passphraseInput = { value: '', disabled: false };
    controls.push(
      manager.enabledCheckbox,
      manager.providerSelect,
      manager.passphraseToggle,
      manager.passphraseInput,
    );
    manager.currentSettings = publicSettings('device');
    manager.providerSettings = manager.currentSettings.providerConfigs;
    let refreshes = 0;
    let availabilityRefreshes = 0;
    manager.refresh = async () => { refreshes++; };
    manager.onAvailabilityChanged = async () => { availabilityRefreshes++; };
    const messages = [];
    manager.send = async (message) => {
      messages.push(message);
      return responseGate.promise;
    };

    const originalDocument = globalThis.document;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.document = {
      getElementById: () => ({ appendChild() {} }),
      createElement: () => ({
        children: [],
        style: {},
        appendChild(child) { this.children.push(child); },
        addEventListener() {},
        remove() {},
      }),
    };
    globalThis.setTimeout = () => 0;
    try {
      const pending = manager.saveSettings();
      await Promise.resolve();
      const busyStates = controls.map(({ disabled }) => disabled);
      responseGate.resolve({ saved: true, unlocked: true });
      expect(await pending).toBeTrue();

      expect(busyStates.every(Boolean)).toBeTrue();
      expect(controls.every(({ disabled }) => disabled === false)).toBeTrue();
      expect(messages).toHaveLength(1);
      expect(messages[0].action).toBe('saveAISettings');
      expect(messages[0].keyUpdates).toHaveLength(1);
      expect(refreshes).toBe(1);
      expect(availabilityRefreshes).toBe(1);
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('source sends one atomic save and no raw config in test/model-list actions', async () => {
    const source = await Bun.file(
      new URL('../../sidepanel/components/ai-settings.js', import.meta.url),
    ).text();
    const saveBody = AISettings.prototype.saveSettings.toString();
    const testBody = AISettings.prototype.testConnection.toString();
    const modelsBody = AISettings.prototype.loadModels.toString();

    expect(saveBody.match(/action:\s*['"]saveAISettings['"]/g) || []).toHaveLength(1);
    expect(saveBody).not.toContain('setAIApiKey');
    expect(testBody).not.toContain('buildProviderConfig');
    expect(modelsBody).not.toContain('buildProviderConfig');
    expect(testBody).not.toMatch(/testAIConnection[\s\S]*?config\s*[,}]/);
    expect(modelsBody).not.toMatch(/listModels[\s\S]*?config\s*[,}]/);
    expect(source.includes('Save AI settings before testing or loading models.')).toBeTrue();
    expect(source.includes('Unlock this provider before testing or loading models.')).toBeTrue();
    expect(source.includes('Re-enter every saved API key before changing key protection.')).toBeTrue();
    expect(source.includes("action: 'setAIApiKey'")).toBeFalse();
  });

  test('panel AI availability refreshers declare last-call-wins generations', async () => {
    const panel = await Bun.file(
      new URL('../../sidepanel/panel.js', import.meta.url),
    ).text();
    expect(panel).toContain('let aiVisibilityGeneration = 0');
    expect(panel).toContain('let aiStatusGeneration = 0');
    expect(panel).toContain('visibilityGeneration !== aiVisibilityGeneration');
    expect(panel).toContain('statusGeneration !== aiStatusGeneration');
  });

  test('declares the exact restart-unlock controls', async () => {
    const html = await Bun.file(
      new URL('../../sidepanel/panel.html', import.meta.url),
    ).text();
    for (const id of [
      'ai-unlock-section',
      'ai-unlock-passphrase',
      'btn-unlock-ai',
      'ai-unlock-result',
    ]) {
      expect(html.includes(`id="${id}"`)).toBeTrue();
    }
  });
});
