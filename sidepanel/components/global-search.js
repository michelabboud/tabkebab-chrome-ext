// global-search.js — Global search overlay across tabs, stashes, and sessions

export class GlobalSearch {
  constructor() {
    this.overlay = null;
    this.input = null;
    this.resultsEl = null;
    this.activeIndex = -1;
    this.flatItems = [];
    this._debounceTimer = null;

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
    this._fetchAll();
  }

  close() {
    if (!this.overlay) return;
    this.overlay.remove();
    this.overlay = null;
    this.input = null;
    this.resultsEl = null;
    this.activeIndex = -1;
    this.flatItems = [];
    this._tabs = [];
    this._stashes = [];
    this._sessions = [];
    clearTimeout(this._debounceTimer);
  }

  async _fetchAll() {
    try {
      const [tabData, stashes, sessions] = await Promise.all([
        chrome.runtime.sendMessage({ action: 'getGroupedTabs' }),
        chrome.runtime.sendMessage({ action: 'listStashes' }),
        chrome.runtime.sendMessage({ action: 'listSessions' }),
      ]);

      // Flatten grouped tabs
      this._tabs = [];
      if (tabData?.groups) {
        for (const group of tabData.groups) {
          if (group.tabs) {
            this._tabs.push(...group.tabs);
          }
        }
      }

      this._stashes = stashes || [];
      this._sessions = sessions || [];

      // Render initial state (empty query shows all)
      this._search(this.input?.value || '');
    } catch {
      // Data not available yet
    }
  }

  _onInput() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._search(this.input?.value || '');
    }, 150);
  }

  _search(query) {
    const q = query.trim().toLowerCase();

    // Filter open tabs
    const matchedTabs = this._tabs.filter(t =>
      !q ||
      (t.title && t.title.toLowerCase().includes(q)) ||
      (t.url && t.url.toLowerCase().includes(q))
    );

    // Filter stashes — match if any tab inside matches, or the stash name matches
    const matchedStashes = this._stashes.filter(s => {
      if (!q) return true;
      if (s.name && s.name.toLowerCase().includes(q)) return true;
      return (s.tabs || []).some(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.url && t.url.toLowerCase().includes(q))
      );
    }).map(s => {
      const matchCount = q
        ? (s.tabs || []).filter(t =>
            (t.title && t.title.toLowerCase().includes(q)) ||
            (t.url && t.url.toLowerCase().includes(q))
          ).length
        : s.tabs?.length || 0;
      return { ...s, _matchCount: matchCount };
    });

    // Filter sessions — match if any tab inside matches, or the session name matches
    const matchedSessions = this._sessions.filter(s => {
      if (!q) return true;
      if (s.name && s.name.toLowerCase().includes(q)) return true;
      const allTabs = (s.windows || []).flatMap(w => w.tabs || []);
      return allTabs.some(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.url && t.url.toLowerCase().includes(q))
      );
    }).map(s => {
      const allTabs = (s.windows || []).flatMap(w => w.tabs || []);
      const matchCount = q
        ? allTabs.filter(t =>
            (t.title && t.title.toLowerCase().includes(q)) ||
            (t.url && t.url.toLowerCase().includes(q))
          ).length
        : allTabs.length;
      return { ...s, _matchCount: matchCount, _totalTabs: allTabs.length };
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
        const tabCount = stash.tabs?.length || 0;
        const parts = [`${tabCount} tab${tabCount !== 1 ? 's' : ''}`];
        if (stash._matchCount && stash._matchCount !== tabCount) {
          parts.push(`${stash._matchCount} matched`);
        }
        if (stash.date) {
          parts.push(this._formatDate(stash.date));
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
        if (session.date) {
          parts.push(this._formatDate(session.date));
        }
        meta.textContent = parts.join(' \u00B7 ');

        item.append(icon, title, meta);
        return item;
      }, sessions.length > maxPerSection);
    }

    // Attach click handlers to all items
    for (const item of this.flatItems) {
      item.addEventListener('click', () => this._activateResult(item));
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

  _activateResult(item) {
    const type = item.dataset.type;

    if (type === 'tab') {
      const tabId = parseInt(item.dataset.tabId, 10);
      const windowId = parseInt(item.dataset.windowId, 10);
      chrome.tabs.update(tabId, { active: true });
      chrome.windows.update(windowId, { focused: true });
      this.close();
    } else if (type === 'stash') {
      this.close();
      const btn = document.querySelector('.tab-nav [data-view="stash"]');
      if (btn) btn.click();
    } else if (type === 'session') {
      this.close();
      const btn = document.querySelector('.tab-nav [data-view="sessions"]');
      if (btn) btn.click();
    }
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
        this._activateResult(this.flatItems[this.activeIndex]);
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
