// core/background/stash.js — Stash capture (window/group/domain/auto-stash),
// the shared save-before-close boundary, restore, delete and undo.

import { getAllTabs, excludeIncognitoTabs, closeTabs, extractDomain } from '../tabs-api.js';
import { saveStash, listStashes as listStashesDB, getStash, deleteStash as deleteStashDB, restoreStashTabs, importStashes as importStashesDB } from '../stash-db.js';
import { isRestorableUrl, sanitizeCapturedGroupTitle, sanitizeStashableTab } from '../tab-restore.js';
import { shouldDeleteRestoredSource } from '../restore-outcome.js';
import { getSettings } from '../settings.js';
import { withStateMutationLock } from '../state-mutation-lock.js';
import { getKeepAwakeList } from './tabs.js';
import { createBookmarksUnlocked } from './bookmarks.js';

// ── Auto-stash ──

async function autoStashOldTabsUnlocked() {
  try {
    const settings = await getSettings();
    if (settings.autoStashAfterDays <= 0) return;

    const keepAwake = new Set(await getKeepAwakeList());
    const tabs = await getAllTabs({ allWindows: true, excludeIncognito: true });
    const thresholdMs = settings.autoStashAfterDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - thresholdMs;

    // Group old tabs by window
    const windowBuckets = new Map();
    for (const tab of tabs) {
      if (tab.active) continue;
      // Pinned and audio-playing tabs are in use even when not focused.
      if (tab.pinned || tab.audible) continue;
      if (keepAwake.has(extractDomain(tab.url))) continue;
      if ((tab.lastAccessed || Date.now()) > cutoff) continue;
      // Never select a tab restore could not reopen: it must stay open.
      if (!isRestorableUrl(tab.url)) continue;

      if (!windowBuckets.has(tab.windowId)) windowBuckets.set(tab.windowId, []);
      windowBuckets.get(tab.windowId).push(tab);
    }

    for (const [, oldTabs] of windowBuckets) {
      if (oldTabs.length === 0) continue;

      const stashTabs = [];
      const capturedTabs = [];
      for (const t of oldTabs) {
        const saved = sanitizeStashableTab({
          url: t.url, title: t.title, favIconUrl: t.favIconUrl, pinned: t.pinned || false,
        });
        if (!saved) continue;
        stashTabs.push(saved);
        capturedTabs.push(t);
      }
      // Never close a tab that was not captured into the stash.
      if (stashTabs.length === 0) continue;

      const stashId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const stash = {
        id: stashId,
        name: `[Auto-stash] ${stashTabs.length} idle tabs`,
        source: 'auto',
        sourceDetail: 'auto-stash',
        createdAt: Date.now(),
        tabCount: stashTabs.length,
        windows: [{ tabCount: stashTabs.length, tabs: stashTabs }],
      };

      await persistCapturedStash({
        stash,
        capturedTabs,
        emptyError: 'No stashable old tabs',
        save: (record) => saveStashThenAutoBookmark(record, capturedTabs),
      });
    }
  } catch (e) { console.warn('[TabKebab] auto-stash failed:', e); }
}

export async function autoStashOldTabs() {
  return withStateMutationLock(() => autoStashOldTabsUnlocked());
}

/**
 * Commit a fully captured stash before closing only the represented source
 * tabs. Every stash path shares this boundary so a rejected write or an empty
 * capture can never destroy a tab that is not recoverable from the stash.
 */
export async function persistCapturedStash({
  stash,
  capturedTabs,
  emptyError,
  save = saveStash,
  close = closeTabs,
}) {
  // Restore refuses non-restorable URLs (chrome:, about:, data:, extension
  // pages…), so such tabs are neither stored nor closed: they stay open.
  const restorableTabs = Array.isArray(capturedTabs)
    ? capturedTabs.filter((tab) => isRestorableUrl(tab?.url))
    : [];
  if (stash && Array.isArray(stash.windows)) {
    let total = 0;
    const windows = [];
    for (const window of stash.windows) {
      const tabs = Array.isArray(window?.tabs)
        ? window.tabs.filter((tab) => isRestorableUrl(tab?.url))
        : [];
      if (tabs.length === 0) continue;
      total += tabs.length;
      windows.push({ ...window, tabs, tabCount: tabs.length });
    }
    stash = { ...stash, windows, tabCount: total };
  }
  if (restorableTabs.length === 0 || !(stash?.tabCount > 0)) {
    return { error: emptyError };
  }

  await save(stash);
  const closableIds = restorableTabs
    .filter((tab) => Number.isInteger(tab?.id))
    .map((tab) => tab.id);
  if (closableIds.length > 0) await close(closableIds);
  return { success: true, stash };
}

/**
 * Stash save step that also auto-bookmarks exactly the captured tabs. It is
 * passed as `persistCapturedStash({ save })`, so bookmarks are written after
 * the stash commits but before any source tab is closed. A bookmark failure
 * never blocks or fails the stash.
 */
async function saveStashThenAutoBookmark(stash, capturedTabs, {
  save = saveStash,
  loadSettings = getSettings,
  bookmark = createBookmarksUnlocked,
} = {}) {
  await save(stash);
  try {
    const settings = await loadSettings();
    const anyFormat = settings.bookmarkByWindows || settings.bookmarkByGroups || settings.bookmarkByDomains;
    if (!settings.autoBookmarkOnStash || !anyFormat) return;
    await bookmark({
      tabs: Array.isArray(capturedTabs)
        ? capturedTabs.filter((tab) => isRestorableUrl(tab?.url))
        : [],
      stashName: typeof stash?.name === 'string' ? stash.name : 'Stash',
    });
  } catch (e) {
    console.warn('[TabKebab] auto-bookmark on stash failed:', e);
  }
}

/**
 * Apply the storage policy for one completed stash restore.
 * Incomplete outcomes leave the original IndexedDB record untouched.
 */
export async function applyStashRestoreDisposition(
  stash,
  restoreResult,
  removeAfterRestore,
  {
    deleteSource = deleteStashDB,
    saveSource = saveStash,
  } = {},
) {
  if (shouldDeleteRestoredSource(restoreResult, removeAfterRestore)) {
    await deleteSource(stash.id);
    return { deleted: true, markedRestored: false };
  }

  if (restoreResult.complete && restoreResult.restoredCount > 0) {
    await saveSource({ ...stash, restoredAt: Date.now() });
    return { deleted: false, markedRestored: true };
  }

  return { deleted: false, markedRestored: false };
}

// ── Message handlers ──

export const stashHandlers = {
  async stashWindow(msg) {
    return withStateMutationLock(async () => {
    const tabs = await getAllTabs({ allWindows: true, excludeIncognito: true });
    const windowTabs = tabs.filter(t => t.windowId === msg.windowId);
    if (windowTabs.length === 0) return { error: 'No tabs in window' };

    let chromeGroups = [];
    try { chromeGroups = await chrome.tabGroups.query({ windowId: msg.windowId }); } catch (e) { console.warn('[TabKebab] tabGroups query failed:', e); }

    const groupMeta = new Map();
    for (const g of chromeGroups) {
      groupMeta.set(g.id, { title: sanitizeCapturedGroupTitle(g.title), color: g.color || 'grey', collapsed: g.collapsed || false });
    }

    const stashTabs = [];
    const groupIds = new Set();
    const capturedTabs = [];
    for (const t of windowTabs) {
      const saved = sanitizeStashableTab({ url: t.url, title: t.title, favIconUrl: t.favIconUrl, pinned: t.pinned || false });
      if (!saved) continue;
      if (t.groupId !== undefined && t.groupId !== -1) {
        saved.groupId = t.groupId;
        groupIds.add(t.groupId);
      }
      stashTabs.push(saved);
      capturedTabs.push(t);
    }
    const groups = [];
    for (const gid of groupIds) {
      const meta = groupMeta.get(gid);
      if (meta) groups.push({ id: gid, ...meta });
    }

    const stashId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const stash = {
      id: stashId,
      name: `Window ${msg.windowNumber || '?'}`,
      source: 'window',
      sourceDetail: String(msg.windowId),
      createdAt: Date.now(),
      tabCount: stashTabs.length,
      windows: [{ tabCount: stashTabs.length, tabs: stashTabs, ...(groups.length > 0 ? { groups } : {}) }],
    };

    const committed = await persistCapturedStash({
      stash,
      capturedTabs,
      emptyError: 'No stashable tabs in window',
      // Auto-bookmark exactly the captured tabs, before they are closed.
      save: (record) => saveStashThenAutoBookmark(record, capturedTabs),
    });
    return committed;
    });
  },

  async stashGroup(msg) {
    return withStateMutationLock(async () => {
    const groupTabs = excludeIncognitoTabs(await chrome.tabs.query({ groupId: msg.groupId }));
    if (groupTabs.length === 0) return { error: 'No tabs in group' };

    let groupInfo = { title: 'Untitled', color: 'grey', collapsed: false };
    try {
      const g = await chrome.tabGroups.get(msg.groupId);
      groupInfo = { title: sanitizeCapturedGroupTitle(g.title) || 'Untitled', color: g.color || 'grey', collapsed: g.collapsed || false };
    } catch (e) { console.warn('[TabKebab] stash failed:', e); }

    const stashTabs = [];
    const capturedTabs = [];
    for (const t of groupTabs) {
      const saved = sanitizeStashableTab({
        url: t.url, title: t.title, favIconUrl: t.favIconUrl,
        pinned: t.pinned || false, groupId: msg.groupId,
      });
      if (!saved) continue;
      stashTabs.push(saved);
      capturedTabs.push(t);
    }
    const stashId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const stash = {
      id: stashId,
      name: `${groupInfo.title} [group]`,
      source: 'group',
      sourceDetail: groupInfo.title,
      createdAt: Date.now(),
      tabCount: stashTabs.length,
      windows: [{
        tabCount: stashTabs.length,
        tabs: stashTabs,
        groups: [{ id: msg.groupId, ...groupInfo }],
      }],
    };

    return await persistCapturedStash({
      stash,
      capturedTabs,
      emptyError: 'No stashable tabs in group',
      save: (record) => saveStashThenAutoBookmark(record, capturedTabs),
    });
    });
  },

  async stashDomain(msg) {
    return withStateMutationLock(async () => {
    const allTabs = await getAllTabs({ allWindows: true, excludeIncognito: true });
    const domainTabs = allTabs.filter(t => extractDomain(t.url) === msg.domain);
    if (domainTabs.length === 0) return { error: 'No tabs for domain' };

    const windowMap = new Map();
    const capturedTabs = [];
    for (const t of domainTabs) {
      const saved = sanitizeStashableTab({
        url: t.url, title: t.title, favIconUrl: t.favIconUrl, pinned: t.pinned || false,
      });
      if (!saved) continue;
      if (!windowMap.has(t.windowId)) windowMap.set(t.windowId, []);
      windowMap.get(t.windowId).push(saved);
      capturedTabs.push(t);
    }
    const windows = [];
    for (const [, wTabs] of windowMap) {
      windows.push({ tabCount: wTabs.length, tabs: wTabs });
    }

    const stashId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const stash = {
      id: stashId,
      name: msg.domain || 'Blank & browser pages',
      source: 'domain',
      sourceDetail: msg.domain,
      createdAt: Date.now(),
      tabCount: capturedTabs.length,
      windows,
    };

    return await persistCapturedStash({
      stash,
      capturedTabs,
      emptyError: 'No stashable tabs for domain',
      save: (record) => saveStashThenAutoBookmark(record, capturedTabs),
    });
    });
  },

  async listStashes() {
    return listStashesDB();
  },

  async restoreStash(msg) {
    return withStateMutationLock(async () => {
    const stash = await getStash(msg.stashId);
    // "Undo stash" passes ifUnrestored: a stash that was already restored
    // (and removed, or marked restored) must not reopen its tabs again.
    if (msg.ifUnrestored === true) {
      if (!stash) return { alreadyRestored: true, reason: 'missing' };
      if (stash.restoredAt) return { alreadyRestored: true, reason: 'restored' };
    }
    if (!stash) throw new Error('Stash not found');

    const onProgress = ({ created, loaded, total }) => {
      chrome.runtime.sendMessage({
        action: 'restoreProgress',
        restoreId: msg.stashId,
        created,
        loaded,
        total,
      }).catch(() => {});
    };

    const restoreResult = await restoreStashTabs(stash, { ...(msg.options || {}), onProgress });

    // Read removeStashAfterRestore from settings if not overridden in message
    const removeOverride = msg.deleteAfterRestore;
    let shouldRemove;
    if (removeOverride !== undefined) {
      shouldRemove = removeOverride;
    } else {
      const settings = await getSettings();
      shouldRemove = settings.removeStashAfterRestore;
    }

    await applyStashRestoreDisposition(stash, restoreResult, shouldRemove);

    return restoreResult;
    });
  },

  async deleteStash(msg) {
    return withStateMutationLock(async () => {
      await deleteStashDB(msg.stashId);
      return { success: true };
    });
  },

  async undoDeleteStash(msg) {
    return withStateMutationLock(async () => {
      await saveStash(msg.stash);
      return { success: true };
    });
  },

  async importStashes(msg) {
    return withStateMutationLock(() => importStashesDB(msg.stashes || []));
  },
};
