import { describe, expect, test } from 'bun:test';

import { restoreSession } from '../../core/sessions.js';
import { installChromeMock, readStorageArea } from '../helpers/chrome-mock.js';

function makeSession(tabs, groups = []) {
  return {
    id: 'session-under-test',
    name: 'Restore test',
    version: 2,
    createdAt: 1,
    modifiedAt: 1,
    windows: [{ tabCount: tabs.length, tabs, groups }],
  };
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

describe('restoreSession', () => {
  test('returns an exact incomplete outcome for restored, duplicate, invalid, and failed tabs', async () => {
    const session = makeSession([
      { url: 'https://restore.test/one', title: 'One' },
      { url: 'https://open.test/', title: 'Already open' },
      { url: 'chrome://settings/', title: 'Forbidden' },
      { url: 'not a url', title: 'Malformed' },
      { url: 'https://restore.test/fail', title: 'Fails to create' },
    ]);
    installChromeMock({
      local: { sessions: [session] },
      windows: [{ id: 7, focused: true }],
      tabs: [{ id: 70, windowId: 7, index: 0, active: true, url: 'https://open.test/' }],
      failures: { 'tabs.create': [null, new Error('synthetic create failure')] },
    });

    await expect(restoreSession(session.id, { mode: 'here', discarded: false })).resolves.toEqual({
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

  test('keeps successful saved-tab associations when the middle creation fails', async () => {
    const session = makeSession([
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
    const original = structuredClone(session);
    const harness = installChromeMock({
      local: { sessions: [session] },
      windows: [{ id: 4, focused: true }],
      tabs: [{ id: 40, windowId: 4, index: 0, active: true, url: 'https://current.test/' }],
      failures: { 'tabs.create': [null, new Error('middle create failed'), null] },
    });

    const result = await restoreSession(session.id, { mode: 'here', discarded: false });
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
    expect(readStorageArea('local').sessions[0]).toEqual(original);
  });

  test('mutes, discards, and then unmutes a background restore tab in order', async () => {
    const session = makeSession([{ url: 'https://audio.test/background' }]);
    const harness = installChromeMock({ local: { sessions: [session] } });
    const calls = observeDiscardAudioOrder();

    const result = await restoreSession(session.id, { mode: 'here' });
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
    const session = makeSession([{ url: 'https://audio.test/loaded' }]);
    const harness = installChromeMock({ local: { sessions: [session] } });

    const result = await restoreSession(session.id, { mode: 'here', discarded: false });

    expect(harness.calls.tabs.update.filter(([, changes]) => changes.muted === true)).toEqual([]);
    expect(harness.calls.tabs.discard).toEqual([]);
    expect(result.complete).toBe(true);
  });

  test('keeps the first visible tab active and unmuted', async () => {
    const session = makeSession([
      { url: 'https://visible.test/first' },
      { url: 'https://visible.test/background' },
    ]);
    const harness = installChromeMock({ local: { sessions: [session] } });

    const result = await restoreSession(session.id, { mode: 'windows' });
    const first = harness.snapshot().tabs.find((tab) => tab.url === 'https://visible.test/first');

    expect(first).toEqual(expect.objectContaining({ active: true, discarded: false }));
    expect(first.mutedInfo.muted).toBe(false);
    expect(harness.calls.tabs.update).not.toContainEqual([first.id, { muted: true }]);
    expect(result.complete).toBe(true);
  });

  test('windows mode retries a rejected seed and restores later siblings with aligned metadata', async () => {
    const session = makeSession([
      { url: 'https://seed-fallback.test/rejected', pinned: true, groupId: 20 },
      { url: 'https://seed-fallback.test/visible', pinned: true, groupId: 10 },
      { url: 'https://seed-fallback.test/background', pinned: false, groupId: 10 },
    ], [
      { id: 10, title: 'Survivors', color: 'blue', collapsed: true },
      { id: 20, title: 'Rejected', color: 'red', collapsed: false },
    ]);
    const harness = installChromeMock({
      local: { sessions: [session] },
      failures: { 'windows.create': [new Error('first seed rejected'), null] },
    });

    const result = await restoreSession(session.id, { mode: 'windows', discarded: false });
    const restored = harness.snapshot().tabs.filter((tab) =>
      tab.url.startsWith('https://seed-fallback.test/'),
    );
    const visible = restored.find((tab) => tab.url.endsWith('/visible'));
    const background = restored.find((tab) => tab.url.endsWith('/background'));

    expect(result).toEqual({
      requestedCount: 3,
      restoredCount: 2,
      skippedDuplicate: 0,
      skippedInvalid: 0,
      errors: [{
        scope: 'create',
        url: 'https://seed-fallback.test/rejected',
        message: 'first seed rejected',
      }],
      complete: false,
      windowsCreated: 1,
      groupsRestored: 1,
    });
    expect(harness.calls.windows.create.map(([createData]) => createData.url)).toEqual([
      'https://seed-fallback.test/rejected',
      'https://seed-fallback.test/visible',
    ]);
    expect(harness.calls.tabs.create).toEqual([[
      {
        windowId: visible.windowId,
        url: 'https://seed-fallback.test/background',
        active: false,
      },
    ]]);
    expect(visible).toEqual(expect.objectContaining({
      active: true,
      pinned: true,
      discarded: false,
    }));
    expect(visible.mutedInfo.muted).toBe(false);
    expect(background).toEqual(expect.objectContaining({
      active: false,
      pinned: false,
      groupId: visible.groupId,
    }));
    expect(harness.snapshot().groups).toEqual([
      expect.objectContaining({ title: 'Survivors', color: 'blue', collapsed: true }),
    ]);
  });

  test('single-window mode retries a rejected seed and keeps the eventual visible tab unmuted', async () => {
    const session = makeSession([
      { url: 'https://single-seed.test/rejected' },
      { url: 'https://single-seed.test/visible' },
      { url: 'https://single-seed.test/background' },
    ]);
    const harness = installChromeMock({
      local: { sessions: [session] },
      failures: { 'windows.create': [new Error('single seed rejected'), null] },
    });

    const result = await restoreSession(session.id, {
      mode: 'single-window',
      discarded: false,
    });
    const restored = harness.snapshot().tabs.filter((tab) =>
      tab.url.startsWith('https://single-seed.test/'),
    );
    const visible = restored.find((tab) => tab.url.endsWith('/visible'));
    const background = restored.find((tab) => tab.url.endsWith('/background'));

    expect(result).toEqual({
      requestedCount: 3,
      restoredCount: 2,
      skippedDuplicate: 0,
      skippedInvalid: 0,
      errors: [{
        scope: 'create',
        url: 'https://single-seed.test/rejected',
        message: 'single seed rejected',
      }],
      complete: false,
      windowsCreated: 1,
      groupsRestored: 0,
    });
    expect(harness.calls.windows.create.map(([createData]) => createData.url)).toEqual([
      'https://single-seed.test/rejected',
      'https://single-seed.test/visible',
    ]);
    expect(harness.calls.tabs.create).toEqual([[
      {
        windowId: visible.windowId,
        url: 'https://single-seed.test/background',
        active: false,
      },
    ]]);
    expect(visible).toEqual(expect.objectContaining({ active: true, discarded: false }));
    expect(visible.mutedInfo.muted).toBe(false);
    expect(background).toEqual(expect.objectContaining({ active: false }));
  });

  test('accounts for every candidate when every single-window seed is rejected', async () => {
    const session = makeSession([
      { url: 'https://all-seeds.test/first' },
      { url: 'https://all-seeds.test/second' },
      { url: 'https://all-seeds.test/third' },
    ]);
    const harness = installChromeMock({
      local: { sessions: [session] },
      failures: {
        'windows.create': [
          new Error('first rejected'),
          new Error('second rejected'),
          new Error('third rejected'),
        ],
      },
    });

    const result = await restoreSession(session.id, {
      mode: 'single-window',
      discarded: false,
    });

    expect(result).toEqual({
      requestedCount: 3,
      restoredCount: 0,
      skippedDuplicate: 0,
      skippedInvalid: 0,
      errors: [
        { scope: 'create', url: 'https://all-seeds.test/first', message: 'first rejected' },
        { scope: 'create', url: 'https://all-seeds.test/second', message: 'second rejected' },
        { scope: 'create', url: 'https://all-seeds.test/third', message: 'third rejected' },
      ],
      complete: false,
      windowsCreated: 0,
      groupsRestored: 0,
    });
    expect(harness.calls.windows.create).toHaveLength(3);
    expect(harness.calls.tabs.create).toEqual([]);
  });

  test('does not open another seed window after a post-create visibility update failure', async () => {
    const session = makeSession([
      { url: 'https://post-create.test/visible' },
      { url: 'https://post-create.test/background' },
    ]);
    const harness = installChromeMock({
      local: { sessions: [session] },
      failures: { 'tabs.update': new Error('visibility update failed') },
    });

    const result = await restoreSession(session.id, {
      mode: 'single-window',
      discarded: false,
    });
    const visible = harness.snapshot().tabs.find((tab) =>
      tab.url === 'https://post-create.test/visible',
    );

    expect(result.errors).toEqual([{
      scope: 'update',
      url: 'https://post-create.test/visible',
      message: 'visibility update failed',
    }]);
    expect(result.restoredCount).toBe(2);
    expect(harness.calls.windows.create).toHaveLength(1);
    expect(harness.calls.tabs.create).toHaveLength(1);
    expect(visible).toEqual(expect.objectContaining({ active: true, discarded: false }));
    expect(visible.mutedInfo.muted).toBe(false);
  });

  test('reuses a created seed window when seed-tab discovery fails', async () => {
    const session = makeSession([
      { url: 'https://seed-discovery.test/unknown' },
      { url: 'https://seed-discovery.test/survivor' },
    ]);
    const harness = installChromeMock({ local: { sessions: [session] } });
    const createWindow = chrome.windows.create.bind(chrome.windows);
    const queryTabs = chrome.tabs.query.bind(chrome.tabs);
    chrome.windows.create = async (createData) => {
      const window = await createWindow(createData);
      return { ...window, tabs: [] };
    };
    chrome.tabs.query = async (queryInfo = {}) => {
      if (queryInfo.windowId !== undefined) {
        throw new Error('seed tab discovery failed');
      }
      return queryTabs(queryInfo);
    };

    const result = await restoreSession(session.id, {
      mode: 'single-window',
      discarded: false,
    });
    const survivor = harness.snapshot().tabs.find((tab) =>
      tab.url === 'https://seed-discovery.test/survivor',
    );

    expect(result).toEqual({
      requestedCount: 2,
      restoredCount: 1,
      skippedDuplicate: 0,
      skippedInvalid: 0,
      errors: [{
        scope: 'create',
        url: 'https://seed-discovery.test/unknown',
        message: 'seed tab discovery failed',
      }],
      complete: false,
      windowsCreated: 1,
      groupsRestored: 0,
    });
    expect(harness.calls.windows.create).toHaveLength(1);
    expect(harness.calls.tabs.create).toEqual([[
      {
        windowId: survivor.windowId,
        url: 'https://seed-discovery.test/survivor',
        active: false,
      },
    ]]);
    expect(survivor).toEqual(expect.objectContaining({ active: true, discarded: false }));
    expect(survivor.mutedInfo.muted).toBe(false);
  });

  test('unmutes through finally and reports a discard failure', async () => {
    const session = makeSession([{ url: 'https://audio.test/discard-failure' }]);
    const harness = installChromeMock({
      local: { sessions: [session] },
      failures: { 'tabs.discard': new Error('synthetic discard failure') },
    });
    const calls = observeDiscardAudioOrder();

    const result = await restoreSession(session.id, { mode: 'here' });
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

  test('retries pending unmute cleanup in the outer finally', async () => {
    const session = makeSession([{ url: 'https://audio.test/unmute-retry' }]);
    const harness = installChromeMock({
      local: { sessions: [session] },
      failures: { 'tabs.update': [null, new Error('first unmute failed'), null] },
    });

    const result = await restoreSession(session.id, { mode: 'here' });
    const restoredTab = harness.snapshot().tabs.find((tab) => tab.url === 'https://audio.test/unmute-retry');

    expect(harness.calls.tabs.update).toEqual([
      [restoredTab.id, { muted: true }],
      [restoredTab.id, { muted: false }],
      [restoredTab.id, { muted: false }],
    ]);
    expect(restoredTab.mutedInfo.muted).toBe(false);
    expect(result.errors).toEqual([{
      scope: 'unmute',
      url: 'https://audio.test/unmute-retry',
      message: 'first unmute failed',
    }]);
    expect(result.complete).toBe(false);
  });

  test('reports a pin update failure without losing the created tab', async () => {
    const session = makeSession([{ url: 'https://metadata.test/pin', pinned: true }]);
    const harness = installChromeMock({
      local: { sessions: [session] },
      failures: { 'tabs.update': new Error('synthetic pin failure') },
    });

    const result = await restoreSession(session.id, { mode: 'here', discarded: false });

    expect(harness.snapshot().tabs.some((tab) => tab.url === 'https://metadata.test/pin')).toBe(true);
    expect(result.errors).toEqual([{
      scope: 'pin',
      url: 'https://metadata.test/pin',
      message: 'synthetic pin failure',
    }]);
    expect(result.complete).toBe(false);
  });

  test('reports group creation and metadata update failures with their saved URL', async () => {
    const group = { id: 10, title: 'Saved group', color: 'blue', collapsed: true };
    const groupFailureSession = makeSession([
      { url: 'https://metadata.test/group', groupId: 10 },
    ], [group]);
    installChromeMock({
      local: { sessions: [groupFailureSession] },
      failures: { 'tabs.group': new Error('synthetic group failure') },
    });

    const groupFailure = await restoreSession(groupFailureSession.id, {
      mode: 'here',
      discarded: false,
    });

    expect(groupFailure.errors).toEqual([{
      scope: 'group',
      url: 'https://metadata.test/group',
      message: 'synthetic group failure',
    }]);
    expect(groupFailure.complete).toBe(false);

    const updateFailureSession = makeSession([
      { url: 'https://metadata.test/update', groupId: 10 },
    ], [group]);
    installChromeMock({
      local: { sessions: [updateFailureSession] },
      failures: { 'tabGroups.update': new Error('synthetic metadata failure') },
    });

    const updateFailure = await restoreSession(updateFailureSession.id, {
      mode: 'here',
      discarded: false,
    });

    expect(updateFailure.groupsRestored).toBe(1);
    expect(updateFailure.errors).toEqual([{
      scope: 'update',
      url: 'https://metadata.test/update',
      message: 'synthetic metadata failure',
    }]);
    expect(updateFailure.complete).toBe(false);
  });

  test('reports a mute update failure while preserving an unmuted created tab', async () => {
    const session = makeSession([{ url: 'https://audio.test/mute-failure' }]);
    const harness = installChromeMock({
      local: { sessions: [session] },
      failures: { 'tabs.update': new Error('synthetic mute failure') },
    });

    const result = await restoreSession(session.id, { mode: 'here' });
    const restoredTab = harness.snapshot().tabs.find((tab) => tab.url === 'https://audio.test/mute-failure');

    expect(restoredTab).toEqual(expect.objectContaining({ discarded: true }));
    expect(restoredTab.mutedInfo.muted).toBe(false);
    expect(result.errors).toEqual([{
      scope: 'update',
      url: 'https://audio.test/mute-failure',
      message: 'synthetic mute failure',
    }]);
    expect(result.complete).toBe(false);
  });

  test('single-window mode preserves groups with colliding saved IDs across source windows', async () => {
    const session = {
      id: 'single-window-associations',
      name: 'Single window associations',
      version: 2,
      createdAt: 1,
      modifiedAt: 1,
      windows: [
        {
          tabCount: 2,
          tabs: [
            { url: 'https://single-window.test/first', groupId: 10 },
            { url: 'https://single-window.test/second', groupId: 10 },
          ],
          groups: [{ id: 10, title: 'First source', color: 'blue' }],
        },
        {
          tabCount: 1,
          tabs: [{ url: 'https://single-window.test/third', groupId: 10 }],
          groups: [{ id: 10, title: 'Second source', color: 'red' }],
        },
      ],
    };
    const harness = installChromeMock({ local: { sessions: [session] } });

    const result = await restoreSession(session.id, {
      mode: 'single-window',
      discarded: false,
    });
    const restored = harness.snapshot().tabs.filter((tab) => tab.url.startsWith('https://single-window.test/'));
    const first = restored.find((tab) => tab.url.endsWith('/first'));
    const second = restored.find((tab) => tab.url.endsWith('/second'));
    const third = restored.find((tab) => tab.url.endsWith('/third'));
    const groups = harness.snapshot().groups;

    expect(result).toEqual({
      requestedCount: 3,
      restoredCount: 3,
      skippedDuplicate: 0,
      skippedInvalid: 0,
      errors: [],
      complete: true,
      windowsCreated: 1,
      groupsRestored: 2,
    });
    expect(new Set(restored.map((tab) => tab.windowId)).size).toBe(1);
    expect(first).toEqual(expect.objectContaining({ active: true }));
    expect(first.groupId).toBe(second.groupId);
    expect(third.groupId).not.toBe(first.groupId);
    expect(groups.map((group) => [group.title, group.color])).toEqual([
      ['First source', 'blue'],
      ['Second source', 'red'],
    ]);
  });

  test('an all-duplicate session finalizes as complete without creating tabs', async () => {
    const session = makeSession([{ url: 'https://duplicate.test/' }]);
    const harness = installChromeMock({
      local: { sessions: [session] },
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 10, windowId: 1, active: true, url: 'https://duplicate.test/' }],
    });

    const result = await restoreSession(session.id, { mode: 'here', discarded: false });

    expect(result).toEqual({
      requestedCount: 1,
      restoredCount: 0,
      skippedDuplicate: 1,
      skippedInvalid: 0,
      errors: [],
      complete: true,
      windowsCreated: 0,
      groupsRestored: 0,
    });
    expect(harness.calls.tabs.create).toEqual([]);
  });
});
