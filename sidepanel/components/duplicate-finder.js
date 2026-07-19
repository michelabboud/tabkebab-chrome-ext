// duplicate-finder.js — Scan and close duplicate tabs + empty pages

import { showToast } from './toast.js';
import { collectUndoUrls } from '../../core/duplicates.js';
import { sendOrThrow } from '../message-client.js';

export class DuplicateFinder {
  constructor(rootEl) {
    this.root = rootEl;
    this.listEl = rootEl.querySelector('#duplicate-list');
    this.closeAllBtn = rootEl.querySelector('#btn-close-all-dupes');
    this.emptyPagesRow = rootEl.querySelector('#empty-pages-row');
    this.emptyPagesCount = rootEl.querySelector('#empty-pages-count');
    this.duplicates = [];
    this.emptyPages = [];

    rootEl.querySelector('#btn-scan-dupes').addEventListener('click', () => {
      void this.scan().catch((err) => showToast('Failed to scan for duplicates: ' + err.message, 'error'));
    });
    this.closeAllBtn.addEventListener('click', () => this.closeAllDuplicates());
    rootEl.querySelector('#btn-close-empty')?.addEventListener('click', () => this.closeEmptyPages());
  }

  async refresh() {
    await this.scan();
  }

  async scan() {
    // Scan for duplicates and empty pages in parallel, then commit both caches.
    const [duplicates, emptyPages] = await Promise.all([
      this.send({ action: 'findDuplicates' }),
      this.send({ action: 'findEmptyPages' }),
    ]);
    this.duplicates = duplicates;
    this.emptyPages = emptyPages || [];
    this.render();
    this.renderEmptyPages();

    // Dispatch badge update event (include empty pages in count)
    const dupeCount = this.duplicates
      ? this.duplicates.reduce((sum, g) => sum + g.tabs.length - 1, 0)
      : 0;
    const totalCount = dupeCount + this.emptyPages.length;
    document.dispatchEvent(new CustomEvent('dupesUpdated', { detail: { count: totalCount } }));
  }

  renderEmptyPages() {
    if (!this.emptyPagesRow) return;

    if (this.emptyPages.length === 0) {
      this.emptyPagesRow.hidden = true;
      if (this.emptyPagesCount) this.emptyPagesCount.textContent = '0';
      return;
    }

    this.emptyPagesRow.hidden = false;
    if (this.emptyPagesCount) {
      this.emptyPagesCount.textContent = this.emptyPages.length;
    }
  }

  async closeEmptyPages() {
    if (this.emptyPages.length === 0) {
      showToast('No empty pages found', 'error');
      return;
    }

    const tabIds = this.emptyPages.map(t => t.id);
    const count = tabIds.length;
    try {
      await this.send({ action: 'closeTabs', tabIds });
    } catch (err) {
      showToast('Failed to close empty pages: ' + err.message, 'error');
      return;
    }

    // Clear local state only after the checked close succeeds.
    this.emptyPages = [];
    this.renderEmptyPages();
    const dupeCount = this.duplicates
      ? this.duplicates.reduce((sum, g) => sum + g.tabs.length - 1, 0)
      : 0;
    document.dispatchEvent(new CustomEvent('dupesUpdated', { detail: { count: dupeCount } }));

    await new Promise(r => setTimeout(r, 200));
    try {
      await this.scan();
    } catch (err) {
      showToast('Empty pages were closed, but the view could not refresh: ' + err.message, 'error');
      return;
    }
    showToast(`Closed ${count} empty page(s)`, 'success');
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
          try {
            await this.send({ action: 'closeTabs', tabIds: [tab.id] });
          } catch (err) {
            showToast('Failed to close tab: ' + err.message, 'error');
            return;
          }
          try {
            await this.scan();
          } catch (err) {
            showToast('Tab was closed, but the view could not refresh: ' + err.message, 'error');
            return;
          }
          showToast('Tab closed', 'success');
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

    // Capture URLs before closing so undo can reopen them
    const closedUrls = Object.freeze(collectUndoUrls(this.duplicates, tabIds));
    const undoAction = {
      label: 'Undo',
      callback: async () => {
        try {
          const result = await this.send({ action: 'reopenTabs', urls: closedUrls });
          showToast(`Reopened ${result.created} tab(s)`, 'success');
        } catch (err) {
          showToast('Undo failed: ' + err.message, 'error');
        }
      },
    };

    try {
      await this.send({ action: 'closeTabs', tabIds });
    } catch (err) {
      showToast('Failed to close duplicates: ' + err.message, 'error');
      return;
    }
    try {
      await this.scan();
    } catch (err) {
      showToast(
        'Duplicates were closed, but the view could not refresh: ' + err.message,
        'error',
        8000,
        undoAction,
      );
      return;
    }
    try {
      showToast(`Closed ${tabIds.length} duplicate tab(s)`, 'success', 8000, undoAction);
    } catch (err) {
      showToast('Failed to show duplicate close result: ' + err.message, 'error');
    }
  }

  send(msg) {
    return sendOrThrow(msg);
  }
}
