// core/sessions.js — Session save/restore/list/delete (v2: window-aware)

import { getAllTabs } from './tabs-api.js';
import { Storage } from './storage.js';
import {
  restoreTabWindows,
  sanitizeCapturedGroupTitle,
  sanitizeCapturedTab,
} from './tab-restore.js';
import {
  DRIVE_TOMBSTONES_KEY,
  MAX_DRIVE_STRING_LENGTH,
  MAX_DRIVE_TIMESTAMP,
  canonicalizeLocalSessions,
  canonicalizeLocalDriveSyncDocument,
  computeDeletionTombstone,
  emptyDriveTombstones,
  getDriveEntityTimestamp,
  normalizeDriveTombstone,
  recordDeletionTombstones,
} from './drive-sync.js';
import { MAX_CAPTURED_TEXT_LENGTH } from './capture-limits.js';

const DANGEROUS_PORTABLE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function validateSessionId(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DRIVE_STRING_LENGTH ||
    DANGEROUS_PORTABLE_IDS.has(value)
  ) {
    throw new TypeError('Session ID must be a non-empty bounded safe string');
  }
  return value;
}

function isValidEntityTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DRIVE_TIMESTAMP;
}

function sortCanonicalSessions(sessions) {
  return [...sessions].sort((left, right) => {
    const leftCreated = isValidEntityTimestamp(left.createdAt) ? left.createdAt : 0;
    const rightCreated = isValidEntityTimestamp(right.createdAt) ? right.createdAt : 0;
    if (rightCreated !== leftCreated) return rightCreated - leftCreated;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function validateRestoreTimestamp(value) {
  if (!isValidEntityTimestamp(value)) {
    throw new TypeError('Restore timestamp must be a non-negative safe integer');
  }
  return value;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Migrate a v1 session (flat tabs array) to v2 (windows array).
 * Pure function — does not write to storage.
 */
function migrateV1toV2(session) {
  if (session.version === 2 || !session.tabs) return session;

  // Group tabs by windowId
  const windowMap = new Map();
  for (const tab of session.tabs) {
    const wid = tab.windowId || 0;
    if (!windowMap.has(wid)) windowMap.set(wid, []);
    windowMap.get(wid).push({
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
      pinned: tab.pinned || false,
    });
  }

  const windows = [];
  for (const [, tabs] of windowMap) {
    windows.push({ tabCount: tabs.length, tabs });
  }

  return {
    id: session.id,
    name: session.name,
    version: 2,
    createdAt: session.createdAt,
    modifiedAt: session.modifiedAt,
    windows,
  };
}

// ── Save ──

export async function saveSession(name, allWindows = true) {
  const sessionName = typeof name === 'string'
    ? name.slice(0, MAX_CAPTURED_TEXT_LENGTH)
    : name;
  const tabs = await getAllTabs({ allWindows });

  // Query all Chrome tab groups for group metadata
  let chromeGroups = [];
  try {
    chromeGroups = await chrome.tabGroups.query({});
  } catch { /* tabGroups API may not be available */ }

  // Index groups by id for fast lookup
  const groupMeta = new Map();
  for (const g of chromeGroups) {
    groupMeta.set(g.id, {
      title: sanitizeCapturedGroupTitle(g.title),
      color: g.color || 'grey',
      collapsed: g.collapsed || false,
    });
  }

  // Group tabs by windowId, preserving tab order
  const windowMap = new Map();
  for (const t of tabs) {
    if (!windowMap.has(t.windowId)) windowMap.set(t.windowId, { tabs: [], groupIds: new Set() });
    const entry = windowMap.get(t.windowId);

    const savedTab = sanitizeCapturedTab({
      url: t.url,
      title: t.title,
      favIconUrl: t.favIconUrl,
      pinned: t.pinned || false,
    });
    // A tab whose URL cannot satisfy the canonical string bound cannot be
    // stored without poisoning later canonicalization; skip it.
    if (!savedTab) continue;

    // Save group membership (groupId -1 means ungrouped)
    if (t.groupId !== undefined && t.groupId !== -1) {
      savedTab.groupId = t.groupId;
      entry.groupIds.add(t.groupId);
    }

    entry.tabs.push(savedTab);
  }

  const windows = [];
  for (const [, entry] of windowMap) {
    if (entry.tabs.length === 0) continue;
    const winObj = { tabCount: entry.tabs.length, tabs: entry.tabs };

    // Save group metadata for groups referenced by tabs in this window
    if (entry.groupIds.size > 0) {
      winObj.groups = [];
      for (const gid of entry.groupIds) {
        const meta = groupMeta.get(gid);
        if (meta) {
          winObj.groups.push({ id: gid, ...meta });
        }
      }
    }

    windows.push(winObj);
  }

  if (windows.length === 0) {
    return { error: 'No stashable tabs in session' };
  }

  const session = {
    id: generateId(),
    name: sessionName,
    version: 2,
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    windows,
  };

  const sessions = (await Storage.get('sessions')) || [];
  sessions.unshift(session);
  await Storage.set('sessions', sessions);
  return session;
}

// ── Restore ──

/**
 * Restore a saved session through the shared tab-restore coordinator.
 */
export async function restoreSession(sessionId, options = {}) {
  const sessions = (await Storage.get('sessions')) || [];
  const storedSession = sessions.find((session) => session.id === sessionId);
  if (!storedSession) throw new Error('Session not found');

  const session = migrateV1toV2(storedSession);
  return restoreTabWindows(session.windows || [], options);
}

// ── List / Delete ──

export async function listSessions() {
  const sessions = (await Storage.get('sessions')) || [];
  // Return with v2 migration applied (for display purposes)
  return sessions.map(migrateV1toV2);
}

export async function deleteSessions(sessionIds, deletedAt = Date.now()) {
  if (!Array.isArray(sessionIds)) throw new TypeError('Session IDs must be an array');
  computeDeletionTombstone(null, 0, deletedAt);

  const requestedIds = [];
  const seen = new Set();
  for (const value of sessionIds) {
    const id = validateSessionId(value);
    if (seen.has(id)) continue;
    seen.add(id);
    requestedIds.push(id);
  }

  const snapshot = await Storage.getMany(['sessions', 'manualGroups', DRIVE_TOMBSTONES_KEY]);
  const sessions = canonicalizeLocalSessions(snapshot.sessions ?? []);
  const byId = new Map(sessions.map((entry) => [entry.id, entry]));
  const deletedIds = requestedIds.filter((id) => byId.has(id));
  if (deletedIds.length === 0) {
    return { deletedIds: [], tombstones: Object.create(null) };
  }

  const { nextTombstones, recordedTombstones } = recordDeletionTombstones(
    snapshot[DRIVE_TOMBSTONES_KEY] ?? emptyDriveTombstones(),
    'sessions',
    deletedIds.map((id) => ({ id, entity: byId.get(id) })),
    deletedAt,
  );
  const deletedSet = new Set(deletedIds);
  const remaining = sessions.filter(({ id }) => !deletedSet.has(id));
  const canonical = canonicalizeLocalDriveSyncDocument({
    sessions: remaining,
    manualGroups: snapshot.manualGroups,
    tombstones: nextTombstones,
  });
  await Storage.setMany({
    sessions: canonical.sessions,
    [DRIVE_TOMBSTONES_KEY]: canonical.tombstones,
  });
  return { deletedIds, tombstones: recordedTombstones };
}

export async function deleteSession(sessionId, deletedAt = Date.now()) {
  const result = await deleteSessions([sessionId], deletedAt);
  if (result.deletedIds.length === 0) return { deleted: false, tombstoneAt: null };
  return { deleted: true, tombstoneAt: result.tombstones[sessionId] };
}

export async function restoreDeletedSession(session, restoredAt = Date.now()) {
  const restoreTimestamp = validateRestoreTimestamp(restoredAt);
  const [candidate] = canonicalizeLocalSessions([session]);
  validateSessionId(candidate.id);

  const snapshot = await Storage.getMany(['sessions', 'manualGroups', DRIVE_TOMBSTONES_KEY]);
  const currentSessions = canonicalizeLocalSessions(snapshot.sessions ?? []);
  const { nextTombstones } = recordDeletionTombstones(
    snapshot[DRIVE_TOMBSTONES_KEY] ?? emptyDriveTombstones(),
    'sessions',
    [],
    0,
  );
  const retainedTombstone = normalizeDriveTombstone(nextTombstones.sessions[candidate.id]);
  const modifiedAt = Math.max(
    restoreTimestamp,
    getDriveEntityTimestamp(candidate),
    retainedTombstone + 1,
  );
  const [restored] = canonicalizeLocalSessions([{ ...candidate, modifiedAt }]);
  const nextSessions = sortCanonicalSessions(canonicalizeLocalSessions([
    ...currentSessions.filter(({ id }) => id !== restored.id),
    restored,
  ]));
  const canonical = canonicalizeLocalDriveSyncDocument({
    sessions: nextSessions,
    manualGroups: snapshot.manualGroups,
    tombstones: nextTombstones,
  });

  await Storage.setMany({
    sessions: canonical.sessions,
    [DRIVE_TOMBSTONES_KEY]: canonical.tombstones,
  });
  return canonical.sessions.find(({ id }) => id === restored.id);
}
