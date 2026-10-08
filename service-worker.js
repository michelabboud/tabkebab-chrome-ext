// service-worker.js — Background service worker (Manifest V3) entry point.
//
// Feature logic lives in core/background/*.js. This file only:
//   1. registers every chrome.* event listener synchronously at top level
//      (an MV3 requirement: listeners added after an await are missed when
//      the worker is woken by that event),
//   2. creates the per-worker runtime state (Focus startup barrier, Focus tab
//      guard, message router), and
//   3. re-exports the worker's public surface.

import { createRouter, createRuntimeMessageListener } from './core/background/router.js';
import { tabHandlers, notifyPanel } from './core/background/tabs.js';
import { sessionHandlers } from './core/background/sessions.js';
import { groupingHandlers } from './core/background/grouping.js';
import { stashHandlers } from './core/background/stash.js';
import { bookmarkHandlers } from './core/background/bookmarks.js';
import { driveHandlers } from './core/background/drive.js';
import { settingsHandlers } from './core/background/settings.js';
import { aiHandlers, attachChromeAIPort } from './core/background/ai.js';
import {
  focusHandlers,
  startFocusReadiness,
  scheduleFocusTick,
  createFocusTabGuard,
} from './core/background/focus.js';
import { createAlarmHandler } from './core/background/alarms.js';
import {
  onBrowserStartup,
  onExtensionInstalled,
  reconcileWorkerStartup,
} from './core/background/lifecycle.js';

// ── Public surface (tests and tooling import these from the entry point) ──

export { autoSaveSession } from './core/background/sessions.js';
export {
  desiredManagedAlarmPeriods,
  reconfigureManagedAlarms,
} from './core/background/alarms.js';
export {
  autoStashOldTabs,
  persistCapturedStash,
  applyStashRestoreDisposition,
} from './core/background/stash.js';
export {
  syncDriveState,
  autoSyncDrive,
  runDriveFileRetention,
  runRetentionCleanup,
} from './core/background/drive.js';
export {
  generateBookmarkHtml,
  createBookmarks,
  MAX_BOOKMARK_DEPTH,
  BOOKMARK_RETENTION_COUNT,
  MAX_BOOKMARKS_PER_EXPORT,
  bookmarkDepthBudget,
  planBookmarkFolderLevels,
  saveToChromeBookmarks,
} from './core/background/bookmarks.js';
export { attachChromeAIPort };

// ── Message router ──
// One router per worker instance. registerHandlers throws on a duplicate
// action, so two features can never silently claim the same message.

const router = createRouter();
router.registerHandlers(tabHandlers);
router.registerHandlers(groupingHandlers);
router.registerHandlers(sessionHandlers);
router.registerHandlers(settingsHandlers);
router.registerHandlers(aiHandlers);
router.registerHandlers(stashHandlers);
router.registerHandlers(driveHandlers);
router.registerHandlers(bookmarkHandlers);
router.registerHandlers(focusHandlers);

/**
 * Handle one runtime message. `options` overrides injectable operations
 * (tests); the Focus startup barrier is always this worker's own.
 */
export function handleMessage(msg, options = {}) {
  return router.dispatch(msg, options, { focusReadiness });
}

// ── Lifecycle Events ──

chrome.runtime.onConnect.addListener((port) => {
  attachChromeAIPort(port);
});

// Auto-save on browser startup
chrome.runtime.onStartup.addListener(() => onBrowserStartup());

// Auto-save on extension install/update
chrome.runtime.onInstalled.addListener((details) => onExtensionInstalled(details));

// Handle alarms through one exported seam so scheduled portable-state writers
// use the same locked coordinators as runtime messages.
export const handleAlarm = createAlarmHandler({
  onFocusTick: () => scheduleFocusTick(focusReadiness),
});

chrome.alarms.onAlarm.addListener((alarm) => handleAlarm(alarm));

// Rebind persisted group titles before any Focus listener can trust runtime IDs.
// Listeners still register synchronously, then await this shared startup barrier.
const focusReadiness = startFocusReadiness();

// Ensure alarms exist (service worker can restart)
void reconcileWorkerStartup(focusReadiness);

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Notify the side panel when tabs change; Focus mode intercepts blocked URLs.
const focusTabGuard = createFocusTabGuard({ focusReadiness });

chrome.tabs.onCreated.addListener(async (tab) => {
  notifyPanel();
  await focusTabGuard.onTabCreated(tab);
});
chrome.tabs.onRemoved.addListener(notifyPanel);
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    notifyPanel();
  }
  await focusTabGuard.onTabUpdated(tabId, changeInfo, tab);
});

// Message handler — side panel communicates via chrome.runtime.sendMessage
chrome.runtime.onMessage.addListener(createRuntimeMessageListener(handleMessage));
