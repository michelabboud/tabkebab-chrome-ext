// window-list.js — Renders Chrome windows with tab groups, stats, and consolidation

import { showToast } from './toast.js';

const PHASE_LABELS = {
  snapshot: 'Reading',
  solver:   'Computing',
  planner:  'Planning',
  executor: 'Executing',
};

const PHASE_INDEX = { snapshot: 1, solver: 2, planner: 3, executor: 4 };

const CHROME_COLORS = {
  grey:   '#5f6368',
  blue:   '#1a73e8',
  red:    '#d93025',
  yellow: '#f9ab00',
  green:  '#1e8e3e',
  pink:   '#d01884',
  purple: '#a142f4',
  cyan:   '#007b83',
  orange: '#e8710a',
};

export class WindowList {
  constructor(rootEl) {
    this.root = rootEl;
    this.listEl = rootEl.querySelector('#window-list');
    this.collapsed = new Set();
    this.initialized = false;
    this.lastWindows = [];
    this.maxTabs = 50;
    this.recommendedTabs = 20;

    // Consolidate button + progress
    this.consolidateBtn = rootEl.querySelector('#btn-consolidate-windows');
    this.collapseBtn = rootEl.querySelector('#btn-collapse-all');
    this.expandBtn = rootEl.querySelector('#btn-expand-all');
    this.progressEl = rootEl.querySelector('#consolidation-progress');
    this.progressPhase = rootEl.querySelector('#consolidation-phase');
    this.progressTitle = rootEl.querySelector('#consolidation-title');
    this.progressDetail = rootEl.querySelector('#consolidation-detail');
    this.progressFill = rootEl.querySelector('#consolidation-fill');

    this.consolidateBtn.addEventListener('click', () => this.consolidate());
    this.collapseBtn.addEventListener('click', () => this.collapseAll());
    this.expandBtn.addEventListener('click', () => this.expandAll());

    // Listen for consolidation progress from service worker
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'consolidationProgress') {
        this.updateProgress(msg.phase, msg.detail);
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

    if (phase === 'executor') {
      this.progressFill.classList.remove('indeterminate');
      this.progressFill.style.width = '75%';
    } else {
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

    setTimeout(() => {
      this.progressEl.classList.remove('active', 'done');
    }, 4000);
  }

  hideProgress() {
    this.progressEl.classList.remove('active', 'done');
  }

  // ── Data fetching ──

  async refresh() {
    try {
      // Fetch settings for tab limit thresholds
      try {
        const settings = await this.send({ action: 'getSettings' });
        if (settings) {
          this.maxTabs = settings.maxTabsPerWindow || 50;
          this.recommendedTabs = settings.recommendedTabsPerWindow || 20;
        }
      } catch (e) { console.warn('[TabKebab] settings fetch for tab limits failed:', e); }

      const data = await this.send({ action: 'getWindowStats' });
      this.renderWindows(data.windows);
    } catch (err) {
      showToast('Failed to load windows', 'error');
    }
  }

  // ── Collapse / Expand ──

  /** Collect all collapsible keys for a set of windows. */
  getAllKeys(windows) {
    const keys = [];
    for (const win of windows) {
      keys.push(`window-${win.windowId}`);
      for (const group of win.groups) {
        keys.push(`wg-${win.windowId}-${group.groupId}`);
      }
      if (win.ungroupedCount > 0) {
        keys.push(`wg-${win.windowId}-ungrouped`);
      }
    }
    return keys;
  }

  /** Default state: everything collapsed except the focused window card. */
  applyDefaultCollapse(windows) {
    this.collapsed.clear();
    for (const key of this.getAllKeys(windows)) {
      this.collapsed.add(key);
    }
    // Expand the focused window card (but its inner groups stay collapsed)
    const focused = windows.find(w => w.focused);
    if (focused) {
      this.collapsed.delete(`window-${focused.windowId}`);
    }
  }

  collapseAll() {
    if (!this.lastWindows || this.lastWindows.length === 0) return;
    for (const key of this.getAllKeys(this.lastWindows)) {
      this.collapsed.add(key);
    }
    this.renderWindows(this.lastWindows);
  }

  expandAll() {
    if (!this.lastWindows || this.lastWindows.length === 0) return;
    this.collapsed.clear();
    this.renderWindows(this.lastWindows);
  }

  // ── Window list ──

  renderWindows(windows) {
    this.lastWindows = windows;
    this.listEl.innerHTML = '';

    if (!windows || windows.length === 0) {
      this.listEl.innerHTML = '<p class="empty-state">No windows found.</p>';
      return;
    }

    // On first load, apply default: everything collapsed except focused window
    if (!this.initialized) {
      this.applyDefaultCollapse(windows);
      this.initialized = true;
    }

    for (const win of windows) {
      this.listEl.appendChild(this.createWindowCard(win));
    }
  }

  createWindowCard(win) {
    const card = document.createElement('div');
    card.className = 'window-card';

    const key = `window-${win.windowId}`;
    const isCollapsed = this.collapsed.has(key);

    // Header
    const header = document.createElement('div');
    header.className = `window-card-header${isCollapsed ? ' collapsed' : ''}`;

    const statusDot = document.createElement('span');
    // Override status color based on settings thresholds
    let statusColor = 'green';
    if (win.tabCount >= this.maxTabs) statusColor = 'red';
    else if (win.tabCount >= this.recommendedTabs) statusColor = 'yellow';
    statusDot.className = `window-status-dot status-${statusColor}`;

    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.textContent = '\u25BC';

    const label = document.createElement('span');
    label.className = 'window-card-label';
    label.textContent = `Window ${win.windowNumber}`;

    header.appendChild(statusDot);
    header.appendChild(chevron);
    header.appendChild(label);

    // Show either a warning badge (with count) or a plain count — never both
    if (win.tabCount >= this.maxTabs) {
      const warnBadge = document.createElement('span');
      warnBadge.className = 'window-warning-badge warning-red';
      warnBadge.textContent = `${win.tabCount} tabs`;
      warnBadge.title = `Exceeds limit of ${this.maxTabs} tabs per window`;
      header.appendChild(warnBadge);
    } else if (win.tabCount >= this.recommendedTabs) {
      const warnBadge = document.createElement('span');
      warnBadge.className = 'window-warning-badge warning-yellow';
      warnBadge.textContent = `${win.tabCount} tabs`;
      warnBadge.title = `Exceeds recommended ${this.recommendedTabs} tabs per window`;
      header.appendChild(warnBadge);
    } else {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = win.tabCount;
      header.appendChild(count);
    }

    // Stash button
    const stashBtn = document.createElement('button');
    stashBtn.className = 'stash-btn';
    stashBtn.textContent = 'Stash';
    stashBtn.title = 'Save and close all tabs in this window';
    stashBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      stashBtn.disabled = true;
      stashBtn.textContent = 'Stashing...';
      try {
        const result = await this.send({ action: 'stashWindow', windowId: win.windowId, windowNumber: win.windowNumber });
        showToast(`Stashed ${result.stash.tabCount} tabs from Window ${win.windowNumber}`, 'success');
        this.refresh();
      } catch {
        showToast('Stash failed', 'error');
      } finally {
        stashBtn.disabled = false;
        stashBtn.textContent = 'Stash';
      }
    });
    header.appendChild(stashBtn);

    // Kebab button
    const kebabBtn = document.createElement('button');
    kebabBtn.className = 'kebab-btn';
    kebabBtn.textContent = 'Kebab';
    kebabBtn.title = 'Discard tabs in this window';
    kebabBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      kebabBtn.disabled = true;
      try {
        const result = await this.send({ action: 'discardTabs', scope: 'window', windowId: win.windowId });
        showToast(`Kebab'd ${result.discarded} tabs (${result.skipped} skipped)`, 'success');
        this.refresh();
      } catch {
        showToast('Kebab failed', 'error');
      } finally {
        kebabBtn.disabled = false;
      }
    });
    header.appendChild(kebabBtn);

    if (win.focused) {
      const badge = document.createElement('span');
      badge.className = 'window-focus-badge';
      badge.textContent = 'active';
      header.appendChild(badge);
    }

    header.addEventListener('click', () => {
      const body = card.querySelector('.window-card-body');
      if (this.collapsed.has(key)) {
        this.collapsed.delete(key);
        header.classList.remove('collapsed');
        body.classList.remove('collapsed');
      } else {
        this.collapsed.add(key);
        header.classList.add('collapsed');
        body.classList.add('collapsed');
      }
    });

    // Body
    const body = document.createElement('div');
    body.className = `window-card-body${isCollapsed ? ' collapsed' : ''}`;

    // Group chips row
    if (win.groups.length > 0 || win.ungroupedCount > 0) {
      const chipsRow = document.createElement('div');
      chipsRow.className = 'group-chips-row';

      for (const group of win.groups) {
        const chip = document.createElement('span');
        chip.className = 'group-chip';

        const dot = document.createElement('span');
        dot.className = 'group-chip-dot';
        dot.style.background = CHROME_COLORS[group.color] || CHROME_COLORS.grey;

        const chipLabel = document.createElement('span');
        chipLabel.className = 'group-chip-label';
        chipLabel.textContent = group.title || 'Untitled Group';

        const chipCount = document.createElement('span');
        chipCount.className = 'group-chip-count';
        chipCount.textContent = group.tabCount;

        chip.appendChild(dot);
        chip.appendChild(chipLabel);
        chip.appendChild(chipCount);
        chipsRow.appendChild(chip);
      }

      if (win.ungroupedCount > 0) {
        const chip = document.createElement('span');
        chip.className = 'group-chip';

        const dot = document.createElement('span');
        dot.className = 'group-chip-dot';
        dot.style.background = CHROME_COLORS.grey;

        const chipLabel = document.createElement('span');
        chipLabel.className = 'group-chip-label';
        chipLabel.textContent = 'Ungrouped';

        const chipCount = document.createElement('span');
        chipCount.className = 'group-chip-count';
        chipCount.textContent = win.ungroupedCount;

        chip.appendChild(dot);
        chip.appendChild(chipLabel);
        chip.appendChild(chipCount);
        chipsRow.appendChild(chip);
      }

      body.appendChild(chipsRow);
    }

    // Collapsible group sections
    for (const group of win.groups) {
      body.appendChild(this.createGroupSection(win.windowId, group));
    }

    // Ungrouped section
    if (win.ungroupedCount > 0) {
      body.appendChild(this.createUngroupedSection(win.windowId, win.ungroupedTabs));
    }

    // Focus window button
    const focusBtn = document.createElement('button');
    focusBtn.className = 'window-focus-btn';
    focusBtn.textContent = 'Focus Window';
    focusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.windows.update(win.windowId, { focused: true });
    });
    body.appendChild(focusBtn);

    card.appendChild(header);
    card.appendChild(body);
    return card;
  }

  createGroupSection(windowId, group) {
    const section = document.createElement('div');
    section.className = 'window-group-section';

    const key = `wg-${windowId}-${group.groupId}`;
    const isCollapsed = this.collapsed.has(key);

    const sectionHeader = document.createElement('div');
    sectionHeader.className = `window-group-header${isCollapsed ? ' collapsed' : ''}`;

    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.textContent = '\u25BC';

    const dot = document.createElement('span');
    dot.className = 'group-chip-dot';
    dot.style.background = CHROME_COLORS[group.color] || CHROME_COLORS.grey;

    const label = document.createElement('span');
    label.className = 'window-group-label';
    label.textContent = group.title || 'Untitled Group';

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = group.tabCount;

    sectionHeader.appendChild(chevron);
    sectionHeader.appendChild(dot);
    sectionHeader.appendChild(label);
    sectionHeader.appendChild(count);

    const sectionBody = document.createElement('div');
    sectionBody.className = `window-group-body${isCollapsed ? ' collapsed' : ''}`;

    for (const tab of group.tabs) {
      sectionBody.appendChild(this.createTabItem(tab));
    }

    sectionHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.collapsed.has(key)) {
        this.collapsed.delete(key);
        sectionHeader.classList.remove('collapsed');
        sectionBody.classList.remove('collapsed');
      } else {
        this.collapsed.add(key);
        sectionHeader.classList.add('collapsed');
        sectionBody.classList.add('collapsed');
      }
    });

    section.appendChild(sectionHeader);
    section.appendChild(sectionBody);
    return section;
  }

  createUngroupedSection(windowId, tabs) {
    const section = document.createElement('div');
    section.className = 'window-group-section';

    const key = `wg-${windowId}-ungrouped`;
    const isCollapsed = this.collapsed.has(key);

    const sectionHeader = document.createElement('div');
    sectionHeader.className = `window-group-header${isCollapsed ? ' collapsed' : ''}`;

    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.textContent = '\u25BC';

    const dot = document.createElement('span');
    dot.className = 'group-chip-dot';
    dot.style.background = CHROME_COLORS.grey;

    const label = document.createElement('span');
    label.className = 'window-group-label';
    label.textContent = 'Ungrouped';

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = tabs.length;

    sectionHeader.appendChild(chevron);
    sectionHeader.appendChild(dot);
    sectionHeader.appendChild(label);
    sectionHeader.appendChild(count);

    const sectionBody = document.createElement('div');
    sectionBody.className = `window-group-body${isCollapsed ? ' collapsed' : ''}`;

    for (const tab of tabs) {
      sectionBody.appendChild(this.createTabItem(tab));
    }

    sectionHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.collapsed.has(key)) {
        this.collapsed.delete(key);
        sectionHeader.classList.remove('collapsed');
        sectionBody.classList.remove('collapsed');
      } else {
        this.collapsed.add(key);
        sectionHeader.classList.add('collapsed');
        sectionBody.classList.add('collapsed');
      }
    });

    section.appendChild(sectionHeader);
    section.appendChild(sectionBody);
    return section;
  }

  createTabItem(tab) {
    const item = document.createElement('div');
    item.className = 'tab-item';
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

    item.appendChild(favicon);
    item.appendChild(title);

    item.addEventListener('click', () => {
      this.send({ action: 'focusTab', tabId: tab.id });
    });

    return item;
  }

  // ── Consolidation ──

  async consolidate() {
    this.consolidateBtn.disabled = true;
    this.showProgress();

    try {
      const result = await this.send({ action: 'consolidateWindows' });

      if (result && result.tabsMoved === 0 && result.windowsConsolidated === 0) {
        this.showDone('No under-utilized windows to consolidate');
      } else if (result) {
        const parts = [];
        if (result.windowsConsolidated > 0) parts.push(`${result.windowsConsolidated} window(s) consolidated`);
        if (result.tabsMoved > 0) parts.push(`${result.tabsMoved} tabs moved`);
        if (result.windowsClosed > 0) parts.push(`${result.windowsClosed} window(s) closed`);
        const summary = parts.length > 0 ? parts.join(', ') : 'Done';
        this.showDone(summary);
        showToast('Windows consolidated', 'success');
      } else {
        this.hideProgress();
      }

      this.refresh();
    } catch {
      this.hideProgress();
      showToast('Failed to consolidate windows', 'error');
    } finally {
      this.consolidateBtn.disabled = false;
    }
  }

  send(msg) {
    return chrome.runtime.sendMessage(msg);
  }
}
