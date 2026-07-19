import { describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import * as DriveSync from '../../core/drive-sync.js';
import * as Sessions from '../../core/sessions.js';
import * as Grouping from '../../core/grouping.js';
import { Storage } from '../../core/storage.js';

const {
  MAX_DRIVE_ENTITIES_PER_KIND,
  MAX_DRIVE_JSON_BYTES,
  MAX_DRIVE_STRING_LENGTH,
  MAX_DRIVE_TIMESTAMP,
  MAX_DRIVE_TOMBSTONE,
  MAX_DRIVE_TOMBSTONES_PER_KIND,
  mergeDriveSyncDocuments,
} = DriveSync;

let workerNonce = 0;

async function freshWorker(label) {
  return import(`../../service-worker.js?task8=${label}-${++workerNonce}`);
}

function session(id, timestamp = 1, overrides = {}) {
  return {
    id,
    name: id,
    version: 2,
    createdAt: timestamp,
    modifiedAt: timestamp,
    windows: [{ tabCount: 0, tabs: [] }],
    ...overrides,
  };
}

function group(name, timestamp = 1, overrides = {}) {
  return {
    name,
    color: 'blue',
    tabUrls: [],
    createdAt: timestamp,
    modifiedAt: timestamp,
    ...overrides,
  };
}

function tombstones(overrides = {}) {
  return {
    sessions: {},
    manualGroups: {},
    ...overrides,
  };
}

function document(overrides = {}) {
  return {
    version: 2,
    sessions: [],
    manualGroups: {},
    tombstones: tombstones(),
    ...overrides,
  };
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

function json(value) {
  return JSON.stringify(value);
}

function maxLengthId(index) {
  const prefix = `${String(index).padStart(5, '0')}-`;
  return prefix + 'x'.repeat(MAX_DRIVE_STRING_LENGTH - prefix.length);
}

function installPanelDocument() {
  const originalDocument = globalThis.document;
  const createElement = () => ({
    style: {},
    appendChild() {},
    addEventListener() {},
    remove() {},
  });
  const toastContainer = createElement();
  globalThis.document = {
    createElement,
    getElementById: (id) => id === 'toast-container' ? toastContainer : null,
  };
  return () => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  };
}

describe('pure deletion tombstone timestamp policy', () => {
  test('computes the exact maximum of deletion, entity, and prior timestamps', () => {
    expect(DriveSync.computeDeletionTombstone(session('s', 20), 30, 10)).toBe(30);
    expect(DriveSync.computeDeletionTombstone(session('s', 40), 30, 10)).toBe(40);
    expect(DriveSync.computeDeletionTombstone(session('s', 20), 30, 50)).toBe(50);
    expect(DriveSync.computeDeletionTombstone(session('s', MAX_DRIVE_TOMBSTONE), 0, 0))
      .toBe(MAX_DRIVE_TOMBSTONE);
  });

  test('rejects malformed clocks and an entity whose timestamp cannot be dominated', () => {
    expect(typeof DriveSync.computeDeletionTombstone).toBe('function');
    for (const invalid of [NaN, Infinity, -Infinity, -1, 1.5, '2', MAX_DRIVE_TOMBSTONE + 1]) {
      expect(() => DriveSync.computeDeletionTombstone(session('s', 1), 0, invalid)).toThrow();
    }
    expect(DriveSync.computeDeletionTombstone(session('fallback', 2), 'bad', 3)).toBe(3);
    expect(() => DriveSync.computeDeletionTombstone(
      session('future', MAX_DRIVE_TIMESTAMP),
      0,
      MAX_DRIVE_TOMBSTONE,
    )).toThrow(/represent|timestamp|tombstone/i);
  });

  test('records a fresh lexical transaction map without mutating inputs', () => {
    const current = tombstones({
      sessions: { zed: 7, alpha: 3 },
      manualGroups: { retained: 2 },
    });
    const entries = [
      { id: 'beta', entity: session('beta', 12) },
      { id: 'alpha', entity: session('alpha', 4) },
    ];
    const before = json({ current, entries });

    const result = DriveSync.recordDeletionTombstones(current, 'sessions', entries, 10);

    expect(json({ current, entries })).toBe(before);
    expect(result.nextTombstones).not.toBe(current);
    expect(result.nextTombstones.sessions).not.toBe(current.sessions);
    expect(result.nextTombstones.manualGroups).not.toBe(current.manualGroups);
    expect(Object.getPrototypeOf(result.nextTombstones.sessions)).toBeNull();
    expect(Object.getPrototypeOf(result.nextTombstones.manualGroups)).toBeNull();
    expect(Object.getPrototypeOf(result.recordedTombstones)).toBeNull();
    expect(Object.keys(result.nextTombstones.sessions)).toEqual(['alpha', 'beta', 'zed']);
    expect(result.recordedTombstones).toEqual({ alpha: 10, beta: 12 });
    expect(result.nextTombstones.manualGroups).toEqual({ retained: 2 });
  });

  test('preflights kind, IDs, duplicates, and capacity before returning', () => {
    const validEntry = { id: 'ok', entity: session('ok') };
    expect(() => DriveSync.recordDeletionTombstones(tombstones(), 'stashes', [validEntry], 1))
      .toThrow(/kind|sessions|manualGroups/i);
    for (const id of ['', '__proto__', 'constructor', 'prototype', 7]) {
      expect(() => DriveSync.recordDeletionTombstones(
        tombstones(),
        'sessions',
        [{ id, entity: session('ok') }],
        1,
      )).toThrow();
    }
    expect(() => DriveSync.recordDeletionTombstones(
      tombstones(),
      'sessions',
      [validEntry, validEntry],
      1,
    )).toThrow(/duplicate/i);

    Object.defineProperty(Object.prototype, 'id', {
      value: 'inherited-id',
      configurable: true,
    });
    try {
      expect(() => DriveSync.recordDeletionTombstones(
        tombstones(),
        'sessions',
        [{ entity: session('payload-id') }],
        1,
      )).toThrow(/own|ID/i);
    } finally {
      delete Object.prototype.id;
    }

    const full = {};
    for (let index = 0; index < MAX_DRIVE_TOMBSTONES_PER_KIND; index += 1) {
      full[`id-${index}`] = 1;
    }
    expect(() => DriveSync.recordDeletionTombstones(
      tombstones({ sessions: full }),
      'sessions',
      [{ id: 'new-id', entity: session('new-id') }],
      2,
    )).toThrow(/10,000|limit|capacity/i);
    expect(DriveSync.recordDeletionTombstones(
      tombstones({ sessions: full }),
      'sessions',
      [{ id: 'id-0', entity: session('id-0') }],
      2,
    ).recordedTombstones['id-0']).toBe(2);
  });

  test('rejects a tombstone state whose canonical v2 JSON exceeds the byte ceiling', () => {
    const entryCount = Math.ceil(MAX_DRIVE_JSON_BYTES / (MAX_DRIVE_STRING_LENGTH + 4));
    const oversized = Object.create(null);
    for (let index = 0; index < entryCount; index += 1) {
      oversized[maxLengthId(index)] = 1;
    }

    let error;
    try {
      DriveSync.recordDeletionTombstones(
        tombstones({ sessions: oversized }),
        'sessions',
        [],
        1,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toContain('exceeds the 25 MiB byte limit');
  });

  test('does not promote inherited tombstone-kind maps into canonical state', () => {
    Object.defineProperties(Object.prototype, {
      sessions: { value: { inheritedSession: 7 }, configurable: true },
      manualGroups: { value: { inheritedGroup: 8 }, configurable: true },
    });
    try {
      const result = DriveSync.recordDeletionTombstones({}, 'sessions', [], 1);
      expect(result.nextTombstones.sessions).toEqual({});
      expect(result.nextTombstones.manualGroups).toEqual({});
    } finally {
      delete Object.prototype.sessions;
      delete Object.prototype.manualGroups;
    }
  });

  test('does not promote inherited portable-state sections into a local snapshot', () => {
    Object.defineProperties(Object.prototype, {
      sessions: { value: [session('inherited-session')], configurable: true },
      manualGroups: { value: { inheritedGroup: group('Inherited') }, configurable: true },
      tombstones: { value: tombstones({ sessions: { inheritedSession: 7 } }), configurable: true },
    });
    try {
      const result = DriveSync.canonicalizeLocalDriveSyncDocument({});
      expect(result.sessions).toEqual([]);
      expect(result.manualGroups).toEqual({});
      expect(result.tombstones).toEqual(tombstones());
    } finally {
      delete Object.prototype.sessions;
      delete Object.prototype.manualGroups;
      delete Object.prototype.tombstones;
    }
  });
});

describe('transactional session deletion', () => {
  test('deletes a stable-deduplicated batch with one snapshot and one two-key write', async () => {
    const inputIds = ['beta', 'alpha', 'beta', 'missing'];
    const harness = installChromeMock({
      local: {
        sessions: [session('alpha', 4), session('beta', 12), session('kept', 30)],
        driveSyncTombstones: tombstones({
          sessions: { alpha: 9, old: 8 },
          manualGroups: { retained: 7 },
        }),
      },
    });

    const result = await Sessions.deleteSessions(inputIds, 10);

    expect(inputIds).toEqual(['beta', 'alpha', 'beta', 'missing']);
    expect(result.deletedIds).toEqual(['beta', 'alpha']);
    expect(Object.keys(result.tombstones)).toEqual(['alpha', 'beta']);
    expect(result.tombstones).toEqual({ alpha: 10, beta: 12 });
    expect(harness.calls.storage.local.get)
      .toEqual([[['sessions', 'manualGroups', 'driveSyncTombstones']]]);
    expect(harness.calls.storage.local.set).toHaveLength(1);
    const write = harness.calls.storage.local.set[0][0];
    expect(Object.keys(write).sort()).toEqual(['driveSyncTombstones', 'sessions']);
    expect(write.sessions.map(({ id }) => id)).toEqual(['kept']);
    expect(write.driveSyncTombstones.sessions).toEqual({ alpha: 10, beta: 12, old: 8 });
    expect(write.driveSyncTombstones.manualGroups).toEqual({ retained: 7 });
    expect(harness.snapshot().local.sessions.map(({ id }) => id)).toEqual(['kept']);
  });

  test('does not mutate the frozen snapshot returned by Storage.getMany', async () => {
    const frozenSession = Object.freeze(session('frozen', 5));
    const frozenSessions = Object.freeze([frozenSession]);
    const frozenTombstones = Object.freeze({
      sessions: Object.freeze({ old: 2 }),
      manualGroups: Object.freeze({ retained: 3 }),
    });
    const snapshot = Object.freeze({
      sessions: frozenSessions,
      manualGroups: Object.freeze({}),
      driveSyncTombstones: frozenTombstones,
    });
    const before = json(snapshot);
    const originalGetMany = Storage.getMany;
    const originalSetMany = Storage.setMany;
    let write;
    Storage.getMany = async () => snapshot;
    Storage.setMany = async (values) => { write = values; };
    try {
      await expect(Sessions.deleteSessions(['frozen'], 10)).resolves.toEqual({
        deletedIds: ['frozen'],
        tombstones: { frozen: 10 },
      });
    } finally {
      Storage.getMany = originalGetMany;
      Storage.setMany = originalSetMany;
    }

    expect(json(snapshot)).toBe(before);
    expect(write.sessions).not.toBe(frozenSessions);
    expect(write.driveSyncTombstones).not.toBe(frozenTombstones);
  });

  test('missing IDs are no-ops and invalid inputs perform zero writes', async () => {
    for (const invocation of [
      () => Sessions.deleteSessions(['missing'], 1),
      () => Sessions.deleteSessions([], 1),
    ]) {
      const harness = installChromeMock({
        local: { sessions: [session('kept')], driveSyncTombstones: tombstones() },
      });
      await expect(invocation()).resolves.toEqual({ deletedIds: [], tombstones: {} });
      expect(harness.calls.storage.local.set).toEqual([]);
    }

    for (const [ids, deletedAt] of [
      [[''], 1],
      [['__proto__'], 1],
      [['constructor'], 1],
      [['prototype'], 1],
      [['x'.repeat(MAX_DRIVE_STRING_LENGTH + 1)], 1],
      [[7], 1],
      [['kept'], -1],
      [['kept'], NaN],
      [['kept'], Infinity],
      [['kept'], -Infinity],
      [['kept'], 1.5],
      [['kept'], '1'],
      [['kept'], MAX_DRIVE_TOMBSTONE + 1],
    ]) {
      const harness = installChromeMock({
        local: { sessions: [session('kept')], driveSyncTombstones: tombstones() },
      });
      await expect(Sessions.deleteSessions(ids, deletedAt)).rejects.toBeDefined();
      expect(harness.calls.storage.local.get).toEqual([]);
      expect(harness.calls.storage.local.set).toEqual([]);
      expect(harness.snapshot().local.sessions).toHaveLength(1);
    }
  });

  test('preflight and storage failures leave sessions and tombstones unchanged', async () => {
    for (const [record, failure] of [
      [session('too-new', MAX_DRIVE_TIMESTAMP), null],
      [session('ordinary', 2), new Error('atomic write rejected')],
    ]) {
      const initial = { sessions: [record], driveSyncTombstones: tombstones() };
      const harness = installChromeMock({
        local: initial,
        failures: failure ? { 'storage.local.set': failure } : {},
      });
      await expect(Sessions.deleteSessions([record.id], MAX_DRIVE_TOMBSTONE)).rejects.toBeDefined();
      if (failure) {
        expect(harness.calls.storage.local.set).toHaveLength(1);
        expect(Object.keys(harness.calls.storage.local.set[0][0]).sort())
          .toEqual(['driveSyncTombstones', 'sessions']);
      } else {
        expect(harness.calls.storage.local.set).toEqual([]);
      }
      expect(harness.snapshot().local).toEqual(initial);
    }

    const mixedInitial = {
      sessions: [session('valid', 2), session('too-new', MAX_DRIVE_TIMESTAMP)],
      driveSyncTombstones: tombstones(),
    };
    const mixedHarness = installChromeMock({ local: mixedInitial });
    await expect(Sessions.deleteSessions(
      ['valid', 'too-new'],
      MAX_DRIVE_TOMBSTONE,
    )).rejects.toBeDefined();
    expect(mixedHarness.calls.storage.local.get).toHaveLength(1);
    expect(mixedHarness.calls.storage.local.set).toEqual([]);
    expect(mixedHarness.snapshot().local).toEqual(mixedInitial);
  });

  test('single deletion delegates to the batch contract', async () => {
    let harness = installChromeMock({
      local: { sessions: [session('one', 5)], driveSyncTombstones: tombstones() },
    });
    await expect(Sessions.deleteSession('one', 10)).resolves.toEqual({
      deleted: true,
      tombstoneAt: 10,
    });
    expect(harness.calls.storage.local.get).toHaveLength(1);
    expect(harness.calls.storage.local.set).toHaveLength(1);
    expect(Object.keys(harness.calls.storage.local.set[0][0]).sort())
      .toEqual(['driveSyncTombstones', 'sessions']);

    harness = installChromeMock({
      local: { sessions: [session('one', 5)], driveSyncTombstones: tombstones() },
    });
    await expect(Sessions.deleteSession('missing', 10)).resolves.toEqual({
      deleted: false,
      tombstoneAt: null,
    });
    expect(harness.calls.storage.local.set).toEqual([]);
  });
});

describe('transactional session Undo', () => {
  test('rejects a restore that would exceed the canonical session resource limit', async () => {
    const existing = Array.from(
      { length: MAX_DRIVE_ENTITIES_PER_KIND },
      (_, index) => session(`existing-${String(index).padStart(5, '0')}`, index + 1),
    );
    const initial = {
      sessions: existing,
      driveSyncTombstones: tombstones({ sessions: { restored: 1 } }),
    };
    const harness = installChromeMock({ local: initial });

    await expect(Sessions.restoreDeletedSession(session('restored', 2), 3)).rejects.toThrow(
      'sessions exceed the 10,000 entity limit',
    );
    expect(harness.calls.storage.local.set).toEqual([]);
    expect(harness.snapshot().local).toEqual(initial);
  });

  test('rejects a restore whose individually bounded session and tombstones exceed the combined v2 byte ceiling', async () => {
    const halfEntryCount = Math.ceil(MAX_DRIVE_JSON_BYTES / 2 / (MAX_DRIVE_STRING_LENGTH + 8));
    const existingTombstones = Object.create(null);
    const payload = [];
    for (let index = 0; index < halfEntryCount; index += 1) {
      existingTombstones[maxLengthId(index)] = 1;
      payload.push('y'.repeat(MAX_DRIVE_STRING_LENGTH));
    }
    const initial = {
      sessions: [],
      driveSyncTombstones: tombstones({ sessions: existingTombstones }),
    };
    const harness = installChromeMock({ local: initial });

    let error;
    try {
      await Sessions.restoreDeletedSession(session('restored', 2, { payload }), 3);
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toContain('exceeds the 25 MiB byte limit');
    expect(harness.calls.storage.local.set).toEqual([]);
    expect(harness.snapshot().local).toEqual(initial);
  });

  test('rejects a restore that would exceed the full-document tab ceiling through existing groups', async () => {
    const manualGroups = Object.create(null);
    for (let index = 0; index < 10; index += 1) {
      manualGroups[`group-${index}`] = group(`Group ${index}`, 1, {
        tabUrls: Array.from({ length: 10_000 }, () => 'https://example.test/'),
      });
    }
    const initial = {
      sessions: [],
      manualGroups,
      driveSyncTombstones: tombstones({ sessions: { restored: 1 } }),
    };
    const harness = installChromeMock({ local: initial });
    const candidate = session('restored', 2, {
      windows: [{
        tabCount: 1,
        tabs: [{ url: 'https://restored.example.test/', title: 'Restored' }],
      }],
    });

    await expect(Sessions.restoreDeletedSession(candidate, 3)).rejects.toThrow(
      'document exceeds the 100,000 total tab and URL limit',
    );
    expect(harness.calls.storage.local.set).toEqual([]);
    expect(harness.snapshot().local).toEqual(initial);
  });

  test('retains the tombstone, replaces duplicates, and writes a strictly newer canonical session', async () => {
    const original = session('restore-me', 10);
    const harness = installChromeMock({
      local: {
        sessions: [session('newer-created', 40), session('restore-me', 1)],
        driveSyncTombstones: tombstones({ sessions: { 'restore-me': 50 } }),
      },
    });
    const before = json(original);

    const restored = await Sessions.restoreDeletedSession(original, 20);

    expect(json(original)).toBe(before);
    expect(restored).not.toBe(original);
    expect(restored.modifiedAt).toBe(51);
    expect(harness.calls.storage.local.get)
      .toEqual([[['sessions', 'manualGroups', 'driveSyncTombstones']]]);
    expect(harness.calls.storage.local.set).toHaveLength(1);
    const state = harness.snapshot().local;
    expect(state.sessions.map(({ id }) => id)).toEqual(['newer-created', 'restore-me']);
    expect(state.sessions.filter(({ id }) => id === 'restore-me')).toHaveLength(1);
    expect(state.sessions[1].modifiedAt).toBe(51);
    expect(state.driveSyncTombstones.sessions['restore-me']).toBe(50);
  });

  test('uses defensive legacy timestamp fallback and supports the exact ceiling', async () => {
    installChromeMock({
      local: {
        sessions: [],
        driveSyncTombstones: tombstones({ sessions: { legacy: MAX_DRIVE_TOMBSTONE } }),
      },
    });
    const legacy = session('legacy', 1, { createdAt: -1, modifiedAt: 'bad' });
    const restored = await Sessions.restoreDeletedSession(legacy, MAX_DRIVE_TIMESTAMP);
    expect(restored.modifiedAt).toBe(MAX_DRIVE_TIMESTAMP);
    expect(restored.createdAt).toBeUndefined();
  });

  test('handles absent, zero, and malformed prior tombstones without clearing retained keys', async () => {
    for (const { label, prior, keyRetained } of [
      { label: 'absent', prior: undefined, keyRetained: false },
      { label: 'zero', prior: 0, keyRetained: true },
      { label: 'malformed', prior: 'bad', keyRetained: true },
    ]) {
      const priorMap = prior === undefined ? {} : { [label]: prior };
      const harness = installChromeMock({
        local: {
          sessions: [],
          driveSyncTombstones: tombstones({ sessions: priorMap }),
        },
      });
      const restored = await Sessions.restoreDeletedSession(session(label, 2), 5);
      const storedTombstones = harness.snapshot().local.driveSyncTombstones.sessions;

      expect(restored.modifiedAt).toBe(5);
      expect(Object.hasOwn(storedTombstones, label)).toBe(keyRetained);
      if (keyRetained) expect(storedTombstones[label]).toBe(0);
    }
  });

  test('merges the actual restored transaction state over a stale profile in both operand orders', async () => {
    const harness = installChromeMock({
      local: {
        sessions: [],
        driveSyncTombstones: tombstones({ sessions: { restored: 50 } }),
      },
    });
    const restored = await Sessions.restoreDeletedSession(session('restored', 10), 20);
    const local = harness.snapshot().local;
    const restoredProfile = document({
      sessions: local.sessions,
      tombstones: local.driveSyncTombstones,
    });
    const staleProfile = document({ sessions: [session('restored', 49)] });
    const left = mergeDriveSyncDocuments(restoredProfile, staleProfile);
    const right = mergeDriveSyncDocuments(staleProfile, restoredProfile);

    expect(restored.modifiedAt).toBe(51);
    expect(json(left)).toBe(json(right));
    expect(left.sessions).toHaveLength(1);
    expect(left.sessions[0].modifiedAt).toBe(51);
    expect(left.tombstones.sessions.restored).toBe(50);
  });

  test('rejects malformed restore clocks/payloads and atomic write failure changes nothing', async () => {
    for (const restoredAt of [NaN, Infinity, -Infinity, -1, 1.5, '2', MAX_DRIVE_TIMESTAMP + 1]) {
      const harness = installChromeMock({
        local: { sessions: [], driveSyncTombstones: tombstones() },
      });
      await expect(Sessions.restoreDeletedSession(session('s'), restoredAt)).rejects.toBeDefined();
      expect(harness.calls.storage.local.set).toEqual([]);
    }

    for (const payload of [
      null,
      [],
      { id: '' },
      { id: '__proto__' },
      { id: 'constructor' },
      { id: 'prototype' },
      { id: 'x'.repeat(MAX_DRIVE_STRING_LENGTH + 1) },
      session('bad', 1, { windows: {} }),
    ]) {
      const harness = installChromeMock({
        local: { sessions: [], driveSyncTombstones: tombstones() },
      });
      await expect(Sessions.restoreDeletedSession(payload, 2)).rejects.toBeDefined();
      expect(harness.calls.storage.local.set).toEqual([]);
    }

    Object.defineProperty(Object.prototype, 'id', {
      value: 'inherited-session',
      configurable: true,
    });
    try {
      const harness = installChromeMock({
        local: { sessions: [], driveSyncTombstones: tombstones() },
      });
      const payload = {
        name: 'Inherited ID payload',
        version: 2,
        createdAt: 1,
        modifiedAt: 1,
        windows: [{ tabCount: 0, tabs: [] }],
      };
      await expect(Sessions.restoreDeletedSession(payload, 2)).rejects.toThrow(/own|ID/i);
      expect(harness.calls.storage.local.set).toEqual([]);
    } finally {
      delete Object.prototype.id;
    }

    const initial = {
      sessions: [],
      driveSyncTombstones: tombstones({ sessions: { failed: 4 } }),
    };
    const harness = installChromeMock({
      local: initial,
      failures: { 'storage.local.set': new Error('restore write failed') },
    });
    await expect(Sessions.restoreDeletedSession(session('failed', 2), 3)).rejects.toThrow('restore write failed');
    expect(harness.calls.storage.local.set).toHaveLength(1);
    expect(Object.keys(harness.calls.storage.local.set[0][0]).sort())
      .toEqual(['driveSyncTombstones', 'sessions']);
    expect(harness.snapshot().local).toEqual(initial);
  });
});

describe('transactional manual-group deletion', () => {
  test('removes the group and records its tombstone in one two-key write', async () => {
    const initial = {
      manualGroups: { alpha: group('Alpha', 12), kept: group('Kept', 30) },
      driveSyncTombstones: tombstones({ manualGroups: { alpha: 9, old: 7 } }),
    };
    const before = json(initial);
    const harness = installChromeMock({ local: initial });

    await expect(Grouping.deleteManualGroup('alpha', 10)).resolves.toEqual({
      deleted: true,
      tombstoneAt: 12,
    });
    expect(harness.calls.storage.local.get)
      .toEqual([[['sessions', 'manualGroups', 'driveSyncTombstones']]]);
    expect(harness.calls.storage.local.set).toHaveLength(1);
    const write = harness.calls.storage.local.set[0][0];
    expect(Object.keys(write).sort()).toEqual(['driveSyncTombstones', 'manualGroups']);
    expect(Object.keys(write.manualGroups)).toEqual(['kept']);
    expect(write.driveSyncTombstones.manualGroups).toEqual({ alpha: 12, old: 7 });
    expect(json(initial)).toBe(before);
  });

  test('supports future and ceiling timestamps plus tombstone-cap updates but rejects additions', async () => {
    let harness = installChromeMock({
      local: {
        manualGroups: { future: group('Future', 5) },
        driveSyncTombstones: tombstones(),
      },
    });
    await expect(Grouping.deleteManualGroup('future', 1_000)).resolves.toEqual({
      deleted: true,
      tombstoneAt: 1_000,
    });

    harness = installChromeMock({
      local: {
        manualGroups: { prior: group('Prior', 5) },
        driveSyncTombstones: tombstones({ manualGroups: { prior: 2_000 } }),
      },
    });
    await expect(Grouping.deleteManualGroup('prior', 1_000)).resolves.toEqual({
      deleted: true,
      tombstoneAt: 2_000,
    });
    expect(harness.snapshot().local.driveSyncTombstones.manualGroups.prior).toBe(2_000);

    harness = installChromeMock({
      local: {
        manualGroups: { ceiling: group('Ceiling', MAX_DRIVE_TOMBSTONE) },
        driveSyncTombstones: tombstones(),
      },
    });
    await expect(Grouping.deleteManualGroup('ceiling', 0)).resolves.toEqual({
      deleted: true,
      tombstoneAt: MAX_DRIVE_TOMBSTONE,
    });

    const full = Object.create(null);
    for (let index = 0; index < MAX_DRIVE_TOMBSTONES_PER_KIND; index += 1) {
      full[`id-${index}`] = 1;
    }
    harness = installChromeMock({
      local: {
        manualGroups: { 'id-0': group('Existing') },
        driveSyncTombstones: tombstones({ manualGroups: full }),
      },
    });
    await expect(Grouping.deleteManualGroup('id-0', 2)).resolves.toEqual({
      deleted: true,
      tombstoneAt: 2,
    });
    expect(Object.keys(harness.snapshot().local.driveSyncTombstones.manualGroups))
      .toHaveLength(MAX_DRIVE_TOMBSTONES_PER_KIND);

    harness = installChromeMock({
      local: {
        manualGroups: { 'new-id': group('New') },
        driveSyncTombstones: tombstones({ manualGroups: full }),
      },
    });
    await expect(Grouping.deleteManualGroup('new-id', 2)).rejects.toThrow(/10,000|limit/i);
    expect(harness.calls.storage.local.set).toEqual([]);
  });

  test('missing, invalid, unrepresentable, and rejected writes never partially mutate state', async () => {
    let harness = installChromeMock({
      local: { manualGroups: { kept: group('Kept') }, driveSyncTombstones: tombstones() },
    });
    await expect(Grouping.deleteManualGroup('missing', 2)).resolves.toEqual({
      deleted: false,
      tombstoneAt: null,
    });
    expect(harness.calls.storage.local.set).toEqual([]);

    for (const [id, deletedAt, record] of [
      ['', 2, group('Bad')],
      ['__proto__', 2, group('Bad')],
      ['constructor', 2, group('Bad')],
      ['prototype', 2, group('Bad')],
      ['x'.repeat(MAX_DRIVE_STRING_LENGTH + 1), 2, group('Bad')],
      ['bad-time', -1, group('Bad')],
      ['nan-time', NaN, group('Bad')],
      ['infinite-time', Infinity, group('Bad')],
      ['negative-infinite-time', -Infinity, group('Bad')],
      ['fraction-time', 1.5, group('Bad')],
      ['string-time', '2', group('Bad')],
      ['over-time', MAX_DRIVE_TOMBSTONE + 1, group('Bad')],
      ['too-new', MAX_DRIVE_TOMBSTONE, group('Too New', MAX_DRIVE_TIMESTAMP)],
    ]) {
      harness = installChromeMock({
        local: { manualGroups: { [id]: record }, driveSyncTombstones: tombstones() },
      });
      await expect(Grouping.deleteManualGroup(id, deletedAt)).rejects.toBeDefined();
      if (id !== 'too-new') expect(harness.calls.storage.local.get).toEqual([]);
      expect(harness.calls.storage.local.set).toEqual([]);
    }

    const initial = {
      manualGroups: { alpha: group('Alpha') },
      driveSyncTombstones: tombstones(),
    };
    harness = installChromeMock({
      local: initial,
      failures: { 'storage.local.set': new Error('group write failed') },
    });
    await expect(Grouping.deleteManualGroup('alpha', 2)).rejects.toThrow('group write failed');
    expect(harness.calls.storage.local.set).toHaveLength(1);
    expect(Object.keys(harness.calls.storage.local.set[0][0]).sort())
      .toEqual(['driveSyncTombstones', 'manualGroups']);
    expect(harness.snapshot().local).toEqual(initial);
  });
});

describe('retention and worker ownership', () => {
  test('rolling auto-save delegates one batch with the operation clock and keeps the two newest', async () => {
    installChromeMock();
    const worker = await freshWorker('auto-save-retention');
    const calls = [];
    const now = 20 * 24 * 60 * 60 * 1000;
    const records = [
      session('newest', now - 1, { name: '[Auto] newest' }),
      session('second', now - 2, { name: '[Auto] second' }),
      session('expired-a', 1, { name: '[Auto] expired A' }),
      session('expired-b', 2, { name: '[Auto] expired B' }),
    ];
    await worker.autoSaveSession({
      getTabs: async () => [{ id: 1 }, { id: 2 }],
      loadSettings: async () => ({ autoSaveRetentionDays: 1 }),
      saveSnapshot: async () => {},
      getStorage: async () => records,
      deleteSessions: async (ids, deletedAt) => calls.push({ ids, deletedAt }),
      setStorage: async () => { throw new Error('direct filtered-session write forbidden'); },
      now: () => now,
    });
    expect(calls).toEqual([{ ids: ['expired-a', 'expired-b'], deletedAt: now }]);
  });

  test('alarm retention uses one captured clock for cutoff and the batch tombstones', async () => {
    installChromeMock();
    const worker = await freshWorker('alarm-retention');
    const calls = [];
    const nowMs = 50 * 24 * 60 * 60 * 1000;
    const records = [
      session('newest', nowMs - 1, { name: '[Auto] newest' }),
      session('second', nowMs - 2, { name: '[Auto] second' }),
      session('expired', 1, { name: '[Auto] expired' }),
    ];
    await worker.runRetentionCleanup({
      getSettings: async () => ({
        autoSaveRetentionDays: 1,
        driveRetentionDays: 30,
        neverDeleteFromDrive: true,
      }),
      getStorage: async (key) => key === 'sessions' ? records : { connected: false },
      deleteSessions: async (ids, deletedAt) => calls.push({ ids, deletedAt }),
      setStorage: async () => { throw new Error('direct filtered-session write forbidden'); },
      now: () => nowMs,
    });
    expect(calls).toEqual([{ ids: ['expired'], deletedAt: nowMs }]);
  });

  test('production auto-save and alarm retention persist every expired ID with shared-or-later tombstones', async () => {
    const day = 24 * 60 * 60 * 1000;
    const autoNow = 20 * day;
    let harness = installChromeMock({
      local: {
        sessions: [
          session('newest', autoNow - 1, { name: '[Auto] newest' }),
          session('second', autoNow - 2, { name: '[Auto] second' }),
          session('old-entity', 5, { name: '[Auto] old entity' }),
          session('old-prior', 4, { name: '[Auto] old prior' }),
        ],
        driveSyncTombstones: tombstones({ sessions: { 'old-prior': autoNow + 5 } }),
      },
    });
    let worker = await freshWorker('auto-save-real-transaction');
    await worker.autoSaveSession({
      getTabs: async () => [{ id: 1 }, { id: 2 }],
      loadSettings: async () => ({ autoSaveRetentionDays: 1 }),
      saveSnapshot: async () => {},
      now: () => autoNow,
    });
    expect(harness.snapshot().local.sessions.map(({ id }) => id)).toEqual(['newest', 'second']);
    expect(harness.snapshot().local.driveSyncTombstones.sessions['old-entity']).toBe(autoNow);
    expect(harness.snapshot().local.driveSyncTombstones.sessions['old-prior']).toBe(autoNow + 5);
    expect(harness.calls.storage.local.set).toHaveLength(1);
    expect(Object.keys(harness.calls.storage.local.set[0][0]).sort())
      .toEqual(['driveSyncTombstones', 'sessions']);

    const alarmNow = 40 * day;
    harness = installChromeMock({
      local: {
        sessions: [
          session('alarm-newest', alarmNow - 1, { name: '[Auto] alarm newest' }),
          session('alarm-second', alarmNow - 2, { name: '[Auto] alarm second' }),
          session('alarm-old-entity', 6, { name: '[Auto] alarm old entity' }),
          session('alarm-old-prior', 7, { name: '[Auto] alarm old prior' }),
        ],
        driveSyncTombstones: tombstones({ sessions: { 'alarm-old-prior': alarmNow + 5 } }),
        driveSync: { connected: false },
      },
    });
    worker = await freshWorker('alarm-real-transaction');
    await worker.runRetentionCleanup({
      getSettings: async () => ({
        autoSaveRetentionDays: 1,
        driveRetentionDays: 30,
        neverDeleteFromDrive: true,
      }),
      now: () => alarmNow,
    });
    expect(harness.snapshot().local.sessions.map(({ id }) => id))
      .toEqual(['alarm-newest', 'alarm-second']);
    expect(harness.snapshot().local.driveSyncTombstones.sessions['alarm-old-entity']).toBe(alarmNow);
    expect(harness.snapshot().local.driveSyncTombstones.sessions['alarm-old-prior']).toBe(alarmNow + 5);
    expect(harness.calls.storage.local.set).toHaveLength(1);
    expect(Object.keys(harness.calls.storage.local.set[0][0]).sort())
      .toEqual(['driveSyncTombstones', 'sessions']);
  });

  test('runtime delete/Undo/group actions own their clocks and return checked URL-free summaries', async () => {
    const original = session('worker-session', 1);
    installChromeMock({
      local: {
        sessions: [original],
        manualGroups: { workerGroup: group('Worker Group', 1) },
        driveSyncTombstones: tombstones(),
      },
    });
    const worker = await freshWorker('runtime-routing');

    const deleted = await worker.handleMessage({
      action: 'deleteSession',
      sessionId: original.id,
      deletedAt: 0,
    });
    expect(deleted.deleted).toBeTrue();
    expect(Object.keys(deleted).sort()).toEqual(['deleted', 'tombstoneAt']);
    expect(Number.isSafeInteger(deleted.tombstoneAt)).toBeTrue();
    expect(deleted.tombstoneAt).not.toBe(0);

    const restored = await worker.handleMessage({
      action: 'undoDeleteSession',
      session: original,
      restoredAt: 0,
    });
    expect(restored).toEqual({ restored: true, modifiedAt: expect.any(Number) });
    expect(Object.keys(restored).sort()).toEqual(['modifiedAt', 'restored']);
    expect(Object.hasOwn(restored, 'session')).toBeFalse();
    expect(restored.modifiedAt).toBeGreaterThan(deleted.tombstoneAt);

    const removedGroup = await worker.handleMessage({
      action: 'deleteManualGroup',
      groupId: 'workerGroup',
      deletedAt: 0,
    });
    expect(removedGroup.deleted).toBeTrue();
    expect(Object.keys(removedGroup).sort()).toEqual(['deleted', 'tombstoneAt']);
    expect(removedGroup.tombstoneAt).not.toBe(0);
  });

  test('explicit deletion queues behind an in-flight canonical sync and is not overwritten', async () => {
    const uploadEntered = deferred();
    const uploadGate = deferred();
    const original = session('queued-delete', 10);
    const harness = installChromeMock({
      local: {
        sessions: [original],
        manualGroups: {},
        driveSyncTombstones: tombstones(),
        driveSync: { connected: true },
      },
    });
    const worker = await freshWorker('queued-delete');
    const syncPromise = worker.syncDriveState({
      getDriveState: async () => ({ connected: true }),
      findRemote: async () => null,
      writeRemote: async () => {
        uploadEntered.resolve();
        await uploadGate.promise;
        return 'sync-file';
      },
      exportSubfolders: async () => ({ sessions: 1, stashes: 0, bookmarks: 0 }),
      loadSettings: async () => (await import('../../core/settings.js')).SETTINGS_DEFAULTS,
      writeSettings: async () => {},
      setDriveState: async () => {},
      now: () => 100,
    });
    await uploadEntered.promise;
    let settled = false;
    const deletion = worker.handleMessage({ action: 'deleteSession', sessionId: original.id })
      .finally(() => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBeFalse();
    expect(harness.snapshot().local.sessions).toHaveLength(1);
    uploadGate.resolve();
    await syncPromise;
    await expect(deletion).resolves.toEqual({ deleted: true, tombstoneAt: expect.any(Number) });
    expect(harness.snapshot().local.sessions).toEqual([]);
    expect(harness.snapshot().local.driveSyncTombstones.sessions[original.id]).toBeNumber();
  });

  test('Undo, rolling cleanup, alarm cleanup, and group deletion all queue behind canonical sync', async () => {
    const uploadEntered = deferred();
    const uploadGate = deferred();
    const order = [];
    const day = 24 * 60 * 60 * 1000;
    const nowMs = 20 * day;
    const autoRecords = [
      session('newest', nowMs - 1, { name: '[Auto] newest' }),
      session('second', nowMs - 2, { name: '[Auto] second' }),
      session('expired', 1, { name: '[Auto] expired' }),
    ];
    installChromeMock({
      local: {
        sessions: [],
        manualGroups: {},
        driveSyncTombstones: tombstones(),
        driveSync: { connected: true },
      },
    });
    const worker = await freshWorker('queued-task8-writers');
    const syncPromise = worker.syncDriveState({
      getDriveState: async () => ({ connected: true }),
      findRemote: async () => null,
      writeRemote: async () => {
        order.push('sync:held');
        uploadEntered.resolve();
        await uploadGate.promise;
        return 'sync-file';
      },
      exportSubfolders: async () => ({ sessions: 0, stashes: 0, bookmarks: 0 }),
      loadSettings: async () => (await import('../../core/settings.js')).SETTINGS_DEFAULTS,
      writeSettings: async () => {},
      setDriveState: async () => {},
      now: () => nowMs,
    });
    await uploadEntered.promise;

    const undo = worker.handleMessage(
      { action: 'undoDeleteSession', session: session('queued-undo') },
      {
        now: () => nowMs,
        restoreDeletedSession: async () => {
          order.push('undo');
          return session('queued-undo', nowMs);
        },
      },
    );
    const groupDeletion = worker.handleMessage(
      { action: 'deleteManualGroup', groupId: 'queued-group' },
      {
        now: () => nowMs,
        deleteManualGroup: async () => {
          order.push('group');
          return { deleted: true, tombstoneAt: nowMs };
        },
      },
    );
    const rollingCleanup = worker.autoSaveSession({
      getTabs: async () => [{ id: 1 }, { id: 2 }],
      loadSettings: async () => ({ autoSaveRetentionDays: 1 }),
      saveSnapshot: async () => {},
      getStorage: async () => autoRecords,
      deleteSessions: async () => { order.push('rolling'); },
      now: () => nowMs,
    });
    const alarmCleanup = worker.runRetentionCleanup({
      getSettings: async () => ({
        autoSaveRetentionDays: 1,
        driveRetentionDays: 30,
        neverDeleteFromDrive: true,
      }),
      getStorage: async (key) => key === 'sessions' ? autoRecords : { connected: false },
      deleteSessions: async () => { order.push('alarm'); },
      now: () => nowMs,
    });

    await flushMicrotasks();
    expect(order).toEqual(['sync:held']);
    uploadGate.resolve();
    await syncPromise;
    await Promise.all([undo, groupDeletion, rollingCleanup, alarmCleanup]);
    expect(order).toEqual(['sync:held', 'undo', 'group', 'rolling', 'alarm']);
  });

  test('source contains no direct retention deletion or optimistic panel success path', async () => {
    const workerSource = await Bun.file(new URL('../../service-worker.js', import.meta.url)).text();
    const sessionPanel = await Bun.file(
      new URL('../../sidepanel/components/session-manager.js', import.meta.url),
    ).text();
    const groupPanel = await Bun.file(
      new URL('../../sidepanel/components/group-editor.js', import.meta.url),
    ).text();

    expect(workerSource).not.toMatch(/setStorage\([^\n]*sessions\.filter/);
    expect(workerSource).not.toMatch(/setStorage\(filtered\)/);
    expect(sessionPanel).toMatch(/deleted\s*===\s*true|deleted\s*!==\s*true/);
    expect(sessionPanel).toMatch(/restored\s*===\s*true|restored\s*!==\s*true/);
    expect(groupPanel).toMatch(/deleted\s*===\s*true|deleted\s*!==\s*true/);
  });
});

describe('checked deletion panels', () => {
  test('session deletion and Undo render success only from explicit worker confirmations', async () => {
    const restoreDocument = installPanelDocument();
    const { SessionManager } = await import(`../../sidepanel/components/session-manager.js?task8-panel=${++workerNonce}`);
    const original = session('panel-session', 1);
    const notices = [];
    let refreshes = 0;
    const manager = Object.create(SessionManager.prototype);
    manager.send = async ({ action }) => action === 'deleteSession'
      ? { deleted: true, tombstoneAt: 5 }
      : { restored: true, modifiedAt: 6 };
    manager.notify = (...args) => notices.push(args);
    manager.refresh = async () => { refreshes += 1; };

    try {
      await expect(manager.deleteSessionRecord(original)).resolves.toBeTrue();
      expect(refreshes).toBe(1);
      const deletionNotice = notices.find(([, type]) => type === 'success');
      expect(deletionNotice?.[0]).toContain('Deleted');
      expect(deletionNotice?.[3]?.label).toBe('Undo');
      await deletionNotice[3].callback();
      expect(refreshes).toBe(2);
      expect(notices.filter(([, type]) => type === 'success')).toHaveLength(2);
    } finally {
      restoreDocument();
    }
  });

  test('session deletion and Undo keep committed outcomes distinct from refresh failures', async () => {
    const restoreDocument = installPanelDocument();
    try {
      const { SessionManager } = await import(`../../sidepanel/components/session-manager.js?task8-panel=${++workerNonce}`);
      const notices = [];
      const manager = Object.create(SessionManager.prototype);
      manager.send = async ({ action }) => {
        if (action === 'deleteSession') return { deleted: true, tombstoneAt: 5 };
        if (action === 'undoDeleteSession') return { restored: true, modifiedAt: 6 };
        if (action === 'listSessions') throw new Error('projection failed');
        throw new Error(`Unexpected action: ${action}`);
      };
      manager.notify = (...args) => notices.push(args);

      await expect(manager.deleteSessionRecord(session('committed'))).resolves.toBeTrue();
      expect(notices).toHaveLength(1);
      expect(notices[0][0]).toContain('Deleted "committed", but the view could not refresh');
      expect(notices[0][1]).toBe('error');
      expect(notices[0][3]?.label).toBe('Undo');

      await notices[0][3].callback();
      expect(notices).toHaveLength(2);
      expect(notices[1][0]).toContain('Restored "committed", but the view could not refresh');
      expect(notices[1][0]).not.toContain('Undo failed');
      expect(notices[1][1]).toBe('error');
    } finally {
      restoreDocument();
    }
  });

  test('false or rejected Undo confirmations never refresh or render restore success', async () => {
    const restoreDocument = installPanelDocument();
    try {
      const { SessionManager } = await import(`../../sidepanel/components/session-manager.js?task8-panel=${++workerNonce}`);
      for (const undo of [
        async () => ({ restored: false }),
        async () => { throw new Error('worker rejected Undo'); },
      ]) {
        const notices = [];
        let refreshes = 0;
        const manager = Object.create(SessionManager.prototype);
        manager.send = async ({ action }) => action === 'deleteSession'
          ? { deleted: true, tombstoneAt: 5 }
          : undo();
        manager.notify = (...args) => notices.push(args);
        manager.refresh = async () => { refreshes += 1; };

        await expect(manager.deleteSessionRecord(session('undo-failure'))).resolves.toBeTrue();
        expect(refreshes).toBe(1);
        const deletionNotice = notices.find((args) => args[3]?.label === 'Undo');
        await deletionNotice[3].callback();
        expect(refreshes).toBe(1);
        expect(notices.filter(([message]) => message.startsWith('Restored'))).toEqual([]);
        expect(notices.filter(([, type]) => type === 'error')).toHaveLength(1);
      }
    } finally {
      restoreDocument();
    }
  });

  test('missing or rejected session deletion exposes no success or Undo action', async () => {
    const restoreDocument = installPanelDocument();
    try {
      const { SessionManager } = await import(`../../sidepanel/components/session-manager.js?task8-panel=${++workerNonce}`);
      for (const send of [
        async () => ({ deleted: false, tombstoneAt: null }),
        async () => { throw new Error('worker rejected'); },
      ]) {
        const notices = [];
        const manager = Object.create(SessionManager.prototype);
        manager.send = send;
        manager.notify = (...args) => notices.push(args);
        manager.refresh = async () => {};
        await expect(manager.deleteSessionRecord(session('missing'))).resolves.toBeFalse();
        expect(notices.some(([, type]) => type === 'success')).toBeFalse();
        expect(notices.some((args) => args[3]?.label === 'Undo')).toBeFalse();
        expect(notices.some(([, type]) => type === 'error')).toBeTrue();
      }
    } finally {
      restoreDocument();
    }
  });

  test('missing group deletion cannot render success or refresh committed state', async () => {
    const { GroupEditor } = await import('../../sidepanel/components/group-editor.js');
    const notices = [];
    let refreshes = 0;
    const manager = Object.create(GroupEditor.prototype);
    manager.send = async () => ({ deleted: false, tombstoneAt: null });
    manager.notify = (message, type) => notices.push({ message, type });
    manager.refresh = async () => { refreshes += 1; };

    await expect(manager.deleteGroup('missing', 'Missing')).resolves.toBeFalse();
    expect(refreshes).toBe(0);
    expect(notices.filter(({ type }) => type === 'success')).toEqual([]);
    expect(notices.filter(({ type }) => type === 'error')).toHaveLength(1);
  });
});

describe('two-profile deletion convergence', () => {
  test('stale/equal copies delete, while newer and Undo copies survive with tombstones retained', () => {
    const tombstoneAt = 50;
    const cases = [
      { entity: session('shared', 49), present: false },
      { entity: session('shared', 50), present: false },
      { entity: session('shared', 51), present: true },
      { entity: session('shared', 70), present: true },
    ];

    for (const { entity, present } of cases) {
      const profileA = document({
        tombstones: tombstones({ sessions: { shared: tombstoneAt } }),
      });
      const profileB = document({ sessions: [entity] });
      const left = mergeDriveSyncDocuments(profileA, profileB);
      const right = mergeDriveSyncDocuments(profileB, profileA);
      expect(json(left)).toBe(json(right));
      expect(left.sessions.some(({ id }) => id === 'shared')).toBe(present);
      expect(left.tombstones.sessions.shared).toBe(tombstoneAt);
    }
  });
});
