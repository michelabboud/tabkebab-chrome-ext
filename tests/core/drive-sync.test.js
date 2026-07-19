import { describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { Storage } from '../../core/storage.js';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ENTITIES = 10_000;
const MAX_TOMBSTONES = 10_000;
const MAX_TABS_PER_ENTITY = 10_000;
const MAX_TOTAL_TABS = 100_000;
const MAX_STRING = 16_384;
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;
const MAX_TOMBSTONE = MAX_TIMESTAMP - 1;

let importNonce = 0;

async function syncModule() {
  return import('../../core/drive-sync.js');
}

async function freshDriveClient(label) {
  return import(`../../core/drive-client.js?task7=${label}-${++importNonce}`);
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

function v2(overrides = {}) {
  return {
    version: 2,
    sessions: [],
    manualGroups: {},
    tombstones: { sessions: {}, manualGroups: {} },
    ...overrides,
  };
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nestedValue(depth) {
  let value = 'leaf';
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

function repeatedMap(count, makeValue) {
  const result = Object.create(null);
  for (let index = 0; index < count; index += 1) {
    result[`id-${String(index).padStart(5, '0')}`] = makeValue(index);
  }
  return result;
}

function fakeResponse({
  chunks,
  contentLength = null,
  text,
  arrayBuffer,
  json,
  onRead = () => {},
  onCancel = () => {},
} = {}) {
  const headers = new Headers();
  if (contentLength !== null) headers.set('Content-Length', String(contentLength));
  const response = {
    ok: true,
    status: 200,
    headers,
    json: json ?? (() => { throw new Error('response.json() must not be called'); }),
  };
  if (chunks) {
    let index = 0;
    response.body = {
      getReader() {
        return {
          async read() {
            onRead();
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          async cancel() { onCancel(); },
        };
      },
    };
  } else {
    response.body = null;
    if (arrayBuffer) response.arrayBuffer = arrayBuffer;
    if (text) response.text = text;
  }
  return response;
}

describe('Drive sync v2 migration', () => {
  test('exports the fixed schema constants and fresh empty tombstone maps', async () => {
    const sync = await syncModule();
    expect({
      version: sync.DRIVE_SYNC_VERSION,
      tombstonesKey: sync.DRIVE_TOMBSTONES_KEY,
      bytes: sync.MAX_DRIVE_JSON_BYTES,
      entities: sync.MAX_DRIVE_ENTITIES_PER_KIND,
      tombstones: sync.MAX_DRIVE_TOMBSTONES_PER_KIND,
      entityTabs: sync.MAX_DRIVE_TABS_PER_ENTITY,
      totalTabs: sync.MAX_DRIVE_TOTAL_TABS,
      string: sync.MAX_DRIVE_STRING_LENGTH,
      depth: sync.MAX_DRIVE_NESTING_DEPTH,
      timestamp: sync.MAX_DRIVE_TIMESTAMP,
      tombstone: sync.MAX_DRIVE_TOMBSTONE,
    }).toEqual({
      version: 2,
      tombstonesKey: 'driveSyncTombstones',
      bytes: MAX_BYTES,
      entities: MAX_ENTITIES,
      tombstones: MAX_TOMBSTONES,
      entityTabs: MAX_TABS_PER_ENTITY,
      totalTabs: MAX_TOTAL_TABS,
      string: MAX_STRING,
      depth: 12,
      timestamp: MAX_TIMESTAMP,
      tombstone: MAX_TOMBSTONE,
    });
    const first = sync.emptyDriveTombstones();
    const second = sync.emptyDriveTombstones();
    expect(first).not.toBe(second);
    expect(first.sessions).not.toBe(second.sessions);
    expect(first.manualGroups).not.toBe(second.manualGroups);
    expect(Object.getPrototypeOf(first.sessions)).toBeNull();
    expect(Object.getPrototypeOf(first.manualGroups)).toBeNull();
  });

  test('migrates null, missing-version, and explicit-v1 documents in memory', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const inputs = [
      null,
      { sessions: [session('missing')], manualGroups: { beta: group('Beta') } },
      { version: 1, sessions: [session('v1')], manualGroups: { alpha: group('Alpha') } },
    ];

    const results = inputs.map(migrateDriveSyncDocument);
    expect(results[0]).toEqual(v2());
    expect(results[1]).toMatchObject({
      version: 2,
      sessions: [expect.objectContaining({ id: 'missing' })],
      tombstones: { sessions: {}, manualGroups: {} },
    });
    expect(results[2]).toMatchObject({
      version: 2,
      sessions: [expect.objectContaining({ id: 'v1' })],
      tombstones: { sessions: {}, manualGroups: {} },
    });
  });

  test('returns fresh normalized v2 values with null-prototype lexical maps', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const input = v2({
      sessions: [session('s1', 2, { metadata: { z: 1, a: 2 } })],
      manualGroups: { zed: group('Zed'), alpha: group('Alpha') },
      tombstones: {
        sessions: { zed: 3, alpha: 2 },
        manualGroups: { omega: 4, beta: 1 },
      },
    });

    const output = migrateDriveSyncDocument(input);
    expect(output).not.toBe(input);
    expect(output.sessions).not.toBe(input.sessions);
    expect(output.sessions[0]).not.toBe(input.sessions[0]);
    expect(output.sessions[0].metadata).not.toBe(input.sessions[0].metadata);
    expect(Object.getPrototypeOf(output.manualGroups)).toBeNull();
    expect(Object.getPrototypeOf(output.tombstones.sessions)).toBeNull();
    expect(Object.getPrototypeOf(output.tombstones.manualGroups)).toBeNull();
    expect(Object.keys(output.manualGroups)).toEqual(['alpha', 'zed']);
    expect(Object.keys(output.tombstones.sessions)).toEqual(['alpha', 'zed']);
    expect(Object.keys(output.tombstones.manualGroups)).toEqual(['beta', 'omega']);
  });

  test('does not mutate frozen migration or merge inputs', async () => {
    const { migrateDriveSyncDocument, mergeDriveSyncDocuments } = await syncModule();
    const left = v2({ sessions: [session('left', 1)] });
    const right = v2({ manualGroups: { right: group('Right', 2) } });
    const beforeLeft = JSON.stringify(left);
    const beforeRight = JSON.stringify(right);
    Object.freeze(left.sessions[0].windows[0].tabs);
    Object.freeze(left.sessions[0].windows[0]);
    Object.freeze(left.sessions[0].windows);
    Object.freeze(left.sessions[0]);
    Object.freeze(left.sessions);
    Object.freeze(left.manualGroups);
    Object.freeze(left.tombstones.sessions);
    Object.freeze(left.tombstones.manualGroups);
    Object.freeze(left.tombstones);
    Object.freeze(left);

    expect(migrateDriveSyncDocument(left)).toBeDefined();
    expect(mergeDriveSyncDocuments(left, right)).toBeDefined();
    expect(JSON.stringify(left)).toBe(beforeLeft);
    expect(JSON.stringify(right)).toBe(beforeRight);
  });

  test('rejects unsupported versions and missing or inherited v2 sections', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    expect(() => migrateDriveSyncDocument({ version: 3 })).toThrow(/version/i);
    expect(() => migrateDriveSyncDocument({ version: 2, manualGroups: {}, tombstones: { sessions: {}, manualGroups: {} } })).toThrow(/sessions/i);
    expect(() => migrateDriveSyncDocument({ version: 2, sessions: [], tombstones: { sessions: {}, manualGroups: {} } })).toThrow(/manualGroups/i);
    expect(() => migrateDriveSyncDocument({ version: 2, sessions: [], manualGroups: {} })).toThrow(/tombstones/i);

    const inherited = Object.create({ sessions: [] });
    Object.assign(inherited, {
      version: 2,
      manualGroups: {},
      tombstones: { sessions: {}, manualGroups: {} },
    });
    expect(() => migrateDriveSyncDocument(inherited)).toThrow();
  });

  test('rejects malformed and duplicate sessions', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    for (const sessions of [
      {},
      [null],
      [[]],
      [{ id: '' }],
      [{ id: 1 }],
      [session('duplicate'), session('duplicate')],
      [session('sparse', 1, { windows: new Array(1) })],
      [session('bad-tabs', 1, { windows: [{ tabs: {} }] })],
      [session('bad-number', 1, { score: Infinity })],
    ]) {
      expect(() => migrateDriveSyncDocument(v2({ sessions }))).toThrow();
    }
  });

  test('rejects malformed manual groups and tombstones', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const invalid = [
      v2({ manualGroups: [] }),
      v2({ manualGroups: { '': group('empty') } }),
      v2({ manualGroups: { bad: null } }),
      v2({ manualGroups: { bad: group('bad', 1, { tabUrls: {} }) } }),
      v2({ tombstones: [] }),
      v2({ tombstones: { sessions: [], manualGroups: {} } }),
      v2({ tombstones: { sessions: {}, manualGroups: [] } }),
      v2({ tombstones: { sessions: {} } }),
      v2({ tombstones: { manualGroups: {} } }),
      v2({ tombstones: { sessions: { '': 1 }, manualGroups: {} } }),
      v2({ tombstones: { sessions: { bad: -1 }, manualGroups: {} } }),
      v2({ tombstones: { sessions: { bad: MAX_TIMESTAMP }, manualGroups: {} } }),
      v2({ manualGroups: { bad: group('bad', 1, { modifiedAt: '1' }) } }),
      v2({ tombstones: { sessions: {}, manualGroups: { bad: -1 } } }),
      { ...v2(), unknown: true },
      v2({ tombstones: { sessions: {}, manualGroups: {}, unknown: {} } }),
    ];
    for (const value of invalid) expect(() => migrateDriveSyncDocument(value)).toThrow();

    const inheritedGroups = Object.create({ inherited: group('Inherited') });
    expect(() => migrateDriveSyncDocument(v2({ manualGroups: inheritedGroups }))).toThrow();
    const dangerousGroupMap = JSON.parse('{"constructor":{"name":"bad","tabUrls":[]}}');
    expect(() => migrateDriveSyncDocument(v2({ manualGroups: dangerousGroupMap }))).toThrow();
    const dangerousTombstones = JSON.parse('{"__proto__":1}');
    expect(() => migrateDriveSyncDocument(v2({
      tombstones: { sessions: dangerousTombstones, manualGroups: {} },
    }))).toThrow();
    const dangerousGroupTombstones = JSON.parse('{"constructor":1}');
    expect(() => migrateDriveSyncDocument(v2({
      tombstones: { sessions: {}, manualGroups: dangerousGroupTombstones },
    }))).toThrow();

    const inheritedKinds = Object.create({ sessions: {} });
    inheritedKinds.manualGroups = {};
    expect(() => migrateDriveSyncDocument(v2({ tombstones: inheritedKinds }))).toThrow();
  });

  test('rejects dangerous keys and non-JSON structures at every depth', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const dangerous = ['__proto__', 'constructor', 'prototype'];
    for (const key of dangerous) {
      const root = JSON.parse(`{"version":2,"sessions":[],"manualGroups":{},"tombstones":{"sessions":{},"manualGroups":{}},"${key}":true}`);
      const nested = v2({ sessions: [session('s', 1, { metadata: JSON.parse(`{"${key}":true}`) })] });
      expect(() => migrateDriveSyncDocument(root)).toThrow();
      expect(() => migrateDriveSyncDocument(nested)).toThrow();
    }

    const symbolBearing = v2();
    symbolBearing[Symbol('hidden')] = true;
    expect(() => migrateDriveSyncDocument(symbolBearing)).toThrow();
    expect(() => migrateDriveSyncDocument(v2({ sessions: [session('s', 1, { missing: undefined })] }))).toThrow();
  });
});

describe('Drive timestamps and deterministic merge', () => {
  test('prefers valid modifiedAt, falls back to createdAt, then zero', async () => {
    const { getDriveEntityTimestamp } = await syncModule();
    expect(getDriveEntityTimestamp({ modifiedAt: 9, createdAt: 4 })).toBe(9);
    expect(getDriveEntityTimestamp({ modifiedAt: -1, createdAt: 4 })).toBe(4);
    expect(getDriveEntityTimestamp({ modifiedAt: '9', createdAt: Infinity })).toBe(0);
    expect(getDriveEntityTimestamp(null)).toBe(0);
    expect(getDriveEntityTimestamp({ modifiedAt: MAX_TIMESTAMP })).toBe(MAX_TIMESTAMP);
  });

  test('normalizes tombstones only through the stricter ceiling', async () => {
    const { normalizeDriveTombstone } = await syncModule();
    expect(normalizeDriveTombstone(0)).toBe(0);
    expect(normalizeDriveTombstone(MAX_TOMBSTONE)).toBe(MAX_TOMBSTONE);
    for (const value of [-1, 1.5, '1', NaN, Infinity, MAX_TIMESTAMP, null]) {
      expect(normalizeDriveTombstone(value)).toBe(0);
    }
  });

  test('remote migration accepts exact timestamp ceilings and rejects malformed timestamps', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    expect(() => migrateDriveSyncDocument(v2({
      sessions: [session('max', MAX_TIMESTAMP)],
      tombstones: { sessions: { max: MAX_TOMBSTONE }, manualGroups: {} },
    }))).not.toThrow();

    for (const value of [-1, 1.5, '1', NaN, Infinity, MAX_TIMESTAMP + 1]) {
      expect(() => migrateDriveSyncDocument(v2({ sessions: [session('bad', 1, { modifiedAt: value })] }))).toThrow();
      expect(() => migrateDriveSyncDocument(v2({ tombstones: { sessions: { bad: value }, manualGroups: {} } }))).toThrow();
    }
  });

  test('chooses newer sessions and groups independent of operand order', async () => {
    const { mergeDriveSyncDocuments } = await syncModule();
    const left = v2({
      sessions: [session('s', 1, { name: 'old' })],
      manualGroups: { g: group('old', 1) },
    });
    const right = v2({
      sessions: [session('s', 2, { name: 'new' })],
      manualGroups: { g: group('new', 2) },
    });
    for (const merged of [mergeDriveSyncDocuments(left, right), mergeDriveSyncDocuments(right, left)]) {
      expect(merged.sessions[0].name).toBe('new');
      expect(merged.manualGroups.g.name).toBe('new');
    }
  });

  test('takes greatest tombstones, deletes on equality, and retains them after newer updates', async () => {
    const { mergeDriveSyncDocuments } = await syncModule();
    const left = v2({
      sessions: [session('equal', 5), session('newer', 7)],
      manualGroups: { equal: group('equal', 4), newer: group('newer', 9) },
      tombstones: { sessions: { equal: 3, newer: 6 }, manualGroups: { equal: 4, newer: 8 } },
    });
    const right = v2({
      tombstones: { sessions: { equal: 5, newer: 4 }, manualGroups: { equal: 2, newer: 5 } },
    });
    const merged = mergeDriveSyncDocuments(left, right);
    expect(merged.sessions.map(({ id }) => id)).toEqual(['newer']);
    expect(Object.keys(merged.manualGroups)).toEqual(['newer']);
    expect(merged.tombstones.sessions).toEqual({ equal: 5, newer: 6 });
    expect(merged.tombstones.manualGroups).toEqual({ equal: 4, newer: 8 });
  });

  test('distinguishes an absent tombstone from an explicit zero tombstone', async () => {
    const { mergeDriveSyncDocuments } = await syncModule();
    const entity = session('epoch', 0);
    const withoutTombstone = mergeDriveSyncDocuments(v2({ sessions: [entity] }), v2());
    const withZeroTombstone = mergeDriveSyncDocuments(
      v2({ sessions: [entity] }),
      v2({ tombstones: { sessions: { epoch: 0 }, manualGroups: {} } }),
    );
    expect(withoutTombstone.sessions.map(({ id }) => id)).toEqual(['epoch']);
    expect(withZeroTombstone.sessions).toEqual([]);
    expect(withZeroTombstone.tombstones.sessions.epoch).toBe(0);
  });

  test('resolves equal timestamp content conflicts by recursively sorted lexical serialization', async () => {
    const { mergeDriveSyncDocuments } = await syncModule();
    const alpha = session('same', 5, { name: 'Alpha', metadata: { z: 1, a: 2 } });
    const zulu = session('same', 5, { name: 'Zulu', metadata: { a: 2, z: 1 } });
    const groupAlpha = group('Alpha', 5, { metadata: { z: 1, a: 2 } });
    const groupZulu = group('Zulu', 5, { metadata: { a: 2, z: 1 } });
    const left = v2({ sessions: [alpha], manualGroups: { same: groupAlpha } });
    const right = v2({ sessions: [zulu], manualGroups: { same: groupZulu } });

    const leftRight = mergeDriveSyncDocuments(left, right);
    const rightLeft = mergeDriveSyncDocuments(right, left);
    expect(leftRight.sessions[0].name).toBe('Zulu');
    expect(leftRight.manualGroups.same.name).toBe('Zulu');
    expect(JSON.stringify(leftRight)).toBe(JSON.stringify(rightLeft));
  });

  test('uses JavaScript lexical comparison rather than locale-sensitive ordering for ties', async () => {
    const { mergeDriveSyncDocuments } = await syncModule();
    const upper = session('case', 5, { name: 'Z' });
    const lower = session('case', 5, { name: 'a' });
    const upperBytes = JSON.stringify(upper, Object.keys(upper).sort());
    const lowerBytes = JSON.stringify(lower, Object.keys(lower).sort());
    expect(lowerBytes > upperBytes).toBeTrue();
    for (const merged of [
      mergeDriveSyncDocuments(v2({ sessions: [upper] }), v2({ sessions: [lower] })),
      mergeDriveSyncDocuments(v2({ sessions: [lower] }), v2({ sessions: [upper] })),
    ]) {
      expect(merged.sessions[0].name).toBe('a');
    }
  });

  test('canonicalizes nested property order for identical and uniquely newer winners', async () => {
    const { mergeDriveSyncDocuments } = await syncModule();
    const leftMetadata = {};
    leftMetadata.z = 1;
    leftMetadata.a = 2;
    const rightMetadata = {};
    rightMetadata.a = 2;
    rightMetadata.z = 1;
    const unsortedWinner = session('winner', 9, { metadata: leftMetadata });
    const logicallySameLeft = session('same', 5, { metadata: leftMetadata });
    const logicallySameRight = session('same', 5, { metadata: rightMetadata });
    const groupWinner = group('Winner', 9, { metadata: leftMetadata });
    const groupSameLeft = group('Same', 5, { metadata: leftMetadata });
    const groupSameRight = group('Same', 5, { metadata: rightMetadata });
    const merged = mergeDriveSyncDocuments(
      v2({
        sessions: [unsortedWinner, logicallySameLeft],
        manualGroups: { winner: groupWinner, same: groupSameLeft },
      }),
      v2({
        sessions: [session('winner', 1), logicallySameRight],
        manualGroups: { winner: group('Old', 1), same: groupSameRight },
      }),
    );
    const winner = merged.sessions.find(({ id }) => id === 'winner');
    const same = merged.sessions.find(({ id }) => id === 'same');
    expect(Object.keys(winner)).toEqual([...Object.keys(winner)].sort());
    expect(Object.keys(winner.metadata)).toEqual(['a', 'z']);
    expect(Object.keys(same.metadata)).toEqual(['a', 'z']);
    expect(Object.keys(merged.manualGroups.winner)).toEqual([...Object.keys(merged.manualGroups.winner)].sort());
    expect(Object.keys(merged.manualGroups.winner.metadata)).toEqual(['a', 'z']);
    expect(Object.keys(merged.manualGroups.same.metadata)).toEqual(['a', 'z']);
    expect(JSON.stringify(merged)).toBe(JSON.stringify(mergeDriveSyncDocuments(
      v2({
        sessions: [session('winner', 1), logicallySameRight],
        manualGroups: { winner: group('Old', 1), same: groupSameRight },
      }),
      v2({
        sessions: [unsortedWinner, logicallySameLeft],
        manualGroups: { winner: groupWinner, same: groupSameLeft },
      }),
    )));
  });

  test('sorts sessions and every map lexically for byte-identical output', async () => {
    const { mergeDriveSyncDocuments } = await syncModule();
    const left = v2({
      sessions: [session('z', 2, { createdAt: 10 }), session('a', 2, { createdAt: 10 })],
      manualGroups: { z: group('Z'), a: group('A') },
      tombstones: { sessions: { zed: 1, alpha: 1 }, manualGroups: { zed: 2, alpha: 2 } },
    });
    const right = v2({ sessions: [session('top', 3, { createdAt: 20 })] });
    const merged = mergeDriveSyncDocuments(left, right);
    expect(merged.sessions.map(({ id }) => id)).toEqual(['top', 'a', 'z']);
    expect(Object.keys(merged.manualGroups)).toEqual(['a', 'z']);
    expect(Object.keys(merged.tombstones.sessions)).toEqual(['alpha', 'zed']);
    expect(Object.keys(merged.tombstones.manualGroups)).toEqual(['alpha', 'zed']);
    expect(JSON.stringify(merged)).toBe(JSON.stringify(mergeDriveSyncDocuments(right, left)));
  });
});

describe('Drive sync resource boundaries', () => {
  test('accepts exact entity limits and rejects max plus one', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const sessionsAtMax = Array.from({ length: MAX_ENTITIES }, (_, index) => session(`s-${index}`));
    const groupsAtMax = repeatedMap(MAX_ENTITIES, (index) => group(`g-${index}`));
    expect(migrateDriveSyncDocument(v2({ sessions: sessionsAtMax })).sessions).toHaveLength(MAX_ENTITIES);
    expect(Object.keys(migrateDriveSyncDocument(v2({ manualGroups: groupsAtMax })).manualGroups)).toHaveLength(MAX_ENTITIES);
    expect(() => migrateDriveSyncDocument(v2({ sessions: [...sessionsAtMax, session('overflow')] }))).toThrow(/10,?000|limit/i);
    groupsAtMax.overflow = group('overflow');
    expect(() => migrateDriveSyncDocument(v2({ manualGroups: groupsAtMax }))).toThrow(/10,?000|limit/i);
  });

  test('accepts exact tombstone limits per kind and rejects max plus one', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const sessionTombstones = repeatedMap(MAX_TOMBSTONES, () => 1);
    const groupTombstones = repeatedMap(MAX_TOMBSTONES, () => 2);
    expect(Object.keys(migrateDriveSyncDocument(v2({
      tombstones: { sessions: sessionTombstones, manualGroups: groupTombstones },
    })).tombstones.sessions)).toHaveLength(MAX_TOMBSTONES);
    sessionTombstones.overflow = 1;
    expect(() => migrateDriveSyncDocument(v2({
      tombstones: { sessions: sessionTombstones, manualGroups: {} },
    }))).toThrow(/10,?000|limit/i);
    groupTombstones.overflow = 2;
    expect(() => migrateDriveSyncDocument(v2({
      tombstones: { sessions: {}, manualGroups: groupTombstones },
    }))).toThrow(/10,?000|limit/i);
  });

  test('counts split session windows against one per-entity tab cap', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const windowsAtMax = [
      { tabs: Array.from({ length: 6_000 }, (_, i) => ({ url: `https://a.test/${i}` })) },
      { tabs: Array.from({ length: 4_000 }, (_, i) => ({ url: `https://b.test/${i}` })) },
    ];
    expect(() => migrateDriveSyncDocument(v2({ sessions: [session('max', 1, { windows: windowsAtMax })] }))).not.toThrow();
    windowsAtMax[1].tabs.push({ url: 'https://overflow.test/' });
    expect(() => migrateDriveSyncDocument(v2({ sessions: [session('overflow', 1, { windows: windowsAtMax })] }))).toThrow(/tab|10,?000|limit/i);
  });

  test('preserves and counts legacy flat session tabs against the same caps', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const tabs = Array.from({ length: MAX_TABS_PER_ENTITY }, (_, i) => ({ url: `https://legacy.test/${i}` }));
    const legacy = { id: 'legacy', createdAt: 1, modifiedAt: 1, tabs };
    const migrated = migrateDriveSyncDocument({ version: 1, sessions: [legacy], manualGroups: {} });
    expect(migrated.sessions[0].tabs).toHaveLength(MAX_TABS_PER_ENTITY);
    expect(() => migrateDriveSyncDocument({
      version: 1,
      sessions: [{ ...legacy, tabs: [...tabs, { url: 'https://overflow.test/' }] }],
      manualGroups: {},
    })).toThrow(/tab|10,?000|limit/i);
  });

  test('counts flat and window tabs together for per-entity and total budgets', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const combined = session('combined', 1, {
      tabs: Array.from({ length: 6_000 }, (_, i) => ({ url: `https://flat.test/${i}` })),
      windows: [{ tabs: Array.from({ length: 4_000 }, (_, i) => ({ url: `https://window.test/${i}` })) }],
    });
    expect(() => migrateDriveSyncDocument(v2({ sessions: [combined] }))).not.toThrow();
    expect(() => migrateDriveSyncDocument(v2({
      sessions: [{ ...combined, windows: [{ tabs: [...combined.windows[0].tabs, { url: 'https://overflow.test/' }] }] }],
    }))).toThrow(/tab|10,?000|limit/i);

    const otherSessions = Array.from({ length: 9 }, (_, sessionIndex) => session(`other-${sessionIndex}`, 1, {
      windows: [{ tabs: Array.from({ length: 10_000 }, (_, tabIndex) => ({ url: `https://other.test/${sessionIndex}/${tabIndex}` })) }],
    }));
    expect(() => migrateDriveSyncDocument(v2({ sessions: [...otherSessions, combined] }))).not.toThrow();
    expect(() => migrateDriveSyncDocument(v2({
      sessions: [...otherSessions, combined],
      manualGroups: { overflow: group('overflow', 1, { tabUrls: ['https://overflow.test/'] }) },
    }))).toThrow(/100,?000|total|limit/i);
  });

  test('enforces the per-group URL cap at max and max plus one', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const tabUrls = Array.from({ length: MAX_TABS_PER_ENTITY }, (_, i) => `https://g.test/${i}`);
    expect(() => migrateDriveSyncDocument(v2({ manualGroups: { max: group('max', 1, { tabUrls }) } }))).not.toThrow();
    expect(() => migrateDriveSyncDocument(v2({ manualGroups: { overflow: group('overflow', 1, { tabUrls: [...tabUrls, 'https://overflow.test/'] }) } }))).toThrow(/url|10,?000|limit/i);
  });

  test('enforces the combined total tab and URL cap at max and max plus one', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const sessions = Array.from({ length: 10 }, (_, sessionIndex) => session(`s-${sessionIndex}`, 1, {
      windows: [{ tabs: Array.from({ length: 10_000 }, (_, tabIndex) => ({ url: `https://t.test/${sessionIndex}/${tabIndex}` })) }],
    }));
    expect(() => migrateDriveSyncDocument(v2({ sessions }))).not.toThrow();
    expect(() => migrateDriveSyncDocument(v2({
      sessions,
      manualGroups: { overflow: group('overflow', 1, { tabUrls: ['https://overflow.test/'] }) },
    }))).toThrow(/100,?000|total|limit/i);
  });

  test('accepts exact string and key lengths and rejects max plus one', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    const exact = 'x'.repeat(MAX_STRING);
    const tooLong = `${exact}x`;
    expect(() => migrateDriveSyncDocument(v2({ sessions: [session('s', 1, { name: exact })] }))).not.toThrow();
    expect(() => migrateDriveSyncDocument(v2({ sessions: [session('s', 1, { name: tooLong })] }))).toThrow(/string|length/i);
    expect(() => migrateDriveSyncDocument(v2({ manualGroups: { [exact]: group('exact') } }))).not.toThrow();
    expect(() => migrateDriveSyncDocument(v2({ manualGroups: { [tooLong]: group('long') } }))).toThrow(/key|length/i);
  });

  test('accepts values through root depth 12 and rejects depth 13', async () => {
    const { migrateDriveSyncDocument } = await syncModule();
    expect(() => migrateDriveSyncDocument(v2({
      sessions: [session('depth-12', 1, { metadata: nestedValue(9) })],
    }))).not.toThrow();
    expect(() => migrateDriveSyncDocument(v2({
      sessions: [session('depth-13', 1, { metadata: nestedValue(10) })],
    }))).toThrow(/depth|nest/i);
  });
});

describe('atomic local Drive reconciliation', () => {
  test('Storage multi-key helpers each use exactly one Chrome call', async () => {
    const harness = installChromeMock({ local: { a: 1, b: 2, c: 3 } });
    await expect(Storage.getMany(['a', 'b'])).resolves.toEqual({ a: 1, b: 2 });
    await Storage.setMany({ a: 4, b: 5 });
    await Storage.removeMany(['a', 'b']);
    expect(harness.calls.storage.local.get).toEqual([[['a', 'b']]]);
    expect(harness.calls.storage.local.set).toEqual([[{ a: 4, b: 5 }]]);
    expect(harness.calls.storage.local.remove).toEqual([[['a', 'b']]]);
  });

  test('reads local state in one snapshot and writes it in one three-key commit', async () => {
    const { readLocalDriveSyncDocument, writeLocalDriveSyncDocument } = await syncModule();
    const harness = installChromeMock({
      local: {
        sessions: [session('local')],
        manualGroups: { local: group('Local') },
        driveSyncTombstones: { sessions: { deleted: 2 }, manualGroups: {} },
      },
    });
    const document = await readLocalDriveSyncDocument();
    expect(document.version).toBe(2);
    expect(harness.calls.storage.local.get).toEqual([[['sessions', 'manualGroups', 'driveSyncTombstones']]]);

    await writeLocalDriveSyncDocument(document);
    expect(harness.calls.storage.local.set).toEqual([[
      {
        sessions: document.sessions,
        manualGroups: document.manualGroups,
        driveSyncTombstones: document.tombstones,
      },
    ]]);
  });

  test('defensively normalizes malformed local timestamps while remote migration stays strict', async () => {
    const { readLocalDriveSyncDocument, migrateDriveSyncDocument, getDriveEntityTimestamp } = await syncModule();
    installChromeMock({
      local: {
        sessions: [session('local', 5, { modifiedAt: 'corrupt', createdAt: 5 })],
        manualGroups: { local: group('Local', 7, { modifiedAt: Infinity, createdAt: 7 }) },
        driveSyncTombstones: { sessions: { local: 'corrupt' }, manualGroups: {} },
      },
    });
    const local = await readLocalDriveSyncDocument();
    expect(getDriveEntityTimestamp(local.sessions[0])).toBe(5);
    expect(getDriveEntityTimestamp(local.manualGroups.local)).toBe(7);
    expect(Object.hasOwn(local.sessions[0], 'modifiedAt')).toBeFalse();
    expect(Object.hasOwn(local.manualGroups.local, 'modifiedAt')).toBeFalse();
    expect(local.tombstones.sessions.local).toBe(0);

    expect(() => migrateDriveSyncDocument(v2({
      sessions: [session('remote', 5, { modifiedAt: 'corrupt', createdAt: 5 })],
    }))).toThrow(/timestamp/i);
  });

  test('remote rejection performs zero local writes and preserves local bytes', async () => {
    const { reconcileDriveSync } = await syncModule();
    const initial = {
      sessions: [session('local')],
      manualGroups: { local: group('Local') },
      driveSyncTombstones: { sessions: {}, manualGroups: {} },
    };
    const harness = installChromeMock({ local: initial });
    const before = JSON.stringify(harness.snapshot().local);
    await expect(reconcileDriveSync(v2({ sessions: [session('remote')] }), async () => {
      throw new Error('remote unavailable');
    })).rejects.toThrow('remote unavailable');
    expect(harness.calls.storage.local.set).toEqual([]);
    expect(JSON.stringify(harness.snapshot().local)).toBe(before);
  });

  test('successful reconciliation writes remote before one atomic local commit', async () => {
    const { reconcileDriveSync } = await syncModule();
    const order = [];
    const harness = installChromeMock({ local: { sessions: [session('local')] } });
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (values) => {
      order.push('local');
      return originalSet(values);
    };
    const merged = await reconcileDriveSync(v2({ sessions: [session('remote')] }), async (document) => {
      order.push('remote');
      expect(document.version).toBe(2);
    });
    expect(order).toEqual(['remote', 'local']);
    expect(merged.sessions.map(({ id }) => id).sort()).toEqual(['local', 'remote']);
    expect(harness.calls.storage.local.set).toHaveLength(1);
    expect(Object.keys(harness.calls.storage.local.set[0][0]).sort()).toEqual([
      'driveSyncTombstones', 'manualGroups', 'sessions',
    ]);
  });

  test('a failed local commit changes no keys and retry converges to identical bytes', async () => {
    const { reconcileDriveSync } = await syncModule();
    const initial = {
      sessions: [session('local')],
      manualGroups: { local: group('Local') },
      driveSyncTombstones: { sessions: {}, manualGroups: {} },
    };
    const harness = installChromeMock({
      local: initial,
      failures: { 'storage.local.set': new Error('quota failure') },
    });
    let remoteBytes = '';
    const remote = v2({ sessions: [session('remote')] });
    await expect(reconcileDriveSync(remote, async (document) => {
      remoteBytes = JSON.stringify(document);
    })).rejects.toThrow('quota failure');
    expect(harness.snapshot().local).toEqual(initial);

    const retried = await reconcileDriveSync(JSON.parse(remoteBytes), async (document) => {
      expect(JSON.stringify(document)).toBe(remoteBytes);
    });
    expect(JSON.stringify(retried)).toBe(remoteBytes);
    expect(harness.snapshot().local.sessions.map(({ id }) => id).sort()).toEqual(['local', 'remote']);
  });
});

describe('bounded production Drive JSON reads', () => {
  test('rejects an oversized Content-Length before body consumption', async () => {
    const originalFetch = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = async () => fakeResponse({
      contentLength: MAX_BYTES + 1,
      chunks: [new TextEncoder().encode('{}')],
      onRead: () => { reads += 1; },
    });
    try {
      const { readSyncFile } = await freshDriveClient('header');
      await expect(readSyncFile('sync-file')).rejects.toThrow(/large|limit|25/i);
      expect(reads).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects dishonest streamed length by actual bytes and cancels the reader', async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = 0;
    const chunk = new Uint8Array(MAX_BYTES);
    globalThis.fetch = async () => fakeResponse({
      contentLength: 2,
      chunks: [chunk, new Uint8Array([1])],
      onCancel: () => { cancelled += 1; },
    });
    try {
      const { readSyncFile } = await freshDriveClient('stream-overflow');
      await expect(readSyncFile('sync-file')).rejects.toThrow(/large|limit|25/i);
      expect(cancelled).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('bounds text fallback by UTF-8 bytes including multibyte content', async () => {
    const originalFetch = globalThis.fetch;
    const multibyte = `"${'😀'.repeat(Math.floor(MAX_BYTES / 4))}"`;
    globalThis.fetch = async () => fakeResponse({ text: async () => multibyte });
    try {
      const { readDriveExport } = await freshDriveClient('text-overflow');
      await expect(readDriveExport('export-file')).rejects.toThrow(/large|limit|25/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('bounds arrayBuffer fallback before decoding and parsing', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => fakeResponse({
      arrayBuffer: async () => new Uint8Array(MAX_BYTES + 1).buffer,
    });
    try {
      const { readSyncFile } = await freshDriveClient('array-buffer-overflow');
      await expect(readSyncFile('sync-file')).rejects.toThrow(/large|limit|25/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects invalid JSON without calling response.json()', async () => {
    const originalFetch = globalThis.fetch;
    let jsonCalls = 0;
    globalThis.fetch = async () => fakeResponse({
      chunks: [new TextEncoder().encode('{invalid')],
      json: () => {
        jsonCalls += 1;
        throw new Error('legacy parser invoked');
      },
    });
    try {
      const { readSyncFile } = await freshDriveClient('invalid-json');
      await expect(readSyncFile('sync-file')).rejects.toThrow('Drive JSON is invalid');
      expect(jsonCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects malformed Content-Length before body consumption', async () => {
    const originalFetch = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = async () => fakeResponse({
      contentLength: '12oops',
      chunks: [new TextEncoder().encode('{}')],
      onRead: () => { reads += 1; },
    });
    try {
      const { readSyncFile } = await freshDriveClient('invalid-header');
      await expect(readSyncFile('sync-file')).rejects.toThrow(/Content-Length/i);
      expect(reads).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns under-limit sync, settings, and export JSON through bounded paths', async () => {
    const originalFetch = globalThis.fetch;
    const payloads = [
      v2(),
      { settings: {}, savedAt: 0, version: 1 },
      { portable: true },
    ];
    let index = 0;
    globalThis.fetch = async () => fakeResponse({
      chunks: [new TextEncoder().encode(JSON.stringify(payloads[index++]))],
    });
    try {
      const client = await freshDriveClient('under-limit');
      const { SETTINGS_DEFAULTS } = await import('../../core/settings.js');
      await expect(client.readSyncFile('sync-file')).resolves.toEqual(payloads[0]);
      await expect(client.readSettingsFile('settings-file')).resolves.toEqual({
        settings: SETTINGS_DEFAULTS, savedAt: 0, version: 1,
      });
      await expect(client.readDriveExport('export-file')).resolves.toEqual(payloads[2]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('cross-profile settings also use bounded parsing', async () => {
    const originalFetch = globalThis.fetch;
    let request = 0;
    globalThis.fetch = async () => {
      request += 1;
      if (request === 1) {
        return new Response(JSON.stringify({ files: [{ id: 'settings-file', name: 'tabkebab-settings.json' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return fakeResponse({
        chunks: [new TextEncoder().encode(JSON.stringify({ settings: {}, version: 1 }))],
      });
    };
    try {
      const { readSettingsFromProfile } = await freshDriveClient('cross-profile');
      const { SETTINGS_DEFAULTS } = await import('../../core/settings.js');
      await expect(readSettingsFromProfile('profile-folder')).resolves.toEqual({
        settings: SETTINGS_DEFAULTS, version: 1,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
