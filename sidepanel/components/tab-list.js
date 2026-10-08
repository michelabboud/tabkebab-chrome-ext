// tab-list.js — Renders tabs grouped by domain with collapsible headers + pipeline progress

import { showToast } from './toast.js';
import { showConfirm } from './confirm-dialog.js';
import { showStashedToast } from './stash-list.js';
import { sendOrThrow } from '../message-client.js';
import { SmartGroupFallback } from './smart-group-fallback.js';
import {
  createOverflowMenu,
  makeKeyboardActivatable,
  setExpanded,
  wireCollapseToggle,
  wireMenuButton,
} from './keyboard-activate.js';

const PHASE_LABELS = {
  snapshot: 'Reading',
  solver:   'Computing',
  planner:  'Planning',
  executor: 'Executing',
};

const PHASE_INDEX = { snapshot: 1, solver: 2, planner: 3, executor: 4 };

/**
 * Human label for a domain group key. Non-http pages (about:blank, chrome://,
 * file:) have an empty hostname; unparsable URLs are bucketed as 'other'.
 */
export function domainLabel(domain) {
  if (!domain) return 'Blank & browser pages';
  if (domain === 'other') return 'Other pages';
  return domain;
}

/** Full-title + URL tooltip for a tab row. */
export function tabTooltip(tab) {
  const title = tab?.title || '';
  const url = tab?.url || tab?.pendingUrl || '';
  if (title && url && title !== url) return `${title}\n${url}`;
  return title || url || 'New Tab';
}

export class TabList {
  constructor(rootEl, { navigate = () => {} } = {}) {
    this.root = rootEl;
    this.listEl = rootEl.querySelector('#tab-list');
    this.collapsed = new Set();
    this.initialized = false;
    this.lastGroups = [];
    this.allKeys = [];
    // Render/refresh generations: only the newest call may touch the DOM, so
    // overlapping refreshes (bursts of tabsChanged) can't append duplicates.
    this._renderGeneration = 0;
    this._refreshGeneration = 0;
    this.groupBtn = rootEl.querySelector('#btn-group-by-domain');
    this.ungroupBtn = rootEl.querySelector('#btn-ungroup-all');
    this.groupMenuBtn = rootEl.querySelector('#btn-group-menu');
    this.groupMenu = rootEl.querySelector('#group-menu');
    this.collapseToggleBtn = rootEl.querySelector('#btn-toggle-collapse-tabs');

    // Pipeline progress elements
    this.progressEl = rootEl.querySelector('#pipeline-progress');
    this.progressPhase = rootEl.querySelector('#progress-phase');
    this.progressTitle = rootEl.querySelector('#progress-title');
    this.progressDetail = rootEl.querySelector('#progress-detail');
    this.progressFill = rootEl.querySelector('#progress-fill');

    // Smart Group (AI) button
    this.smartGroupBtn = rootEl.querySelector('#btn-smart-group');
    this.smartGroupFallback = new SmartGroupFallback(
      rootEl.querySelector('#smart-group-fallback'),
      {
        onDomainFallback: () => this.groupByDomain(),
        navigate,
      },
    );

    this.groupBtn.addEventListener('click', () => this.groupByDomain());
    if (this.smartGroupBtn) {
      this.smartGroupBtn.addEventListener('click', () => this.smartGroup());
    }
    this.ungroupBtn.addEventListener('click', () => this.ungroupAll());
    // [Group ▾] split button: primary = by domain, menu = Smart / Ungroup all.
    if (this.groupMenuBtn && this.groupMenu) {
      wireMenuButton(this.groupMenuBtn, this.groupMenu, {
        wrapper: this.groupMenuBtn.parentNode,
      });
    }
    this.collapseToggle = wireCollapseToggle(this.collapseToggleBtn, {
      isAllCollapsed: () => this.isAllCollapsed(),
      onToggle: (collapse) => (collapse ? this.collapseAll() : this.expandAll()),
    });

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

  /** True when every domain row (and window sub-group) is collapsed. */
  isAllCollapsed() {
    if (!this.initialized) return true; // first render starts collapsed
    const keys = this.allKeys || [];
    return keys.length > 0 && keys.every((key) => this.collapsed.has(key));
  }

  syncCollapseToggle() {
    this.collapseToggle?.sync();
  }

  async collapseAll() {
    for (const key of this.allKeys) {
      this.collapsed.add(key);
    }
    try {
      await this.render(this.lastGroups);
    } catch (err) {
      showToast('Failed to collapse tab groups: ' + err.message, 'error');
    }
  }

  async expandAll() {
    this.collapsed.clear();
    try {
      await this.render(this.lastGroups);
    } catch (err) {
      showToast('Failed to expand tab groups: ' + err.message, 'error');
    }
  }

  // ── Tab list rendering ──

  async refresh() {
    const generation = ++this._refreshGeneration;
    const [groups, keepAwakeList] = await Promise.all([
      this.send({ action: 'getGroupedTabs' }),
      this.send({ action: 'getKeepAwakeList' }),
    ]);
    // A newer refresh started while this one was in flight; its data wins.
    if (generation !== this._refreshGeneration) return;
    this.keepAwakeDomains = new Set(keepAwakeList || []);
    await this.render(groups);
  }

  async render(groups) {
    const generation = ++this._renderGeneration;

    if (!groups || groups.length === 0) {
      this.lastGroups = groups;
      this.listEl.innerHTML = '<p class="empty-state">No tabs open.</p>';
      this.syncCollapseToggle();
      return;
    }

    // Build a window index so we can label tabs from other windows
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    // Superseded by a newer render while awaiting: discard this one.
    if (generation !== this._renderGeneration) return;
    this.lastGroups = groups;
    const fragment = document.createDocumentFragment();
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

      // Header: two zones — the name truncates, the actions stay right-aligned.
      const header = document.createElement('div');
      header.className = `domain-group-header${isCollapsed ? ' collapsed' : ''}`;
      const label = domainLabel(group.domain);
      const tabCount = group.tabs.length;
      const tabsWord = `tab${tabCount !== 1 ? 's' : ''}`;

      const windowNumbers = windowEntries.map(([wid]) => windowIndex[wid] || '?');

      // Use the first tab's favicon as the domain icon
      const domainFavicon = group.tabs[0]?.favIconUrl || '';
      const fallbackSvg = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ccc"/></svg>';

      const chevronEl = document.createElement('span');
      chevronEl.className = 'chevron';
      chevronEl.textContent = '▼';
      chevronEl.setAttribute('aria-hidden', 'true');

      const faviconEl = document.createElement('img');
      faviconEl.className = 'domain-favicon';
      faviconEl.src = domainFavicon || fallbackSvg;
      faviconEl.alt = '';
      faviconEl.addEventListener('error', () => { faviconEl.src = fallbackSvg; }, { once: true });

      const domainNameEl = document.createElement('span');
      domainNameEl.className = `domain-name${group.domain ? '' : ' domain-name-generic'}`;
      domainNameEl.textContent = label;
      domainNameEl.title = label;

      const countEl = document.createElement('span');
      countEl.className = 'count';
      countEl.textContent = tabCount;
      countEl.title = `${tabCount} ${tabsWord}`;

      header.appendChild(chevronEl);
      header.appendChild(faviconEl);
      header.appendChild(domainNameEl);
      header.appendChild(countEl);

      // Window label only when the domain spans more than one window.
      if (spansMultipleWindows) {
        const winLabel = document.createElement('span');
        winLabel.className = 'window-label';
        winLabel.textContent = windowNumbers.map(n => `W${n}`).join(', ');
        winLabel.title = `Open in ${windowNumbers.map(n => `Window ${n}`).join(', ')}`;
        header.appendChild(winLabel);
      }

      const isKeepAwake = this.keepAwakeDomains.has(group.domain);

      const actions = document.createElement('div');
      actions.className = 'row-actions';

      // Stash (save + close) stays one click away: it is the core loop.
      const stashBtn = document.createElement('button');
      stashBtn.type = 'button';
      stashBtn.className = 'stash-btn';
      stashBtn.textContent = 'Stash';
      stashBtn.title = 'Stash this domain (save and close tabs)';
      stashBtn.setAttribute('aria-label', `Stash ${label} (${tabCount} ${tabsWord})`);
      stashBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        stashBtn.disabled = true;
        stashBtn.textContent = 'Stashing...';
        try {
          const result = await this.send({ action: 'stashDomain', domain: group.domain });
          if (!await this.refreshCommittedState('Tabs were stashed')) return;
          showStashedToast(result.stash, { from: label, onUndone: () => this.refresh() });
        } catch (err) {
          showToast('Stash failed: ' + err.message, 'error');
        } finally {
          stashBtn.disabled = false;
          stashBtn.textContent = 'Stash';
        }
      });
      actions.appendChild(stashBtn);

      // Everything else lives in the ⋯ menu; Close is separated at the end.
      const rowMenu = createOverflowMenu({
        label: `More actions for ${label}`,
        items: [
          {
            label: 'Sleep tabs (Kebab)',
            className: 'kebab-item',
            title: 'Discard these tabs to free memory',
            onSelect: () => this.kebabDomain(group.domain),
          },
          {
            label: 'Keep awake',
            className: 'keep-awake-item',
            checked: isKeepAwake,
            title: isKeepAwake ? 'Allow these tabs to sleep again' : 'Never auto-sleep these tabs',
            onSelect: () => this.toggleKeepAwake(group.domain, !isKeepAwake),
          },
          {
            label: 'Summarize tabs (AI)',
            className: 'summarize-item ai-feature',
            onSelect: () => this.summarizeGroup(group.tabs.map(t => t.id), domainEl),
          },
          {
            label: `Close ${tabCount} ${tabsWord}…`,
            danger: true,
            className: 'close-item',
            onSelect: () => this.closeDomain(group, label),
          },
        ],
      });
      actions.appendChild(rowMenu.wrapper);
      header.appendChild(actions);

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
          setExpanded(header, true);
        } else {
          this.collapsed.add(group.domain);
          header.classList.add('collapsed');
          body.classList.add('collapsed');
          setExpanded(header, false);
        }
        this.syncCollapseToggle();
      });
      makeKeyboardActivatable(header, {
        expanded: !isCollapsed,
        label: `${label}, ${tabCount} ${tabsWord}${isKeepAwake ? ', kept awake' : ''}`,
      });
      header.title = `${label} — ${tabCount} ${tabsWord}`;

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
            <span class="chevron" aria-hidden="true">\u25BC</span>
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
              setExpanded(subHeader, true);
            } else {
              this.collapsed.add(subKey);
              subHeader.classList.add('collapsed');
              subBody.classList.add('collapsed');
              setExpanded(subHeader, false);
            }
            this.syncCollapseToggle();
          });
          makeKeyboardActivatable(subHeader, {
            expanded: !subCollapsed,
            label: `Window ${wNum}, ${windowTabs.length} tab${windowTabs.length !== 1 ? 's' : ''}`,
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
      fragment.appendChild(domainEl);
    }

    // Swap in one step so the list is never observed half-built or doubled.
    this.listEl.replaceChildren(fragment);
    this.syncCollapseToggle();
  }

  async closeDomain(group, label = domainLabel(group.domain)) {
    const tabIds = group.tabs.map(t => t.id);
    const ok = await showConfirm({
      title: 'Close domain?',
      message: `Close ${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''} from ${label}? This cannot be undone.`,
      confirmLabel: 'Close',
      danger: true,
    });
    if (!ok) return false;
    try {
      await this.send({ action: 'closeTabs', tabIds });
    } catch (err) {
      showToast('Close failed: ' + err.message, 'error');
      return false;
    }
    if (!await this.refreshCommittedState('Domain tabs were closed')) return false;
    showToast(`Closed ${tabIds.length} tabs from ${label}`, 'success');
    return true;
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
    item.title = tabTooltip(tab);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'close-btn tab-close-btn';
    closeBtn.textContent = '\u00D7';
    closeBtn.title = 'Close tab';
    closeBtn.setAttribute('aria-label', `Close tab: ${title.textContent}`);
    closeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await this.send({ action: 'closeTabs', tabIds: [tab.id] });
        await this.refreshCommittedState('Tab was closed');
      } catch (err) {
        showToast('Failed to close tab: ' + err.message, 'error');
      }
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

    item.addEventListener('click', async () => {
      try {
        await this.send({ action: 'focusTab', tabId: tab.id });
      } catch (err) {
        showToast('Failed to focus tab: ' + err.message, 'error');
      }
    });
    makeKeyboardActivatable(item, { label: `Switch to ${title.textContent}` });

    return item;
  }

  async groupByDomain() {
    this.groupBtn.disabled = true;
    this.ungroupBtn.disabled = true;
    if (this.groupMenuBtn) this.groupMenuBtn.disabled = true;
    this.showProgress();

    try {
      const result = await this.send({ action: 'applyDomainGroups' });
      try {
        await this.refresh();
      } catch (err) {
        this.hideProgress();
        showToast('Tabs were grouped, but the view could not refresh: ' + err.message, 'error');
        return;
      }

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

    } catch (err) {
      this.hideProgress();
      showToast('Failed to group tabs: ' + err.message, 'error');
    } finally {
      this.groupBtn.disabled = false;
      this.ungroupBtn.disabled = false;
      if (this.groupMenuBtn) this.groupMenuBtn.disabled = false;
    }
  }

  async smartGroup() {
    if (this.smartGroupBtn) this.smartGroupBtn.disabled = true;
    this.groupBtn.disabled = true;
    this.ungroupBtn.disabled = true;
    if (this.groupMenuBtn) this.groupMenuBtn.disabled = true;
    this.smartGroupFallback?.hide();
    this.showProgress();

    try {
      const result = await this.send({ action: 'applySmartGroups' });
      if (
        result?.aiApplied === false &&
        result?.fallbackAction === 'domain'
      ) {
        this.hideProgress();
        this.smartGroupFallback?.show({
          reason: result.aiFailure,
          source: result.aiSource,
        });
        return;
      }

      try {
        await this.refresh();
      } catch (err) {
        this.hideProgress();
        showToast('Tabs were smart-grouped, but the view could not refresh: ' + err.message, 'error');
        return;
      }

      if (result && result.alreadyOrganized) {
        this.showDone('Already organized — no moves needed');
      } else if (result) {
        const parts = [];
        if (result.tabsMoved > 0) parts.push(`${result.tabsMoved} tabs moved`);
        if (result.windowsCreated > 0) parts.push(`${result.windowsCreated} windows created`);
        if (result.groupsCreated > 0) parts.push(`${result.groupsCreated} groups created`);
        const summary = parts.length > 0 ? parts.join(', ') : 'Done';
        this.showDone(summary);
        showToast(
          result.aiSource === 'zero-config'
            ? "Tabs smart-grouped privately with Chrome's built-in AI"
            : 'Tabs smart-grouped by AI',
          'success',
        );
      } else {
        this.hideProgress();
        showToast('Tabs smart-grouped by AI', 'success');
      }

    } catch (err) {
      this.hideProgress();
      this.smartGroupFallback?.show({
        reason: 'failed',
        source: 'configured',
      });
    } finally {
      if (this.smartGroupBtn) this.smartGroupBtn.disabled = false;
      this.groupBtn.disabled = false;
      this.ungroupBtn.disabled = false;
      if (this.groupMenuBtn) this.groupMenuBtn.disabled = false;
    }
  }

  async summarizeGroup(tabIds, headerEl) {
    // Show loading state on the summarize button
    const btn = headerEl.querySelector('.summarize-item');
    if (btn) {
      btn.textContent = 'Summarizing\u2026';
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
    } catch (err) {
      showToast('Failed to summarize tabs: ' + err.message, 'error');
    } finally {
      if (btn) {
        btn.textContent = 'Summarize tabs (AI)';
        btn.disabled = false;
      }
    }
  }

  async kebabAll() {
    if (this.kebabAllBtn) this.kebabAllBtn.disabled = true;
    try {
      const result = await this.send({ action: 'discardTabs', scope: 'all' });
      try {
        await this.refresh();
      } catch (err) {
        showToast('Tabs were kebabed, but the view could not refresh: ' + err.message, 'error');
        return;
      }
      const msg = `Kebab'd ${result.discarded} tab${result.discarded !== 1 ? 's' : ''}`;
      const extra = result.skipped > 0 ? ` (${result.skipped} skipped)` : '';
      showToast(msg + extra, 'success');
    } catch (err) {
      showToast('Kebab failed: ' + err.message, 'error');
    } finally {
      if (this.kebabAllBtn) this.kebabAllBtn.disabled = false;
    }
  }

  async kebabDomain(domain) {
    try {
      const result = await this.send({ action: 'discardTabs', scope: 'domain', domain });
      try {
        await this.refresh();
      } catch (err) {
        showToast('Domain tabs were kebabed, but the view could not refresh: ' + err.message, 'error');
        return;
      }
      const msg = `Kebab'd ${result.discarded} tab${result.discarded !== 1 ? 's' : ''} from ${domainLabel(domain)}`;
      const extra = result.skipped > 0 ? ` (${result.skipped} skipped)` : '';
      showToast(msg + extra, 'success');
    } catch (err) {
      showToast('Kebab failed: ' + err.message, 'error');
    }
  }

  async toggleKeepAwake(domain, keepAwake) {
    try {
      await this.send({ action: 'setKeepAwake', scope: 'domain', domain, keepAwake });
      if (keepAwake) {
        this.keepAwakeDomains.add(domain);
      } else {
        this.keepAwakeDomains.delete(domain);
      }
      try {
        await this.render(this.lastGroups);
      } catch (err) {
        showToast('Keep-awake changed, but the view could not refresh: ' + err.message, 'error');
        return;
      }
      showToast(keepAwake ? `${domainLabel(domain)} will stay awake` : `${domainLabel(domain)} can now sleep`, 'success');
    } catch (err) {
      showToast('Failed to update keep-awake: ' + err.message, 'error');
    }
  }

  async ungroupAll() {
    try {
      const tabs = await this.send({ action: 'getTabs', allWindows: true });
      if (!Array.isArray(tabs)) throw new Error('No tab data received from background');
      const groupIds = new Set(tabs.filter(t => t.groupId && t.groupId !== -1).map(t => t.groupId));
      if (groupIds.size === 0) {
        showToast('No tab groups to ungroup', 'info');
        return;
      }
      const ok = await showConfirm({
        title: 'Ungroup all tabs?',
        message: `Remove all ${groupIds.size} tab group${groupIds.size !== 1 ? 's' : ''}? Tabs stay open, but group names and colors are lost.`,
        confirmLabel: 'Ungroup All',
        danger: true,
      });
      if (!ok) return;
      // Re-read at action time so tabs grouped while the dialog was open are
      // included and tabs closed meanwhile are not sent.
      const liveTabs = await this.send({ action: 'getTabs', allWindows: true });
      if (!Array.isArray(liveTabs)) throw new Error('No tab data received from background');
      const grouped = liveTabs.filter(t => t.groupId && t.groupId !== -1);
      if (grouped.length > 0) {
        await this.send({ action: 'ungroupTabs', tabIds: grouped.map(t => t.id) });
      }
      if (!await this.refreshCommittedState('Tabs were ungrouped')) return;
      showToast('All tabs ungrouped', 'success');
    } catch (err) {
      showToast('Failed to ungroup tabs: ' + err.message, 'error');
    }
  }

  async refreshCommittedState(committedMessage) {
    try {
      await this.refresh();
      return true;
    } catch (err) {
      showToast(`${committedMessage}, but the view could not refresh: ${err.message}`, 'error');
      return false;
    }
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
