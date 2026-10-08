// group-editor.js — Chrome native groups + manual groups with drag-and-drop

import { showToast } from './toast.js';
import { showConfirm } from './confirm-dialog.js';
import { showStashedToast } from './stash-list.js';
import { sendOrThrow } from '../message-client.js';
import {
  createOverflowMenu,
  makeKeyboardActivatable,
  setExpanded,
  wireCollapseToggle,
} from './keyboard-activate.js';

/** Full-title + URL tooltip for a tab row. */
function tabTooltip(tab) {
  const title = tab?.title || '';
  const url = tab?.url || tab?.pendingUrl || '';
  if (title && url && title !== url) return `${title}\n${url}`;
  return title || url || 'New Tab';
}

function tabsText(n) {
  return `${n} tab${n !== 1 ? 's' : ''}`;
}

/**
 * Live member tab ids of a Chrome tab group, read at action time so tabs
 * added to the group since the last render are included and tabs that left
 * (or closed) are not touched.
 */
export async function queryLiveGroupTabIds(groupId) {
  const tabs = await chrome.tabs.query({ groupId });
  return (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => tab.groupId === groupId)
    .map((tab) => tab.id);
}

function closedCount(result, fallback) {
  for (const key of ['closed', 'closedCount']) {
    if (Number.isFinite(result?.[key])) return result[key];
  }
  return fallback;
}

export class GroupEditor {
  constructor(rootEl) {
    this.root = rootEl;
    this.notify = showToast;
    this.chromeGroupsContainer = rootEl.querySelector('#chrome-groups-container');
    this.groupsContainer = rootEl.querySelector('#manual-groups-container');
    this.ungroupedEl = rootEl.querySelector('#ungrouped-tabs');

    rootEl.querySelector('#btn-create-group').addEventListener('click', async () => {
      await this.createGroup();
    });
    rootEl.querySelector('#new-group-name').addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') await this.createGroup();
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
        setExpanded(headerEl, !collapsed);
      });
      makeKeyboardActivatable(headerEl, { expanded: !contentEl.hidden });
    }
  }

  async refresh() {
    const [chromeGroups, manualGroups, tabs] = await Promise.all([
      this.send({ action: 'getChromeGroups' }),
      this.getManualGroups(),
      this.send({ action: 'getTabs' }),
    ]);
    this.allTabs = tabs || [];
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

    // Bulk toolbar — same pattern as Domains/Windows: [Sleep all] [⇕]
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar view-toolbar chrome-groups-toolbar';

    const kebabAllBtn = document.createElement('button');
    kebabAllBtn.type = 'button';
    kebabAllBtn.className = 'action-btn secondary sleep-all-btn';
    kebabAllBtn.textContent = 'Sleep all';
    kebabAllBtn.title = 'Kebab: discard every grouped tab to free memory';
    kebabAllBtn.addEventListener('click', async () => {
      kebabAllBtn.disabled = true;
      try {
        await this.discardAllChromeGroups(groups);
      } finally {
        kebabAllBtn.disabled = false;
      }
    });

    const collapseToggleBtn = document.createElement('button');
    collapseToggleBtn.type = 'button';
    collapseToggleBtn.className = 'icon-toggle-btn collapse-toggle-btn';
    collapseToggleBtn.textContent = '⇕'; // ⇕
    wireCollapseToggle(collapseToggleBtn, {
      isAllCollapsed: () => groups.every((g) => g.collapsed),
      onToggle: (collapse) => this.setAllChromeGroupsCollapsed(groups, collapse),
    });

    toolbar.appendChild(kebabAllBtn);
    toolbar.appendChild(collapseToggleBtn);
    this.chromeGroupsContainer.appendChild(toolbar);

    for (const group of groups) {
      const el = document.createElement('div');
      el.className = 'chrome-group';
      const groupTitle = group.title || 'Untitled Group';

      // Header
      const header = document.createElement('div');
      header.className = 'chrome-group-header';
      header.addEventListener('click', () => {
        body.hidden = !body.hidden;
        chevron.textContent = body.hidden ? '▶' : '▼';
        setExpanded(header, !body.hidden);
      });

      const chevron = document.createElement('span');
      chevron.className = 'chrome-group-chevron';
      chevron.textContent = '▼';
      chevron.setAttribute('aria-hidden', 'true');

      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = this.chromeColor(group.color);
      dot.setAttribute('aria-hidden', 'true');

      const name = document.createElement('span');
      name.className = `group-name${group.title ? '' : ' group-name-untitled'}`;
      name.textContent = groupTitle;
      name.title = groupTitle;

      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = tabsText(group.tabs.length);

      header.appendChild(chevron);
      header.appendChild(dot);
      header.appendChild(name);
      header.appendChild(count);

      // Actions: Stash stays visible; the rest goes in ⋯ with Close last.
      const actions = document.createElement('div');
      actions.className = 'chrome-group-actions row-actions';

      const stashGroupBtn = document.createElement('button');
      stashGroupBtn.type = 'button';
      stashGroupBtn.className = 'stash-btn';
      stashGroupBtn.textContent = 'Stash';
      stashGroupBtn.title = 'Save and close tabs in this group';
      stashGroupBtn.setAttribute('aria-label', `Stash ${groupTitle} (${tabsText(group.tabs.length)})`);
      stashGroupBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        stashGroupBtn.disabled = true;
        stashGroupBtn.textContent = 'Stashing...';
        try {
          await this.stashChromeGroup(group);
        } finally {
          stashGroupBtn.disabled = false;
          stashGroupBtn.textContent = 'Stash';
        }
      });

      const rowMenu = createOverflowMenu({
        label: `More actions for ${groupTitle}`,
        items: [
          {
            label: 'Sleep tabs (Kebab)',
            className: 'kebab-item',
            title: 'Discard tabs in this group to free memory',
            onSelect: () => this.discardChromeGroup(group),
          },
          {
            label: 'Keep awake',
            className: 'keep-awake-item',
            title: 'Never auto-sleep tabs in this group',
            onSelect: () => this.keepChromeGroupAwake(group),
          },
          {
            label: group.collapsed ? 'Expand in tab strip' : 'Collapse in tab strip',
            className: 'collapse-item',
            onSelect: () => this.toggleChromeGroupCollapsed(group),
          },
          {
            label: 'Ungroup',
            className: 'ungroup-item',
            title: 'Remove the group; tabs stay open',
            onSelect: () => this.ungroupChromeGroup(group),
          },
          {
            label: `Close ${tabsText(group.tabs.length)}…`,
            danger: true,
            className: 'close-item',
            onSelect: () => this.confirmCloseChromeGroup(group),
          },
        ],
      });

      actions.appendChild(stashGroupBtn);
      actions.appendChild(rowMenu.wrapper);
      header.appendChild(actions);
      makeKeyboardActivatable(header, {
        expanded: true,
        label: `${groupTitle}, ${tabsText(group.tabs.length)}`,
      });

      // Tab list body
      const body = document.createElement('div');
      body.className = 'chrome-group-body';

      for (const tab of group.tabs) {
        const row = document.createElement('div');
        row.className = 'chrome-group-tab';
        row.title = tabTooltip(tab);
        row.addEventListener('click', async () => {
          try {
            await this.send({ action: 'focusTab', tabId: tab.id });
          } catch (err) {
            showToast('Failed to focus tab: ' + err.message, 'error');
          }
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

        row.appendChild(favicon);
        row.appendChild(title);
        makeKeyboardActivatable(row, { label: `Switch to ${title.textContent}` });
        body.appendChild(row);
      }

      el.appendChild(header);
      el.appendChild(body);
      this.chromeGroupsContainer.appendChild(el);
    }
  }

  async keepChromeGroupAwake(group) {
    try {
      await this.send({ action: 'setKeepAwake', scope: 'group', groupId: group.id, keepAwake: true });
      showToast(`"${group.title || 'Untitled Group'}" tabs set to keep awake`, 'success');
      return true;
    } catch (err) {
      showToast('Failed to set keep awake: ' + err.message, 'error');
      return false;
    }
  }

  async toggleChromeGroupCollapsed(group) {
    const newState = !group.collapsed;
    try {
      await this.send({ action: 'setGroupCollapsed', groupId: group.id, collapsed: newState });
      group.collapsed = newState;
    } catch (err) {
      showToast('Failed to update group: ' + err.message, 'error');
      return false;
    }
    await this.refreshCommittedState(newState ? 'Group collapsed' : 'Group expanded');
    return true;
  }

  async confirmCloseChromeGroup(group) {
    const tabIds = group.tabs.map(t => t.id);
    const ok = await showConfirm({
      title: 'Close group?',
      message: `Close ${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''} from "${group.title || 'Untitled Group'}"? This cannot be undone.`,
      confirmLabel: 'Close',
      danger: true,
    });
    if (!ok) return false;
    return this.closeChromeGroup(group);
  }

  // ── Manual Groups ──

  async getManualGroups() {
    return (await this.send({ action: 'getManualGroups' })) || {};
  }

  renderGroups(groups, tabs) {
    this.groupsContainer.innerHTML = '';

    const entries = Object.entries(groups);
    if (entries.length === 0) {
      this.groupsContainer.innerHTML = '<p class="empty-state">Name a group, then drag tabs into it.</p>';
      return;
    }

    for (const [groupId, group] of entries) {
      const groupEl = document.createElement('div');
      groupEl.className = 'manual-group';

      // Header (clickable to collapse/expand)
      const header = document.createElement('div');
      header.className = 'manual-group-header';

      const chevron = document.createElement('span');
      chevron.className = 'chrome-group-chevron';
      chevron.textContent = '\u25bc';
      chevron.setAttribute('aria-hidden', 'true');

      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = this.chromeColor(group.color);
      dot.setAttribute('aria-hidden', 'true');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'group-name';
      nameSpan.textContent = group.name;
      nameSpan.title = group.name;

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

      const urlSet = new Set(group.tabUrls);
      const matchingTabs = tabs.filter(t => urlSet.has(t.url));
      if (matchingTabs.length === 0) {
        body.innerHTML = '<p class="empty-state empty-state-compact">Drag tabs here or search below</p>';
      } else {
        for (const tab of matchingTabs) {
          body.appendChild(this.createDraggableTab(tab));
        }
      }

      // Add-tab area (search / paste URL)
      const addTabArea = this.createAddTabArea(groupId, group);

      // Toggle collapse/expand on header click
      header.addEventListener('click', () => {
        const isHidden = !body.hidden;
        body.hidden = isHidden;
        addTabArea.hidden = isHidden;
        chevron.textContent = isHidden ? '\u25b6' : '\u25bc';
        setExpanded(header, !isHidden);
      });
      makeKeyboardActivatable(header, {
        expanded: true,
        label: `${group.name}, ${tabsText(group.tabUrls.length)}`,
      });

      // Actions
      const actions = document.createElement('div');
      actions.className = 'manual-group-actions';

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'action-btn secondary action-btn-sm';
      applyBtn.textContent = 'Apply to Chrome';
      applyBtn.addEventListener('click', () => this.applyToChrome(groupId));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'action-btn ghost-danger action-btn-sm';
      deleteBtn.textContent = 'Delete group';
      deleteBtn.setAttribute('aria-label', `Delete group ${group.name}`);
      deleteBtn.addEventListener('click', async () => {
        const ok = await showConfirm({
          title: 'Delete group?',
          message: `"${group.name}" will be permanently deleted.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) await this.deleteGroup(groupId, group.name);
      });

      actions.appendChild(applyBtn);
      actions.appendChild(deleteBtn);

      groupEl.appendChild(header);
      groupEl.appendChild(body);
      groupEl.appendChild(addTabArea);
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
    item.title = tabTooltip(tab);

    item.appendChild(favicon);
    item.appendChild(title);

    return item;
  }

  // ── Add Tab Area (search open tabs / paste URL) ──

  createAddTabArea(groupId, group) {
    const area = document.createElement('div');
    area.className = 'group-add-tab';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input group-add-tab-input';
    input.placeholder = 'Search open tabs or paste a URL\u2026';
    input.setAttribute('aria-label', `Add a tab to ${group.name}`);

    const results = document.createElement('div');
    results.className = 'group-add-tab-results';

    let debounceTimer;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.renderAddTabResults(input.value.trim(), groupId, group, results, input);
      }, 150);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        results.innerHTML = '';
        input.blur();
        e.preventDefault();
      }
    });

    area.appendChild(input);
    area.appendChild(results);
    return area;
  }

  renderAddTabResults(query, groupId, group, resultsEl, inputEl) {
    resultsEl.innerHTML = '';
    if (!query) return;

    const isUrl = this.isLikelyUrl(query);
    const existingUrls = new Set(group.tabUrls);

    // If it looks like a URL, offer to add it directly
    if (isUrl) {
      let url = query;
      if (!/^https?:\/\//i.test(url) && !/^chrome(-extension)?:\/\//i.test(url)) {
        url = 'https://' + url;
      }
      if (!existingUrls.has(url)) {
        resultsEl.appendChild(this.createUrlResultItem(url, groupId, inputEl, resultsEl));
      }
    }

    // Filter open tabs by title or URL
    const q = query.toLowerCase();
    const matched = (this.allTabs || [])
      .filter(t => !existingUrls.has(t.url))
      .filter(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.url && t.url.toLowerCase().includes(q))
      )
      .slice(0, 8);

    for (const tab of matched) {
      resultsEl.appendChild(this.createTabResultItem(tab, groupId));
    }

    if (resultsEl.children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'group-add-tab-empty';
      empty.textContent = isUrl ? 'URL already in group' : 'No matching tabs found';
      resultsEl.appendChild(empty);
    }
  }

  createUrlResultItem(url, groupId, inputEl, resultsEl) {
    const item = document.createElement('div');
    item.className = 'group-add-tab-result url-result';

    const badge = document.createElement('span');
    badge.className = 'group-add-tab-url-badge';
    badge.textContent = 'URL';

    const label = document.createElement('span');
    label.className = 'group-add-tab-result-label';
    label.textContent = url;
    label.title = url;

    const addBtn = document.createElement('button');
    addBtn.className = 'group-add-tab-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add this URL to group';
    addBtn.type = 'button';
    addBtn.setAttribute('aria-label', `Add ${url} to group`);
    addBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.addTabToGroup(url, groupId, 'URL added to group');
    });

    item.appendChild(badge);
    item.appendChild(label);
    item.appendChild(addBtn);
    return item;
  }

  createTabResultItem(tab, groupId) {
    const item = document.createElement('div');
    item.className = 'group-add-tab-result';

    const favicon = document.createElement('img');
    favicon.className = 'favicon';
    favicon.src = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ccc"/></svg>';
    favicon.width = 16;
    favicon.height = 16;
    favicon.alt = '';
    favicon.addEventListener('error', () => {
      favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ccc"/></svg>';
    }, { once: true });

    const label = document.createElement('span');
    label.className = 'group-add-tab-result-label';
    label.textContent = tab.title || tab.url || 'Untitled';
    label.title = tab.url || '';

    const addBtn = document.createElement('button');
    addBtn.className = 'group-add-tab-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add to group';
    addBtn.type = 'button';
    addBtn.setAttribute('aria-label', `Add ${tab.title || tab.url || 'tab'} to group`);
    addBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.addTabToGroup(tab.url, groupId, 'Tab added to group');
    });

    item.appendChild(favicon);
    item.appendChild(label);
    item.appendChild(addBtn);
    return item;
  }

  isLikelyUrl(text) {
    if (/^https?:\/\//i.test(text)) return true;
    if (/^chrome(-extension)?:\/\//i.test(text)) return true;
    if (/^[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(text)) return true;
    return false;
  }

  // ── Drag and Drop ──

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

      await this.moveDroppedTab(tabUrl, targetGroupId);
    });
  }

  async moveTabToGroup(tabUrl, targetGroupId) {
    return this.send({ action: 'moveTabToManualGroup', tabUrl, targetGroupId });
  }

  async refreshCommittedState(committedMessage) {
    try {
      await this.refresh();
      return true;
    } catch (err) {
      this.notify(`${committedMessage}, but the view could not refresh: ${err.message}`, 'error');
      return false;
    }
  }

  async discardChromeGroup(group) {
    let result;
    try {
      result = await this.send({ action: 'discardTabs', scope: 'group', groupId: group.id });
    } catch (err) {
      this.notify('Kebab failed: ' + err.message, 'error');
      return false;
    }
    const message = `Kebab'd ${result.discarded} tabs (${result.skipped} skipped)`;
    const refreshed = await this.refreshCommittedState(message);
    if (refreshed) this.notify(message, 'success');
    return true;
  }

  async discardAllChromeGroups(groups) {
    let totalDiscarded = 0;
    let totalSkipped = 0;
    let committed = 0;
    const failures = [];
    for (const group of groups) {
      try {
        const result = await this.send({ action: 'discardTabs', scope: 'group', groupId: group.id });
        totalDiscarded += result.discarded;
        totalSkipped += result.skipped;
        committed += 1;
      } catch (err) {
        failures.push(err);
      }
    }

    const message = `Kebab'd ${totalDiscarded} tabs (${totalSkipped} skipped)`;
    const refreshed = committed > 0 ? await this.refreshCommittedState(message) : false;
    if (failures.length > 0) {
      this.notify(
        `Kebab All incomplete — ${failures.length} group${failures.length === 1 ? '' : 's'} failed: ${failures[0].message}`,
        'error',
      );
      return false;
    }
    if (refreshed) this.notify(message, 'success');
    return true;
  }

  async stashChromeGroup(group) {
    let result;
    try {
      result = await this.send({ action: 'stashGroup', groupId: group.id });
    } catch (err) {
      this.notify('Stash failed: ' + err.message, 'error');
      return false;
    }
    const from = `"${group.title}"`;
    const refreshed = await this.refreshCommittedState(`Stashed ${result.stash.tabCount} tabs from ${from}`);
    if (refreshed) {
      showStashedToast(result.stash, { from, onUndone: () => this.refresh(), notify: this.notify });
    }
    return true;
  }

  async ungroupChromeGroup(group) {
    let tabIds;
    try {
      tabIds = await queryLiveGroupTabIds(group.id);
      if (tabIds.length === 0) {
        this.notify(`"${group.title}" no longer has any tabs`, 'info');
        await this.refreshCommittedState('Group already empty');
        return false;
      }
      await this.send({ action: 'ungroupTabs', tabIds });
    } catch (err) {
      this.notify('Failed to ungroup tabs: ' + err.message, 'error');
      return false;
    }
    const message = `Ungrouped "${group.title}"`;
    const refreshed = await this.refreshCommittedState(message);
    if (refreshed) this.notify(message, 'success');
    return true;
  }

  async closeChromeGroup(group) {
    let count;
    try {
      const tabIds = await queryLiveGroupTabIds(group.id);
      if (tabIds.length === 0) {
        this.notify(`"${group.title}" no longer has any tabs`, 'info');
        await this.refreshCommittedState('Group already empty');
        return false;
      }
      const result = await this.send({ action: 'closeTabs', tabIds });
      count = closedCount(result, tabIds.length);
    } catch (err) {
      this.notify('Failed to close tabs: ' + err.message, 'error');
      return false;
    }
    const message = `Closed ${count} tabs from "${group.title}"`;
    const refreshed = await this.refreshCommittedState(message);
    if (refreshed) this.notify(message, 'success');
    return true;
  }

  async setAllChromeGroupsCollapsed(groups, collapsed) {
    const failures = [];
    let committed = 0;
    for (const group of groups) {
      try {
        await this.send({ action: 'setGroupCollapsed', groupId: group.id, collapsed });
        committed += 1;
      } catch (err) {
        failures.push(err);
      }
    }

    const verb = collapsed ? 'Collapsed' : 'Expanded';
    const message = `${verb} ${committed} group${committed === 1 ? '' : 's'}`;
    const refreshed = committed > 0 ? await this.refreshCommittedState(message) : false;
    if (failures.length > 0) {
      this.notify(
        `${verb} groups incomplete — ${failures.length} group${failures.length === 1 ? '' : 's'} failed: ${failures[0].message}`,
        'error',
      );
      return false;
    }
    if (refreshed) this.notify(message, 'success');
    return true;
  }

  async moveDroppedTab(tabUrl, targetGroupId) {
    try {
      await this.moveTabToGroup(tabUrl, targetGroupId);
    } catch (err) {
      this.notify('Failed to move tab: ' + err.message, 'error');
      return false;
    }
    await this.refreshCommittedState('Tab moved');
    return true;
  }

  async addTabToGroup(tabUrl, targetGroupId, successMessage) {
    try {
      await this.moveTabToGroup(tabUrl, targetGroupId);
    } catch (err) {
      this.notify('Failed to add tab to group: ' + err.message, 'error');
      return false;
    }
    const refreshed = await this.refreshCommittedState(successMessage);
    if (refreshed) this.notify(successMessage, 'success');
    return true;
  }

  async createGroup() {
    const nameInput = this.root.querySelector('#new-group-name');
    const colorSelect = this.root.querySelector('#new-group-color');
    const name = nameInput.value.trim();

    if (!name) {
      this.notify('Enter a group name', 'error');
      nameInput.focus();
      return false;
    }

    try {
      await this.send({ action: 'createManualGroup', name, color: colorSelect.value });
    } catch (err) {
      this.notify('Failed to create group: ' + err.message, 'error');
      return false;
    }
    nameInput.value = '';
    const successMessage = `Group "${name}" created`;
    const refreshed = await this.refreshCommittedState(successMessage);
    if (refreshed) this.notify(successMessage, 'success');
    return true;
  }

  async deleteGroup(groupId, name) {
    try {
      const result = await this.send({ action: 'deleteManualGroup', groupId });
      if (result?.deleted !== true) {
        this.notify('Group was not deleted because it no longer exists', 'error');
        return false;
      }
    } catch (err) {
      this.notify('Failed to delete group: ' + err.message, 'error');
      return false;
    }
    const successMessage = `Group "${name}" deleted`;
    const refreshed = await this.refreshCommittedState(successMessage);
    if (refreshed) this.notify(successMessage, 'success');
    return true;
  }

  async applyToChrome(groupId) {
    try {
      const groups = await this.getManualGroups();
      const group = groups[groupId];
      if (!group || group.tabUrls.length === 0) {
        showToast('No tabs in this group', 'error');
        return;
      }

      const allTabs = await this.send({ action: 'getTabs' });
      const urls = new Set(group.tabUrls);
      const tabIds = allTabs.filter(t => urls.has(t.url)).map(t => t.id);

      if (tabIds.length === 0) {
        showToast('No matching open tabs found', 'error');
        return;
      }

      await this.send({ action: 'createTabGroup', tabIds, title: group.name, color: group.color });
      showToast(`Applied "${group.name}" to Chrome`, 'success');
    } catch (err) {
      showToast('Failed to apply group: ' + err.message, 'error');
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
    return sendOrThrow(msg);
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
