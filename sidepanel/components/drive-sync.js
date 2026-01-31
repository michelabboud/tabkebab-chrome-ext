// drive-sync.js — Google Drive connect/disconnect/sync UI

import { showToast } from './toast.js';
import { showConfirm } from './confirm-dialog.js';
import { authenticate, disconnect, findSyncFile, readSyncFile, writeSyncFile, findSettingsFile, readSettingsFile, writeSettingsFile, listDriveProfiles, readSettingsFromProfile } from '../../core/drive-client.js';
import { Storage } from '../../core/storage.js';

export class DriveSync {
  constructor(rootEl) {
    this.root = rootEl;
    this.statusEl = rootEl.querySelector('#drive-status');
    this.connectBtn = rootEl.querySelector('#btn-connect-drive');
    this.syncBtn = rootEl.querySelector('#btn-sync-now');
    this.disconnectBtn = rootEl.querySelector('#btn-disconnect-drive');

    this.undoSettingsBtn = rootEl.querySelector('#btn-undo-drive-settings');

    this.connectBtn.addEventListener('click', () => this.connect());
    this.syncBtn.addEventListener('click', () => this.syncNow());
    this.disconnectBtn.addEventListener('click', () => this.disconnectDrive());
    if (this.undoSettingsBtn) {
      this.undoSettingsBtn.addEventListener('click', () => this.undoSettingsLoad());
    }
  }

  async refresh() {
    const state = await Storage.get('driveSync');
    this.updateUI(state);

    if (this.undoSettingsBtn) {
      const prev = await Storage.get('tabkebabSettingsPrevious');
      this.undoSettingsBtn.hidden = !prev;
    }
  }

  updateUI(state) {
    const connected = state && state.connected;

    if (connected) {
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

    // Show/hide Drive connected settings in the settings card
    const connectedSection = this.root.querySelector('#drive-settings-connected');
    if (connectedSection) connectedSection.hidden = !connected;
  }

  async connect() {
    try {
      await authenticate();

      // Ensure a profile name is set for multi-profile isolation
      let profileName = await Storage.get('driveProfileName');
      if (!profileName) {
        profileName = prompt('Enter a name for this Chrome profile (e.g., "Work", "Personal"):');
        if (!profileName || !profileName.trim()) {
          showToast('Profile name is required for Drive sync', 'error');
          return;
        }
        profileName = profileName.trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 50);
        if (!profileName) {
          showToast('Profile name must contain letters or numbers', 'error');
          return;
        }
        await Storage.set('driveProfileName', profileName);
      }

      await Storage.set('driveSync', { connected: true, lastSyncedAt: null, driveFileId: null });
      showToast(`Connected to Google Drive (profile: ${profileName})`, 'success');
      this.refresh();
      await this.promptLoadSettings();
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

      // Sync everything to Drive subfolders (sessions, stashes, bookmarks)
      const syncResult = await chrome.runtime.sendMessage({ action: 'syncAllToDrive' });

      // Update sync state
      await Storage.set('driveSync', {
        connected: true,
        lastSyncedAt: Date.now(),
        driveFileId: syncFile?.id || null
      });

      // Write current settings to Drive
      try {
        const currentSettings = await chrome.runtime.sendMessage({ action: 'getSettings' });
        await writeSettingsFile({ settings: currentSettings, savedAt: Date.now(), version: 1 });
      } catch (e) { console.warn('[TabKebab] cross-profile settings import failed:', e); }

      const parts = [];
      if (syncResult.sessions > 0) parts.push(`${syncResult.sessions} sessions`);
      if (syncResult.stashes > 0) parts.push(`${syncResult.stashes} stashes`);
      if (syncResult.bookmarks > 0) parts.push(`${syncResult.bookmarks} bookmarks`);
      const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      showToast(`Synced with Google Drive${detail}`, 'success');
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

  async promptLoadSettings() {
    try {
      // 1. Check own profile for settings
      const settingsFile = await findSettingsFile();
      if (settingsFile) {
        const remoteData = await readSettingsFile(settingsFile.id);
        if (remoteData?.settings) {
          const savedDate = remoteData.savedAt
            ? new Date(remoteData.savedAt).toLocaleString()
            : 'unknown date';

          const ok = await showConfirm({
            title: 'Load Drive Settings',
            message: `Settings found on Google Drive (saved ${savedDate}). Load these settings?`,
            confirmLabel: 'Load Settings',
            cancelLabel: 'Keep Current',
          });
          if (ok) {
            await this.#applyRemoteSettings(remoteData.settings);
            showToast('Settings loaded from Drive. Use "Undo Last Settings Import" to revert.', 'success');
            this.refresh();
          }
          return;
        }
      }

      // 2. No own settings — check other profiles for cross-profile import
      const profiles = await listDriveProfiles();
      const ownName = await Storage.get('driveProfileName');
      const otherProfiles = profiles.filter(p => p.name !== ownName);

      for (const profile of otherProfiles) {
        const data = await readSettingsFromProfile(profile.id);
        if (data?.settings) {
          const savedDate = data.savedAt
            ? new Date(data.savedAt).toLocaleString()
            : 'unknown date';

          const ok = await showConfirm({
            title: 'Import from Another Profile',
            message: `Settings found in profile "${profile.name}" (saved ${savedDate}). Import these settings?`,
            confirmLabel: 'Import',
            cancelLabel: 'Skip',
          });
          if (ok) {
            await this.#applyRemoteSettings(data.settings);
            showToast(`Settings imported from "${profile.name}". Use "Undo Last Settings Import" to revert.`, 'success');
            this.refresh();
          }
          return;
        }
      }
    } catch (e) {
      console.warn('[TabKebab] post-connect settings sync failed:', e);
    }
  }

  async #applyRemoteSettings(settings) {
    const currentSettings = await chrome.runtime.sendMessage({ action: 'getSettings' });
    await Storage.set('tabkebabSettingsPrevious', currentSettings);
    await chrome.runtime.sendMessage({ action: 'saveSettings', settings });
  }

  async undoSettingsLoad() {
    const prev = await Storage.get('tabkebabSettingsPrevious');
    if (!prev) {
      showToast('No previous settings to restore', 'error');
      return;
    }

    const ok = await showConfirm({
      title: 'Undo Settings Import',
      message: 'Restore your previous settings?',
      confirmLabel: 'Restore',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;

    await chrome.runtime.sendMessage({ action: 'saveSettings', settings: prev });
    await Storage.remove('tabkebabSettingsPrevious');
    showToast('Previous settings restored', 'success');
    this.refresh();
  }
}
