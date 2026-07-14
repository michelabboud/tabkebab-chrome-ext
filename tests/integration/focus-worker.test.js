import { describe, expect, test } from 'bun:test';

import { installChromeMock, readStorageArea } from '../helpers/chrome-mock.js';

let importNonce = 0;

async function importWorker() {
  return import(`../../service-worker.js?focus-worker=${++importNonce}`);
}

async function waitFor(assertion, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (assertion()) return;
    await Bun.sleep(1);
  }
  throw new Error(message);
}

function runtimeState(overrides = {}) {
  return {
    status: 'active',
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
    aiBlocking: false,
    stashId: null,
    focusGroupId: null,
    distractionsBlocked: 0,
    focusTabCount: 0,
    ...overrides,
  };
}

describe('Focus service-worker integration', () => {
  test('worker initialization rebinds a paused run and leaves title-only preferences unchanged', async () => {
    const preferences = {
      coding: { allowlist: [{ type: 'group', value: 'Deep Work' }] },
    };
    const harness = installChromeMock({
      local: {
        focusState: runtimeState({
          status: 'paused',
          pausedAt: Date.now(),
          allowedDomains: [{
            type: 'group',
            value: 'Deep Work',
            groupId: 90,
            groupIds: [91],
          }],
        }),
        focusProfilePrefs: preferences,
      },
      groups: [
        { id: 0, title: 'Deep Work' },
        { id: 6, title: 'Deep Work' },
      ],
    });

    await importWorker();
    await waitFor(
      () => readStorageArea('local').focusState?.allowedDomains?.[0]?.groupIds?.length === 2,
      'worker initialization did not persist rebound group IDs',
    );

    expect(readStorageArea('local').focusState.allowedDomains).toEqual([
      { type: 'group', value: 'Deep Work', groupIds: [0, 6] },
    ]);
    expect(readStorageArea('local').focusProfilePrefs).toEqual(preferences);
    expect(harness.calls.tabGroups.query).toEqual([[{}]]);
  });

  test('worker initialization rejects stale runtime group IDs when the live query fails', async () => {
    const preferences = {
      coding: { allowlist: [{ type: 'group', value: 'Deep Work' }] },
    };
    const harness = installChromeMock({
      local: {
        focusState: runtimeState({
          strictMode: true,
          allowedDomains: [{
            type: 'group',
            value: 'Deep Work',
            groupId: 90,
            groupIds: [91],
          }],
        }),
        focusProfilePrefs: preferences,
      },
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 1, windowId: 1, url: 'https://blocked.test/', groupId: 91 }],
      failures: { 'tabGroups.query': new Error('synthetic startup group query failure') },
    });

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      await importWorker();
      await waitFor(
        () => readStorageArea('local').focusState?.allowedDomains?.[0]?.groupIds?.length === 0,
        'failed group lookup did not remove stale runtime authority',
      );
      await Bun.sleep(1);
    } finally {
      console.warn = originalWarn;
    }

    expect(readStorageArea('local').focusState.allowedDomains).toEqual([
      { type: 'group', value: 'Deep Work', groupIds: [] },
    ]);
    expect(readStorageArea('local').focusProfilePrefs).toEqual(preferences);
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toContain('Focus group rebinding failed');

    await chrome.tabs.onUpdated.dispatch(1, { url: 'https://blocked.test/next' }, {
      ...harness.snapshot().tabs[0],
      url: 'https://blocked.test/next',
    });
    await waitFor(
      () => harness.calls.tabs.goBack.length === 1,
      'navigation trusted a stale group ID after startup query failure',
    );
    expect(harness.calls.tabs.goBack).toEqual([[1]]);
  });

  test('navigation applies exact URL and rebound group policy without prefix matching', async () => {
    const exactUrl = 'https://docs.test/Exact?Q=One#Part';
    const harness = installChromeMock({
      local: {
        focusState: runtimeState({
          strictMode: true,
          aiBlocking: true,
          allowedDomains: [
            { type: 'url', value: exactUrl },
            { type: 'group', value: 'Deep Work', groupId: 91, groupIds: [92] },
          ],
        }),
      },
      windows: [{ id: 1, focused: true }],
      groups: [{ id: 0, windowId: 1, title: 'Deep Work' }],
      tabs: [
        { id: 1, windowId: 1, url: exactUrl, active: true },
        { id: 2, windowId: 1, url: 'https://other.test/', groupId: 0 },
        { id: 3, windowId: 1, url: 'chrome://settings/' },
      ],
    });

    await importWorker();
    await waitFor(
      () => readStorageArea('local').focusState?.allowedDomains?.[1]?.groupIds?.[0] === 0,
      'active Focus state did not rebind before navigation assertions',
    );

    const aiSettingsReadCount = () => harness.calls.storage.local.get
      .filter(([key]) => key === 'aiSettings')
      .length;
    const aiReadsBeforeAllowedNavigation = aiSettingsReadCount();

    await chrome.tabs.onUpdated.dispatch(1, { url: exactUrl }, {
      ...harness.snapshot().tabs.find(({ id }) => id === 1),
      url: exactUrl,
    });
    await Bun.sleep(1);
    expect(harness.calls.tabs.goBack).toEqual([]);
    expect(aiSettingsReadCount()).toBe(aiReadsBeforeAllowedNavigation);

    const prefixExtension = `${exactUrl}/extra`;
    await chrome.tabs.onUpdated.dispatch(1, { url: prefixExtension }, {
      ...harness.snapshot().tabs.find(({ id }) => id === 1),
      url: prefixExtension,
    });
    await waitFor(
      () => harness.calls.tabs.goBack.length === 1,
      'strict navigation did not reject the URL prefix extension',
    );
    expect(harness.calls.tabs.goBack).toEqual([[1]]);

    await chrome.tabs.onUpdated.dispatch(2, { url: 'https://blocked.test/' }, {
      ...harness.snapshot().tabs.find(({ id }) => id === 2),
      url: 'https://blocked.test/',
    });
    await Bun.sleep(1);
    expect(harness.calls.tabs.goBack).toEqual([[1]]);
    expect(aiSettingsReadCount()).toBe(aiReadsBeforeAllowedNavigation);

    await chrome.tabs.onUpdated.dispatch(3, { url: 'chrome://settings/' }, {
      ...harness.snapshot().tabs.find(({ id }) => id === 3),
      url: 'chrome://settings/',
    });
    await Bun.sleep(1);
    expect(harness.calls.tabs.goBack).toEqual([[1]]);
    expect(aiSettingsReadCount()).toBe(aiReadsBeforeAllowedNavigation);
  });
});
