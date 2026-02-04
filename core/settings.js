// core/settings.js — Settings schema, defaults, and CRUD

import { Storage } from './storage.js';

const STORAGE_KEY = 'tabkebabSettings';

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
  autoKebabAfterHours: 0,    // 0 = off
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
};

/**
 * Get all settings, merged with defaults for any missing keys.
 */
export async function getSettings() {
  const stored = await Storage.get(STORAGE_KEY);
  return { ...SETTINGS_DEFAULTS, ...(stored || {}) };
}

/**
 * Save full settings object (merges with defaults).
 */
export async function saveSettings(settings) {
  const merged = { ...SETTINGS_DEFAULTS, ...settings };
  await Storage.set(STORAGE_KEY, merged);
  return merged;
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
  const settings = await getSettings();
  settings[key] = value;
  await Storage.set(STORAGE_KEY, settings);
  return settings;
}
