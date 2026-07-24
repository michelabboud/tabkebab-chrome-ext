import { afterEach, describe, expect, test } from 'bun:test';

import { AIClient } from '../../core/ai/ai-client.js';
import {
  AIUnavailableError,
  AINetworkError,
  AITimeoutError,
} from '../../core/ai/provider.js';
import { applySmartGroupsToChrome } from '../../core/grouping.js';
import {
  installChromeMock,
  resetChromeMock,
} from '../helpers/chrome-mock.js';

const originalGetPublicSettings = AIClient.getPublicSettings;
const originalComplete = AIClient.complete;
const originalCompleteWithChromeAI = AIClient.completeWithChromeAI;

function settings({
  enabled = false,
  providerId = null,
  hasApiKey = false,
} = {}) {
  return {
    enabled,
    providerId,
    providerConfigs: {
      openai: { model: 'gpt-4.1-nano', hasApiKey, usesPassphrase: false },
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
  };
}

function installTabs() {
  installChromeMock({
    windows: [{ id: 1, focused: true }],
    tabs: [
      { id: 11, windowId: 1, url: 'https://one.example/', title: 'One' },
      { id: 12, windowId: 1, url: 'https://two.example/', title: 'Two' },
    ],
  });
}

afterEach(async () => {
  AIClient.getPublicSettings = originalGetPublicSettings;
  AIClient.complete = originalComplete;
  AIClient.completeWithChromeAI = originalCompleteWithChromeAI;
  await resetChromeMock();
});

describe('Smart Group coordinator fallback outcomes', () => {
  test('uses the brokered zero-config route and reports built-in unavailability', async () => {
    installTabs();
    let configuredCalls = 0;
    AIClient.getPublicSettings = async () => settings();
    AIClient.complete = async () => {
      configuredCalls += 1;
      throw new Error('configured provider must not run');
    };
    AIClient.completeWithChromeAI = async () => {
      throw new AIUnavailableError('model not downloaded');
    };

    await expect(applySmartGroupsToChrome()).resolves.toEqual({
      aiApplied: false,
      aiSource: 'zero-config',
      aiFailure: 'unavailable',
      fallbackAction: 'domain',
    });
    expect(configuredCalls).toBe(0);
  });

  test('keeps a configured key route and reports a sanitized provider failure', async () => {
    installTabs();
    let zeroConfigCalls = 0;
    AIClient.getPublicSettings = async () => settings({
      enabled: true,
      providerId: 'openai',
      hasApiKey: true,
    });
    AIClient.complete = async () => {
      throw new AINetworkError('provider echoed private detail');
    };
    AIClient.completeWithChromeAI = async () => {
      zeroConfigCalls += 1;
      throw new Error('zero-config provider must not run');
    };

    await expect(applySmartGroupsToChrome()).resolves.toEqual({
      aiApplied: false,
      aiSource: 'configured',
      aiFailure: 'failed',
      fallbackAction: 'domain',
    });
    expect(zeroConfigCalls).toBe(0);
  });

  test('turns the established timeout lifecycle into a non-blocking domain action', async () => {
    installTabs();
    AIClient.getPublicSettings = async () => settings({
      enabled: true,
      providerId: 'openai',
      hasApiKey: true,
    });
    AIClient.complete = async () => {
      throw new AITimeoutError('request timed out');
    };

    await expect(applySmartGroupsToChrome()).resolves.toEqual({
      aiApplied: false,
      aiSource: 'configured',
      aiFailure: 'timeout',
      fallbackAction: 'domain',
    });
  });
});
