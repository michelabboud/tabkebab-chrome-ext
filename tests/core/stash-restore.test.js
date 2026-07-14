import { describe, expect, test } from 'bun:test';

import { restoreStashTabs } from '../../core/stash-db.js';
import { installChromeMock } from '../helpers/chrome-mock.js';

function makeStash(tabs, groups = []) {
  return {
    id: 'stash-under-test',
    name: 'Restore test',
    createdAt: 1,
    tabCount: tabs.length,
    windows: [{ tabCount: tabs.length, tabs, groups }],
  };
}

function installHereChromeMock(overrides = {}) {
  return installChromeMock({
    windows: [{ id: 1, focused: true }],
    ...overrides,
  });
}

function observeDiscardAudioOrder() {
  const calls = [];
  chrome.tabs.onCreated.addListener((tab) => {
    calls.push(['create', { active: tab.active }]);
  });
  chrome.tabs.onUpdated.addListener((tabId, changes) => {
    if (changes.mutedInfo) {
      calls.push(['update', tabId, { muted: changes.mutedInfo.muted }]);
    }
    if (changes.discarded) calls.push(['discard', tabId]);
  });
  return calls;
}

describe('restoreStashTabs', () => {
  test('returns an exact incomplete outcome for restored, duplicate, invalid, and failed tabs', async () => {
    const stash = makeStash([
      { url: 'https://restore.test/one', title: 'One' },
      { url: 'https://open.test/', title: 'Already open' },
      { url: 'chrome://settings/', title: 'Forbidden' },
      { url: 'not a url', title: 'Malformed' },
      { url: 'https://restore.test/fail', title: 'Fails to create' },
    ]);
    installChromeMock({
      windows: [{ id: 7, focused: true }],
      tabs: [{ id: 70, windowId: 7, index: 0, active: true, url: 'https://open.test/' }],
      failures: { 'tabs.create': [null, new Error('synthetic create failure')] },
    });

    await expect(restoreStashTabs(stash, { mode: 'here', discarded: false })).resolves.toEqual({
      requestedCount: 5,
      restoredCount: 1,
      skippedDuplicate: 1,
      skippedInvalid: 2,
      errors: [{
        scope: 'create',
        url: 'https://restore.test/fail',
        message: 'synthetic create failure',
      }],
      complete: false,
      windowsCreated: 0,
      groupsRestored: 0,
    });
  });

  test('keeps successful saved-tab associations and leaves the stash object unchanged', async () => {
    const stash = makeStash([
      {
        url: 'https://association.test/first',
        title: 'A'.repeat(700),
        favIconUrl: 'javascript:bad-icon',
        pinned: true,
        groupId: 10,
      },
      {
        url: 'https://association.test/middle',
        title: 'Middle',
        pinned: true,
        groupId: 20,
      },
      {
        url: 'https://association.test/last',
        title: 'Last',
        pinned: false,
        groupId: 10,
      },
    ], [
      { id: 10, title: 'Survivors', color: 'blue', collapsed: true },
      { id: 20, title: 'Missing', color: 'red', collapsed: false },
    ]);
    const original = structuredClone(stash);
    const harness = installChromeMock({
      windows: [{ id: 4, focused: true }],
      tabs: [{ id: 40, windowId: 4, index: 0, active: true, url: 'https://current.test/' }],
      failures: { 'tabs.create': [null, new Error('middle create failed'), null] },
    });

    const result = await restoreStashTabs(stash, { mode: 'here', discarded: false });
    const restored = harness.snapshot().tabs.filter((tab) => tab.url.startsWith('https://association.test/'));
    const first = restored.find((tab) => tab.url.endsWith('/first'));
    const last = restored.find((tab) => tab.url.endsWith('/last'));

    expect(result).toEqual({
      requestedCount: 3,
      restoredCount: 2,
      skippedDuplicate: 0,
      skippedInvalid: 0,
      errors: [{
        scope: 'create',
        url: 'https://association.test/middle',
        message: 'middle create failed',
      }],
      complete: false,
      windowsCreated: 0,
      groupsRestored: 1,
    });
    expect(first).toEqual(expect.objectContaining({ pinned: true }));
    expect(last).toEqual(expect.objectContaining({ pinned: false, groupId: first.groupId }));
    expect(first.groupId).not.toBe(-1);
    expect(stash).toEqual(original);
  });

  test('mutes, discards, and then unmutes a background restore tab in order', async () => {
    const stash = makeStash([{ url: 'https://audio.test/background' }]);
    const harness = installHereChromeMock();
    const calls = observeDiscardAudioOrder();

    const result = await restoreStashTabs(stash, { mode: 'here' });
    const restoredTab = harness.snapshot().tabs.find((tab) => tab.url === 'https://audio.test/background');

    expect(calls).toEqual([
      ['create', { active: false }],
      ['update', restoredTab.id, { muted: true }],
      ['discard', restoredTab.id],
      ['update', restoredTab.id, { muted: false }],
    ]);
    expect(restoredTab.mutedInfo.muted).toBe(false);
    expect(result.complete).toBe(true);
  });

  test('never mutes a tab in non-discard mode', async () => {
    const stash = makeStash([{ url: 'https://audio.test/loaded' }]);
    const harness = installHereChromeMock();

    const result = await restoreStashTabs(stash, { mode: 'here', discarded: false });

    expect(harness.calls.tabs.update.filter(([, changes]) => changes.muted === true)).toEqual([]);
    expect(harness.calls.tabs.discard).toEqual([]);
    expect(result.complete).toBe(true);
  });

  test('keeps the first visible tab active and unmuted', async () => {
    const stash = makeStash([
      { url: 'https://visible.test/first' },
      { url: 'https://visible.test/background' },
    ]);
    const harness = installChromeMock();

    const result = await restoreStashTabs(stash, { mode: 'windows' });
    const first = harness.snapshot().tabs.find((tab) => tab.url === 'https://visible.test/first');

    expect(first).toEqual(expect.objectContaining({ active: true, discarded: false }));
    expect(first.mutedInfo.muted).toBe(false);
    expect(harness.calls.tabs.update).not.toContainEqual([first.id, { muted: true }]);
    expect(result.complete).toBe(true);
  });

  test('unmutes through finally and reports a discard failure', async () => {
    const stash = makeStash([{ url: 'https://audio.test/discard-failure' }]);
    const harness = installHereChromeMock({
      failures: { 'tabs.discard': new Error('synthetic discard failure') },
    });
    const calls = observeDiscardAudioOrder();

    const result = await restoreStashTabs(stash, { mode: 'here' });
    const restoredTab = harness.snapshot().tabs.find((tab) => tab.url === 'https://audio.test/discard-failure');

    expect(calls).toEqual([
      ['create', { active: false }],
      ['update', restoredTab.id, { muted: true }],
      ['update', restoredTab.id, { muted: false }],
    ]);
    expect(harness.calls.tabs.discard).toEqual([[restoredTab.id]]);
    expect(restoredTab.mutedInfo.muted).toBe(false);
    expect(result.errors).toEqual([{
      scope: 'discard',
      url: 'https://audio.test/discard-failure',
      message: 'synthetic discard failure',
    }]);
    expect(result.complete).toBe(false);
  });
});
