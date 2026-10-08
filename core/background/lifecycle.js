// core/background/lifecycle.js — Browser startup, extension install/update,
// and service-worker (re)start work. The listeners themselves are registered
// at the top level of service-worker.js.

import { AIClient } from '../ai/ai-client.js';
import { getSettings, isFeatureOn } from '../settings.js';
import { FocusStatus, updateBadge } from '../focus.js';
import { autoSaveSession } from './sessions.js';
import { ALARM_AUTO_SAVE, ALARM_FOCUS_TICK, reconfigureManagedAlarms } from './alarms.js';

/**
 * Startup/install auto-save is an Automation chore that writes a session:
 * skipped while Automation or Sessions is switched off.
 */
export async function autoSaveIfEnabled({
  loadSettings = getSettings,
  autoSave = autoSaveSession,
} = {}) {
  let settings = null;
  try {
    settings = await loadSettings();
  } catch {
    settings = null; // unreadable settings: keep the historical behavior
  }
  if (settings && (!isFeatureOn(settings, 'automation') || !isFeatureOn(settings, 'sessions'))) {
    return null;
  }
  return autoSave();
}

// Auto-save on browser startup
export function onBrowserStartup() {
  setTimeout(async () => {
    try {
      await autoSaveIfEnabled();
      await reconfigureManagedAlarms();
    } catch (error) {
      console.warn('[TabKebab] Startup alarm reconciliation failed:', error);
    }
  }, 5000);
}

// Auto-save on extension install/update + open panel on first install
export async function onExtensionInstalled(details) {
  // Pre-v1.2.14 provider responses were cached without a credential-reflection
  // check. The cache is disposable, so clear it on install/update before use.
  try {
    await AIClient.clearCache();
  } catch {
    console.warn('[TabKebab] AI cache migration failed');
  }

  // Note: sidePanel.open() requires a user gesture, which onInstalled
  // never has, so the panel is not auto-opened here. The toolbar action opens
  // it (setPanelBehavior in service-worker.js) and the first-run walkthrough shows on first
  // open.

  setTimeout(async () => {
    try {
      await autoSaveIfEnabled();
      await reconfigureManagedAlarms();
    } catch (error) {
      console.warn('[TabKebab] Install/update alarm reconciliation failed:', error);
    }
  }, 5000);
}

// Ensure alarms exist (service worker can restart)
export function reconcileWorkerStartup(focusReadiness) {
  return (async () => {
    const focusState = await focusReadiness;

    const alarm = await chrome.alarms.get(ALARM_AUTO_SAVE);
    if (!alarm) await reconfigureManagedAlarms();

    // Restore focus alarm + badge if a session was active before SW restart
    if (focusState?.status === FocusStatus.ACTIVE) {
      const existing = await chrome.alarms.get(ALARM_FOCUS_TICK);
      if (!existing) await chrome.alarms.create(ALARM_FOCUS_TICK, { periodInMinutes: 1 });
      await updateBadge(focusState);
    }
  })().catch((error) => {
    console.warn('[TabKebab] Service-worker alarm reconciliation failed:', error);
  });
}
