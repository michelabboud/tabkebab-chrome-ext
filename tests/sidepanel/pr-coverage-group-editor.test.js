// PR coverage: Groups view (sidepanel/components/group-editor.js) behaviour
// changed in the 1.3.0 review — live-membership actions, committed-vs-refresh
// messaging, section disclosure semantics, manual groups and the add-tab area.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { createEvent, installFakeDom, keydown } from '../helpers/fake-dom.js';

import { GroupEditor, queryLiveGroupTabIds } from '../../sidepanel/components/group-editor.js';

let dom;
let toastContainer;
let overlay;

beforeEach(() => {
  dom = installFakeDom();
  toastContainer = dom.el('div', { id: 'toast-container' });
  overlay = dom.el('div', { id: 'confirm-overlay' });
});

afterEach(() => {
  dom.restore();
});

function toasts() {
  return toastContainer.children.map((toast) => ({
    type: toast.className.replace(/^toast\s+/, '').split(' ')[0],
    message: toast.children[0]?.textContent,
  }));
}

async function flush(times = 12) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function buildEditor() {
  const root = dom.el('div');
  for (const [header, content] of [
    ['section-chrome-groups', 'chrome-groups-container'],
    ['section-custom-groups', 'custom-groups-content'],
    ['section-ungrouped', 'ungrouped-tabs'],
  ]) {
    const h = dom.el('div', { id: header, parent: root });
    dom.el('span', { className: 'section-chevron', parent: h });
    dom.el('div', { id: content, parent: root });
  }
  dom.el('div', { id: 'manual-groups-container', parent: dom.document.getElementById('custom-groups-content') });
  dom.el('button', { id: 'btn-create-group', parent: root });
  dom.el('input', { id: 'new-group-name', parent: root });
  const color = dom.el('select', { id: 'new-group-color', parent: root });
  color.value = 'red';
  return { root, editor: new GroupEditor(root) };
}

function routedHandler(routes, sent = []) {
  return async (message) => {
    sent.push(message);
    const route = routes[message.action];
    if (typeof route === 'function') return route(message);
    return route;
  };
}

const BASE_ROUTES = {
  getChromeGroups: [],
  getManualGroups: {},
  getTabs: [],
};

function confirmButtons() {
  const buttons = overlay.querySelectorAll('button');
  return { cancel: buttons[0], confirm: buttons[1] };
}

describe('section toggles are keyboard-operable disclosures', () => {
  test('headers get button semantics, aria-expanded flips with the content, chevron follows', () => {
    installChromeMock();
    const { root } = buildEditor();
    const header = root.querySelector('#section-ungrouped');
    const content = root.querySelector('#ungrouped-tabs');
    expect(header.getAttribute('role')).toBe('button');
    expect(header.getAttribute('tabindex')).toBe('0');
    expect(header.getAttribute('aria-expanded')).toBe('true');

    keydown(header, 'Enter');
    expect(content.hidden).toBe(true);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.classList.contains('collapsed')).toBe(true);
    expect(header.querySelector('.section-chevron').textContent).toBe('▶');

    keydown(header, ' ');
    expect(content.hidden).toBe(false);
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  test('a missing section pair is skipped instead of throwing', () => {
    installChromeMock();
    const root = dom.el('div');
    for (const id of ['chrome-groups-container', 'manual-groups-container', 'ungrouped-tabs']) {
      dom.el('div', { id, parent: root });
    }
    dom.el('button', { id: 'btn-create-group', parent: root });
    dom.el('input', { id: 'new-group-name', parent: root });
    expect(() => new GroupEditor(root)).not.toThrow();
  });
});

describe('queryLiveGroupTabIds', () => {
  test('keeps only tabs still in the group and tolerates a non-array response', async () => {
    installChromeMock({
      tabs: [
        { id: 1, groupId: 5, url: 'https://a.test/' },
        { id: 2, groupId: 6, url: 'https://b.test/' },
        { id: 3, groupId: 5, url: 'https://c.test/' },
      ],
    });
    expect(await queryLiveGroupTabIds(5)).toEqual([1, 3]);
    expect(await queryLiveGroupTabIds(99)).toEqual([]);

    const original = chrome.tabs.query;
    chrome.tabs.query = async () => undefined;
    try {
      expect(await queryLiveGroupTabIds(5)).toEqual([]);
    } finally {
      chrome.tabs.query = original;
    }
  });
});

describe('Chrome group actions report commits and refresh failures separately', () => {
  test('closeChromeGroup uses the worker-reported closed count, not the requested count', async () => {
    const sent = [];
    installChromeMock({
      tabs: [{ id: 1, groupId: 4 }, { id: 2, groupId: 4 }, { id: 3, groupId: 4 }],
      runtimeHandler: routedHandler({ ...BASE_ROUTES, closeTabs: { closed: 2 } }, sent),
    });
    const { editor } = buildEditor();
    expect(await editor.closeChromeGroup({ id: 4, title: 'Work', tabs: [] })).toBe(true);
    expect(sent.find((m) => m.action === 'closeTabs')).toEqual({ action: 'closeTabs', tabIds: [1, 2, 3] });
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Closed 2 tabs from "Work"' });
  });

  test('closeChromeGroup falls back to closedCount, then to the live id count', async () => {
    let response = { closedCount: 1 };
    installChromeMock({
      tabs: [{ id: 1, groupId: 4 }, { id: 2, groupId: 4 }],
      runtimeHandler: routedHandler({ ...BASE_ROUTES, closeTabs: () => response }),
    });
    const { editor } = buildEditor();
    await editor.closeChromeGroup({ id: 4, title: 'W', tabs: [] });
    expect(toasts().at(-1).message).toBe('Closed 1 tabs from "W"');
    response = { success: true };
    await editor.closeChromeGroup({ id: 4, title: 'W', tabs: [] });
    expect(toasts().at(-1).message).toBe('Closed 2 tabs from "W"');
  });

  test('a close that committed but whose refresh failed says so instead of reporting failure', async () => {
    installChromeMock({
      tabs: [{ id: 1, groupId: 4 }],
      runtimeHandler: routedHandler({
        getChromeGroups: () => { throw new Error('worker gone'); },
        getManualGroups: {},
        getTabs: [],
        closeTabs: { closed: 1 },
      }),
    });
    const { editor } = buildEditor();
    expect(await editor.closeChromeGroup({ id: 4, title: 'W', tabs: [] })).toBe(true);
    expect(toasts()).toEqual([
      { type: 'error', message: 'Closed 1 tabs from "W", but the view could not refresh: worker gone' },
    ]);
  });

  test('closeTabs failure reports the error and returns false', async () => {
    installChromeMock({
      tabs: [{ id: 1, groupId: 4 }],
      runtimeHandler: routedHandler({ ...BASE_ROUTES, closeTabs: { error: 'boom' } }),
    });
    const { editor } = buildEditor();
    expect(await editor.closeChromeGroup({ id: 4, title: 'W', tabs: [] })).toBe(false);
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Failed to close tabs: boom' });
  });

  test('ungroup failure is reported; success refreshes then notifies', async () => {
    let fail = true;
    installChromeMock({
      tabs: [{ id: 9, groupId: 2 }],
      runtimeHandler: routedHandler({
        ...BASE_ROUTES,
        ungroupTabs: () => (fail ? { error: 'nope' } : { success: true }),
      }),
    });
    const { editor } = buildEditor();
    expect(await editor.ungroupChromeGroup({ id: 2, title: 'G', tabs: [] })).toBe(false);
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Failed to ungroup tabs: nope' });
    fail = false;
    expect(await editor.ungroupChromeGroup({ id: 2, title: 'G', tabs: [] })).toBe(true);
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Ungrouped "G"' });
  });

  test('confirmCloseChromeGroup closes nothing when cancelled and closes live tabs when confirmed', async () => {
    const sent = [];
    installChromeMock({
      tabs: [{ id: 1, groupId: 4 }, { id: 2, groupId: 4 }],
      runtimeHandler: routedHandler({ ...BASE_ROUTES, closeTabs: { closed: 2 } }, sent),
    });
    const { editor } = buildEditor();
    const group = { id: 4, title: '', tabs: [{ id: 1 }] };

    let pending = editor.confirmCloseChromeGroup(group);
    expect(overlay.querySelector('.confirm-message').textContent)
      .toBe('Close 1 tab from "Untitled Group"? This cannot be undone.');
    confirmButtons().cancel.click();
    expect(await pending).toBe(false);
    expect(sent.some((m) => m.action === 'closeTabs')).toBe(false);

    pending = editor.confirmCloseChromeGroup(group);
    confirmButtons().confirm.click();
    expect(await pending).toBe(true);
    // Live membership wins over the rendered snapshot (tab 2 joined since render).
    expect(sent.find((m) => m.action === 'closeTabs').tabIds).toEqual([1, 2]);
  });

  test('discardChromeGroup reports discarded/skipped counts and failures', async () => {
    let response = { discarded: 3, skipped: 1 };
    installChromeMock({
      runtimeHandler: routedHandler({ ...BASE_ROUTES, discardTabs: () => response }),
    });
    const { editor } = buildEditor();
    expect(await editor.discardChromeGroup({ id: 1 })).toBe(true);
    expect(toasts().at(-1)).toEqual({ type: 'success', message: "Kebab'd 3 tabs (1 skipped)" });
    response = { error: 'denied' };
    expect(await editor.discardChromeGroup({ id: 1 })).toBe(false);
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Kebab failed: denied' });
  });

  test('discardAllChromeGroups sums successes and reports partial failure as an error', async () => {
    installChromeMock({
      runtimeHandler: routedHandler({
        ...BASE_ROUTES,
        discardTabs: (m) => (m.groupId === 2 ? { error: 'gone' } : { discarded: 2, skipped: 0 }),
      }),
    });
    const { editor } = buildEditor();
    expect(await editor.discardAllChromeGroups([{ id: 1 }, { id: 2 }, { id: 3 }])).toBe(false);
    expect(toasts().at(-1)).toEqual({
      type: 'error',
      message: 'Kebab All incomplete — 1 group failed: gone',
    });

    expect(await editor.discardAllChromeGroups([{ id: 1 }, { id: 3 }])).toBe(true);
    expect(toasts().at(-1)).toEqual({ type: 'success', message: "Kebab'd 4 tabs (0 skipped)" });
  });

  test('discardAllChromeGroups with every group failing does not refresh', async () => {
    const sent = [];
    installChromeMock({
      runtimeHandler: routedHandler({ ...BASE_ROUTES, discardTabs: { error: 'x' } }, sent),
    });
    const { editor } = buildEditor();
    expect(await editor.discardAllChromeGroups([{ id: 1 }, { id: 2 }])).toBe(false);
    expect(sent.some((m) => m.action === 'getChromeGroups')).toBe(false);
    expect(toasts().at(-1).message).toBe('Kebab All incomplete — 2 groups failed: x');
  });

  test('setAllChromeGroupsCollapsed pluralises and reports failures', async () => {
    installChromeMock({
      runtimeHandler: routedHandler({
        ...BASE_ROUTES,
        setGroupCollapsed: (m) => (m.groupId === 9 ? { error: 'bad' } : { success: true }),
      }),
    });
    const { editor } = buildEditor();
    expect(await editor.setAllChromeGroupsCollapsed([{ id: 1 }], true)).toBe(true);
    expect(toasts().at(-1).message).toBe('Collapsed 1 group');
    expect(await editor.setAllChromeGroupsCollapsed([{ id: 1 }, { id: 2 }], false)).toBe(true);
    expect(toasts().at(-1).message).toBe('Expanded 2 groups');
    expect(await editor.setAllChromeGroupsCollapsed([{ id: 1 }, { id: 9 }], true)).toBe(false);
    expect(toasts().at(-1)).toEqual({
      type: 'error',
      message: 'Collapsed groups incomplete — 1 group failed: bad',
    });
  });

  test('toggleChromeGroupCollapsed flips the stored state only after the worker commits', async () => {
    let fail = true;
    installChromeMock({
      runtimeHandler: routedHandler({
        ...BASE_ROUTES,
        setGroupCollapsed: () => (fail ? { error: 'locked' } : { success: true }),
      }),
    });
    const { editor } = buildEditor();
    const group = { id: 1, collapsed: false };
    expect(await editor.toggleChromeGroupCollapsed(group)).toBe(false);
    expect(group.collapsed).toBe(false);
    expect(toasts().at(-1).message).toBe('Failed to update group: locked');
    fail = false;
    expect(await editor.toggleChromeGroupCollapsed(group)).toBe(true);
    expect(group.collapsed).toBe(true);
  });

  test('keepChromeGroupAwake sends the group scope and reports failure', async () => {
    const sent = [];
    let fail = false;
    installChromeMock({
      runtimeHandler: routedHandler({
        ...BASE_ROUTES,
        setKeepAwake: () => (fail ? { error: 'no' } : { success: true }),
      }, sent),
    });
    const { editor } = buildEditor();
    expect(await editor.keepChromeGroupAwake({ id: 3, title: '' })).toBe(true);
    expect(sent.at(-1)).toEqual({ action: 'setKeepAwake', scope: 'group', groupId: 3, keepAwake: true });
    expect(toasts().at(-1).message).toBe('"Untitled Group" tabs set to keep awake');
    fail = true;
    expect(await editor.keepChromeGroupAwake({ id: 3, title: 'X' })).toBe(false);
  });

  test('stashChromeGroup failure is reported and no Undo toast is shown', async () => {
    installChromeMock({
      runtimeHandler: routedHandler({ ...BASE_ROUTES, stashGroup: { error: 'busy' } }),
    });
    const { editor } = buildEditor();
    expect(await editor.stashChromeGroup({ id: 1, title: 'G' })).toBe(false);
    expect(toasts()).toEqual([{ type: 'error', message: 'Stash failed: busy' }]);
  });
});

describe('Chrome group rendering', () => {
  test('empty list shows an empty state; untitled groups get a styled fallback name', () => {
    installChromeMock();
    const { editor, root } = buildEditor();
    editor.renderChromeGroups([]);
    expect(root.querySelector('#chrome-groups-container').textContent).toBe('No active Chrome tab groups.');

    editor.renderChromeGroups([{ id: 1, title: '', color: 'nope', collapsed: true, tabs: [{ id: 5, url: 'https://x.test/' }] }]);
    const name = root.querySelector('.group-name');
    expect(name.textContent).toBe('Untitled Group');
    expect(name.classList.contains('group-name-untitled')).toBe(true);
    // Unknown colors fall back to blue.
    expect(root.querySelector('.color-dot').style.background).toBe('#1a73e8');
    // A collapsed group offers "Expand in tab strip".
    expect(root.querySelector('.collapse-item').textContent).toBe('Expand in tab strip');
    expect(root.querySelector('.chrome-group-header').getAttribute('aria-label')).toBe('Untitled Group, 1 tab');
  });

  test('header click toggles the body; tab rows focus their tab and report failures', async () => {
    const sent = [];
    installChromeMock({
      runtimeHandler: routedHandler({ ...BASE_ROUTES, focusTab: (m) => (m.tabId === 6 ? { error: 'closed' } : {}) }, sent),
    });
    const { editor, root } = buildEditor();
    editor.renderChromeGroups([{
      id: 1, title: 'G', color: 'red', collapsed: false,
      tabs: [{ id: 5, title: 'Same', url: 'Same' }, { id: 6, title: '', url: '' }],
    }]);
    const header = root.querySelector('.chrome-group-header');
    const body = root.querySelector('.chrome-group-body');
    header.click();
    expect(body.hidden).toBe(true);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.chrome-group-chevron').textContent).toBe('▶');

    const rows = root.querySelectorAll('.chrome-group-tab');
    // Title equal to URL: tooltip is not duplicated; empty tab reads "New Tab".
    expect(rows[0].title).toBe('Same');
    expect(rows[1].title).toBe('New Tab');
    expect(rows[1].getAttribute('aria-label')).toBe('Switch to New Tab');

    keydown(rows[0], 'Enter');
    await flush();
    expect(sent.at(-1)).toEqual({ action: 'focusTab', tabId: 5 });
    rows[1].click();
    await flush();
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Failed to focus tab: closed' });
  });

  test('Sleep all disables while running and the collapse toggle reflects all-collapsed state', async () => {
    let release;
    installChromeMock({
      runtimeHandler: routedHandler({
        ...BASE_ROUTES,
        discardTabs: () => new Promise((resolve) => { release = () => resolve({ discarded: 1, skipped: 0 }); }),
      }),
    });
    const { editor, root } = buildEditor();
    editor.renderChromeGroups([
      { id: 1, title: 'A', collapsed: true, tabs: [] },
      { id: 2, title: 'B', collapsed: true, tabs: [] },
    ]);
    const toggle = root.querySelector('.collapse-toggle-btn');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.title).toBe('Expand all');

    const sleepAll = root.querySelector('.sleep-all-btn');
    sleepAll.click();
    await flush();
    expect(sleepAll.disabled).toBe(true);
    release();
    await flush(4);
    release();
    await flush(30);
    expect(sleepAll.disabled).toBe(false);
  });
});

describe('manual groups', () => {
  const groups = {
    g1: { name: 'Reading', color: 'green', tabUrls: ['https://a.test/', 'https://gone.test/'] },
    g2: { name: 'Empty', color: 'purple', tabUrls: [] },
  };
  const tabs = [
    { id: 1, url: 'https://a.test/', title: 'A' },
    { id: 2, url: 'https://b.test/', title: 'Bee docs' },
    { id: 3, url: 'https://c.test/', title: 'Sea' },
  ];

  test('renders groups with counts, drop zones and the open members only', () => {
    installChromeMock();
    const { editor, root } = buildEditor();
    editor.renderGroups(groups, tabs);
    const cards = root.querySelectorAll('.manual-group');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.group-count').textContent).toBe('2 tabs');
    expect(cards[1].querySelector('.group-count').textContent).toBe('0 tabs');
    expect(cards[0].querySelector('.manual-group-body').dataset.dropzone).toBe('g1');
    expect(cards[0].querySelectorAll('.tab-item').map((el) => el.dataset.tabUrl)).toEqual(['https://a.test/']);
    expect(cards[1].querySelector('.manual-group-body').textContent).toBe('Drag tabs here or search below');
    expect(cards[0].querySelector('.manual-group-header').getAttribute('aria-label')).toBe('Reading, 2 tabs');

    // Header collapses body and add-tab area together.
    cards[0].querySelector('.manual-group-header').click();
    expect(cards[0].querySelector('.manual-group-body').hidden).toBe(true);
    expect(cards[0].querySelector('.group-add-tab').hidden).toBe(true);
  });

  test('empty manual groups and fully grouped tabs show empty states', () => {
    installChromeMock();
    const { editor, root } = buildEditor();
    editor.renderGroups({}, tabs);
    expect(root.querySelector('#manual-groups-container').textContent).toBe('Name a group, then drag tabs into it.');
    editor.renderUngrouped({ g: { tabUrls: tabs.map((t) => t.url) } }, tabs);
    expect(root.querySelector('#ungrouped-tabs').textContent).toBe('All tabs are grouped.');
    editor.renderUngrouped(groups, tabs);
    expect(root.querySelectorAll('#ungrouped-tabs .tab-item').map((el) => String(el.dataset.tabId))).toEqual(['2', '3']);
  });

  // BUG: drive-sync accepts a manual group without `tabUrls` (core/drive-sync.js:237
  // only validates it when present) and the core was hardened for that shape
  // (fix-plan 5.6), but GroupEditor.renderGroups / renderUngrouped still read
  // `group.tabUrls.length` / iterate it unguarded
  // (sidepanel/components/group-editor.js:360, :440; applyToChrome :888), so one such group
  // throws a TypeError and the whole Groups view fails to render.
  test.skip('a legacy manual group without tabUrls renders as empty instead of throwing', () => {
    installChromeMock();
    const { editor } = buildEditor();
    expect(() => editor.renderGroups({ legacy: { name: 'Old', color: 'blue' } }, tabs)).not.toThrow();
    expect(() => editor.renderUngrouped({ legacy: { name: 'Old', color: 'blue' } }, tabs)).not.toThrow();
  });

  test('delete group asks first; cancel keeps it, confirm deletes and reports a vanished group', async () => {
    const sent = [];
    let deleted = true;
    installChromeMock({
      runtimeHandler: routedHandler({ ...BASE_ROUTES, deleteManualGroup: () => ({ deleted }) }, sent),
    });
    const { editor, root } = buildEditor();
    editor.renderGroups(groups, tabs);
    const deleteBtn = root.querySelector('.manual-group-actions .ghost-danger');
    expect(deleteBtn.getAttribute('aria-label')).toBe('Delete group Reading');

    deleteBtn.click();
    confirmButtons().cancel.click();
    await flush();
    expect(sent.some((m) => m.action === 'deleteManualGroup')).toBe(false);

    deleteBtn.click();
    confirmButtons().confirm.click();
    await flush(30);
    expect(sent.find((m) => m.action === 'deleteManualGroup')).toEqual({ action: 'deleteManualGroup', groupId: 'g1' });
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Group "Reading" deleted' });

    deleted = false;
    expect(await editor.deleteGroup('g1', 'Reading')).toBe(false);
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Group was not deleted because it no longer exists' });
  });

  test('applyToChrome groups the open members and handles empty, unmatched and failing cases', async () => {
    const sent = [];
    let manual = groups;
    let createResult = { success: true };
    installChromeMock({
      runtimeHandler: routedHandler({
        ...BASE_ROUTES,
        getManualGroups: () => manual,
        getTabs: tabs,
        createTabGroup: () => createResult,
      }, sent),
    });
    const { editor } = buildEditor();

    await editor.applyToChrome('g1');
    expect(sent.at(-1)).toEqual({ action: 'createTabGroup', tabIds: [1], title: 'Reading', color: 'green' });
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Applied "Reading" to Chrome' });

    await editor.applyToChrome('g2');
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'No tabs in this group' });
    await editor.applyToChrome('missing');
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'No tabs in this group' });

    manual = { g3: { name: 'Closed', color: 'red', tabUrls: ['https://closed.test/'] } };
    await editor.applyToChrome('g3');
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'No matching open tabs found' });

    manual = groups;
    createResult = { error: 'no window' };
    await editor.applyToChrome('g1');
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Failed to apply group: no window' });
  });

  test('createGroup validates the name, sends the chosen color, and clears the input', async () => {
    const sent = [];
    installChromeMock({ runtimeHandler: routedHandler({ ...BASE_ROUTES, createManualGroup: { success: true } }, sent) });
    const { editor, root } = buildEditor();
    const input = root.querySelector('#new-group-name');

    input.value = '   ';
    expect(await editor.createGroup()).toBe(false);
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Enter a group name' });
    expect(dom.document.activeElement).toBe(input);

    input.value = ' Research ';
    keydown(input, 'Enter');
    await flush(30);
    expect(sent.find((m) => m.action === 'createManualGroup')).toEqual({ action: 'createManualGroup', name: 'Research', color: 'red' });
    expect(input.value).toBe('');
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Group "Research" created' });
  });

  test('createGroup failure keeps the typed name', async () => {
    installChromeMock({ runtimeHandler: routedHandler({ ...BASE_ROUTES, createManualGroup: { error: 'dup' } }) });
    const { editor, root } = buildEditor();
    root.querySelector('#new-group-name').value = 'X';
    expect(await editor.createGroup()).toBe(false);
    expect(root.querySelector('#new-group-name').value).toBe('X');
    expect(toasts().at(-1).message).toBe('Failed to create group: dup');
  });
});

describe('add-tab area', () => {
  test('isLikelyUrl recognises schemes and bare domains, not plain words', () => {
    installChromeMock();
    const { editor } = buildEditor();
    expect(editor.isLikelyUrl('https://x.test')).toBe(true);
    expect(editor.isLikelyUrl('chrome://settings')).toBe(true);
    expect(editor.isLikelyUrl('chrome-extension://abc/page.html')).toBe(true);
    expect(editor.isLikelyUrl('example.com/path')).toBe(true);
    expect(editor.isLikelyUrl('docs')).toBe(false);
    expect(editor.isLikelyUrl('two words.com')).toBe(false);
  });

  test('a bare domain becomes an https URL result; an existing URL reports "already in group"', () => {
    installChromeMock();
    const { editor } = buildEditor();
    editor.allTabs = [];
    const results = dom.document.createElement('div');
    const group = { name: 'G', tabUrls: ['https://in.test'] };

    editor.renderAddTabResults('example.com', 'g', group, results, null);
    expect(results.querySelector('.url-result .group-add-tab-result-label').textContent).toBe('https://example.com');
    expect(results.querySelector('.group-add-tab-btn').getAttribute('aria-label')).toBe('Add https://example.com to group');

    editor.renderAddTabResults('https://in.test', 'g', group, results, null);
    expect(results.textContent).toBe('URL already in group');

    editor.renderAddTabResults('', 'g', group, results, null);
    expect(results.children).toHaveLength(0);
  });

  test('tab search matches title or URL, skips members, caps at 8, and adds on click', async () => {
    const sent = [];
    installChromeMock({ runtimeHandler: routedHandler({ ...BASE_ROUTES, moveTabToManualGroup: {} }, sent) });
    const { editor } = buildEditor();
    editor.allTabs = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: i, title: `Doc ${i}`, url: `https://d${i}.test/` })),
      { id: 50, title: 'Other', url: 'https://docs-site.test/' },
    ];
    const results = dom.document.createElement('div');
    const group = { name: 'G', tabUrls: ['https://d0.test/'] };

    editor.renderAddTabResults('doc', 'g', group, results, null);
    const items = results.querySelectorAll('.group-add-tab-result');
    expect(items).toHaveLength(8);
    expect(items[0].querySelector('.group-add-tab-result-label').textContent).toBe('Doc 1');

    editor.renderAddTabResults('zzz', 'g', group, results, null);
    expect(results.textContent).toBe('No matching tabs found');

    editor.renderAddTabResults('Other', 'g', group, results, null);
    results.querySelector('.group-add-tab-btn').click();
    await flush(30);
    expect(sent.find((m) => m.action === 'moveTabToManualGroup'))
      .toEqual({ action: 'moveTabToManualGroup', tabUrl: 'https://docs-site.test/', targetGroupId: 'g' });
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Tab added to group' });
  });

  test('addTabToGroup failure is reported without a refresh', async () => {
    const sent = [];
    installChromeMock({ runtimeHandler: routedHandler({ ...BASE_ROUTES, moveTabToManualGroup: { error: 'gone' } }, sent) });
    const { editor } = buildEditor();
    expect(await editor.addTabToGroup('https://x.test/', 'g', 'ok')).toBe(false);
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Failed to add tab to group: gone' });
    expect(sent.some((m) => m.action === 'getChromeGroups')).toBe(false);
  });

  test('Escape clears the input and results', () => {
    installChromeMock();
    const { editor } = buildEditor();
    const area = editor.createAddTabArea('g', { name: 'G', tabUrls: [] });
    const input = area.querySelector('input');
    const results = area.querySelector('.group-add-tab-results');
    expect(input.getAttribute('aria-label')).toBe('Add a tab to G');
    input.value = 'abc';
    results.appendChild(dom.document.createElement('div'));
    const event = keydown(input, 'Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('');
    expect(results.children).toHaveLength(0);
  });
});

describe('drag and drop', () => {
  function dragEvent(type, target, data = {}) {
    const store = { ...data };
    const event = createEvent(type);
    event.dataTransfer = {
      setData(kind, value) { store[kind] = value; },
      getData(kind) { return store[kind] ?? ''; },
      effectAllowed: null,
      dropEffect: null,
    };
    event.relatedTarget = null;
    target.dispatchEvent(event);
    return event;
  }

  test('drag start marks the item, dragover highlights the zone, drop moves the tab', async () => {
    const sent = [];
    installChromeMock({ runtimeHandler: routedHandler({ ...BASE_ROUTES, moveTabToManualGroup: {} }, sent) });
    const { editor, root } = buildEditor();
    editor.renderGroups({ g1: { name: 'G', color: 'blue', tabUrls: [] } }, []);
    editor.renderUngrouped({}, [{ id: 7, url: 'https://drag.test/', title: 'Drag me' }]);
    const item = root.querySelector('#ungrouped-tabs .tab-item');
    item.setAttribute('draggable', 'true');
    const zone = root.querySelector('[data-dropzone]');

    const start = dragEvent('dragstart', item);
    expect(start.dataTransfer.getData('text/plain')).toBe('https://drag.test/');
    expect(item.classList.contains('dragging')).toBe(true);

    const over = dragEvent('dragover', zone);
    expect(over.defaultPrevented).toBe(true);
    expect(zone.classList.contains('drop-target')).toBe(true);

    dragEvent('dragleave', zone);
    expect(zone.classList.contains('drop-target')).toBe(false);

    dragEvent('dragover', zone);
    dragEvent('dragend', item);
    expect(item.classList.contains('dragging')).toBe(false);
    expect(zone.classList.contains('drop-target')).toBe(false);

    dragEvent('dragover', zone);
    dragEvent('drop', zone, { 'text/plain': 'https://drag.test/' });
    await flush(30);
    expect(zone.classList.contains('drop-target')).toBe(false);
    expect(sent.find((m) => m.action === 'moveTabToManualGroup'))
      .toEqual({ action: 'moveTabToManualGroup', tabUrl: 'https://drag.test/', targetGroupId: 'g1' });
  });

  test('a drop without data or outside a zone sends nothing', async () => {
    const sent = [];
    installChromeMock({ runtimeHandler: routedHandler({ ...BASE_ROUTES, moveTabToManualGroup: {} }, sent) });
    const { editor, root } = buildEditor();
    editor.renderGroups({ g1: { name: 'G', color: 'blue', tabUrls: [] } }, []);
    dragEvent('drop', root.querySelector('[data-dropzone]'));
    dragEvent('drop', root.querySelector('#ungrouped-tabs'), { 'text/plain': 'https://x.test/' });
    await flush();
    expect(sent.some((m) => m.action === 'moveTabToManualGroup')).toBe(false);
  });

  test('moveDroppedTab reports a failed move', async () => {
    installChromeMock({ runtimeHandler: routedHandler({ ...BASE_ROUTES, moveTabToManualGroup: { error: 'stale' } }) });
    const { editor } = buildEditor();
    expect(await editor.moveDroppedTab('u', 'g')).toBe(false);
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Failed to move tab: stale' });
  });
});

describe('refresh', () => {
  test('renders all three sections from worker data and tolerates null responses', async () => {
    installChromeMock({
      runtimeHandler: routedHandler({ getChromeGroups: null, getManualGroups: null, getTabs: [{ id: 1, url: 'https://a.test/', title: 'A' }] }),
    });
    const { editor, root } = buildEditor();
    await editor.refresh();
    expect(root.querySelector('#chrome-groups-container').textContent).toBe('No active Chrome tab groups.');
    expect(root.querySelector('#manual-groups-container').textContent).toBe('Name a group, then drag tabs into it.');
    expect(root.querySelectorAll('#ungrouped-tabs .tab-item')).toHaveLength(1);
  });
});
