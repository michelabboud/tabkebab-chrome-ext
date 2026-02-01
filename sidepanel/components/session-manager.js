// session-manager.js — Save/restore/delete sessions + export/import

import { showToast } from './toast.js';
import { exportData, exportSession, importData } from '../../core/export-import.js';

export class SessionManager {
  constructor(rootEl) {
    this.root = rootEl;
    this.savedListEl = rootEl.querySelector('#session-list-saved');
    this.autoListEl = rootEl.querySelector('#session-list-auto');
    this.activeRestoreId = null;

    rootEl.querySelector('#btn-save-session').addEventListener('click', () => this.saveSession());
    rootEl.querySelector('#btn-export').addEventListener('click', () => this.export());
    rootEl.querySelector('#btn-import').addEventListener('change', (e) => this.import(e));

    // Allow pressing Enter in the input to save
    rootEl.querySelector('#session-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.saveSession();
    });

    // Session sub-tab switching
    const sessionTabs = rootEl.querySelectorAll('.session-sub-nav [role="tab"]');
    sessionTabs.forEach(btn => {
      btn.addEventListener('click', () => {
        sessionTabs.forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');

        const target = btn.dataset.sessionTab;
        this.savedListEl.hidden = target !== 'saved';
        this.autoListEl.hidden = target !== 'auto';
      });
    });

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
    const container =
      this.savedListEl.querySelector(`[data-restore-id="${restoreId}"] .restore-progress`) ||
      this.autoListEl.querySelector(`[data-restore-id="${restoreId}"] .restore-progress`);
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

  hideProgress(restoreId) {
    const container =
      this.savedListEl.querySelector(`[data-restore-id="${restoreId}"] .restore-progress`) ||
      this.autoListEl.querySelector(`[data-restore-id="${restoreId}"] .restore-progress`);
    if (container) {
      container.classList.remove('active');
      const fill = container.querySelector('.restore-progress-fill');
      if (fill) {
        fill.style.width = '0%';
        fill.classList.remove('loading');
      }
    }
  }

  async refresh() {
    try {
      const sessions = await this.send({ action: 'listSessions' });
      this.render(sessions);
    } catch {
      showToast('Failed to load sessions', 'error');
    }
  }

  render(sessions) {
    this.savedListEl.innerHTML = '';
    this.autoListEl.innerHTML = '';

    if (!sessions || sessions.length === 0) {
      this.savedListEl.innerHTML = '<p class="empty-state">No saved sessions yet.</p>';
      this.autoListEl.innerHTML = '<p class="empty-state">No auto-saved sessions yet.</p>';
      return;
    }

    const saved = sessions.filter(s => !s.name.startsWith('[Auto] '));
    const auto = sessions.filter(s => s.name.startsWith('[Auto] '));

    if (saved.length === 0) {
      this.savedListEl.innerHTML = '<p class="empty-state">No saved sessions yet.</p>';
    } else {
      for (const session of saved) {
        this.savedListEl.appendChild(this.createSessionCard(session, false));
      }
    }

    if (auto.length === 0) {
      this.autoListEl.innerHTML = '<p class="empty-state">No auto-saved sessions yet.</p>';
    } else {
      for (const session of auto) {
        this.autoListEl.appendChild(this.createSessionCard(session, true));
      }
    }

    // Update auto tab badge with count
    const autoBadge = this.root.querySelector('.session-sub-nav [data-session-tab="auto"]');
    if (autoBadge) {
      const existing = autoBadge.querySelector('.session-auto-count');
      if (existing) existing.remove();
      if (auto.length > 0) {
        const count = document.createElement('span');
        count.className = 'session-auto-count';
        count.textContent = auto.length;
        autoBadge.appendChild(count);
      }
    }
  }

  createSessionCard(session, isAutoSave) {
    const card = document.createElement('div');
    card.className = `session-card${isAutoSave ? ' session-auto' : ''}`;

    const date = new Date(session.createdAt);
    const dateStr = date.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const meta = this.buildMetaText(session, dateStr);

    card.dataset.restoreId = session.id;

    // For auto-saves, strip the "[Auto] " prefix since the tab already indicates it
    const displayName = isAutoSave
      ? session.name.replace(/^\[Auto] /, '')
      : session.name;

    card.innerHTML = `
      <div class="session-name">${this.escapeHtml(displayName)}</div>
      <div class="session-meta">${meta}</div>
      <div class="restore-progress">
        <div class="restore-progress-bar"><div class="restore-progress-fill"></div></div>
        <div class="restore-progress-label"></div>
      </div>
      <div class="session-actions"></div>
    `;

    const actions = card.querySelector('.session-actions');

    const restoreBtn = this.createBtn('Restore', 'action-btn secondary', async () => {
      restoreBtn.disabled = true;
      restoreBtn.textContent = 'Restoring...';
      this.activeRestoreId = session.id;
      try {
        const result = await this.send({
          action: 'restoreSession',
          sessionId: session.id,
          options: { mode: 'windows' },
        });
        this.showRestoreResult(session.name, result);
      } catch (err) {
        showToast(`Restore failed: ${err.message}`, 'error');
      } finally {
        this.activeRestoreId = null;
        this.hideProgress(session.id);
        restoreBtn.disabled = false;
        restoreBtn.textContent = 'Restore';
      }
    });

    const restoreHereBtn = this.createBtn('Restore here', 'action-btn secondary', async () => {
      restoreHereBtn.disabled = true;
      restoreHereBtn.textContent = 'Restoring...';
      this.activeRestoreId = session.id;
      try {
        const result = await this.send({
          action: 'restoreSession',
          sessionId: session.id,
          options: { mode: 'here' },
        });
        this.showRestoreResult(session.name, result);
      } catch (err) {
        showToast(`Restore failed: ${err.message}`, 'error');
      } finally {
        this.activeRestoreId = null;
        this.hideProgress(session.id);
        restoreHereBtn.disabled = false;
        restoreHereBtn.textContent = 'Restore here';
      }
    });

    const exportBtn = document.createElement('button');
    exportBtn.className = 'action-btn secondary icon-btn';
    exportBtn.title = 'Export this session';
    exportBtn.innerHTML = '\u2913'; // downwards arrow to bar
    exportBtn.addEventListener('click', async () => {
      try {
        await exportSession(session.id);
        showToast(`Exported "${session.name}"`, 'success');
      } catch (err) {
        showToast('Export failed: ' + err.message, 'error');
      }
    });

    const deleteBtn = this.createBtn('Delete', 'action-btn danger', async () => {
      await this.send({ action: 'deleteSession', sessionId: session.id });
      this.refresh();
      showToast(`Deleted "${session.name}"`, 'success', 8000, {
        label: 'Undo',
        callback: async () => {
          try {
            await this.send({ action: 'undoDeleteSession', session });
            showToast(`Restored "${session.name}"`, 'success');
            this.refresh();
          } catch {
            showToast('Undo failed', 'error');
          }
        },
      });
    });

    actions.appendChild(restoreBtn);
    actions.appendChild(restoreHereBtn);
    actions.appendChild(exportBtn);
    actions.appendChild(deleteBtn);

    return card;
  }

  buildMetaText(session, dateStr) {
    if (session.windows) {
      const tabCount = session.windows.reduce((sum, w) => sum + w.tabCount, 0);
      const winCount = session.windows.length;
      const groupCount = session.windows.reduce((sum, w) => sum + (w.groups?.length || 0), 0);
      const winLabel = winCount === 1 ? '1 window' : `${winCount} windows`;
      let meta = `${tabCount} tabs \u00b7 ${winLabel}`;
      if (groupCount > 0) {
        meta += ` \u00b7 ${groupCount} group${groupCount !== 1 ? 's' : ''}`;
      }
      return `${meta} \u00b7 ${dateStr}`;
    }
    // v1 fallback
    const tabCount = session.tabs ? session.tabs.length : 0;
    return `${tabCount} tabs \u00b7 ${dateStr}`;
  }

  showRestoreResult(name, result) {
    if (result.restoredCount === 0) {
      showToast('All tabs already open \u2014 nothing to restore', 'info');
      return;
    }

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

  async saveSession() {
    const input = this.root.querySelector('#session-name');
    const name = input.value.trim();
    if (!name) {
      showToast('Enter a session name', 'error');
      input.focus();
      return;
    }

    try {
      await this.send({ action: 'saveSession', name });
      showToast(`Session "${name}" saved`, 'success');
      input.value = '';
      this.refresh();
    } catch {
      showToast('Failed to save session', 'error');
    }
  }

  async export() {
    try {
      await exportData();
      showToast('Data exported', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  }

  async import(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      await importData(file);
      showToast('Data imported successfully', 'success');
      this.refresh();
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    }

    // Reset file input so the same file can be imported again
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

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
