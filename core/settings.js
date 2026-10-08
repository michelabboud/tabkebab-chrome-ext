// core/settings.js — Settings schema, defaults, and CRUD

import { Storage } from './storage.js';
import { MAX_DRIVE_TIMESTAMP, assertBoundedDriveJsonValue } from './drive-sync.js';

const STORAGE_KEY = 'tabkebabSettings';

/**
 * Per-feature on/off switches. Every feature defaults ON; turning one off
 * hides its UI, stops its schedules and refuses its message actions, but
 * never deletes its data. Missing keys (legacy settings) read as ON.
 */
export const FEATURE_KEYS = Object.freeze([
  'focus',
  'ai',
  'drive',
  'bookmarks',
  'automation',
  'duplicates',
  'sessions',
  'stash',
  'windows',
  'commandBar',
  'search',
]);
const FEATURE_KEY_SET = new Set(FEATURE_KEYS);

export function defaultFeatures() {
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, true]));
}

export const SETTINGS_DEFAULTS = {
  // General
  removeStashAfterRestore: true,
  defaultView: 'tabs',       // tabs | sessions | windows | stash
  theme: 'system',           // system | light | dark

  // Tab Limits
  maxTabsPerWindow: 50,
  recommendedTabsPerWindow: 20,

  // Automation
  autoSaveIntervalHours: 24,
  autoSaveRetentionDays: 7,
  autoKebabAfterHours: 3,    // 0 = off, default 3 hours
  autoStashAfterDays: 0,     // 0 = off

  // Bookmarks
  bookmarkByWindows: false,
  bookmarkByGroups: false,
  bookmarkByDomains: false,
  bookmarkDestination: 'chrome',   // chrome | indexeddb | drive | all
  autoBookmarkOnStash: false,
  compressedExport: false,
  exportHtmlBookmarkToDrive: false,

  // Focus Mode
  focusDefaultProfile: 'coding',
  focusDefaultDuration: 25,
  focusTabAction: 'kebab',          // kebab | stash | group | none
  focusStrictBlocking: false,       // Phase 2: true = close tab vs goBack

  // Google Drive
  autoExportSessionsToDrive: false,
  autoExportStashesToDrive: false,
  autoSyncToDriveIntervalHours: 0, // 0 = manual only
  driveRetentionDays: 30,
  neverDeleteFromDrive: false,

  // Feature switches (all ON by default; see FEATURE_KEYS)
  features: Object.freeze(defaultFeatures()),
};

export const PORTABLE_SETTINGS_KEYS = Object.freeze(Object.keys(SETTINGS_DEFAULTS));

export const SETTINGS_CONSTRAINTS = Object.freeze({
  removeStashAfterRestore: { type: 'boolean' },
  defaultView: { enum: ['tabs', 'windows', 'stash', 'sessions'] },
  theme: { enum: ['system', 'light', 'dark'] },
  maxTabsPerWindow: { type: 'integer', min: 1, max: 500 },
  recommendedTabsPerWindow: { type: 'integer', min: 1, max: 500 },
  autoSaveIntervalHours: { type: 'integer', min: 1, max: 168 },
  autoSaveRetentionDays: { type: 'integer', min: 1, max: 365 },
  autoKebabAfterHours: { type: 'integer', min: 0, max: 720 },
  autoStashAfterDays: { type: 'integer', min: 0, max: 365 },
  bookmarkByWindows: { type: 'boolean' },
  bookmarkByGroups: { type: 'boolean' },
  bookmarkByDomains: { type: 'boolean' },
  bookmarkDestination: { enum: ['chrome', 'indexeddb', 'drive', 'all'] },
  autoBookmarkOnStash: { type: 'boolean' },
  compressedExport: { type: 'boolean' },
  exportHtmlBookmarkToDrive: { type: 'boolean' },
  focusDefaultProfile: { enum: ['coding', 'writing', 'research', 'meeting'] },
  focusDefaultDuration: { type: 'integer', min: 1, max: 480 },
  focusTabAction: { enum: ['kebab', 'stash', 'group', 'none'] },
  focusStrictBlocking: { type: 'boolean' },
  autoExportSessionsToDrive: { type: 'boolean' },
  autoExportStashesToDrive: { type: 'boolean' },
  autoSyncToDriveIntervalHours: { type: 'integer', min: 0, max: 168 },
  driveRetentionDays: { type: 'integer', min: 1, max: 365 },
  neverDeleteFromDrive: { type: 'boolean' },
  features: { type: 'features' },
});

const SETTINGS_KEYS = PORTABLE_SETTINGS_KEYS;
const SETTINGS_KEY_SET = new Set(SETTINGS_KEYS);
const SETTINGS_ENVELOPE_KEYS = new Set(['settings', 'savedAt', 'version']);

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function assertPlainOwnPatch(input) {
  if (!isPlainRecord(input)) throw new TypeError('Settings patch must be a plain object');
  assertBoundedDriveJsonValue(input);
  for (const key of Object.keys(input)) {
    if (!SETTINGS_KEY_SET.has(key)) throw new TypeError(`Unknown setting: ${key}`);
  }
}

/**
 * Validate a (possibly partial) `features` object: a plain object whose keys
 * are known feature names and whose values are booleans. Throws otherwise.
 */
export function assertFeaturesPatch(value) {
  if (!isPlainRecord(value)) throw new TypeError('features must be an object');
  for (const key of Object.keys(value)) {
    if (!FEATURE_KEY_SET.has(key)) throw new TypeError(`features contains unknown feature ${key}`);
    if (typeof value[key] !== 'boolean') throw new TypeError(`features.${key} must be a boolean`);
  }
}

/**
 * Merge a partial features patch over a base features object. Missing keys
 * (and malformed base values) read as ON, so legacy settings load all-on.
 * The result always lists every feature, in FEATURE_KEYS order.
 */
export function mergeFeatures(base, patch = {}) {
  const source = isPlainRecord(base) ? base : {};
  const merged = {};
  for (const key of FEATURE_KEYS) {
    if (Object.hasOwn(patch, key)) merged[key] = patch[key];
    else merged[key] = typeof source[key] === 'boolean' ? source[key] : true;
  }
  return merged;
}

/** Whether `name` is on in `settings` (missing settings/keys read as ON). */
export function isFeatureOn(settings, name) {
  return settings?.features?.[name] !== false;
}

function validateSettingValue(key, value) {
  const constraint = SETTINGS_CONSTRAINTS[key];
  if (constraint.type === 'features') {
    assertFeaturesPatch(value);
    return;
  }
  if (constraint.type === 'boolean') {
    if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`);
    return;
  }
  if (constraint.type === 'integer') {
    if (!Number.isInteger(value) || value < constraint.min || value > constraint.max) {
      throw new TypeError(`${key} must be an integer from ${constraint.min} to ${constraint.max}`);
    }
    return;
  }
  if (constraint.enum && !constraint.enum.includes(value)) {
    throw new TypeError(`${key} must be one of: ${constraint.enum.join(', ')}`);
  }
}

function canonicalCurrentSettings(currentSettings) {
  const canonical = {};
  const current = isPlainRecord(currentSettings) ? currentSettings : {};
  for (const key of SETTINGS_KEYS) {
    canonical[key] = Object.hasOwn(current, key) ? current[key] : SETTINGS_DEFAULTS[key];
  }
  // Legacy or partial stored features: fill every missing switch with ON.
  canonical.features = mergeFeatures(canonical.features);
  return canonical;
}

/**
 * Validate an own-property partial patch and return one complete allowlisted
 * settings object merged over defaults/current values.
 */
export function validateSettingsPatch(input, currentSettings = SETTINGS_DEFAULTS) {
  assertPlainOwnPatch(input);
  const canonical = canonicalCurrentSettings(currentSettings);
  for (const key of Object.keys(input)) {
    if (key === 'features') {
      // A features patch may be partial: validate it, then merge it over the
      // current switches so unspecified features keep their value.
      assertFeaturesPatch(input.features);
      canonical.features = mergeFeatures(canonical.features, input.features);
    } else {
      canonical[key] = input[key];
    }
  }
  for (const key of SETTINGS_KEYS) validateSettingValue(key, canonical[key]);
  if (canonical.recommendedTabsPerWindow > canonical.maxTabsPerWindow) {
    throw new TypeError('recommendedTabsPerWindow cannot exceed maxTabsPerWindow');
  }
  return canonical;
}

/**
 * Parse and canonicalize the legacy Drive settings envelope. Task 7 keeps the
 * settings schema at version 1 while bounding and allowlisting every field.
 */
export function parseDriveSettingsDocument(input) {
  assertBoundedDriveJsonValue(input);
  if (!isPlainRecord(input)) throw new TypeError('Drive settings document must be a plain object');
  for (const key of Object.keys(input)) {
    if (!SETTINGS_ENVELOPE_KEYS.has(key)) throw new TypeError(`Unknown Drive settings field: ${key}`);
  }
  if (!Object.hasOwn(input, 'settings') || !isPlainRecord(input.settings)) {
    throw new TypeError('Drive settings document requires an own settings object');
  }
  if (Object.hasOwn(input, 'version') && input.version !== 1) {
    throw new TypeError('Unsupported Drive settings version');
  }
  if (Object.hasOwn(input, 'savedAt') &&
      (!Number.isSafeInteger(input.savedAt) || input.savedAt < 0 || input.savedAt > MAX_DRIVE_TIMESTAMP)) {
    throw new TypeError('Drive settings savedAt must be a valid timestamp');
  }

  const output = { settings: validateSettingsPatch(input.settings, SETTINGS_DEFAULTS) };
  if (Object.hasOwn(input, 'savedAt')) output.savedAt = input.savedAt;
  if (Object.hasOwn(input, 'version')) output.version = 1;
  return output;
}

/**
 * Get all settings, merged with defaults for any missing keys.
 */
export async function getSettings() {
  const stored = await Storage.get(STORAGE_KEY);
  const storedPatch = {};
  if (stored !== null) {
    if (!isPlainRecord(stored)) throw new TypeError('Stored settings must be a plain object');
    for (const key of SETTINGS_KEYS) {
      if (!Object.hasOwn(stored, key)) continue;
      // Stored switches are read leniently (unknown or malformed entries
      // fall back to ON) so a downgrade can never lock the panel out.
      storedPatch[key] = key === 'features' ? mergeFeatures(stored.features) : stored[key];
    }
  }
  return validateSettingsPatch(storedPatch, SETTINGS_DEFAULTS);
}

/**
 * Save full settings object (merges with defaults).
 */
export async function saveSettings(settings) {
  const current = await getSettings();
  const canonical = validateSettingsPatch(settings, current);
  await Storage.set(STORAGE_KEY, canonical);
  return canonical;
}

/**
 * Get a single setting value by key.
 */
export async function getSetting(key) {
  const settings = await getSettings();
  return settings[key];
}

/**
 * Set a single setting value by key.
 */
export async function setSetting(key, value) {
  return saveSettings({ [key]: value });
}

/**
 * A settings import must never make Drive retention more destructive than the
 * local configuration: keep `neverDeleteFromDrive` on and never shorten
 * `driveRetentionDays`.
 */
export function preserveDriveRetentionGuards(current, replacement) {
  const next = { ...replacement };
  if (current?.neverDeleteFromDrive === true) next.neverDeleteFromDrive = true;
  const localDays = Number.isInteger(current?.driveRetentionDays)
    ? current.driveRetentionDays
    : SETTINGS_DEFAULTS.driveRetentionDays;
  if (!Number.isInteger(next.driveRetentionDays) || next.driveRetentionDays < localDays) {
    next.driveRetentionDays = localDays;
  }
  return next;
}
