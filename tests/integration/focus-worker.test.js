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

function startFocusMessage() {
  return {
    action: 'startFocus',
    profileId: 'coding',
    duration: 25,
    tabAction: 'none',
    allowedDomains: [{ type: 'group', value: 'Deep Work' }],
    blockedDomains: [],
    strictMode: true,
    blockedCategories: [],
    aiBlocking: false,
  };
}

async function exerciseMutationAfterDeferredInitialization({ action, initialFailure }) {
  const paused = action === 'resumeFocus';
  const harness = installChromeMock({
    local: {
      focusState: runtimeState({
        status: paused ? 'paused' : 'active',
        pausedAt: paused ? Date.now() - 1_000 : null,
        allowedDomains: [{
          type: 'group',
          value: 'Deep Work',
          groupId: 90,
          groupIds: [91],
        }],
      }),
    },
    groups: [
      { id: 3, title: 'Deep Work' },
      { id: 7, title: 'Other' },
    ],
  });
  const gate = createDeferred();
  const queryGroups = chrome.tabGroups.query.bind(chrome.tabGroups);
  let queryCount = 0;
  chrome.tabGroups.query = async (...args) => {
    queryCount++;
    const groups = await queryGroups(...args);
    if (queryCount === 1) {
      await gate.promise;
      if (initialFailure) throw new Error('synthetic deferred initialization failure');
    }
    return groups;
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await importWorker();
    await waitFor(
      () => harness.calls.tabGroups.query.length === 1,
      `${action} setup did not enter its initial group query`,
    );

    let settled = false;
    const responsePromise = chrome.runtime.sendMessage(
      action === 'startFocus' ? startFocusMessage() : { action: 'resumeFocus' },
    ).then((response) => {
      settled = true;
      return response;
    });
    await Bun.sleep(1);
    const settledBeforeReadiness = settled;
    const queriesBeforeReadiness = harness.calls.tabGroups.query.length;

    await chrome.tabGroups.update(3, { title: 'Old' });
    await chrome.tabGroups.update(7, { title: 'Deep Work' });
    gate.resolve();

    const response = await responsePromise;
    await waitFor(
      () => readStorageArea('local').focusState?.allowedDomains?.[0]?.groupIds?.[0] === 7,
      `${action} did not persist its own current group query after readiness`,
    );

    return {
      response,
      settledBeforeReadiness,
      queriesBeforeReadiness,
      finalState: readStorageArea('local').focusState,
      queryCalls: harness.calls.tabGroups.query.length,
      warnings,
    };
  } finally {
    gate.resolve();
    console.warn = originalWarn;
  }
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

  test('expired Focus alarm waits for startup while read-only messages stay fail-closed', async () => {
    const staleState = runtimeState({
      startedAt: Date.now() - 120_000,
      duration: 1,
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
    await Bun.sleep(1);
    expect(harness.calls.action.setBadgeText).toEqual([]);
    expect(harness.calls.storage.local.remove).toEqual([]);
    const stateFromMessage = await chrome.runtime.sendMessage({ action: 'getFocusState' });

    expect(stateFromMessage.status).toBe('active');
    expect(stateFromMessage.allowedDomains).toEqual([
      { type: 'group', value: 'Deep Work', groupIds: [] },
    ]);
    expect(readStorageArea('local').focusState.allowedDomains).toEqual(staleState.allowedDomains);

    gate.resolve();
    await waitFor(
      () => readStorageArea('local').focusState === undefined,
      'expired Focus alarm did not end the run after startup readiness',
    );
  });

  test('failed rebound persistence keeps alarm, message, and navigation paths fail-closed', async () => {
    const staleState = runtimeState({
      strictMode: true,
      allowedDomains: [{
        type: 'group',
        value: 'Deep Work',
        groupId: 90,
        groupIds: [91],
      }],
    });
    const blockedUrl = 'https://blocked.test/recycled-group';
    const harness = installChromeMock({
      local: { focusState: staleState },
      windows: [{ id: 1, focused: true }],
      groups: [{ id: 7, title: 'Deep Work' }],
      tabs: [{ id: 1, windowId: 1, url: blockedUrl, groupId: 91 }],
      failures: { 'storage.local.set': new Error('synthetic rebound persistence failure') },
    });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      await importWorker();
      await waitFor(
        () => warnings.some(([message]) => String(message).includes('Focus group rebinding failed')),
        'worker did not report failed rebound persistence',
      );
    } finally {
      console.warn = originalWarn;
    }

    await chrome.alarms.onAlarm.dispatch({ name: 'focusTick' });
    const stateFromMessage = await chrome.runtime.sendMessage({ action: 'getFocusState' });
    expect(stateFromMessage.allowedDomains).toEqual([
      { type: 'group', value: 'Deep Work', groupIds: [] },
    ]);

    await chrome.tabs.onUpdated.dispatch(1, { url: blockedUrl }, {
      ...harness.snapshot().tabs[0],
      url: blockedUrl,
    });
    await waitFor(
      () => harness.calls.tabs.goBack.length === 1,
      'navigation trusted a recycled group ID after rebound persistence failed',
    );
    expect(harness.calls.tabs.goBack).toEqual([[1]]);
  });

  for (const initialFailure of [false, true]) {
    const readinessResult = initialFailure ? 'failure' : 'success';
    test(`start and resume wait for deferred initialization ${readinessResult} before querying current groups`, async () => {
      for (const action of ['startFocus', 'resumeFocus']) {
        const result = await exerciseMutationAfterDeferredInitialization({
          action,
          initialFailure,
        });

        expect(result.settledBeforeReadiness).toBe(false);
        expect(result.queriesBeforeReadiness).toBe(1);
        expect(result.queryCalls).toBe(2);
        expect(result.response.status).toBe('active');
        expect(result.response.allowedDomains).toEqual([
          { type: 'group', value: 'Deep Work', groupIds: [7] },
        ]);
        expect(result.finalState.allowedDomains).toEqual(result.response.allowedDomains);
        expect(result.warnings.length).toBe(initialFailure ? 1 : 0);
      }
    });
  }

  test('end, pause, and extend messages do not mutate Focus state before startup readiness', async () => {
    for (const message of [
      { action: 'endFocus' },
      { action: 'pauseFocus' },
      { action: 'extendFocus', minutes: 5 },
    ]) {
      const harness = installChromeMock({
        local: { focusState: runtimeState() },
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
        `${message.action} setup did not enter startup readiness`,
      );

      let settled = false;
      const responsePromise = chrome.runtime.sendMessage(message).then((response) => {
        settled = true;
        return response;
      });
      await Bun.sleep(1);
      const settledBeforeReadiness = settled;
      const writesBeforeReadiness =
        harness.calls.storage.local.set.length + harness.calls.storage.local.remove.length;

      gate.resolve();
      await responsePromise;

      expect(settledBeforeReadiness).toBe(false);
      expect(writesBeforeReadiness).toBe(0);
    }
  });

  test('a queued Focus mutation preserves its error-shaped message response', async () => {
    const harness = installChromeMock({
      local: { focusState: runtimeState() },
    });
    const gate = createDeferred();
    const queryGroups = chrome.tabGroups.query.bind(chrome.tabGroups);
    let queryCount = 0;
    chrome.tabGroups.query = async (...args) => {
      queryCount++;
      const groups = await queryGroups(...args);
      if (queryCount === 1) {
        await gate.promise;
        return groups;
      }
      throw new Error('synthetic queued start failure');
    };

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      await importWorker();
      await waitFor(
        () => harness.calls.tabGroups.query.length === 1,
        'queued error setup did not enter startup readiness',
      );

      let settled = false;
      const responsePromise = chrome.runtime.sendMessage(startFocusMessage()).then((response) => {
        settled = true;
        return response;
      });
      await Bun.sleep(1);
      expect(settled).toBe(false);

      gate.resolve();
      expect(await responsePromise).toEqual({ error: 'synthetic queued start failure' });
      expect(harness.calls.tabGroups.query).toHaveLength(2);
      expect(warnings.some(([message]) => String(message).includes('handler error'))).toBe(true);
    } finally {
      gate.resolve();
      console.warn = originalWarn;
    }
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
