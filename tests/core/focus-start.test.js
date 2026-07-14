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

async function loadFocus(overrides = {}) {
  const harness = installChromeMock(overrides);
  const focus = await import(`../../core/focus.js?focus-start=${++importNonce}`);
  return { focus, harness };
}

function makeStartOptions(overrides = {}) {
  return {
    profileId: 'coding',
    duration: 25,
    tabAction: 'none',
    allowedDomains: [],
    blockedDomains: [],
    strictMode: false,
    blockedCategories: [],
    aiBlocking: false,
    ...overrides,
  };
}

describe('Focus startup policy and tab actions', () => {
  test('startup classifies legacy domain, exact URL, and every rebound same-title group through one allowlist', async () => {
    const preferences = {
      coding: {
        allowlist: [
          'work.test',
          { type: 'url', value: 'https://exact.test/Path?Q=One#Part' },
          { type: 'group', value: 'Deep Work' },
        ],
      },
    };
    const allowlist = [
      'work.test',
      { type: 'url', value: 'https://exact.test/Path?Q=One#Part' },
      { type: 'group', value: 'Deep Work', groupId: 99, groupIds: [98] },
    ];
    const originalAllowlist = structuredClone(allowlist);
    const { focus, harness } = await loadFocus({
      local: { focusProfilePrefs: preferences },
      windows: [{ id: 1, focused: true }],
      groups: [
        { id: 0, windowId: 1, title: 'Deep Work' },
        { id: 7, windowId: 1, title: 'Deep Work' },
        { id: 8, windowId: 1, title: 'deep work' },
      ],
      tabs: [
        { id: 1, windowId: 1, url: 'https://work.test/' },
        { id: 2, windowId: 1, url: 'https://sub.work.test/' },
        { id: 3, windowId: 1, url: 'https://exact.test/Path?Q=One#Part' },
        { id: 4, windowId: 1, url: 'https://exact.test/Path?Q=One#Part/extra' },
        { id: 5, windowId: 1, url: 'https://other.test/', groupId: 0 },
        { id: 6, windowId: 1, url: 'https://other.test/', groupId: 7 },
        { id: 7, windowId: 1, url: 'https://other.test/', groupId: 8 },
        { id: 8, windowId: 1, url: 'https://notwork.test/' },
      ],
    });

    const state = await focus.startFocus(makeStartOptions({ allowedDomains: allowlist }));

    expect(state.focusTabCount).toBe(5);
    expect(state.allowedDomains).toEqual([
      'work.test',
      { type: 'url', value: 'https://exact.test/Path?Q=One#Part' },
      { type: 'group', value: 'Deep Work', groupIds: [0, 7] },
    ]);
    expect(harness.calls.tabGroups.query).toEqual([[{}]]);
    expect(allowlist).toEqual(originalAllowlist);
    expect(readStorageArea('local').focusProfilePrefs).toEqual(preferences);
  });

  test('kebab discards only background non-focus tabs after live groups resolve', async () => {
    const { focus, harness } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://focus.test/', active: true },
        { id: 2, windowId: 1, url: 'https://blocked.test/background' },
        { id: 3, windowId: 1, url: 'https://blocked.test/active', active: true },
        { id: 4, windowId: 1, url: 'chrome://settings/' },
        { id: 5, windowId: 1, url: 'chrome-extension://extension-id/panel.html' },
      ],
    });
    const order = [];
    const queryGroups = chrome.tabGroups.query.bind(chrome.tabGroups);
    const queryTabs = chrome.tabs.query.bind(chrome.tabs);
    const discardTab = chrome.tabs.discard.bind(chrome.tabs);
    chrome.tabGroups.query = async (...args) => {
      order.push('groups');
      return queryGroups(...args);
    };
    chrome.tabs.query = async (...args) => {
      order.push('tabs');
      return queryTabs(...args);
    };
    chrome.tabs.discard = async (...args) => {
      order.push(`discard:${args[0]}`);
      return discardTab(...args);
    };

    const state = await focus.startFocus(makeStartOptions({
      tabAction: 'kebab',
      allowedDomains: ['focus.test'],
    }));

    expect(order).toEqual(['groups', 'tabs', 'discard:2']);
    expect(harness.calls.tabGroups.query).toEqual([[{}]]);
    expect(harness.calls.tabs.discard).toEqual([[2]]);
    expect(state.focusTabCount).toBe(1);
    expect(harness.snapshot().tabs.find(({ id }) => id === 3)?.discarded).toBe(false);
    expect(harness.snapshot().tabs.find(({ id }) => id === 4)?.discarded).toBe(false);
    expect(harness.snapshot().tabs.find(({ id }) => id === 5)?.discarded).toBe(false);
  });

  test('stash persists and closes only background non-focus tabs through the injected persistence adapter', async () => {
    const saved = [];
    const { focus, harness } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://focus.test/', active: true },
        { id: 2, windowId: 1, url: 'https://blocked.test/one', title: 'One', pinned: true },
        { id: 3, windowId: 1, url: 'https://blocked.test/two', title: 'Two' },
        { id: 4, windowId: 1, url: 'https://blocked.test/active', active: true },
        { id: 5, windowId: 1, url: 'chrome://settings/' },
      ],
    });

    const state = await focus.startFocus(
      makeStartOptions({ tabAction: 'stash', allowedDomains: ['focus.test'] }),
      { saveStash: async (stash) => saved.push(structuredClone(stash)) },
    );

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(expect.objectContaining({
      id: state.stashId,
      source: 'domain',
      sourceDetail: 'focus-mode',
      tabCount: 2,
      windows: [{
        tabCount: 2,
        tabs: [
          expect.objectContaining({ url: 'https://blocked.test/one', pinned: true }),
          expect.objectContaining({ url: 'https://blocked.test/two', pinned: false }),
        ],
      }],
    }));
    expect(harness.calls.tabs.remove).toEqual([[[2, 3]]]);
    expect(harness.snapshot().tabs.map(({ id }) => id)).toEqual([1, 4, 5]);
    expect(harness.calls.tabGroups.query).toEqual([[{}]]);
  });

  test('group action groups only eligible focus tabs and excludes internal pages', async () => {
    const { focus, harness } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      groups: [{ id: 12, windowId: 1, title: 'Allowed Group' }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://focus.test/', active: true },
        { id: 2, windowId: 1, url: 'https://other.test/', groupId: 12 },
        { id: 3, windowId: 1, url: 'https://blocked.test/' },
        { id: 4, windowId: 1, url: 'chrome://settings/' },
        { id: 5, windowId: 1, url: 'chrome-extension://extension-id/panel.html' },
      ],
    });

    const state = await focus.startFocus(makeStartOptions({
      tabAction: 'group',
      allowedDomains: [
        { type: 'domain', value: 'focus.test' },
        { type: 'group', value: 'Allowed Group' },
      ],
    }));

    expect(harness.calls.tabs.group).toHaveLength(1);
    expect(harness.calls.tabs.group[0][0].tabIds).toEqual([1, 2]);
    expect(state.focusTabCount).toBe(2);
    expect(state.focusGroupId).toBeNumber();
    expect(harness.calls.tabGroups.query).toEqual([[{}]]);
  });

  test('non-strict empty allowlist treats every eligible non-internal tab as focus', async () => {
    const { focus, harness } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://one.test/' },
        { id: 2, windowId: 1, url: 'about:blank' },
        { id: 3, windowId: 1, url: 'chrome://settings/' },
        { id: 4, windowId: 1, url: 'chrome-extension://extension-id/panel.html' },
      ],
    });

    const state = await focus.startFocus(makeStartOptions({
      tabAction: 'kebab',
      strictMode: false,
      allowedDomains: [],
    }));

    expect(state.focusTabCount).toBe(2);
    expect(harness.calls.tabs.discard).toEqual([]);
  });

  test('strict empty allowlist makes every non-internal tab non-focus while preserving the active tab', async () => {
    const { focus, harness } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://one.test/' },
        { id: 2, windowId: 1, url: 'about:blank' },
        { id: 3, windowId: 1, url: 'https://active.test/', active: true },
        { id: 4, windowId: 1, url: 'chrome://settings/' },
        { id: 5, windowId: 1, url: 'chrome-extension://extension-id/panel.html' },
      ],
    });

    const state = await focus.startFocus(makeStartOptions({
      tabAction: 'kebab',
      strictMode: true,
      allowedDomains: [],
    }));

    expect(state.focusTabCount).toBe(0);
    expect(harness.calls.tabs.discard).toEqual([[1], [2]]);
    expect(harness.snapshot().tabs.find(({ id }) => id === 3)?.discarded).toBe(false);
    expect(harness.snapshot().tabs.find(({ id }) => id === 4)?.discarded).toBe(false);
    expect(harness.snapshot().tabs.find(({ id }) => id === 5)?.discarded).toBe(false);
  });

  test('startup classifies a navigating tab by pendingUrl before its committed URL', async () => {
    const allowedPendingUrl = 'https://exact.test/Allowed';
    const { focus, harness } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [
        {
          id: 1,
          windowId: 1,
          url: 'https://blocked.test/committed',
          pendingUrl: allowedPendingUrl,
        },
        {
          id: 2,
          windowId: 1,
          url: allowedPendingUrl,
          pendingUrl: 'https://blocked.test/pending',
        },
      ],
    });

    const state = await focus.startFocus(makeStartOptions({
      tabAction: 'kebab',
      strictMode: true,
      allowedDomains: [{ type: 'url', value: allowedPendingUrl }],
    }));

    expect(state.focusTabCount).toBe(1);
    expect(harness.calls.tabs.discard).toEqual([[2]]);
    expect(harness.snapshot().tabs.find(({ id }) => id === 1)?.discarded).toBe(false);
  });

  test('startup stash preserves the authoritative pending URL instead of the committed URL', async () => {
    const committedAllowedUrl = 'https://allowed.test/committed';
    const pendingBlockedUrl = 'https://blocked.test/pending';
    const saved = [];
    const { focus } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [{
        id: 1,
        windowId: 1,
        url: committedAllowedUrl,
        pendingUrl: pendingBlockedUrl,
        title: 'Navigating tab',
      }],
    });

    await focus.startFocus(
      makeStartOptions({
        tabAction: 'stash',
        strictMode: true,
        allowedDomains: [{ type: 'url', value: committedAllowedUrl }],
      }),
      { saveStash: async (stash) => saved.push(structuredClone(stash)) },
    );

    expect(saved).toHaveLength(1);
    expect(saved[0].windows[0].tabs[0].url).toBe(pendingBlockedUrl);
  });

  test('startup excludes an internal pending target but blocks a hostless pending target', async () => {
    const { focus, harness } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [
        {
          id: 1,
          windowId: 1,
          url: 'https://blocked.test/committed',
          pendingUrl: 'chrome://settings/',
        },
        {
          id: 2,
          windowId: 1,
          url: 'chrome://settings/',
          pendingUrl: 'about:blank',
        },
      ],
    });

    const state = await focus.startFocus(makeStartOptions({
      tabAction: 'kebab',
      strictMode: true,
      allowedDomains: [],
    }));

    expect(state.focusTabCount).toBe(0);
    expect(harness.calls.tabs.discard).toEqual([[2]]);
    expect(harness.snapshot().tabs.find(({ id }) => id === 1)?.discarded).toBe(false);
  });

  test('a live-group query failure aborts before tab classification, mutation, or focus-state persistence', async () => {
    const { focus, harness } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 1, windowId: 1, url: 'https://blocked.test/' }],
      failures: { 'tabGroups.query': new Error('synthetic group query failure') },
    });

    await expect(focus.startFocus(makeStartOptions({
      tabAction: 'kebab',
      strictMode: true,
    }))).rejects.toThrow('synthetic group query failure');

    expect(harness.calls.tabGroups.query).toEqual([[{}]]);
    expect(harness.calls.tabs.query).toEqual([]);
    expect(harness.calls.tabs.discard).toEqual([]);
    expect(harness.calls.tabs.remove).toEqual([]);
    expect(harness.calls.tabs.group).toEqual([]);
    expect(harness.calls.alarms.create).toEqual([]);
    expect(harness.calls.action.setBadgeText).toEqual([]);
    expect(readStorageArea('local').focusState).toBeUndefined();
  });
});

describe('Focus runtime group rebinding', () => {
  test('getFocusState cannot restore persisted group IDs while live rebinding is pending', async () => {
    const stale = {
      status: 'active',
      startedAt: Date.now(),
      duration: 25,
      pausedAt: null,
      pausedElapsed: 0,
      allowedDomains: [{ type: 'group', value: 'Deep Work', groupId: 90, groupIds: [91] }],
      distractionsBlocked: 0,
    };
    const { focus, harness } = await loadFocus({
      local: { focusState: stale },
      groups: [{ id: 7, title: 'Deep Work' }],
    });
    const gate = createDeferred();
    const queryGroups = chrome.tabGroups.query.bind(chrome.tabGroups);
    chrome.tabGroups.query = async (...args) => {
      const groups = await queryGroups(...args);
      await gate.promise;
      return groups;
    };

    const rebind = focus.rebindStoredFocusState();
    while (harness.calls.tabGroups.query.length === 0) await Bun.sleep(1);

    const stateDuringLookup = await focus.getFocusState();
    expect(stateDuringLookup.allowedDomains).toEqual([
      { type: 'group', value: 'Deep Work', groupIds: [] },
    ]);
    expect(focus.getCachedFocusState().allowedDomains).toEqual(stateDuringLookup.allowedDomains);

    gate.resolve();
    await rebind;
  });

  test('failed rebinding keeps later storage reads and changes free of stale group IDs', async () => {
    const stale = {
      status: 'active',
      startedAt: Date.now(),
      duration: 25,
      pausedAt: null,
      pausedElapsed: 0,
      allowedDomains: [{ type: 'group', value: 'Deep Work', groupId: 90, groupIds: [91] }],
      distractionsBlocked: 0,
    };
    const { focus } = await loadFocus({
      local: { focusState: stale },
      failures: { 'tabGroups.query': new Error('synthetic lookup failure') },
    });

    await expect(focus.rebindStoredFocusState()).rejects.toThrow('synthetic lookup failure');
    await chrome.storage.local.set({ focusState: stale });

    expect(focus.getCachedFocusState().allowedDomains).toEqual([
      { type: 'group', value: 'Deep Work', groupIds: [] },
    ]);
    expect((await focus.getFocusState()).allowedDomains).toEqual([
      { type: 'group', value: 'Deep Work', groupIds: [] },
    ]);
  });

  test('resume replaces paused-state group bindings from one fresh query before persisting active state', async () => {
    const paused = {
      status: 'paused',
      startedAt: Date.now() - 10_000,
      duration: 25,
      pausedAt: Date.now() - 2_000,
      pausedElapsed: 0,
      allowedDomains: [{ type: 'group', value: 'Deep Work', groupId: 90, groupIds: [91] }],
      distractionsBlocked: 0,
    };
    const prefs = {
      coding: { allowlist: [{ type: 'group', value: 'Deep Work' }] },
    };
    const { focus, harness } = await loadFocus({
      local: { focusState: paused, focusProfilePrefs: prefs },
      groups: [
        { id: 0, title: 'Deep Work' },
        { id: 6, title: 'Deep Work' },
      ],
    });

    const state = await focus.resumeFocus();

    expect(state.status).toBe('active');
    expect(state.allowedDomains).toEqual([
      { type: 'group', value: 'Deep Work', groupIds: [0, 6] },
    ]);
    expect(harness.calls.tabGroups.query).toEqual([[{}]]);
    expect(readStorageArea('local').focusState.allowedDomains).toEqual(state.allowedDomains);
    expect(readStorageArea('local').focusProfilePrefs).toEqual(prefs);
  });

  test('resume leaves paused state unchanged when fresh group rebinding fails', async () => {
    const paused = {
      status: 'paused',
      startedAt: Date.now() - 10_000,
      duration: 25,
      pausedAt: Date.now() - 2_000,
      pausedElapsed: 0,
      allowedDomains: [{ type: 'group', value: 'Deep Work', groupIds: [91] }],
      distractionsBlocked: 0,
    };
    const { focus, harness } = await loadFocus({
      local: { focusState: paused },
      failures: { 'tabGroups.query': new Error('resume group query failed') },
    });

    await expect(focus.resumeFocus()).rejects.toThrow('resume group query failed');

    expect(harness.calls.tabGroups.query).toEqual([[{}]]);
    expect(readStorageArea('local').focusState).toEqual(paused);
  });
});
