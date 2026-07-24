import { describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { sendOrThrow } from '../../sidepanel/message-client.js';

let importNonce = 0;

async function lockModule() {
  return import('../../core/state-mutation-lock.js');
}

async function freshWorker(label) {
  return import(`../../service-worker.js?task7=${label}-${++importNonce}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function session(id, timestamp = 1) {
  return {
    id,
    name: id,
    version: 2,
    createdAt: timestamp,
    modifiedAt: timestamp,
    windows: [{ tabCount: 0, tabs: [] }],
  };
}

describe('worker-local FIFO state mutation lock', () => {
  test('starts and settles operations in strict FIFO order and propagates values', async () => {
    const { withStateMutationLock } = await lockModule();
    const firstGate = deferred();
    const order = [];

    const first = withStateMutationLock(async () => {
      order.push('first:start');
      await firstGate.promise;
      order.push('first:settle');
      return 'first-value';
    });
    const second = withStateMutationLock(async () => {
      order.push('second:start');
      order.push('second:settle');
      return 'second-value';
    });

    await flushMicrotasks();
    expect(order).toEqual(['first:start']);
    firstGate.resolve();
    await expect(first).resolves.toBe('first-value');
    await expect(second).resolves.toBe('second-value');
    expect(order).toEqual(['first:start', 'first:settle', 'second:start', 'second:settle']);
  });

  test('propagates caller rejection while releasing the queue afterward', async () => {
    const { withStateMutationLock } = await lockModule();
    const gate = deferred();
    const order = [];
    const failure = new Error('first failed');

    const first = withStateMutationLock(async () => {
      order.push('first:start');
      await gate.promise;
      throw failure;
    });
    const second = withStateMutationLock(async () => {
      order.push('second:start');
      return 2;
    });

    await flushMicrotasks();
    expect(order).toEqual(['first:start']);
    gate.resolve();
    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first:start', 'second:start']);
  });

  test('prevents a later mutation from being overwritten by a deferred sync', async () => {
    const { withStateMutationLock } = await lockModule();
    const uploadGate = deferred();
    let state = ['before-sync'];
    const order = [];

    const sync = withStateMutationLock(async () => {
      order.push('sync:start');
      const merged = ['from-sync'];
      await uploadGate.promise;
      state = merged;
      order.push('sync:settle');
    });
    const mutation = withStateMutationLock(async () => {
      order.push('mutation:start');
      state = [...state, 'after-sync'];
      order.push('mutation:settle');
    });

    await flushMicrotasks();
    expect(state).toEqual(['before-sync']);
    expect(order).toEqual(['sync:start']);
    uploadGate.resolve();
    await Promise.all([sync, mutation]);
    expect(order).toEqual(['sync:start', 'sync:settle', 'mutation:start', 'mutation:settle']);
    expect(state).toEqual(['from-sync', 'after-sync']);
  });
});

describe('service-worker portable-state ownership', () => {
  test('manual and alarm sync delegate to the same coordinator function', async () => {
    installChromeMock();
    const worker = await freshWorker('shared-sync');
    const calls = [];
    const coordinator = async () => {
      calls.push('sync');
      return { sessions: 0, stashes: 0, bookmarks: 0 };
    };

    await expect(worker.handleMessage({ action: 'syncDriveState' }, {
      syncDrive: coordinator,
    })).resolves.toEqual({ sessions: 0, stashes: 0, bookmarks: 0 });
    await worker.autoSyncDrive(coordinator);
    expect(calls).toEqual(['sync', 'sync']);
  });

  test('the sync coordinator orders remote, local, exports, settings, and last-sync state under one lock', async () => {
    const order = [];
    installChromeMock({
      local: {
        sessions: [session('local')],
        manualGroups: {},
        driveSyncTombstones: { sessions: {}, manualGroups: {} },
        driveSync: { connected: true, driveFileId: 'old-file' },
      },
    });
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (values) => {
      if (Object.hasOwn(values, 'sessions')) order.push('local');
      if (Object.hasOwn(values, 'driveSync')) order.push('last-sync');
      return originalSet(values);
    };
    const worker = await freshWorker('sync-order');

    const result = await worker.syncDriveState({
      getDriveState: async () => ({ connected: true, driveFileId: 'old-file' }),
      findRemote: async () => {
        order.push('find-remote');
        return { id: 'remote-file' };
      },
      readRemote: async () => {
        order.push('read-remote');
        return { version: 1, sessions: [session('remote')], manualGroups: {} };
      },
      writeRemote: async () => {
        order.push('remote');
        return 'remote-file';
      },
      exportSubfolders: async () => {
        order.push('exports');
        return { sessions: 2, stashes: 0, bookmarks: 0 };
      },
      loadSettings: async () => {
        order.push('load-settings');
        const { SETTINGS_DEFAULTS } = await import('../../core/settings.js');
        return SETTINGS_DEFAULTS;
      },
      writeSettings: async (document) => {
        order.push('settings');
        expect(document.version).toBe(1);
      },
      setDriveState: async (state) => {
        order.push('last-sync');
        await originalSet({ driveSync: state });
      },
      now: () => 1234,
    });

    expect(order).toEqual([
      'find-remote', 'read-remote', 'remote', 'local', 'exports',
      'load-settings', 'settings', 'last-sync',
    ]);
    expect(result).toEqual({
      version: 2,
      sessions: 2,
      manualGroups: 0,
      stashes: 0,
      bookmarks: 0,
      lastSyncedAt: 1234,
    });
  });

  test('lastSyncedAt is unchanged when exports or settings fail', async () => {
    for (const failurePoint of ['exports', 'settings']) {
      const harness = installChromeMock({
        local: {
          driveSync: { connected: true, lastSyncedAt: 10 },
          sessions: [],
          manualGroups: {},
          driveSyncTombstones: { sessions: {}, manualGroups: {} },
        },
      });
      const worker = await freshWorker(`sync-failure-${failurePoint}`);
      const expectedFailure = failurePoint === 'exports' ? 'export failed' : 'settings failed';
      await expect(worker.syncDriveState({
        getDriveState: async () => ({ connected: true, lastSyncedAt: 10 }),
        findRemote: async () => null,
        writeRemote: async () => 'new-file',
        exportSubfolders: async () => {
          if (failurePoint === 'exports') throw new Error('export failed');
          return { sessions: 0, stashes: 0, bookmarks: 0 };
        },
        loadSettings: async () => (await import('../../core/settings.js')).SETTINGS_DEFAULTS,
        writeSettings: async () => {
          if (failurePoint === 'settings') throw new Error('settings failed');
        },
        now: () => 20,
      })).rejects.toThrow(expectedFailure);
      expect(harness.snapshot().local.driveSync.lastSyncedAt).toBe(10);
    }
  });

  test('session and manual-group mutations queue behind a deferred canonical upload', async () => {
    const uploadGate = deferred();
    const uploadEntered = deferred();
    const exportGate = deferred();
    const exportEntered = deferred();
    const settingsGate = deferred();
    const settingsEntered = deferred();
    const stateGate = deferred();
    const stateEntered = deferred();
    const order = [];
    installChromeMock({
      local: {
        driveSync: { connected: true },
        sessions: [],
        manualGroups: {},
        driveSyncTombstones: { sessions: {}, manualGroups: {} },
      },
    });
    const worker = await freshWorker('queued-mutations');
    const syncPromise = worker.syncDriveState({
      getDriveState: async () => ({ connected: true }),
      findRemote: async () => null,
      writeRemote: async () => {
        order.push('sync:upload');
        uploadEntered.resolve();
        await uploadGate.promise;
      },
      exportSubfolders: async () => {
        order.push('sync:exports');
        exportEntered.resolve();
        await exportGate.promise;
        return { sessions: 0, stashes: 0, bookmarks: 0 };
      },
      loadSettings: async () => (await import('../../core/settings.js')).SETTINGS_DEFAULTS,
      writeSettings: async () => {
        order.push('sync:settings');
        settingsEntered.resolve();
        await settingsGate.promise;
      },
      setDriveState: async () => {
        order.push('sync:last-sync');
        stateEntered.resolve();
        await stateGate.promise;
      },
      now: () => 1,
    });
    await uploadEntered.promise;

    const sessionMutation = worker.handleMessage({ action: 'saveSession', name: 'queued' }, {
      saveSession: async () => { order.push('session'); return session('queued', 2); },
    });
    const groupMutation = worker.handleMessage({ action: 'createManualGroup', name: 'Queued', color: 'blue' }, {
      createManualGroup: async () => { order.push('group'); return { groupId: 'g', group: { name: 'Queued' } }; },
    });
    try {
      await flushMicrotasks();
      expect(order).toEqual(['sync:upload']);
      uploadGate.resolve();
      await exportEntered.promise;
      expect(order).toEqual(['sync:upload', 'sync:exports']);
      exportGate.resolve();
      await settingsEntered.promise;
      expect(order).toEqual(['sync:upload', 'sync:exports', 'sync:settings']);
      settingsGate.resolve();
      await stateEntered.promise;
      expect(order).toEqual(['sync:upload', 'sync:exports', 'sync:settings', 'sync:last-sync']);
      stateGate.resolve();
      await Promise.all([syncPromise, sessionMutation, groupMutation]);
      expect(order).toEqual([
        'sync:upload', 'sync:exports', 'sync:settings', 'sync:last-sync', 'session', 'group',
      ]);
    } finally {
      uploadGate.resolve();
      exportGate.resolve();
      settingsGate.resolve();
      stateGate.resolve();
      await Promise.allSettled([syncPromise, sessionMutation, groupMutation]);
    }
  });

  test('validates worker-owned group payloads and performs one move transform', async () => {
    const harness = installChromeMock({
      local: {
        manualGroups: {
          a: { name: 'A', color: 'blue', tabUrls: ['https://move.test/'], createdAt: 1, modifiedAt: 1 },
          b: { name: 'B', color: 'red', tabUrls: [], createdAt: 1, modifiedAt: 1 },
        },
      },
    });
    const worker = await freshWorker('group-actions');
    await expect(worker.handleMessage({
      action: 'moveTabToManualGroup',
      tabUrl: 'https://move.test/',
      targetGroupId: 'b',
    })).resolves.toMatchObject({ targetGroupId: 'b' });
    expect(harness.snapshot().local.manualGroups.a.tabUrls).toEqual([]);
    expect(harness.snapshot().local.manualGroups.b.tabUrls).toEqual(['https://move.test/']);
    expect(harness.calls.storage.local.set).toHaveLength(1);

    const before = JSON.stringify(harness.snapshot().local.manualGroups);
    await expect(worker.handleMessage({
      action: 'moveTabToManualGroup', tabUrl: '', targetGroupId: 'b',
    })).rejects.toThrow();
    await expect(worker.handleMessage({
      action: 'moveTabToManualGroup', tabUrl: 'https://move.test/', targetGroupId: 'missing',
    })).rejects.toThrow();
    expect(JSON.stringify(harness.snapshot().local.manualGroups)).toBe(before);
  });

  test('creates IDs inside the worker and rejects malformed create/delete payloads before writes', async () => {
    const harness = installChromeMock({ local: { manualGroups: {} } });
    const worker = await freshWorker('group-validation');
    const created = await worker.handleMessage({ action: 'createManualGroup', name: 'Work', color: 'cyan' });
    expect(created.groupId).toBeString();
    expect(created.groupId.length).toBeGreaterThan(0);
    expect(created.group).toMatchObject({ name: 'Work', color: 'cyan', tabUrls: [] });
    expect(harness.snapshot().local.manualGroups[created.groupId]).toEqual(created.group);

    const writes = harness.calls.storage.local.set.length;
    await expect(worker.handleMessage({ action: 'createManualGroup', name: '', color: 'blue' })).rejects.toThrow();
    await expect(worker.handleMessage({ action: 'createManualGroup', name: 'Bad', color: 'chartreuse' })).rejects.toThrow();
    await expect(worker.handleMessage({ action: 'deleteManualGroup', groupId: '' })).rejects.toThrow();
    expect(harness.calls.storage.local.set).toHaveLength(writes);
  });

  test('validates Undo sessions and replaces duplicate IDs in the single transaction', async () => {
    const harness = installChromeMock({ local: { sessions: [session('existing')] } });
    const worker = await freshWorker('undo-validation');
    await expect(worker.handleMessage({
      action: 'undoDeleteSession', session: session('restored', 2),
    })).resolves.toEqual({ restored: true, modifiedAt: expect.any(Number) });
    expect(harness.snapshot().local.sessions.map(({ id }) => id)).toEqual(['restored', 'existing']);
    const writes = harness.calls.storage.local.set.length;
    await expect(worker.handleMessage({
      action: 'undoDeleteSession', session: session('existing', 3),
    })).resolves.toEqual({ restored: true, modifiedAt: expect.any(Number) });
    expect(harness.snapshot().local.sessions.filter(({ id }) => id === 'existing')).toHaveLength(1);
    await expect(worker.handleMessage({ action: 'undoDeleteSession', session: { id: '' } })).rejects.toThrow();
    expect(harness.calls.storage.local.set).toHaveLength(writes + 1);
  });

  test('explicit delete and Undo wait behind an existing mutation and settle FIFO', async () => {
    const { withStateMutationLock } = await lockModule();
    const gate = deferred();
    const entered = deferred();
    const order = [];
    installChromeMock({ local: { sessions: [] } });
    const worker = await freshWorker('delete-undo-queue');
    const blocker = withStateMutationLock(async () => {
      order.push('blocker');
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    const deletion = worker.handleMessage({ action: 'deleteSession', sessionId: 'deleted' }, {
      deleteSession: async () => { order.push('delete'); },
    });
    const undo = worker.handleMessage({ action: 'undoDeleteSession', session: session('restored', 2) });
    await flushMicrotasks();
    expect(order).toEqual(['blocker']);
    gate.resolve();
    await Promise.all([blocker, deletion, undo]);
    expect(order).toEqual(['blocker', 'delete']);
    expect((await chrome.storage.local.get('sessions')).sessions.map(({ id }) => id)).toEqual(['restored']);
  });

  test('auto-save holds one lock through rolling retention', async () => {
    const saveGate = deferred();
    const saveEntered = deferred();
    const order = [];
    installChromeMock();
    const worker = await freshWorker('auto-save-lock');
    const autoSave = worker.autoSaveSession({
      getTabs: async () => [{ id: 1 }, { id: 2 }],
      loadSettings: async () => ({ autoSaveRetentionDays: 7 }),
      saveSnapshot: async () => {
        order.push('auto:save');
        saveEntered.resolve();
        await saveGate.promise;
      },
      getStorage: async () => [
        { id: 'recent', name: '[Auto] recent', createdAt: 20 },
        { id: 'keep', name: '[Auto] keep', createdAt: 19 },
        { id: 'old', name: '[Auto] old', createdAt: 1 },
      ],
      deleteSessions: async () => { order.push('auto:retention'); },
      now: () => 10 * 24 * 60 * 60 * 1000,
    });
    await saveEntered.promise;
    const deletion = worker.handleMessage({ action: 'deleteSession', sessionId: 'later' }, {
      deleteSession: async () => { order.push('delete'); },
    });
    await flushMicrotasks();
    expect(order).toEqual(['auto:save']);
    saveGate.resolve();
    await Promise.all([autoSave, deletion]);
    expect(order).toEqual(['auto:save', 'auto:retention', 'delete']);
  });

  test('retention cleanup holds one lock through local pruning and alarm dispatch uses it', async () => {
    const retentionGate = deferred();
    const retentionEntered = deferred();
    const order = [];
    installChromeMock();
    const worker = await freshWorker('retention-lock');
    const cleanup = worker.runRetentionCleanup({
      getSettings: async () => ({
        autoSaveRetentionDays: 1,
        driveRetentionDays: 0,
        neverDeleteFromDrive: false,
      }),
      getStorage: async (key) => key === 'sessions'
        ? [
            { id: 'new-a', name: '[Auto] A', createdAt: 20 },
            { id: 'new-b', name: '[Auto] B', createdAt: 19 },
            { id: 'old', name: '[Auto] Old', createdAt: 1 },
          ]
        : { connected: true },
      deleteSessions: async () => {
        order.push('retention:write');
        retentionEntered.resolve();
        await retentionGate.promise;
      },
      now: () => 3 * 24 * 60 * 60 * 1000,
    });
    await retentionEntered.promise;
    const group = worker.handleMessage({ action: 'deleteManualGroup', groupId: 'later' }, {
      deleteManualGroup: async () => { order.push('group'); },
    });
    await flushMicrotasks();
    expect(order).toEqual(['retention:write']);
    retentionGate.resolve();
    await Promise.all([cleanup, group]);
    expect(order).toEqual(['retention:write', 'group']);

    let alarmCalls = 0;
    await worker.handleAlarm({ name: 'retentionCleanup' }, {
      runRetention: async () => { alarmCalls += 1; },
    });
    expect(alarmCalls).toBe(1);
  });

  test('supports ungrouped removal, authoritative worker IDs, and real group deletion', async () => {
    const harness = installChromeMock({
      local: {
        manualGroups: {
          a: { name: 'A', color: 'blue', tabUrls: ['https://remove.test/'], createdAt: 1, modifiedAt: 1 },
        },
      },
    });
    const worker = await freshWorker('group-complete-paths');
    const created = await worker.handleMessage({
      action: 'createManualGroup',
      groupId: 'caller-controlled',
      name: 'Created',
      color: 'green',
    });
    expect(created.groupId).not.toBe('caller-controlled');
    expect(Object.hasOwn(harness.snapshot().local.manualGroups, 'caller-controlled')).toBeFalse();

    await worker.handleMessage({
      action: 'moveTabToManualGroup',
      tabUrl: 'https://remove.test/',
      targetGroupId: 'ungrouped',
    });
    expect(harness.snapshot().local.manualGroups.a.tabUrls).toEqual([]);

    await expect(worker.handleMessage({
      action: 'deleteManualGroup', groupId: created.groupId,
    })).resolves.toEqual({ deleted: true, tombstoneAt: expect.any(Number) });
    expect(Object.hasOwn(harness.snapshot().local.manualGroups, created.groupId)).toBeFalse();
  });

  test('rejects non-string, whitespace, dangerous, and oversized portable payloads before writes', async () => {
    const harness = installChromeMock({ local: { manualGroups: {}, sessions: [] } });
    const worker = await freshWorker('runtime-bounds');
    const long = 'x'.repeat(16_385);
    for (const message of [
      { action: 'createManualGroup', name: 1, color: 'blue' },
      { action: 'createManualGroup', name: ' padded ', color: 'blue' },
      { action: 'createManualGroup', name: long, color: 'blue' },
      { action: 'moveTabToManualGroup', tabUrl: ' ', targetGroupId: 'ungrouped' },
      { action: 'moveTabToManualGroup', tabUrl: 'not-a-url', targetGroupId: 'ungrouped' },
      { action: 'moveTabToManualGroup', tabUrl: 'https://ok.test/', targetGroupId: '__proto__' },
      { action: 'deleteManualGroup', groupId: 'constructor' },
      { action: 'saveSession', name: long },
      { action: 'deleteSession', sessionId: null },
    ]) {
      await expect(worker.handleMessage(message)).rejects.toThrow();
    }
    expect(harness.calls.storage.local.set).toEqual([]);
  });

  test('internal sync/export helpers contain no nested lock acquisition and legacy group writers are gone', async () => {
    const workerSource = await Bun.file(new URL('../../service-worker.js', import.meta.url)).text();
    const unlockedSync = workerSource.slice(
      workerSource.indexOf('async function syncDriveStateUnlocked'),
      workerSource.indexOf('export async function syncDriveState'),
    );
    const exportHelper = workerSource.slice(
      workerSource.indexOf('async function exportDriveSubfolders'),
      workerSource.indexOf('async function setCompletedDriveState'),
    );
    expect(unlockedSync).not.toContain('withStateMutationLock');
    expect(unlockedSync).not.toContain('chrome.runtime.sendMessage');
    expect(exportHelper).not.toContain('withStateMutationLock');
    expect(exportHelper).not.toContain('chrome.runtime.sendMessage');

    const groupingSource = await Bun.file(new URL('../../core/grouping.js', import.meta.url)).text();
    for (const legacy of [
      'saveManualGroup', 'addTabToManualGroup', 'removeTabFromManualGroup', 'removeTabFromAllGroups',
    ]) {
      expect(groupingSource).not.toContain(`function ${legacy}`);
    }
  });

  test('Drive settings import atomically snapshots canonical current settings and saves a canonical replacement', async () => {
    const harness = installChromeMock({
      local: { tabkebabSettings: { theme: 'light', injected: 'discard' } },
    });
    const worker = await freshWorker('settings-import');
    const saved = await worker.handleMessage({
      action: 'importDriveSettings',
      settings: { theme: 'dark', defaultView: 'sessions' },
    });
    const write = harness.calls.storage.local.set[0][0];
    expect(Object.keys(write).sort()).toEqual(['tabkebabSettings', 'tabkebabSettingsPrevious']);
    expect(write.tabkebabSettings).toEqual(saved);
    expect(write.tabkebabSettings).toMatchObject({ theme: 'dark', defaultView: 'sessions' });
    expect(write.tabkebabSettingsPrevious).toMatchObject({ theme: 'light' });
    expect(Object.hasOwn(write.tabkebabSettingsPrevious, 'injected')).toBeFalse();
  });

  test('rejected or failed settings import cannot create an undo snapshot', async () => {
    for (const mode of ['invalid', 'storage']) {
      const initial = { tabkebabSettings: { theme: 'light' } };
      const harness = installChromeMock({
        local: initial,
        failures: mode === 'storage' ? { 'storage.local.set': new Error('write failed') } : {},
      });
      const worker = await freshWorker(`settings-import-${mode}`);
      await expect(worker.handleMessage({
        action: 'importDriveSettings',
        settings: mode === 'invalid' ? { theme: 'purple' } : { theme: 'dark' },
      })).rejects.toThrow();
      expect(harness.snapshot().local).toEqual(initial);
      expect(Object.hasOwn(harness.snapshot().local, 'tabkebabSettingsPrevious')).toBeFalse();
    }
  });

  test('failed settings Undo keeps the validated snapshot and successful Undo consumes it afterward', async () => {
    const previous = { theme: 'light' };
    const harness = installChromeMock({
      local: {
        tabkebabSettings: { theme: 'dark' },
        tabkebabSettingsPrevious: previous,
      },
      failures: { 'storage.local.set': new Error('restore failed') },
    });
    const worker = await freshWorker('settings-undo');
    await expect(worker.handleMessage({ action: 'undoDriveSettings' })).rejects.toThrow('restore failed');
    expect(harness.snapshot().local.tabkebabSettingsPrevious).toEqual(previous);
    expect(harness.snapshot().local.tabkebabSettings.theme).toBe('dark');

    await expect(worker.handleMessage({ action: 'undoDriveSettings' })).resolves.toMatchObject({ theme: 'light' });
    expect(harness.snapshot().local.tabkebabSettings.theme).toBe('light');
    expect(Object.hasOwn(harness.snapshot().local, 'tabkebabSettingsPrevious')).toBeFalse();
  });
});

describe('panel mutation and checked-message boundaries', () => {
  test('group editor has no direct manual-group writes and uses checked worker messages', async () => {
    const source = await Bun.file(new URL('../../sidepanel/components/group-editor.js', import.meta.url)).text();
    expect(source).not.toMatch(/chrome\.storage\.local\.set\(\{\s*manualGroups/);
    expect(source).toContain("action: 'getManualGroups'");
    expect(source).toContain("action: 'createManualGroup'");
    expect(source).toContain("action: 'moveTabToManualGroup'");
    expect(source).toContain("action: 'deleteManualGroup'");
    expect(source).toContain("import { sendOrThrow }");
  });

  test('Drive Sync panel delegates canonical sync only through sendOrThrow', async () => {
    const source = await Bun.file(new URL('../../sidepanel/components/drive-sync.js', import.meta.url)).text();
    expect(source).toContain("this.send({ action: 'syncDriveState' })");
    expect(source).not.toContain('sendMessage');
    expect(source).not.toMatch(/findSyncFile|readSyncFile|writeSyncFile/);
    expect(source).not.toMatch(/Storage\.set\('sessions'|Storage\.set\('manualGroups'/);
    const syncNowSource = source.slice(source.indexOf('async syncNow()'), source.indexOf('async disconnectDrive()'));
    expect(syncNowSource).not.toMatch(/Storage\.set\('driveSync'/);
    expect(source).not.toContain("action: 'syncAllToDrive'");
    expect(source).toContain("action: 'importDriveSettings'");
    expect(source).toContain("action: 'undoDriveSettings'");
  });

  test('an error-shaped sync response cannot render success or advance UI state', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: () => null };
    try {
      const { DriveSync } = await import(`../../sidepanel/components/drive-sync.js?task7-ui=${++importNonce}`);
      for (const configure of [
        () => installChromeMock({ runtimeHandler: async () => ({ error: 'worker sync failed' }) }),
        () => installChromeMock({ failures: { 'runtime.sendMessage': new Error('transport failed') } }),
      ]) {
        const harness = configure();
        const notices = [];
        const manager = Object.create(DriveSync.prototype);
        manager.syncBtn = { disabled: false, textContent: 'Sync Now' };
        manager.notify = (message, type) => notices.push({ message, type });
        manager.refresh = async () => { notices.push({ refresh: true }); };

        await manager.syncNow();
        expect(notices.filter(({ type }) => type === 'success')).toEqual([]);
        expect(notices.some(({ type, message }) => type === 'error' && message.startsWith('Sync failed:'))).toBeTrue();
        expect(manager.syncBtn).toEqual({ disabled: false, textContent: 'Sync Now' });
        expect(harness.calls.storage.local.set).toEqual([]);
      }
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    }
  });

  test('Drive Sync reports post-commit refresh failure without escaping or reclassifying worker outcome', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: () => null };
    try {
      const { DriveSync } = await import(`../../sidepanel/components/drive-sync.js?task7-sync-refresh=${++importNonce}`);
      for (const [workerSucceeds, expectedResult] of [[true, true], [false, false]]) {
        installChromeMock({
          runtimeHandler: async () => {
            if (!workerSucceeds) return { error: 'worker sync failed' };
            return { sessions: 1, stashes: 0, bookmarks: 0 };
          },
        });
        const notices = [];
        const manager = Object.create(DriveSync.prototype);
        manager.syncBtn = { disabled: false, textContent: 'Sync Now' };
        manager.notify = (message, type) => notices.push({ message, type });
        manager.refresh = async () => { throw new Error('projection failed'); };

        await expect(manager.syncNow()).resolves.toBe(expectedResult);
        expect(manager.syncBtn).toEqual({ disabled: false, textContent: 'Sync Now' });
        expect(notices.filter(({ type }) => type === 'success')).toEqual([]);
        if (workerSucceeds) {
          expect(notices).toHaveLength(1);
          expect(notices[0].message).toContain('Synced with Google Drive (1 sessions), but the view could not refresh');
        } else {
          expect(notices.some(({ message }) => message.startsWith('Sync failed:'))).toBeTrue();
          expect(notices.every(({ type }) => type === 'error')).toBeTrue();
        }
      }
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    }
  });

  test('settings apply uses the checked worker boundary and a returned error leaves storage untouched', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: () => null };
    try {
      const { DriveSync } = await import(`../../sidepanel/components/drive-sync.js?task7-settings-ui=${++importNonce}`);
      const harness = installChromeMock({
        local: { tabkebabSettings: { theme: 'light' } },
        runtimeHandler: async () => ({ error: 'settings rejected' }),
      });
      const manager = Object.create(DriveSync.prototype);
      await expect(manager.applyRemoteSettings({ theme: 'dark' })).rejects.toThrow('settings rejected');
      expect(harness.calls.storage.local.set).toEqual([]);
      expect(harness.snapshot().local).toEqual({ tabkebabSettings: { theme: 'light' } });
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    }
  });

  test('Drive settings Undo distinguishes a committed restore from a failed post-commit refresh', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: () => null };
    try {
      const { DriveSync } = await import(`../../sidepanel/components/drive-sync.js?task7-undo-refresh=${++importNonce}`);
      installChromeMock({
        local: { tabkebabSettingsPrevious: { theme: 'light' } },
        runtimeHandler: async () => ({ theme: 'light' }),
      });
      const notices = [];
      const manager = Object.create(DriveSync.prototype);
      manager.confirm = async () => true;
      manager.notify = (message, type) => notices.push({ message, type });
      manager.refresh = async () => { throw new Error('projection failed'); };

      await expect(manager.undoSettingsLoad()).resolves.toBeTrue();
      expect(notices).toHaveLength(1);
      expect(notices[0].message).toContain('restored, but the view could not refresh');
      expect(notices[0].message).not.toContain('Settings restore failed');
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    }
  });

  test('manual-group UI reports rejected mutations without clearing, refreshing, or rendering success', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: () => null };
    try {
      const { GroupEditor } = await import(`../../sidepanel/components/group-editor.js?task7-errors=${++importNonce}`);
      const notices = [];
      const nameInput = { value: 'Work', focus() {} };
      const colorSelect = { value: 'blue' };
      const manager = Object.create(GroupEditor.prototype);
      manager.root = {
        querySelector(selector) {
          return selector === '#new-group-name' ? nameInput : colorSelect;
        },
      };
      installChromeMock({ runtimeHandler: async () => ({ error: 'worker rejected mutation' }) });
      manager.notify = (message, type) => notices.push({ message, type });
      let refreshes = 0;
      manager.refresh = async () => { refreshes += 1; };

      await expect(manager.createGroup()).resolves.toBeFalse();
      await expect(manager.deleteGroup('group-id', 'Work')).resolves.toBeFalse();
      await expect(manager.addTabToGroup(
        'https://example.test/',
        'group-id',
        'Tab added to group',
      )).resolves.toBeFalse();

      expect(nameInput.value).toBe('Work');
      expect(refreshes).toBe(0);
      expect(notices.filter(({ type }) => type === 'success')).toEqual([]);
      expect(notices.filter(({ type }) => type === 'error')).toHaveLength(3);
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    }
  });

  test('manual-group UI distinguishes a committed mutation from a failed post-commit refresh', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: () => null };
    try {
      const { GroupEditor } = await import(`../../sidepanel/components/group-editor.js?task7-refresh=${++importNonce}`);
      const notices = [];
      const nameInput = { value: 'Work', focus() {} };
      const colorSelect = { value: 'blue' };
      const manager = Object.create(GroupEditor.prototype);
      manager.root = {
        querySelector(selector) {
          return selector === '#new-group-name' ? nameInput : colorSelect;
        },
      };
      installChromeMock({
        runtimeHandler: async ({ action }) => action === 'deleteManualGroup'
          ? { deleted: true, tombstoneAt: 1 }
          : { success: true },
      });
      manager.notify = (message, type) => notices.push({ message, type });
      manager.refresh = async () => { throw new Error('projection failed'); };

      await expect(manager.createGroup()).resolves.toBeTrue();
      await expect(manager.deleteGroup('group-id', 'Work')).resolves.toBeTrue();
      await expect(manager.addTabToGroup(
        'https://example.test/',
        'group-id',
        'Tab added to group',
      )).resolves.toBeTrue();
      await expect(manager.moveDroppedTab('https://example.test/', 'group-id')).resolves.toBeTrue();

      expect(nameInput.value).toBe('');
      expect(notices).toHaveLength(4);
      expect(notices.every(({ message }) => message.includes('but the view could not refresh'))).toBeTrue();
      expect(notices.some(({ message }) => /^Failed to (create|delete|add|move)/.test(message))).toBeFalse();
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    }
  });

  test('Chrome-group mutations retain committed outcomes when projection refresh fails', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: () => null };
    try {
      const { GroupEditor } = await import(`../../sidepanel/components/group-editor.js?task11-committed=${++importNonce}`);
      const methods = [
        'discardChromeGroup',
        'stashChromeGroup',
        'ungroupChromeGroup',
        'closeChromeGroup',
        'setAllChromeGroupsCollapsed',
      ];
      for (const method of methods) expect(GroupEditor.prototype[method]).toBeFunction();
      if (methods.some((method) => typeof GroupEditor.prototype[method] !== 'function')) return;

      installChromeMock({
        runtimeHandler: async ({ action }) => {
          if (action === 'discardTabs') return { discarded: 2, skipped: 1 };
          if (action === 'stashGroup') return { stash: { tabCount: 3 } };
          return { success: true };
        },
      });
      const notices = [];
      const manager = Object.create(GroupEditor.prototype);
      manager.notify = (message, type) => notices.push({ message, type });
      manager.refresh = async () => { throw new Error('projection failed'); };
      const group = {
        id: 4,
        title: 'Current Group',
        collapsed: false,
        tabs: [{ id: 10 }, { id: 11 }],
      };

      await expect(manager.discardChromeGroup(group)).resolves.toBeTrue();
      await expect(manager.stashChromeGroup(group)).resolves.toBeTrue();
      await expect(manager.ungroupChromeGroup(group)).resolves.toBeTrue();
      await expect(manager.closeChromeGroup(group)).resolves.toBeTrue();
      await expect(manager.setAllChromeGroupsCollapsed([group], true)).resolves.toBeTrue();

      expect(notices).toHaveLength(5);
      expect(notices.every(({ type }) => type === 'error')).toBeTrue();
      expect(notices.every(({ message }) => message.includes('but the view could not refresh: projection failed'))).toBeTrue();
      expect(notices.every(({ message }) => !/^(Kebab failed:|Stash failed:|Failed to ungroup|Failed to close|Failed to collapse)/.test(message))).toBeTrue();
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    }
  });
});
