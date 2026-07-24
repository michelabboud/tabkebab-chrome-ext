import { describe, expect, test } from 'bun:test';

import {
  classifySmartGroupFailure,
  selectSmartGroupRoute,
} from '../../core/ai/smart-group-route.js';

function publicSettings(overrides = {}) {
  return {
    enabled: false,
    providerId: null,
    providerConfigs: {
      openai: { model: 'gpt-4.1-nano', hasApiKey: false, usesPassphrase: false },
      claude: { model: 'claude-haiku-4-5', hasApiKey: false, usesPassphrase: false },
      gemini: { model: 'gemini-2.5-flash', hasApiKey: false, usesPassphrase: false },
      'chrome-ai': { model: 'default', hasApiKey: false, usesPassphrase: false },
      custom: {
        model: 'default',
        baseUrl: 'http://localhost:11434/v1',
        hasApiKey: false,
        usesPassphrase: false,
      },
    },
    protectionMode: 'device',
    ...overrides,
  };
}

describe('Smart Group AI route', () => {
  test('uses Chrome built-in AI without saved settings or a BYO key', () => {
    expect(selectSmartGroupRoute(publicSettings())).toEqual({
      mode: 'zero-config',
      providerId: 'chrome-ai',
    });
  });

  test('keeps an enabled keyed provider as the configured Smart Group route', () => {
    const settings = publicSettings({
      enabled: true,
      providerId: 'openai',
    });
    settings.providerConfigs.openai.hasApiKey = true;

    expect(selectSmartGroupRoute(settings)).toEqual({
      mode: 'configured',
      providerId: 'openai',
    });
  });

  test('uses Chrome built-in AI when a keyed provider is selected without a key', () => {
    expect(selectSmartGroupRoute(publicSettings({
      enabled: true,
      providerId: 'gemini',
    }))).toEqual({
      mode: 'zero-config',
      providerId: 'chrome-ai',
    });
  });

  test('preserves an enabled keyless custom provider as explicit configuration', () => {
    expect(selectSmartGroupRoute(publicSettings({
      enabled: true,
      providerId: 'custom',
    }))).toEqual({
      mode: 'configured',
      providerId: 'custom',
    });
  });

  test('classifies unavailable, timeout/abort, and other failures without raw messages', () => {
    expect(classifySmartGroupFailure({ code: 'AI_UNAVAILABLE', message: 'raw browser detail' }))
      .toBe('unavailable');
    expect(classifySmartGroupFailure({ code: 'AI_FOREGROUND_REQUIRED' }))
      .toBe('unavailable');
    expect(classifySmartGroupFailure({ code: 'AI_TIMEOUT' })).toBe('timeout');
    expect(classifySmartGroupFailure({ code: 'AI_ABORTED' })).toBe('timeout');
    expect(classifySmartGroupFailure(new Error('secret provider detail'))).toBe('failed');
  });
});
