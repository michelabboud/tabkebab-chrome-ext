// core/stash-db.js — IndexedDB storage for stashed tabs

import { getAllTabs } from './tabs-api.js';
import { normalizeUrl } from './duplicates.js';

const DB_NAME = 'TabKebabStash';
const DB_VERSION = 1;
const STORE_NAME = 'stashes';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('by-createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

export async function saveStash(stash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(stash);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listStashes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.objectStore(STORE_NAME).index('by-createdAt');
    const results = [];
    const request = index.openCursor(null, 'prev');

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getStash(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteStash(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllStashes() {
  return listStashes();
}

export async function importStashes(stashes) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  let imported = 0;
  let skipped = 0;

  for (const stash of stashes) {
    const existing = await new Promise((resolve) => {
      const req = store.get(stash.id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    if (existing) {
      skipped++;
    } else {
      store.put(stash);
      imported++;
    }
  }

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return { imported, skipped };
}

export async function clearAllStashes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Restore ──

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 50;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRestorableUrl(url) {
  if (!url) return false;
  const blocked = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://'];
  return !blocked.some(prefix => url.startsWith(prefix));
}

async function restoreGroups(savedTabs, createdTabs, groups, windowId, result) {
  const groupTabMap = new Map();
  for (let i = 0; i < savedTabs.length && i < createdTabs.length; i++) {
    const gid = savedTabs[i].groupId;
    if (gid !== undefined && gid !== -1) {
      if (!groupTabMap.has(gid)) groupTabMap.set(gid, []);
      groupTabMap.get(gid).push(createdTabs[i].id);
    }
  }

  const groupMetaMap = new Map();
  for (const g of groups) {
    groupMetaMap.set(g.id, g);
  }

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
    } catch { /* group creation can fail if tabs were closed */ }
  }
}

/**
 * Restore stashed tabs. Mirrors the session restore logic.
 * @param {Object} stash — Stash object from IndexedDB
 * @param {Object} [options]
 * @param {string} [options.mode='windows'] — 'windows' | 'here'
 * @param {boolean} [options.discarded=true] — restore tabs in discarded state (not loaded until clicked)
 */
export async function restoreStashTabs(stash, options = {}) {
  const mode = options.mode || 'windows';
  const shouldDiscard = options.discarded !== false;

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

  // Collect restorable tabs per window
  const windowBatches = [];
  for (const win of stash.windows) {
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

  if (mode === 'windows') {
    for (const { tabs, groups } of windowBatches) {
      try {
        const win = await chrome.windows.create({ url: tabs[0].url });
        result.windowsCreated++;
        result.restoredCount++;

        const windowId = win.id;

        for (let i = 1; i < tabs.length; i += BATCH_SIZE) {
          const batch = tabs.slice(i, i + BATCH_SIZE);
          await Promise.all(
            batch.map(tab =>
              chrome.tabs.create({ windowId, url: tab.url, active: false })
            )
          );
          result.restoredCount += batch.length;
          if (i + BATCH_SIZE < tabs.length) await sleep(BATCH_DELAY_MS);
        }

        const createdTabs = await chrome.tabs.query({ windowId });

        // Restore pinned state
        for (let i = 0; i < tabs.length && i < createdTabs.length; i++) {
          if (tabs[i].pinned) {
            try {
              await chrome.tabs.update(createdTabs[i].id, { pinned: true });
            } catch { /* tab may have been closed */ }
          }
        }

        // Restore tab groups
        if (groups.length > 0) {
          await restoreGroups(tabs, createdTabs, groups, windowId, result);
        }

        // Discard restored tabs to save memory (skip the active first tab)
        if (shouldDiscard) {
          for (const ct of createdTabs) {
            if (!ct.active) {
              try { await chrome.tabs.discard(ct.id); } catch { /* ignore */ }
            }
          }
        }
      } catch (err) {
        result.errors.push(`Window creation failed: ${err.message}`);
      }
    }
  } else if (mode === 'here') {
    const createdIds = [];
    for (let i = 0; i < allRestorable.length; i += BATCH_SIZE) {
      const batch = allRestorable.slice(i, i + BATCH_SIZE);
      const created = await Promise.all(
        batch.map(tab =>
          chrome.tabs.create({ url: tab.url, active: false, pinned: tab.pinned || false })
        )
      );
      for (const t of created) createdIds.push(t.id);
      result.restoredCount += batch.length;
      if (i + BATCH_SIZE < allRestorable.length) await sleep(BATCH_DELAY_MS);
    }

    // Discard all restored tabs to save memory
    if (shouldDiscard) {
      for (const id of createdIds) {
        try { await chrome.tabs.discard(id); } catch { /* ignore */ }
      }
    }
  }

  return result;
}
