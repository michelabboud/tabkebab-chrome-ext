// duplicate-finder.js — Scan and close duplicate tabs

import { showToast } from './toast.js';

export class DuplicateFinder {
  constructor(rootEl) {
    this.root = rootEl;
    this.listEl = rootEl.querySelector('#duplicate-list');
    this.closeAllBtn = rootEl.querySelector('#btn-close-all-dupes');
    this.duplicates = [];

    rootEl.querySelector('#btn-scan-dupes').addEventListener('click', () => this.scan());
    this.closeAllBtn.addEventListener('click', () => this.closeAllDuplicates());
  }

  async refresh() {
    await this.scan();
  }

  async scan() {
    try {
      this.duplicates = await this.send({ action: 'findDuplicates' });
      this.render();
    } catch {
      showToast('Failed to scan for duplicates', 'error');
    }
  }

  render() {
    this.listEl.innerHTML = '';

    if (!this.duplicates || this.duplicates.length === 0) {
      this.listEl.innerHTML = '<p class="empty-state">No duplicate tabs found.</p>';
      this.closeAllBtn.disabled = true;
      return;
    }

    this.closeAllBtn.disabled = false;
    const totalDupes = this.duplicates.reduce((sum, g) => sum + g.tabs.length - 1, 0);
    this.closeAllBtn.textContent = `Close All Duplicates (${totalDupes})`;

    for (const group of this.duplicates) {
      const groupEl = document.createElement('div');
      groupEl.className = 'duplicate-group';

      const urlEl = document.createElement('div');
      urlEl.className = 'dupe-url';
      urlEl.textContent = group.url;
      groupEl.appendChild(urlEl);

      group.tabs.forEach((tab, index) => {
        const tabEl = document.createElement('div');
        tabEl.className = 'dupe-tab';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.tabId = tab.id;
        // First tab is the one to keep (unchecked), the rest are checked for closing
        checkbox.checked = index > 0;

        const label = document.createElement('label');
        const titleSpan = document.createElement('span');
        titleSpan.textContent = tab.title || 'Untitled';
        label.appendChild(checkbox);
        label.appendChild(titleSpan);

        if (index === 0) {
          const keepBadge = document.createElement('span');
          keepBadge.className = 'keep-badge';
          keepBadge.textContent = 'KEEP';
          tabEl.appendChild(label);
          tabEl.appendChild(keepBadge);
        } else {
          tabEl.appendChild(label);
        }

        const closeBtn = document.createElement('button');
        closeBtn.className = 'action-btn danger';
        closeBtn.textContent = 'Close';
        closeBtn.style.padding = '2px 8px';
        closeBtn.style.fontSize = '11px';
        closeBtn.addEventListener('click', async () => {
          await this.send({ action: 'closeTabs', tabIds: [tab.id] });
          showToast('Tab closed', 'success');
          this.scan();
        });
        tabEl.appendChild(closeBtn);

        groupEl.appendChild(tabEl);
      });

      this.listEl.appendChild(groupEl);
    }
  }

  async closeAllDuplicates() {
    // Close all checked tabs
    const checkboxes = this.listEl.querySelectorAll('input[type="checkbox"]:checked');
    const tabIds = Array.from(checkboxes).map(cb => parseInt(cb.dataset.tabId, 10));

    if (tabIds.length === 0) {
      showToast('No duplicates selected', 'error');
      return;
    }

    try {
      await this.send({ action: 'closeTabs', tabIds });
      showToast(`Closed ${tabIds.length} duplicate tab(s)`, 'success');
      this.scan();
    } catch {
      showToast('Failed to close duplicates', 'error');
    }
  }

  send(msg) {
    return chrome.runtime.sendMessage(msg);
  }
}
