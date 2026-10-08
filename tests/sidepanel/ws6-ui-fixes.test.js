// Regression tests for WS6 (side panel UI) of docs/reports/full-review-fix-plan.md.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { deferred } from '../helpers/deferred.js';
import { installFakeDom, keydown } from '../helpers/fake-dom.js';

import {
  DuplicateFinder,
  selectLiveDuplicateCloses,
  selectLiveEmptyPageIds,
} from '../../sidepanel/components/duplicate-finder.js';
import { GroupEditor } from '../../sidepanel/components/group-editor.js';
import { TabList } from '../../sidepanel/components/tab-list.js';
import { WindowList } from '../../sidepanel/components/window-list.js';
import { StashList } from '../../sidepanel/components/stash-list.js';
import { SessionManager } from '../../sidepanel/components/session-manager.js';
import { CommandBar } from '../../sidepanel/components/command-bar.js';
import { isConfirmOpen, showConfirm } from '../../sidepanel/components/confirm-dialog.js';
import {
  createDebounced,
  isPlainShortcutAllowed,
  resolveTabsChangedRefreshKey,
} from '../../sidepanel/panel-helpers.js';

let dom;
let toastContainer;

beforeEach(() => {
  dom = installFakeDom();
  toastContainer = dom.el('div', { id: 'toast-container' });
  dom.el('div', { id: 'confirm-overlay', className: 'confirm-overlay' }).hidden = true;
});

afterEach(() => {
  dom.restore();
});

function toasts() {
  return toastContainer.children.map((toast) => ({
    type: toast.className.replace(/^toast\s+/, ''),
    message: toast.children[0]?.textContent,
  }));
}

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function sentActions(calls, action) {
  return calls.filter((message) => message.action === action);
}

// ── 6.1 Re-validate stale tab ids at action time ──

describe('6.1 duplicate and group actions act only on live matching tabs', () => {
  test('empty-page selection drops tabs that loaded content, closed, became active, or are navigating', () => {
    const scanned = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const live = [
      { id: 1, url: 'about:blank', active: false },
      { id: 2, url: 'https://now-has-content.test/', active: false },
      { id: 4, url: 'about:blank', active: true },
      { id: 5, url: '', pendingUrl: 'https://loading.test/', active: false },
    ];
    expect(selectLiveEmptyPageIds(scanned, live)).toEqual([1]);
  });

  test('closeEmptyPages closes only pages that are still blank', async () => {
    const calls = [];
    installChromeMock({
      tabs: [
        { id: 1, url: 'about:blank' },
        { id: 2, url: 'https://typed-into.test/' },
      ],
      runtimeHandler: async (message) => {
        calls.push(message);
        if (message.action === 'findDuplicates') return [];
        if (message.action === 'findEmptyPages') return [];
        return { success: true };
      },
    });
    const finder = Object.create(DuplicateFinder.prototype);
    finder.listEl = document.createElement('div');
    finder.closeAllBtn = document.createElement('button');
    finder.emptyPagesRow = null;
    finder.duplicates = [];
    finder.emptyPages = [{ id: 1, url: 'about:blank' }, { id: 2, url: 'about:blank' }];

    const done = finder.closeEmptyPages();
    await new Promise((r) => setTimeout(r, 250));
    await done;

    expect(sentActions(calls, 'closeTabs')).toEqual([{ action: 'closeTabs', tabIds: [1] }]);
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Closed 1 empty page(s)' });
  });

  test('closeEmptyPages closes nothing when every scanned page now has content', async () => {
    const calls = [];
    installChromeMock({
      tabs: [{ id: 1, url: 'https://typed-into.test/' }],
      runtimeHandler: async (message) => {
        calls.push(message);
        if (message.action === 'findDuplicates') return [];
        if (message.action === 'findEmptyPages') return [];
        return { success: true };
      },
    });
    const finder = Object.create(DuplicateFinder.prototype);
    finder.listEl = document.createElement('div');
    finder.closeAllBtn = document.createElement('button');
    finder.emptyPagesRow = null;
    finder.duplicates = [];
    finder.emptyPages = [{ id: 1, url: 'about:blank' }];

    await finder.closeEmptyPages();

    expect(sentActions(calls, 'closeTabs')).toEqual([]);
  });

  test('duplicate selection drops navigated tabs and never closes the last live copy', () => {
    const groups = [{
      url: 'https://dup.test/page',
      tabs: [
        { id: 1, url: 'https://dup.test/page' },
        { id: 2, url: 'https://dup.test/page' },
        { id: 3, url: 'https://dup.test/page' },
      ],
    }];

    // Tab 3 navigated away; tab 1 (kept) still open → only tab 2 closes.
    expect(selectLiveDuplicateCloses(groups, [2, 3], [
      { id: 1, url: 'https://dup.test/page' },
      { id: 2, url: 'https://dup.test/page/' },
      { id: 3, url: 'https://elsewhere.test/' },
    ])).toEqual({ tabIds: [2], urls: ['https://dup.test/page/'] });

    // Kept tab 1 was closed: closing 2 and 3 would remove every copy.
    expect(selectLiveDuplicateCloses(groups, [2, 3], [
      { id: 2, url: 'https://dup.test/page' },
      { id: 3, url: 'https://dup.test/page' },
    ]).tabIds).toEqual([3]);

    // Everything selected is gone.
    expect(selectLiveDuplicateCloses(groups, [2, 3], []).tabIds).toEqual([]);
  });

  test('closeAllDuplicates sends only re-validated ids and undo reopens only those', async () => {
    const calls = [];
    installChromeMock({
      tabs: [
        { id: 1, url: 'https://dup.test/' },
        { id: 2, url: 'https://dup.test/' },
        { id: 3, url: 'https://moved-on.test/' },
      ],
      runtimeHandler: async (message) => {
        calls.push(message);
        if (message.action === 'findDuplicates') return [];
        if (message.action === 'findEmptyPages') return [];
        return { success: true };
      },
    });
    const finder = Object.create(DuplicateFinder.prototype);
    finder.listEl = document.createElement('div');
    finder.closeAllBtn = document.createElement('button');
    finder.emptyPagesRow = null;
    finder.emptyPages = [];
    finder.duplicates = [{
      url: 'https://dup.test/',
      tabs: [
        { id: 1, url: 'https://dup.test/' },
        { id: 2, url: 'https://dup.test/' },
        { id: 3, url: 'https://dup.test/' },
      ],
    }];
    finder.render();

    await finder.closeAllDuplicates();

    expect(sentActions(calls, 'closeTabs')).toEqual([{ action: 'closeTabs', tabIds: [2] }]);
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Closed 1 duplicate tab(s)' });
  });

  test('re-rendering duplicates preserves the user\'s checkbox choices', () => {
    const finder = Object.create(DuplicateFinder.prototype);
    finder.listEl = document.createElement('div');
    finder.closeAllBtn = document.createElement('button');
    finder.duplicates = [{
      url: 'https://dup.test/',
      tabs: [{ id: 1, url: 'https://dup.test/' }, { id: 2, url: 'https://dup.test/' }],
    }];
    finder.render();
    finder.listEl.querySelector('input[data-tab-id="2"]').checked = false;
    finder.render();
    expect(finder.listEl.querySelector('input[data-tab-id="2"]').checked).toBe(false);
  });

  test('Chrome group ungroup/close use live membership, including newly added tabs', async () => {
    const calls = [];
    installChromeMock({
      tabs: [
        { id: 10, groupId: 4, url: 'https://a.test/' },
        { id: 11, groupId: -1, url: 'https://left-group.test/' },
        { id: 12, groupId: 4, url: 'https://joined-later.test/' },
        { id: 13, groupId: 7, url: 'https://other.test/' },
      ],
      runtimeHandler: async (message) => {
        calls.push(message);
        return { success: true };
      },
    });
    const editor = Object.create(GroupEditor.prototype);
    const notices = [];
    editor.notify = (message, type) => notices.push({ message, type });
    editor.refresh = async () => {};
    const staleGroup = { id: 4, title: 'Work', tabs: [{ id: 10 }, { id: 11 }] };

    await expect(editor.ungroupChromeGroup(staleGroup)).resolves.toBeTrue();
    await expect(editor.closeChromeGroup(staleGroup)).resolves.toBeTrue();

    expect(sentActions(calls, 'ungroupTabs')).toEqual([{ action: 'ungroupTabs', tabIds: [10, 12] }]);
    expect(sentActions(calls, 'closeTabs')).toEqual([{ action: 'closeTabs', tabIds: [10, 12] }]);
    expect(notices.at(-1)).toEqual({ message: 'Closed 2 tabs from "Work"', type: 'success' });
  });

  test('Chrome group actions on a group that emptied send nothing', async () => {
    const calls = [];
    installChromeMock({
      tabs: [{ id: 10, groupId: -1 }],
      runtimeHandler: async (message) => { calls.push(message); return { success: true }; },
    });
    const editor = Object.create(GroupEditor.prototype);
    editor.notify = () => {};
    editor.refresh = async () => {};
    const staleGroup = { id: 4, title: 'Gone', tabs: [{ id: 10 }] };

    await expect(editor.closeChromeGroup(staleGroup)).resolves.toBeFalse();
    await expect(editor.ungroupChromeGroup(staleGroup)).resolves.toBeFalse();
    expect(calls).toEqual([]);
  });

  test('tabsChanged refreshes the visible live-tab view, not just Domains', async () => {
    expect(resolveTabsChangedRefreshKey({ visibleView: 'tabs', activeSubtab: 'domains' })).toBe('tabs');
    expect(resolveTabsChangedRefreshKey({ visibleView: 'tabs', activeSubtab: 'groups' })).toBe('groups');
    expect(resolveTabsChangedRefreshKey({ visibleView: 'tabs', activeSubtab: 'duplicates' })).toBe('duplicates');
    expect(resolveTabsChangedRefreshKey({ visibleView: 'tabs' })).toBe('tabs');
    expect(resolveTabsChangedRefreshKey({ visibleView: 'windows' })).toBe('windows');
    expect(resolveTabsChangedRefreshKey({ visibleView: 'stash' })).toBeNull();

    const panel = await Bun.file(new URL('../../sidepanel/panel.js', import.meta.url)).text();
    expect(panel).toMatch(/message\.type === 'tabsChanged'\)\s*{\s*scheduleTabsChangedRefresh\(\);/);
    expect(panel).toContain('createDebounced(refreshVisibleTabViews, 150)');
  });
});

// ── 6.2 Domains render race ──

function domainGroups(...domains) {
  return domains.map((domain, i) => ({
    domain,
    tabs: [{ id: 100 + i, windowId: 1, title: domain, url: `https://${domain}/` }],
  }));
}

function makeTabList() {
  const list = Object.create(TabList.prototype);
  list.listEl = document.createElement('div');
  document.body.appendChild(list.listEl);
  list.collapsed = new Set();
  list.initialized = false;
  list.lastGroups = [];
  list.allKeys = [];
  list.summaries = new Map();
  list.keepAwakeDomains = new Set();
  list._renderGeneration = 0;
  list._refreshGeneration = 0;
  return list;
}

describe('6.2 overlapping Domains renders never duplicate groups', () => {
  test('a stale render that resolves late is discarded', async () => {
    installChromeMock({ windows: [{ id: 1 }] });
    const pending = [];
    chrome.windows.getAll = () => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    };
    const list = makeTabList();

    const first = list.render(domainGroups('old.test'));
    const second = list.render(domainGroups('a.test', 'b.test'));
    pending[1].resolve([{ id: 1 }]);
    await second;
    pending[0].resolve([{ id: 1 }]);
    await first;

    const names = list.listEl.querySelectorAll('.domain-name').map((el) => el.textContent);
    expect(names).toEqual(['a.test', 'b.test']);
    expect(list.lastGroups.map((g) => g.domain)).toEqual(['a.test', 'b.test']);
  });

  test('N concurrent renders of the same data produce one copy of each group', async () => {
    installChromeMock({ windows: [{ id: 1 }] });
    const list = makeTabList();
    await Promise.all([1, 2, 3, 4].map(() => list.render(domainGroups('a.test', 'b.test'))));
    expect(list.listEl.querySelectorAll('.domain-group')).toHaveLength(2);
  });

  test('a refresh superseded by a newer refresh does not render', async () => {
    installChromeMock({ windows: [{ id: 1 }] });
    const list = makeTabList();
    const replies = [];
    list.send = (message) => {
      const d = deferred();
      replies.push({ message, d });
      return d.promise;
    };
    const first = list.refresh();
    const second = list.refresh();
    // Second refresh's data arrives first.
    replies[2].d.resolve(domainGroups('new.test'));
    replies[3].d.resolve([]);
    await second;
    replies[0].d.resolve(domainGroups('stale.test'));
    replies[1].d.resolve([]);
    await first;
    await flush();
    const names = list.listEl.querySelectorAll('.domain-name').map((el) => el.textContent);
    expect(names).toEqual(['new.test']);
  });

  test('tabsChanged bursts are debounced into one refresh', () => {
    const timers = new Map();
    let nextId = 0;
    let runs = 0;
    const debounced = createDebounced(() => { runs += 1; }, 150, {
      setTimer: (fn) => { const id = ++nextId; timers.set(id, fn); return id; },
      clearTimer: (id) => timers.delete(id),
    });
    for (let i = 0; i < 10; i += 1) debounced();
    expect(timers.size).toBe(1);
    for (const fn of timers.values()) fn();
    expect(runs).toBe(1);
  });
});

// ── 6.3 Shortcuts and dialog keyboard handling ──

describe('6.3 keyboard shortcuts and confirm dialog', () => {
  test('single-key shortcuts ignore modifiers, open dialogs, claimed events and inputs', () => {
    const body = { tagName: 'BODY' };
    expect(isPlainShortcutAllowed({ key: '1', target: body })).toBe(true);
    expect(isPlainShortcutAllowed({ key: 'F', shiftKey: true, target: body })).toBe(true);
    expect(isPlainShortcutAllowed({ key: 'f', ctrlKey: true, target: body })).toBe(false);
    expect(isPlainShortcutAllowed({ key: 'f', metaKey: true, target: body })).toBe(false);
    expect(isPlainShortcutAllowed({ key: '1', altKey: true, target: body })).toBe(false);
    expect(isPlainShortcutAllowed({ key: '1', target: body }, { dialogOpen: true })).toBe(false);
    expect(isPlainShortcutAllowed({ key: '1', defaultPrevented: true, target: body })).toBe(false);
    expect(isPlainShortcutAllowed({ key: '1', target: { tagName: 'INPUT' } })).toBe(false);
    expect(isPlainShortcutAllowed({ key: '1', target: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
  });

  test('panel keydown handler checks the dialog and modifier guard before shortcuts', async () => {
    const panel = await Bun.file(new URL('../../sidepanel/panel.js', import.meta.url)).text();
    const handler = panel.slice(panel.indexOf("document.addEventListener('keydown'"));
    const guard = handler.indexOf('isPlainShortcutAllowed(e, { dialogOpen: isConfirmOpen() })');
    expect(handler.indexOf('if (isConfirmOpen()) return;')).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(handler.indexOf("const tabKeys = {"));
    expect(guard).toBeLessThan(handler.indexOf("e.key === 'f'"));
  });

  test('Escape cancels without reaching the panel handler, and focus is restored', async () => {
    const opener = dom.el('button', { id: 'opener' });
    opener.focus();
    let panelSawEscape = false;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') panelSawEscape = true; });

    const result = showConfirm({ title: 'Close?', message: 'Sure?' });
    expect(isConfirmOpen()).toBe(true);
    const overlay = document.getElementById('confirm-overlay');
    expect(overlay.hidden).toBe(false);
    expect(overlay.querySelector('.confirm-dialog').getAttribute('role')).toBe('alertdialog');

    keydown(document.activeElement, 'Escape');
    await expect(result).resolves.toBe(false);
    expect(panelSawEscape).toBe(false);
    expect(isConfirmOpen()).toBe(false);
    expect(overlay.hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  test('Tab and Shift+Tab are trapped inside the dialog', async () => {
    const result = showConfirm({ title: 'Close?', message: 'Sure?', confirmLabel: 'Yes', cancelLabel: 'No' });
    const [cancelBtn, confirmBtn] = document.getElementById('confirm-overlay').querySelectorAll('button');
    expect(document.activeElement).toBe(confirmBtn);
    keydown(document.activeElement, 'Tab');
    expect(document.activeElement).toBe(cancelBtn);
    keydown(document.activeElement, 'Tab');
    expect(document.activeElement).toBe(confirmBtn);
    keydown(document.activeElement, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(cancelBtn);
    confirmBtn.click();
    await expect(result).resolves.toBe(true);
  });

  test('a second dialog cancels the first instead of orphaning its promise', async () => {
    const first = showConfirm({ title: 'A', message: 'a' });
    const second = showConfirm({ title: 'B', message: 'b' });
    await expect(first).resolves.toBe(false);
    expect(isConfirmOpen()).toBe(true);
    keydown(document.activeElement, 'Escape');
    await expect(second).resolves.toBe(false);
  });

  test('clicking inside the dialog body does not disarm backdrop-click cancel', async () => {
    const result = showConfirm({ title: 'A', message: 'a' });
    const overlay = document.getElementById('confirm-overlay');
    overlay.querySelector('.confirm-message').click();
    expect(isConfirmOpen()).toBe(true);
    overlay.click();
    await expect(result).resolves.toBe(false);
  });
});

// ── 6.4 Keyboard-accessible headers and rows ──

describe('6.4 headers and tab rows are keyboard operable', () => {
  test('Domains headers and tab rows expose button semantics and react to Enter/Space', async () => {
    const calls = [];
    installChromeMock({
      windows: [{ id: 1 }],
      runtimeHandler: async (message) => { calls.push(message); return { success: true }; },
    });
    const list = makeTabList();
    await list.render(domainGroups('a.test'));

    const header = list.listEl.querySelector('.domain-group-header');
    expect(header.getAttribute('tabindex')).toBe('0');
    expect(header.getAttribute('role')).toBe('button');
    expect(header.getAttribute('aria-expanded')).toBe('false');

    keydown(header, 'Enter');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(list.listEl.querySelector('.domain-group-body').classList.contains('collapsed')).toBe(false);

    // Keys on nested controls don't toggle the header.
    keydown(header.querySelector('.kebab-btn'), 'Enter');
    expect(header.getAttribute('aria-expanded')).toBe('true');

    keydown(header, ' ');
    expect(header.getAttribute('aria-expanded')).toBe('false');

    const row = list.listEl.querySelector('.tab-item');
    expect(row.getAttribute('tabindex')).toBe('0');
    expect(row.getAttribute('role')).toBe('button');
    keydown(row, 'Enter');
    await flush();
    expect(calls).toContainEqual({ action: 'focusTab', tabId: 100 });
  });

  test('Windows card/group headers and tab rows are keyboard operable', async () => {
    const calls = [];
    installChromeMock({
      runtimeHandler: async (message) => { calls.push(message); return { success: true }; },
    });
    const wl = Object.create(WindowList.prototype);
    wl.collapsed = new Set(['window-1']);
    wl.maxTabs = 50;
    wl.recommendedTabs = 20;
    const card = wl.createWindowCard({
      windowId: 1,
      windowNumber: 1,
      tabCount: 1,
      focused: true,
      groups: [{ groupId: 5, title: 'G', color: 'blue', tabCount: 1, tabs: [{ id: 7, title: 'T' }] }],
      ungroupedCount: 0,
      ungroupedTabs: [],
    });
    document.body.appendChild(card);

    const header = card.querySelector('.window-card-header');
    expect(header.getAttribute('role')).toBe('button');
    expect(header.getAttribute('tabindex')).toBe('0');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    keydown(header, 'Enter');
    expect(header.getAttribute('aria-expanded')).toBe('true');

    const groupHeader = card.querySelector('.window-group-header');
    expect(groupHeader.getAttribute('role')).toBe('button');
    expect(groupHeader.getAttribute('aria-expanded')).toBe('true');
    keydown(groupHeader, ' ');
    expect(groupHeader.getAttribute('aria-expanded')).toBe('false');
    // The nested toggle must not also toggle the card.
    expect(header.getAttribute('aria-expanded')).toBe('true');

    const row = card.querySelector('.tab-item');
    expect(row.getAttribute('role')).toBe('button');
    keydown(row, 'Enter');
    await flush();
    expect(calls).toContainEqual({ action: 'focusTab', tabId: 7 });
  });
});

// ── 6.5 Ungroup All confirmation ──

describe('6.5 Ungroup All asks for confirmation', () => {
  function setup() {
    const calls = [];
    installChromeMock({
      windows: [{ id: 1 }],
      runtimeHandler: async (message) => {
        calls.push(message);
        if (message.action === 'getTabs') {
          return [
            { id: 1, groupId: 3 },
            { id: 2, groupId: 3 },
            { id: 3, groupId: -1 },
          ];
        }
        return { success: true };
      },
    });
    const list = makeTabList();
    list.refresh = async () => {};
    return { list, calls };
  }

  test('cancelling the dialog leaves groups untouched', async () => {
    const { list, calls } = setup();
    const done = list.ungroupAll();
    await flush();
    expect(isConfirmOpen()).toBe(true);
    expect(document.getElementById('confirm-overlay').querySelector('.confirm-message').textContent)
      .toContain('1 tab group');
    keydown(document.activeElement, 'Escape');
    await done;
    expect(sentActions(calls, 'ungroupTabs')).toEqual([]);
  });

  test('confirming ungroups the live grouped tabs', async () => {
    const { list, calls } = setup();
    const done = list.ungroupAll();
    await flush();
    document.getElementById('confirm-overlay').querySelectorAll('button')[1].click();
    await done;
    expect(sentActions(calls, 'ungroupTabs')).toEqual([{ action: 'ungroupTabs', tabIds: [1, 2] }]);
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'All tabs ungrouped' });
  });

  test('no dialog when there are no groups', async () => {
    installChromeMock({ runtimeHandler: async () => [{ id: 1, groupId: -1 }] });
    const list = makeTabList();
    await list.ungroupAll();
    expect(isConfirmOpen()).toBe(false);
    expect(toasts().at(-1)).toEqual({ type: 'info', message: 'No tab groups to ungroup' });
  });
});

// ── 6.6 Concurrent restores ──

function buildStashList() {
  const root = dom.el('div');
  dom.el('div', { id: 'stash-list', parent: root });
  dom.el('button', { id: 'btn-export-stashes', parent: root });
  dom.el('input', { id: 'btn-import-stashes', parent: root });
  return new StashList(root);
}

function buildSessionManager() {
  const root = dom.el('div');
  for (const id of ['session-list-saved', 'session-list-auto']) dom.el('div', { id, parent: root });
  for (const id of ['btn-save-session', 'btn-export']) dom.el('button', { id, parent: root });
  for (const id of ['btn-import', 'session-name']) dom.el('input', { id, parent: root });
  return new SessionManager(root);
}

describe('6.6 concurrent restores keep each other\'s progress', () => {
  for (const [name, build] of [['StashList', buildStashList], ['SessionManager', buildSessionManager]]) {
    test(`${name} tracks every active restore id`, async () => {
      installChromeMock();
      const component = build();
      const updates = [];
      component.updateProgress = (id, created, loaded, total) => updates.push([id, loaded, total]);

      component.beginRestore('a');
      component.beginRestore('b');
      // Two restores report in the same frame: both must be applied.
      component._onRestoreProgress({ action: 'restoreProgress', restoreId: 'a', created: 1, loaded: 1, total: 4 });
      component._onRestoreProgress({ action: 'restoreProgress', restoreId: 'b', created: 2, loaded: 2, total: 5 });
      await new Promise((r) => setTimeout(r, 5));
      expect(updates).toEqual([['a', 1, 4], ['b', 2, 5]]);

      // Restore "a" finishing must not silence "b".
      expect(component.endRestore('a')).toBe(true);
      component._onRestoreProgress({ action: 'restoreProgress', restoreId: 'a', created: 4, loaded: 4, total: 4 });
      component._onRestoreProgress({ action: 'restoreProgress', restoreId: 'b', created: 3, loaded: 3, total: 5 });
      await new Promise((r) => setTimeout(r, 5));
      expect(updates.slice(2)).toEqual([['b', 3, 5]]);

      // Same id restored twice ("Restore" + "Restore here"): stays active until both end.
      component.beginRestore('b');
      expect(component.endRestore('b')).toBe(false);
      expect(component.isRestoreActive('b')).toBe(true);
      expect(component.endRestore('b')).toBe(true);
      expect(component.isRestoreActive('b')).toBe(false);
    });
  }

  test('restore buttons no longer use a single activeRestoreId', async () => {
    for (const file of ['stash-list', 'session-manager']) {
      const source = await Bun.file(new URL(`../../sidepanel/components/${file}.js`, import.meta.url)).text();
      expect(source).not.toContain('activeRestoreId');
    }
  });
});

// ── 6.7 Undefined service-worker responses ──

describe('6.7 undefined background responses fail with a clear error', () => {
  test('WindowList.refresh rejects clearly when getWindowStats returns nothing', async () => {
    installChromeMock({ runtimeHandler: async () => undefined });
    const wl = Object.create(WindowList.prototype);
    wl.listEl = document.createElement('div');
    await expect(wl.refresh()).rejects.toThrow('No window data received from background');
  });

  test('CommandBar reports a missing executeNLCommand response instead of crashing', async () => {
    installChromeMock({ runtimeHandler: async () => undefined });
    const root = dom.el('div');
    dom.el('input', { id: 'ai-command-input', parent: root }).value = 'close youtube';
    dom.el('div', { id: 'command-results', parent: root });
    dom.el('button', { id: 'btn-ai-command', parent: root });
    const bar = new CommandBar(root);

    await bar.execute();

    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Command failed: no response from background' });
    expect(bar.pending).toBe(false);
    expect(root.querySelector('#command-results').innerHTML).toBe('');
  });
});
