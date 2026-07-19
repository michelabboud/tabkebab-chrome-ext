// drive-sync.js — Google Drive connect/disconnect/sync UI

import { showToast } from './toast.js';
import { showConfirm } from './confirm-dialog.js';
import { authenticate, disconnect, findSettingsFile, readSettingsFile, listDriveProfiles, readSettingsFromProfile } from '../../core/drive-client.js';
import { Storage } from '../../core/storage.js';
import { sendOrThrow } from '../message-client.js';

export class DriveSync {
  constructor(rootEl, { send = sendOrThrow, notify = showToast, confirm = showConfirm } = {}) {
    this.root = rootEl;
    this.sendMessage = send;
    this.notify = notify;
    this.confirm = confirm;
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
          this.notify('Profile name is required for Drive sync', 'error');
          return;
        }
        profileName = profileName.trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 50);
        if (!profileName) {
          this.notify('Profile name must contain letters or numbers', 'error');
          return;
        }
        await Storage.set('driveProfileName', profileName);
      }

      await Storage.set('driveSync', { connected: true, lastSyncedAt: null, driveFileId: null });
      this.notify(`Connected to Google Drive (profile: ${profileName})`, 'success');
      this.refresh();
      await this.promptLoadSettings();
    } catch (err) {
      this.notify('Failed to connect: ' + err.message, 'error');
    }
  }

  async syncNow() {
    this.syncBtn.disabled = true;
    this.syncBtn.textContent = 'Syncing...';
    let syncSucceeded = false;
    let successMessage = '';

    try {
      const syncResult = await this.sendMessage({ action: 'syncDriveState' });
      const parts = [];
      if (syncResult.sessions > 0) parts.push(`${syncResult.sessions} sessions`);
      if (syncResult.stashes > 0) parts.push(`${syncResult.stashes} stashes`);
      if (syncResult.bookmarks > 0) parts.push(`${syncResult.bookmarks} bookmarks`);
      const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      successMessage = `Synced with Google Drive${detail}`;
      syncSucceeded = true;
    } catch (err) {
      this.notify('Sync failed: ' + err.message, 'error');
    } finally {
      this.syncBtn.textContent = 'Sync Now';
      this.syncBtn.disabled = false;
    }

    try {
      await this.refresh();
    } catch {
      if (syncSucceeded) {
        this.notify(`${successMessage}, but the view could not refresh`, 'error');
      } else {
        this.notify('Drive status could not refresh after the failed sync', 'error');
      }
      return syncSucceeded;
    }

    if (syncSucceeded) this.notify(successMessage, 'success');
    return syncSucceeded;
  }

  async disconnectDrive() {
    try {
      await disconnect();
      await Storage.set('driveSync', { connected: false, lastSyncedAt: null, driveFileId: null });
      this.notify('Disconnected from Google Drive', 'success');
      this.refresh();
    } catch (err) {
      this.notify('Failed to disconnect: ' + err.message, 'error');
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

          const ok = await this.confirm({
            title: 'Load Drive Settings',
            message: `Settings found on Google Drive (saved ${savedDate}). Load these settings?`,
            confirmLabel: 'Load Settings',
            cancelLabel: 'Keep Current',
          });
          if (ok) {
            await this.applyRemoteSettings(remoteData.settings);
            this.notify('Settings loaded from Drive. Use "Undo Last Settings Import" to revert.', 'success');
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

          const ok = await this.confirm({
            title: 'Import from Another Profile',
            message: `Settings found in profile "${profile.name}" (saved ${savedDate}). Import these settings?`,
            confirmLabel: 'Import',
            cancelLabel: 'Skip',
          });
          if (ok) {
            await this.applyRemoteSettings(data.settings);
            this.notify(`Settings imported from "${profile.name}". Use "Undo Last Settings Import" to revert.`, 'success');
            this.refresh();
          }
          return;
        }
      }
    } catch (e) {
      console.warn('[TabKebab] post-connect settings sync failed:', e);
    }
  }

  async applyRemoteSettings(settings) {
    return this.sendMessage({ action: 'importDriveSettings', settings });
  }

  async undoSettingsLoad() {
    const prev = await Storage.get('tabkebabSettingsPrevious');
    if (!prev) {
      this.notify('No previous settings to restore', 'error');
      return false;
    }

    const ok = await this.confirm({
      title: 'Undo Settings Import',
      message: 'Restore your previous settings?',
      confirmLabel: 'Restore',
      cancelLabel: 'Cancel',
    });
    if (!ok) return false;

    try {
      await this.sendMessage({ action: 'undoDriveSettings' });
    } catch (error) {
      this.notify(`Settings restore failed: ${error.message}`, 'error');
      return false;
    }

    try {
      await this.refresh();
    } catch {
      this.notify('Previous settings restored, but the view could not refresh', 'error');
      return true;
    }
    this.notify('Previous settings restored', 'success');
    return true;
  }
}
