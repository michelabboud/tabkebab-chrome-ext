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

async function loadFocus(overrides = {}) {
  const harness = installChromeMock(overrides);
  const focus = await import(`../../core/focus.js?focus-lifecycle=${++importNonce}`);
  return { focus, harness };
}

function activeState(overrides = {}) {
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
    distractionsBlocked: 0,
    focusTabCount: 0,
    ...overrides,
  };
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

async function withUuidSequence(values, callback) {
  const original = crypto.randomUUID;
  let index = 0;
  crypto.randomUUID = () => values[index++];
  try {
    return await callback();
  } finally {
    crypto.randomUUID = original;
  }
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(message);
}

async function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    return { result: await callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

describe('Focus run identity', () => {
  test('allocates the new run identity before awaiting stored lifecycle state', async () => {
    const { focus } = await loadFocus();
    const entered = deferred();
    const release = deferred();
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = async (...args) => {
      if (args[0] === 'focusState') {
        entered.resolve();
        await release.promise;
      }
      return get(...args);
    };

    let uuidCalls = 0;
    const original = crypto.randomUUID;
    crypto.randomUUID = () => {
      uuidCalls++;
      return 'run-before-read';
    };
    try {
      const pending = focus.startFocus(startOptions());
      await entered.promise;
      expect(uuidCalls).toBe(1);
      release.resolve();
      expect((await pending).runId).toBe('run-before-read');
    } finally {
      release.resolve();
      crypto.randomUUID = original;
    }
  });

  test('two starts persist distinct UUIDs and finish the prior run first', async () => {
    const { focus } = await loadFocus();

    await withUuidSequence(['run-one', 'run-two'], async () => {
      const first = await focus.startFocus(startOptions());
      const second = await focus.startFocus(startOptions());

      expect(first.runId).toBe('run-one');
      expect(second.runId).toBe('run-two');
      expect(readStorageArea('local').focusState.runId).toBe('run-two');
      expect(readStorageArea('local').focusHistory.map(({ runId }) => runId)).toEqual(['run-one']);
    });
  });

  test('a legacy state receives a one-time cleanup ID that is terminal before the new run is saved', async () => {
    const legacy = activeState({ runId: undefined, focusGroupId: 0 });
    const { focus, harness } = await loadFocus({
      local: { focusState: legacy },
      tabs: [{ id: 4, windowId: 1, url: 'https://work.test/', groupId: 0 }],
      groups: [{ id: 0, windowId: 1, title: 'Coding' }],
    });

    await withUuidSequence(['new-run', 'legacy-cleanup'], async () => {
      const state = await focus.startFocus(startOptions());
      const writes = harness.calls.storage.local.set
        .map(([items]) => items.focusState)
        .filter(Boolean);

      expect(state.runId).toBe('new-run');
      expect(writes[0]).toEqual(expect.objectContaining({
        status: 'ending',
        runId: 'legacy-cleanup',
      }));
      expect(writes.at(-1)).toEqual(expect.objectContaining({
        status: 'active',
        runId: 'new-run',
      }));
      expect(writes.findIndex(({ runId }) => runId === 'new-run'))
        .toBeGreaterThan(harness.calls.storage.local.remove.length - 1);
      expect(readStorageArea('local').focusHistory[0].runId).toBe('legacy-cleanup');
      expect(state.runId).not.toBe('legacy-cleanup');
      expect(harness.calls.tabs.ungroup).toEqual([[[4]]]);
    });
  });

  test('a UUID collision with the previous run is regenerated before replacement', async () => {
    const { focus } = await loadFocus({
      local: { focusState: activeState({ runId: 'run-a' }) },
    });

    await withUuidSequence(['run-a', 'run-b'], async () => {
      const replacement = await focus.startFocus(startOptions());

      expect(replacement.runId).toBe('run-b');
      expect(readStorageArea('local').focusState.runId).toBe('run-b');
      expect(readStorageArea('local').focusHistory[0].runId).toBe('run-a');
    });
  });
});

describe('validateDistractionTarget', () => {
  const passingDecision = { distraction: true, confidence: 0.700001 };

  const rejectedCases = [
    ['missing state', null, {}, passingDecision],
    ['paused state', activeState({ status: 'paused' }), {}, passingDecision],
    ['ending state', activeState({ status: 'ending' }), {}, passingDecision],
    ['mismatched run', activeState({ runId: 'other-run' }), {}, passingDecision],
    ['empty run', activeState({ runId: '' }), {}, passingDecision],
    ['neither URL matches', activeState(), {
      url: 'https://elsewhere.test/current',
      pendingUrl: 'https://elsewhere.test/pending',
    }, passingDecision],
    ['non-distraction', activeState(), {}, { distraction: false, confidence: 1 }],
    ['confidence at threshold', activeState(), {}, { distraction: true, confidence: 0.7 }],
    ['string confidence', activeState(), {}, { distraction: true, confidence: '0.9' }],
    ['NaN confidence', activeState(), {}, { distraction: true, confidence: Number.NaN }],
    ['infinite confidence', activeState(), {}, { distraction: true, confidence: Infinity }],
    ['missing confidence', activeState(), {}, { distraction: true }],
  ];

  for (const [name, state, tabOverrides, decision] of rejectedCases) {
    test(`rejects ${name}`, async () => {
      const classifiedUrl = 'https://classified.test/path';
      const tabs = state === null ? [] : [{
        id: 5,
        windowId: 1,
        url: classifiedUrl,
        pendingUrl: '',
        ...tabOverrides,
      }];
      const { focus } = await loadFocus({
        local: state === null ? {} : { focusState: state },
        tabs,
      });

      expect(await focus.validateDistractionTarget({
        runId: 'run-a',
        tabId: 5,
        classifiedUrl,
        decision,
      })).toBeNull();
    });
  }

  test('rejects a removed tab after validating the active run', async () => {
    const { focus, harness } = await loadFocus({ local: { focusState: activeState() } });

    expect(await focus.validateDistractionTarget({
      runId: 'run-a',
      tabId: 404,
      classifiedUrl: 'https://classified.test/',
      decision: passingDecision,
    })).toBeNull();
    expect(harness.calls.storage.local.get.at(-1)).toEqual(['focusState']);
    expect(harness.calls.tabs.get).toEqual([[404]]);
  });

  for (const [name, tab] of [
    ['current URL', {
      url: 'https://classified.test/path',
      pendingUrl: 'https://different.test/pending',
    }],
    ['non-empty pending URL', {
      url: 'https://different.test/current',
      pendingUrl: 'https://classified.test/path',
    }],
  ]) {
    test(`accepts an exact ${name} match independently`, async () => {
      const { focus } = await loadFocus({
        local: { focusState: activeState() },
        tabs: [{ id: 5, windowId: 1, ...tab }],
      });

      expect(await focus.validateDistractionTarget({
        runId: 'run-a',
        tabId: 5,
        classifiedUrl: 'https://classified.test/path',
        decision: passingDecision,
      })).toEqual({
        state: expect.objectContaining({ runId: 'run-a', status: 'active' }),
        tab: expect.objectContaining({ id: 5 }),
      });
    });
  }

  for (const transition of ['pause', 'end', 'replacement']) {
    test(`rejects ${transition} while the first live tab read is pending`, async () => {
      const classifiedUrl = 'https://classified.test/first-read';
      const entered = deferred();
      const release = deferred();
      const { focus, harness } = await loadFocus({
        local: { focusState: activeState() },
        tabs: [{ id: 5, windowId: 1, url: classifiedUrl }],
      });
      const getTab = chrome.tabs.get.bind(chrome.tabs);
      chrome.tabs.get = async (...args) => {
        const tab = await getTab(...args);
        entered.resolve();
        await release.promise;
        return tab;
      };

      const pending = focus.handleDistraction({
        runId: 'run-a',
        tabId: 5,
        classifiedUrl,
        decision: { distraction: true, confidence: 1 },
        category: 'strict',
      });
      await entered.promise;
      const nextState = transition === 'replacement'
        ? activeState({ runId: 'run-b' })
        : activeState({ status: transition === 'pause' ? 'paused' : 'ending' });
      await chrome.storage.local.set({ focusState: nextState });
      release.resolve();

      expect(await pending).toBeNull();
      expect(harness.calls.tabs.goBack).toEqual([]);
      expect(harness.calls.tabs.remove).toEqual([]);
    });
  }

  test('rejects a pause-resume ABA cycle while the live tab read is pending', async () => {
    const classifiedUrl = 'https://classified.test/aba';
    const entered = deferred();
    const release = deferred();
    const { focus, harness } = await loadFocus({
      local: { focusState: activeState() },
      tabs: [{ id: 5, windowId: 1, url: classifiedUrl }],
    });
    const getTab = chrome.tabs.get.bind(chrome.tabs);
    chrome.tabs.get = async (...args) => {
      const tab = await getTab(...args);
      entered.resolve();
      await release.promise;
      return tab;
    };

    const pending = focus.handleDistraction({
      runId: 'run-a',
      tabId: 5,
      classifiedUrl,
      decision: { distraction: true, confidence: 1 },
      category: 'strict',
    });
    await entered.promise;
    await chrome.storage.local.set({
      focusState: activeState({ status: 'paused', pausedAt: Date.now() }),
    });
    await chrome.storage.local.set({ focusState: activeState() });
    release.resolve();

    expect(await pending).toBeNull();
    expect(harness.calls.tabs.goBack).toEqual([]);
    expect(harness.calls.tabs.remove).toEqual([]);
  });

  for (const transition of ['pause', 'end', 'replacement']) {
    test(`rejects ${transition} while the fallback live tab read is pending`, async () => {
      const classifiedUrl = 'https://classified.test/fallback-read';
      const entered = deferred();
      const release = deferred();
      const { focus, harness } = await loadFocus({
        local: { focusState: activeState() },
        tabs: [{ id: 5, windowId: 1, url: classifiedUrl }],
      });
      const getTab = chrome.tabs.get.bind(chrome.tabs);
      let reads = 0;
      chrome.tabs.get = async (...args) => {
        const tab = await getTab(...args);
        reads++;
        if (reads === 2) {
          entered.resolve();
          await release.promise;
        }
        return tab;
      };
      chrome.tabs.goBack = async () => {
        harness.calls.tabs.goBack.push([5]);
        throw new Error('synthetic missing history');
      };

      const pending = focus.handleDistraction({
        runId: 'run-a',
        tabId: 5,
        classifiedUrl,
        decision: { distraction: true, confidence: 1 },
        category: 'strict',
      });
      await entered.promise;
      const nextState = transition === 'replacement'
        ? activeState({ runId: 'run-b' })
        : activeState({ status: transition === 'pause' ? 'paused' : 'ending' });
      await chrome.storage.local.set({ focusState: nextState });
      release.resolve();

      expect(await pending).toBeNull();
      expect(harness.calls.tabs.goBack).toEqual([[5]]);
      expect(harness.calls.tabs.remove).toEqual([]);
    });
  }

  test('does not await another state read between the final tab snapshot and goBack', async () => {
    const classifiedUrl = 'https://classified.test/final-order';
    const navigatedUrl = 'https://navigated.test/after-tab-read';
    const { focus, harness } = await loadFocus({
      local: { focusState: activeState() },
      tabs: [{ id: 5, windowId: 1, url: classifiedUrl }],
    });
    const getStorage = chrome.storage.local.get.bind(chrome.storage.local);
    let focusStateReads = 0;
    let goBackCompletedBeforeSecondRead = null;
    chrome.storage.local.get = async (...args) => {
      const result = await getStorage(...args);
      if (args[0] === 'focusState' && ++focusStateReads === 2) {
        goBackCompletedBeforeSecondRead = harness.calls.tabs.goBack.length === 1;
        await chrome.tabs.update(5, { url: navigatedUrl });
      }
      return result;
    };

    await focus.handleDistraction({
      runId: 'run-a',
      tabId: 5,
      classifiedUrl,
      decision: { distraction: true, confidence: 1 },
      category: 'strict',
    });

    expect(goBackCompletedBeforeSecondRead).toBeTrue();
    expect(harness.calls.tabs.goBack).toEqual([[5]]);
  });
});

describe('ending and recovery', () => {
  test('ending a paused run freezes elapsed time at the pause boundary', async () => {
    const startedAt = Date.now() - 120_000;
    const pausedAt = startedAt + 45_000;
    const { focus } = await loadFocus({
      local: {
        focusState: activeState({
          status: 'paused',
          startedAt,
          pausedAt,
          pausedElapsed: 5_000,
        }),
      },
    });

    const record = await focus.endFocus({ expectedRunId: 'run-a' });

    expect(record.actualDurationMs).toBe(40_000);
    expect(readStorageArea('local').focusHistory[0].actualDurationMs).toBe(40_000);
  });

  test('persists ending before restore and group zero teardown, then removes state last', async () => {
    const order = [];
    const { focus, harness } = await loadFocus({
      local: { focusState: activeState({ stashId: 'stash-1', focusGroupId: 0 }) },
      tabs: [{ id: 8, windowId: 1, url: 'https://work.test/', groupId: 0 }],
      groups: [{ id: 0, windowId: 1, title: 'Coding' }],
    });
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    const remove = chrome.storage.local.remove.bind(chrome.storage.local);
    chrome.storage.local.set = async (items) => {
      if (items.focusState) order.push(`state:${items.focusState.status}`);
      if (items.focusHistory) order.push('history');
      return set(items);
    };
    chrome.storage.local.remove = async (key) => {
      order.push(`remove:${key}`);
      return remove(key);
    };

    const record = await focus.endFocus({
      expectedRunId: 'run-a',
      adapters: {
        getStash: async () => ({ id: 'stash-1', windows: [] }),
        restoreStashTabs: async () => {
          order.push(`restore:${readStorageArea('local').focusState.status}`);
        },
        ungroupTabs: async (ids) => {
          order.push(`ungroup:${ids.join(',')}:${readStorageArea('local').focusState.status}`);
        },
      },
    });

    expect(order[0]).toBe('state:ending');
    expect(order).toContain('restore:ending');
    expect(order).toContain('ungroup:8:ending');
    expect(order.at(-1)).toBe('remove:focusState');
    expect(harness.calls.tabs.query).toContainEqual([{ groupId: 0 }]);
    expect(record).toEqual(expect.objectContaining({ runId: 'run-a', teardownFailures: [] }));
    expect(readStorageArea('local').focusState).toBeUndefined();
  });

  test('partial teardown failures are structured and do not prevent terminal cleanup', async () => {
    const { focus } = await loadFocus({
      local: { focusState: activeState({ stashId: 'stash-1', focusGroupId: 0 }) },
      failures: {
        'tabs.query': new Error('group query failed'),
        'alarms.clear': new Error('alarm failed'),
        'action.setBadgeText': new Error('badge failed'),
      },
    });

    const { result: record, warnings } = await captureWarnings(() => focus.endFocus({
        expectedRunId: 'run-a',
        adapters: {
          getStash: async () => { throw new Error('stash failed'); },
        },
      }));

    expect(record.teardownFailures).toEqual(expect.arrayContaining([
      { step: 'restore', message: 'stash failed' },
      { step: 'ungroup', message: 'group query failed' },
      { step: 'alarm', message: 'alarm failed' },
      { step: 'badge', message: 'badge failed' },
    ]));
    expect(readStorageArea('local').focusState).toBeUndefined();
    expect(readStorageArea('local').focusHistory).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  test('a history write failure is reported and still reaches final state cleanup', async () => {
    const { focus } = await loadFocus({
      local: { focusState: activeState() },
      failures: {
        'storage.local.set': [null, new Error('history write failed')],
      },
    });

    const { result: record, warnings } = await captureWarnings(() => focus.endFocus({
      expectedRunId: 'run-a',
    }));

    expect(record.teardownFailures).toContainEqual({
      step: 'history',
      message: 'history write failed',
    });
    expect(readStorageArea('local').focusState).toBeUndefined();
    expect(readStorageArea('local').focusHistory).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  test('history is deduplicated when final removal fails and a worker restart recovers ending', async () => {
    const { focus } = await loadFocus({
      local: { focusState: activeState() },
      failures: { 'storage.local.remove': new Error('synthetic final removal failure') },
    });

    const { result: first, warnings } = await captureWarnings(() => focus.endFocus({
      expectedRunId: 'run-a',
    }));
    expect(first.teardownFailures).toContainEqual({
      step: 'state',
      message: 'synthetic final removal failure',
    });
    expect(readStorageArea('local').focusState.status).toBe('ending');
    expect(readStorageArea('local').focusHistory).toHaveLength(1);
    expect(warnings).toHaveLength(1);

    await import(`../../service-worker.js?focus-recovery=${++importNonce}`);
    await waitFor(
      () => readStorageArea('local').focusState === undefined,
      'worker restart did not recover the ending run',
    );
    expect(readStorageArea('local').focusHistory).toHaveLength(1);
    expect(readStorageArea('local').focusHistory[0].runId).toBe('run-a');
  });

  test('recovery does not repeat a successfully checkpointed stash restore', async () => {
    let stashReads = 0;
    let restoreCalls = 0;
    const adapters = {
      getStash: async () => {
        stashReads++;
        return {
          id: 'stash-1',
          windows: [{ tabs: [{ url: 'https://restored.test/' }] }],
        };
      },
      restoreStashTabs: async () => {
        restoreCalls++;
        return { complete: true, requestedCount: 1, restoredCount: 1 };
      },
    };
    const { focus } = await loadFocus({
      local: { focusState: activeState({ stashId: 'stash-1' }) },
      failures: { 'storage.local.remove': new Error('synthetic final removal failure') },
    });

    await captureWarnings(() => focus.endFocus({ expectedRunId: 'run-a', adapters }));
    expect(readStorageArea('local').focusState).toEqual(expect.objectContaining({
      status: 'ending',
      runId: 'run-a',
      teardownCompleted: { restore: true },
    }));

    const recoveredFocus = await import(`../../core/focus.js?focus-restore-recovery=${++importNonce}`);
    await recoveredFocus.endFocus({ expectedRunId: 'run-a', adapters });

    expect(stashReads).toBe(1);
    expect(restoreCalls).toBe(1);
    expect(readStorageArea('local').focusState).toBeUndefined();
    expect(readStorageArea('local').focusHistory).toHaveLength(1);
  });

  test('an incomplete stash restore is not checkpointed and retries on recovery', async () => {
    let restoreCalls = 0;
    const adapters = {
      getStash: async () => ({
        id: 'stash-1',
        windows: [{ tabs: [{ url: 'https://restore-retry.test/' }] }],
      }),
      restoreStashTabs: async () => {
        restoreCalls++;
        return restoreCalls === 1
          ? { complete: false, requestedCount: 1, restoredCount: 0 }
          : { complete: true, requestedCount: 1, restoredCount: 1 };
      },
    };
    const { focus } = await loadFocus({
      local: { focusState: activeState({ stashId: 'stash-1' }) },
      failures: { 'storage.local.remove': new Error('synthetic final removal failure') },
    });

    await captureWarnings(() => focus.endFocus({ expectedRunId: 'run-a', adapters }));
    expect(readStorageArea('local').focusState.teardownCompleted?.restore).not.toBeTrue();

    const recoveredFocus = await import(`../../core/focus.js?focus-incomplete-recovery=${++importNonce}`);
    await recoveredFocus.endFocus({ expectedRunId: 'run-a', adapters });

    expect(restoreCalls).toBe(2);
    expect(readStorageArea('local').focusState).toBeUndefined();
    expect(readStorageArea('local').focusHistory).toHaveLength(1);
  });

  test('concurrent end calls share one teardown flight', async () => {
    const restoreGate = deferred();
    let restoreCalls = 0;
    const { focus } = await loadFocus({
      local: { focusState: activeState({ stashId: 'stash-1' }) },
    });
    const options = {
      expectedRunId: 'run-a',
      adapters: {
        getStash: async () => ({ id: 'stash-1', windows: [] }),
        restoreStashTabs: async () => {
          restoreCalls++;
          await restoreGate.promise;
        },
      },
    };

    const first = focus.endFocus(options);
    const second = focus.endFocus(options);
    await Bun.sleep(1);
    expect(restoreCalls).toBe(1);
    restoreGate.resolve();
    expect(await second).toEqual(await first);
    expect(restoreCalls).toBe(1);
    expect(readStorageArea('local').focusHistory).toHaveLength(1);
  });
});

describe('stale lifecycle continuations', () => {
  for (const boundary of ['pre-persist', 'alarm', 'badge']) {
    test(`end is serialized through ${boundary} startup and leaves no active authority`, async () => {
      const entered = deferred();
      const release = deferred();
      const { focus, harness } = await loadFocus();

      if (boundary === 'pre-persist') {
        const query = chrome.tabGroups.query.bind(chrome.tabGroups);
        chrome.tabGroups.query = async (...args) => {
          entered.resolve();
          await release.promise;
          return query(...args);
        };
      } else if (boundary === 'alarm') {
        const createAlarm = chrome.alarms.create.bind(chrome.alarms);
        chrome.alarms.create = async (...args) => {
          if (args[0] === 'focusTick') {
            entered.resolve();
            await release.promise;
          }
          return createAlarm(...args);
        };
      } else {
        const setBadgeText = chrome.action.setBadgeText.bind(chrome.action);
        let held = false;
        chrome.action.setBadgeText = async (...args) => {
          if (!held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return setBadgeText(...args);
        };
      }

      await withUuidSequence(['run-start'], async () => {
        let authorityWhenStartResolved;
        const start = focus.startFocus(startOptions()).then((state) => {
          authorityWhenStartResolved = readStorageArea('local').focusState;
          return state;
        });
        await entered.promise;

        let endSettled = false;
        const end = focus.endFocus().then((record) => {
          endSettled = true;
          return record;
        });
        await Bun.sleep(1);
        const endSettledWhileHeld = endSettled;
        release.resolve();
        const started = await start;
        const record = await end;

        expect(endSettledWhileHeld).toBeFalse();
        expect(started.runId).toBe('run-start');
        expect(authorityWhenStartResolved).toEqual(expect.objectContaining({
          status: 'active',
          runId: 'run-start',
        }));
        expect(record.runId).toBe('run-start');
      });

      expect(readStorageArea('local').focusState).toBeUndefined();
      expect(harness.snapshot().alarms.find(({ name }) => name === 'focusTick')).toBeUndefined();
      expect(harness.snapshot().action.badgeText).toBe('');
    });
  }

  test('pause persists paused authority before starting badge work', async () => {
    const observedStatuses = [];
    const { focus } = await loadFocus({ local: { focusState: activeState() } });
    const setBadgeText = chrome.action.setBadgeText.bind(chrome.action);
    chrome.action.setBadgeText = async (...args) => {
      observedStatuses.push(readStorageArea('local').focusState?.status);
      return setBadgeText(...args);
    };

    await focus.pauseFocus();

    expect(observedStatuses).toEqual(['paused']);
  });

  test('a state swap during badge text write repaints the latest run', async () => {
    const replacement = activeState({
      status: 'paused',
      runId: 'run-b',
      pausedAt: Date.now(),
      profileName: 'Replacement',
    });
    const { focus, harness } = await loadFocus({
      local: { focusState: activeState() },
    });
    const setBadgeText = chrome.action.setBadgeText.bind(chrome.action);
    let swapped = false;
    chrome.action.setBadgeText = async (...args) => {
      if (!swapped) {
        swapped = true;
        await chrome.storage.local.set({ focusState: replacement });
      }
      return setBadgeText(...args);
    };

    await focus.updateBadge(activeState(), 'run-a');

    expect(harness.snapshot().action.badgeText).toBe('||');
    expect(harness.snapshot().action.badgeBackgroundColor).toBe('#f59e0b');
  });

  test('a deferred pause write cannot resurrect a run that ends concurrently', async () => {
    const pauseWriteEntered = deferred();
    const releasePauseWrite = deferred();
    const { focus } = await loadFocus({ local: { focusState: activeState() } });
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (items) => {
      if (items.focusState?.status === 'paused') {
        pauseWriteEntered.resolve();
        await releasePauseWrite.promise;
      }
      return set(items);
    };

    const pause = focus.pauseFocus();
    await pauseWriteEntered.promise;
    const end = focus.endFocus({ expectedRunId: 'run-a' });
    await Bun.sleep(1);
    releasePauseWrite.resolve();
    await Promise.all([pause, end]);

    expect(readStorageArea('local').focusState).toBeUndefined();
    expect(readStorageArea('local').focusHistory).toHaveLength(1);
    expect(readStorageArea('local').focusHistory[0].runId).toBe('run-a');
  });

  test('a deferred distraction counter write cannot overwrite a concurrent end', async () => {
    const counterWriteEntered = deferred();
    const releaseCounterWrite = deferred();
    const classifiedUrl = 'https://blocked.test/path';
    const { focus, harness } = await loadFocus({
      local: { focusState: activeState() },
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 9, windowId: 1, url: classifiedUrl }],
    });
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (items) => {
      if (items.focusState?.status === 'active' &&
          items.focusState.distractionsBlocked === 1) {
        counterWriteEntered.resolve();
        await releaseCounterWrite.promise;
      }
      return set(items);
    };

    const distraction = focus.handleDistraction({
      runId: 'run-a',
      tabId: 9,
      classifiedUrl,
      decision: { distraction: true, confidence: 1 },
      category: 'strict',
    });
    await counterWriteEntered.promise;
    const end = focus.endFocus({ expectedRunId: 'run-a' });
    await Bun.sleep(1);
    const notificationCountAtEnd = harness.calls.runtime.sendMessage.filter(
      ([message]) => message?.type === 'focusDistraction',
    ).length;
    releaseCounterWrite.resolve();
    await Promise.all([distraction, end]);

    expect(readStorageArea('local').focusState).toBeUndefined();
    expect(readStorageArea('local').focusHistory).toHaveLength(1);
    expect(harness.calls.runtime.sendMessage.filter(
      ([message]) => message?.type === 'focusDistraction',
    )).toHaveLength(notificationCountAtEnd);
  });

  test('an old tick cannot end a replacement run', async () => {
    const replacement = activeState({
      runId: 'run-b',
      startedAt: Date.now() - 120_000,
      duration: 1,
    });
    const { focus, harness } = await loadFocus({ local: { focusState: replacement } });

    await focus.handleFocusTick('run-a');

    expect(readStorageArea('local').focusState).toEqual(replacement);
    expect(harness.calls.storage.local.remove).toEqual([]);
  });

  for (const operation of ['resume', 'rebind']) {
    test(`a stale ${operation} continuation cannot overwrite a replacement run`, async () => {
      const initial = activeState({
        status: operation === 'resume' ? 'paused' : 'active',
        pausedAt: operation === 'resume' ? Date.now() - 1000 : null,
        allowedDomains: [{ type: 'group', value: 'Deep Work', groupIds: [90] }],
      });
      const replacement = activeState({ runId: 'run-b', profileName: 'Replacement' });
      const { focus } = await loadFocus({
        local: { focusState: initial },
        groups: [{ id: 7, title: 'Deep Work' }],
      });
      const gate = deferred();
      const query = chrome.tabGroups.query.bind(chrome.tabGroups);
      chrome.tabGroups.query = async (...args) => {
        const result = await query(...args);
        await gate.promise;
        return result;
      };

      const pending = operation === 'resume'
        ? focus.resumeFocus()
        : focus.rebindStoredFocusState();
      await Bun.sleep(1);
      await chrome.storage.local.set({ focusState: replacement });
      gate.resolve();

      expect(await pending).toBeNull();
      expect(readStorageArea('local').focusState).toEqual(replacement);
    });
  }

  test('a delayed distraction badge reset cannot paint a replacement run', async () => {
    const callbacks = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback) => {
      callbacks.push(callback);
      return 1;
    };
    try {
      const { focus, harness } = await loadFocus({
        local: { focusState: activeState() },
      });
      await focus.flashBadgeDistraction('run-a');
      await chrome.storage.local.set({
        focusState: activeState({
          status: 'paused',
          runId: 'run-b',
          pausedAt: Date.now(),
        }),
      });

      await callbacks[0]();

      expect(harness.snapshot().action.badgeText).toBe('||');
      expect(harness.snapshot().action.badgeBackgroundColor).toBe('#f59e0b');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
