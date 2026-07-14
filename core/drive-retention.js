// core/drive-retention.js — fail-closed Google Drive retention policy

export const CANONICAL_DRIVE_FILES = new Set([
  'tabkebab-sync.json',
  'tabkebab-settings.json',
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]+$/;

function parseCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function parseArchiveTimestamp(value) {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
  if (!match || parseCalendarDate(match[1]) === null) return null;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  const roundTrip = new Date(timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return roundTrip === value ? timestamp : null;
}

function parseMilliseconds(value) {
  if (!/^\d{13}$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function classifyNormalName(name, scope) {
  let match;

  if (scope === 'sessions') {
    match = name.match(/^sessions-(\d{4}-\d{2}-\d{2})\.json$/);
    const timestamp = match ? parseCalendarDate(match[1]) : null;
    return timestamp === null ? null : { category: 'sessions', timestamp };
  }

  if (scope === 'stashes') {
    match = name.match(/^stashes-(\d{4}-\d{2}-\d{2})\.json$/);
    if (match) {
      const timestamp = parseCalendarDate(match[1]);
      return timestamp === null ? null : { category: 'stashes', timestamp };
    }

    match = name.match(/^stash-([A-Za-z0-9-]+)-(\d{13})\.json$/);
    if (match) {
      const timestamp = parseMilliseconds(match[2]);
      return timestamp === null ? null : { category: 'stashes', timestamp };
    }
    return null;
  }

  if (scope === 'bookmarks') {
    match = name.match(/^bookmarks-(\d{4}-\d{2}-\d{2})-(\d{13})\.json$/);
    if (match) {
      if (parseCalendarDate(match[1]) === null) return null;
      const timestamp = parseMilliseconds(match[2]);
      return timestamp === null ? null : { category: 'bookmarks-json', timestamp };
    }

    match = name.match(/^bookmarks-(\d{4}-\d{2}-\d{2})\.json$/);
    if (match) {
      const timestamp = parseCalendarDate(match[1]);
      return timestamp === null ? null : { category: 'bookmarks-json', timestamp };
    }

    match = name.match(/^bookmarks-(\d{4}-\d{2}-\d{2})\.html$/);
    if (match) {
      const timestamp = parseCalendarDate(match[1]);
      return timestamp === null ? null : { category: 'bookmarks-html', timestamp };
    }
    return null;
  }

  if (scope === 'profile') {
    match = name.match(/^tabkebab-export-(\d{13})\.json$/);
    const timestamp = match ? parseMilliseconds(match[1]) : null;
    return timestamp === null ? null : { category: 'portable-export', timestamp };
  }

  return null;
}

function classifyArchiveName(name) {
  const match = name.match(/^(.*)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(\.(?:json|html))$/);
  if (!match) return null;

  const timestamp = parseArchiveTimestamp(match[2]);
  if (timestamp === null) return null;
  const originalName = `${match[1]}${match[3]}`;

  if (originalName === 'tabkebab-sync.json') return { category: 'archive-sync', timestamp };
  if (originalName === 'tabkebab-settings.json') return { category: 'archive-settings', timestamp };

  const families = [
    ['sessions', 'archive-sessions'],
    ['stashes', 'archive-stashes'],
    ['bookmarks', null],
  ];
  for (const [scope, category] of families) {
    const classified = classifyNormalName(originalName, scope);
    if (!classified) continue;
    if (category) return { category, timestamp };
    if (classified.category === 'bookmarks-json') {
      return { category: 'archive-bookmarks-json', timestamp };
    }
    if (classified.category === 'bookmarks-html') {
      return { category: 'archive-bookmarks-html', timestamp };
    }
  }

  return null;
}

/**
 * Classify a filename only when it is a known, dated, recoverable copy in its
 * authoritative Drive scope. The returned embedded timestamp validates the
 * name; retention age is intentionally based on modifiedTime elsewhere.
 */
export function classifyDatedDriveFile(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
  if (typeof file.name !== 'string' || typeof file.scope !== 'string') return null;
  if (CANONICAL_DRIVE_FILES.has(file.name)) return null;
  if (file.scope === 'archive') return classifyArchiveName(file.name);
  return classifyNormalName(file.name, file.scope);
}

export function isValidDriveFileId(fileId) {
  return typeof fileId === 'string' && DRIVE_FILE_ID.test(fileId);
}

function parseModifiedTime(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match || parseCalendarDate(match[1]) === null) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (match[5] !== 'Z') {
    const offsetHour = Number(match[5].slice(1, 3));
    const offsetMinute = Number(match[5].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function duplicateFingerprint(file) {
  return JSON.stringify([file?.name, file?.scope, file?.modifiedTime]);
}

/**
 * Select old, non-newest recoverable copies for deletion without mutating the
 * inventory or its file records.
 */
export function selectDriveRetentionDeletions(files, cutoffMs) {
  if (!Array.isArray(files)) throw new TypeError('Drive retention files must be an array');
  if (typeof cutoffMs !== 'number' || !Number.isFinite(cutoffMs)) {
    throw new TypeError('Drive retention cutoff must be a finite number');
  }

  const fingerprintsById = new Map();
  for (const file of files) {
    if (!isValidDriveFileId(file?.id)) continue;
    const fingerprint = duplicateFingerprint(file);
    const previous = fingerprintsById.get(file.id);
    if (previous !== undefined && previous !== fingerprint) {
      throw new Error(`Drive inventory contains conflicting metadata for file ID ${file.id}`);
    }
    fingerprintsById.set(file.id, fingerprint);
  }

  const keptCanonical = [];
  const ignoredUndated = [];
  const classifiedFiles = [];
  const newestByCategory = new Map();
  const processedIds = new Set();

  for (const file of files) {
    if (isValidDriveFileId(file?.id)) {
      if (processedIds.has(file.id)) continue;
      processedIds.add(file.id);
    }
    if (file && typeof file === 'object' && CANONICAL_DRIVE_FILES.has(file.name)) {
      keptCanonical.push(file);
      continue;
    }

    const classification = classifyDatedDriveFile(file);
    const modifiedTime = parseModifiedTime(file?.modifiedTime);
    if (!classification || modifiedTime === null || !isValidDriveFileId(file?.id)) {
      ignoredUndated.push(file);
      continue;
    }

    classifiedFiles.push({ file, category: classification.category, modifiedTime });
    const newest = newestByCategory.get(classification.category);
    if (newest === undefined || modifiedTime > newest) {
      newestByCategory.set(classification.category, modifiedTime);
    }
  }

  const deleteFiles = [];
  const keptNewest = [];
  const deleteIds = new Set();
  for (const entry of classifiedFiles) {
    if (entry.modifiedTime === newestByCategory.get(entry.category)) {
      keptNewest.push(entry.file);
      continue;
    }
    if (entry.modifiedTime < cutoffMs && !deleteIds.has(entry.file.id)) {
      deleteIds.add(entry.file.id);
      deleteFiles.push(entry.file);
    }
  }

  return { deleteFiles, keptCanonical, keptNewest, ignoredUndated };
}

export function validateDriveRetentionDays(days) {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new TypeError('Drive retention days must be an integer from 1 to 365');
  }
  return days;
}

export function retentionCutoff(days, nowMs = Date.now()) {
  validateDriveRetentionDays(days);
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('Drive retention current time must be a finite number');
  }
  return nowMs - (days * DAY_MS);
}

export function emptyDriveRetentionResult() {
  return {
    deleted: 0,
    keptCanonical: 0,
    keptNewest: 0,
    ignoredUndated: 0,
    errors: [],
  };
}

/**
 * Complete inventory and selection before making the first destructive call.
 * Individual delete failures are reported as plain serializable records.
 */
export async function coordinateDriveRetention({ cutoffMs, listFiles, deleteFile }) {
  if (typeof listFiles !== 'function' || typeof deleteFile !== 'function') {
    throw new TypeError('Drive retention requires listFiles and deleteFile functions');
  }

  const files = await listFiles();
  const selection = selectDriveRetentionDeletions(files, cutoffMs);
  const result = {
    deleted: 0,
    keptCanonical: selection.keptCanonical.length,
    keptNewest: selection.keptNewest.length,
    ignoredUndated: selection.ignoredUndated.length,
    errors: [],
  };

  for (const file of selection.deleteFiles) {
    try {
      await deleteFile(file.id);
      result.deleted++;
    } catch {
      result.errors.push({
        fileId: file.id,
        name: file.name,
        message: 'Drive file deletion failed',
      });
    }
  }

  return result;
}
