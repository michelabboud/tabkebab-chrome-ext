// stash-list.js — Stash view: list, restore, delete, export/import stashes

import { showToast } from './toast.js';
import { showConfirm } from './confirm-dialog.js';
import { Storage } from '../../core/storage.js';

export class StashList {
  constructor(rootEl) {
    this.root = rootEl;
    this.listEl = rootEl.querySelector('#stash-list');
    this.driveConnected = false;
    this.activeRestoreId = null;

    rootEl.querySelector('#btn-export-stashes').addEventListener('click', () => this.exportStashes());
    rootEl.querySelector('#btn-import-stashes').addEventListener('change', (e) => this.importStashes(e));

    // Listen for restore progress broadcasts from the service worker
    this._onRestoreProgress = (message) => {
      if (message.action === 'restoreProgress' && message.restoreId === this.activeRestoreId) {
        this.updateProgress(message.restoreId, message.current, message.total);
      }
    };
    chrome.runtime.onMessage.addListener(this._onRestoreProgress);
  }

  updateProgress(restoreId, current, total) {
    const container = this.listEl.querySelector(`[data-restore-id="${restoreId}"] .restore-progress`);
    if (!container) return;
    container.classList.add('active');
    const fill = container.querySelector('.restore-progress-fill');
    const label = container.querySelector('.restore-progress-label');
    if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
    if (label) label.textContent = `Restoring ${current} / ${total} tabs...`;
  }

  async refresh() {
    try {
      // Check Drive connection status
      const driveState = await Storage.get('driveSync');
      this.driveConnected = driveState?.connected || false;

      const stashes = await this.send({ action: 'listStashes' });
      this.render(stashes);
    } catch {
      showToast('Failed to load stashes', 'error');
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
      img.src = tab.favIconUrl || fallbackSvg;
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
      await this.restoreStash(stash.id, stash.name, { mode: 'windows' });
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
      await this.restoreStash(stash.id, stash.name, { mode: 'here' });
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
      const ok = await showConfirm({
        title: 'Delete stash?',
        message: `"${stash.name}" will be permanently deleted.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (ok) await this.deleteStash(stash.id, stash.name);
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
      if (fill) fill.style.width = '0%';
    }
  }

  async restoreStash(id, name, options) {
    try {
      // Let service worker read removeStashAfterRestore from settings
      const result = await this.send({
        action: 'restoreStash',
        stashId: id,
        options,
      });

      if (result.restoredCount === 0) {
        showToast('All tabs already open \u2014 nothing to restore', 'info');
      } else {
        const parts = [`Restored ${result.restoredCount} tabs`];
        if (result.windowsCreated > 0) {
          parts[0] += ` in ${result.windowsCreated} window${result.windowsCreated > 1 ? 's' : ''}`;
        }
        if (result.groupsRestored > 0) {
          parts.push(`${result.groupsRestored} group${result.groupsRestored > 1 ? 's' : ''} restored`);
        }
        if (result.skippedDuplicate > 0) {
          parts.push(`${result.skippedDuplicate} duplicate${result.skippedDuplicate > 1 ? 's' : ''} skipped`);
        }
        showToast(parts.join(' \u2014 '), 'success');
      }
      this.refresh();
    } catch (err) {
      showToast(`Restore failed: ${err.message}`, 'error');
    }
  }

  async deleteStash(id, name) {
    try {
      await this.send({ action: 'deleteStash', stashId: id });
      showToast(`Deleted "${name}"`, 'success');
      this.refresh();
    } catch {
      showToast('Delete failed', 'error');
    }
  }

  async exportSingleStash(stash) {
    try {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        stashes: [stash],
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tabkebab-stash-${stash.name.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showToast('Stash exported', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  }

  async exportStashes() {
    try {
      const stashes = await this.send({ action: 'listStashes' });
      if (!stashes || stashes.length === 0) {
        showToast('No stashes to export', 'info');
        return;
      }

      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        stashes,
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tabkebab-stashes-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showToast('Stashes exported', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  }

  async importStashes(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.stashes || !Array.isArray(data.stashes)) {
        throw new Error('No stashes found in file');
      }

      const result = await this.send({ action: 'importStashes', stashes: data.stashes });
      showToast(`Imported ${result.imported} stash(es), ${result.skipped} skipped`, 'success');
      this.refresh();
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    }

    e.target.value = '';
  }

  createBtn(text, className, onClick) {
    const btn = document.createElement('button');
    btn.className = className;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  send(msg) {
    return chrome.runtime.sendMessage(msg);
  }
}
