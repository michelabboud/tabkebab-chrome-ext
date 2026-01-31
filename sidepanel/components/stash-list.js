// stash-list.js — Stash view: list, restore, delete, export/import stashes

import { showToast } from './toast.js';

export class StashList {
  constructor(rootEl) {
    this.root = rootEl;
    this.listEl = rootEl.querySelector('#stash-list');

    rootEl.querySelector('#btn-export-stashes').addEventListener('click', () => this.exportStashes());
    rootEl.querySelector('#btn-import-stashes').addEventListener('change', (e) => this.importStashes(e));
  }

  async refresh() {
    try {
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

    // Header: name + source badge
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
      restoreBtn.disabled = true;
      restoreBtn.textContent = 'Restoring...';
      await this.restoreStash(stash.id, stash.name, { mode: 'windows' });
      restoreBtn.disabled = false;
      restoreBtn.textContent = 'Restore';
    });

    const restoreHereBtn = this.createBtn('Restore here', 'action-btn secondary', async () => {
      restoreHereBtn.disabled = true;
      restoreHereBtn.textContent = 'Restoring...';
      await this.restoreStash(stash.id, stash.name, { mode: 'here' });
      restoreHereBtn.disabled = false;
      restoreHereBtn.textContent = 'Restore here';
    });

    const deleteBtn = this.createBtn('Delete', 'action-btn danger', async () => {
      await this.deleteStash(stash.id, stash.name);
    });

    actions.appendChild(restoreBtn);
    actions.appendChild(restoreHereBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(header);
    card.appendChild(preview);
    card.appendChild(meta);
    card.appendChild(actions);
    return card;
  }

  async restoreStash(id, name, options) {
    try {
      const result = await this.send({
        action: 'restoreStash',
        stashId: id,
        options,
        deleteAfterRestore: true,
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
