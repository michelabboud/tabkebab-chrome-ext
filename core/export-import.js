// core/export-import.js — Portable JSON export/import orchestration

import {
  MAX_PORTABLE_IMPORT_BYTES,
  createPortableExportDocument,
  mergePortableSections,
  parsePortableExportDocument,
  validateStashSection,
} from './export-schema.js';
import { Storage } from './storage.js';
import { getAllStashes, replaceAllStashes } from './stash-db.js';
import { createDefaultKeepAwakeDomains } from './keep-awake-defaults.js';
import { SETTINGS_DEFAULTS, validateSettingsPatch } from './settings.js';

const frozenSections = (sections) => Object.freeze(sections);

export const PORTABLE_KIND_SECTIONS = Object.freeze({
  full: frozenSections([
    'sessions',
    'stashes',
    'manualGroups',
    'keepAwakeDomains',
    'bookmarks',
    'settings',
    'focusProfilePrefs',
    'focusHistory',
    'aiSettings',
  ]),
  sessions: frozenSections(['sessions']),
  stashes: frozenSections(['stashes']),
  settings: frozenSections(['settings']),
});

const PORTABLE_SECTION_REPOSITORIES = Object.freeze({
  sessions: Object.freeze({ storageKey: 'sessions', empty: () => [] }),
  stashes: Object.freeze({ stashStore: true, empty: () => [] }),
  manualGroups: Object.freeze({ storageKey: 'manualGroups', empty: () => Object.create(null) }),
  keepAwakeDomains: Object.freeze({
    storageKey: 'keepAwakeDomains',
    empty: () => [],
    exportEmpty: createDefaultKeepAwakeDomains,
    exportNormalize: (value) => value ?? createDefaultKeepAwakeDomains(),
  }),
  bookmarks: Object.freeze({ storageKey: 'tabkebabBookmarks', empty: () => [] }),
  settings: Object.freeze({
    storageKey: 'tabkebabSettings',
    empty: () => Object.create(null),
    exportNormalize: (value) => validateSettingsPatch(value ?? {}, SETTINGS_DEFAULTS),
  }),
  focusProfilePrefs: Object.freeze({
    storageKey: 'focusProfilePrefs',
    empty: () => Object.create(null),
  }),
  focusHistory: Object.freeze({ storageKey: 'focusHistory', empty: () => [] }),
  aiSettings: Object.freeze({ storageKey: 'aiSettings', empty: () => Object.create(null) }),
});

const TOMBSTONES_STORAGE_KEY = 'driveSyncTombstones';
const COUNTED_SECTIONS = Object.freeze([
  'sessions',
  'stashes',
  'manualGroups',
  'bookmarks',
  'focusHistory',
]);

function portableKindSections(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(PORTABLE_KIND_SECTIONS, kind)) {
    throw new TypeError('Portable kind must be full, sessions, stashes, or settings');
  }
  return PORTABLE_KIND_SECTIONS[kind];
}

function requireRepositorySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('Storage repository returned an invalid snapshot');
  }
  return snapshot;
}

function sectionValue(snapshot, section, { forExport = false } = {}) {
  const repository = PORTABLE_SECTION_REPOSITORIES[section];
  if (repository.stashStore) return snapshot;
  const value = !Object.hasOwn(snapshot, repository.storageKey) ||
      snapshot[repository.storageKey] === undefined
    ? (forExport && repository.exportEmpty ? repository.exportEmpty() : repository.empty())
    : snapshot[repository.storageKey];
  return forExport && repository.exportNormalize
    ? repository.exportNormalize(value)
    : value;
}

function exportTimestamp(now) {
  const clockValue = now();
  return clockValue instanceof Date ? clockValue.toISOString() : clockValue;
}

function emptyTombstones() {
  return { sessions: Object.create(null), manualGroups: Object.create(null) };
}

function validateImportClock(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Import clock must return a non-negative safe-integer timestamp');
  }
  return value;
}

function emptyCountSummary() {
  const imported = {};
  const skipped = {};
  for (const section of COUNTED_SECTIONS) {
    imported[section] = 0;
    skipped[section] = 0;
  }
  return { imported, skipped };
}

function sectionRecordCount(section, value) {
  return section === 'manualGroups' ? Object.keys(value).length : value.length;
}

function buildCountSummary(sections, existing, incoming, merged) {
  const result = emptyCountSummary();
  for (const section of sections) {
    if (!COUNTED_SECTIONS.includes(section)) continue;
    const localCount = sectionRecordCount(section, existing[section]);
    const incomingCount = sectionRecordCount(section, incoming[section]);
    const mergedCount = sectionRecordCount(section, merged[section]);
    const imported = mergedCount - localCount;
    result.imported[section] = imported;
    result.skipped[section] = incomingCount - imported;
  }
  return result;
}

function rollbackFailure(scope, operation, message) {
  return { scope, operation, message };
}

export class ImportRollbackError extends Error {
  constructor(originalCause, rollbackFailures) {
    super('Import failed and rollback was incomplete', { cause: originalCause });
    this.name = 'ImportRollbackError';
    this.rollbackFailures = rollbackFailures.map(({ scope, operation, message }) => ({
      scope,
      operation,
      message,
    }));
  }
}

export async function buildFullExportPayload({
  storage = Storage,
  stashRepository = { list: getAllStashes },
  now = () => new Date(),
} = {}) {
  return buildPortableExportPayload('full', { storage, stashRepository, now });
}

export async function buildPortableExportPayload(kind, {
  storage = Storage,
  stashRepository = { list: getAllStashes },
  now = () => new Date(),
} = {}) {
  const sectionNames = portableKindSections(kind);
  const exportedAt = exportTimestamp(now);
  const sections = Object.create(null);
  const localSections = sectionNames.filter((section) => {
    return Boolean(PORTABLE_SECTION_REPOSITORIES[section].storageKey);
  });

  if (localSections.length > 0) {
    const keys = localSections.map((section) => PORTABLE_SECTION_REPOSITORIES[section].storageKey);
    const snapshot = requireRepositorySnapshot(await storage.getMany(keys));
    for (const section of localSections) {
      sections[section] = sectionValue(snapshot, section, { forExport: true });
    }
  }

  if (sectionNames.includes('stashes')) {
    sections.stashes = await stashRepository.list();
  }

  return createPortableExportDocument(kind, sections, exportedAt);
}

function validateAcceptedKinds(acceptedKinds) {
  if (!acceptedKinds || typeof acceptedKinds === 'string' ||
      typeof acceptedKinds[Symbol.iterator] !== 'function') {
    throw new TypeError('Accepted portable kinds must be a non-empty collection');
  }
  const kinds = [...acceptedKinds];
  if (kinds.length === 0) {
    throw new TypeError('Accepted portable kinds must be a non-empty collection');
  }
  for (const kind of kinds) portableKindSections(kind);
  return new Set(kinds);
}

export async function readPortableImportFile(file, acceptedKinds) {
  const accepted = validateAcceptedKinds(acceptedKinds);
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0 ||
      typeof file.text !== 'function') {
    throw new TypeError('Portable import requires a file with a valid size and text reader');
  }
  if (file.size > MAX_PORTABLE_IMPORT_BYTES) {
    throw new TypeError('Portable import file exceeds the 25 MiB size limit');
  }

  const text = await file.text();
  if (typeof text !== 'string') throw new TypeError('Portable import file did not return text');
  const parsed = parsePortableExportDocument(JSON.parse(text));
  if (!accepted.has(parsed.kind)) {
    throw new TypeError(`Portable import kind ${parsed.kind} is not accepted here`);
  }
  return parsed;
}

export function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  let anchor = null;
  let attached = false;
  try {
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    attached = true;
    anchor.click();
  } finally {
    try {
      if (attached) document.body.removeChild(anchor);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function validateParsedImportDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('Portable import document must be a normalized object');
  }
  const sections = portableKindSections(document.kind);
  for (const section of sections) {
    if (!Object.hasOwn(document, section)) {
      throw new TypeError(`Portable ${document.kind} import requires ${section}`);
    }
  }
  return sections;
}

async function rollbackImport({
  storage,
  stashRepository,
  localSnapshot,
  localKeys,
  stashSnapshot,
  restoreStashes,
}) {
  const failures = [];
  if (restoreStashes) {
    try {
      await stashRepository.replace(stashSnapshot);
    } catch {
      failures.push(rollbackFailure(
        'stashes',
        'restore',
        'Failed to restore the prior stash snapshot',
      ));
    }
  }

  if (localKeys.length > 0) {
    const presentValues = Object.create(null);
    const absentKeys = [];
    for (const key of localKeys) {
      if (Object.hasOwn(localSnapshot, key)) presentValues[key] = localSnapshot[key];
      else absentKeys.push(key);
    }

    if (Object.keys(presentValues).length > 0) {
      try {
        await storage.setMany(presentValues);
      } catch {
        failures.push(rollbackFailure(
          'localStorage',
          'restore',
          'Failed to restore prior local storage values',
        ));
      }
    }
    if (absentKeys.length > 0) {
      try {
        await storage.removeMany(absentKeys);
      } catch {
        failures.push(rollbackFailure(
          'localStorage',
          'removeAbsent',
          'Failed to remove local storage keys created by the import',
        ));
      }
    }
  }
  return failures;
}

export async function applyPortableImport(parsedDocument, {
  storage = Storage,
  stashRepository = { list: getAllStashes, replace: replaceAllStashes },
  now = Date.now,
} = {}) {
  const sections = validateParsedImportDocument(parsedDocument);
  const mergeNow = validateImportClock(now());
  const localSections = sections.filter((section) => {
    return Boolean(PORTABLE_SECTION_REPOSITORIES[section].storageKey);
  });
  const localKeys = localSections.map((section) => PORTABLE_SECTION_REPOSITORIES[section].storageKey);
  const hasStashes = sections.includes('stashes');
  const localSnapshot = localKeys.length > 0
    ? requireRepositorySnapshot(await storage.getMany(localKeys))
    : Object.create(null);
  const stashSnapshot = hasStashes ? await stashRepository.list() : null;

  let retainedTombstones = emptyTombstones();
  if (sections.includes('sessions') || sections.includes('manualGroups')) {
    const snapshot = requireRepositorySnapshot(await storage.getMany([TOMBSTONES_STORAGE_KEY]));
    if (Object.hasOwn(snapshot, TOMBSTONES_STORAGE_KEY) && snapshot[TOMBSTONES_STORAGE_KEY] != null) {
      retainedTombstones = snapshot[TOMBSTONES_STORAGE_KEY];
    }
  }

  const existing = Object.create(null);
  const incoming = Object.create(null);
  for (const section of sections) {
    existing[section] = section === 'stashes'
      ? stashSnapshot
      : sectionValue(localSnapshot, section);
    incoming[section] = parsedDocument[section];
  }
  const merged = mergePortableSections(existing, incoming, {
    tombstones: retainedTombstones,
    now: mergeNow,
  });
  if (hasStashes) merged.stashes = validateStashSection(merged.stashes);
  const result = buildCountSummary(sections, existing, incoming, merged);

  const localValues = Object.create(null);
  for (const section of localSections) {
    localValues[PORTABLE_SECTION_REPOSITORIES[section].storageKey] = merged[section];
  }

  let stashReplacementAttempted = false;
  try {
    if (localKeys.length > 0) await storage.setMany(localValues);
    if (hasStashes) {
      stashReplacementAttempted = true;
      await stashRepository.replace(merged.stashes);
    }
  } catch (originalCause) {
    const rollbackFailures = await rollbackImport({
      storage,
      stashRepository,
      localSnapshot,
      localKeys,
      stashSnapshot,
      restoreStashes: stashReplacementAttempted,
    });
    if (rollbackFailures.length > 0) {
      throw new ImportRollbackError(originalCause, rollbackFailures);
    }
    throw originalCause;
  }

  return result;
}
