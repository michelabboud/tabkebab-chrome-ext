import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { takeSnapshot } from '../../core/engine/snapshot.js';
import { solveWithAI } from '../../core/engine/solver-ai.js';
import { plan, pruneDesiredState } from '../../core/engine/planner.js';
import { execute } from '../../core/engine/executor.js';
import {
  OpType,
  createDesiredState,
  createDomainSlot,
  createWindowSlot,
} from '../../core/engine/types.js';
import {
  applyDomainGroupsToChrome,
  applyManualGroupToChrome,
  getWindowStats,
  moveTabToManualGroup,
} from '../../core/grouping.js';
import { installChromeMock } from '../helpers/chrome-mock.js';

// The executor paces Chrome calls with real timers; run them immediately.
const originalSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 0;
  };
});
afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
});

function aiTabs(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: 100 + i,
    windowId: 1,
    url: `https://site${i}.example/`,
    title: `Tab ${i}`,
    _domain: `site${i}.example`,
  }));
}

function allSlotTabIds(desiredState) {
  return desiredState.windowSlots.flatMap(slot => slot.domains.flatMap(d => d.tabIds));
}

describe('5.1 AI solver index validation', () => {
  test('non-integer indices are ignored instead of discarding the whole result', async () => {
    const tabs = aiTabs(4);
    const desired = await solveWithAI({ tabs }, undefined, {
      complete: async () => ({
        parsed: { groups: [{ name: 'Work', color: 'blue', tabIndices: [0, 1.5, 1, '2', 99, -1] }] },
      }),
    });

    expect(desired).not.toBeNull();
    expect(allSlotTabIds(desired)).toEqual([100, 101]);
  });

  test('a tab listed in several groups stays only in the first group', async () => {
    const tabs = aiTabs(5);
    const desired = await solveWithAI({ tabs }, undefined, {
      complete: async () => ({
        parsed: {
          groups: [
            { name: 'A', tabIndices: [0, 1, 1, 0] },
            { name: 'B', tabIndices: [1, 2, 3] },
            { name: 'C', tabIndices: [3, 4] },
          ],
        },
      }),
    });

    const ids = allSlotTabIds(desired);
    expect(new Set(ids).size).toBe(ids.length);
    const byName = Object.fromEntries(
      desired.windowSlots.flatMap(s => s.domains).map(d => [d.label, d.tabIds]),
    );
    expect(byName.A).toEqual([100, 101]);
    expect(byName.B).toEqual([102, 103]);
    // C lost tab 3 to B and fell below two tabs: dropped, tab 4 is a single.
    expect(byName.C).toBeUndefined();
    expect(desired.singles.map(s => s.tabId)).toEqual([104]);
  });

  test('returns null when dedupe leaves no group with two tabs', async () => {
    const desired = await solveWithAI({ tabs: aiTabs(3) }, undefined, {
      complete: async () => ({
        parsed: { groups: [{ name: 'A', tabIndices: [0] }, { name: 'B', tabIndices: [0, 1.2] }] },
      }),
    });
    expect(desired).toBeNull();
  });
});

describe('5.2 / 5.3 snapshot scope', () => {
  test('excludes pinned tabs, non-normal windows and incognito windows when regular ones exist', async () => {
    installChromeMock({
      windows: [
        { id: 1, focused: true },
        { id: 2, type: 'popup' },
        { id: 3, type: 'app' },
        { id: 4, incognito: true },
      ],
      tabs: [
        { id: 11, windowId: 1, url: 'https://a.example/1' },
        { id: 12, windowId: 1, url: 'https://a.example/2', pinned: true },
        { id: 21, windowId: 2, url: 'https://a.example/popup' },
        { id: 31, windowId: 3, url: 'https://a.example/app' },
        { id: 41, windowId: 4, url: 'https://a.example/private' },
      ],
    });

    const snapshot = await takeSnapshot();
    expect(snapshot.tabs.map(t => t.id)).toEqual([11]);
    expect([...snapshot.tabsByWindow.keys()]).toEqual([1]);
    expect(snapshot.windows.map(w => w.id)).toEqual([1]);
  });

  test('uses incognito windows when no regular window exists', async () => {
    installChromeMock({
      windows: [{ id: 4, incognito: true, focused: true }, { id: 5, type: 'popup', incognito: true }],
      tabs: [
        { id: 41, windowId: 4, url: 'https://a.example/1' },
        { id: 51, windowId: 5, url: 'https://a.example/2' },
      ],
    });

    const snapshot = await takeSnapshot();
    expect(snapshot.tabs.map(t => t.id)).toEqual([41]);
  });

  test('window stats still count pinned tabs', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 11, windowId: 1, url: 'https://a.example/1', pinned: true },
        { id: 12, windowId: 1, url: 'https://a.example/2' },
      ],
    });
    const stats = await getWindowStats();
    expect(stats.totalTabs).toBe(2);
  });

  test('domain grouping never groups or moves a pinned tab or a popup tab', async () => {
    const mock = installChromeMock({
      windows: [{ id: 1, focused: true }, { id: 2, type: 'popup' }],
      tabs: [
        { id: 11, windowId: 1, url: 'https://a.example/pinned', pinned: true },
        { id: 12, windowId: 1, url: 'https://a.example/1' },
        { id: 13, windowId: 1, url: 'https://a.example/2' },
        { id: 21, windowId: 2, url: 'https://a.example/popup' },
      ],
    });

    await applyDomainGroupsToChrome();

    const touched = [
      ...mock.calls.tabs.group.flatMap(([opts]) => opts.tabIds),
      ...mock.calls.tabs.move.flatMap(([ids]) => (Array.isArray(ids) ? ids : [ids])),
      ...mock.calls.windows.create.map(([data]) => data.tabId),
    ];
    expect(touched).not.toContain(11);
    expect(touched).not.toContain(21);
    expect(mock.calls.tabs.group.length).toBeGreaterThan(0);

    const state = mock.snapshot();
    expect(state.tabs.find(t => t.id === 11)).toMatchObject({ pinned: true, groupId: -1, windowId: 1 });
    expect(state.tabs.find(t => t.id === 21).windowId).toBe(2);
  });
});

describe('5.4 verification passes after a tab closes mid-run', () => {
  test('pruneDesiredState drops dead tabs and lets the plan converge', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 11, windowId: 1, url: 'https://a.example/1', groupId: 7 },
        { id: 12, windowId: 1, url: 'https://a.example/2', groupId: 7 },
        { id: 21, windowId: 1, url: 'https://b.example/1' },
        { id: 22, windowId: 1, url: 'https://b.example/2' },
      ],
      groups: [{ id: 7, windowId: 1, title: 'a.example', color: 'blue' }],
    });
    const snapshot = await takeSnapshot();

    const desired = createDesiredState({
      windowSlots: [createWindowSlot({
        domains: [
          createDomainSlot({ domain: 'a.example', tabIds: [11, 12, 13], color: 'blue' }),
          createDomainSlot({ domain: 'b.example', tabIds: [21, 22, 23], color: 'red' }),
        ],
        totalTabs: 6,
      })],
      singles: [{ domain: 'c.example', tabId: 99 }],
    });
    // Remove 22 too so b.example falls below the two-tab minimum.
    const liveSnapshot = { ...snapshot, tabsById: new Map([...snapshot.tabsById].filter(([id]) => id !== 22)) };

    // Without pruning the closed tab 13 keeps forcing a CREATE_GROUP.
    expect(plan(snapshot, desired).operations.some(op => op.type === OpType.CREATE_GROUP && op.title === 'a.example')).toBe(true);

    const pruned = pruneDesiredState(desired, liveSnapshot);
    expect(pruned.windowSlots).toHaveLength(1);
    expect(pruned.windowSlots[0].domains.map(d => [d.label, d.tabIds])).toEqual([['a.example', [11, 12]]]);
    expect(pruned.singles).toEqual([{ domain: 'b.example', tabId: 21 }]);
    expect(plan(snapshot, pruned).operations).toEqual([]);
  });

  test('domain grouping does not re-create a group in every verification pass', async () => {
    const mock = installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 11, windowId: 1, url: 'https://a.example/1' },
        { id: 12, windowId: 1, url: 'https://a.example/2' },
        { id: 13, windowId: 1, url: 'https://a.example/3' },
      ],
    });

    // The user closes tab 13 right after the group is created.
    const originalUpdate = chrome.tabGroups.update;
    let closed = false;
    chrome.tabGroups.update = async (...args) => {
      const result = await originalUpdate(...args);
      if (!closed) {
        closed = true;
        await chrome.tabs.remove(13);
      }
      return result;
    };

    await applyDomainGroupsToChrome();
    expect(mock.calls.tabs.group).toHaveLength(1);
  });
});

describe('5.5 executor keeps the user\'s blank tabs', () => {
  test('a New Tab page moved into a new window is not closed', async () => {
    const mock = installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 10, windowId: 1, url: 'https://keep.example/' },
        { id: 11, windowId: 1, url: 'chrome://newtab/' },
        { id: 12, windowId: 1, url: 'https://a.example/' },
        { id: 13, windowId: 1, url: 'about:blank' },
      ],
    });

    await execute({
      operations: [
        { type: OpType.CREATE_WINDOW, slotIndex: 0, seedTabId: 12 },
        { type: OpType.MOVE_TABS, slotIndex: 0, targetWindowId: null, tabIds: [11, 13] },
      ],
      stats: {},
    });

    expect(mock.calls.tabs.remove).toHaveLength(0);
    const ids = mock.snapshot().tabs.map(t => t.id).sort();
    expect(ids).toEqual([10, 11, 12, 13]);
  });
});

describe('5.6 manual groups without tabUrls', () => {
  test('moveTabToManualGroup tolerates a target missing tabUrls', async () => {
    installChromeMock({
      local: { manualGroups: { g1: { id: 'g1', name: 'G', color: 'blue' } } },
    });
    await expect(moveTabToManualGroup('https://a.example/', 'g1')).resolves.toEqual({
      tabUrl: 'https://a.example/',
      targetGroupId: 'g1',
    });
    const stored = (await chrome.storage.local.get('manualGroups')).manualGroups;
    expect(stored.g1.tabUrls).toEqual(['https://a.example/']);
  });

  test('applyManualGroupToChrome tolerates a group missing tabUrls', async () => {
    const mock = installChromeMock({
      local: { manualGroups: { g1: { id: 'g1', name: 'G', color: 'blue', tabUrls: 'oops' } } },
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 11, windowId: 1, url: 'https://a.example/' }],
    });
    await expect(applyManualGroupToChrome('g1')).resolves.toBeUndefined();
    expect(mock.calls.tabs.group).toHaveLength(0);
  });
});
