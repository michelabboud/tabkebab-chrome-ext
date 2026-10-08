// duplicate-finder.js — Scan and close duplicate tabs + empty pages

import { showToast } from './toast.js';
import { normalizeUrl } from '../../core/duplicates.js';
import { sendOrThrow } from '../message-client.js';

// Must stay in sync with findEmptyPages() in core/duplicates.js.
const EMPTY_PAGE_URLS = new Set(['', 'about:blank', 'edge://newtab/']);

function isStillEmptyPage(tab) {
  if (!tab || tab.active) return false;
  if (!EMPTY_PAGE_URLS.has(tab.url || '')) return false;
  // A blank tab that has started navigating is about to have content.
  if (tab.pendingUrl && !EMPTY_PAGE_URLS.has(tab.pendingUrl)) return false;
  return true;
}

/**
 * Re-validate the empty pages captured at scan time against live tabs.
 * Returns the ids that still exist and are still blank, inactive pages.
 */
export function selectLiveEmptyPageIds(scannedEmptyPages, liveTabs) {
  const liveById = new Map((liveTabs || []).map((tab) => [tab.id, tab]));
  const ids = [];
  for (const page of scannedEmptyPages || []) {
    if (isStillEmptyPage(liveById.get(page?.id))) ids.push(page.id);
  }
  return ids;
}

/**
 * Re-validate selected duplicate closes against live tabs.
 *
 * A selected tab is closed only if it still exists and its URL still
 * normalizes to the duplicate group's URL. Each group keeps at least one
 * live copy open, so if the kept tab was closed or navigated away the last
 * remaining copy is never closed.
 *
 * @returns {{ tabIds: number[], urls: string[] }} ids to close + live URLs for undo
 */
export function selectLiveDuplicateCloses(duplicateGroups, selectedIds, liveTabs) {
  const selected = new Set(selectedIds || []);
  const liveTabsList = liveTabs || [];
  const liveById = new Map(liveTabsList.map((tab) => [tab.id, tab]));
  const tabIds = [];
  const urls = [];

  for (const group of duplicateGroups || []) {
    if (!Array.isArray(group?.tabs)) continue;
    const key = group.url;
    const candidates = [];
    for (const tab of group.tabs) {
      if (!selected.has(tab?.id)) continue;
      const live = liveById.get(tab.id);
      if (live && normalizeUrl(live.url || '') === key) candidates.push(live);
    }
    if (candidates.length === 0) continue;

    const candidateIds = new Set(candidates.map((tab) => tab.id));
    const survivors = liveTabsList.filter(
      (tab) => !candidateIds.has(tab.id) && normalizeUrl(tab.url || '') === key,
    );
    // Never close every remaining copy of a page.
    if (survivors.length === 0) candidates.shift();

    for (const tab of candidates) {
      tabIds.push(tab.id);
      urls.push(tab.url);
    }
  }
  return { tabIds, urls };
}

/** Prefer the background's real closed count when it reports one. */
function closedCount(result, fallback) {
  for (const key of ['closed', 'closedCount']) {
    if (Number.isFinite(result?.[key])) return result[key];
  }
  return fallback;
}

async function queryLiveTabs() {
  const tabs = await chrome.tabs.query({});
  return Array.isArray(tabs) ? tabs : [];
}

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

    // The scan may be stale: a "blank" tab may have loaded content since.
    let tabIds;
    try {
      tabIds = selectLiveEmptyPageIds(this.emptyPages, await queryLiveTabs());
    } catch (err) {
      showToast('Failed to check empty pages: ' + err.message, 'error');
      return;
    }
    if (tabIds.length === 0) {
      showToast('Those pages are no longer empty — nothing closed', 'info');
      await this.scan().catch(() => {});
      return;
    }
    let count;
    try {
      const result = await this.send({ action: 'closeTabs', tabIds });
      count = closedCount(result, tabIds.length);
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
    // Preserve the user's checkbox choices across re-renders (tabsChanged
    // refreshes re-scan while the user may be adjusting the selection).
    const previousChecks = new Map();
    for (const cb of this.listEl.querySelectorAll?.('input[type="checkbox"]') || []) {
      previousChecks.set(String(cb.dataset.tabId), cb.checked);
    }
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
        checkbox.checked = previousChecks.has(String(tab.id))
          ? previousChecks.get(String(tab.id))
          : index > 0;

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
            const live = selectLiveDuplicateCloses([group], [tab.id], await queryLiveTabs());
            if (live.tabIds.length === 0) {
              showToast('Tab is no longer a duplicate — nothing closed', 'info');
              await this.scan().catch(() => {});
              return;
            }
            await this.send({ action: 'closeTabs', tabIds: live.tabIds });
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
    const selectedIds = Array.from(checkboxes).map(cb => parseInt(cb.dataset.tabId, 10));

    if (selectedIds.length === 0) {
      showToast('No duplicates selected', 'error');
      return;
    }

    // Re-validate against live tabs: ids captured at render time may now be
    // closed, navigated elsewhere, or the last remaining copy of the page.
    let live;
    try {
      live = selectLiveDuplicateCloses(this.duplicates, selectedIds, await queryLiveTabs());
    } catch (err) {
      showToast('Failed to check duplicates: ' + err.message, 'error');
      return;
    }
    const tabIds = live.tabIds;
    if (tabIds.length === 0) {
      showToast('Selected tabs are no longer duplicates — nothing closed', 'info');
      await this.scan().catch(() => {});
      return;
    }

    // Capture URLs before closing so undo can reopen them
    const closedUrls = Object.freeze([...live.urls]);
    const undoAction = {
      label: 'Undo',
      callback: async () => {
        try {
          const result = await this.send({ action: 'reopenTabs', urls: closedUrls });
          showToast(`Reopened ${result?.created ?? 0} tab(s)`, 'success');
        } catch (err) {
          showToast('Undo failed: ' + err.message, 'error');
        }
      },
    };

    let count;
    try {
      const result = await this.send({ action: 'closeTabs', tabIds });
      count = closedCount(result, tabIds.length);
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
      showToast(`Closed ${count} duplicate tab(s)`, 'success', 8000, undoAction);
    } catch (err) {
      showToast('Failed to show duplicate close result: ' + err.message, 'error');
    }
  }

  send(msg) {
    return sendOrThrow(msg);
  }
}
