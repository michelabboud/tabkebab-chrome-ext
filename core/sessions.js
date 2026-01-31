// core/sessions.js — Session save/restore/list/delete (v2: window-aware)

import { getAllTabs } from './tabs-api.js';
import { Storage } from './storage.js';
import { normalizeUrl } from './duplicates.js';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * URLs that cannot be opened programmatically by extensions.
 */
function isRestorableUrl(url) {
  if (!url) return false;
  const blocked = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://'];
  return !blocked.some(prefix => url.startsWith(prefix));
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
      title: g.title || '',
      color: g.color || 'grey',
      collapsed: g.collapsed || false,
    });
  }

  // Group tabs by windowId, preserving tab order
  const windowMap = new Map();
  for (const t of tabs) {
    if (!windowMap.has(t.windowId)) windowMap.set(t.windowId, { tabs: [], groupIds: new Set() });
    const entry = windowMap.get(t.windowId);

    const savedTab = {
      url: t.url,
      title: t.title,
      favIconUrl: t.favIconUrl,
      pinned: t.pinned || false,
    };

    // Save group membership (groupId -1 means ungrouped)
    if (t.groupId !== undefined && t.groupId !== -1) {
      savedTab.groupId = t.groupId;
      entry.groupIds.add(t.groupId);
    }

    entry.tabs.push(savedTab);
  }

  const windows = [];
  for (const [, entry] of windowMap) {
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

  const session = {
    id: generateId(),
    name,
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

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 50;

// Lazy restore for large tab sets (>20 tabs)
const LAZY_THRESHOLD = 20;
const LAZY_BATCH_SIZE = 5;
const LAZY_DELAY_MS = 800;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Restore Chrome tab groups after tabs have been created.
 * Maps saved groupIds to actual tab IDs and recreates groups.
 */
async function restoreGroups(savedTabs, createdTabs, groups, windowId, result) {
  // Build a map: old groupId → [actual tab IDs]
  const groupTabMap = new Map();
  for (let i = 0; i < savedTabs.length && i < createdTabs.length; i++) {
    const gid = savedTabs[i].groupId;
    if (gid !== undefined && gid !== -1) {
      if (!groupTabMap.has(gid)) groupTabMap.set(gid, []);
      groupTabMap.get(gid).push(createdTabs[i].id);
    }
  }

  // Index saved group metadata by id
  const groupMetaMap = new Map();
  for (const g of groups) {
    groupMetaMap.set(g.id, g);
  }

  // Create each group
  for (const [oldGid, tabIds] of groupTabMap) {
    if (tabIds.length === 0) continue;
    const meta = groupMetaMap.get(oldGid);

    try {
      const newGroupId = await chrome.tabs.group({
        createProperties: { windowId },
        tabIds,
      });

      if (meta) {
        const updateProps = {};
        if (meta.title) updateProps.title = meta.title;
        if (meta.color) updateProps.color = meta.color;
        if (meta.collapsed) updateProps.collapsed = meta.collapsed;
        if (Object.keys(updateProps).length > 0) {
          await chrome.tabGroups.update(newGroupId, updateProps);
        }
      }

      result.groupsRestored++;
    } catch {
      // Group creation can fail if tabs were closed in the meantime
    }
  }
}

/**
 * Restore a saved session.
 * @param {string} sessionId
 * @param {Object} [options]
 * @param {string} [options.mode='windows'] - 'windows' | 'here' | 'single-window'
 * @param {Function} [options.onProgress] - callback(current, total) called after each batch
 * @returns {Promise<Object>} RestoreResult
 */
export async function restoreSession(sessionId, options = {}) {
  const mode = options.mode || 'windows';
  const onProgress = options.onProgress || null;

  const sessions = (await Storage.get('sessions')) || [];
  let session = sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Session not found');

  // Migrate v1 → v2 if needed
  session = migrateV1toV2(session);

  // Build set of currently open URLs for dedup
  const openTabs = await getAllTabs({ allWindows: true });
  const openUrls = new Set();
  for (const t of openTabs) {
    if (t.url) openUrls.add(normalizeUrl(t.url));
  }

  const result = {
    restoredCount: 0,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    windowsCreated: 0,
    groupsRestored: 0,
    errors: [],
  };

  // Collect restorable tabs per window, filtering out dupes and invalid URLs
  const windowBatches = [];
  for (const win of session.windows) {
    const restorable = [];
    for (const tab of win.tabs) {
      if (!isRestorableUrl(tab.url)) {
        result.skippedInvalid++;
        continue;
      }
      const norm = normalizeUrl(tab.url);
      if (openUrls.has(norm)) {
        result.skippedDuplicate++;
        continue;
      }
      // Mark as "will be open" so cross-window dupes within the session are also caught
      openUrls.add(norm);
      restorable.push(tab);
    }
    if (restorable.length > 0) {
      windowBatches.push({ tabs: restorable, groups: win.groups || [] });
    }
  }

  const allRestorable = windowBatches.flatMap(wb => wb.tabs);

  if (allRestorable.length === 0) {
    return result;
  }

  // Choose lazy vs normal batching based on total tab count
  const totalCount = allRestorable.length;
  const lazy = totalCount > LAZY_THRESHOLD;
  const batchSize = lazy ? LAZY_BATCH_SIZE : BATCH_SIZE;
  const batchDelay = lazy ? LAZY_DELAY_MS : BATCH_DELAY_MS;

  if (mode === 'windows') {
    // Each saved window → new Chrome window
    for (const { tabs, groups } of windowBatches) {
      try {
        // Create window with first tab
        const win = await chrome.windows.create({ url: tabs[0].url });
        result.windowsCreated++;
        result.restoredCount++;
        if (onProgress) onProgress(result.restoredCount, totalCount);

        const windowId = win.id;

        // Add remaining tabs in batches
        for (let i = 1; i < tabs.length; i += batchSize) {
          const batch = tabs.slice(i, i + batchSize);
          const created = await Promise.all(
            batch.map(tab =>
              chrome.tabs.create({ windowId, url: tab.url, active: false })
            )
          );
          result.restoredCount += batch.length;
          if (onProgress) onProgress(result.restoredCount, totalCount);

          // Per-batch discard
          for (const ct of created) {
            try { await chrome.tabs.discard(ct.id); } catch { /* ignore */ }
          }

          if (i + batchSize < tabs.length) await sleep(batchDelay);
        }

        // Query created tabs to get their actual IDs
        const createdTabs = await chrome.tabs.query({ windowId });

        // Restore pinned state
        for (let i = 0; i < tabs.length && i < createdTabs.length; i++) {
          if (tabs[i].pinned) {
            try {
              await chrome.tabs.update(createdTabs[i].id, { pinned: true });
            } catch { /* Tab may have been closed */ }
          }
        }

        // Restore tab groups
        if (groups.length > 0) {
          await restoreGroups(tabs, createdTabs, groups, windowId, result);
        }
      } catch (err) {
        result.errors.push(`Window creation failed: ${err.message}`);
      }
    }
  } else if (mode === 'here') {
    // All tabs in current window
    for (let i = 0; i < allRestorable.length; i += batchSize) {
      const batch = allRestorable.slice(i, i + batchSize);
      const created = await Promise.all(
        batch.map(tab =>
          chrome.tabs.create({ url: tab.url, active: false, pinned: tab.pinned || false })
        )
      );
      result.restoredCount += batch.length;
      if (onProgress) onProgress(result.restoredCount, totalCount);

      // Per-batch discard
      for (const ct of created) {
        try { await chrome.tabs.discard(ct.id); } catch { /* ignore */ }
      }

      if (i + batchSize < allRestorable.length) await sleep(batchDelay);
    }
  } else if (mode === 'single-window') {
    // All tabs in one new window
    try {
      const win = await chrome.windows.create({ url: allRestorable[0].url });
      result.windowsCreated++;
      result.restoredCount++;
      if (onProgress) onProgress(result.restoredCount, totalCount);

      const windowId = win.id;
      for (let i = 1; i < allRestorable.length; i += batchSize) {
        const batch = allRestorable.slice(i, i + batchSize);
        const created = await Promise.all(
          batch.map(tab =>
            chrome.tabs.create({ windowId, url: tab.url, active: false })
          )
        );
        result.restoredCount += batch.length;
        if (onProgress) onProgress(result.restoredCount, totalCount);

        // Per-batch discard
        for (const ct of created) {
          try { await chrome.tabs.discard(ct.id); } catch { /* ignore */ }
        }

        if (i + batchSize < allRestorable.length) await sleep(batchDelay);
      }

      // Restore pinned state
      const createdTabs = await chrome.tabs.query({ windowId });
      for (let i = 0; i < allRestorable.length && i < createdTabs.length; i++) {
        if (allRestorable[i].pinned) {
          try {
            await chrome.tabs.update(createdTabs[i].id, { pinned: true });
          } catch {
            // Tab may have been closed
          }
        }
      }
    } catch (err) {
      result.errors.push(`Window creation failed: ${err.message}`);
    }
  }

  return result;
}

// ── List / Delete ──

export async function listSessions() {
  const sessions = (await Storage.get('sessions')) || [];
  // Return with v2 migration applied (for display purposes)
  return sessions.map(migrateV1toV2);
}

export async function deleteSession(sessionId) {
  const sessions = (await Storage.get('sessions')) || [];
  const filtered = sessions.filter(s => s.id !== sessionId);
  await Storage.set('sessions', filtered);
}
