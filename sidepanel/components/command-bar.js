// command-bar.js — Natural language command input bar

import { showToast } from './toast.js';
import { sendOrThrow } from '../message-client.js';
import { makeKeyboardActivatable } from './keyboard-activate.js';
import { friendlyErrorMessage } from '../restore-feedback.js';

// Parsed NL actions whose confirmation closes or removes tabs.
const DESTRUCTIVE_ACTIONS = new Set(['close', 'stash', 'discard', 'kebab']);

const THINKING_HTML = `
  <div class="pipeline-progress active command-progress" role="status">
    <div class="phase-label"><span>Thinking\u2026</span></div>
    <div class="progress-bar"><div class="progress-bar-fill indeterminate"></div></div>
  </div>`;

function progressHtml(label) {
  return THINKING_HTML.replace('Thinking\u2026', label);
}

export class CommandBar {
  constructor(rootEl) {
    this.root = rootEl;
    this.inputEl = rootEl.querySelector('#ai-command-input');
    this.resultsEl = rootEl.querySelector('#command-results');
    this.pending = false;
    this._confirmationGeneration = 0;

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !this.pending) {
        e.preventDefault();
        this.execute();
      }
    });

    rootEl.querySelector('#btn-ai-command').addEventListener('click', () => {
      if (!this.pending) this.execute();
    });
  }

  async execute() {
    const command = this.inputEl.value.trim();
    if (!command) return;

    this._confirmationGeneration += 1;
    this.pending = true;
    this.inputEl.disabled = true;
    this.resultsEl.innerHTML = THINKING_HTML;

    try {
      const result = await this.send({ action: 'executeNLCommand', command });

      if (!result || typeof result !== 'object') {
        showToast('Command failed: no response from background', 'error');
        this.resultsEl.innerHTML = '';
      } else if (result.error) {
        showToast(result.error, 'error');
        this.resultsEl.innerHTML = '';
      } else if (result.confirmation) {
        this.showConfirmation(result);
      } else if (result.action === 'find' && result.matchedTabs) {
        this.showFindResults(result);
      } else if (result.executed) {
        showToast(result.message || 'Done', 'success');
        this.resultsEl.innerHTML = '';
        this.inputEl.value = '';
      } else {
        showToast('Command produced no result', 'error');
        this.resultsEl.innerHTML = '';
      }
    } catch (err) {
      showToast('Command failed: ' + friendlyErrorMessage(err), 'error');
      this.resultsEl.innerHTML = '';
    } finally {
      this.pending = false;
      this.inputEl.disabled = false;
      this.inputEl.focus();
    }
  }

  // ── Find Results ──

  showFindResults(result) {
    this._beginResultRender();
    this.resultsEl.innerHTML = '';

    const tabs = result.matchedTabs;
    const tabIds = tabs.map(t => t.id);

    // Header
    const header = document.createElement('div');
    header.className = 'find-results-header';
    header.textContent = `Found ${tabs.length} tab${tabs.length !== 1 ? 's' : ''}`;

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'toolbar find-results-actions';

    const groupBtn = document.createElement('button');
    groupBtn.className = 'action-btn';
    groupBtn.textContent = 'Group';
    groupBtn.addEventListener('click', async () => {
      try {
        await this.send({ action: 'createTabGroup', tabIds, title: 'AI Results', color: 'blue' });
        showToast(`Grouped ${tabs.length} tabs`, 'success');
        this.resultsEl.innerHTML = '';
        this.inputEl.value = '';
      } catch (err) {
        showToast('Could not group tabs: ' + friendlyErrorMessage(err), 'error');
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'action-btn danger';
    closeBtn.textContent = 'Close all';
    closeBtn.addEventListener('click', () => {
      this.showCloseConfirmation(tabs);
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'action-btn secondary';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      this.resultsEl.innerHTML = '';
    });

    actions.appendChild(groupBtn);
    actions.appendChild(closeBtn);
    actions.appendChild(dismissBtn);

    // Tab list
    const list = document.createElement('div');
    list.className = 'find-results-list';

    for (const tab of tabs) {
      const row = document.createElement('div');
      row.className = 'find-result-item';
      row.addEventListener('click', async () => {
        try {
          await this.send({ action: 'focusTab', tabId: tab.id });
        } catch (err) {
          showToast('Could not switch to tab: ' + friendlyErrorMessage(err), 'error');
        }
      });
      makeKeyboardActivatable(row, { label: `Switch to ${tab.title || tab.url || 'tab'}` });

      const favicon = document.createElement('img');
      favicon.className = 'find-result-favicon';
      favicon.src = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ccc"/></svg>';
      favicon.width = 16;
      favicon.height = 16;
      favicon.addEventListener('error', () => {
        favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ccc"/></svg>';
      }, { once: true });

      const title = document.createElement('span');
      title.className = 'find-result-title';
      title.textContent = tab.title || tab.url || 'Untitled';
      title.title = tab.url || '';

      row.appendChild(favicon);
      row.appendChild(title);
      list.appendChild(row);
    }

    this.resultsEl.appendChild(header);
    this.resultsEl.appendChild(actions);
    this.resultsEl.appendChild(list);
  }

  showCloseConfirmation(tabs) {
    this._beginResultRender();
    const tabIds = tabs.map(t => t.id);
    this.resultsEl.innerHTML = '';

    const msg = document.createElement('p');
    msg.className = 'command-confirmation';
    msg.textContent = `Close ${tabs.length} tab${tabs.length !== 1 ? 's' : ''}?`;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'action-btn danger';
    confirmBtn.textContent = 'Yes, close';
    confirmBtn.addEventListener('click', async () => {
      try {
        await this.send({ action: 'closeTabs', tabIds });
        showToast(`Closed ${tabs.length} tabs`, 'success');
        this.inputEl.value = '';
        this.resultsEl.innerHTML = '';
      } catch (err) {
        showToast('Could not close tabs: ' + friendlyErrorMessage(err), 'error');
      }
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'action-btn secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      this.showFindResults({ matchedTabs: tabs });
    });

    const btns = document.createElement('div');
    btns.className = 'toolbar';
    btns.appendChild(confirmBtn);
    btns.appendChild(cancelBtn);

    this.resultsEl.appendChild(msg);
    this.resultsEl.appendChild(btns);
  }

  // ── Destructive Action Confirmation ──

  showConfirmation(result) {
    const generation = this._beginResultRender();
    this.resultsEl.innerHTML = '';

    const msg = document.createElement('p');
    msg.className = 'command-confirmation';
    msg.textContent = result.confirmation;

    const parsedAction = String(result.parsedCommand?.action || '').toLowerCase();
    const destructive = DESTRUCTIVE_ACTIONS.has(parsedAction);
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = destructive ? 'action-btn danger' : 'action-btn';
    confirmBtn.textContent = parsedAction === 'close' ? 'Close tabs'
      : parsedAction === 'stash' ? 'Stash tabs'
      : 'Confirm';
    confirmBtn.addEventListener('click', async () => {
      if (this._confirmationGeneration !== generation) return false;
      this._setConfirmationBusy(true);
      this.resultsEl.innerHTML = progressHtml('Working\u2026');
      try {
        const execResult = await this.send({
          action: 'confirmNLCommand',
          parsedCommand: result.parsedCommand,
        });
        if (this._confirmationGeneration !== generation) return false;
        showToast(execResult?.message || 'Done', 'success');
        this.inputEl.value = '';
        this.resultsEl.innerHTML = '';
        return true;
      } catch (err) {
        if (this._confirmationGeneration !== generation) return false;
        showToast('Execution failed: ' + friendlyErrorMessage(err), 'error');
        this.showConfirmation(result);
        return false;
      } finally {
        if (this._confirmationGeneration === generation) {
          this._setConfirmationBusy(false);
        }
      }
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'action-btn secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      this.resultsEl.innerHTML = '';
    });

    const btns = document.createElement('div');
    btns.className = 'toolbar';
    btns.appendChild(confirmBtn);
    btns.appendChild(cancelBtn);

    this.resultsEl.appendChild(msg);
    this.resultsEl.appendChild(btns);
  }

  _beginResultRender() {
    this._confirmationGeneration = (this._confirmationGeneration || 0) + 1;
    this._setConfirmationBusy(false);
    return this._confirmationGeneration;
  }

  _setConfirmationBusy(busy) {
    this.pending = busy;
    this.inputEl.disabled = busy;
  }

  send(msg) {
    return sendOrThrow(msg);
  }
}
