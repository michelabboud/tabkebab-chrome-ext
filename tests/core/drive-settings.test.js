import { describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';

const MAX_STRING = 16_384;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

async function settingsModule() {
  return import('../../core/settings.js');
}

function validEnvelope(settings = {}, overrides = {}) {
  return { settings, version: 1, ...overrides };
}

function nestedValue(depth) {
  let value = 'leaf';
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

describe('Drive settings envelope validation', () => {
  test('accepts legacy missing-version and explicit version-1 envelopes', async () => {
    const { parseDriveSettingsDocument, SETTINGS_DEFAULTS } = await settingsModule();
    expect(parseDriveSettingsDocument({ settings: {} })).toEqual({
      settings: SETTINGS_DEFAULTS,
    });
    expect(parseDriveSettingsDocument({ settings: { theme: 'dark' }, version: 1 })).toEqual({
      settings: { ...SETTINGS_DEFAULTS, theme: 'dark' },
      version: 1,
    });
  });

  test('accepts optional savedAt boundaries and rejects malformed timestamps', async () => {
    const { parseDriveSettingsDocument } = await settingsModule();
    expect(parseDriveSettingsDocument(validEnvelope({}, { savedAt: 0 })).savedAt).toBe(0);
    expect(parseDriveSettingsDocument(validEnvelope({}, { savedAt: MAX_TIMESTAMP })).savedAt).toBe(MAX_TIMESTAMP);
    for (const savedAt of [-1, 1.5, '1', NaN, Infinity, MAX_TIMESTAMP + 1]) {
      expect(() => parseDriveSettingsDocument(validEnvelope({}, { savedAt }))).toThrow(/savedAt|timestamp/i);
    }
  });

  test('requires an own plain settings object and rejects unsupported or unknown envelope keys', async () => {
    const { parseDriveSettingsDocument } = await settingsModule();
    for (const input of [
      null,
      {},
      { settings: null },
      { settings: [] },
      { settings: {}, version: 2 },
      { settings: {}, version: '1' },
      { settings: {}, version: 1, surprise: true },
    ]) {
      expect(() => parseDriveSettingsDocument(input)).toThrow();
    }

    const inheritedSettings = Object.create({ settings: {} });
    inheritedSettings.version = 1;
    expect(() => parseDriveSettingsDocument(inheritedSettings)).toThrow();
  });

  test('rejects unknown, inherited, and prototype-pollution settings keys', async () => {
    const { parseDriveSettingsDocument } = await settingsModule();
    expect(() => parseDriveSettingsDocument(validEnvelope({ unknownSetting: true }))).toThrow(/unknown/i);

    const inherited = Object.create({ theme: 'dark' });
    inherited.defaultView = 'tabs';
    expect(() => parseDriveSettingsDocument(validEnvelope(inherited))).toThrow();

    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const input = JSON.parse(`{"settings":{"${key}":true},"version":1}`);
      expect(() => parseDriveSettingsDocument(input)).toThrow();
    }
  });

  test('rejects oversized strings, excessive nesting, and non-JSON values', async () => {
    const { parseDriveSettingsDocument } = await settingsModule();
    expect(() => parseDriveSettingsDocument(validEnvelope({ theme: 'x'.repeat(MAX_STRING + 1) }))).toThrow(/length/i);
    expect(() => parseDriveSettingsDocument(validEnvelope({ theme: nestedValue(11) }))).toThrow(/depth|nest/i);
    expect(() => parseDriveSettingsDocument(validEnvelope({ theme: undefined }))).toThrow();
  });

  test('rejects an over-25-MiB downloaded settings body before any save', async () => {
    const originalFetch = globalThis.fetch;
    const harness = installChromeMock();
    const bytes = new TextEncoder().encode(`{"settings":{"theme":"${'x'.repeat(MAX_BYTES)}"},"version":1}`);
    let delivered = false;
    let jsonCalls = 0;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => delivered
            ? { done: true, value: undefined }
            : (delivered = true, { done: false, value: bytes }),
          cancel: async () => {},
        }),
      },
      json: () => {
        jsonCalls += 1;
        throw new Error('legacy settings parser invoked');
      },
    });
    try {
      const { readSettingsFile } = await import('../../core/drive-client.js?settings-size-rejection');
      await expect(readSettingsFile('settings-file')).rejects.toThrow(/25 MiB limit/i);
      expect(jsonCalls).toBe(0);
      expect(harness.calls.storage.local.set).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a rejected downloaded settings document performs zero storage saves', async () => {
    const originalFetch = globalThis.fetch;
    const harness = installChromeMock();
    globalThis.fetch = async () => new Response(JSON.stringify({ settings: { unknown: true }, version: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    try {
      const { readSettingsFile } = await import('../../core/drive-client.js?settings-rejection');
      await expect(readSettingsFile('settings-file')).rejects.toThrow(/unknown/i);
      expect(harness.calls.storage.local.set).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('canonical settings constraints', () => {
  test('exports the exact allowlisted constraint keys', async () => {
    const { SETTINGS_CONSTRAINTS, SETTINGS_DEFAULTS } = await settingsModule();
    expect(Object.keys(SETTINGS_CONSTRAINTS)).toEqual(Object.keys(SETTINGS_DEFAULTS));
    expect(Object.isFrozen(SETTINGS_CONSTRAINTS)).toBeTrue();
  });

  test('accepts exact booleans and rejects coercible boolean values', async () => {
    const { SETTINGS_CONSTRAINTS, SETTINGS_DEFAULTS, validateSettingsPatch } = await settingsModule();
    const booleanKeys = Object.entries(SETTINGS_CONSTRAINTS)
      .filter(([, constraint]) => constraint.type === 'boolean')
      .map(([key]) => key);
    expect(booleanKeys.length).toBeGreaterThan(0);
    for (const key of booleanKeys) {
      expect(validateSettingsPatch({ [key]: true }, SETTINGS_DEFAULTS)[key]).toBeTrue();
      expect(validateSettingsPatch({ [key]: false }, SETTINGS_DEFAULTS)[key]).toBeFalse();
      for (const invalid of [0, 1, 'true', null, undefined]) {
        expect(() => validateSettingsPatch({ [key]: invalid }, SETTINGS_DEFAULTS)).toThrow();
      }
    }
  });

  test.each([
    ['defaultView', ['tabs', 'windows', 'stash', 'sessions']],
    ['theme', ['system', 'light', 'dark']],
    ['bookmarkDestination', ['chrome', 'indexeddb', 'drive', 'all']],
    ['focusDefaultProfile', ['coding', 'writing', 'research', 'meeting']],
    ['focusTabAction', ['kebab', 'stash', 'group', 'none']],
  ])('validates the exact %s enum', async (key, values) => {
    const { SETTINGS_DEFAULTS, validateSettingsPatch } = await settingsModule();
    for (const value of values) {
      expect(validateSettingsPatch({ [key]: value }, SETTINGS_DEFAULTS)[key]).toBe(value);
    }
    for (const invalid of ['', values[0].toUpperCase(), 1, null]) {
      expect(() => validateSettingsPatch({ [key]: invalid }, SETTINGS_DEFAULTS)).toThrow();
    }
  });

  test.each([
    ['maxTabsPerWindow', 1, 500],
    ['recommendedTabsPerWindow', 1, 500],
    ['autoSaveIntervalHours', 1, 168],
    ['autoSaveRetentionDays', 1, 365],
    ['autoKebabAfterHours', 0, 720],
    ['autoStashAfterDays', 0, 365],
    ['focusDefaultDuration', 1, 480],
    ['autoSyncToDriveIntervalHours', 0, 168],
    ['driveRetentionDays', 1, 365],
  ])('validates %s at exact integer boundaries', async (key, minimum, maximum) => {
    const { SETTINGS_DEFAULTS, validateSettingsPatch } = await settingsModule();
    const current = {
      ...SETTINGS_DEFAULTS,
      maxTabsPerWindow: 500,
      recommendedTabsPerWindow: 1,
    };
    expect(validateSettingsPatch({ [key]: minimum }, current)[key]).toBe(minimum);
    expect(validateSettingsPatch({ [key]: maximum }, current)[key]).toBe(maximum);
    for (const invalid of [minimum - 1, maximum + 1, minimum + 0.5, String(minimum), NaN, Infinity, -Infinity]) {
      expect(() => validateSettingsPatch({ [key]: invalid }, current)).toThrow();
    }
  });

  test('merges partial patches with defaults/current settings and returns a complete fresh allowlisted object', async () => {
    const { SETTINGS_DEFAULTS, validateSettingsPatch } = await settingsModule();
    const current = { ...SETTINGS_DEFAULTS, theme: 'dark', unknown: 'discard-me' };
    const patch = { defaultView: 'sessions' };
    const output = validateSettingsPatch(patch, current);
    expect(output).toEqual({ ...SETTINGS_DEFAULTS, theme: 'dark', defaultView: 'sessions' });
    expect(output).not.toBe(current);
    expect(output).not.toBe(patch);
    expect(Object.hasOwn(output, 'unknown')).toBeFalse();
  });

  test('rejects unknown and inherited patch keys', async () => {
    const { SETTINGS_DEFAULTS, validateSettingsPatch } = await settingsModule();
    expect(() => validateSettingsPatch({ unknown: true }, SETTINGS_DEFAULTS)).toThrow(/unknown/i);
    const inherited = Object.create({ theme: 'dark' });
    inherited.defaultView = 'tabs';
    expect(() => validateSettingsPatch(inherited, SETTINGS_DEFAULTS)).toThrow();
  });

  test('enforces recommendedTabsPerWindow no greater than maxTabsPerWindow after merge', async () => {
    const { SETTINGS_DEFAULTS, validateSettingsPatch } = await settingsModule();
    expect(() => validateSettingsPatch({
      maxTabsPerWindow: 10,
      recommendedTabsPerWindow: 11,
    }, SETTINGS_DEFAULTS)).toThrow(/recommended|max/i);
    expect(() => validateSettingsPatch({ maxTabsPerWindow: 10 }, {
      ...SETTINGS_DEFAULTS,
      recommendedTabsPerWindow: 20,
    })).toThrow(/recommended|max/i);
    expect(validateSettingsPatch({
      maxTabsPerWindow: 10,
      recommendedTabsPerWindow: 10,
    }, SETTINGS_DEFAULTS)).toMatchObject({ maxTabsPerWindow: 10, recommendedTabsPerWindow: 10 });
  });
});

describe('settings storage boundary', () => {
  test('getSettings returns only validated default keys and never spreads stored extras', async () => {
    const { getSettings, SETTINGS_DEFAULTS } = await settingsModule();
    installChromeMock({ local: { tabkebabSettings: { theme: 'dark', injected: 'drop-me' } } });
    await expect(getSettings()).resolves.toEqual({ ...SETTINGS_DEFAULTS, theme: 'dark' });
  });

  test('saveSettings persists exactly one complete canonical allowlisted object', async () => {
    const { saveSettings, SETTINGS_DEFAULTS } = await settingsModule();
    const harness = installChromeMock({ local: { tabkebabSettings: { theme: 'light' } } });
    const saved = await saveSettings({ defaultView: 'stash' });
    expect(saved).toEqual({ ...SETTINGS_DEFAULTS, theme: 'light', defaultView: 'stash' });
    expect(harness.calls.storage.local.set).toEqual([[{ tabkebabSettings: saved }]]);
  });

  test('setSetting delegates through the same validation/save boundary', async () => {
    const { setSetting } = await settingsModule();
    const harness = installChromeMock();
    await expect(setSetting('theme', 'dark')).resolves.toMatchObject({ theme: 'dark' });
    expect(harness.calls.storage.local.set).toHaveLength(1);
    await expect(setSetting('theme', 'purple')).rejects.toThrow();
    await expect(setSetting('unknown', true)).rejects.toThrow();
    expect(harness.calls.storage.local.set).toHaveLength(1);
  });
});
