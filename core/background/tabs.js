// core/background/tabs.js — Tab and window actions, duplicates, keep-awake
// list, kebab (tab discard), and side-panel change notifications.

import { findDuplicates, findEmptyPages } from '../duplicates.js';
import { getAllTabs, focusTab, closeTabs, extractDomain } from '../tabs-api.js';
import { Storage } from '../storage.js';
import { getSettings } from '../settings.js';
import { withStateMutationLock } from '../state-mutation-lock.js';
import { createDefaultKeepAwakeDomains } from '../keep-awake-defaults.js';

// ── Keep Awake Defaults ──

export async function getKeepAwakeList() {
  const list = await Storage.get('keepAwakeDomains');
  return list === null ? createDefaultKeepAwakeDomains() : list;
}

// ── Auto-kebab (discard idle tabs) ──

export async function autoKebabOldTabs() {
  try {
    const settings = await getSettings();
    if (settings.autoKebabAfterHours <= 0) return;

    const keepAwake = new Set(await getKeepAwakeList());
    const tabs = await getAllTabs({ allWindows: true });
    const thresholdMs = settings.autoKebabAfterHours * 60 * 60 * 1000;
    const cutoff = Date.now() - thresholdMs;

    for (const tab of tabs) {
      if (tab.active || tab.discarded) continue;
      // Never discard a tab that is playing audio (music, calls, video).
      if (tab.audible) continue;
      if (tab.autoDiscardable === false) continue;
      if (keepAwake.has(extractDomain(tab.url))) continue;
      if ((tab.lastAccessed || Date.now()) > cutoff) continue;

      try { await chrome.tabs.discard(tab.id); } catch (e) { /* tab may be active or protected */ }
    }
  } catch (e) { console.warn('[TabKebab] auto-kebab failed:', e); }
}

// Notify side panel when tabs change
export function notifyPanel() {
  chrome.runtime.sendMessage({ type: 'tabsChanged' }).catch(() => {
    // Side panel not open — ignore
  });
}

// ── Message handlers ──

export const tabHandlers = {
  async getTabs(msg) {
    return getAllTabs({ allWindows: msg.allWindows ?? true });
  },

  async findDuplicates() {
    return findDuplicates();
  },

  async findEmptyPages() {
    return findEmptyPages();
  },

  async closeTabs(msg) {
    const closed = await closeTabs(msg.tabIds);
    return { success: true, closed };
  },

  async reopenTabs(msg) {
    const created = [];
    for (const url of (msg.urls || [])) {
      try {
        const tab = await chrome.tabs.create({ url, active: false });
        created.push(tab.id);
      } catch (e) {
        console.warn('[TabKebab] Failed to reopen tab:', url, e);
      }
    }
    return { created: created.length };
  },

  async focusTab(msg) {
    await focusTab(msg.tabId);
    return { success: true };
  },

  // ── Tab Sleep (Kebab) ──

  async getKeepAwakeList() {
    return getKeepAwakeList();
  },

  async saveKeepAwakeList(msg) {
    return withStateMutationLock(async () => {
      if (msg.domains === null) {
        await Storage.remove('keepAwakeDomains');
      } else {
        await Storage.set('keepAwakeDomains', msg.domains);
      }
      return { success: true };
    });
  },

  async toggleKeepAwakeDomain(msg) {
    return withStateMutationLock(async () => {
      const list = await getKeepAwakeList();
      const idx = list.indexOf(msg.domain);
      if (idx >= 0) {
        list.splice(idx, 1);
        await Storage.set('keepAwakeDomains', list);
        return { isKeepAwake: false };
      }
      list.push(msg.domain);
      await Storage.set('keepAwakeDomains', list);
      return { isKeepAwake: true };
    });
  },

  async discardTabs(msg) {
    const keepAwake = new Set(await getKeepAwakeList());
    let tabs = await getAllTabs({ allWindows: true });

    // Scope filtering
    if (msg.scope === 'domain') {
      tabs = tabs.filter(t => extractDomain(t.url) === msg.domain);
    } else if (msg.scope === 'group') {
      tabs = tabs.filter(t => t.groupId === msg.groupId);
    } else if (msg.scope === 'window') {
      tabs = tabs.filter(t => t.windowId === msg.windowId);
    }
    // scope === 'all' — no filter

    let discarded = 0;
    let skipped = 0;
    const errors = [];

    for (const tab of tabs) {
      // Skip: active tab, already discarded, keep-awake domain, autoDiscardable === false
      if (tab.active) { skipped++; continue; }
      if (tab.discarded) { skipped++; continue; }
      if (keepAwake.has(extractDomain(tab.url))) { skipped++; continue; }
      if (tab.autoDiscardable === false) { skipped++; continue; }

      try {
        await chrome.tabs.discard(tab.id);
        discarded++;
      } catch (err) {
        errors.push({ tabId: tab.id, error: err.message });
      }
    }

    return { discarded, skipped, errors };
  },

  async setKeepAwake(msg) {
    return withStateMutationLock(async () => {
      let tabs = await getAllTabs({ allWindows: true });

      if (msg.scope === 'domain') {
        tabs = tabs.filter(t => extractDomain(t.url) === msg.domain);
      } else if (msg.scope === 'group') {
        tabs = tabs.filter(t => t.groupId === msg.groupId);
      }

      const value = !msg.keepAwake; // autoDiscardable is the inverse of keep-awake
      for (const tab of tabs) {
        try {
          await chrome.tabs.update(tab.id, { autoDiscardable: value });
        } catch { /* ignore */ }
      }

      // For domain scope, also persist to keep-awake list
      if (msg.scope === 'domain' && msg.domain) {
        const list = await getKeepAwakeList();
        const idx = list.indexOf(msg.domain);
        if (msg.keepAwake && idx < 0) {
          list.push(msg.domain);
          await Storage.set('keepAwakeDomains', list);
        } else if (!msg.keepAwake && idx >= 0) {
          list.splice(idx, 1);
          await Storage.set('keepAwakeDomains', list);
        }
      }

      return { success: true };
    });
  },
};
