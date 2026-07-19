// global-search.js — Global search overlay across tabs, stashes, and sessions

import { sendOrThrow } from '../message-client.js';

export const SEARCH_UNAVAILABLE_MESSAGE = 'Search unavailable — try again.';
const TAB_ACTIVATION_FAILURE_MESSAGE = 'Could not open tab — try again.';

function tabsFromWindows(record) {
  if (!Array.isArray(record?.windows)) return [];
  return record.windows.flatMap((window) => Array.isArray(window?.tabs) ? window.tabs : []);
}

function tabMatches(tab, query) {
  return (tab?.title && tab.title.toLowerCase().includes(query)) ||
    (tab?.url && tab.url.toLowerCase().includes(query));
}

function validateCurrentWindowRecords(records) {
  if (!Array.isArray(records)) throw new Error('Saved search records are unavailable');
  for (const record of records) {
    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      !Object.hasOwn(record, 'windows') ||
      !Array.isArray(record.windows)
    ) {
      throw new Error('Saved search records are unavailable');
    }
    for (const window of record.windows) {
      if (
        window === null ||
        typeof window !== 'object' ||
        Array.isArray(window) ||
        !Object.hasOwn(window, 'tabs') ||
        !Array.isArray(window.tabs)
      ) {
        throw new Error('Saved search records are unavailable');
      }
    }
  }
  return records;
}

export function flattenGroupedTabs(groupedTabs) {
  if (!Array.isArray(groupedTabs) || Object.hasOwn(groupedTabs, 'error')) {
    throw new Error('Grouped tabs are unavailable');
  }

  const tabs = [];
  for (const group of groupedTabs) {
    if (
      group === null ||
      typeof group !== 'object' ||
      Array.isArray(group) ||
      !Object.hasOwn(group, 'tabs') ||
      !Array.isArray(group.tabs)
    ) {
      throw new Error('Grouped tabs are unavailable');
    }
    tabs.push(...group.tabs);
  }
  return tabs;
}

export class GlobalSearch {
  constructor({ send = sendOrThrow } = {}) {
    this.send = send;
    this.overlay = null;
    this.input = null;
    this.resultsEl = null;
    this.activeIndex = -1;
    this.flatItems = [];
    this._debounceTimer = null;
    this._loadState = 'idle';
    this._lifecycleGeneration = 0;
    this._fetchGeneration = 0;

    // Cached data from parallel fetches
    this._tabs = [];
    this._stashes = [];
    this._sessions = [];
  }

  toggle() {
    if (this.overlay) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    if (this.overlay) return;
    this._lifecycleGeneration += 1;

    this.overlay = document.createElement('div');
    this.overlay.id = 'search-overlay';
    this.overlay.className = 'search-overlay';
    this.overlay.innerHTML = `
      <div class="search-panel">
        <div class="search-input-wrap">
          <svg class="search-input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input type="text" class="search-input" placeholder="Search tabs, stashes, sessions\u2026" autocomplete="off" spellcheck="false">
          <kbd class="search-esc-hint">Esc</kbd>
        </div>
        <div class="search-results"></div>
      </div>
    `;

    document.body.appendChild(this.overlay);
    this.input = this.overlay.querySelector('.search-input');
    this.resultsEl = this.overlay.querySelector('.search-results');

    this.input.addEventListener('input', () => this._onInput());
    this.overlay.addEventListener('keydown', (e) => this._onKeydown(e));
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    this.input.focus();
    void this._fetchAll(this._lifecycleGeneration);
  }

  close() {
    if (!this.overlay) return;
    this._lifecycleGeneration += 1;
    this.overlay.remove();
    this.overlay = null;
    this.input = null;
    this.resultsEl = null;
    this.activeIndex = -1;
    this.flatItems = [];
    this._tabs = [];
    this._stashes = [];
    this._sessions = [];
    this._loadState = 'idle';
    clearTimeout(this._debounceTimer);
  }

  async _fetchAll(lifecycleGeneration = this._lifecycleGeneration) {
    const fetchGeneration = ++this._fetchGeneration;
    const overlay = this.overlay;
    const ownsView = () =>
      this._lifecycleGeneration === lifecycleGeneration &&
      this._fetchGeneration === fetchGeneration &&
      this.overlay === overlay;
    this._loadState = 'loading';
    try {
      const [tabData, stashes, sessions] = await Promise.all([
        this.send({ action: 'getGroupedTabs' }),
        this.send({ action: 'listStashes' }),
        this.send({ action: 'listSessions' }),
      ]);

      const tabs = flattenGroupedTabs(tabData);
      const validStashes = validateCurrentWindowRecords(stashes);
      const validSessions = validateCurrentWindowRecords(sessions);
      if (!ownsView()) return false;
      this._tabs = tabs;
      this._stashes = validStashes;
      this._sessions = validSessions;
      this._loadState = 'ready';

      // Render initial state (empty query shows all)
      this._search(this.input?.value || '');
      return true;
    } catch {
      if (!ownsView()) return false;
      this._tabs = [];
      this._stashes = [];
      this._sessions = [];
      this.flatItems = [];
      this.activeIndex = -1;
      this._loadState = 'unavailable';
      this.renderUnavailable(SEARCH_UNAVAILABLE_MESSAGE);
      return false;
    }
  }

  renderUnavailable(message) {
    if (!this.resultsEl) return;
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.setAttribute('role', 'alert');
    empty.textContent = message;
    this.resultsEl.replaceChildren(empty);
  }

  _onInput() {
    clearTimeout(this._debounceTimer);
    if (this._loadState !== 'ready') return;
    this._debounceTimer = setTimeout(() => {
      this._search(this.input?.value || '');
    }, 150);
  }

  _search(query) {
    if (this._loadState !== 'ready') return;
    const q = query.trim().toLowerCase();

    // Filter open tabs
    const matchedTabs = this._tabs.filter(t =>
      !q ||
      (t.title && t.title.toLowerCase().includes(q)) ||
      (t.url && t.url.toLowerCase().includes(q))
    );

    // Filter stashes — match if any tab inside matches, or the stash name matches
    const matchedStashes = this._stashes.map((stash) => {
      const allTabs = tabsFromWindows(stash);
      const matchCount = q ? allTabs.filter((tab) => tabMatches(tab, q)).length : allTabs.length;
      const totalTabs = Number.isInteger(stash?.tabCount) && stash.tabCount >= 0
        ? stash.tabCount
        : allTabs.length;
      return { ...stash, _matchCount: matchCount, _totalTabs: totalTabs };
    }).filter((stash) => {
      if (!q) return true;
      return (stash.name && stash.name.toLowerCase().includes(q)) || stash._matchCount > 0;
    });

    // Filter sessions — match if any tab inside matches, or the session name matches
    const matchedSessions = this._sessions.map((session) => {
      const allTabs = tabsFromWindows(session);
      const matchCount = q ? allTabs.filter((tab) => tabMatches(tab, q)).length : allTabs.length;
      return { ...session, _matchCount: matchCount, _totalTabs: allTabs.length };
    }).filter((session) => {
      if (!q) return true;
      return (session.name && session.name.toLowerCase().includes(q)) || session._matchCount > 0;
    });

    this._renderResults(matchedTabs, matchedStashes, matchedSessions);
  }

  _renderResults(tabs, stashes, sessions) {
    if (!this.resultsEl) return;
    this.resultsEl.innerHTML = '';
    this.flatItems = [];
    this.activeIndex = -1;

    const maxPerSection = 10;

    if (tabs.length === 0 && stashes.length === 0 && sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = 'No results found';
      this.resultsEl.appendChild(empty);
      return;
    }

    // Open Tabs section
    if (tabs.length > 0) {
      this._renderSection('Open Tabs', tabs.length, tabs.slice(0, maxPerSection), (tab) => {
        const item = document.createElement('div');
        item.className = 'search-item';
        item.dataset.type = 'tab';
        item.dataset.tabId = tab.id;
        item.dataset.windowId = tab.windowId;

        const favicon = document.createElement('img');
        favicon.className = 'search-item-favicon';
        favicon.src = tab.favIconUrl || `chrome-extension://${chrome.runtime.id}/icons/icon16.png`;
        favicon.width = 16;
        favicon.height = 16;
        favicon.alt = '';
        favicon.onerror = () => { favicon.style.display = 'none'; };

        const title = document.createElement('span');
        title.className = 'search-item-title';
        title.textContent = tab.title || 'Untitled';

        const url = document.createElement('span');
        url.className = 'search-item-url';
        try {
          url.textContent = new URL(tab.url).hostname;
        } catch {
          url.textContent = tab.url || '';
        }

        item.append(favicon, title, url);
        return item;
      }, tabs.length > maxPerSection);
    }

    // Stashes section
    if (stashes.length > 0) {
      this._renderSection('Stashes', stashes.length, stashes.slice(0, maxPerSection), (stash) => {
        const item = document.createElement('div');
        item.className = 'search-item';
        item.dataset.type = 'stash';
        item.dataset.stashId = stash.id;

        const icon = document.createElement('span');
        icon.className = 'search-item-type-icon';
        icon.textContent = '\u{1F4E6}';

        const title = document.createElement('span');
        title.className = 'search-item-title';
        title.textContent = stash.name || 'Unnamed stash';

        const meta = document.createElement('span');
        meta.className = 'search-item-url';
        const tabCount = stash._totalTabs || 0;
        const parts = [`${tabCount} tab${tabCount !== 1 ? 's' : ''}`];
        if (stash._matchCount && stash._matchCount !== tabCount) {
          parts.push(`${stash._matchCount} matched`);
        }
        if (stash.createdAt) {
          parts.push(this._formatDate(stash.createdAt));
        }
        meta.textContent = parts.join(' \u00B7 ');

        item.append(icon, title, meta);
        return item;
      }, stashes.length > maxPerSection);
    }

    // Sessions section
    if (sessions.length > 0) {
      this._renderSection('Sessions', sessions.length, sessions.slice(0, maxPerSection), (session) => {
        const item = document.createElement('div');
        item.className = 'search-item';
        item.dataset.type = 'session';
        item.dataset.sessionId = session.id;

        const icon = document.createElement('span');
        icon.className = 'search-item-type-icon';
        icon.textContent = '\u{1F4BE}';

        const title = document.createElement('span');
        title.className = 'search-item-title';
        title.textContent = session.name || 'Unnamed session';

        const meta = document.createElement('span');
        meta.className = 'search-item-url';
        const totalTabs = session._totalTabs || 0;
        const parts = [`${totalTabs} tab${totalTabs !== 1 ? 's' : ''}`];
        if (session._matchCount && session._matchCount !== totalTabs) {
          parts.push(`${session._matchCount} matched`);
        }
        if (session.createdAt) {
          parts.push(this._formatDate(session.createdAt));
        }
        meta.textContent = parts.join(' \u00B7 ');

        item.append(icon, title, meta);
        return item;
      }, sessions.length > maxPerSection);
    }

    // Attach click handlers to all items
    for (const item of this.flatItems) {
      item.addEventListener('click', () => { void this._activateResult(item); });
    }
  }

  _renderSection(label, totalCount, items, renderItem, hasMore) {
    const header = document.createElement('div');
    header.className = 'search-section-header';
    header.innerHTML = `<span>${label}</span><span class="search-section-count">${totalCount}</span>`;
    this.resultsEl.appendChild(header);

    for (const data of items) {
      const el = renderItem(data);
      this.resultsEl.appendChild(el);
      this.flatItems.push(el);
    }

    if (hasMore) {
      const showAll = document.createElement('div');
      showAll.className = 'search-show-all';
      showAll.textContent = `Show all ${totalCount}`;
      showAll.addEventListener('click', () => {
        // Re-search without limit — handled by scrolling to view
        const sectionType = label.toLowerCase().includes('tab') ? 'tabs'
          : label.toLowerCase().includes('stash') ? 'stash'
          : 'sessions';
        this.close();
        const btn = document.querySelector(`.tab-nav [data-view="${sectionType}"]`);
        if (btn) btn.click();
      });
      this.resultsEl.appendChild(showAll);
    }
  }

  renderActionFailure(message) {
    if (!this.resultsEl) return;
    let error = this.resultsEl.querySelector('.search-action-error');
    if (!error) {
      error = document.createElement('div');
      error.className = 'search-action-error';
      error.setAttribute('role', 'alert');
      this.resultsEl.prepend(error);
    }
    error.textContent = message;
  }

  async _activateResult(item) {
    const type = item.dataset.type;
    const lifecycleGeneration = this._lifecycleGeneration;
    const overlay = this.overlay;
    const ownsView = () =>
      this._lifecycleGeneration === lifecycleGeneration && this.overlay === overlay;

    if (type === 'tab') {
      const tabId = parseInt(item.dataset.tabId, 10);
      const windowId = parseInt(item.dataset.windowId, 10);
      try {
        await chrome.tabs.update(tabId, { active: true });
        if (!ownsView()) return false;
        await chrome.windows.update(windowId, { focused: true });
        if (!ownsView()) return false;
        this.close();
        return true;
      } catch {
        if (ownsView()) this.renderActionFailure(TAB_ACTIVATION_FAILURE_MESSAGE);
        return false;
      }
    } else if (type === 'stash') {
      this.close();
      const btn = document.querySelector('.tab-nav [data-view="stash"]');
      if (btn) btn.click();
      return true;
    } else if (type === 'session') {
      this.close();
      const btn = document.querySelector('.tab-nav [data-view="sessions"]');
      if (btn) btn.click();
      return true;
    }
    return false;
  }

  _onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._moveActive(1);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._moveActive(-1);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.activeIndex >= 0 && this.activeIndex < this.flatItems.length) {
        void this._activateResult(this.flatItems[this.activeIndex]);
      }
      return;
    }
  }

  _moveActive(delta) {
    if (this.flatItems.length === 0) return;

    // Remove current highlight
    if (this.activeIndex >= 0 && this.activeIndex < this.flatItems.length) {
      this.flatItems[this.activeIndex].classList.remove('active');
    }

    // Compute new index
    this.activeIndex += delta;
    if (this.activeIndex < 0) this.activeIndex = this.flatItems.length - 1;
    if (this.activeIndex >= this.flatItems.length) this.activeIndex = 0;

    // Apply highlight and scroll into view
    this.flatItems[this.activeIndex].classList.add('active');
    this.flatItems[this.activeIndex].scrollIntoView({ block: 'nearest' });
  }

  _formatDate(dateStr) {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }
}
