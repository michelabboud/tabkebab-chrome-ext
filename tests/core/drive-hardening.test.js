// Regression tests for the WS3 Drive sync / retention / import hardening.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import * as DriveSync from '../../core/drive-sync.js';
import * as Sessions from '../../core/sessions.js';

const {
  DRIVE_TOMBSTONE_TTL_MS,
  MAX_DRIVE_TOMBSTONES_PER_KIND,
  MAX_DRIVE_ENTITIES_PER_KIND,
  mergeDriveSyncDocuments,
  migrateDriveSyncDocument,
  reconcileDriveSync,
  recordDeletionTombstones,
  repairDriveSyncDocument,
} = DriveSync;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-08T00:00:00.000Z');

let importNonce = 0;
async function freshDriveClient(label) {
  return import(`../../core/drive-client.js?ws3=${label}-${++importNonce}`);
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

function v2(overrides = {}) {
  return {
    version: 2,
    sessions: [],
    manualGroups: {},
    tombstones: { sessions: {}, manualGroups: {} },
    ...overrides,
  };
}

function tombstoneMap(count, timestampFor, prefix = 'id') {
  const map = {};
  for (let index = 0; index < count; index += 1) map[`${prefix}-${index}`] = timestampFor(index);
  return map;
}

// ── 3.1 tombstone bounding ───────────────────────────

describe('3.1 tombstone TTL and cap', () => {
  test('recording a deletion expires tombstones older than the TTL', () => {
    const current = {
      sessions: {
        expired: NOW - DRIVE_TOMBSTONE_TTL_MS - 1,
        boundary: NOW - DRIVE_TOMBSTONE_TTL_MS,
        young: NOW - DAY_MS,
      },
      manualGroups: { expiredGroup: NOW - DRIVE_TOMBSTONE_TTL_MS - 1, youngGroup: NOW - 1 },
    };
    const { nextTombstones } = recordDeletionTombstones(current, 'sessions', [{ id: 'new', entity: null }], NOW);
    expect(Object.keys(nextTombstones.sessions).sort()).toEqual(['boundary', 'new', 'young']);
    expect(Object.keys(nextTombstones.manualGroups)).toEqual(['youngGroup']);
  });

  test('a full tombstone map never blocks deletes: the oldest entries are evicted', () => {
    const full = tombstoneMap(MAX_DRIVE_TOMBSTONES_PER_KIND, (index) => NOW - DAY_MS + index);
    const entries = [{ id: 'a', entity: null }, { id: 'b', entity: null }];
    const { nextTombstones } = recordDeletionTombstones({ sessions: full, manualGroups: {} }, 'sessions', entries, NOW);
    const ids = Object.keys(nextTombstones.sessions);
    expect(ids).toHaveLength(MAX_DRIVE_TOMBSTONES_PER_KIND);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).not.toContain('id-0');
    expect(ids).not.toContain('id-1');
    expect(ids).toContain('id-2');
  });

  test('deleteSessions stays bounded under years of auto-save rotation', async () => {
    // 10,000 tombstones spread over 400 days, as an unpruned client would leave.
    const legacy = tombstoneMap(
      MAX_DRIVE_TOMBSTONES_PER_KIND,
      (index) => NOW - Math.floor((index / MAX_DRIVE_TOMBSTONES_PER_KIND) * 400 * DAY_MS),
      'old',
    );
    const harness = installChromeMock({
      local: {
        sessions: [session('auto-1', NOW - 2 * DAY_MS)],
        driveSyncTombstones: { sessions: legacy, manualGroups: {} },
      },
    });
    await expect(Sessions.deleteSessions(['auto-1'], NOW)).resolves.toMatchObject({ deletedIds: ['auto-1'] });
    const stored = harness.snapshot().local.driveSyncTombstones.sessions;
    expect(stored['auto-1']).toBe(NOW);
    const count = Object.keys(stored).length;
    expect(count).toBeLessThan(MAX_DRIVE_TOMBSTONES_PER_KIND * 0.5);
    for (const value of Object.values(stored)) {
      expect(value).toBeGreaterThanOrEqual(NOW - DRIVE_TOMBSTONE_TTL_MS);
    }
  });

  test('merge applies tombstones before expiring them and caps the union to the newest', () => {
    const left = v2({
      sessions: [session('deleted-long-ago', 5)],
      tombstones: {
        sessions: { 'deleted-long-ago': 10, ...tombstoneMap(6_000, (i) => NOW - i, 'left') },
        manualGroups: {},
      },
    });
    const right = v2({
      tombstones: { sessions: tombstoneMap(6_000, (i) => NOW - 10_000 - i, 'right'), manualGroups: {} },
    });
    const merged = mergeDriveSyncDocuments(left, right, { now: NOW });
    // The expired tombstone still suppressed its entity in this merge.
    expect(merged.sessions).toEqual([]);
    expect(Object.hasOwn(merged.tombstones.sessions, 'deleted-long-ago')).toBeFalse();
    const ids = Object.keys(merged.tombstones.sessions);
    expect(ids).toHaveLength(MAX_DRIVE_TOMBSTONES_PER_KIND);
    expect(ids.filter((id) => id.startsWith('left-'))).toHaveLength(6_000);
    expect(() => migrateDriveSyncDocument(merged)).not.toThrow();
    // Commutative.
    expect(JSON.stringify(mergeDriveSyncDocuments(right, left, { now: NOW }))).toBe(JSON.stringify(merged));
  });

  test('repairs an over-cap remote document instead of failing every sync', async () => {
    const overflow = tombstoneMap(MAX_DRIVE_TOMBSTONES_PER_KIND + 50, (i) => NOW - i, 'r');
    const remote = v2({ tombstones: { sessions: overflow, manualGroups: {} } });
    expect(() => migrateDriveSyncDocument(remote)).toThrow(/limit/i);

    installChromeMock({ local: { sessions: [session('local', NOW)] } });
    const uploads = [];
    const merged = await reconcileDriveSync(remote, async (document) => { uploads.push(document); }, { now: NOW });
    expect(uploads).toHaveLength(1);
    expect(Object.keys(uploads[0].tombstones.sessions)).toHaveLength(MAX_DRIVE_TOMBSTONES_PER_KIND);
    expect(Object.hasOwn(uploads[0].tombstones.sessions, 'r-0')).toBeTrue();
    expect(merged.sessions.map(({ id }) => id)).toEqual(['local']);
  });

  test('repair leaves otherwise-corrupt remote documents failing closed', () => {
    const overflow = tombstoneMap(MAX_DRIVE_TOMBSTONES_PER_KIND + 1, () => 1);
    overflow.bad = 'not-a-timestamp';
    const remote = v2({ tombstones: { sessions: overflow, manualGroups: {} } });
    expect(repairDriveSyncDocument(remote, { now: NOW })).toBe(remote);
    expect(() => migrateDriveSyncDocument(repairDriveSyncDocument(remote, { now: NOW }))).toThrow();
  });

  test('never uploads a merged document whose live entities exceed the cap', async () => {
    const half = Math.ceil(MAX_DRIVE_ENTITIES_PER_KIND / 2) + 1;
    const localSessions = Array.from({ length: half }, (_, i) => session(`local-${i}`, NOW));
    const remoteSessions = Array.from({ length: half }, (_, i) => session(`remote-${i}`, NOW));
    const harness = installChromeMock({ local: { sessions: localSessions } });
    let uploads = 0;
    await expect(reconcileDriveSync(v2({ sessions: remoteSessions }), async () => { uploads += 1; }, { now: NOW }))
      .rejects.toThrow(/limit/i);
    expect(uploads).toBe(0);
    expect(harness.snapshot().local.sessions).toHaveLength(half);
  });
});

// ── Drive client fetch harness ───────────────────────

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const FOLDER_IDS = {
  TabKebab: 'root-id',
  Profile: 'profile-id',
  sessions: 'sessions-id',
  stashes: 'stashes-id',
  bookmarks: 'bookmarks-id',
  archive: 'archive-id',
};

let originalFetch;
let originalWarn;
let calls;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalWarn = console.warn;
  console.warn = () => {};
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

/**
 * Route Drive calls. `handle` may return a Response to override; otherwise
 * folder lookups resolve from FOLDER_IDS minus `missingFolders`.
 */
function installFetch({ handle = () => null, missingFolders = new Set() } = {}) {
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || 'GET';
    const call = { url, method, body: options.body };
    calls.push(call);
    const override = await handle(call);
    if (override) return override;
    const query = url.searchParams.get('q') || '';
    const name = query.match(/name='([^']+)'/)?.[1];
    if (method === 'GET' && name && query.includes('vnd.google-apps.folder')) {
      if (missingFolders.has(name)) return jsonResponse({ files: [] });
      return jsonResponse({ files: [{ id: FOLDER_IDS[name] || `${name}-id`, name }] });
    }
    if (method === 'GET') return jsonResponse({ files: [] });
    return jsonResponse({ id: 'generic-id' });
  };
}

function posts() {
  return calls.filter(({ method }) => method === 'POST');
}

// ── 3.2 non-idempotent creates ───────────────────────

describe('3.2 create POSTs are not blindly retried', () => {
  test('folder create that 503s but actually succeeded is recovered by lookup, not duplicated', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    let created = false;
    installFetch({
      handle: ({ url, method }) => {
        const name = (url.searchParams.get('q') || '').match(/name='([^']+)'/)?.[1];
        if (method === 'GET' && name === 'sessions') {
          return jsonResponse({ files: created ? [{ id: 'sessions-created', name }] : [] });
        }
        if (method === 'POST' && url.pathname.endsWith('/files')) {
          created = true; // server applied it, then failed the response
          return jsonResponse({}, 503, { 'Retry-After': '0' });
        }
        return null;
      },
    });
    const { getSessionsFolderId } = await freshDriveClient('folder-recover');
    await expect(getSessionsFolderId()).resolves.toBe('sessions-created');
    expect(posts()).toHaveLength(1);
  });

  test('folder create retries only after a lookup confirms it is absent', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    let attempts = 0;
    installFetch({
      missingFolders: new Set(['sessions']),
      handle: ({ url, method }) => {
        if (method === 'POST' && url.pathname.endsWith('/files')) {
          attempts += 1;
          if (attempts === 1) return jsonResponse({}, 500, { 'Retry-After': '0' });
          return jsonResponse({ id: 'sessions-new', name: 'sessions' });
        }
        return null;
      },
    });
    const { getSessionsFolderId } = await freshDriveClient('folder-retry');
    await expect(getSessionsFolderId()).resolves.toBe('sessions-new');
    expect(posts()).toHaveLength(2);
    const firstPost = calls.indexOf(posts()[0]);
    const secondPost = calls.indexOf(posts()[1]);
    const lookupsBetween = calls.slice(firstPost + 1, secondPost)
      .filter(({ method, url }) => method === 'GET' && (url.searchParams.get('q') || '').includes("name='sessions'"));
    expect(lookupsBetween.length).toBeGreaterThanOrEqual(1);
  });

  test('multipart upload that 502s is recovered by lookup and overwritten in place', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    let uploaded = false;
    installFetch({
      handle: ({ url, method }) => {
        const name = (url.searchParams.get('q') || '').match(/name='([^']+)'/)?.[1];
        if (method === 'GET' && name === 'tabkebab-sync.json') {
          return jsonResponse({ files: uploaded ? [{ id: 'sync-id', name }] : [] });
        }
        if (method === 'POST' && url.searchParams.get('uploadType') === 'multipart') {
          uploaded = true;
          return jsonResponse({}, 502, { 'Retry-After': '0' });
        }
        if (method === 'PATCH') return jsonResponse({ id: 'sync-id' });
        return null;
      },
    });
    const { writeSyncFile } = await freshDriveClient('upload-recover');
    await expect(writeSyncFile({ version: 2 })).resolves.toBe('sync-id');
    expect(posts()).toHaveLength(1);
    const patches = calls.filter(({ method }) => method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].url.pathname).toEndWith('/files/sync-id');
    expect(patches[0].url.searchParams.get('uploadType')).toBe('media');
  });

  test('a duplicate sync file resolves to the oldest by createdTime, then ID', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    installFetch({
      handle: ({ url, method }) => {
        const name = (url.searchParams.get('q') || '').match(/name='([^']+)'/)?.[1];
        if (method === 'GET' && name === 'tabkebab-sync.json') {
          expect(url.searchParams.get('fields')).toContain('createdTime');
          return jsonResponse({
            files: [
              { id: 'b-same-time', name, createdTime: '2026-01-01T00:00:00.000Z' },
              { id: 'newer', name, createdTime: '2026-05-01T00:00:00.000Z' },
              { id: 'a-same-time', name, createdTime: '2026-01-01T00:00:00.000Z' },
            ],
          });
        }
        return null;
      },
    });
    const { findSyncFile } = await freshDriveClient('duplicates');
    await expect(findSyncFile()).resolves.toMatchObject({ id: 'a-same-time' });
  });

  test('a create 5xx with Retry-After over 60s is still recovered by lookup', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    let created = false;
    installFetch({
      handle: ({ url, method }) => {
        const name = (url.searchParams.get('q') || '').match(/name='([^']+)'/)?.[1];
        if (method === 'GET' && name === 'sessions') {
          return jsonResponse({ files: created ? [{ id: 'sessions-created', name }] : [] });
        }
        if (method === 'POST' && url.pathname.endsWith('/files')) {
          created = true;
          return jsonResponse({}, 503, { 'Retry-After': '3600' });
        }
        return null;
      },
    });
    const { getSessionsFolderId } = await freshDriveClient('folder-recover-long-retry');
    await expect(getSessionsFolderId()).resolves.toBe('sessions-created');
    expect(posts()).toHaveLength(1);
  });

  test('a create 5xx with Retry-After over 60s is not retried when the lookup finds nothing', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    installFetch({
      missingFolders: new Set(['sessions']),
      handle: ({ url, method }) => {
        if (method === 'POST' && url.pathname.endsWith('/files')) {
          return jsonResponse({}, 503, { 'Retry-After': '3600' });
        }
        return null;
      },
    });
    const { getSessionsFolderId } = await freshDriveClient('folder-long-retry-absent');
    await expect(getSessionsFolderId()).rejects.toThrow(/503.*60s/);
    expect(posts()).toHaveLength(1);
  });

  test('idempotent GETs are still retried on 5xx', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    let failures = 0;
    installFetch({
      handle: ({ url, method }) => {
        if (method === 'GET' && url.searchParams.get('alt') === 'media') {
          if (failures++ === 0) return jsonResponse({}, 503, { 'Retry-After': '0' });
          return jsonResponse({ ok: true });
        }
        return null;
      },
    });
    const { readSyncFile } = await freshDriveClient('get-retry');
    await expect(readSyncFile('file-id')).resolves.toEqual({ ok: true });
    expect(failures).toBe(2);
  });
});

// ── 3.5 Retry-After ──────────────────────────────────

describe('3.5 Retry-After parsing and clamping', () => {
  test('parses delta-seconds and HTTP-date forms', async () => {
    const { parseRetryAfterMs } = await freshDriveClient('parse');
    expect(parseRetryAfterMs('5', NOW)).toBe(5000);
    expect(parseRetryAfterMs(' 0 ', NOW)).toBe(0);
    expect(parseRetryAfterMs(new Date(NOW + 10_000).toUTCString(), NOW)).toBe(10_000);
    expect(parseRetryAfterMs(new Date(NOW - 10_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfterMs('soon', NOW)).toBeNull();
    expect(parseRetryAfterMs(null, NOW)).toBeNull();
    expect(parseRetryAfterMs('-3', NOW)).toBeNull();
  });

  test('an HTTP-date in the past retries immediately instead of sleeping NaN', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    let attempts = 0;
    installFetch({
      handle: ({ url }) => {
        if (url.searchParams.get('alt') === 'media') {
          if (attempts++ === 0) {
            return jsonResponse({}, 429, { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' });
          }
          return jsonResponse({ ok: 1 });
        }
        return null;
      },
    });
    const { readSyncFile } = await freshDriveClient('date-retry');
    const started = Date.now();
    await expect(readSyncFile('file-id')).resolves.toEqual({ ok: 1 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('fails instead of sleeping when the server asks for more than 60s', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    let attempts = 0;
    installFetch({
      handle: ({ url }) => {
        if (url.searchParams.get('alt') === 'media') {
          attempts += 1;
          return jsonResponse({}, 429, { 'Retry-After': '3600' });
        }
        return null;
      },
    });
    const { readSyncFile } = await freshDriveClient('too-long');
    await expect(readSyncFile('file-id')).rejects.toThrow(/429.*60s/);
    expect(attempts).toBe(1);
  });
});

// ── 3.3 trash instead of delete ──────────────────────

describe('3.3 retention moves files to trash', () => {
  test('deleteDriveFile PATCHes trashed:true and never issues DELETE', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    installFetch();
    const { deleteDriveFile } = await freshDriveClient('trash');
    await deleteDriveFile('old-file');
    expect(calls.filter(({ method }) => method === 'DELETE')).toEqual([]);
    const [patch] = calls.filter(({ method }) => method === 'PATCH');
    expect(patch.url.pathname).toEndWith('/files/old-file');
    expect(JSON.parse(patch.body)).toEqual({ trashed: true });
  });
});

// ── 3.6 paginated, validated listings ────────────────

describe('3.6 listDriveProfiles paginates and validates', () => {
  function profilePages(pages) {
    return ({ url, method }) => {
      const query = url.searchParams.get('q') || '';
      if (method === 'GET' && query.startsWith("'root-id' in parents")) {
        return jsonResponse(pages[url.searchParams.get('pageToken') || 'first']);
      }
      return null;
    };
  }

  test('returns every page and filters reserved folders', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    installFetch({
      handle: profilePages({
        first: { files: [{ id: 'p1', name: 'Work' }, { id: 's', name: 'sessions' }], nextPageToken: 'next' },
        next: { files: [{ id: 'p2', name: 'Home' }] },
      }),
    });
    const { listDriveProfiles } = await freshDriveClient('profiles');
    await expect(listDriveProfiles()).resolves.toEqual([
      { id: 'p1', name: 'Work' },
      { id: 'p2', name: 'Home' },
    ]);
  });

  test('rejects invalid entries instead of returning them', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    installFetch({ handle: profilePages({ first: { files: [{ id: 'bad/id', name: 'Evil' }] } }) });
    const { listDriveProfiles } = await freshDriveClient('profiles-invalid');
    await expect(listDriveProfiles()).rejects.toThrow(/invalid/i);
  });

  test('the unused first-page-only listDriveExports helper is removed', async () => {
    const client = await freshDriveClient('exports-removed');
    expect(client.listDriveExports).toBeUndefined();
  });
});
