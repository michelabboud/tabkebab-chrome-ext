// drive-sync.js — Google Drive connect/disconnect/sync UI

import { showToast } from './toast.js';
import { authenticate, disconnect, findSyncFile, readSyncFile, writeSyncFile } from '../../core/drive-client.js';
import { Storage } from '../../core/storage.js';

export class DriveSync {
  constructor(rootEl) {
    this.root = rootEl;
    this.statusEl = rootEl.querySelector('#drive-status');
    this.connectBtn = rootEl.querySelector('#btn-connect-drive');
    this.syncBtn = rootEl.querySelector('#btn-sync-now');
    this.disconnectBtn = rootEl.querySelector('#btn-disconnect-drive');

    this.connectBtn.addEventListener('click', () => this.connect());
    this.syncBtn.addEventListener('click', () => this.syncNow());
    this.disconnectBtn.addEventListener('click', () => this.disconnectDrive());
  }

  async refresh() {
    const state = await Storage.get('driveSync');
    this.updateUI(state);
  }

  updateUI(state) {
    if (state && state.connected) {
      this.statusEl.textContent = state.lastSyncedAt
        ? `Connected. Last synced: ${new Date(state.lastSyncedAt).toLocaleString()}`
        : 'Connected. Not yet synced.';
      this.statusEl.classList.add('connected');
      this.connectBtn.hidden = true;
      this.syncBtn.disabled = false;
      this.disconnectBtn.hidden = false;
    } else {
      this.statusEl.textContent = 'Not connected';
      this.statusEl.classList.remove('connected');
      this.connectBtn.hidden = false;
      this.syncBtn.disabled = true;
      this.disconnectBtn.hidden = true;
    }
  }

  async connect() {
    try {
      await authenticate();
      await Storage.set('driveSync', { connected: true, lastSyncedAt: null, driveFileId: null });
      showToast('Connected to Google Drive', 'success');
      this.refresh();
    } catch (err) {
      showToast('Failed to connect: ' + err.message, 'error');
    }
  }

  async syncNow() {
    this.syncBtn.disabled = true;
    this.syncBtn.textContent = 'Syncing...';

    try {
      // Read local data
      const localSessions = (await Storage.get('sessions')) || [];
      const localGroups = (await Storage.get('manualGroups')) || {};

      // Read remote data
      let remoteSessions = [];
      let remoteGroups = {};
      const syncFile = await findSyncFile();

      if (syncFile) {
        const remoteData = await readSyncFile(syncFile.id);
        remoteSessions = remoteData.sessions || [];
        remoteGroups = remoteData.manualGroups || {};
      }

      // Merge sessions: deduplicate by ID, newer modifiedAt wins
      const mergedSessionsMap = new Map();
      for (const s of [...remoteSessions, ...localSessions]) {
        const existing = mergedSessionsMap.get(s.id);
        if (!existing || (s.modifiedAt || s.createdAt) > (existing.modifiedAt || existing.createdAt)) {
          mergedSessionsMap.set(s.id, s);
        }
      }
      const mergedSessions = Array.from(mergedSessionsMap.values())
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      // Merge groups: newer modifiedAt wins
      const mergedGroups = { ...remoteGroups };
      for (const [id, group] of Object.entries(localGroups)) {
        const remote = mergedGroups[id];
        if (!remote || (group.modifiedAt || 0) > (remote.modifiedAt || 0)) {
          mergedGroups[id] = group;
        }
      }

      // Write merged data to both local and remote
      await Storage.set('sessions', mergedSessions);
      await Storage.set('manualGroups', mergedGroups);
      await writeSyncFile({ sessions: mergedSessions, manualGroups: mergedGroups });

      // Update sync state
      await Storage.set('driveSync', {
        connected: true,
        lastSyncedAt: Date.now(),
        driveFileId: syncFile?.id || null
      });

      showToast('Synced with Google Drive', 'success');
    } catch (err) {
      showToast('Sync failed: ' + err.message, 'error');
    }

    this.syncBtn.textContent = 'Sync Now';
    this.refresh();
  }

  async disconnectDrive() {
    try {
      await disconnect();
      await Storage.set('driveSync', { connected: false, lastSyncedAt: null, driveFileId: null });
      showToast('Disconnected from Google Drive', 'success');
      this.refresh();
    } catch (err) {
      showToast('Failed to disconnect: ' + err.message, 'error');
    }
  }
}
