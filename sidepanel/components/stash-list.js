// stash-list.js — Stash view: list, restore, delete, export/import stashes

import { showToast } from './toast.js';
import { showConfirm } from './confirm-dialog.js';
import { MAX_DRIVE_STRING_LENGTH } from '../../core/drive-sync.js';
import { Storage } from '../../core/storage.js';
import { downloadJson, readPortableImportFile } from '../../core/export-import.js';
import { sendOrThrow } from '../message-client.js';
import { formatRestoreFeedback } from '../restore-feedback.js';
import {
  formatPortableImportSummary,
  portableImportToastType,
} from '../portable-import-summary.js';

const SAFE_FAVICON_SCHEMES = new Set(['http', 'https', 'chrome', 'data']);

// Render only favicon URLs that satisfy the capture-time policy; stored
// records may predate capture sanitization or arrive through portable import.
function safeFaviconUrl(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DRIVE_STRING_LENGTH
  ) {
    return null;
  }
  let scheme;
  try {
    scheme = new URL(value).protocol.replace(/:$/, '').toLowerCase();
  } catch {
    return null;
  }
  return SAFE_FAVICON_SCHEMES.has(scheme) ? value : null;
}

export class StashList {
  constructor(rootEl) {
    this.root = rootEl;
    this.listEl = rootEl.querySelector('#stash-list');
    this.driveConnected = false;
    this.activeRestoreId = null;

    rootEl.querySelector('#btn-export-stashes').addEventListener('click', () => this.exportStashes());
    rootEl.querySelector('#btn-import-stashes').addEventListener('change', (e) => this.importStashes(e));

    // Listen for restore progress broadcasts from the service worker
    this._progressPending = null;
    this._progressRafId = null;
    this._onRestoreProgress = (message) => {
      if (message.action === 'restoreProgress' && message.restoreId === this.activeRestoreId) {
        this._progressPending = message;
        if (!this._progressRafId) {
          this._progressRafId = requestAnimationFrame(() => {
            this._progressRafId = null;
            const m = this._progressPending;
            if (m) this.updateProgress(m.restoreId, m.created, m.loaded, m.total);
          });
        }
      }
    };
    chrome.runtime.onMessage.addListener(this._onRestoreProgress);
  }

  updateProgress(restoreId, created, loaded, total) {
    const container = this.listEl.querySelector(`[data-restore-id="${restoreId}"] .restore-progress`);
    if (!container) return;
    container.classList.add('active');
    const fill = container.querySelector('.restore-progress-fill');
    const label = container.querySelector('.restore-progress-label');
    if (fill) {
      fill.style.width = `${Math.round((loaded / total) * 100)}%`;
      if (loaded < created) {
        fill.classList.add('loading');
      } else {
        fill.classList.remove('loading');
      }
    }
    if (label) {
      if (loaded === 0 && created > 0) {
        label.textContent = `Creating tabs... (${created} / ${total})`;
      } else if (loaded > 0 && loaded < total) {
        label.textContent = `Loading... ${loaded} / ${total} tabs ready`;
      } else if (loaded >= total) {
        label.textContent = 'Finishing up...';
      }
    }
  }

  async refresh({ notifyFailure = true } = {}) {
    try {
      // Check Drive connection status
      const driveState = await Storage.get('driveSync');
      const stashes = await this.send({ action: 'listStashes' });
      this.driveConnected = driveState?.connected || false;
      this.render(stashes);
      this._lastRefreshError = null;
      return true;
    } catch (err) {
      this._lastRefreshError = err;
      if (notifyFailure) showToast('Failed to load stashes: ' + err.message, 'error');
      return false;
    }
  }

  render(stashes) {
    this.listEl.innerHTML = '';

    if (!stashes || stashes.length === 0) {
      this.listEl.innerHTML = '<p class="empty-state">No stashed tabs yet. Stash a window, group, or domain to save and close tabs.</p>';
      return;
    }

    for (const stash of stashes) {
      this.listEl.appendChild(this.createStashCard(stash));
    }
  }

  createStashCard(stash) {
    const card = document.createElement('div');
    card.className = 'stash-card';
    card.dataset.restoreId = stash.id;

    // Header: name + source badge + restored badge
    const header = document.createElement('div');
    header.className = 'stash-card-header';

    const name = document.createElement('span');
    name.className = 'stash-name';
    name.textContent = stash.name;
    name.title = stash.name;

    const badge = document.createElement('span');
    badge.className = `stash-source-badge source-${stash.source || 'window'}`;
    badge.textContent = stash.source || 'window';

    header.appendChild(name);
    header.appendChild(badge);

    if (stash.restoredAt) {
      const restoredBadge = document.createElement('span');
      restoredBadge.className = 'stash-restored-badge';
      restoredBadge.textContent = 'Restored';
      header.appendChild(restoredBadge);
    }

    // Favicon preview
    const allTabs = (stash.windows || []).flatMap(w => w.tabs || []);
    const preview = document.createElement('div');
    preview.className = 'stash-preview';

    const maxFavicons = 5;
    const shown = allTabs.slice(0, maxFavicons);
    const fallbackSvg = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ccc"/></svg>';

    for (const tab of shown) {
      const img = document.createElement('img');
      img.className = 'stash-preview-favicon';
      img.src = safeFaviconUrl(tab.favIconUrl) || fallbackSvg;
      img.alt = '';
      img.addEventListener('error', () => { img.src = fallbackSvg; }, { once: true });
      preview.appendChild(img);
    }

    if (allTabs.length > maxFavicons) {
      const more = document.createElement('span');
      more.className = 'stash-preview-more';
      more.textContent = `+${allTabs.length - maxFavicons}`;
      preview.appendChild(more);
    }

    // Meta line
    const meta = document.createElement('div');
    meta.className = 'stash-meta';

    const date = new Date(stash.createdAt);
    const dateStr = date.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const winCount = (stash.windows || []).length;
    const parts = [`${stash.tabCount || allTabs.length} tabs`];
    if (winCount > 1) parts.push(`${winCount} windows`);
    parts.push(dateStr);
    meta.textContent = parts.join(' \u00b7 ');

    // Actions
    const actions = document.createElement('div');
    actions.className = 'stash-actions';

    const restoreBtn = this.createBtn('Restore', 'action-btn secondary', async () => {
      if (stash.restoredAt) {
        const ok = await showConfirm({
          title: 'Restore again?',
          message: 'This stash was already restored. Restore again?',
          confirmLabel: 'Restore',
        });
        if (!ok) return;
      }
      restoreBtn.disabled = true;
      restoreBtn.textContent = 'Restoring...';
      this.activeRestoreId = stash.id;
      await this.restoreStash(stash.id, { mode: 'windows' });
      this.activeRestoreId = null;
      this.hideProgress(stash.id);
      restoreBtn.disabled = false;
      restoreBtn.textContent = 'Restore';
    });

    const restoreHereBtn = this.createBtn('Restore here', 'action-btn secondary', async () => {
      if (stash.restoredAt) {
        const ok = await showConfirm({
          title: 'Restore again?',
          message: 'This stash was already restored. Restore again?',
          confirmLabel: 'Restore',
        });
        if (!ok) return;
      }
      restoreHereBtn.disabled = true;
      restoreHereBtn.textContent = 'Restoring...';
      this.activeRestoreId = stash.id;
      await this.restoreStash(stash.id, { mode: 'here' });
      this.activeRestoreId = null;
      this.hideProgress(stash.id);
      restoreHereBtn.disabled = false;
      restoreHereBtn.textContent = 'Restore here';
    });

    // Per-stash Export button (download arrow)
    const exportBtn = this.createBtn('\u2913', 'stash-btn icon-btn', async () => {
      await this.exportSingleStash(stash);
    });
    exportBtn.title = 'Export this stash as JSON';

    // Per-stash Drive upload button (cloud icon, shown when Drive connected)
    const driveBtn = this.createBtn('\u2601', 'stash-btn icon-btn', async () => {
      driveBtn.disabled = true;
      try {
        await this.send({ action: 'exportStashToDrive', stashId: stash.id });
        showToast(`"${stash.name}" saved to Drive`, 'success');
      } catch (err) {
        showToast('Drive upload failed: ' + err.message, 'error');
      }
      driveBtn.disabled = false;
    });
    driveBtn.title = 'Save to Google Drive';
    if (!this.driveConnected) driveBtn.hidden = true;

    const deleteBtn = this.createBtn('Delete', 'action-btn danger', async () => {
      await this.deleteStash(stash);
    });

    actions.appendChild(restoreBtn);
    actions.appendChild(restoreHereBtn);
    actions.appendChild(exportBtn);
    actions.appendChild(driveBtn);
    actions.appendChild(deleteBtn);

    // Progress bar (hidden by default)
    const progressContainer = document.createElement('div');
    progressContainer.className = 'restore-progress';
    progressContainer.innerHTML = `
      <div class="restore-progress-bar"><div class="restore-progress-fill"></div></div>
      <div class="restore-progress-label"></div>
    `;

    card.appendChild(header);
    card.appendChild(preview);
    card.appendChild(meta);
    card.appendChild(progressContainer);
    card.appendChild(actions);
    return card;
  }

  hideProgress(restoreId) {
    const container = this.listEl.querySelector(`[data-restore-id="${restoreId}"] .restore-progress`);
    if (container) {
      container.classList.remove('active');
      const fill = container.querySelector('.restore-progress-fill');
      if (fill) {
        fill.style.width = '0%';
        fill.classList.remove('loading');
      }
    }
  }

  async restoreStash(id, options) {
    try {
      // Let service worker read removeStashAfterRestore from settings
      const result = await this.send({
        action: 'restoreStash',
        stashId: id,
        options,
      });
      const feedback = formatRestoreFeedback(result, { source: 'stash' });

      const refreshed = await this.refresh({ notifyFailure: false });
      if (!refreshed) {
        showToast(
          `${feedback.message} View could not refresh: ${this._lastRefreshError?.message || 'unknown error'}.`,
          'error',
        );
        return;
      }
      showToast(feedback.message, feedback.type);
    } catch (err) {
      showToast(`Restore failed: ${err.message}`, 'error');
    }
  }

  async deleteStash(stash) {
    const undoOptions = {
      label: 'Undo',
      callback: async () => {
        try {
          await this.send({ action: 'undoDeleteStash', stash });
        } catch (err) {
          showToast('Undo failed: ' + err.message, 'error');
          return;
        }
        const refreshed = await this.refresh({ notifyFailure: false });
        if (!refreshed) {
          showToast(`Restored "${stash.name}", but the view could not refresh: ${this._lastRefreshError?.message || 'unknown error'}`, 'error');
          return;
        }
        showToast(`Restored "${stash.name}"`, 'success');
      },
    };

    try {
      await this.send({ action: 'deleteStash', stashId: stash.id });
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
      return;
    }

    const refreshed = await this.refresh({ notifyFailure: false });
    if (!refreshed) {
      showToast(
        `Deleted "${stash.name}", but the view could not refresh: ${this._lastRefreshError?.message || 'unknown error'}`,
        'error',
        8000,
        undoOptions,
      );
      return;
    }
    showToast(`Deleted "${stash.name}"`, 'success', 8000, undoOptions);
  }

  async exportSingleStash(stash) {
    try {
      const payload = await this.send({
        action: 'buildPortableStashExport',
        stashId: stash.id,
      });
      const safeName = (stash.name || 'stash').replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40);
      downloadJson(payload, `tabkebab-stash-${safeName}-${Date.now()}.json`);

      showToast('Stash exported', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  }

  async exportStashes() {
    try {
      const payload = await this.send({ action: 'buildPortableExport', kind: 'stashes' });
      if (payload.stashes.length === 0) {
        showToast('No stashes to export', 'info');
        return;
      }
      downloadJson(payload, `tabkebab-stashes-${Date.now()}.json`);

      showToast('Stashes exported', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  }

  async importStashes(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const document = await readPortableImportFile(file, ['stashes']);
      const result = await this.send({ action: 'importPortableData', document });
      const refreshed = await this.refresh({ notifyFailure: false });
      if (!refreshed) {
        showToast(
          `Stashes were imported, but the view could not refresh: ${this._lastRefreshError?.message || 'unknown error'}`,
          'error',
        );
        return;
      }
      showToast(
        formatPortableImportSummary(result, 'Stash import'),
        portableImportToastType(result),
      );
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    } finally {
      e.target.value = '';
    }
  }

  createBtn(text, className, onClick) {
    const btn = document.createElement('button');
    btn.className = className;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  send(msg) {
    return sendOrThrow(msg);
  }
}
