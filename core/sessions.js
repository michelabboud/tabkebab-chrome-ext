// core/sessions.js — Session save/restore/list/delete (v2: window-aware)

import { getAllTabs } from './tabs-api.js';
import { Storage } from './storage.js';
import { restoreTabWindows } from './tab-restore.js';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

/**
 * Restore a saved session through the shared tab-restore coordinator.
 */
export async function restoreSession(sessionId, options = {}) {
  const sessions = (await Storage.get('sessions')) || [];
  const storedSession = sessions.find((session) => session.id === sessionId);
  if (!storedSession) throw new Error('Session not found');

  const session = migrateV1toV2(storedSession);
  return restoreTabWindows(session.windows || [], options);
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
