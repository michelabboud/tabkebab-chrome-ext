// tab-list.js — Renders tabs grouped by domain with collapsible headers + pipeline progress

import { showToast } from './toast.js';
import { showConfirm } from './confirm-dialog.js';

const PHASE_LABELS = {
  snapshot: 'Reading',
  solver:   'Computing',
  planner:  'Planning',
  executor: 'Executing',
};

const PHASE_INDEX = { snapshot: 1, solver: 2, planner: 3, executor: 4 };

export class TabList {
  constructor(rootEl) {
    this.root = rootEl;
    this.listEl = rootEl.querySelector('#tab-list');
    this.collapsed = new Set();
    this.initialized = false;
    this.lastGroups = [];
    this.allKeys = [];
    this.groupBtn = rootEl.querySelector('#btn-group-by-domain');
    this.ungroupBtn = rootEl.querySelector('#btn-ungroup-all');
    this.collapseBtn = rootEl.querySelector('#btn-collapse-all-tabs');
    this.expandBtn = rootEl.querySelector('#btn-expand-all-tabs');

    // Pipeline progress elements
    this.progressEl = rootEl.querySelector('#pipeline-progress');
    this.progressPhase = rootEl.querySelector('#progress-phase');
    this.progressTitle = rootEl.querySelector('#progress-title');
    this.progressDetail = rootEl.querySelector('#progress-detail');
    this.progressFill = rootEl.querySelector('#progress-fill');

    // Smart Group (AI) button
    this.smartGroupBtn = rootEl.querySelector('#btn-smart-group');

    this.groupBtn.addEventListener('click', () => this.groupByDomain());
    if (this.smartGroupBtn) {
      this.smartGroupBtn.addEventListener('click', () => this.smartGroup());
    }
    this.ungroupBtn.addEventListener('click', () => this.ungroupAll());
    this.collapseBtn.addEventListener('click', () => this.collapseAll());
    this.expandBtn.addEventListener('click', () => this.expandAll());

    // Tab summaries cache (tabId → summary string)
    this.summaries = new Map();

    // Keep awake domains
    this.keepAwakeDomains = new Set();

    // Kebab All button
    this.kebabAllBtn = rootEl.querySelector('#btn-kebab-all');
    if (this.kebabAllBtn) {
      this.kebabAllBtn.addEventListener('click', () => this.kebabAll());
    }

    // Listen for progress updates from the service worker (throttled to rAF)
    this._progressPending = null;
    this._progressRafId = null;
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'groupingProgress') {
        this._progressPending = msg;
        if (!this._progressRafId) {
          this._progressRafId = requestAnimationFrame(() => {
            this._progressRafId = null;
            const m = this._progressPending;
            if (m) this.updateProgress(m.phase, m.detail);
          });
        }
      }
    });
  }

  // ── Progress UI ──

  showProgress() {
    this.progressEl.classList.add('active');
    this.progressEl.classList.remove('done');
    this.progressFill.classList.add('indeterminate');
    this.progressFill.style.width = '';
  }

  updateProgress(phase, detail) {
    const phaseNum = PHASE_INDEX[phase] || 1;
    this.progressPhase.textContent = `Phase ${phaseNum}/4`;
    this.progressTitle.textContent = PHASE_LABELS[phase] || phase;
    this.progressDetail.textContent = detail || '';

    // For executor phase, switch from indeterminate to determinate if possible
    if (phase === 'executor') {
      this.progressFill.classList.remove('indeterminate');
      // Progress is approximate: phases 1-3 are fast, executor is the real work
      this.progressFill.style.width = '75%';
    } else {
      const pct = (phaseNum / 4) * 50; // Phases 1-3 fill up to 50%
      this.progressFill.classList.add('indeterminate');
      this.progressFill.style.width = '';
    }
  }

  showDone(message) {
    this.progressEl.classList.add('done');
    this.progressFill.classList.remove('indeterminate');
    this.progressFill.style.width = '100%';
    this.progressPhase.textContent = 'DONE';
    this.progressTitle.textContent = message;
    this.progressDetail.textContent = '';

    // Auto-hide after 4 seconds
    setTimeout(() => {
      this.progressEl.classList.remove('active', 'done');
    }, 4000);
  }

  hideProgress() {
    this.progressEl.classList.remove('active', 'done');
  }

  // ── Collapse / Expand ──

  collapseAll() {
    for (const key of this.allKeys) {
      this.collapsed.add(key);
    }
    this.render(this.lastGroups);
  }

  expandAll() {
    this.collapsed.clear();
    this.render(this.lastGroups);
  }

  // ── Tab list rendering ──

  async refresh() {
    try {
      const [groups, keepAwakeList] = await Promise.all([
        this.send({ action: 'getGroupedTabs' }),
        this.send({ action: 'getKeepAwakeList' }),
      ]);
      this.keepAwakeDomains = new Set(keepAwakeList || []);
      this.render(groups);
    } catch (err) {
      showToast('Failed to load tabs', 'error');
    }
  }

  async render(groups) {
    this.lastGroups = groups;
    this.listEl.innerHTML = '';

    if (!groups || groups.length === 0) {
      this.listEl.innerHTML = '<p class="empty-state">No tabs open.</p>';
      return;
    }

    // Build a window index so we can label tabs from other windows
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const windowIndex = {};
    windows.forEach((w, i) => { windowIndex[w.id] = i + 1; });
    const multipleWindows = windows.length > 1;

    // Collect all collapsible keys for collapse/expand all
    const keys = [];
    for (const g of groups) {
      keys.push(g.domain);
      const byWin = {};
      for (const tab of g.tabs) {
        const wid = tab.windowId;
        if (!byWin[wid]) byWin[wid] = true;
      }
      if (multipleWindows && Object.keys(byWin).length > 1) {
        for (const wid of Object.keys(byWin)) {
          const wNum = windowIndex[wid] || '?';
          keys.push(`${g.domain}::W${wNum}`);
        }
      }
    }
    this.allKeys = keys;

    // Default: all domain groups collapsed on first load
    if (!this.initialized) {
      for (const g of groups) {
        this.collapsed.add(g.domain);
      }
      this.initialized = true;
    }

    for (const group of groups) {
      const domainEl = document.createElement('div');
      domainEl.className = 'domain-group';

      const isCollapsed = this.collapsed.has(group.domain);

      // Split tabs by window
      const byWindow = {};
      for (const tab of group.tabs) {
        const wid = tab.windowId;
        if (!byWindow[wid]) byWindow[wid] = [];
        byWindow[wid].push(tab);
      }
      const windowEntries = Object.entries(byWindow);
      const spansMultipleWindows = multipleWindows && windowEntries.length > 1;

      // Header
      const header = document.createElement('div');
      header.className = `domain-group-header${isCollapsed ? ' collapsed' : ''}`;

      const windowNumbers = windowEntries.map(([wid]) => windowIndex[wid] || '?');
      const windowInfo = multipleWindows
        ? ` <span class="window-label">${windowNumbers.map(n => `W${n}`).join(', ')}</span>`
        : '';

      // Use the first tab's favicon as the domain icon
      const domainFavicon = group.tabs[0]?.favIconUrl || '';
      const fallbackSvg = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ccc"/></svg>';

      const chevronEl = document.createElement('span');
      chevronEl.className = 'chevron';
      chevronEl.textContent = '\u25BC';

      const faviconEl = document.createElement('img');
      faviconEl.className = 'domain-favicon';
      faviconEl.src = domainFavicon || fallbackSvg;
      faviconEl.alt = '';
      faviconEl.addEventListener('error', () => { faviconEl.src = fallbackSvg; }, { once: true });

      const domainNameEl = document.createElement('span');
      domainNameEl.className = 'domain-name';
      domainNameEl.textContent = group.domain;

      const countEl = document.createElement('span');
      countEl.className = 'count';
      countEl.textContent = group.tabs.length;

      header.appendChild(chevronEl);
      header.appendChild(faviconEl);
      header.appendChild(domainNameEl);
      header.appendChild(countEl);

      if (multipleWindows) {
        const winLabel = document.createElement('span');
        winLabel.className = 'window-label';
        winLabel.textContent = windowNumbers.map(n => `W${n}`).join(', ');
        header.appendChild(winLabel);
      }

      // Summarize button (only if AI is available — checked async)
      const summarizeBtn = document.createElement('button');
      summarizeBtn.className = 'summarize-btn ai-feature';
      summarizeBtn.textContent = '\u2139'; // ℹ info icon
      summarizeBtn.title = 'Summarize tabs (AI)';
      summarizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tabIds = group.tabs.map(t => t.id);
        this.summarizeGroup(tabIds, domainEl);
      });
      header.appendChild(summarizeBtn);

      // Keep Awake toggle
      const isKeepAwake = this.keepAwakeDomains.has(group.domain);
      const keepAwakeBtn = document.createElement('button');
      keepAwakeBtn.className = `keep-awake-btn${isKeepAwake ? ' keep-awake-active' : ''}`;
      keepAwakeBtn.textContent = isKeepAwake ? '\u2600' : '\u263E'; // ☀ or ☾
      keepAwakeBtn.title = isKeepAwake ? 'Keep Awake (click to allow sleep)' : 'Allow sleep (click to keep awake)';
      keepAwakeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleKeepAwake(group.domain, !isKeepAwake);
      });
      header.appendChild(keepAwakeBtn);

      // Stash (save + close) button
      const stashBtn = document.createElement('button');
      stashBtn.className = 'stash-btn';
      stashBtn.textContent = 'Stash';
      stashBtn.title = 'Stash this domain (save and close tabs)';
      stashBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        stashBtn.disabled = true;
        stashBtn.textContent = 'Stashing...';
        try {
          const result = await this.send({ action: 'stashDomain', domain: group.domain });
          showToast(`Stashed ${result.stash.tabCount} tabs from ${group.domain}`, 'success');
          this.refresh();
        } catch {
          showToast('Stash failed', 'error');
        } finally {
          stashBtn.disabled = false;
          stashBtn.textContent = 'Stash';
        }
      });
      header.appendChild(stashBtn);

      // Kebab (discard) button
      const kebabBtn = document.createElement('button');
      kebabBtn.className = 'kebab-btn';
      kebabBtn.textContent = 'Kebab';
      kebabBtn.title = 'Kebab this domain (discard tabs)';
      kebabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.kebabDomain(group.domain);
      });
      header.appendChild(kebabBtn);

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'close-btn';
      closeBtn.textContent = 'Close';
      closeBtn.title = 'Close all tabs from this domain';
      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tabIds = group.tabs.map(t => t.id);
        const ok = await showConfirm({
          title: 'Close domain?',
          message: `Close ${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''} from ${group.domain}? This cannot be undone.`,
          confirmLabel: 'Close',
          danger: true,
        });
        if (!ok) return;
        closeBtn.disabled = true;
        try {
          await this.send({ action: 'closeTabs', tabIds });
          showToast(`Closed ${tabIds.length} tabs from ${group.domain}`, 'success');
          this.refresh();
        } catch {
          showToast('Close failed', 'error');
          closeBtn.disabled = false;
        }
      });
      header.appendChild(closeBtn);

      // Apply keep-awake class to header
      if (isKeepAwake) {
        header.classList.add('keep-awake');
      }

      header.addEventListener('click', () => {
        const body = domainEl.querySelector('.domain-group-body');
        if (this.collapsed.has(group.domain)) {
          this.collapsed.delete(group.domain);
          header.classList.remove('collapsed');
          body.classList.remove('collapsed');
        } else {
          this.collapsed.add(group.domain);
          header.classList.add('collapsed');
          body.classList.add('collapsed');
        }
      });

      // Body
      const body = document.createElement('div');
      body.className = `domain-group-body${isCollapsed ? ' collapsed' : ''}`;

      if (spansMultipleWindows) {
        // Render sub-groups per window
        for (const [wid, windowTabs] of windowEntries) {
          const wNum = windowIndex[wid] || '?';
          const subKey = `${group.domain}::W${wNum}`;
          const subCollapsed = this.collapsed.has(subKey);

          const subgroup = document.createElement('div');
          subgroup.className = 'window-subgroup';

          const subHeader = document.createElement('div');
          subHeader.className = `window-subgroup-header${subCollapsed ? ' collapsed' : ''}`;
          subHeader.innerHTML = `
            <span class="chevron">\u25BC</span>
            <span class="window-label">Window ${wNum}</span>
            <span class="count">${windowTabs.length}</span>
          `;
          subHeader.addEventListener('click', (e) => {
            e.stopPropagation();
            const subBody = subgroup.querySelector('.window-subgroup-body');
            if (this.collapsed.has(subKey)) {
              this.collapsed.delete(subKey);
              subHeader.classList.remove('collapsed');
              subBody.classList.remove('collapsed');
            } else {
              this.collapsed.add(subKey);
              subHeader.classList.add('collapsed');
              subBody.classList.add('collapsed');
            }
          });

          const subBody = document.createElement('div');
          subBody.className = `window-subgroup-body${subCollapsed ? ' collapsed' : ''}`;

          for (const tab of windowTabs) {
            subBody.appendChild(this.createTabItem(tab));
          }

          subgroup.appendChild(subHeader);
          subgroup.appendChild(subBody);
          body.appendChild(subgroup);
        }
      } else {
        // Single window — flat list, no sub-groups needed
        for (const tab of group.tabs) {
          body.appendChild(this.createTabItem(tab));
        }
      }

      domainEl.appendChild(header);
      domainEl.appendChild(body);
      this.listEl.appendChild(domainEl);
    }
  }

  createTabItem(tab) {
    const item = document.createElement('div');
    item.className = `tab-item${tab.discarded ? ' tab-discarded' : ''}`;
    item.dataset.tabId = tab.id;

    const favicon = document.createElement('img');
    favicon.className = 'favicon';
    favicon.src = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ccc"/></svg>';
    favicon.alt = '';
    favicon.addEventListener('error', () => {
      favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ccc"/></svg>';
    }, { once: true });

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title || tab.url || 'New Tab';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = '\u00D7';
    closeBtn.title = 'Close tab';
    closeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.send({ action: 'closeTabs', tabIds: [tab.id] });
      this.refresh();
    });

    item.appendChild(favicon);
    item.appendChild(title);

    // Show cached summary if available
    if (this.summaries.has(tab.id)) {
      const summaryEl = document.createElement('span');
      summaryEl.className = 'tab-summary';
      summaryEl.textContent = this.summaries.get(tab.id);
      item.appendChild(summaryEl);
    }

    item.appendChild(closeBtn);

    item.addEventListener('click', () => {
      this.send({ action: 'focusTab', tabId: tab.id });
    });

    return item;
  }

  async groupByDomain() {
    this.groupBtn.disabled = true;
    this.ungroupBtn.disabled = true;
    this.showProgress();

    try {
      const result = await this.send({ action: 'applyDomainGroups' });

      if (result && result.alreadyOrganized) {
        this.showDone('Already organized — no moves needed');
      } else if (result) {
        const parts = [];
        if (result.tabsMoved > 0) parts.push(`${result.tabsMoved} tabs moved`);
        if (result.windowsCreated > 0) parts.push(`${result.windowsCreated} windows created`);
        if (result.groupsCreated > 0) parts.push(`${result.groupsCreated} groups created`);
        const summary = parts.length > 0 ? parts.join(', ') : 'Done';
        this.showDone(summary);
        showToast('Tabs grouped by domain', 'success');
      } else {
        this.hideProgress();
        showToast('Tabs grouped by domain', 'success');
      }

      this.refresh();
    } catch {
      this.hideProgress();
      showToast('Failed to group tabs', 'error');
    } finally {
      this.groupBtn.disabled = false;
      this.ungroupBtn.disabled = false;
    }
  }

  async smartGroup() {
    if (this.smartGroupBtn) this.smartGroupBtn.disabled = true;
    this.groupBtn.disabled = true;
    this.ungroupBtn.disabled = true;
    this.showProgress();

    try {
      const result = await this.send({ action: 'applySmartGroups' });

      if (result && result.alreadyOrganized) {
        this.showDone('Already organized — no moves needed');
      } else if (result) {
        const parts = [];
        if (result.tabsMoved > 0) parts.push(`${result.tabsMoved} tabs moved`);
        if (result.windowsCreated > 0) parts.push(`${result.windowsCreated} windows created`);
        if (result.groupsCreated > 0) parts.push(`${result.groupsCreated} groups created`);
        const summary = parts.length > 0 ? parts.join(', ') : 'Done';
        this.showDone(summary);
        showToast('Tabs smart-grouped by AI', 'success');
      } else {
        this.hideProgress();
        showToast('Tabs smart-grouped by AI', 'success');
      }

      this.refresh();
    } catch {
      this.hideProgress();
      showToast('Smart grouping failed', 'error');
    } finally {
      if (this.smartGroupBtn) this.smartGroupBtn.disabled = false;
      this.groupBtn.disabled = false;
      this.ungroupBtn.disabled = false;
    }
  }

  async summarizeGroup(tabIds, headerEl) {
    // Show loading state on the summarize button
    const btn = headerEl.querySelector('.summarize-btn');
    if (btn) {
      btn.textContent = '\u22EF'; // ellipsis
      btn.disabled = true;
    }

    try {
      const result = await this.send({ action: 'summarizeTabs', tabIds });

      if (result.summaries) {
        for (const s of result.summaries) {
          this.summaries.set(s.tabId, s.summary);

          // Find the tab item and add/update the summary element
          const tabEl = this.listEl.querySelector(`.tab-item[data-tab-id="${s.tabId}"]`);
          if (tabEl) {
            let summaryEl = tabEl.querySelector('.tab-summary');
            if (!summaryEl) {
              summaryEl = document.createElement('span');
              summaryEl.className = 'tab-summary';
              tabEl.querySelector('.title').after(summaryEl);
            }
            summaryEl.textContent = s.summary;
          }
        }
      }
    } catch {
      showToast('Failed to summarize tabs', 'error');
    } finally {
      if (btn) {
        btn.textContent = '\u2139'; // info icon
        btn.disabled = false;
      }
    }
  }

  async kebabAll() {
    if (this.kebabAllBtn) this.kebabAllBtn.disabled = true;
    try {
      const result = await this.send({ action: 'discardTabs', scope: 'all' });
      const msg = `Kebab'd ${result.discarded} tab${result.discarded !== 1 ? 's' : ''}`;
      const extra = result.skipped > 0 ? ` (${result.skipped} skipped)` : '';
      showToast(msg + extra, 'success');
      this.refresh();
    } catch {
      showToast('Kebab failed', 'error');
    } finally {
      if (this.kebabAllBtn) this.kebabAllBtn.disabled = false;
    }
  }

  async kebabDomain(domain) {
    try {
      const result = await this.send({ action: 'discardTabs', scope: 'domain', domain });
      const msg = `Kebab'd ${result.discarded} tab${result.discarded !== 1 ? 's' : ''} from ${domain}`;
      const extra = result.skipped > 0 ? ` (${result.skipped} skipped)` : '';
      showToast(msg + extra, 'success');
      this.refresh();
    } catch {
      showToast('Kebab failed', 'error');
    }
  }

  async toggleKeepAwake(domain, keepAwake) {
    try {
      await this.send({ action: 'setKeepAwake', scope: 'domain', domain, keepAwake });
      if (keepAwake) {
        this.keepAwakeDomains.add(domain);
        showToast(`${domain} will stay awake`, 'success');
      } else {
        this.keepAwakeDomains.delete(domain);
        showToast(`${domain} can now sleep`, 'success');
      }
      this.render(this.lastGroups);
    } catch {
      showToast('Failed to update keep-awake', 'error');
    }
  }

  async ungroupAll() {
    try {
      const tabs = await this.send({ action: 'getTabs', allWindows: true });
      const grouped = tabs.filter(t => t.groupId && t.groupId !== -1);
      if (grouped.length > 0) {
        await this.send({ action: 'ungroupTabs', tabIds: grouped.map(t => t.id) });
      }
      showToast('All tabs ungrouped', 'success');
      this.refresh();
    } catch {
      showToast('Failed to ungroup tabs', 'error');
    }
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
