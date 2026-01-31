// settings-manager.js — Settings UI controller: loads, renders, and saves settings

import { showToast } from './toast.js';
import { showConfirm } from './confirm-dialog.js';
import { Storage } from '../../core/storage.js';

export class SettingsManager {
  constructor(rootEl) {
    this.root = rootEl;

    // Collect all setting inputs by data-setting attribute
    this.inputs = rootEl.querySelectorAll('[data-setting]');

    // Auto-save on change for every setting input
    this.inputs.forEach(input => {
      input.addEventListener('change', () => this.saveFromUI());
    });

    // When "never delete from Drive" is toggled, gray out retention + reset its value
    const neverDeleteInput = rootEl.querySelector('#setting-neverDeleteFromDrive');
    if (neverDeleteInput) {
      neverDeleteInput.addEventListener('change', () => {
        this.updateRetentionState(neverDeleteInput.checked);
      });
    }

    // Bookmark Now button
    const bookmarkBtn = rootEl.querySelector('#btn-bookmark-now');
    if (bookmarkBtn) {
      bookmarkBtn.addEventListener('click', () => this.bookmarkNow());
    }

    // Drive cleanup button
    const cleanBtn = rootEl.querySelector('#btn-clean-drive');
    if (cleanBtn) {
      cleanBtn.addEventListener('click', () => this.cleanDriveFiles());
    }

    // Export/Import settings
    const exportSettingsBtn = rootEl.querySelector('#btn-export-settings');
    if (exportSettingsBtn) {
      exportSettingsBtn.addEventListener('click', () => this.exportSettings());
    }
    const importSettingsInput = rootEl.querySelector('#btn-import-settings');
    if (importSettingsInput) {
      importSettingsInput.addEventListener('change', (e) => this.importSettings(e));
    }
  }

  async refresh() {
    try {
      const settings = await this.send({ action: 'getSettings' });
      this.renderSettings(settings);

      // Show/hide Drive connected settings
      const driveState = await Storage.get('driveSync');
      const driveConnected = driveState?.connected || false;
      const connectedSection = this.root.querySelector('#drive-settings-connected');
      if (connectedSection) connectedSection.hidden = !driveConnected;
    } catch {
      // Settings not available — use defaults
    }
  }

  renderSettings(settings) {
    this.inputs.forEach(input => {
      const key = input.dataset.setting;
      const value = settings[key];

      if (value === undefined) return;

      if (input.type === 'checkbox') {
        input.checked = !!value;
      } else if (input.type === 'number') {
        input.value = value;
      } else {
        input.value = value;
      }
    });

    // Apply retention disabled state based on never-delete toggle
    this.updateRetentionState(settings.neverDeleteFromDrive);
  }

  /** Gray out Drive retention row when "never delete" is ON, and reset counter on toggle. */
  updateRetentionState(neverDelete) {
    const retentionRow = this.root.querySelector('#drive-retention-row');
    const retentionInput = this.root.querySelector('#setting-driveRetentionDays');
    if (!retentionRow || !retentionInput) return;

    if (neverDelete) {
      retentionRow.classList.add('disabled');
      retentionInput.disabled = true;
      // Reset to default when toggling ON
      retentionInput.value = 30;
    } else {
      retentionRow.classList.remove('disabled');
      retentionInput.disabled = false;
    }
  }

  async saveFromUI() {
    const settings = {};

    this.inputs.forEach(input => {
      const key = input.dataset.setting;
      if (input.type === 'checkbox') {
        settings[key] = input.checked;
      } else if (input.type === 'number') {
        settings[key] = Number(input.value) || 0;
      } else {
        settings[key] = input.value;
      }
    });

    try {
      await this.send({ action: 'saveSettings', settings });
    } catch {
      showToast('Failed to save settings', 'error');
    }
  }

  async bookmarkNow() {
    const btn = this.root.querySelector('#btn-bookmark-now');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Creating...';
    }

    try {
      const result = await this.send({ action: 'createBookmarks', options: {} });
      if (result.error) {
        showToast(result.error, 'error');
      } else if (result.destinations?.length > 0) {
        showToast(`Bookmarks saved to: ${result.destinations.join(', ')}`, 'success');
      } else {
        showToast('No bookmarks created', 'info');
      }
    } catch (err) {
      showToast('Bookmark failed: ' + err.message, 'error');
    }

    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Bookmark Now';
    }
  }

  async cleanDriveFiles() {
    const daysInput = this.root.querySelector('#drive-cleanup-days');
    const days = Number(daysInput?.value) || 30;
    const btn = this.root.querySelector('#btn-clean-drive');

    const ok = await showConfirm({
      title: 'Clean Drive files?',
      message: `Delete Drive files older than ${days} days? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Cleaning...';
    }

    try {
      const result = await this.send({ action: 'cleanDriveFiles', days });
      showToast(`Deleted ${result.deleted} old Drive files`, 'success');
    } catch (err) {
      showToast('Cleanup failed: ' + err.message, 'error');
    }

    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Clean Drive Files';
    }
  }

  async exportSettings() {
    try {
      const settings = await this.send({ action: 'getSettings' });
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tabkebab-settings-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Settings exported', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  }

  async importSettings(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.settings || typeof data.settings !== 'object') {
        throw new Error('No valid settings found in file');
      }

      await this.send({ action: 'saveSettings', settings: data.settings });
      showToast('Settings imported', 'success');
      this.refresh();
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    }

    e.target.value = '';
  }

  send(msg) {
    return chrome.runtime.sendMessage(msg);
  }
}
