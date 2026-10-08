// session-manager.js — Save/restore/delete sessions + export/import

import { showToast } from './toast.js';
import { downloadJson, readPortableImportFile } from '../../core/export-import.js';
import { sendOrThrow } from '../message-client.js';
import { formatRestoreFeedback, friendlyErrorMessage } from '../restore-feedback.js';
import { defaultSessionName, formatRecordDate, pluralize } from '../record-format.js';
import {
  formatPortableImportSummary,
  portableImportToastType,
} from '../portable-import-summary.js';
import { renderActionableEmptyState } from './actionable-empty-state.js';
import { closeMoreMenu, wireMoreMenu } from '../more-menu.js';

export class SessionManager {
  constructor(rootEl, { navigate = () => {} } = {}) {
    this.root = rootEl;
    this.notify = showToast;
    this.navigate = navigate;
    this.savedListEl = rootEl.querySelector('#session-list-saved');
    this.autoListEl = rootEl.querySelector('#session-list-auto');
    // Restore ids currently in flight (id → count, since "Restore" and
    // "Restore here" may run concurrently for the same item). A single id
    // would let one restore's completion silence another's progress.
    this.activeRestores = new Map();

    rootEl.querySelector('#btn-save-session').addEventListener('click', () => this.saveSession());
    rootEl.querySelector('#btn-export').addEventListener('click', () => {
      closeMoreMenu(rootEl);
      void this.export();
    });
    rootEl.querySelector('#btn-import').addEventListener('change', (e) => {
      closeMoreMenu(rootEl);
      void this.import(e);
    });
    wireMoreMenu(rootEl);

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
    // Latest pending progress per restore id, flushed once per frame.
    this._progressPending = new Map();
    this._progressRafId = null;
    this._onRestoreProgress = (message) => {
      if (message?.action === 'restoreProgress' && this.isRestoreActive(message.restoreId)) {
        this._progressPending.set(message.restoreId, message);
        if (!this._progressRafId) {
          this._progressRafId = requestAnimationFrame(() => {
            this._progressRafId = null;
            const pending = [...this._progressPending.values()];
            this._progressPending.clear();
            for (const m of pending) {
              if (this.isRestoreActive(m.restoreId)) {
                this.updateProgress(m.restoreId, m.created, m.loaded, m.total);
              }
            }
          });
        }
      }
    };
    chrome.runtime.onMessage.addListener(this._onRestoreProgress);
  }

  isRestoreActive(restoreId) {
    return this.activeRestores.has(restoreId);
  }

  beginRestore(restoreId) {
    this.activeRestores.set(restoreId, (this.activeRestores.get(restoreId) || 0) + 1);
  }

  /** Returns true when no other restore of the same id is still running. */
  endRestore(restoreId) {
    const remaining = (this.activeRestores.get(restoreId) || 1) - 1;
    if (remaining > 0) {
      this.activeRestores.set(restoreId, remaining);
      return false;
    }
    this.activeRestores.delete(restoreId);
    this._progressPending?.delete?.(restoreId);
    return true;
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

  async refresh({ notifyFailure = true } = {}) {
    try {
      const sessions = await this.send({ action: 'listSessions' });
      this.render(sessions);
      this._lastRefreshError = null;
      return true;
    } catch (err) {
      this._lastRefreshError = err;
      if (notifyFailure) this.notify('Could not load sessions: ' + friendlyErrorMessage(err), 'error');
      return false;
    }
  }

  render(sessions) {
    this.savedListEl.innerHTML = '';
    this.autoListEl.innerHTML = '';

    if (!sessions || sessions.length === 0) {
      this.renderSavedEmptyState();
      this.renderAutoEmptyState();
      return;
    }

    const saved = sessions.filter(s => !s.name.startsWith('[Auto] '));
    const auto = sessions.filter(s => s.name.startsWith('[Auto] '));

    if (saved.length === 0) {
      this.renderSavedEmptyState();
    } else {
      for (const session of saved) {
        this.savedListEl.appendChild(this.createSessionCard(session, false));
      }
    }

    if (auto.length === 0) {
      this.renderAutoEmptyState();
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

  renderSavedEmptyState() {
    renderActionableEmptyState(this.savedListEl, {
      message: 'Save all open windows as a session you can restore later.',
      actionLabel: 'Name a session',
      onAction: () => this.root.querySelector('#session-name')?.focus(),
    });
  }

  renderAutoEmptyState() {
    renderActionableEmptyState(this.autoListEl, {
      message: 'Automatic snapshots appear here after auto-save runs.',
      actionLabel: 'Set up auto-save',
      onAction: () => this.navigate({
        view: 'settings',
        sectionId: 'settings-automation-section',
      }),
    });
  }

  createSessionCard(session, isAutoSave) {
    const card = document.createElement('div');
    card.className = `session-card record-card${isAutoSave ? ' session-auto' : ''}`;
    card.dataset.restoreId = session.id;

    // For auto-saves, strip the "[Auto] " prefix since the tab already indicates it
    const displayName = isAutoSave
      ? session.name.replace(/^\[Auto] /, '')
      : session.name;

    const nameEl = document.createElement('div');
    nameEl.className = 'session-name';
    nameEl.textContent = displayName;
    nameEl.title = displayName;

    const metaEl = document.createElement('div');
    metaEl.className = 'session-meta';
    metaEl.textContent = this.buildMetaText(session);

    const progress = document.createElement('div');
    progress.className = 'restore-progress';
    progress.innerHTML = `
      <div class="restore-progress-bar"><div class="restore-progress-fill"></div></div>
      <div class="restore-progress-label"></div>
    `;

    const actions = document.createElement('div');
    actions.className = 'session-actions record-actions';

    const runRestore = (btn, idleText, mode) => async () => {
      btn.disabled = true;
      btn.textContent = 'Restoring...';
      this.beginRestore(session.id);
      try {
        const result = await this.send({
          action: 'restoreSession',
          sessionId: session.id,
          options: { mode },
        });
        this.showRestoreResult(result);
      } catch (err) {
        showToast(`Restore failed: ${friendlyErrorMessage(err)}`, 'error');
      } finally {
        if (this.endRestore(session.id)) this.hideProgress(session.id);
        btn.disabled = false;
        btn.textContent = idleText;
      }
    };

    const restoreBtn = this.createBtn('Restore', 'action-btn', null);
    restoreBtn.title = 'Reopen this session in new windows';
    restoreBtn.addEventListener('click', runRestore(restoreBtn, 'Restore', 'windows'));

    const restoreHereBtn = this.createBtn('Restore here', 'action-btn secondary', null);
    restoreHereBtn.title = 'Reopen this session in this window';
    restoreHereBtn.addEventListener('click', runRestore(restoreHereBtn, 'Restore here', 'here'));

    const spacer = document.createElement('span');
    spacer.className = 'record-actions-spacer';

    const exportBtn = this.createBtn('\u2913', 'action-btn secondary icon-btn record-icon-btn', async () => {
      try {
        const payload = await this.send({
          action: 'buildPortableSessionExport',
          sessionId: session.id,
        });
        const safeName = (session.name || 'session').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
        downloadJson(payload, `tabkebab-session-${safeName}-${Date.now()}.json`);
        showToast(`Exported "${displayName}"`, 'success');
      } catch (err) {
        showToast('Export failed: ' + friendlyErrorMessage(err), 'error');
      }
    });
    exportBtn.title = 'Export this session as JSON';
    exportBtn.setAttribute('aria-label', `Export ${displayName}`);

    const deleteBtn = this.createBtn('Delete', 'action-btn ghost-danger', async () => {
      await this.deleteSessionRecord(session);
    });
    deleteBtn.setAttribute('aria-label', `Delete session ${displayName}`);

    actions.appendChild(restoreBtn);
    actions.appendChild(restoreHereBtn);
    actions.appendChild(spacer);
    actions.appendChild(exportBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(nameEl);
    card.appendChild(metaEl);
    card.appendChild(progress);
    card.appendChild(actions);
    return card;
  }

  async deleteSessionRecord(session) {
    let deletion;
    try {
      deletion = await this.send({ action: 'deleteSession', sessionId: session.id });
    } catch (error) {
      this.notify(`Delete failed: ${friendlyErrorMessage(error)}`, 'error');
      return false;
    }
    if (deletion?.deleted !== true) {
      this.notify('Session was not deleted because it no longer exists', 'error');
      await this.refresh();
      return false;
    }

    const undoOptions = {
      label: 'Undo',
      callback: async () => {
        let result;
        try {
          result = await this.send({ action: 'undoDeleteSession', session });
          if (result?.restored !== true) throw new Error('Worker did not confirm the restore');
        } catch (error) {
          this.notify(`Undo failed: ${friendlyErrorMessage(error)}`, 'error');
          return;
        }
        try {
          const refreshed = await this.refresh({ notifyFailure: false });
          if (refreshed === false) throw new Error('Session view refresh failed');
          this.notify(`Restored "${session.name}"`, 'success');
        } catch {
          this.notify(`Restored "${session.name}", but the view could not refresh`, 'error');
        }
      },
    };
    try {
      const refreshed = await this.refresh({ notifyFailure: false });
      if (refreshed === false) throw new Error('Session view refresh failed');
      this.notify(`Deleted "${session.name}"`, 'success', 8000, undoOptions);
    } catch {
      this.notify(`Deleted "${session.name}", but the view could not refresh`, 'error', 8000, undoOptions);
    }
    return true;
  }

  buildMetaText(session, now = new Date()) {
    const dateStr = formatRecordDate(session?.createdAt, { now });
    const parts = [];
    if (Array.isArray(session?.windows)) {
      const tabCount = session.windows.reduce((sum, w) => sum + (w.tabCount ?? w.tabs?.length ?? 0), 0);
      const winCount = session.windows.length;
      const groupCount = session.windows.reduce((sum, w) => sum + (w.groups?.length || 0), 0);
      parts.push(pluralize(tabCount, 'tab'), pluralize(winCount, 'window'));
      if (groupCount > 0) parts.push(pluralize(groupCount, 'group'));
    } else {
      // v1 fallback
      parts.push(pluralize(session?.tabs ? session.tabs.length : 0, 'tab'));
    }
    if (dateStr) parts.push(dateStr);
    return parts.join(' \u00b7 ');
  }

  showRestoreResult(result) {
    const feedback = formatRestoreFeedback(result, { source: 'session' });
    showToast(feedback.message, feedback.type);
  }

  async saveSession({ now = new Date() } = {}) {
    const input = this.root.querySelector('#session-name');
    // An empty name is not an error: fall back to a timestamped default.
    const name = input.value.trim() || defaultSessionName(now);

    try {
      await this.send({ action: 'saveSession', name });
      input.value = '';
      const refreshed = await this.refresh({ notifyFailure: false });
      if (!refreshed) {
        showToast(`Session "${name}" was saved, but the view could not refresh: ${friendlyErrorMessage(this._lastRefreshError)}`, 'error');
        return;
      }
      showToast(`Session "${name}" saved`, 'success');
    } catch (err) {
      showToast('Could not save session: ' + friendlyErrorMessage(err), 'error');
    }
  }

  async export() {
    try {
      const payload = await this.send({ action: 'buildPortableExport', kind: 'full' });
      downloadJson(payload, `tabkebab-export-${Date.now()}.json`);
      showToast('Data exported', 'success');
    } catch (err) {
      showToast('Export failed: ' + friendlyErrorMessage(err), 'error');
    }
  }

  async import(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const document = await readPortableImportFile(file, ['full', 'sessions']);
      const result = await this.send({ action: 'importPortableData', document });
      const refreshed = await this.refresh({ notifyFailure: false });
      if (!refreshed) {
        showToast(
          `Data was imported, but the view could not refresh: ${friendlyErrorMessage(this._lastRefreshError)}`,
          'error',
        );
        return;
      }
      showToast(
        formatPortableImportSummary(result, 'Data import'),
        portableImportToastType(result),
      );
    } catch (err) {
      showToast('Import failed: ' + friendlyErrorMessage(err), 'error');
    } finally {
      // Reset file input so the same file can be imported again.
      e.target.value = '';
    }
  }

  createBtn(text, className, onClick) {
    const btn = document.createElement('button');
    btn.className = className;
    btn.type = 'button';
    btn.textContent = text;
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
  }

  send(msg) {
    return sendOrThrow(msg);
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
