// session-manager.js — Save/restore/delete sessions + export/import

import { showToast } from './toast.js';
import { exportData, exportSession, importData } from '../../core/export-import.js';

export class SessionManager {
  constructor(rootEl) {
    this.root = rootEl;
    this.listEl = rootEl.querySelector('#session-list');

    rootEl.querySelector('#btn-save-session').addEventListener('click', () => this.saveSession());
    rootEl.querySelector('#btn-export').addEventListener('click', () => this.export());
    rootEl.querySelector('#btn-import').addEventListener('change', (e) => this.import(e));

    // Allow pressing Enter in the input to save
    rootEl.querySelector('#session-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.saveSession();
    });
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
    this.listEl.innerHTML = '';

    if (!sessions || sessions.length === 0) {
      this.listEl.innerHTML = '<p class="empty-state">No saved sessions yet.</p>';
      return;
    }

    for (const session of sessions) {
      const card = document.createElement('div');
      const isAutoSave = session.name.startsWith('[Auto] ');
      card.className = `session-card${isAutoSave ? ' session-auto' : ''}`;

      const date = new Date(session.createdAt);
      const dateStr = date.toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });

      // v2 sessions have windows array; v1 have flat tabs array
      const meta = this.buildMetaText(session, dateStr);

      const autoBadge = isAutoSave ? '<span class="session-auto-badge">Auto</span>' : '';
      card.innerHTML = `
        <div class="session-name">${autoBadge}${this.escapeHtml(session.name)}</div>
        <div class="session-meta">${meta}</div>
        <div class="session-actions"></div>
      `;

      const actions = card.querySelector('.session-actions');

      const restoreBtn = this.createBtn('Restore', 'action-btn secondary', async () => {
        restoreBtn.disabled = true;
        restoreBtn.textContent = 'Restoring...';
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
          restoreBtn.disabled = false;
          restoreBtn.textContent = 'Restore';
        }
      });

      const restoreHereBtn = this.createBtn('Restore here', 'action-btn secondary', async () => {
        restoreHereBtn.disabled = true;
        restoreHereBtn.textContent = 'Restoring...';
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
        showToast(`Deleted "${session.name}"`, 'success');
        this.refresh();
      });

      actions.appendChild(restoreBtn);
      actions.appendChild(restoreHereBtn);
      actions.appendChild(exportBtn);
      actions.appendChild(deleteBtn);
      this.listEl.appendChild(card);
    }
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
