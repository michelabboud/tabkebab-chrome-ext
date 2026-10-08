// U2 — Tabs (Domains / Groups / Duplicates) and Windows view UX fixes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { installFakeDom, keydown } from '../helpers/fake-dom.js';

import {
  createOverflowMenu,
  wireCollapseToggle,
} from '../../sidepanel/components/keyboard-activate.js';
import { TabList, domainLabel, tabTooltip } from '../../sidepanel/components/tab-list.js';
import { WindowList } from '../../sidepanel/components/window-list.js';
import { GroupEditor } from '../../sidepanel/components/group-editor.js';
import {
  DuplicateFinder,
  formatDuplicateUrl,
} from '../../sidepanel/components/duplicate-finder.js';

let dom;

beforeEach(() => {
  dom = installFakeDom();
  dom.el('div', { id: 'toast-container' });
  dom.el('div', { id: 'confirm-overlay', className: 'confirm-overlay' }).hidden = true;
});

afterEach(() => {
  dom.restore();
});

async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function recorder(responder = () => ({ success: true })) {
  const calls = [];
  installChromeMock({
    windows: [{ id: 1 }],
    runtimeHandler: async (message) => {
      calls.push(message);
      return responder(message);
    },
  });
  return calls;
}

function actions(calls, action) {
  return calls.filter((m) => m.action === action);
}

function menuItemLabels(menu) {
  return menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')
    .map((item) => item.textContent);
}

async function confirmDialog() {
  await flush();
  const overlay = document.getElementById('confirm-overlay');
  overlay.querySelectorAll('button')[1].click();
}

// ── Overflow menu primitive ──

describe('overflow menu', () => {
  function build(selected) {
    const header = dom.el('div', { className: 'row-header' });
    let headerClicks = 0;
    header.addEventListener('click', () => { headerClicks += 1; });
    const menu = createOverflowMenu({
      label: 'More actions for a.test',
      items: [
        { label: 'Close 2 tabs', danger: true, onSelect: () => selected.push('close') },
        { label: 'Sleep tabs', onSelect: () => selected.push('sleep') },
        { label: 'Keep awake', checked: true, onSelect: () => selected.push('awake') },
      ],
    });
    header.appendChild(menu.wrapper);
    return { menu, header, headerClicks: () => headerClicks };
  }

  test('exposes menu-button semantics and starts closed', () => {
    const { menu } = build([]);
    expect(menu.button.getAttribute('aria-haspopup')).toBe('menu');
    expect(menu.button.getAttribute('aria-expanded')).toBe('false');
    expect(menu.button.getAttribute('aria-label')).toBe('More actions for a.test');
    expect(menu.menu.getAttribute('role')).toBe('menu');
    expect(menu.menu.hidden).toBe(true);
    for (const item of menu.items) expect(item.getAttribute('tabindex')).toBe('-1');
  });

  test('destructive items are grouped last behind a separator', () => {
    const { menu } = build([]);
    const kids = menu.menu.children;
    expect(kids.map((k) => k.textContent || k.getAttribute('role'))).toEqual([
      'Sleep tabs', 'Keep awake', 'separator', 'Close 2 tabs',
    ]);
    expect(kids.at(-1).classList.contains('danger')).toBe(true);
    expect(kids[1].getAttribute('role')).toBe('menuitemcheckbox');
    expect(kids[1].getAttribute('aria-checked')).toBe('true');
  });

  test('opens on click, focuses the first item, arrows move, Escape closes and restores focus', () => {
    const { menu, headerClicks } = build([]);
    menu.button.click();
    expect(headerClicks()).toBe(0);
    expect(menu.menu.hidden).toBe(false);
    expect(menu.button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement.textContent).toBe('Sleep tabs');

    keydown(document.activeElement, 'ArrowDown');
    expect(document.activeElement.textContent).toBe('Keep awake');
    keydown(document.activeElement, 'ArrowDown');
    expect(document.activeElement.textContent).toBe('Close 2 tabs');
    keydown(document.activeElement, 'ArrowDown');
    expect(document.activeElement.textContent).toBe('Sleep tabs');
    keydown(document.activeElement, 'End');
    expect(document.activeElement.textContent).toBe('Close 2 tabs');

    const esc = keydown(document.activeElement, 'Escape');
    expect(esc._stopped).toBe(true);
    expect(menu.menu.hidden).toBe(true);
    expect(menu.button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu.button);
  });

  test('ArrowUp on the button opens on the last item', () => {
    const { menu } = build([]);
    keydown(menu.button, 'ArrowUp');
    expect(menu.menu.hidden).toBe(false);
    expect(document.activeElement.textContent).toBe('Close 2 tabs');
  });

  test('choosing an item closes the menu, runs it, and does not toggle the row', () => {
    const selected = [];
    const { menu, headerClicks } = build(selected);
    menu.button.click();
    menu.items[0].click();
    expect(selected).toEqual(['sleep']);
    expect(menu.menu.hidden).toBe(true);
    expect(headerClicks()).toBe(0);
  });

  test('opening one menu closes another; an outside click closes it', () => {
    const a = build([]).menu;
    const b = build([]).menu;
    a.button.click();
    b.button.click();
    expect(a.menu.hidden).toBe(true);
    expect(b.menu.hidden).toBe(false);
    dom.el('div').click();
    expect(b.menu.hidden).toBe(true);
  });

  test('collapse toggle exposes aria-pressed and flips it', async () => {
    let collapsed = false;
    const btn = dom.el('button');
    wireCollapseToggle(btn, {
      isAllCollapsed: () => collapsed,
      onToggle: (collapse) => { collapsed = collapse; },
    });
    expect(btn.getAttribute('aria-label')).toBe('Collapse all');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    await flush();
    expect(collapsed).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).toBe('Expand all');
  });
});

// ── Domains ──

function makeTabList() {
  const list = Object.create(TabList.prototype);
  list.listEl = dom.el('div');
  list.collapsed = new Set();
  list.initialized = false;
  list.lastGroups = [];
  list.allKeys = [];
  list.summaries = new Map();
  list.keepAwakeDomains = new Set();
  list._renderGeneration = 0;
  list._refreshGeneration = 0;
  list.refresh = async () => {};
  return list;
}

const GROUPS = [
  {
    domain: 'a-very-long-subdomain.example.com',
    tabs: [
      { id: 1, windowId: 1, title: 'Alpha', url: 'https://a-very-long-subdomain.example.com/x' },
      { id: 2, windowId: 1, title: 'Beta', url: 'https://a-very-long-subdomain.example.com/y' },
    ],
  },
  { domain: '', tabs: [{ id: 3, windowId: 1, title: '', url: 'about:blank' }] },
];

describe('Domains rows', () => {
  test('two-zone row: truncatable name with tooltip, Stash + ⋯ only', async () => {
    recorder();
    const list = makeTabList();
    await list.render(GROUPS);
    const header = list.listEl.querySelector('.domain-group-header');
    const name = header.querySelector('.domain-name');
    expect(name.textContent).toBe('a-very-long-subdomain.example.com');
    expect(name.title).toBe('a-very-long-subdomain.example.com');

    const actionsEl = header.querySelector('.row-actions');
    expect(actionsEl.querySelector('.stash-btn')).not.toBeNull();
    expect(actionsEl.querySelector('.row-menu-btn')).not.toBeNull();
    // No inline Kebab/Close/keep-awake chips competing for width.
    expect(header.querySelector('.kebab-btn')).toBeNull();
    expect(header.querySelector('.keep-awake-btn')).toBeNull();
    expect(header.querySelector('.close-btn')).toBeNull();
    // Single window: no W1 pill.
    expect(header.querySelector('.window-label')).toBeNull();

    expect(menuItemLabels(header.querySelector('.row-menu'))).toEqual([
      'Sleep tabs (Kebab)', 'Keep awake', 'Summarize tabs (AI)', 'Close 2 tabs…',
    ]);
  });

  test('non-http pages get a readable label instead of an empty name', async () => {
    recorder();
    const list = makeTabList();
    await list.render(GROUPS);
    const names = list.listEl.querySelectorAll('.domain-name').map((el) => el.textContent);
    expect(names[1]).toBe('Blank & browser pages');
    expect(domainLabel('')).toBe('Blank & browser pages');
    expect(domainLabel('other')).toBe('Other pages');
    expect(domainLabel('x.test')).toBe('x.test');
  });

  test('row menu items send the same messages as the old chips', async () => {
    const calls = recorder((m) => (m.action === 'discardTabs' ? { discarded: 2, skipped: 0 } : { success: true }));
    const list = makeTabList();
    await list.render(GROUPS);
    const header = list.listEl.querySelector('.domain-group-header');
    const [sleep, awake] = header.querySelectorAll('.row-menu-item');

    sleep.click();
    await flush();
    expect(actions(calls, 'discardTabs')).toEqual([
      { action: 'discardTabs', scope: 'domain', domain: 'a-very-long-subdomain.example.com' },
    ]);

    awake.click();
    await flush();
    expect(actions(calls, 'setKeepAwake')).toEqual([{
      action: 'setKeepAwake', scope: 'domain', domain: 'a-very-long-subdomain.example.com', keepAwake: true,
    }]);
  });

  test('Close in the menu still confirms before closing', async () => {
    const calls = recorder();
    const list = makeTabList();
    await list.render(GROUPS);
    const header = list.listEl.querySelector('.domain-group-header');
    header.querySelector('.row-menu-item.close-item').click();
    await flush();
    expect(actions(calls, 'closeTabs')).toEqual([]);
    await confirmDialog();
    await flush();
    expect(actions(calls, 'closeTabs')).toEqual([{ action: 'closeTabs', tabIds: [1, 2] }]);
  });

  test('Stash chip sends stashDomain with the raw domain key', async () => {
    const calls = recorder((m) => (m.action === 'stashDomain' ? { stash: { tabCount: 1 } } : { success: true }));
    const list = makeTabList();
    await list.render(GROUPS);
    list.listEl.querySelectorAll('.stash-btn')[1].click();
    await flush();
    expect(actions(calls, 'stashDomain')).toEqual([{ action: 'stashDomain', domain: '' }]);
  });

  test('tab rows carry full title + URL tooltips and a labelled close button', async () => {
    recorder();
    const list = makeTabList();
    await list.render(GROUPS);
    const row = list.listEl.querySelector('.tab-item');
    expect(row.title).toBe('Alpha\nhttps://a-very-long-subdomain.example.com/x');
    expect(row.getAttribute('role')).toBe('button');
    expect(row.querySelector('.close-btn').getAttribute('aria-label')).toBe('Close tab: Alpha');
    expect(tabTooltip({ url: 'about:blank' })).toBe('about:blank');
  });
});

describe('Domains toolbar', () => {
  function buildRoot() {
    const root = dom.el('div');
    const split = dom.el('div', { className: 'split-btn', parent: root });
    dom.el('button', { id: 'btn-group-by-domain', parent: split });
    dom.el('button', { id: 'btn-group-menu', parent: split });
    const menu = dom.el('div', { id: 'group-menu', parent: split });
    const smart = dom.el('button', { id: 'btn-smart-group', parent: menu });
    smart.setAttribute('role', 'menuitem');
    const ungroup = dom.el('button', { id: 'btn-ungroup-all', parent: menu });
    ungroup.setAttribute('role', 'menuitem');
    dom.el('button', { id: 'btn-kebab-all', parent: root });
    dom.el('button', { id: 'btn-toggle-collapse-tabs', parent: root });
    const progress = dom.el('div', { id: 'pipeline-progress', parent: root });
    for (const id of ['progress-phase', 'progress-title', 'progress-detail', 'progress-fill']) {
      dom.el('span', { id, parent: progress });
    }
    dom.el('div', { id: 'tab-list', parent: root });
    return root;
  }

  test('split button, Sleep all and the collapse toggle stay wired to the same actions', async () => {
    const calls = recorder((m) => {
      if (m.action === 'getGroupedTabs') return GROUPS;
      if (m.action === 'getKeepAwakeList') return [];
      if (m.action === 'getTabs') return [];
      if (m.action === 'discardTabs') return { discarded: 0, skipped: 0 };
      return { success: true };
    });
    const root = buildRoot();
    const list = new TabList(root);

    const menuBtn = root.querySelector('#btn-group-menu');
    expect(menuBtn.getAttribute('aria-haspopup')).toBe('menu');
    expect(menuBtn.getAttribute('aria-controls')).toBe('group-menu');
    expect(root.querySelector('#group-menu').hidden).toBe(true);

    root.querySelector('#btn-group-by-domain').click();
    await flush(20);
    expect(actions(calls, 'applyDomainGroups')).toHaveLength(1);

    menuBtn.click();
    expect(root.querySelector('#group-menu').hidden).toBe(false);
    expect(document.activeElement.id).toBe('btn-smart-group');
    root.querySelector('#btn-smart-group').click();
    expect(root.querySelector('#group-menu').hidden).toBe(true);
    await flush(20);
    expect(actions(calls, 'applySmartGroups')).toHaveLength(1);

    root.querySelector('#btn-ungroup-all').click();
    await flush();
    expect(actions(calls, 'getTabs')).toHaveLength(1);

    root.querySelector('#btn-kebab-all').click();
    await flush();
    expect(actions(calls, 'discardTabs')).toEqual([{ action: 'discardTabs', scope: 'all' }]);

    await list.refresh();
    const toggle = root.querySelector('#btn-toggle-collapse-tabs');
    expect(toggle.getAttribute('aria-pressed')).toBe('true'); // first load is collapsed
    toggle.click();
    await flush();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(list.collapsed.size).toBe(0);
    toggle.click();
    await flush();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });
});

// ── Windows ──

function makeWindowList() {
  const wl = Object.create(WindowList.prototype);
  wl.collapsed = new Set();
  wl.maxTabs = 50;
  wl.recommendedTabs = 20;
  wl.refresh = async () => {};
  return wl;
}

const WIN = (over = {}) => ({
  windowId: 2,
  windowNumber: 2,
  tabCount: 3,
  focused: false,
  groups: [],
  ungroupedCount: 1,
  ungroupedTabs: [{ id: 9, title: 'Docs', url: 'https://docs.test/a' }],
  ...over,
});

describe('Windows cards', () => {
  test('Bring to front is a styled secondary button; active window uses an edge + dot', () => {
    recorder();
    const wl = makeWindowList();
    const active = wl.createWindowCard(WIN({ focused: true, windowId: 1, windowNumber: 1 }));
    expect(active.classList.contains('window-card--active')).toBe(true);
    const focusBtn = active.querySelector('.window-focus-btn');
    expect(focusBtn.classList.contains('action-btn')).toBe(true);
    expect(focusBtn.classList.contains('secondary')).toBe(true);
    expect(active.querySelector('.window-active-dot').textContent).toBe('');
    expect(active.querySelector('.window-card-header').getAttribute('aria-label'))
      .toBe('Window 1 (current window), 3 tabs');
    // The focused window cannot be closed from here.
    expect(menuItemLabels(active.querySelector('.row-menu'))).toEqual(['Sleep tabs (Kebab)']);
  });

  test('menu actions: sleep, bring to front, confirmed close', async () => {
    const calls = recorder((m) => (m.action === 'discardTabs' ? { discarded: 1, skipped: 0 } : { success: true }));
    const removed = [];
    chrome.windows.remove = async (id) => { removed.push(id); };
    const focusedIds = [];
    chrome.windows.update = async (id, info) => { focusedIds.push([id, info]); };
    const wl = makeWindowList();
    const card = wl.createWindowCard(WIN());
    dom.document.body.appendChild(card);
    const menu = card.querySelector('.row-menu');
    expect(menuItemLabels(menu)).toEqual(['Sleep tabs (Kebab)', 'Bring to front', 'Close window…']);
    const [sleep, front, close] = menu.querySelectorAll('.row-menu-item');

    sleep.click();
    await flush();
    expect(actions(calls, 'discardTabs')).toEqual([{ action: 'discardTabs', scope: 'window', windowId: 2 }]);

    front.click();
    await flush();
    expect(focusedIds).toEqual([[2, { focused: true }]]);

    close.click();
    await flush();
    expect(removed).toEqual([]);
    await confirmDialog();
    await flush();
    expect(removed).toEqual([2]);
  });

  test('tab rows have tooltips and Stash sends stashWindow', async () => {
    const calls = recorder(() => ({ stash: { tabCount: 3 } }));
    const wl = makeWindowList();
    const card = wl.createWindowCard(WIN());
    expect(card.querySelector('.tab-item').title).toBe('Docs\nhttps://docs.test/a');
    card.querySelector('.stash-btn').click();
    await flush();
    expect(actions(calls, 'stashWindow')).toEqual([{ action: 'stashWindow', windowId: 2, windowNumber: 2 }]);
  });
});

// ── Groups ──

function makeEditor() {
  const editor = Object.create(GroupEditor.prototype);
  editor.notify = () => {};
  editor.chromeGroupsContainer = dom.el('div');
  editor.groupsContainer = dom.el('div');
  editor.refresh = async () => {};
  return editor;
}

const CHROME_GROUPS = [
  { id: 11, title: 'Review', color: 'blue', collapsed: false, tabs: [{ id: 1, title: 'PR', url: 'https://gh.test/pr' }] },
  { id: 12, title: '', color: 'red', collapsed: true, tabs: [{ id: 2, title: 'W', url: 'https://w.test/' }] },
];

describe('Groups view', () => {
  test('group titles render with a tooltip; actions are Stash + ⋯ with Close last', () => {
    recorder();
    const editor = makeEditor();
    editor.renderChromeGroups(CHROME_GROUPS);
    const headers = editor.chromeGroupsContainer.querySelectorAll('.chrome-group-header');
    const name = headers[0].querySelector('.group-name');
    expect(name.textContent).toBe('Review');
    expect(name.title).toBe('Review');
    expect(headers[1].querySelector('.group-name').textContent).toBe('Untitled Group');
    expect(headers[0].getAttribute('role')).toBe('button');
    expect(menuItemLabels(headers[0].querySelector('.row-menu'))).toEqual([
      'Sleep tabs (Kebab)', 'Keep awake', 'Collapse in tab strip', 'Ungroup', 'Close 1 tab…',
    ]);
    const row = editor.chromeGroupsContainer.querySelector('.chrome-group-tab');
    expect(row.title).toBe('PR\nhttps://gh.test/pr');
    expect(row.getAttribute('role')).toBe('button');
  });

  test('toolbar Sleep all and collapse toggle send the same group messages', async () => {
    const calls = recorder((m) => (m.action === 'discardTabs' ? { discarded: 1, skipped: 0 } : { success: true }));
    const editor = makeEditor();
    editor.renderChromeGroups(CHROME_GROUPS);
    const toolbar = editor.chromeGroupsContainer.querySelector('.chrome-groups-toolbar');
    toolbar.querySelector('.sleep-all-btn').click();
    await flush(20);
    expect(actions(calls, 'discardTabs')).toEqual([
      { action: 'discardTabs', scope: 'group', groupId: 11 },
      { action: 'discardTabs', scope: 'group', groupId: 12 },
    ]);

    const toggle = toolbar.querySelector('.collapse-toggle-btn');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    await flush(20);
    expect(actions(calls, 'setGroupCollapsed')).toEqual([
      { action: 'setGroupCollapsed', groupId: 11, collapsed: true },
      { action: 'setGroupCollapsed', groupId: 12, collapsed: true },
    ]);
  });

  test('menu Ungroup and Collapse keep their messages; Close confirms first', async () => {
    const calls = recorder();
    chrome.tabs.query = async () => [{ id: 1, groupId: 11 }];
    const editor = makeEditor();
    editor.renderChromeGroups(CHROME_GROUPS);
    const items = editor.chromeGroupsContainer.querySelector('.row-menu').querySelectorAll('.row-menu-item');
    items[2].click();
    await flush();
    expect(actions(calls, 'setGroupCollapsed')).toEqual([{ action: 'setGroupCollapsed', groupId: 11, collapsed: true }]);
    items[3].click();
    await flush();
    expect(actions(calls, 'ungroupTabs')).toEqual([{ action: 'ungroupTabs', tabIds: [1] }]);
    items[4].click();
    await flush();
    expect(actions(calls, 'closeTabs')).toEqual([]);
    await confirmDialog();
    await flush();
    expect(actions(calls, 'closeTabs')).toEqual([{ action: 'closeTabs', tabIds: [1] }]);
  });

  test('custom groups empty state teaches drag and drop', () => {
    const editor = makeEditor();
    editor.renderGroups({}, []);
    expect(editor.groupsContainer.textContent).toBe('Name a group, then drag tabs into it.');
  });
});

// ── Duplicates ──

describe('Duplicates', () => {
  test('formatDuplicateUrl decodes and shortens safely', () => {
    expect(formatDuplicateUrl('http://stackoverflow.com:8123/questions/1?t=javascript%20-%20How'))
      .toBe('stackoverflow.com:8123/questions/1?t=javascript - How');
    expect(formatDuplicateUrl('https://www.example.com/')).toBe('example.com');
    expect(formatDuplicateUrl('https://ex.test/caf%C3%A9')).toBe('ex.test/café');
    // Malformed escapes never throw.
    expect(formatDuplicateUrl('https://ex.test/bad%E0%A4%A')).toBe('ex.test/bad%E0%A4%A');
    expect(formatDuplicateUrl('chrome://settings/')).toBe('chrome://settings/');
    expect(formatDuplicateUrl('not a url %zz')).toBe('not a url %zz');
  });

  function makeFinder() {
    const finder = Object.create(DuplicateFinder.prototype);
    finder.listEl = dom.el('div');
    finder.closeAllBtn = dom.el('button');
    finder.duplicates = [{
      url: 'https://dup.test/a%20b',
      tabs: [
        { id: 1, title: 'One', url: 'https://dup.test/a%20b' },
        { id: 2, title: 'Two', url: 'https://dup.test/a%20b' },
        { id: 3, title: 'Three', url: 'https://dup.test/a%20b' },
      ],
    }];
    return finder;
  }

  test('group header shows a readable URL and keeps the raw URL in the tooltip', () => {
    const finder = makeFinder();
    finder.render();
    const urlEl = finder.listEl.querySelector('.dupe-url');
    expect(urlEl.textContent).toBe('dup.test/a b');
    expect(urlEl.title).toBe('https://dup.test/a%20b');
    const closeBtn = finder.listEl.querySelector('.dupe-close-btn');
    expect(closeBtn.getAttribute('aria-label')).toBe('Close tab: One');
  });

  test('Close button count matches the checked tabs it will close', () => {
    const finder = makeFinder();
    finder.render();
    expect(finder.closeAllBtn.textContent).toBe('Close 2 duplicates');
    expect(finder.closeAllBtn.disabled).toBe(false);

    const cb = finder.listEl.querySelector('input[data-tab-id="2"]');
    cb.checked = false;
    cb.dispatchEvent({ type: 'change', bubbles: true, preventDefault() {}, stopPropagation() {} });
    expect(finder.closeAllBtn.textContent).toBe('Close 1 duplicate');

    const cb3 = finder.listEl.querySelector('input[data-tab-id="3"]');
    cb3.checked = false;
    cb3.dispatchEvent({ type: 'change', bubbles: true, preventDefault() {}, stopPropagation() {} });
    expect(finder.closeAllBtn.textContent).toBe('Close duplicates');
    expect(finder.closeAllBtn.disabled).toBe(true);
  });
});

// ── Markup ──

describe('Tabs and Windows markup', () => {
  test('toolbars use the split button, Sleep all and one collapse toggle', async () => {
    const html = await Bun.file(new URL('../../sidepanel/panel.html', import.meta.url)).text();
    expect(html).toContain('id="btn-group-menu"');
    expect(html).toMatch(/id="group-menu"[^>]*role="menu"/);
    expect(html).toMatch(/id="btn-smart-group"[^>]*role="menuitem"/);
    expect(html).toMatch(/id="btn-ungroup-all"[^>]*role="menuitem"/);
    expect(html).toContain('id="btn-toggle-collapse-tabs"');
    expect(html).toContain('id="btn-toggle-collapse-windows"');
    expect(html).not.toContain('id="btn-collapse-all-tabs"');
    expect(html).not.toContain('id="btn-expand-all"');
    expect(html).toMatch(/id="new-group-name"[^>]*aria-label=/);
    expect(html).toMatch(/id="sub-domains"[^>]*role="tabpanel"/);
  });
});

// ── Stash Undo toasts + duplicate badge count ──

function lastToast() {
  const toast = document.getElementById('toast-container').children.at(-1);
  return {
    text: toast?.textContent || '',
    hasUndo: Boolean(toast?.querySelectorAll('button').some((b) => b.textContent === 'Undo')),
  };
}

describe('stash success uses showStashedToast (with Undo)', () => {
  const STASH = { id: 'stash-1', tabCount: 2 };

  test('Domains stash', async () => {
    recorder((m) => (m.action === 'stashDomain' ? { stash: STASH } : { success: true }));
    const list = makeTabList();
    await list.render(GROUPS);
    list.listEl.querySelector('.stash-btn').click();
    await flush(12);
    expect(lastToast().text).toContain('Stashed 2 tabs from a-very-long-subdomain.example.com');
    expect(lastToast().hasUndo).toBe(true);
  });

  test('Windows stash', async () => {
    recorder(() => ({ stash: STASH }));
    const wl = makeWindowList();
    wl.createWindowCard(WIN()).querySelector('.stash-btn').click();
    await flush(12);
    expect(lastToast().text).toContain('Stashed 2 tabs from Window 2');
    expect(lastToast().hasUndo).toBe(true);
  });

  test('Chrome group stash', async () => {
    recorder(() => ({ stash: STASH }));
    const editor = makeEditor();
    editor.notify = (await import('../../sidepanel/components/toast.js')).showToast;
    await editor.stashChromeGroup(CHROME_GROUPS[0]);
    expect(lastToast().text).toContain('Stashed 2 tabs from "Review"');
    expect(lastToast().hasUndo).toBe(true);
  });
});

test('dupesUpdated reports duplicateCount without blank pages', async () => {
  recorder((m) => (m.action === 'findDuplicates'
    ? [{ url: 'https://d.test/', tabs: [{ id: 1, url: 'https://d.test/' }, { id: 2, url: 'https://d.test/' }] }]
    : [{ id: 7, url: 'about:blank' }, { id: 8, url: 'about:blank' }]));
  const finder = Object.create(DuplicateFinder.prototype);
  finder.listEl = dom.el('div');
  finder.closeAllBtn = dom.el('button');
  finder.emptyPagesRow = null;
  const details = [];
  document.addEventListener('dupesUpdated', (e) => details.push(e.detail));
  await finder.scan();
  expect(details.at(-1)).toEqual({ count: 3, duplicateCount: 1 });
});
