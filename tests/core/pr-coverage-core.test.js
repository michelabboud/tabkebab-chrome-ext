// PR coverage: boundary and malformed-input cases for core changes in 1.3.0
// (closeTabs partial counts, incognito filtering, AI cache TTL/LRU, restore
// outcome classification, tombstone TTL/cap boundaries, Drive Retry-After and
// bounded JSON reads, NL confirmation threshold and over-broad filters,
// retention guards on settings import).

import { describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';

import { closeTabs, excludeIncognitoTabs, getAllTabs } from '../../core/tabs-api.js';
import { AICache } from '../../core/ai/cache.js';
import { isSettledExceptInvalid } from '../../core/restore-outcome.js';
import {
  DRIVE_TOMBSTONE_TTL_MS,
  MAX_DRIVE_TOMBSTONES_PER_KIND,
  pruneDriveTombstoneMap,
  recordDeletionTombstones,
  repairDriveSyncDocument,
} from '../../core/drive-sync.js';
import {
  MAX_DRIVE_RETRY_AFTER_MS,
  parseRetryAfterMs,
  readBoundedJsonResponse,
} from '../../core/drive-client.js';
import {
  NL_CONFIRM_TAB_THRESHOLD,
  buildNLConfirmation,
  executeNLAction,
  nlActionRequiresConfirmation,
  overBroadFilterReason,
  sanitizeGroupColor,
  sanitizeGroupName,
} from '../../core/nl-executor.js';
import { SETTINGS_DEFAULTS, preserveDriveRetentionGuards } from '../../core/settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-08T00:00:00.000Z');

// ── closeTabs ──

describe('closeTabs input shapes and stale-id recovery', () => {
  function seed(failures = {}) {
    return installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://a.test/' },
        { id: 2, windowId: 1, url: 'https://b.test/' },
        { id: 3, windowId: 1, url: 'https://c.test/', active: true },
      ],
      failures,
    });
  }

  test('accepts a single id and drops null/undefined entries', async () => {
    const harness = seed();
    expect(await closeTabs(1)).toBe(1);
    expect(await closeTabs([null, undefined, 2, undefined])).toBe(1);
    expect(harness.calls.tabs.remove.at(-1)).toEqual([[2]]);
    expect(await closeTabs([null])).toBe(0);
    expect(await closeTabs(undefined)).toBe(0);
    expect(harness.snapshot().tabs.map(({ id }) => id)).toEqual([3]);
  });

  test('a stale id in first position counts nothing before it and retries the rest', async () => {
    const harness = seed();
    expect(await closeTabs([99, 1, 2])).toBe(2);
    expect(harness.snapshot().tabs.map(({ id }) => id)).toEqual([3]);
  });

  test('a missing-tab error without a parsable id retries every id individually', async () => {
    const harness = seed({ 'tabs.remove': [new Error('No tab with id')] });
    expect(await closeTabs([1, 2])).toBe(2);
    expect(harness.calls.tabs.remove.slice(1)).toEqual([[1], [2]]);
  });

  test('a non-missing error during the per-id retry is rethrown', async () => {
    seed({ 'tabs.remove': [new Error('No tab with id: 77'), new Error('Tabs cannot be edited right now')] });
    await expect(closeTabs([77, 1, 2])).rejects.toThrow('Tabs cannot be edited right now');
  });

  test('negative stale ids in the message are parsed', async () => {
    seed({ 'tabs.remove': [new Error('No tab with id: -1.')] });
    expect(await closeTabs([1, -1, 2])).toBe(2);
  });
});

describe('incognito filtering', () => {
  test('excludeIncognitoTabs tolerates malformed input and keeps tabs without the flag', () => {
    expect(excludeIncognitoTabs(null)).toEqual([]);
    expect(excludeIncognitoTabs('tabs')).toEqual([]);
    expect(excludeIncognitoTabs([null, { id: 1 }, { id: 2, incognito: true }, { id: 3, incognito: 'true' }]))
      .toEqual([null, { id: 1 }, { id: 3, incognito: 'true' }]);
  });

  test('getAllTabs with a windowId also honours excludeIncognito', async () => {
    installChromeMock({
      windows: [{ id: 5, incognito: true }],
      tabs: [{ id: 1, windowId: 5, incognito: true }, { id: 2, windowId: 5 }],
    });
    expect((await getAllTabs({ windowId: 5, excludeIncognito: true })).map((t) => t.id)).toEqual([2]);
    expect((await getAllTabs({ windowId: 5 })).map((t) => t.id)).toEqual([1, 2]);
  });
});

// ── AI cache ──

describe('AICache TTL and LRU', () => {
  test('an entry older than 24h is a miss and is deleted', async () => {
    installChromeMock({
      local: {
        aiCache: {
          stale: { response: { text: 'old' }, timestamp: Date.now() - DAY_MS - 1000, accessedAt: Date.now() - DAY_MS - 1000 },
          fresh: { response: { text: 'new' }, timestamp: Date.now(), accessedAt: Date.now() },
        },
      },
    });
    expect(await AICache.get('stale')).toBeNull();
    expect(await AICache.get('missing')).toBeNull();
    const stored = (await chrome.storage.local.get('aiCache')).aiCache;
    expect(Object.keys(stored)).toEqual(['fresh']);
  });

  test('a legacy entry without accessedAt uses its timestamp for the touch interval', async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const harness = installChromeMock({
      local: { aiCache: { legacy: { response: { text: 'x' }, timestamp: twoHoursAgo } } },
    });
    expect(await AICache.get('legacy')).toEqual({ text: 'x' });
    expect(harness.calls.storage.local.set).toHaveLength(1);
    const stored = (await chrome.storage.local.get('aiCache')).aiCache.legacy;
    expect(stored.accessedAt).toBeGreaterThan(twoHoursAgo);
  });

  test('the 201st entry evicts the least recently used one', async () => {
    const base = Date.now() - 60_000;
    const seeded = {};
    for (let i = 0; i < 200; i += 1) {
      seeded[`k${i}`] = { response: { i }, timestamp: base + i, accessedAt: base + i };
    }
    // k0 is the oldest by timestamp but was used recently.
    seeded.k0.accessedAt = Date.now();
    installChromeMock({ local: { aiCache: seeded } });
    await AICache.set('new', { i: 'new' });
    const stored = (await chrome.storage.local.get('aiCache')).aiCache;
    expect(Object.keys(stored)).toHaveLength(200);
    expect(stored.k1).toBeUndefined();
    expect(stored.k0).toBeDefined();
    expect(stored.new).toBeDefined();
  });

  test('a failed write does not wedge the cache lock for later calls', async () => {
    installChromeMock({ failures: { 'storage.local.set': [new Error('QUOTA_BYTES quota exceeded')] } });
    await expect(AICache.set('a', { text: 'a' })).rejects.toThrow('quota');
    await AICache.set('b', { text: 'b' });
    expect(await AICache.get('b')).toEqual({ text: 'b' });
  });
});

// ── Restore outcome ──

describe('isSettledExceptInvalid edge cases', () => {
  const base = { requestedCount: 3, restoredCount: 2, skippedDuplicate: 0, skippedInvalid: 1, errors: [] };

  test('rejects null, missing errors, no invalid entries and unaccounted tabs', () => {
    expect(isSettledExceptInvalid(null)).toBe(false);
    expect(isSettledExceptInvalid({ ...base, errors: undefined })).toBe(false);
    expect(isSettledExceptInvalid({ ...base, restoredCount: 3, skippedInvalid: 0 })).toBe(false);
    expect(isSettledExceptInvalid({ ...base, restoredCount: 1 })).toBe(false);
  });

  test('counts duplicates as settled and coerces numeric strings', () => {
    expect(isSettledExceptInvalid({ ...base, restoredCount: 1, skippedDuplicate: 1 })).toBe(true);
    expect(isSettledExceptInvalid({ ...base, restoredCount: '2', skippedInvalid: '1' })).toBe(true);
    expect(isSettledExceptInvalid({ ...base, restoredCount: 'x' })).toBe(false);
  });
});

// ── Tombstone bounds ──

describe('pruneDriveTombstoneMap boundaries', () => {
  test('an entry exactly at the TTL cutoff is kept; one millisecond older is expired', () => {
    const cutoff = NOW - DRIVE_TOMBSTONE_TTL_MS;
    const result = pruneDriveTombstoneMap({ edge: cutoff, older: cutoff - 1, fresh: NOW }, { cutoff });
    expect(Object.keys(result).sort()).toEqual(['edge', 'fresh']);
    expect(DRIVE_TOMBSTONE_TTL_MS).toBe(180 * DAY_MS);
  });

  test('exactly the cap is kept whole; cap + 1 drops the oldest, ties broken by id', () => {
    const map = {};
    for (let i = 0; i < MAX_DRIVE_TOMBSTONES_PER_KIND; i += 1) map[`id-${i}`] = NOW - i;
    expect(Object.keys(pruneDriveTombstoneMap(map))).toHaveLength(10_000);

    map['id-tie'] = NOW - (MAX_DRIVE_TOMBSTONES_PER_KIND - 1); // ties with id-9999
    const pruned = pruneDriveTombstoneMap(map);
    expect(Object.keys(pruned)).toHaveLength(10_000);
    // Equal timestamps: lexically smaller id wins, so "id-9999" stays and "id-tie" goes.
    expect(pruned['id-9999']).toBeDefined();
    expect(pruned['id-tie']).toBeUndefined();
  });

  test('protected ids survive expiry, count against the cap first, and over-cap protection throws', () => {
    const result = pruneDriveTombstoneMap(
      { keep: 1, a: NOW, b: NOW - 1 },
      { cutoff: NOW - 10, protectedIds: new Set(['keep']), cap: 2 },
    );
    expect(Object.keys(result).sort()).toEqual(['a', 'keep']);
    expect(() => pruneDriveTombstoneMap({ a: 1, b: 2 }, { protectedIds: new Set(['a', 'b']), cap: 1 }))
      .toThrow('Deletion would exceed the 1 tombstone limit');
  });

  test('recording a batch larger than the cap is rejected before any result exists', () => {
    const entries = Array.from({ length: MAX_DRIVE_TOMBSTONES_PER_KIND + 1 }, (_, i) => ({ id: `s-${i}` }));
    expect(() => recordDeletionTombstones({ sessions: {}, manualGroups: {} }, 'sessions', entries, NOW))
      .toThrow('10,000 tombstone limit');
  });

  test('recording a batch exactly at the cap evicts every older tombstone of that kind only', () => {
    const entries = Array.from({ length: MAX_DRIVE_TOMBSTONES_PER_KIND }, (_, i) => ({ id: `s-${i}` }));
    const { nextTombstones } = recordDeletionTombstones(
      { sessions: { old: NOW - 1 }, manualGroups: { g: NOW - 1 } },
      'sessions',
      entries,
      NOW,
    );
    expect(Object.keys(nextTombstones.sessions)).toHaveLength(10_000);
    expect(nextTombstones.sessions.old).toBeUndefined();
    expect(nextTombstones.manualGroups.g).toBe(NOW - 1);
  });

  test('recording expires the other kind by TTL too', () => {
    const { nextTombstones } = recordDeletionTombstones(
      { sessions: {}, manualGroups: { ancient: NOW - DRIVE_TOMBSTONE_TTL_MS - 1, recent: NOW - DAY_MS } },
      'sessions',
      [{ id: 'x' }],
      NOW,
    );
    expect(Object.keys(nextTombstones.manualGroups)).toEqual(['recent']);
  });

  test('repair rejects an invalid clock and leaves documents at or under the cap untouched', () => {
    const atCap = { sessions: {}, manualGroups: {} };
    for (let i = 0; i < MAX_DRIVE_TOMBSTONES_PER_KIND; i += 1) atCap.sessions[`s${i}`] = 1;
    const doc = { version: 2, sessions: [], manualGroups: {}, tombstones: atCap };
    expect(repairDriveSyncDocument(doc, { now: NOW })).toBe(doc);
    expect(repairDriveSyncDocument(null)).toBeNull();
    expect(() => repairDriveSyncDocument(doc, { now: -1 })).toThrow('non-negative safe integer');
    expect(() => repairDriveSyncDocument(doc, { now: 1.5 })).toThrow('non-negative safe integer');
  });

  test('repair skips non-record maps and over-cap maps with dangerous keys', () => {
    const over = Object.create(null);
    for (let i = 0; i <= MAX_DRIVE_TOMBSTONES_PER_KIND; i += 1) over[`s${i}`] = NOW;
    over.__proto__ = NOW;
    const doc = { tombstones: { sessions: over, manualGroups: 'nope' } };
    expect(repairDriveSyncDocument(doc, { now: NOW })).toBe(doc);
  });
});

// ── Drive client pure helpers ──

describe('Drive Retry-After boundaries', () => {
  test('exactly 60s is within the honoured limit; 61s is not', () => {
    expect(MAX_DRIVE_RETRY_AFTER_MS).toBe(60_000);
    expect(parseRetryAfterMs('60', NOW)).toBe(MAX_DRIVE_RETRY_AFTER_MS);
    expect(parseRetryAfterMs('61', NOW)).toBeGreaterThan(MAX_DRIVE_RETRY_AFTER_MS);
    expect(parseRetryAfterMs(new Date(NOW + 60_000).toUTCString(), NOW)).toBe(60_000);
  });

  test('absurd values and non-strings are handled without NaN', () => {
    expect(parseRetryAfterMs('9'.repeat(30), NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(parseRetryAfterMs('   ', NOW)).toBeNull();
    expect(parseRetryAfterMs(30, NOW)).toBeNull();
    expect(parseRetryAfterMs('1.5', NOW)).toBeNull();
    expect(parseRetryAfterMs('Foo, 99 Bar 2026', NOW)).toBeNull();
  });
});

describe('readBoundedJsonResponse body paths', () => {
  test('arrayBuffer and text fallbacks parse JSON', async () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    expect(await readBoundedJsonResponse({ headers: new Headers(), arrayBuffer: async () => bytes.buffer })).toEqual({ a: 1 });
    expect(await readBoundedJsonResponse({ headers: new Headers(), text: async () => '{"b":2}' })).toEqual({ b: 2 });
  });

  test('invalid bodies fail closed', async () => {
    await expect(readBoundedJsonResponse({ headers: new Headers() })).rejects.toThrow('body is unavailable');
    await expect(readBoundedJsonResponse({ headers: new Headers(), arrayBuffer: async () => 'x' })).rejects.toThrow('invalid bytes');
    await expect(readBoundedJsonResponse({ headers: new Headers(), text: async () => 42 })).rejects.toThrow('invalid text');
    let cancelled = false;
    const reader = {
      read: async () => ({ done: false, value: 'not bytes' }),
      cancel: async () => { cancelled = true; },
    };
    await expect(readBoundedJsonResponse({ headers: new Headers(), body: { getReader: () => reader } }))
      .rejects.toThrow('invalid byte chunk');
    expect(cancelled).toBe(true);
  });

  test('a streamed body is reassembled across chunks', async () => {
    const encoded = new TextEncoder().encode('{"stream":true}');
    const chunks = [encoded.slice(0, 5), encoded.slice(5)];
    const reader = {
      read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }),
      cancel: async () => {},
    };
    expect(await readBoundedJsonResponse({ headers: new Headers(), body: { getReader: () => reader } }))
      .toEqual({ stream: true });
  });
});

// ── NL confirmation ──

describe('NL confirmation threshold and over-broad filters', () => {
  const tabsIn = (count, windowId = 1, extra = {}) =>
    Array.from({ length: count }, (_, i) => ({ id: i + 1, windowId, title: `T${i}`, url: `https://x.test/${i}`, ...extra }));

  test('exactly 20 tabs in one window run without confirmation; 21 or two windows need it', () => {
    expect(NL_CONFIRM_TAB_THRESHOLD).toBe(20);
    expect(nlActionRequiresConfirmation('group', tabsIn(20))).toBe(false);
    expect(nlActionRequiresConfirmation('move', tabsIn(21))).toBe(true);
    expect(nlActionRequiresConfirmation('group', [...tabsIn(1, 1), ...tabsIn(1, 2)])).toBe(true);
    expect(nlActionRequiresConfirmation('close', [])).toBe(true);
    expect(nlActionRequiresConfirmation('find', tabsIn(50))).toBe(false);
    expect(nlActionRequiresConfirmation('group', null)).toBe(false);
    // Tabs without a windowId do not inflate the window count.
    expect(nlActionRequiresConfirmation('move', [{ id: 1 }, { id: 2 }])).toBe(false);
  });

  test('over-broad filters: bare TLDs, trivial URL needles, symbol-only titles, match-everything', () => {
    const tooBroad = 'That command is too broad. Please be more specific about which tabs you mean.';
    expect(overBroadFilterReason({ domain: 'com' }, 1, 10)).toBe(tooBroad);
    expect(overBroadFilterReason({ domain: 'localhost' }, 1, 10)).toBeNull();
    expect(overBroadFilterReason({ domain: 'github.com' }, 3, 10)).toBeNull();
    expect(overBroadFilterReason({ urlContains: 'www' }, 1, 10)).toBe(tooBroad);
    expect(overBroadFilterReason({ urlContains: '.com' }, 1, 10)).toBe(tooBroad);
    expect(overBroadFilterReason({ urlContains: 'ab' }, 1, 10)).toBe(tooBroad);
    expect(overBroadFilterReason({ urlContains: '///' }, 1, 10)).toBe(tooBroad);
    expect(overBroadFilterReason({ urlContains: 'docs' }, 1, 10)).toBeNull();
    expect(overBroadFilterReason({ titleContains: 'a' }, 1, 10)).toBe(tooBroad);
    expect(overBroadFilterReason({ titleContains: '!!' }, 1, 10)).toBe(tooBroad);
    expect(overBroadFilterReason({ titleContains: '日本' }, 1, 10)).toBeNull();
    expect(overBroadFilterReason({}, 1, 10)).toBe(tooBroad);
    // Matching every tab is too broad only beyond a trivially small browser.
    expect(overBroadFilterReason({ domain: 'github.com' }, 3, 3)).toBe(tooBroad);
    expect(overBroadFilterReason({ domain: 'github.com' }, 2, 2)).toBeNull();
  });

  test('confirmation text: singular, pinned counts, unknown actions, long and blank titles', () => {
    expect(buildNLConfirmation('close', [{ id: 1, windowId: 1, title: 'One' }])).toBe('Close 1 tab? "One"');
    expect(buildNLConfirmation('close', [{ id: 1, windowId: 1, title: 'P', pinned: true }]))
      .toBe('Close 1 tab (including 1 pinned)? "P"');
    expect(buildNLConfirmation('discard', [{ id: 1, title: '  ', url: 'https://u.test/' }]))
      .toBe('Apply "discard" to 1 tab? "https://u.test/"');
    const long = buildNLConfirmation('move', [{ id: 1, windowId: 1, title: 'x'.repeat(60) }]);
    expect(long).toBe(`Move 1 tab to a new window? "${'x'.repeat(39)}…"`);
    expect(buildNLConfirmation('close', null)).toBe('Close 0 tabs?');
    expect(buildNLConfirmation('move', [{ id: 1 }])).toBe('Move 1 tab to a new window? "Untitled"');
  });

  test('group name/color sanitising edge cases', () => {
    expect(sanitizeGroupColor(' GRAY ')).toBe('grey');
    expect(sanitizeGroupColor('magenta')).toBe('blue');
    expect(sanitizeGroupColor(null)).toBe('blue');
    expect(sanitizeGroupName('\u0000\u0007')).toBe('AI Group');
    expect(sanitizeGroupName(42)).toBe('AI Group');
    expect(sanitizeGroupName('a\nb\tc')).toBe('a b c');
  });

  test('focus, move, find and unknown actions', async () => {
    const harness = installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://a.test/', title: 'A' },
        { id: 2, windowId: 1, url: 'https://b.test/', title: 'B' },
        { id: 3, windowId: 1, url: 'https://c.test/', title: 'C', active: true },
      ],
    });
    expect(await executeNLAction({ action: 'focus' }, [])).toEqual({ error: 'No matching tab found' });
    expect(await executeNLAction({ action: 'focus' }, [{ id: 2 }])).toEqual({ executed: true, message: 'Focused on tab' });
    expect(await executeNLAction({ action: 'move' }, [])).toEqual({ error: 'No tabs to move' });
    expect(await executeNLAction({ action: 'group' }, [{ id: 'x' }])).toEqual({ error: 'No tabs to group' });

    const moved = await executeNLAction({ action: 'move' }, [{ id: 1 }, { id: 2 }]);
    expect(moved).toEqual({ executed: true, message: 'Moved 2 tab(s) to new window' });
    const snapshot = harness.snapshot();
    const windowOf = (id) => snapshot.tabs.find((t) => t.id === id).windowId;
    expect(windowOf(1)).not.toBe(1);
    expect(windowOf(2)).toBe(windowOf(1));

    const found = await executeNLAction({ action: 'find' }, [{ id: 3, title: 'C', url: 'https://c.test/', extra: 'drop' }]);
    expect(found.matchedTabs).toEqual([{ id: 3, title: 'C', url: 'https://c.test/', favIconUrl: undefined }]);
    expect(await executeNLAction({ action: 'explode' }, [])).toEqual({ error: 'Unknown action: explode' });
    expect(await executeNLAction({ action: 'close' }, 'not-an-array')).toEqual({ executed: true, message: 'Closed 0 tab(s)' });
  });
});

// ── Settings import guard ──

describe('preserveDriveRetentionGuards malformed values', () => {
  test('non-integer imported retention falls back to the local value; never mutates inputs', () => {
    const current = { neverDeleteFromDrive: false, driveRetentionDays: 60 };
    const replacement = { driveRetentionDays: '365', neverDeleteFromDrive: false };
    const next = preserveDriveRetentionGuards(current, replacement);
    expect(next.driveRetentionDays).toBe(60);
    expect(replacement.driveRetentionDays).toBe('365');
    expect(preserveDriveRetentionGuards(current, { driveRetentionDays: 60.5 }).driveRetentionDays).toBe(60);
    expect(preserveDriveRetentionGuards(current, { driveRetentionDays: 60 }).driveRetentionDays).toBe(60);
  });

  test('a non-integer local value uses the default floor; a null current is tolerated', () => {
    expect(preserveDriveRetentionGuards({ driveRetentionDays: 'x' }, {}).driveRetentionDays)
      .toBe(SETTINGS_DEFAULTS.driveRetentionDays);
    const next = preserveDriveRetentionGuards(null, { neverDeleteFromDrive: false, driveRetentionDays: 9999 });
    expect(next).toEqual({ neverDeleteFromDrive: false, driveRetentionDays: 9999 });
    // Only a strict `true` locks the never-delete guard on.
    expect(preserveDriveRetentionGuards({ neverDeleteFromDrive: 'yes' }, { neverDeleteFromDrive: false }).neverDeleteFromDrive)
      .toBe(false);
  });
});
