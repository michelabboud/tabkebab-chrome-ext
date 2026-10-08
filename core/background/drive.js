// core/background/drive.js — Google Drive: canonical state sync, subfolder
// exports, scheduled/manual retention, and Drive message actions.

import { deleteSessions } from '../sessions.js';
import { Storage } from '../storage.js';
import { listStashes as listStashesDB, getStash } from '../stash-db.js';
import { getSettings, isFeatureOn } from '../settings.js';
import { exportToSubfolder, exportRawToSubfolder, listAllDriveFiles, deleteDriveFile, findSyncFile, readSyncFile, writeSyncFile, writeSettingsFile } from '../drive-client.js';
import { coordinateDriveRetention, emptyDriveRetentionResult, retentionCutoff, validateDriveRetentionDays } from '../drive-retention.js';
import { reconcileDriveSync } from '../drive-sync.js';
import { withStateMutationLock } from '../state-mutation-lock.js';
import { generateBookmarkHtml } from './bookmarks.js';
import { AUTO_SAVE_PREFIX } from './sessions.js';
import { createLogger } from '../log.js';
const log = createLogger('drive');

async function exportDriveSubfolders({ scheduled = false } = {}) {
  const results = { sessions: 0, stashes: 0, bookmarks: 0 };
  const dateStr = new Date().toISOString().slice(0, 10);
  const settings = await getSettings();

  const sessions = (await Storage.get('sessions')) || [];
  if (sessions.length > 0 && (!scheduled || settings.autoExportSessionsToDrive)) {
    await exportToSubfolder('sessions', `sessions-${dateStr}.json`, {
      sessions,
      exportedAt: Date.now(),
    });
    results.sessions = sessions.length;
  }

  const stashes = await listStashesDB();
  if (stashes.length > 0 && (!scheduled || settings.autoExportStashesToDrive)) {
    await exportToSubfolder('stashes', `stashes-${dateStr}.json`, {
      stashes,
      exportedAt: Date.now(),
    });
    results.stashes = stashes.length;
  }

  const bookmarks = (await Storage.get('tabkebabBookmarks')) || [];
  if (bookmarks.length > 0 && !scheduled) {
    const payload = { bookmarks, exportedAt: Date.now() };
    if (settings.compressedExport) {
      await exportRawToSubfolder(
        'bookmarks',
        `bookmarks-${dateStr}.json`,
        JSON.stringify(payload),
        'application/json',
      );
    } else {
      await exportToSubfolder('bookmarks', `bookmarks-${dateStr}.json`, payload);
    }
    results.bookmarks = bookmarks.length;

    if (settings.exportHtmlBookmarkToDrive && bookmarks[0]?.formats) {
      const html = generateBookmarkHtml(bookmarks[0]);
      await exportRawToSubfolder(
        'bookmarks',
        `bookmarks-${dateStr}.html`,
        html,
        'text/html',
      );
    }
  }

  return results;
}

async function setCompletedDriveState({ lastSyncedAt, driveFileId }) {
  const current = await Storage.get('driveSync');
  if (current?.connected !== true) throw new Error('Google Drive disconnected during sync');
  await Storage.set('driveSync', { ...current, lastSyncedAt, driveFileId });
}

async function syncDriveStateUnlocked({
  scheduled = false,
  getDriveState = () => Storage.get('driveSync'),
  findRemote = findSyncFile,
  readRemote = readSyncFile,
  writeRemote = writeSyncFile,
  exportSubfolders = exportDriveSubfolders,
  loadSettings = getSettings,
  writeSettings = writeSettingsFile,
  setDriveState = setCompletedDriveState,
  now = Date.now,
} = {}) {
  const initialState = await getDriveState();
  if (initialState?.connected !== true) throw new Error('Google Drive is not connected');

  const remoteFile = await findRemote();
  const remoteDocument = remoteFile ? await readRemote(remoteFile.id) : null;
  let driveFileId = remoteFile?.id ?? initialState.driveFileId ?? null;
  const merged = await reconcileDriveSync(remoteDocument, async (document) => {
    const writtenId = await writeRemote(document);
    if (typeof writtenId === 'string' && writtenId.length > 0) driveFileId = writtenId;
  });

  const exportResult = await exportSubfolders({ scheduled });
  const settings = await loadSettings();
  const completedAt = now();
  if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
    throw new Error('Drive sync clock returned an invalid timestamp');
  }
  await writeSettings({ settings, savedAt: completedAt, version: 1 });
  await setDriveState({ lastSyncedAt: completedAt, driveFileId });

  return {
    version: merged.version,
    sessions: merged.sessions.length,
    manualGroups: Object.keys(merged.manualGroups).length,
    stashes: exportResult.stashes,
    bookmarks: exportResult.bookmarks,
    lastSyncedAt: completedAt,
  };
}

export async function syncDriveState(options = {}) {
  return withStateMutationLock(() => syncDriveStateUnlocked(options));
}

export async function autoSyncDrive(sync = syncDriveState) {
  try {
    return await sync({ scheduled: true });
  } catch {
    log.warn('automatic Drive sync failed');
    return null;
  }
}

export async function runDriveFileRetention(
  { mode, days, neverDeleteFromDrive, connected },
  {
    now = Date.now,
    listFiles = listAllDriveFiles,
    deleteFile = deleteDriveFile,
  } = {},
) {
  if (mode !== 'manual' && mode !== 'scheduled') {
    throw new TypeError('Drive retention mode must be manual or scheduled');
  }

  if (mode === 'scheduled' && days === 0) return emptyDriveRetentionResult();
  validateDriveRetentionDays(days);

  // Persisted guard corruption is treated as disabled. Destructive work is
  // allowed only for the exact affirmative state.
  if (neverDeleteFromDrive !== false || connected !== true) {
    return emptyDriveRetentionResult();
  }
  const nowMs = now();
  const cutoffMs = retentionCutoff(days, nowMs);
  return coordinateDriveRetention({ cutoffMs, listFiles, deleteFile });
}

async function runRetentionCleanupUnlocked({
  getSettings: loadSettings = getSettings,
  getStorage = (key) => Storage.get(key),
  deleteSessions: deleteSessionsOperation = deleteSessions,
  now = Date.now,
  listFiles = listAllDriveFiles,
  deleteFile = deleteDriveFile,
} = {}) {
  try {
    const settings = await loadSettings();
    const automationOn = isFeatureOn(settings, 'automation');
    const driveOn = isFeatureOn(settings, 'drive');

    // Clean old auto-saves locally (an automation chore: skipped while
    // Automation is switched off, so turning it off never prunes data)
    const retentionMs = (settings.autoSaveRetentionDays || 7) * 24 * 60 * 60 * 1000;
    const nowMs = now();
    const cutoff = nowMs - retentionMs;
    const sessions = (await getStorage('sessions')) || [];
    const autoSaves = sessions.filter(s => s.name.startsWith(AUTO_SAVE_PREFIX));
    const recentIds = new Set(autoSaves.slice(0, 2).map(s => s.id));
    const idsToDelete = new Set();

    for (const s of autoSaves) {
      if ((s.createdAt || 0) < cutoff && !recentIds.has(s.id)) {
        idsToDelete.add(s.id);
      }
    }

    if (automationOn && idsToDelete.size > 0) {
      await deleteSessionsOperation([...idsToDelete], nowMs);
    }

    if (!driveOn) return emptyDriveRetentionResult();
    const driveState = await getStorage('driveSync');
    return await runDriveFileRetention({
      mode: 'scheduled',
      days: settings.driveRetentionDays,
      neverDeleteFromDrive: settings.neverDeleteFromDrive,
      connected: driveState?.connected,
    }, { now: () => nowMs, listFiles, deleteFile });
  } catch {
    log.warn('Drive retention cleanup failed');
    return emptyDriveRetentionResult();
  }
}

export async function runRetentionCleanup(options = {}) {
  return withStateMutationLock(() => runRetentionCleanupUnlocked(options));
}

// ── Message handlers ──

function runSyncDrive(ctx) {
  const { syncDrive = syncDriveState } = ctx;
  return syncDrive();
}

export const driveHandlers = {
  async exportStashToDrive(msg) {
    const stash = await getStash(msg.stashId);
    if (!stash) throw new Error('Stash not found');
    const filename = `stash-${stash.name.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}.json`;
    await exportToSubfolder('stashes', filename, stash);
    return { success: true };
  },

  async syncStashesToDrive() {
    const stashes = await listStashesDB();
    if (stashes.length === 0) return { synced: 0 };
    const filename = `stashes-${new Date().toISOString().slice(0, 10)}.json`;
    await exportToSubfolder('stashes', filename, { stashes, exportedAt: Date.now() });
    return { synced: stashes.length };
  },

  async syncDriveState(msg, ctx) {
    return runSyncDrive(ctx);
  },

  async syncAllToDrive(msg, ctx) {
    return runSyncDrive(ctx);
  },

  async cleanDriveFiles(msg, ctx) {
    const {
      getSettings: loadSettings = getSettings,
      getStorage = (key) => Storage.get(key),
      now = Date.now,
      listFiles = listAllDriveFiles,
      deleteFile = deleteDriveFile,
    } = ctx;
    const settings = await loadSettings();
    const driveState = await getStorage('driveSync');
    return runDriveFileRetention({
      mode: 'manual',
      days: msg.days,
      neverDeleteFromDrive: settings.neverDeleteFromDrive,
      connected: driveState?.connected,
    }, { now, listFiles, deleteFile });
  },
};
