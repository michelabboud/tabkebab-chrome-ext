import { describe, expect, test } from 'bun:test';

import { installChromeMock, readStorageArea } from '../helpers/chrome-mock.js';
import { readWorkerModule, sliceBetween } from '../helpers/worker-source.js';

let importNonce = 0;

async function loadFocus(overrides = {}) {
  const harness = installChromeMock(overrides);
  const focus = await import(`../../core/focus.js?stash-focus-safety=${++importNonce}`);
  return { focus, harness };
}

async function loadWorker() {
  return import('../../tabkebab-service-worker.js?stash-focus-safety');
}

function startOptions(overrides = {}) {
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

function runState(overrides = {}) {
  return {
    status: 'active',
    runId: 'run-a',
    startedAt: Date.now() - 10_000,
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
    focusGroupOwnershipToken: null,
    distractionsBlocked: 0,
    focusTabCount: 0,
    ...overrides,
  };
}

async function quietly(operation) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await operation();
  } finally {
    console.warn = warn;
  }
}

const NON_RESTORABLE = [
  'about:blank',
  'blob:https://a.test/0b6c',
  'brave://settings/',
  'chrome://settings/',
  'chrome-extension://abcdefghijklmnop/page.html',
  'data:text/html,hello',
  'devtools://devtools/bundled/inspector.html',
  'edge://settings/',
  'javascript:void(0)',
];

describe('1.1 one restorable-URL predicate for capture, close and restore', () => {
  test('isRestorableUrl rejects every protocol restore refuses and accepts web URLs', async () => {
    const { isRestorableUrl, sanitizeStashableTab } = await import('../../core/tab-restore.js');
    for (const url of NON_RESTORABLE) {
      expect(isRestorableUrl(url)).toBeFalse();
      expect(sanitizeStashableTab({ url, title: 'x' })).toBeNull();
    }
    expect(isRestorableUrl('')).toBeFalse();
    expect(isRestorableUrl(null)).toBeFalse();
    expect(isRestorableUrl('not a url')).toBeFalse();
    expect(isRestorableUrl('https://a.test/')).toBeTrue();
    expect(isRestorableUrl('  http://a.test/  ')).toBeTrue();
    expect(sanitizeStashableTab({ url: 'https://a.test/' })).toEqual(
      expect.objectContaining({ url: 'https://a.test/' }),
    );
  });

  test('persistCapturedStash stores and closes only restorable tabs; the rest stay open', async () => {
    const worker = await loadWorker();
    const saved = [];
    const closed = [];
    const capturedTabs = [
      { id: 1, url: 'https://keep.test/' },
      ...NON_RESTORABLE.map((url, index) => ({ id: 10 + index, url })),
    ];
    const result = await worker.persistCapturedStash({
      stash: {
        id: 'stash-1',
        name: 'Window',
        tabCount: capturedTabs.length,
        windows: [{
          tabCount: capturedTabs.length,
          tabs: capturedTabs.map(({ url }) => ({ url, title: '' })),
        }],
      },
      capturedTabs,
      emptyError: 'No stashable tabs in window',
      save: async (stash) => { saved.push(structuredClone(stash)); },
      close: async (ids) => { closed.push(...ids); },
    });

    expect(result.success).toBeTrue();
    expect(closed).toEqual([1]);
    expect(saved).toHaveLength(1);
    expect(saved[0].tabCount).toBe(1);
    expect(saved[0].windows).toEqual([{ tabCount: 1, tabs: [{ url: 'https://keep.test/', title: '' }] }]);
  });

  test('a capture of only non-restorable tabs saves nothing and closes nothing', async () => {
    const worker = await loadWorker();
    let saves = 0;
    const closed = [];
    const capturedTabs = [{ id: 3, url: 'about:blank' }, { id: 4, url: 'data:text/plain,x' }];
    await expect(worker.persistCapturedStash({
      stash: {
        id: 'stash-2',
        tabCount: 2,
        windows: [{ tabCount: 2, tabs: capturedTabs.map(({ url }) => ({ url })) }],
      },
      capturedTabs,
      emptyError: 'No stashable tabs in window',
      save: async () => { saves++; },
      close: async (ids) => { closed.push(...ids); },
    })).resolves.toEqual({ error: 'No stashable tabs in window' });
    expect(saves).toBe(0);
    expect(closed).toEqual([]);
  });

  test('auto-stash selects and captures through the shared restorable predicate', () => {
    const body = sliceBetween(
      readWorkerModule('core/background/stash.js'),
      'async function autoStashOldTabsUnlocked',
      'export async function autoStashOldTabs(',
    );
    expect(body).toContain('if (!isRestorableUrl(tab.url)) continue;');
    expect(body).toContain('sanitizeStashableTab(');
    expect(body).not.toContain("startsWith('chrome://')");
  });
});

describe('1.2 Focus stash never strands the run in ENDING', () => {
  test('Focus stash captures only restorable non-focus tabs and leaves the rest open', async () => {
    const saved = [];
    const { focus, harness } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://focus.test/', active: true },
        { id: 2, windowId: 1, url: 'https://blocked.test/' },
        { id: 3, windowId: 1, url: 'about:blank' },
        { id: 4, windowId: 1, url: 'data:text/html,note' },
        { id: 5, windowId: 1, url: 'edge://flags/' },
      ],
    });

    const state = await focus.startFocus(
      startOptions({ tabAction: 'stash', allowedDomains: ['focus.test'] }),
      { saveStash: async (stash) => saved.push(structuredClone(stash)) },
    );

    expect(saved).toHaveLength(1);
    expect(saved[0].windows[0].tabs.map(({ url }) => url)).toEqual(['https://blocked.test/']);
    expect(saved[0].tabCount).toBe(1);
    expect(state.stashId).toBe(saved[0].id);
    expect(harness.calls.tabs.remove).toEqual([[[2]]]);
    expect(harness.snapshot().tabs.map(({ id }) => id)).toEqual([1, 3, 4, 5]);
  });

  test('a Focus stash with nothing restorable creates no stash and closes nothing', async () => {
    const saved = [];
    const { focus, harness } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://focus.test/', active: true },
        { id: 2, windowId: 1, url: 'about:blank' },
      ],
    });

    const state = await focus.startFocus(
      startOptions({ tabAction: 'stash', allowedDomains: ['focus.test'] }),
      { saveStash: async (stash) => saved.push(stash) },
    );

    expect(saved).toEqual([]);
    expect(state.stashId).toBeNull();
    expect(harness.calls.tabs.remove).toEqual([]);
  });

  test('an invalid-only restore shortfall completes teardown instead of staying ENDING', async () => {
    const deleted = [];
    const { focus } = await loadFocus({
      local: { focusState: runState({ stashId: 'stash-1' }) },
    });

    const record = await focus.endFocus({
      expectedRunId: 'run-a',
      adapters: {
        getStash: async () => ({ id: 'stash-1', windows: [] }),
        restoreStashTabs: async () => ({
          requestedCount: 2,
          restoredCount: 1,
          skippedDuplicate: 0,
          skippedInvalid: 1,
          errors: [],
          complete: false,
        }),
        deleteStash: async (id) => { deleted.push(id); },
      },
    });

    expect(record.teardownFailures).toEqual([]);
    expect(readStorageArea('local').focusState).toBeUndefined();
    // Keep the stash so the unrestorable entry is still on record.
    expect(deleted).toEqual([]);
  });

  test('restore errors still keep the run ENDING for a retry', async () => {
    const { focus } = await loadFocus({
      local: { focusState: runState({ stashId: 'stash-1' }) },
    });

    await quietly(() => focus.endFocus({
      expectedRunId: 'run-a',
      adapters: {
        getStash: async () => ({ id: 'stash-1', windows: [] }),
        restoreStashTabs: async () => ({
          requestedCount: 2,
          restoredCount: 0,
          skippedDuplicate: 0,
          skippedInvalid: 1,
          errors: [{ scope: 'create', url: 'https://a.test/', message: 'boom' }],
          complete: false,
        }),
        deleteStash: async () => {},
      },
    }));

    expect(readStorageArea('local').focusState.status).toBe('ending');
  });

  test('an already-stuck ENDING state with a legacy unrestorable stash entry recovers', async () => {
    const deleted = [];
    const { focus, harness } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 1, windowId: 1, url: 'https://focus.test/', active: true }],
      local: {
        focusState: runState({
          status: 'ending',
          endedAt: Date.now() - 1000,
          actualDurationMs: 9000,
          stashId: 'legacy-stash',
        }),
      },
    });

    const record = await focus.endFocus({
      expectedRunId: 'run-a',
      adapters: {
        getStash: async () => ({
          id: 'legacy-stash',
          windows: [{
            tabs: [
              { url: 'https://restored.test/', title: 'Restored' },
              { url: 'about:blank', title: 'Blank' },
            ],
          }],
        }),
        // Real restore coordinator: it reports skippedInvalid for about:blank.
        deleteStash: async (id) => { deleted.push(id); },
      },
    });

    expect(record).not.toBeNull();
    expect(readStorageArea('local').focusState).toBeUndefined();
    expect(harness.snapshot().tabs.map(({ url }) => url)).toContain('https://restored.test/');
    expect(deleted).toEqual([]);
  });
});

describe('1.10 a fully restored Focus stash is deleted', () => {
  test('complete restore deletes the stash before checkpointing', async () => {
    const order = [];
    const { focus } = await loadFocus({
      local: { focusState: runState({ stashId: 'stash-9' }) },
    });

    await focus.endFocus({
      expectedRunId: 'run-a',
      adapters: {
        getStash: async () => ({ id: 'stash-9', windows: [] }),
        restoreStashTabs: async () => {
          order.push('restore');
          return { requestedCount: 1, restoredCount: 1, skippedInvalid: 0, errors: [], complete: true };
        },
        deleteStash: async (id) => { order.push(`delete:${id}`); },
      },
    });

    expect(order).toEqual(['restore', 'delete:stash-9']);
    expect(readStorageArea('local').focusState).toBeUndefined();
  });

  test('an incomplete restore never deletes the stash', async () => {
    const deleted = [];
    const { focus } = await loadFocus({
      local: { focusState: runState({ stashId: 'stash-9' }) },
    });

    await quietly(() => focus.endFocus({
      expectedRunId: 'run-a',
      adapters: {
        getStash: async () => ({ id: 'stash-9', windows: [] }),
        restoreStashTabs: async () => ({
          requestedCount: 2, restoredCount: 1, skippedInvalid: 0, errors: [], complete: false,
        }),
        deleteStash: async (id) => { deleted.push(id); },
      },
    }));

    expect(deleted).toEqual([]);
  });

  test('a stash deletion failure is reported but does not block teardown', async () => {
    const { focus } = await loadFocus({
      local: { focusState: runState({ stashId: 'stash-9' }) },
    });

    const record = await quietly(() => focus.endFocus({
      expectedRunId: 'run-a',
      adapters: {
        getStash: async () => ({ id: 'stash-9', windows: [] }),
        restoreStashTabs: async () => ({ requestedCount: 0, restoredCount: 0, errors: [], complete: true }),
        deleteStash: async () => { throw new Error('synthetic delete failure'); },
      },
    }));

    expect(record.teardownFailures).toContainEqual({
      step: 'stash-delete',
      message: 'synthetic delete failure',
    });
    expect(readStorageArea('local').focusState).toBeUndefined();
  });
});

describe('1.3 extending an open-ended session', () => {
  test('extendFocus is a no-op for an open-ended run and keeps it open-ended', async () => {
    const { focus } = await loadFocus({
      local: { focusState: runState({ duration: 0, startedAt: Date.now() - 60 * 60_000 }) },
    });

    const result = await focus.extendFocus(5, 'run-a');
    expect(result.duration).toBe(0);
    expect(readStorageArea('local').focusState.duration).toBe(0);
    expect(focus.getRemainingMs(readStorageArea('local').focusState)).toBe(Infinity);

    // A tick after the "extension" must not end the session.
    const tick = await focus.handleFocusTick('run-a');
    expect(tick?.status).toBe('active');
    expect(readStorageArea('local').focusState.status).toBe('active');
  });

  test('extendFocus still adds minutes to a timed run', async () => {
    const { focus } = await loadFocus({
      local: { focusState: runState({ duration: 25 }) },
    });
    const result = await focus.extendFocus(5, 'run-a');
    expect(result.duration).toBe(30);
  });
});

describe('1.4 Focus group action respects windows, pins and user groups', () => {
  function multiWindowTabs() {
    return {
      windows: [{ id: 1, focused: true }, { id: 2 }],
      groups: [{ id: 50, windowId: 1, title: 'Mine', color: 'red' }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://focus.test/a', active: true },
        { id: 2, windowId: 1, url: 'https://focus.test/pinned', pinned: true },
        { id: 3, windowId: 1, url: 'https://focus.test/grouped', groupId: 50 },
        { id: 4, windowId: 2, url: 'https://focus.test/b', active: true },
        { id: 5, windowId: 2, url: 'https://focus.test/c' },
        { id: 6, windowId: 2, url: 'https://other.test/' },
      ],
    };
  }

  test('creates one group per window from ungrouped, unpinned focus tabs only', async () => {
    const { focus, harness } = await loadFocus(multiWindowTabs());

    const state = await focus.startFocus(startOptions({
      tabAction: 'group',
      allowedDomains: ['focus.test'],
    }));

    const groupCalls = harness.calls.tabs.group.map(([options]) => options);
    expect(groupCalls).toEqual([
      { createProperties: { windowId: 1 }, tabIds: [1] },
      { createProperties: { windowId: 2 }, tabIds: [4, 5] },
    ]);
    const tabs = Object.fromEntries(harness.snapshot().tabs.map((tab) => [tab.id, tab]));
    expect(tabs[2].pinned).toBeTrue();
    expect(tabs[2].groupId).toBe(-1);
    expect(tabs[3].groupId).toBe(50);
    expect(tabs[1].groupId).not.toBe(tabs[4].groupId);
    expect(state.focusGroupIds).toHaveLength(2);
    expect(state.focusGroupId).toBe(state.focusGroupIds[0]);
    expect(readStorageArea('session').focusGroupOwnership.groupIds).toEqual(state.focusGroupIds);

    await focus.endFocus({ expectedRunId: state.runId });
    const after = Object.fromEntries(harness.snapshot().tabs.map((tab) => [tab.id, tab]));
    expect([1, 4, 5].map((id) => after[id].groupId)).toEqual([-1, -1, -1]);
    expect(after[3].groupId).toBe(50);
    expect(after[2].pinned).toBeTrue();
    expect(readStorageArea('local').focusState).toBeUndefined();
    expect(readStorageArea('session').focusGroupOwnership).toBeUndefined();
  });

  test('a later window group failure rolls back the earlier window group', async () => {
    const { focus, harness } = await loadFocus({
      ...multiWindowTabs(),
      failures: { 'tabs.group': [null, new Error('synthetic second group failure')] },
    });

    await expect(focus.startFocus(startOptions({
      tabAction: 'group',
      allowedDomains: ['focus.test'],
    }))).rejects.toThrow('synthetic second group failure');

    const tabs = Object.fromEntries(harness.snapshot().tabs.map((tab) => [tab.id, tab]));
    expect(tabs[1].groupId).toBe(-1);
    expect(tabs[3].groupId).toBe(50);
    expect(readStorageArea('local').focusState).toBeUndefined();
    expect(readStorageArea('session').focusGroupOwnership).toBeUndefined();
  });

  test('legacy single-group state still tears down', async () => {
    const { focus, harness } = await loadFocus({
      local: {
        focusState: runState({ focusGroupId: 7, focusGroupOwnershipToken: 'token-a' }),
      },
      session: { focusGroupOwnership: { runId: 'run-a', token: 'token-a', groupId: 7 } },
      windows: [{ id: 1 }],
      groups: [{ id: 7, windowId: 1, title: 'Coding' }],
      tabs: [{ id: 8, windowId: 1, url: 'https://work.test/', groupId: 7 }],
    });

    const record = await focus.endFocus({ expectedRunId: 'run-a' });
    expect(record.teardownFailures).toEqual([]);
    expect(harness.snapshot().tabs[0].groupId).toBe(-1);
  });
});

describe('1.5 blocked domains are normalized like the allowlist', () => {
  test('normalizeBlockedDomain strips scheme, path, port and wildcard; rejects junk', async () => {
    const { normalizeBlockedDomain, normalizeBlockedDomains } = await import('../../core/focus-policy.js');
    expect(normalizeBlockedDomain('  Reddit.COM ')).toBe('reddit.com');
    expect(normalizeBlockedDomain('https://www.YouTube.com/watch?v=1')).toBe('www.youtube.com');
    expect(normalizeBlockedDomain('*.x.com')).toBe('x.com');
    expect(normalizeBlockedDomain('x.com/home')).toBe('x.com');
    expect(normalizeBlockedDomain('x.com:8080')).toBe('x.com');
    expect(normalizeBlockedDomain('not a domain')).toBeNull();
    expect(normalizeBlockedDomain('')).toBeNull();
    expect(normalizeBlockedDomain('ftp://files.test/')).toBeNull();
    expect(normalizeBlockedDomain('a*b.com')).toBeNull();
    expect(normalizeBlockedDomains(['x.com', '*.x.com', 'https://x.com/', 'bad value', 7]))
      .toEqual(['x.com']);
  });

  test('startFocus stores normalized blocked domains that actually match', async () => {
    const { focus } = await loadFocus({
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 1, windowId: 1, url: 'https://focus.test/', active: true }],
    });

    const state = await focus.startFocus(startOptions({
      blockedDomains: ['https://www.reddit.com/r/all', '*.x.com', 'bad value'],
    }));

    expect(state.blockedDomains).toEqual(['www.reddit.com', 'x.com']);
    expect(focus.isBlockedDomain('https://api.x.com/feed', state).blocked).toBeTrue();
    expect(focus.isBlockedDomain('https://www.reddit.com/r/x', state).blocked).toBeTrue();
    expect(focus.isBlockedDomain('https://focus.test/', state).blocked).toBeFalse();
  });
});

describe('1.6 curated blocklist entries', () => {
  test('armorgames.com is blocked and no curated entry contains whitespace', async () => {
    const { BLOCKLIST_CATEGORIES, checkAgainstBlocklists } = await import('../../core/focus-blocklists.js');
    expect(checkAgainstBlocklists('armorgames.com', ['gaming']).blocked).toBeTrue();
    for (const category of Object.values(BLOCKLIST_CATEGORIES)) {
      for (const domain of category.domains) {
        expect(domain).not.toMatch(/\s/);
      }
    }
  });
});
