import { describe, expect, test } from 'bun:test';

import { installChromeMock, readStorageArea } from '../helpers/chrome-mock.js';

let importNonce = 0;

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
  test('a strict navigation delivered before startup rebinding waits and is enforced', async () => {
    const blockedUrl = 'https://blocked.test/pre-ready';
    const harness = installChromeMock({
      local: {
        focusState: runtimeState({
          strictMode: true,
          allowedDomains: [{ type: 'group', value: 'Deep Work', groupIds: [91] }],
        }),
      },
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 1, windowId: 1, url: blockedUrl, groupId: -1 }],
    });
    const gate = createDeferred();
    const getStorage = chrome.storage.local.get.bind(chrome.storage.local);
    let heldFocusRead = false;
    chrome.storage.local.get = async (keys) => {
      if (!heldFocusRead && keys === 'focusState') {
        heldFocusRead = true;
        await gate.promise;
      }
      return getStorage(keys);
    };

    await importWorker();
    const navigation = chrome.tabs.onUpdated.dispatch(1, { url: blockedUrl }, {
      ...harness.snapshot().tabs[0],
      url: blockedUrl,
    });
    await Bun.sleep(1);
    expect(harness.calls.tabs.goBack).toEqual([]);

    gate.resolve();
    await navigation;
    await waitFor(
      () => harness.calls.tabs.goBack.length === 1,
      'pre-ready strict navigation was dropped instead of enforced after rebinding',
    );
    expect(harness.calls.tabs.goBack).toEqual([[1]]);
  });

  test('a strict tab creation delivered before startup rebinding waits and is enforced', async () => {
    const blockedUrl = 'https://blocked.test/pre-ready-created';
    const harness = installChromeMock({
      local: {
        focusState: runtimeState({
          strictMode: true,
          allowedDomains: [{ type: 'group', value: 'Deep Work', groupIds: [91] }],
        }),
      },
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 1, windowId: 1, url: blockedUrl, groupId: -1 }],
    });
    const gate = createDeferred();
    const getStorage = chrome.storage.local.get.bind(chrome.storage.local);
    let heldFocusRead = false;
    chrome.storage.local.get = async (keys) => {
      if (!heldFocusRead && keys === 'focusState') {
        heldFocusRead = true;
        await gate.promise;
      }
      return getStorage(keys);
    };

    await importWorker();
    const creation = chrome.tabs.onCreated.dispatch(harness.snapshot().tabs[0]);
    await Bun.sleep(1);
    expect(harness.calls.tabs.goBack).toEqual([]);

    gate.resolve();
    await creation;
    await waitFor(
      () => harness.calls.tabs.goBack.length === 1,
      'pre-ready strict tab creation was dropped instead of enforced after rebinding',
    );
    expect(harness.calls.tabs.goBack).toEqual([[1]]);
  });

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

  test('alarm and message reads cannot restore stale group IDs while startup lookup is pending', async () => {
    const staleState = runtimeState({
      strictMode: true,
      allowedDomains: [{
        type: 'group',
        value: 'Deep Work',
        groupId: 90,
        groupIds: [91],
      }],
    });
    const harness = installChromeMock({
      local: { focusState: staleState },
      groups: [{ id: 7, title: 'Deep Work' }],
    });
    const gate = createDeferred();
    const queryGroups = chrome.tabGroups.query.bind(chrome.tabGroups);
    chrome.tabGroups.query = async (...args) => {
      const groups = await queryGroups(...args);
      await gate.promise;
      return groups;
    };

    await importWorker();
    await waitFor(
      () => harness.calls.tabGroups.query.length === 1,
      'worker startup did not enter its pending group lookup',
    );

    await chrome.alarms.onAlarm.dispatch({ name: 'focusTick' });
    await waitFor(
      () => harness.calls.action.setBadgeText.length > 0,
      'focus alarm did not read the pending startup state',
    );
    const stateFromMessage = await chrome.runtime.sendMessage({ action: 'getFocusState' });

    expect(stateFromMessage.allowedDomains).toEqual([
      { type: 'group', value: 'Deep Work', groupIds: [] },
    ]);
    expect(readStorageArea('local').focusState.allowedDomains).toEqual(staleState.allowedDomains);

    gate.resolve();
    await waitFor(
      () => readStorageArea('local').focusState?.allowedDomains?.[0]?.groupIds?.[0] === 7,
      'worker startup did not finish after the pending-boundary assertion',
    );
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

  test('onUpdated treats changeInfo.url as authoritative over a stale pendingUrl', async () => {
    const pendingAllowedUrl = 'https://allowed.test/exact';
    const blockedUrl = 'https://blocked.test/new-navigation';
    const harness = installChromeMock({
      local: {
        focusState: runtimeState({
          strictMode: true,
          allowedDomains: [{ type: 'url', value: pendingAllowedUrl }],
        }),
      },
      windows: [{ id: 1, focused: true }],
      tabs: [{
        id: 1,
        windowId: 1,
        url: 'https://committed.test/old',
        pendingUrl: pendingAllowedUrl,
      }],
    });

    await importWorker();
    await waitFor(
      () => harness.calls.tabGroups.query.length === 1,
      'worker startup did not complete its group lookup',
    );

    await chrome.tabs.onUpdated.dispatch(1, { url: blockedUrl }, {
      ...harness.snapshot().tabs[0],
      url: blockedUrl,
    });
    await waitFor(
      () => harness.calls.tabs.goBack.length === 1,
      'changeInfo.url was ignored in favor of the tab pendingUrl',
    );
    expect(harness.calls.tabs.goBack).toEqual([[1]]);
  });
});
