// group-editor.js — Chrome native groups + manual groups with drag-and-drop

import { showToast } from './toast.js';
import { showConfirm } from './confirm-dialog.js';

export class GroupEditor {
  constructor(rootEl) {
    this.root = rootEl;
    this.chromeGroupsContainer = rootEl.querySelector('#chrome-groups-container');
    this.groupsContainer = rootEl.querySelector('#manual-groups-container');
    this.ungroupedEl = rootEl.querySelector('#ungrouped-tabs');

    rootEl.querySelector('#btn-create-group').addEventListener('click', () => this.createGroup());
    rootEl.querySelector('#new-group-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.createGroup();
    });

    this.setupDragAndDrop();
    this.setupSectionToggles();
  }

  setupSectionToggles() {
    const sections = [
      { header: '#section-chrome-groups', content: '#chrome-groups-container' },
      { header: '#section-custom-groups', content: '#custom-groups-content' },
      { header: '#section-ungrouped', content: '#ungrouped-tabs' },
    ];

    for (const { header, content } of sections) {
      const headerEl = this.root.querySelector(header);
      const contentEl = this.root.querySelector(content);
      if (!headerEl || !contentEl) continue;

      const chevron = headerEl.querySelector('.section-chevron');
      headerEl.addEventListener('click', () => {
        const collapsed = !contentEl.hidden;
        contentEl.hidden = collapsed;
        if (chevron) chevron.textContent = collapsed ? '\u25b6' : '\u25bc';
        headerEl.classList.toggle('collapsed', collapsed);
      });
    }
  }

  async refresh() {
    const [chromeGroups, manualGroups, tabs] = await Promise.all([
      this.send({ action: 'getChromeGroups' }),
      this.getManualGroups(),
      this.send({ action: 'getTabs' }),
    ]);
    this.renderChromeGroups(chromeGroups || []);
    this.renderGroups(manualGroups, tabs);
    this.renderUngrouped(manualGroups, tabs);
  }

  // ── Chrome Native Groups ──

  renderChromeGroups(groups) {
    this.chromeGroupsContainer.innerHTML = '';

    if (groups.length === 0) {
      this.chromeGroupsContainer.innerHTML = '<p class="empty-state">No active Chrome tab groups.</p>';
      return;
    }

    // Bulk collapse/expand toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar chrome-groups-toolbar';

    const collapseAllBtn = document.createElement('button');
    collapseAllBtn.className = 'action-btn secondary';
    collapseAllBtn.textContent = 'Collapse All';
    collapseAllBtn.addEventListener('click', async () => {
      for (const g of groups) {
        await this.send({ action: 'setGroupCollapsed', groupId: g.id, collapsed: true });
      }
      this.refresh();
    });

    const expandAllBtn = document.createElement('button');
    expandAllBtn.className = 'action-btn secondary';
    expandAllBtn.textContent = 'Expand All';
    expandAllBtn.addEventListener('click', async () => {
      for (const g of groups) {
        await this.send({ action: 'setGroupCollapsed', groupId: g.id, collapsed: false });
      }
      this.refresh();
    });

    const kebabAllBtn = document.createElement('button');
    kebabAllBtn.className = 'action-btn kebab';
    kebabAllBtn.textContent = 'Kebab All';
    kebabAllBtn.addEventListener('click', async () => {
      kebabAllBtn.disabled = true;
      let totalDiscarded = 0;
      let totalSkipped = 0;
      for (const g of groups) {
        try {
          const result = await this.send({ action: 'discardTabs', scope: 'group', groupId: g.id });
          totalDiscarded += result.discarded;
          totalSkipped += result.skipped;
        } catch { /* ignore */ }
      }
      showToast(`Kebab'd ${totalDiscarded} tabs (${totalSkipped} skipped)`, 'success');
      kebabAllBtn.disabled = false;
      this.refresh();
    });

    toolbar.appendChild(kebabAllBtn);
    toolbar.appendChild(collapseAllBtn);
    toolbar.appendChild(expandAllBtn);
    this.chromeGroupsContainer.appendChild(toolbar);

    for (const group of groups) {
      const el = document.createElement('div');
      el.className = 'chrome-group';

      // Header
      const header = document.createElement('div');
      header.className = 'chrome-group-header';
      header.addEventListener('click', () => {
        body.hidden = !body.hidden;
        chevron.textContent = body.hidden ? '\u25b6' : '\u25bc';
      });

      const chevron = document.createElement('span');
      chevron.className = 'chrome-group-chevron';
      chevron.textContent = '\u25bc';

      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = this.chromeColor(group.color);

      const name = document.createElement('span');
      name.className = 'group-name';
      name.textContent = group.title;

      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = `${group.tabs.length} tab${group.tabs.length !== 1 ? 's' : ''}`;

      header.appendChild(chevron);
      header.appendChild(dot);
      header.appendChild(name);
      header.appendChild(count);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'chrome-group-actions';

      const kebabGroupBtn = document.createElement('button');
      kebabGroupBtn.className = 'kebab-btn';
      kebabGroupBtn.textContent = 'Kebab';
      kebabGroupBtn.title = 'Discard tabs in this group';
      kebabGroupBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        kebabGroupBtn.disabled = true;
        try {
          const result = await this.send({ action: 'discardTabs', scope: 'group', groupId: group.id });
          showToast(`Kebab'd ${result.discarded} tabs (${result.skipped} skipped)`, 'success');
          this.refresh();
        } catch {
          showToast('Kebab failed', 'error');
        } finally {
          kebabGroupBtn.disabled = false;
        }
      });

      const keepAwakeGroupBtn = document.createElement('button');
      keepAwakeGroupBtn.className = 'keep-awake-btn';
      keepAwakeGroupBtn.textContent = '\u263E'; // ☾
      keepAwakeGroupBtn.title = 'Keep tabs in this group awake';
      keepAwakeGroupBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await this.send({ action: 'setKeepAwake', scope: 'group', groupId: group.id, keepAwake: true });
          showToast(`"${group.title}" tabs set to keep awake`, 'success');
        } catch {
          showToast('Failed to set keep awake', 'error');
        }
      });

      const stashGroupBtn = document.createElement('button');
      stashGroupBtn.className = 'stash-btn';
      stashGroupBtn.textContent = 'Stash';
      stashGroupBtn.title = 'Save and close tabs in this group';
      stashGroupBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        stashGroupBtn.disabled = true;
        stashGroupBtn.textContent = 'Stashing...';
        try {
          const result = await this.send({ action: 'stashGroup', groupId: group.id });
          showToast(`Stashed ${result.stash.tabCount} tabs from "${group.title}"`, 'success');
          this.refresh();
        } catch {
          showToast('Stash failed', 'error');
        } finally {
          stashGroupBtn.disabled = false;
          stashGroupBtn.textContent = 'Stash';
        }
      });

      const collapseBtn = document.createElement('button');
      collapseBtn.className = 'action-btn secondary';
      collapseBtn.textContent = group.collapsed ? 'Expand' : 'Collapse';
      collapseBtn.style.fontSize = '11px';
      collapseBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newState = !group.collapsed;
        await this.send({ action: 'setGroupCollapsed', groupId: group.id, collapsed: newState });
        group.collapsed = newState;
        collapseBtn.textContent = newState ? 'Expand' : 'Collapse';
      });

      const ungroupBtn = document.createElement('button');
      ungroupBtn.className = 'action-btn secondary';
      ungroupBtn.textContent = 'Ungroup';
      ungroupBtn.style.fontSize = '11px';
      ungroupBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tabIds = group.tabs.map(t => t.id);
        await this.send({ action: 'ungroupTabs', tabIds });
        showToast(`Ungrouped "${group.title}"`, 'success');
        this.refresh();
      });

      const closeBtn = document.createElement('button');
      closeBtn.className = 'action-btn danger';
      closeBtn.textContent = 'Close';
      closeBtn.style.fontSize = '11px';
      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tabIds = group.tabs.map(t => t.id);
        const ok = await showConfirm({
          title: 'Close group?',
          message: `Close ${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''} from "${group.title}"? This cannot be undone.`,
          confirmLabel: 'Close',
          danger: true,
        });
        if (!ok) return;
        await this.send({ action: 'closeTabs', tabIds });
        showToast(`Closed ${tabIds.length} tabs from "${group.title}"`, 'success');
        this.refresh();
      });

      actions.appendChild(stashGroupBtn);
      actions.appendChild(kebabGroupBtn);
      actions.appendChild(keepAwakeGroupBtn);
      actions.appendChild(collapseBtn);
      actions.appendChild(ungroupBtn);
      actions.appendChild(closeBtn);
      header.appendChild(actions);

      // Tab list body
      const body = document.createElement('div');
      body.className = 'chrome-group-body';

      for (const tab of group.tabs) {
        const row = document.createElement('div');
        row.className = 'chrome-group-tab';
        row.addEventListener('click', () => {
          this.send({ action: 'focusTab', tabId: tab.id });
        });

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
        title.title = tab.url || '';

        row.appendChild(favicon);
        row.appendChild(title);
        body.appendChild(row);
      }

      el.appendChild(header);
      el.appendChild(body);
      this.chromeGroupsContainer.appendChild(el);
    }
  }

  // ── Manual Groups ──

  async getManualGroups() {
    const data = await chrome.storage.local.get('manualGroups');
    return data.manualGroups || {};
  }

  renderGroups(groups, tabs) {
    this.groupsContainer.innerHTML = '';

    const entries = Object.entries(groups);
    if (entries.length === 0) {
      this.groupsContainer.innerHTML = '<p class="empty-state">No custom groups. Create one above.</p>';
      return;
    }

    for (const [groupId, group] of entries) {
      const groupEl = document.createElement('div');
      groupEl.className = 'manual-group';

      // Header (clickable to collapse/expand)
      const header = document.createElement('div');
      header.className = 'manual-group-header';
      header.style.cursor = 'pointer';

      const chevron = document.createElement('span');
      chevron.className = 'chrome-group-chevron';
      chevron.textContent = '\u25bc';

      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = this.chromeColor(group.color);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'group-name';
      nameSpan.textContent = this.escapeHtml(group.name);

      const countSpan = document.createElement('span');
      countSpan.className = 'group-count';
      countSpan.textContent = `${group.tabUrls.length} tab${group.tabUrls.length !== 1 ? 's' : ''}`;

      header.appendChild(chevron);
      header.appendChild(dot);
      header.appendChild(nameSpan);
      header.appendChild(countSpan);

      // Drop zone body
      const body = document.createElement('div');
      body.className = 'manual-group-body';
      body.dataset.dropzone = groupId;

      // Toggle collapse/expand on header click
      header.addEventListener('click', () => {
        body.hidden = !body.hidden;
        chevron.textContent = body.hidden ? '\u25b6' : '\u25bc';
      });

      const matchingTabs = tabs.filter(t => group.tabUrls.includes(t.url));
      if (matchingTabs.length === 0) {
        body.innerHTML = '<p class="empty-state" style="padding:8px">Drag tabs here</p>';
      } else {
        for (const tab of matchingTabs) {
          body.appendChild(this.createDraggableTab(tab));
        }
      }

      // Actions
      const actions = document.createElement('div');
      actions.className = 'manual-group-actions';

      const applyBtn = document.createElement('button');
      applyBtn.className = 'action-btn secondary';
      applyBtn.textContent = 'Apply to Chrome';
      applyBtn.style.fontSize = '11px';
      applyBtn.addEventListener('click', () => this.applyToChrome(groupId));

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'action-btn danger';
      deleteBtn.textContent = 'Delete Group';
      deleteBtn.style.fontSize = '11px';
      deleteBtn.addEventListener('click', async () => {
        const ok = await showConfirm({
          title: 'Delete group?',
          message: `"${group.name}" will be permanently deleted.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) this.deleteGroup(groupId, group.name);
      });

      actions.appendChild(applyBtn);
      actions.appendChild(deleteBtn);

      groupEl.appendChild(header);
      groupEl.appendChild(body);
      groupEl.appendChild(actions);
      this.groupsContainer.appendChild(groupEl);
    }
  }

  renderUngrouped(groups, tabs) {
    this.ungroupedEl.innerHTML = '';

    // Collect all URLs that are in any group
    const groupedUrls = new Set();
    for (const group of Object.values(groups)) {
      for (const url of group.tabUrls) {
        groupedUrls.add(url);
      }
    }

    const ungrouped = tabs.filter(t => !groupedUrls.has(t.url));

    if (ungrouped.length === 0) {
      this.ungroupedEl.innerHTML = '<p class="empty-state">All tabs are grouped.</p>';
      return;
    }

    for (const tab of ungrouped) {
      this.ungroupedEl.appendChild(this.createDraggableTab(tab));
    }
  }

  createDraggableTab(tab) {
    const item = document.createElement('div');
    item.className = 'tab-item';
    item.draggable = true;
    item.dataset.tabId = tab.id;
    item.dataset.tabUrl = tab.url;

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

    return item;
  }

  setupDragAndDrop() {
    this.root.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.tab-item[draggable]');
      if (!item) return;
      e.dataTransfer.setData('text/plain', item.dataset.tabUrl);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });

    this.root.addEventListener('dragend', (e) => {
      const item = e.target.closest('.tab-item');
      if (item) item.classList.remove('dragging');
      this.root.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    });

    this.root.addEventListener('dragover', (e) => {
      const dropzone = e.target.closest('[data-dropzone]');
      if (!dropzone) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      dropzone.classList.add('drop-target');
    });

    this.root.addEventListener('dragleave', (e) => {
      const dropzone = e.target.closest('[data-dropzone]');
      if (dropzone && !dropzone.contains(e.relatedTarget)) {
        dropzone.classList.remove('drop-target');
      }
    });

    this.root.addEventListener('drop', async (e) => {
      const dropzone = e.target.closest('[data-dropzone]');
      if (!dropzone) return;
      e.preventDefault();
      dropzone.classList.remove('drop-target');

      const tabUrl = e.dataTransfer.getData('text/plain');
      const targetGroupId = dropzone.dataset.dropzone;

      if (!tabUrl) return;

      try {
        await this.moveTabToGroup(tabUrl, targetGroupId);
        this.refresh();
      } catch (err) {
        showToast('Failed to move tab', 'error');
      }
    });
  }

  async moveTabToGroup(tabUrl, targetGroupId) {
    const groups = await this.getManualGroups();

    // Remove from all groups first
    for (const group of Object.values(groups)) {
      group.tabUrls = group.tabUrls.filter(u => u !== tabUrl);
      group.modifiedAt = Date.now();
    }

    // Add to target group (unless it's "ungrouped")
    if (targetGroupId !== 'ungrouped' && groups[targetGroupId]) {
      groups[targetGroupId].tabUrls.push(tabUrl);
      groups[targetGroupId].modifiedAt = Date.now();
    }

    await chrome.storage.local.set({ manualGroups: groups });
  }

  async createGroup() {
    const nameInput = this.root.querySelector('#new-group-name');
    const colorSelect = this.root.querySelector('#new-group-color');
    const name = nameInput.value.trim();

    if (!name) {
      showToast('Enter a group name', 'error');
      nameInput.focus();
      return;
    }

    const groupId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const groups = await this.getManualGroups();

    groups[groupId] = {
      name,
      color: colorSelect.value,
      tabUrls: [],
      createdAt: Date.now(),
      modifiedAt: Date.now()
    };

    await chrome.storage.local.set({ manualGroups: groups });
    nameInput.value = '';
    showToast(`Group "${name}" created`, 'success');
    this.refresh();
  }

  async deleteGroup(groupId, name) {
    const groups = await this.getManualGroups();
    delete groups[groupId];
    await chrome.storage.local.set({ manualGroups: groups });
    showToast(`Group "${name}" deleted`, 'success');
    this.refresh();
  }

  async applyToChrome(groupId) {
    const groups = await this.getManualGroups();
    const group = groups[groupId];
    if (!group || group.tabUrls.length === 0) {
      showToast('No tabs in this group', 'error');
      return;
    }

    const allTabs = await this.send({ action: 'getTabs' });
    const tabIds = allTabs.filter(t => group.tabUrls.includes(t.url)).map(t => t.id);

    if (tabIds.length === 0) {
      showToast('No matching open tabs found', 'error');
      return;
    }

    try {
      await this.send({ action: 'createTabGroup', tabIds, title: group.name, color: group.color });
      showToast(`Applied "${group.name}" to Chrome`, 'success');
    } catch {
      showToast('Failed to apply group', 'error');
    }
  }

  chromeColor(color) {
    const map = {
      blue: '#1a73e8',
      red: '#d93025',
      yellow: '#f9ab00',
      green: '#188038',
      pink: '#e8305b',
      purple: '#a142f4',
      cyan: '#00796b',
      orange: '#e8710a'
    };
    return map[color] || map.blue;
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
