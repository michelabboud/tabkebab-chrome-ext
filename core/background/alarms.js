// core/background/alarms.js — Managed alarm schedule (reconcile with
// settings) and alarm → automation dispatch.

import { getSettings, isFeatureOn } from '../settings.js';
import { withStateMutationLock } from '../state-mutation-lock.js';
import { autoSaveSession } from './sessions.js';
import { autoKebabOldTabs } from './tabs.js';
import { autoStashOldTabs } from './stash.js';
import { autoSyncDrive, runRetentionCleanup } from './drive.js';
import { createBookmarks } from './bookmarks.js';

// ── Alarm names ──

export const ALARM_AUTO_SAVE = 'autoSaveSession';
export const ALARM_AUTO_KEBAB = 'autoKebab';
export const ALARM_AUTO_STASH = 'autoStash';
export const ALARM_AUTO_SYNC_DRIVE = 'autoSyncDrive';
export const ALARM_RETENTION_CLEANUP = 'retentionCleanup';
export const ALARM_AUTO_BOOKMARK = 'autoBookmark';
export const ALARM_FOCUS_TICK = 'focusTick';

// ── Alarm system ──

/**
 * Desired period (minutes) for every managed alarm; `null` means disabled.
 * Exported for tests.
 */
export function desiredManagedAlarmPeriods(settings) {
  const bookmarkFormat = settings.bookmarkByWindows || settings.bookmarkByGroups || settings.bookmarkByDomains;
  // Feature switches (Settings → Features). An off feature has no alarms.
  const automation = isFeatureOn(settings, 'automation');
  const drive = isFeatureOn(settings, 'drive');
  const bookmarks = isFeatureOn(settings, 'bookmarks');
  const stash = isFeatureOn(settings, 'stash');
  const sessions = isFeatureOn(settings, 'sessions');
  return {
    [ALARM_AUTO_SAVE]: automation && sessions ? (settings.autoSaveIntervalHours || 24) * 60 : null,
    [ALARM_AUTO_KEBAB]: automation && settings.autoKebabAfterHours > 0 ? 60 : null,
    [ALARM_AUTO_STASH]: automation && stash && settings.autoStashAfterDays > 0 ? 360 : null,
    [ALARM_AUTO_SYNC_DRIVE]: drive && settings.autoSyncToDriveIntervalHours > 0
      ? settings.autoSyncToDriveIntervalHours * 60
      : null,
    // Retention prunes old auto-saves (automation) and old Drive files (drive).
    [ALARM_RETENTION_CLEANUP]: automation || drive ? 720 : null,
    [ALARM_AUTO_BOOKMARK]: bookmarks && settings.autoBookmarkOnStash && bookmarkFormat ? 720 : null,
  };
}

/**
 * Feature(s) each managed alarm belongs to. A scheduled run whose feature
 * was switched off after the alarm fired is skipped. Retention is handled
 * inside runRetentionCleanup (it serves two features).
 */
export const ALARM_FEATURES = Object.freeze({
  [ALARM_AUTO_SAVE]: Object.freeze(['automation', 'sessions']),
  [ALARM_AUTO_KEBAB]: Object.freeze(['automation']),
  [ALARM_AUTO_STASH]: Object.freeze(['automation', 'stash']),
  [ALARM_AUTO_SYNC_DRIVE]: Object.freeze(['drive']),
  [ALARM_AUTO_BOOKMARK]: Object.freeze(['bookmarks']),
});

function loadFeatureSettings() {
  return getSettings();
}

/**
 * Reconcile managed alarms with settings. An alarm whose period is already
 * correct is left untouched: re-creating it on every browser startup or
 * settings save would reset its countdown, so long intervals (e.g. 24h
 * auto-save on a browser restarted daily) would never fire. Only missing or
 * changed alarms are (re)created, and disabled ones are cleared.
 */
export async function reconfigureAlarms(settings) {
  if (!settings) settings = await getSettings();
  const failures = [];

  const runAlarmOperation = async (operation, name, callback) => {
    try {
      await callback();
    } catch (error) {
      console.warn(`[TabKebab] alarm ${operation} failed:`, name, error);
      failures.push(error instanceof Error ? error : new Error(`Alarm ${operation} failed: ${name}`));
    }
  };

  const desired = desiredManagedAlarmPeriods(settings);
  for (const [name, period] of Object.entries(desired)) {
    let existing = null;
    try {
      existing = (await chrome.alarms.get(name)) || null;
    } catch (error) {
      // Unknown state: fall through to the clear/create path below.
      console.warn('[TabKebab] alarm get failed:', name, error);
      existing = undefined;
    }

    if (period === null) {
      if (existing !== null) {
        await runAlarmOperation('clear', name, () => chrome.alarms.clear(name));
      }
      continue;
    }

    if (existing && existing.periodInMinutes === period) continue;

    // chrome.alarms.create replaces an alarm with the same name.
    await runAlarmOperation('create', name, () => chrome.alarms.create(
      name,
      { delayInMinutes: period, periodInMinutes: period },
    ));
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more managed alarms could not be reconfigured');
  }
}

export async function reconfigureManagedAlarms({ reconfigure = reconfigureAlarms } = {}) {
  return withStateMutationLock(() => reconfigure());
}

/**
 * Build the alarm handler. Alarms go through one exported seam so scheduled
 * portable-state writers use the same locked coordinators as runtime
 * messages. `onFocusTick` runs the Focus tick behind the worker's own
 * startup barrier (see focus.js `scheduleFocusTick`).
 */
export function createAlarmHandler({ onFocusTick }) {
  return async function handleAlarm(alarm, {
    runAutoSave = autoSaveSession,
    runAutoKebab = autoKebabOldTabs,
    runAutoStash = autoStashOldTabs,
    runAutoSync = autoSyncDrive,
    runRetention = runRetentionCleanup,
    runAutoBookmark = () => createBookmarks(),
    loadSettings = loadFeatureSettings,
  } = {}) {
    const features = Object.hasOwn(ALARM_FEATURES, alarm.name) ? ALARM_FEATURES[alarm.name] : null;
    if (features) {
      let settings = null;
      try {
        settings = await loadSettings();
      } catch {
        settings = null; // unreadable settings: never block a scheduled run
      }
      if (settings && features.some((feature) => !isFeatureOn(settings, feature))) return null;
    }
    switch (alarm.name) {
      case ALARM_AUTO_SAVE:      return runAutoSave();
      case ALARM_AUTO_KEBAB:     return runAutoKebab();
      case ALARM_AUTO_STASH:     return runAutoStash();
      case ALARM_AUTO_SYNC_DRIVE: return runAutoSync();
      case ALARM_RETENTION_CLEANUP: return runRetention();
      case ALARM_AUTO_BOOKMARK:  return runAutoBookmark();
      case ALARM_FOCUS_TICK:
        onFocusTick();
        return null;
      default:
        return null;
    }
  };
}
