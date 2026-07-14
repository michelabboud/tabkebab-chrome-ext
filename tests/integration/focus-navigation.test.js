import { describe, expect, test } from 'bun:test';

import { installChromeMock, readStorageArea } from '../helpers/chrome-mock.js';

let importNonce = 0;

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(message);
}

function focusState(overrides = {}) {
  return {
    status: 'active',
    runId: 'run-a',
    startedAt: Date.now(),
    duration: 25,
    pausedAt: null,
    pausedElapsed: 0,
    profileId: 'coding',
    profileName: 'Coding',
    profileColor: 'cyan',
    tabAction: 'none',
    allowedDomains: [],
    blockedDomains: [],
    strictMode: false,
    blockedCategories: [],
    aiBlocking: true,
    stashId: null,
    focusGroupId: null,
    distractionsBlocked: 0,
    focusTabCount: 1,
    ...overrides,
  };
}

async function importWorkerWithDeferredAi(overrides = {}) {
  const classifiedUrl = overrides.classifiedUrl ?? 'https://delayed.test/path';
  const laterUrl = overrides.laterUrl ?? 'https://allowed.test/later';
  const gate = deferred();
  const harness = installChromeMock({
    local: {
      focusState: focusState({
        allowedDomains: [{ type: 'url', value: laterUrl }],
        ...overrides.state,
      }),
      aiSettings: {
        enabled: true,
        providerId: 'custom',
        providerConfigs: { custom: { baseUrl: 'https://provider.test/v1' } },
        usePassphrase: false,
      },
    },
    windows: [{ id: 1, focused: true }],
    tabs: [{ id: 11, windowId: 1, url: 'https://origin.test/', active: true }],
  });
  const { AIClient } = await import('../../core/ai/ai-client.js');
  const originalComplete = AIClient.complete;
  const originalAvailable = AIClient.isAvailable;
  let completeCalls = 0;
  AIClient.isAvailable = async () => true;
  AIClient.complete = async () => {
    completeCalls++;
    return gate.promise;
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await import(`../../service-worker.js?focus-navigation=${++importNonce}`);
    await waitFor(
      () => harness.calls.tabGroups.query.length === 1,
      'worker startup did not complete Focus group lookup',
    );
  } catch (error) {
    AIClient.complete = originalComplete;
    AIClient.isAvailable = originalAvailable;
    console.warn = originalWarn;
    throw error;
  }

  return {
    classifiedUrl,
    laterUrl,
    gate,
    harness,
    warnings,
    completeCalls: () => completeCalls,
    restore() {
      AIClient.complete = originalComplete;
      AIClient.isAvailable = originalAvailable;
      console.warn = originalWarn;
    },
  };
}

function focusSideEffectCounts(harness) {
  return {
    goBack: harness.calls.tabs.goBack.length,
    remove: harness.calls.tabs.remove.length,
    sidePanel: harness.calls.sidePanel.open.length,
    badgeText: harness.calls.action.setBadgeText.length,
    badgeColor: harness.calls.action.setBadgeBackgroundColor.length,
    notifications: harness.calls.runtime.sendMessage.filter(
      ([message]) => message?.type === 'focusDistraction',
    ).length,
  };
}

async function assertNoNewFocusEffects(harness, before) {
  await Bun.sleep(5);
  expect(focusSideEffectCounts(harness)).toEqual(before);
}

describe('deferred Focus classification authority', () => {
  for (const lifecycle of ['pause', 'pause-resume', 'end', 'replacement', 'remove', 'navigate']) {
    test(`${lifecycle} while AI is pending makes the completion a no-op`, async () => {
      const context = await importWorkerWithDeferredAi();
      try {
        const navigation = chrome.tabs.update(11, { url: context.classifiedUrl });
        await waitFor(
          () => context.completeCalls() === 1,
          `${lifecycle}: navigation did not reach deferred AIClient.complete`,
        );

        if (lifecycle === 'pause' || lifecycle === 'pause-resume') {
          const response = await chrome.runtime.sendMessage({
            action: 'pauseFocus',
            expectedRunId: 'run-a',
          });
          expect(response.status).toBe('paused');
          if (lifecycle === 'pause-resume') {
            const resumed = await chrome.runtime.sendMessage({
              action: 'resumeFocus',
              expectedRunId: 'run-a',
            });
            expect(resumed.status).toBe('active');
          }
        } else if (lifecycle === 'end') {
          await chrome.runtime.sendMessage({ action: 'endFocus', expectedRunId: 'run-a' });
          expect(readStorageArea('local').focusState).toBeUndefined();
        } else if (lifecycle === 'replacement') {
          const response = await chrome.runtime.sendMessage({
            action: 'startFocus',
            profileId: 'writing',
            duration: 25,
            tabAction: 'none',
            allowedDomains: [],
            blockedDomains: [],
            strictMode: false,
            blockedCategories: [],
            aiBlocking: false,
          });
          expect(response.runId).not.toBe('run-a');
        } else if (lifecycle === 'remove') {
          await chrome.tabs.remove(11);
        } else {
          await chrome.tabs.update(11, { url: context.laterUrl });
        }

        const before = focusSideEffectCounts(context.harness);
        const replacementBefore = readStorageArea('local').focusState;
        context.gate.resolve({
          parsed: { distraction: true, confidence: 0.99, category: 'social media' },
        });
        await navigation;
        await assertNoNewFocusEffects(context.harness, before);

        const after = readStorageArea('local').focusState;
        if (replacementBefore?.runId) {
          expect(after).toEqual(replacementBefore);
        }
      } finally {
        context.gate.resolve({ parsed: { distraction: false, confidence: 1 } });
        context.restore();
      }
    });
  }

  test('a cached high-confidence result still uses live state and URL validation', async () => {
    const context = await importWorkerWithDeferredAi({
      classifiedUrl: 'https://cached.test/path',
    });
    try {
      const navigation = chrome.tabs.update(11, { url: context.classifiedUrl });
      await waitFor(() => context.completeCalls() === 1, 'cache seed did not reach AI');
      context.gate.resolve({
        parsed: { distraction: true, confidence: 0.99, category: 'news' },
      });
      await navigation;
      await waitFor(
        () => context.harness.calls.tabs.goBack.length === 1,
        'first confident result did not seed and act through the live guard',
      );

      const before = focusSideEffectCounts(context.harness);
      await chrome.runtime.sendMessage({ action: 'pauseFocus', expectedRunId: 'run-a' });
      const pausedBaseline = focusSideEffectCounts(context.harness);
      await chrome.tabs.update(11, { url: context.classifiedUrl });
      await assertNoNewFocusEffects(context.harness, pausedBaseline);
      expect(context.completeCalls()).toBe(1);
      expect(before.goBack).toBe(1);
    } finally {
      context.restore();
    }
  });
});

describe('point-of-side-effect fallback validation', () => {
  test('a goBack failure followed by navigation away cannot remove the tab', async () => {
    const blockedUrl = 'https://blocked.test/path';
    const harness = installChromeMock({
      local: {
        focusState: focusState({
          strictMode: true,
          aiBlocking: false,
          allowedDomains: [],
        }),
      },
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 11, windowId: 1, url: 'https://origin.test/', active: true }],
      failures: { 'tabs.goBack': new Error('no history') },
    });
    await import(`../../service-worker.js?focus-fallback=${++importNonce}`);
    await waitFor(
      () => harness.calls.tabGroups.query.length === 1,
      'worker startup did not complete Focus group lookup',
    );
    const goBack = chrome.tabs.goBack.bind(chrome.tabs);
    chrome.tabs.goBack = async (tabId) => {
      await chrome.tabs.update(tabId, { url: 'chrome://settings/' });
      return goBack(tabId);
    };

    await chrome.tabs.update(11, { url: blockedUrl });
    await waitFor(
      () => harness.calls.tabs.goBack.length === 1,
      'blocked navigation did not attempt goBack',
    );
    await Bun.sleep(5);

    expect(harness.calls.tabs.remove).toEqual([]);
    expect(harness.snapshot().tabs.find(({ id }) => id === 11)?.url).toBe('chrome://settings/');
  });
});
