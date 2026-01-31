// command-bar.js — Natural language command input bar

import { showToast } from './toast.js';

export class CommandBar {
  constructor(rootEl) {
    this.root = rootEl;
    this.inputEl = rootEl.querySelector('#ai-command-input');
    this.resultsEl = rootEl.querySelector('#command-results');
    this.pending = false;

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.pending) {
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

    this.pending = true;
    this.inputEl.disabled = true;
    this.resultsEl.innerHTML = '<p class="loading-text">Thinking...</p>';

    try {
      const result = await this.send({ action: 'executeNLCommand', command });

      if (result.error) {
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
      }
    } catch (err) {
      showToast('Command failed: ' + err.message, 'error');
      this.resultsEl.innerHTML = '';
    } finally {
      this.pending = false;
      this.inputEl.disabled = false;
      this.inputEl.focus();
    }
  }

  // ── Find Results ──

  showFindResults(result) {
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
        showToast('Failed to group: ' + err.message, 'error');
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
      row.addEventListener('click', () => {
        this.send({ action: 'focusTab', tabId: tab.id });
      });

      const favicon = document.createElement('img');
      favicon.className = 'find-result-favicon';
      favicon.src = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
      favicon.width = 16;
      favicon.height = 16;
      favicon.addEventListener('error', () => {
        favicon.style.visibility = 'hidden';
      });

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
      } catch (err) {
        showToast('Failed to close: ' + err.message, 'error');
      }
      this.resultsEl.innerHTML = '';
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
    this.resultsEl.innerHTML = '';

    const msg = document.createElement('p');
    msg.className = 'command-confirmation';
    msg.textContent = result.confirmation;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'action-btn';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.addEventListener('click', async () => {
      this.resultsEl.innerHTML = '<p class="loading-text">Executing...</p>';
      try {
        const execResult = await this.send({
          action: 'confirmNLCommand',
          parsedCommand: result.parsedCommand,
        });
        showToast(execResult.message || 'Done', 'success');
        this.inputEl.value = '';
      } catch (err) {
        showToast('Execution failed', 'error');
      }
      this.resultsEl.innerHTML = '';
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

  send(msg) {
    return chrome.runtime.sendMessage(msg);
  }
}
