// PR coverage: Windows view (sidepanel/components/window-list.js) — collapse
// toggle state, default collapse, threshold badges, consolidation progress and
// committed-vs-refresh messaging.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { installFakeDom, keydown } from '../helpers/fake-dom.js';

import { WindowList } from '../../sidepanel/components/window-list.js';

let dom;
let toastContainer;
let originalWarn;

beforeEach(() => {
  dom = installFakeDom();
  toastContainer = dom.el('div', { id: 'toast-container' });
  originalWarn = console.warn;
  console.warn = () => {};
});

afterEach(() => {
  console.warn = originalWarn;
  dom.restore();
});

function toasts() {
  return toastContainer.children.map((toast) => ({
    type: toast.className.replace(/^toast\s+/, '').split(' ')[0],
    message: toast.children[0]?.textContent,
  }));
}

async function flush(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function routedHandler(routes, sent = []) {
  return async (message) => {
    sent.push(message);
    const route = routes[message.action];
    if (typeof route === 'function') return route(message);
    return route;
  };
}

function buildWindowList() {
  const root = dom.el('div');
  for (const id of ['window-list', 'consolidation-progress', 'consolidation-phase', 'consolidation-title', 'consolidation-detail', 'consolidation-fill']) {
    dom.el('div', { id, parent: root });
  }
  dom.el('button', { id: 'btn-consolidate-windows', parent: root });
  dom.el('button', { id: 'btn-toggle-collapse-windows', parent: root });
  return { root, list: new WindowList(root) };
}

function tab(id, title = `Tab ${id}`) {
  return { id, title, url: `https://t${id}.test/` };
}

const WINDOWS = [
  {
    windowId: 1,
    windowNumber: 1,
    focused: true,
    tabCount: 3,
    groups: [{ groupId: 10, title: '', color: 'nope', tabCount: 1, tabs: [tab(1)] }],
    ungroupedCount: 2,
    ungroupedTabs: [tab(2), tab(3, '')],
  },
  {
    windowId: 2,
    windowNumber: 2,
    focused: false,
    tabCount: 1,
    groups: [],
    ungroupedCount: 1,
    ungroupedTabs: [tab(4)],
  },
];

describe('collapse state', () => {
  test('first render collapses everything except the focused window card', () => {
    installChromeMock();
    const { list, root } = buildWindowList();
    list.renderWindows(WINDOWS);
    expect([...list.collapsed].sort()).toEqual([
      'wg-1-10', 'wg-1-ungrouped', 'wg-2-ungrouped', 'window-2',
    ]);
    const toggle = root.querySelector('#btn-toggle-collapse-windows');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    // A later render keeps the user's state instead of re-applying the default.
    list.collapsed.delete('window-2');
    list.renderWindows(WINDOWS);
    expect(list.collapsed.has('window-2')).toBe(false);
  });

  test('the toolbar toggle collapses and expands every key and stays in sync', async () => {
    installChromeMock();
    const { list, root } = buildWindowList();
    list.renderWindows(WINDOWS);
    const toggle = root.querySelector('#btn-toggle-collapse-windows');

    toggle.click();
    await flush();
    expect(list.isAllCollapsed()).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.title).toBe('Expand all');

    toggle.click();
    await flush();
    expect(list.collapsed.size).toBe(0);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  test('collapse/expand with no windows is a no-op and the empty state reads plainly', () => {
    installChromeMock();
    const { list, root } = buildWindowList();
    list.renderWindows([]);
    expect(root.querySelector('#window-list').textContent).toBe('No windows found.');
    expect(list.isAllCollapsed()).toBe(false);
    list.collapseAll();
    list.expandAll();
    expect(list.collapsed.size).toBe(0);
  });

  test('ungrouped section header toggles with the keyboard and updates aria-expanded', () => {
    installChromeMock();
    const { list } = buildWindowList();
    list.collapsed.clear();
    list.initialized = true;
    list.renderWindows(WINDOWS);
    const section = list.listEl.querySelectorAll('[aria-label]')
      .find((el) => el.getAttribute('aria-label') === 'Ungrouped, 2 tabs');
    expect(section.getAttribute('aria-expanded')).toBe('true');
    keydown(section, 'Enter');
    expect(list.collapsed.has('wg-1-ungrouped')).toBe(true);
    expect(section.getAttribute('aria-expanded')).toBe('false');
    keydown(section, ' ');
    expect(list.collapsed.has('wg-1-ungrouped')).toBe(false);
  });
});

describe('cards', () => {
  test('threshold badges: plain count, recommended (yellow) and limit (red)', () => {
    installChromeMock();
    const { list } = buildWindowList();
    list.maxTabs = 10;
    list.recommendedTabs = 5;
    const card = (tabCount) => list.createWindowCard({ ...WINDOWS[1], tabCount });

    let c = card(4);
    expect(c.querySelector('.window-status-dot').className).toContain('status-green');
    expect(c.querySelector('.window-card-header .count').title).toBe('4 tabs');
    c = card(5);
    expect(c.querySelector('.warning-yellow').title).toBe('Exceeds recommended 5 tabs per window');
    expect(c.querySelector('.window-status-dot').className).toContain('status-yellow');
    c = card(10);
    expect(c.querySelector('.warning-red').title).toBe('Exceeds limit of 10 tabs per window');
    expect(c.querySelector('.window-card-header .count')).toBeNull();
    c = card(1);
    expect(c.querySelector('.window-card-header .count').title).toBe('1 tab');
  });

  test('tab rows fall back to URL and "New Tab" and report focus failures', async () => {
    installChromeMock({ runtimeHandler: routedHandler({ focusTab: { error: 'gone' } }) });
    const { list } = buildWindowList();
    const item = list.createTabItem({ id: 9, title: '', url: '' });
    expect(item.title).toBe('New Tab');
    expect(item.getAttribute('aria-label')).toBe('Switch to New Tab');
    item.click();
    await flush();
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Failed to focus tab: gone' });
    expect(list.createTabItem({ id: 1, title: 'T', url: 'https://u/' }).title).toBe('T\nhttps://u/');
  });
});

describe('refresh', () => {
  test('settings failure keeps default thresholds; settings values are applied when present', async () => {
    let settings = { error: 'nope' };
    installChromeMock({
      runtimeHandler: routedHandler({ getSettings: () => settings, getWindowStats: { windows: [] } }),
    });
    const { list } = buildWindowList();
    await list.refresh();
    expect(list.maxTabs).toBe(50);
    expect(list.recommendedTabs).toBe(20);

    settings = { maxTabsPerWindow: 12, recommendedTabsPerWindow: 0 };
    await list.refresh();
    expect(list.maxTabs).toBe(12);
    expect(list.recommendedTabs).toBe(20);
  });
});

describe('consolidation', () => {
  test('progress phases map to labels and executor shows a determinate bar', () => {
    installChromeMock();
    const { list, root } = buildWindowList();
    list.showProgress();
    expect(root.querySelector('#consolidation-progress').classList.contains('active')).toBe(true);
    list.updateProgress('planner', 'Planning moves');
    expect(root.querySelector('#consolidation-phase').textContent).toBe('Phase 3/4');
    expect(root.querySelector('#consolidation-title').textContent).toBe('Planning');
    expect(root.querySelector('#consolidation-fill').classList.contains('indeterminate')).toBe(true);
    list.updateProgress('executor');
    expect(root.querySelector('#consolidation-fill').style.width).toBe('75%');
    expect(root.querySelector('#consolidation-detail').textContent).toBe('');
    list.updateProgress('mystery', 'x');
    expect(root.querySelector('#consolidation-phase').textContent).toBe('Phase 1/4');
    expect(root.querySelector('#consolidation-title').textContent).toBe('mystery');
  });

  test('worker progress broadcasts drive the progress UI', async () => {
    installChromeMock();
    const { root } = buildWindowList();
    await chrome.runtime.onMessage.dispatch({ type: 'consolidationProgress', phase: 'solver', detail: 'd' });
    expect(root.querySelector('#consolidation-title').textContent).toBe('Computing');
  });

  test('summary lists only non-zero parts; a no-op says so without a toast', async () => {
    let result = { tabsMoved: 4, windowsConsolidated: 2, windowsClosed: 1 };
    installChromeMock({
      runtimeHandler: routedHandler({ consolidateWindows: () => result, getSettings: {}, getWindowStats: { windows: [] } }),
    });
    const { list, root } = buildWindowList();
    await list.consolidate();
    expect(root.querySelector('#consolidation-title').textContent)
      .toBe('2 window(s) consolidated, 4 tabs moved, 1 window(s) closed');
    expect(root.querySelector('#consolidation-phase').textContent).toBe('DONE');
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Windows consolidated' });
    expect(list.consolidateBtn.disabled).toBe(false);

    result = { tabsMoved: 0, windowsConsolidated: 0 };
    await list.consolidate();
    expect(root.querySelector('#consolidation-title').textContent).toBe('No under-utilized windows to consolidate');
    expect(toasts()).toHaveLength(1);

    result = { tabsMoved: 0, windowsConsolidated: 0, windowsClosed: 0, groupsMoved: 3 };
    result.tabsMoved = undefined;
    await list.consolidate();
    expect(root.querySelector('#consolidation-title').textContent).toBe('Done');
  });

  test('a committed consolidation whose refresh fails says so; a failed one reports the error', async () => {
    let routes = { consolidateWindows: { tabsMoved: 1 }, getSettings: {}, getWindowStats: null };
    installChromeMock({ runtimeHandler: (m) => routedHandler(routes)(m) });
    const { list, root } = buildWindowList();
    await list.consolidate();
    expect(toasts().at(-1)).toEqual({
      type: 'error',
      message: 'Windows were consolidated, but the view could not refresh: No window data received from background',
    });
    expect(root.querySelector('#consolidation-progress').classList.contains('active')).toBe(false);

    routes = { consolidateWindows: { error: 'busy' } };
    await list.consolidate();
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Failed to consolidate windows: busy' });
    expect(list.consolidateBtn.disabled).toBe(false);
  });
});
