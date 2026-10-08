// core/background/sessions.js — Saved sessions: auto-save and session actions.

import { saveSession, restoreSession, listSessions, deleteSession, deleteSessions, restoreDeletedSession } from '../sessions.js';
import { getAllTabs } from '../tabs-api.js';
import { Storage } from '../storage.js';
import { getSettings } from '../settings.js';
import { withStateMutationLock } from '../state-mutation-lock.js';
import { requireRuntimeString } from './router.js';

// ── Auto-save Sessions ──

export const AUTO_SAVE_PREFIX = '[Auto] ';

async function autoSaveSessionUnlocked({
  getTabs = () => getAllTabs({ allWindows: true, excludeIncognito: true }),
  loadSettings = getSettings,
  saveSnapshot = (name) => saveSession(name, true),
  getStorage = () => Storage.get('sessions'),
  deleteSessions: deleteSessionsOperation = deleteSessions,
  now = Date.now,
} = {}) {
  try {
    const tabs = await getTabs();
    // Skip auto-save if browser has no real tabs open
    if (tabs.length <= 1) return;

    const settings = await loadSettings();
    const nowMs = now();
    const date = new Date(nowMs);
    const dateStr = date.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const name = `${AUTO_SAVE_PREFIX}${dateStr}`;

    await saveSnapshot(name);

    // Rolling retention by days
    const sessions = (await getStorage()) || [];
    const autoSaves = sessions.filter(s => s.name.startsWith(AUTO_SAVE_PREFIX));
    const retentionMs = (settings.autoSaveRetentionDays || 7) * 24 * 60 * 60 * 1000;
    const cutoff = nowMs - retentionMs;

    const idsToDelete = new Set();
    for (const s of autoSaves) {
      if ((s.createdAt || 0) < cutoff) {
        idsToDelete.add(s.id);
      }
    }

    // Always keep at least the 2 most recent regardless of age
    const recentIds = new Set(autoSaves.slice(0, 2).map(s => s.id));
    for (const id of recentIds) idsToDelete.delete(id);

    if (idsToDelete.size > 0) {
      await deleteSessionsOperation([...idsToDelete], nowMs);
    }
  } catch (e) { console.warn('[TabKebab] auto-save failed:', e);
    // Auto-save should never crash the service worker
  }
}

export async function autoSaveSession(options = {}) {
  return withStateMutationLock(() => autoSaveSessionUnlocked(options));
}

// ── Message handlers ──

export const sessionHandlers = {
  async saveSession(msg, ctx) {
    const { saveSession: saveSessionOperation = saveSession } = ctx;
    requireRuntimeString(msg.name, 'Session name');
    return withStateMutationLock(() => saveSessionOperation(msg.name));
  },

  async restoreSession(msg) {
    const onProgress = ({ created, loaded, total }) => {
      chrome.runtime.sendMessage({
        action: 'restoreProgress',
        restoreId: msg.sessionId,
        created,
        loaded,
        total,
      }).catch(() => {});
    };
    return restoreSession(msg.sessionId, { ...msg.options, onProgress });
  },

  async listSessions() {
    return listSessions();
  },

  async deleteSession(msg, ctx) {
    const { deleteSession: deleteSessionOperation = deleteSession, now = Date.now } = ctx;
    requireRuntimeString(msg.sessionId, 'Session ID');
    return withStateMutationLock(() => deleteSessionOperation(msg.sessionId, now()));
  },

  async undoDeleteSession(msg, ctx) {
    const {
      restoreDeletedSession: restoreDeletedSessionOperation = restoreDeletedSession,
      now = Date.now,
    } = ctx;
    return withStateMutationLock(async () => {
      const restored = await restoreDeletedSessionOperation(msg.session, now());
      return { restored: true, modifiedAt: restored.modifiedAt };
    });
  },
};
