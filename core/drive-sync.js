// core/drive-sync.js — bounded Drive sync v2 migration and deterministic merge

import { Storage } from './storage.js';

export const DRIVE_SYNC_VERSION = 2;
export const DRIVE_TOMBSTONES_KEY = 'driveSyncTombstones';
export const MAX_DRIVE_JSON_BYTES = 25 * 1024 * 1024;
export const MAX_DRIVE_ENTITIES_PER_KIND = 10_000;
export const MAX_DRIVE_TOMBSTONES_PER_KIND = 10_000;
export const MAX_DRIVE_TABS_PER_ENTITY = 10_000;
export const MAX_DRIVE_TOTAL_TABS = 100_000;
export const MAX_DRIVE_STRING_LENGTH = 16_384;
export const MAX_DRIVE_NESTING_DEPTH = 12;
export const MAX_DRIVE_TIMESTAMP = Number.MAX_SAFE_INTEGER;
export const MAX_DRIVE_TOMBSTONE = MAX_DRIVE_TIMESTAMP - 1;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ROOT_KEYS = new Set(['version', 'sessions', 'manualGroups', 'tombstones']);
const LEGACY_ROOT_KEYS = new Set(['version', 'sessions', 'manualGroups']);
const TOMBSTONE_KINDS = new Set(['sessions', 'manualGroups']);

function fail(message) {
  throw new TypeError(`Invalid Drive sync document: ${message}`);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function lexicalCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateKey(key, path) {
  if (key.length > MAX_DRIVE_STRING_LENGTH) fail(`${path} key exceeds the string length limit`);
  if (DANGEROUS_KEYS.has(key)) fail(`${path} contains a prototype-pollution key`);
}

function ownDataKeys(value, path) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${path} cannot be inspected safely`);
  }
  if (keys.some((key) => typeof key !== 'string')) fail(`${path} contains a symbol key`);
  return keys;
}

function validateJsonTree(value, path, depth, ancestors) {
  if (depth > MAX_DRIVE_NESTING_DEPTH) fail(`${path} exceeds the nesting depth limit`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > MAX_DRIVE_STRING_LENGTH) fail(`${path} string exceeds the length limit`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') fail(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) fail(`${path} contains a cycle`);
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${path} is not a JSON array`);
      const keys = ownDataKeys(value, path);
      const expected = new Set(['length']);
      for (let index = 0; index < value.length; index += 1) expected.add(String(index));
      if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
        fail(`${path} is sparse or contains non-JSON array properties`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
          fail(`${path}[${index}] is not an own JSON value`);
        }
        validateJsonTree(descriptor.value, `${path}[${index}]`, depth + 1, ancestors);
      }
      return;
    }

    if (!isPlainRecord(value)) fail(`${path} is not a plain object`);
    for (const key of ownDataKeys(value, path)) {
      validateKey(key, path);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        fail(`${path}.${key} is not an enumerable data property`);
      }
      validateJsonTree(descriptor.value, `${path}.${key}`, depth + 1, ancestors);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('Invalid Drive sync document:')) throw error;
    fail(`${path} cannot be inspected safely`);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Validate a parsed value as bounded JSON. Settings and Drive readers reuse
 * this boundary before applying their more specific schemas.
 */
export function assertBoundedDriveJsonValue(value) {
  validateJsonTree(value, 'root', 0, new Set());
  let encoded;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(value));
  } catch {
    fail('cannot be serialized as JSON');
  }
  if (encoded.byteLength > MAX_DRIVE_JSON_BYTES) fail('exceeds the 25 MiB byte limit');
  return value;
}

function canonicalClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalClone);
  const output = {};
  for (const key of Object.keys(value).sort(lexicalCompare)) {
    output[key] = canonicalClone(value[key]);
  }
  return output;
}

function sortedNullMap(entries) {
  const output = Object.create(null);
  for (const [key, value] of [...entries].sort(([left], [right]) => lexicalCompare(left, right))) {
    output[key] = value;
  }
  return output;
}

function validateId(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DRIVE_STRING_LENGTH) {
    fail(`${path} must be a non-empty bounded string`);
  }
  if (DANGEROUS_KEYS.has(value)) fail(`${path} uses a prototype-pollution key`);
  return value;
}

function isEntityTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DRIVE_TIMESTAMP;
}

function isTombstone(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DRIVE_TOMBSTONE;
}

function validateEntityTimestampFields(entity, path) {
  for (const key of ['modifiedAt', 'createdAt']) {
    if (Object.hasOwn(entity, key) && !isEntityTimestamp(entity[key])) {
      fail(`${path}.${key} is not a valid timestamp`);
    }
  }
}

function countSessionTabs(entity, path) {
  let count = 0;
  if (Object.hasOwn(entity, 'tabs')) {
    if (!Array.isArray(entity.tabs)) fail(`${path}.tabs must be an array`);
    count += entity.tabs.length;
  }
  if (Object.hasOwn(entity, 'windows')) {
    if (!Array.isArray(entity.windows)) fail(`${path}.windows must be an array`);
    for (let index = 0; index < entity.windows.length; index += 1) {
      const window = entity.windows[index];
      if (!isPlainRecord(window)) fail(`${path}.windows[${index}] must be an object`);
      if (Object.hasOwn(window, 'tabs')) {
        if (!Array.isArray(window.tabs)) fail(`${path}.windows[${index}].tabs must be an array`);
        count += window.tabs.length;
      }
    }
  }
  if (count > MAX_DRIVE_TABS_PER_ENTITY) fail(`${path} exceeds the 10,000 tab limit`);
  return count;
}

function normalizeSessions(value) {
  if (!Array.isArray(value)) fail('sessions must be an array');
  if (value.length > MAX_DRIVE_ENTITIES_PER_KIND) fail('sessions exceed the 10,000 entity limit');
  const seen = new Set();
  const sessions = [];
  let totalTabs = 0;

  for (let index = 0; index < value.length; index += 1) {
    const entity = value[index];
    if (!isPlainRecord(entity)) fail(`sessions[${index}] must be an object`);
    if (!Object.hasOwn(entity, 'id')) fail(`sessions[${index}].id must be an own property`);
    const id = validateId(entity.id, `sessions[${index}].id`);
    if (seen.has(id)) fail(`sessions contains duplicate ID ${id}`);
    seen.add(id);
    validateEntityTimestampFields(entity, `sessions[${index}]`);
    totalTabs += countSessionTabs(entity, `sessions[${index}]`);
    sessions.push(canonicalClone(entity));
  }
  return { sessions, totalTabs };
}

function normalizeManualGroups(value) {
  if (!isPlainRecord(value)) fail('manualGroups must be a map');
  const keys = Object.keys(value);
  if (keys.length > MAX_DRIVE_ENTITIES_PER_KIND) fail('manualGroups exceed the 10,000 entity limit');
  const entries = [];
  let totalTabs = 0;

  for (const id of keys) {
    validateId(id, 'manualGroups key');
    const entity = value[id];
    if (!isPlainRecord(entity)) fail(`manualGroups.${id} must be an object`);
    validateEntityTimestampFields(entity, `manualGroups.${id}`);
    if (Object.hasOwn(entity, 'tabUrls')) {
      if (!Array.isArray(entity.tabUrls)) fail(`manualGroups.${id}.tabUrls must be an array`);
      if (entity.tabUrls.length > MAX_DRIVE_TABS_PER_ENTITY) {
        fail(`manualGroups.${id} exceeds the 10,000 URL limit`);
      }
      totalTabs += entity.tabUrls.length;
    }
    entries.push([id, canonicalClone(entity)]);
  }
  return { manualGroups: sortedNullMap(entries), totalTabs };
}

function normalizeTombstoneMap(value, kind) {
  if (!isPlainRecord(value)) fail(`tombstones.${kind} must be a map`);
  const keys = Object.keys(value);
  if (keys.length > MAX_DRIVE_TOMBSTONES_PER_KIND) {
    fail(`tombstones.${kind} exceeds the 10,000 tombstone limit`);
  }
  const entries = [];
  for (const id of keys) {
    validateId(id, `tombstones.${kind} key`);
    if (!isTombstone(value[id])) fail(`tombstones.${kind}.${id} is not a valid tombstone timestamp`);
    entries.push([id, value[id]]);
  }
  return sortedNullMap(entries);
}

function assertOnlyKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path} contains unknown key ${key}`);
  }
}

export function emptyDriveTombstones() {
  return {
    sessions: Object.create(null),
    manualGroups: Object.create(null),
  };
}

export function getDriveEntityTimestamp(entity) {
  if (!entity || typeof entity !== 'object') return 0;
  if (isEntityTimestamp(entity.modifiedAt)) return entity.modifiedAt;
  if (isEntityTimestamp(entity.createdAt)) return entity.createdAt;
  return 0;
}

export function normalizeDriveTombstone(value) {
  return isTombstone(value) ? value : 0;
}

function assertDeletionTimestamp(value) {
  if (!isTombstone(value)) {
    throw new TypeError('Deletion timestamp must be a non-negative safe integer within the tombstone range');
  }
  return value;
}

/**
 * Compute a deletion timestamp that is at least as new as the entity and any
 * prior tombstone. An entity at MAX_DRIVE_TIMESTAMP cannot be represented by
 * the stricter tombstone schema and therefore fails closed.
 */
export function computeDeletionTombstone(entity, previousTombstone, deletedAt) {
  const deletionTimestamp = assertDeletionTimestamp(deletedAt);
  const entityTimestamp = getDriveEntityTimestamp(entity);
  if (entityTimestamp > MAX_DRIVE_TOMBSTONE) {
    throw new TypeError('Entity timestamp cannot be represented by a deletion tombstone');
  }
  return Math.max(
    deletionTimestamp,
    entityTimestamp,
    normalizeDriveTombstone(previousTombstone),
  );
}

function normalizeDeletionTombstoneState(currentTombstones) {
  const root = isPlainRecord(currentTombstones) ? currentTombstones : {};
  const output = emptyDriveTombstones();
  for (const kind of TOMBSTONE_KINDS) {
    const source = Object.hasOwn(root, kind) && isPlainRecord(root[kind]) ? root[kind] : {};
    const keys = Object.keys(source);
    if (keys.length > MAX_DRIVE_TOMBSTONES_PER_KIND) {
      fail(`tombstones.${kind} exceeds the 10,000 tombstone limit`);
    }
    output[kind] = sortedNullMap(keys.map((id) => {
      validateId(id, `tombstones.${kind} key`);
      return [id, normalizeDriveTombstone(source[id])];
    }));
  }
  return output;
}

/**
 * Purely record one same-kind deletion batch into a fresh canonical tombstone
 * state. Every entry and capacity change is preflighted before a result exists.
 */
export function recordDeletionTombstones(currentTombstones, kind, entries, deletedAt) {
  assertDeletionTimestamp(deletedAt);
  if (!TOMBSTONE_KINDS.has(kind)) {
    throw new TypeError('Deletion tombstone kind must be sessions or manualGroups');
  }
  if (!Array.isArray(entries)) throw new TypeError('Deletion tombstone entries must be an array');

  const nextTombstones = normalizeDeletionTombstoneState(currentTombstones);
  const seen = new Set();
  const prepared = [];
  let added = 0;
  for (const entry of entries) {
    if (!isPlainRecord(entry)) throw new TypeError('Deletion tombstone entry must be an object');
    if (!Object.hasOwn(entry, 'id')) throw new TypeError('Deletion tombstone entry must have an own ID');
    const id = validateId(entry.id, 'deletion tombstone ID');
    if (seen.has(id)) throw new TypeError(`Duplicate deletion tombstone ID: ${id}`);
    seen.add(id);
    if (!Object.hasOwn(nextTombstones[kind], id)) added += 1;
    prepared.push({
      id,
      timestamp: computeDeletionTombstone(
        entry.entity,
        nextTombstones[kind][id],
        deletedAt,
      ),
    });
  }

  if (Object.keys(nextTombstones[kind]).length + added > MAX_DRIVE_TOMBSTONES_PER_KIND) {
    throw new TypeError(`Deletion would exceed the ${MAX_DRIVE_TOMBSTONES_PER_KIND.toLocaleString('en-US')} tombstone limit`);
  }

  const updatedEntries = Object.entries(nextTombstones[kind]);
  const updated = new Map(updatedEntries);
  for (const { id, timestamp } of prepared) updated.set(id, timestamp);
  nextTombstones[kind] = sortedNullMap(updated.entries());
  const canonicalTombstones = migrateDriveSyncDocument({
    version: DRIVE_SYNC_VERSION,
    sessions: [],
    manualGroups: {},
    tombstones: nextTombstones,
  }).tombstones;
  const recordedTombstones = sortedNullMap(
    prepared.map(({ id, timestamp }) => [id, timestamp]),
  );
  return { nextTombstones: canonicalTombstones, recordedTombstones };
}

export function migrateDriveSyncDocument(input) {
  if (input === null || input === undefined) {
    return {
      version: DRIVE_SYNC_VERSION,
      sessions: [],
      manualGroups: Object.create(null),
      tombstones: emptyDriveTombstones(),
    };
  }

  assertBoundedDriveJsonValue(input);
  if (!isPlainRecord(input)) fail('root must be an object');
  const hasVersion = Object.hasOwn(input, 'version');
  const version = hasVersion ? input.version : 1;
  if (version !== 1 && version !== DRIVE_SYNC_VERSION) fail(`unsupported version ${String(version)}`);
  assertOnlyKeys(input, version === DRIVE_SYNC_VERSION ? ROOT_KEYS : LEGACY_ROOT_KEYS, 'root');

  if (version === DRIVE_SYNC_VERSION) {
    for (const key of ['sessions', 'manualGroups', 'tombstones']) {
      if (!Object.hasOwn(input, key)) fail(`version 2 requires own ${key}`);
    }
  }

  const { sessions, totalTabs: sessionTabs } = normalizeSessions(
    Object.hasOwn(input, 'sessions') ? input.sessions : [],
  );
  const { manualGroups, totalTabs: groupTabs } = normalizeManualGroups(
    Object.hasOwn(input, 'manualGroups') ? input.manualGroups : {},
  );
  if (sessionTabs + groupTabs > MAX_DRIVE_TOTAL_TABS) {
    fail('document exceeds the 100,000 total tab and URL limit');
  }

  let tombstones = emptyDriveTombstones();
  if (version === DRIVE_SYNC_VERSION) {
    if (!isPlainRecord(input.tombstones)) fail('tombstones must be an object');
    assertOnlyKeys(input.tombstones, TOMBSTONE_KINDS, 'tombstones');
    for (const kind of TOMBSTONE_KINDS) {
      if (!Object.hasOwn(input.tombstones, kind)) fail(`tombstones requires own ${kind}`);
    }
    tombstones = {
      sessions: normalizeTombstoneMap(input.tombstones.sessions, 'sessions'),
      manualGroups: normalizeTombstoneMap(input.tombstones.manualGroups, 'manualGroups'),
    };
  }

  return { version: DRIVE_SYNC_VERSION, sessions, manualGroups, tombstones };
}

function canonicalEntityString(entity) {
  return JSON.stringify(canonicalClone(entity));
}

function chooseEntity(left, right) {
  if (!left) return canonicalClone(right);
  if (!right) return canonicalClone(left);
  const leftTimestamp = getDriveEntityTimestamp(left);
  const rightTimestamp = getDriveEntityTimestamp(right);
  if (leftTimestamp > rightTimestamp) return canonicalClone(left);
  if (rightTimestamp > leftTimestamp) return canonicalClone(right);
  const leftString = canonicalEntityString(left);
  const rightString = canonicalEntityString(right);
  return canonicalClone(leftString >= rightString ? left : right);
}

function mergeEntityMaps(leftEntries, rightEntries) {
  const left = new Map(leftEntries);
  const right = new Map(rightEntries);
  const ids = new Set([...left.keys(), ...right.keys()]);
  const merged = new Map();
  for (const id of ids) merged.set(id, chooseEntity(left.get(id), right.get(id)));
  return merged;
}

function mergeTombstones(left, right) {
  const entries = [];
  const ids = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const id of ids) {
    const leftValue = Object.hasOwn(left, id) ? left[id] : null;
    const rightValue = Object.hasOwn(right, id) ? right[id] : null;
    entries.push([id, leftValue === null ? rightValue : rightValue === null ? leftValue : Math.max(leftValue, rightValue)]);
  }
  return sortedNullMap(entries);
}

export function mergeDriveSyncDocuments(leftInput, rightInput) {
  const left = migrateDriveSyncDocument(leftInput);
  const right = migrateDriveSyncDocument(rightInput);
  const sessionEntities = mergeEntityMaps(
    left.sessions.map((entity) => [entity.id, entity]),
    right.sessions.map((entity) => [entity.id, entity]),
  );
  const groupEntities = mergeEntityMaps(
    Object.entries(left.manualGroups),
    Object.entries(right.manualGroups),
  );
  const sessionTombstones = mergeTombstones(left.tombstones.sessions, right.tombstones.sessions);
  const groupTombstones = mergeTombstones(left.tombstones.manualGroups, right.tombstones.manualGroups);

  const sessions = [...sessionEntities.entries()]
    .filter(([id, entity]) => !Object.hasOwn(sessionTombstones, id) ||
      getDriveEntityTimestamp(entity) > sessionTombstones[id])
    .map(([, entity]) => canonicalClone(entity))
    .sort((leftEntity, rightEntity) => {
      const createdOrder = getValidCreatedAt(rightEntity) - getValidCreatedAt(leftEntity);
      return createdOrder || lexicalCompare(leftEntity.id, rightEntity.id);
    });

  const manualGroupEntries = [...groupEntities.entries()]
    .filter(([id, entity]) => !Object.hasOwn(groupTombstones, id) ||
      getDriveEntityTimestamp(entity) > groupTombstones[id])
    .map(([id, entity]) => [id, canonicalClone(entity)]);

  return {
    version: DRIVE_SYNC_VERSION,
    sessions,
    manualGroups: sortedNullMap(manualGroupEntries),
    tombstones: {
      sessions: sessionTombstones,
      manualGroups: groupTombstones,
    },
  };
}

function getValidCreatedAt(entity) {
  return isEntityTimestamp(entity?.createdAt) ? entity.createdAt : 0;
}

function normalizeLocalEntity(entity) {
  if (!isPlainRecord(entity)) return entity;
  const output = {};
  for (const key of Object.keys(entity)) {
    if ((key === 'modifiedAt' || key === 'createdAt') && !isEntityTimestamp(entity[key])) continue;
    output[key] = entity[key];
  }
  return output;
}

function normalizeLocalTombstones(value) {
  const output = emptyDriveTombstones();
  const root = isPlainRecord(value) ? value : {};
  for (const kind of TOMBSTONE_KINDS) {
    const source = Object.hasOwn(root, kind) && isPlainRecord(root[kind]) ? root[kind] : {};
    output[kind] = sortedNullMap(
      Object.keys(source).map((id) => [id, normalizeDriveTombstone(source[id])]),
    );
  }
  return output;
}

/**
 * Canonicalize one complete local portable-state snapshot with Task 7's
 * defensive timestamp/tombstone recovery and full-document resource limits.
 */
export function canonicalizeLocalDriveSyncDocument(input) {
  if (!isPlainRecord(input)) fail('local state must be an object');
  const rawSessions = Object.hasOwn(input, 'sessions') ? input.sessions : undefined;
  const rawManualGroups = Object.hasOwn(input, 'manualGroups') ? input.manualGroups : undefined;
  const rawTombstones = Object.hasOwn(input, 'tombstones') ? input.tombstones : undefined;
  const sessions = Array.isArray(rawSessions)
    ? rawSessions.map(normalizeLocalEntity)
    : rawSessions ?? [];
  const manualGroups = isPlainRecord(rawManualGroups)
    ? sortedNullMap(Object.entries(rawManualGroups).map(
      ([id, entity]) => [id, normalizeLocalEntity(entity)],
    ))
    : rawManualGroups ?? {};
  return migrateDriveSyncDocument({
    version: DRIVE_SYNC_VERSION,
    sessions,
    manualGroups,
    tombstones: normalizeLocalTombstones(rawTombstones),
  });
}

export async function readLocalDriveSyncDocument() {
  const values = await Storage.getMany(['sessions', 'manualGroups', DRIVE_TOMBSTONES_KEY]);
  return canonicalizeLocalDriveSyncDocument({
    sessions: values.sessions,
    manualGroups: values.manualGroups,
    tombstones: values[DRIVE_TOMBSTONES_KEY],
  });
}

export async function writeLocalDriveSyncDocument(document) {
  const canonical = migrateDriveSyncDocument(document);
  await Storage.setMany({
    sessions: canonical.sessions,
    manualGroups: canonical.manualGroups,
    [DRIVE_TOMBSTONES_KEY]: canonical.tombstones,
  });
  return canonical;
}

export async function reconcileDriveSync(remoteDocument, writeRemote) {
  if (typeof writeRemote !== 'function') throw new TypeError('Drive remote writer must be a function');
  const remote = migrateDriveSyncDocument(remoteDocument);
  const local = await readLocalDriveSyncDocument();
  const merged = mergeDriveSyncDocuments(local, remote);
  await writeRemote(merged);
  await writeLocalDriveSyncDocument(merged);
  return merged;
}
