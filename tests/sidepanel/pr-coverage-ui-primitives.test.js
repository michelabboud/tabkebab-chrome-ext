// PR coverage: shared side-panel primitives added or reworked in 1.3.0 —
// keyboard-activate menus, focus traps, panel helpers, toast durations and
// the command bar's find / confirmation flows.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { createEvent, installFakeDom, keydown } from '../helpers/fake-dom.js';

import {
  createOverflowMenu,
  makeKeyboardActivatable,
  setExpanded,
  wireCollapseToggle,
  wireMenuButton,
} from '../../sidepanel/components/keyboard-activate.js';
import { createFocusTrap, isModalOpen } from '../../sidepanel/components/confirm-dialog.js';
import {
  createDebounced,
  createDeferrableRefresh,
  formatStatsStrip,
  isEditingElement,
  isPlainShortcutAllowed,
  nextRovingIndex,
  prefersReducedMotion,
  resolveTabsChangedRefreshKey,
  scrollIntoContainer,
  selectTab,
  shouldShowStatsStrip,
} from '../../sidepanel/panel-helpers.js';
import { resolveToastDuration, showToast } from '../../sidepanel/components/toast.js';
import { CommandBar } from '../../sidepanel/components/command-bar.js';

let dom;
let toastContainer;

beforeEach(() => {
  dom = installFakeDom();
  toastContainer = dom.el('div', { id: 'toast-container' });
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

function withWindow(win, run) {
  const had = Object.hasOwn(globalThis, 'window');
  const previous = globalThis.window;
  globalThis.window = win;
  try {
    return run();
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }
}

// ── makeKeyboardActivatable ──

describe('makeKeyboardActivatable', () => {
  test('native buttons are returned untouched', () => {
    const btn = dom.el('button');
    expect(makeKeyboardActivatable(btn, { label: 'x' })).toBe(btn);
    expect(btn.getAttribute('role')).toBeNull();
    expect(btn.getAttribute('aria-label')).toBeNull();
  });

  test('Enter, Space and legacy Spacebar activate; other keys and nested targets do not', () => {
    const row = dom.el('div');
    const nested = dom.el('button', { parent: row });
    let clicks = 0;
    row.addEventListener('click', () => { clicks += 1; });
    makeKeyboardActivatable(row, { label: 'Row', expanded: false });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.getAttribute('aria-label')).toBe('Row');

    expect(keydown(row, 'Enter').defaultPrevented).toBe(true);
    keydown(row, ' ');
    keydown(row, 'Spacebar');
    expect(clicks).toBe(3);
    expect(keydown(row, 'a').defaultPrevented).toBe(false);
    // Keys on a nested control bubble up but must not activate the row.
    keydown(nested, 'Enter');
    expect(clicks).toBe(3);

    setExpanded(row, 1);
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });
});

// ── Menus ──

describe('wireMenuButton / createOverflowMenu', () => {
  function buildMenu(items) {
    const host = dom.el('div');
    const menu = createOverflowMenu({ label: 'More', items });
    host.appendChild(menu.wrapper);
    return menu;
  }

  test('disabled and hidden items are skipped; arrows wrap; Home/End jump', () => {
    const menu = buildMenu([
      { label: 'One' },
      { label: 'Hidden', hidden: true },
      { label: 'Two' },
      { label: 'Three' },
    ]);
    menu.items[2].disabled = true; // "Two"
    menu.open();
    const doc = dom.document;
    expect(doc.activeElement).toBe(menu.items[0]);
    keydown(menu.items[0], 'ArrowUp');
    expect(doc.activeElement).toBe(menu.items[3]);
    keydown(menu.items[3], 'ArrowDown');
    expect(doc.activeElement).toBe(menu.items[0]);
    keydown(menu.items[0], 'End');
    expect(doc.activeElement).toBe(menu.items[3]);
    keydown(menu.items[3], 'Home');
    expect(doc.activeElement).toBe(menu.items[0]);
    expect(menu.items[1].hidden).toBe(true);
  });

  test('Tab closes without stealing focus back; Enter and letters are swallowed', () => {
    const menu = buildMenu([{ label: 'A' }, { label: 'B' }]);
    let bubbled = 0;
    dom.document.body.addEventListener('keydown', () => { bubbled += 1; });
    menu.open();
    const enter = keydown(menu.items[0], 'Enter');
    expect(enter.defaultPrevented).toBe(false);
    keydown(menu.items[0], 'f');
    expect(bubbled).toBe(0);
    expect(menu.isOpen()).toBe(true);

    keydown(menu.items[0], 'Tab');
    expect(menu.isOpen()).toBe(false);
    expect(menu.button.getAttribute('aria-expanded')).toBe('false');
    expect(dom.document.activeElement).toBe(menu.items[0]);
  });

  test('Escape on the button closes an open menu and returns focus; button click toggles', () => {
    const menu = buildMenu([{ label: 'A' }]);
    menu.button.click();
    expect(menu.isOpen()).toBe(true);
    expect(menu.wrapper.classList.contains('menu-open')).toBe(true);
    const esc = keydown(menu.button, 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(menu.isOpen()).toBe(false);
    expect(dom.document.activeElement).toBe(menu.button);
    // Escape on a closed menu is left alone.
    expect(keydown(menu.button, 'Escape').defaultPrevented).toBe(false);

    menu.button.click();
    menu.button.click();
    expect(menu.isOpen()).toBe(false);
  });

  test('a scroll outside the menu closes it; a scroll inside does not', () => {
    const menu = buildMenu([{ label: 'A' }]);
    menu.open();
    menu.menu.dispatchEvent(createEvent('scroll'));
    expect(menu.isOpen()).toBe(true);
    dom.el('div').dispatchEvent(createEvent('scroll'));
    expect(menu.isOpen()).toBe(false);
  });

  test('a click on a disabled item does not close the menu', () => {
    const menu = buildMenu([{ label: 'A' }, { label: 'B' }]);
    menu.items[1].disabled = true;
    menu.open();
    menu.items[1].dispatchEvent(createEvent('click'));
    expect(menu.isOpen()).toBe(true);
  });

  test('checkbox items expose aria-checked; separators appear only between benign and danger items', () => {
    let menu = buildMenu([{ label: 'Pin', checked: 1 }, { label: 'Off', checked: false, title: 'tip' }]);
    expect(menu.items[0].getAttribute('role')).toBe('menuitemcheckbox');
    expect(menu.items[0].getAttribute('aria-checked')).toBe('true');
    expect(menu.items[1].getAttribute('aria-checked')).toBe('false');
    expect(menu.items[1].title).toBe('tip');
    expect(menu.menu.querySelector('.row-menu-separator')).toBeNull();

    menu = buildMenu([{ label: 'Close', danger: true }]);
    expect(menu.menu.querySelector('.row-menu-separator')).toBeNull();
    expect(menu.items[0].className).toBe('row-menu-item danger');
  });

  test('wireMenuButton links aria-controls when the menu has an id', () => {
    const button = dom.el('button');
    const menu = dom.el('div', { id: 'm1' });
    const item = dom.el('button', { parent: menu });
    item.setAttribute('role', 'menuitem');
    const api = wireMenuButton(button, menu);
    expect(button.getAttribute('aria-controls')).toBe('m1');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(item.getAttribute('tabindex')).toBe('-1');
    api.open({ focus: 'last' });
    expect(dom.document.activeElement).toBe(item);
    api.close({ restoreFocus: true });
    expect(dom.document.activeElement).toBe(button);
  });

  test('opening another menu closes the first', () => {
    const a = buildMenu([{ label: 'A' }]);
    const b = buildMenu([{ label: 'B' }]);
    a.open();
    b.open();
    expect(a.isOpen()).toBe(false);
    expect(b.isOpen()).toBe(true);
    b.close();
  });

  describe('fixed positioning', () => {
    function rect(r) { return () => ({ left: 0, right: 0, top: 0, bottom: 0, ...r }); }
    const win = { innerWidth: 400, innerHeight: 600, addEventListener() {}, removeEventListener() {} };

    test('right-aligned menus anchor to the wrapper and open below when there is room', () => {
      const menu = buildMenu([{ label: 'A' }]);
      menu.wrapper.getBoundingClientRect = rect({ left: 300, right: 380, top: 100, bottom: 120 });
      menu.menu.offsetHeight = 50;
      withWindow(win, () => menu.open());
      expect(menu.menu.style.position).toBe('fixed');
      expect(menu.menu.style.left).toBe('auto');
      expect(menu.menu.style.right).toBe('20px');
      expect(menu.menu.style.top).toBe('124px');
      withWindow(win, () => menu.close());
    });

    test('a menu that would overflow the bottom flips above the anchor', () => {
      const menu = buildMenu([{ label: 'A' }]);
      menu.wrapper.getBoundingClientRect = rect({ left: 10, right: 50, top: 560, bottom: 580 });
      menu.menu.offsetHeight = 100;
      withWindow(win, () => menu.open());
      expect(menu.menu.style.top).toBe('456px');
      withWindow(win, () => menu.close());
    });

    test('a right-aligned menu running off the left edge is pinned to 8px', () => {
      const menu = buildMenu([{ label: 'A' }]);
      menu.wrapper.getBoundingClientRect = rect({ left: 2, right: 20, top: 10, bottom: 20 });
      menu.menu.getBoundingClientRect = rect({ left: -40 });
      withWindow(win, () => menu.open());
      expect(menu.menu.style.right).toBe('auto');
      expect(menu.menu.style.left).toBe('8px');
      withWindow(win, () => menu.close());
    });

    test('start-aligned menus use the anchor left edge, never closer than 8px', () => {
      const menu = buildMenu([{ label: 'A' }]);
      menu.menu.dataset.align = 'start';
      menu.wrapper.getBoundingClientRect = rect({ left: 3, right: 30, top: 10, bottom: 20 });
      withWindow(win, () => menu.open());
      expect(menu.menu.style.right).toBe('auto');
      expect(menu.menu.style.left).toBe('8px');
      withWindow(win, () => menu.close());
    });
  });
});

describe('wireCollapseToggle', () => {
  test('a missing button yields a harmless sync()', () => {
    const api = wireCollapseToggle(null, { isAllCollapsed: () => true, onToggle() {} });
    expect(() => api.sync()).not.toThrow();
  });

  test('click toggles to the opposite of the current state and resyncs', async () => {
    let collapsed = false;
    const calls = [];
    const btn = dom.el('button');
    wireCollapseToggle(btn, {
      isAllCollapsed: () => collapsed,
      onToggle: async (collapse) => { calls.push(collapse); collapsed = collapse; },
    });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Collapse all');
    btn.click();
    await flush();
    expect(calls).toEqual([true]);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('is-collapsed')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Collapse all');
  });
});

// ── Focus trap ──

describe('createFocusTrap', () => {
  test('Tab in a container with nothing focusable is swallowed without throwing', () => {
    const dialog = dom.el('div');
    const trap = createFocusTrap(dialog);
    expect(isModalOpen()).toBe(true);
    const event = keydown(dialog, 'Tab');
    expect(event.defaultPrevented).toBe(true);
    trap.release();
    expect(isModalOpen()).toBe(false);
  });

  test('skips disabled, hidden and tabindex=-1 controls; Shift+Tab from the first wraps to the last', () => {
    const dialog = dom.el('div');
    const first = dom.el('button', { parent: dialog });
    const disabled = dom.el('button', { parent: dialog });
    disabled.disabled = true;
    const hidden = dom.el('input', { parent: dialog });
    hidden.hidden = true;
    const skipped = dom.el('div', { parent: dialog });
    skipped.setAttribute('tabindex', '-1');
    const last = dom.el('div', { parent: dialog });
    last.setAttribute('tabindex', '0');

    const trap = createFocusTrap(dialog);
    expect(dom.document.activeElement).toBe(first);
    keydown(first, 'Tab', { shiftKey: true });
    expect(dom.document.activeElement).toBe(last);
    keydown(last, 'Tab');
    expect(dom.document.activeElement).toBe(first);
    trap.release();
  });

  test('focus escaping the container is pulled back; release is idempotent and can skip focus restore', () => {
    const opener = dom.el('button');
    opener.focus();
    const dialog = dom.el('div');
    const inner = dom.el('button', { parent: dialog });
    const outside = dom.el('button');
    const trap = createFocusTrap(dialog);
    expect(dom.document.activeElement).toBe(inner);

    outside.focus();
    outside.dispatchEvent(createEvent('focusin'));
    expect(dom.document.activeElement).toBe(inner);

    trap.release({ restoreFocus: false });
    expect(dom.document.activeElement).toBe(inner);
    trap.release();
    expect(isModalOpen()).toBe(false);
    // After release, keys no longer reach the trap.
    let closed = 0;
    const second = createFocusTrap(dialog, { onClose: () => { closed += 1; } });
    second.release();
    keydown(inner, 'Escape');
    expect(closed).toBe(0);
  });

  test('focus is not restored to a detached opener', () => {
    const opener = dom.el('button');
    opener.focus();
    const dialog = dom.el('div');
    const inner = dom.el('button', { parent: dialog });
    const trap = createFocusTrap(dialog);
    opener.remove();
    trap.release();
    expect(dom.document.activeElement).toBe(inner);
  });
});

// ── Panel helpers ──

describe('panel helpers', () => {
  test('createDebounced: flush with nothing pending is a no-op; cancel drops the call', () => {
    let runs = 0;
    const timers = [];
    const debounced = createDebounced(() => { runs += 1; }, 100, {
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => {},
    });
    debounced.flush();
    expect(runs).toBe(0);
    debounced();
    debounced.cancel();
    debounced.flush();
    expect(runs).toBe(0);
    debounced();
    debounced.flush();
    expect(runs).toBe(1);
    debounced.flush();
    expect(runs).toBe(1);
  });

  test('createDeferrableRefresh: resume without a pending request does nothing; busy keeps it pending', () => {
    let busy = false;
    let runs = 0;
    const refresh = createDeferrableRefresh(() => { runs += 1; }, { isBusy: () => busy });
    refresh.resume();
    expect(runs).toBe(0);
    busy = true;
    refresh();
    refresh.resume();
    expect(refresh.isPending()).toBe(true);
    expect(runs).toBe(0);
    busy = false;
    refresh.resume();
    expect(runs).toBe(1);
    expect(refresh.isPending()).toBe(false);
  });

  test('isPlainShortcutAllowed rejects null events, claimed events, selects and contenteditable', () => {
    expect(isPlainShortcutAllowed(null)).toBe(false);
    expect(isPlainShortcutAllowed({ defaultPrevented: true })).toBe(false);
    expect(isPlainShortcutAllowed({ altKey: true })).toBe(false);
    expect(isPlainShortcutAllowed({ target: { tagName: 'SELECT' } })).toBe(false);
    expect(isPlainShortcutAllowed({ target: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
    expect(isPlainShortcutAllowed({ target: { tagName: 'DIV' } }, { dialogOpen: true })).toBe(false);
    expect(isPlainShortcutAllowed({ target: { tagName: 'DIV' } })).toBe(true);
    expect(isEditingElement(null)).toBe(false);
    expect(isEditingElement({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  test('refresh key and stats-strip visibility for every view', () => {
    expect(resolveTabsChangedRefreshKey({ visibleView: 'tabs' })).toBe('tabs');
    expect(resolveTabsChangedRefreshKey({ visibleView: 'tabs', activeSubtab: 'unknown' })).toBe('tabs');
    expect(resolveTabsChangedRefreshKey({ visibleView: 'tabs', activeSubtab: 'duplicates' })).toBe('duplicates');
    expect(resolveTabsChangedRefreshKey({ visibleView: 'stash' })).toBeNull();
    expect(shouldShowStatsStrip('tabs')).toBe(true);
    expect(shouldShowStatsStrip('focus')).toBe(false);
  });

  test('nextRovingIndex handles an empty list, a missing current index and unknown keys', () => {
    expect(nextRovingIndex('ArrowRight', 0, 0)).toBe(-1);
    expect(nextRovingIndex('ArrowDown', -1, 3)).toBe(1);
    expect(nextRovingIndex('ArrowUp', -1, 3)).toBe(2);
    expect(nextRovingIndex('Enter', 1, 3)).toBe(-1);
  });

  test('selectTab with no selection keeps the existing tab stop', () => {
    const tabs = [dom.el('button'), dom.el('button'), dom.el('button')];
    selectTab(tabs, tabs[1]);
    selectTab(tabs, null);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(tabs.every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
  });

  test('formatStatsStrip prefers discardedTabs, never goes negative, and singularises', () => {
    expect(formatStatsStrip({ totalWindows: 1, totalTabs: 1, discardedTabs: 1 })).toBe('1 window · 1 tab · 1 sleeping');
    expect(formatStatsStrip({ totalWindows: 2, totalTabs: 3, activeTabs: 9 })).toBe('2 windows · 3 tabs · 0 sleeping');
    expect(formatStatsStrip({ totalWindows: 'x', totalTabs: null })).toBe('0 windows · 0 tabs · 0 sleeping');
  });

  test('prefersReducedMotion survives a throwing matchMedia; scrollIntoContainer tolerates missing pieces', () => {
    expect(prefersReducedMotion({ matchMedia() { throw new Error('nope'); } })).toBe(false);
    expect(prefersReducedMotion(null)).toBe(false);
    expect(() => scrollIntoContainer(null)).not.toThrow();

    const calls = [];
    const el = dom.el('div');
    el.scrollIntoView = (opts) => calls.push(opts);
    // align:start without a container falls back to the nearest-scroll path.
    scrollIntoContainer(el, { align: 'start', win: {} });
    expect(calls).toEqual([{ behavior: 'smooth', block: 'nearest', inline: 'nearest' }]);
  });
});

// ── Toasts ──

describe('toast duration edge cases', () => {
  test('non-positive and non-finite durations fall back to the type default', () => {
    expect(resolveToastDuration({ duration: 0 })).toBe(3500);
    expect(resolveToastDuration({ duration: -5, type: 'error' })).toBe(6000);
    expect(resolveToastDuration({ duration: Infinity })).toBe(3500);
    expect(resolveToastDuration({ duration: 2000, hasAction: true })).toBe(6000);
    expect(resolveToastDuration({ duration: 12000, hasAction: true })).toBe(12000);
    expect(resolveToastDuration()).toBe(3500);
  });

  test('an action without a callback is ignored; a throwing action still dismisses', () => {
    showToast('plain', 'info', undefined, { label: 'Undo' });
    expect(toastContainer.children[0].querySelector('.toast-action')).toBeNull();
    expect(toastContainer.children[0].dataset.duration).toBe('3500');

    const handle = showToast('act', { action: { label: 'Go', callback() { throw new Error('x'); } } });
    const btn = handle.element?.querySelector?.('.toast-action') ?? toastContainer.children[1].querySelector('.toast-action');
    expect(() => btn.click()).not.toThrow();
    expect(toastContainer.children[1].style.opacity).toBe('0');
  });

  test('without a container no toast is created', () => {
    toastContainer.remove();
    expect(showToast('x')).toBeNull();
  });
});

// ── Command bar ──

function buildCommandBar() {
  const root = dom.el('div');
  dom.el('textarea', { id: 'ai-command-input', parent: root });
  dom.el('div', { id: 'command-results', parent: root });
  dom.el('button', { id: 'btn-ai-command', parent: root });
  return { root, bar: new CommandBar(root) };
}

function routedHandler(routes, sent = []) {
  return async (message) => {
    sent.push(message);
    const route = routes[message.action];
    if (typeof route === 'function') return route(message);
    return route;
  };
}

describe('command bar flows', () => {
  test('empty input does nothing; Shift+Enter does not submit', async () => {
    const sent = [];
    installChromeMock({ runtimeHandler: routedHandler({}, sent) });
    const { root, bar } = buildCommandBar();
    const input = root.querySelector('#ai-command-input');
    input.value = '   ';
    await bar.execute();
    input.value = 'close docs';
    keydown(input, 'Enter', { shiftKey: true });
    await flush();
    expect(sent).toHaveLength(0);
  });

  test('error, executed and empty results', async () => {
    let response = { error: 'AI is not configured' };
    installChromeMock({ runtimeHandler: routedHandler({ executeNLCommand: () => response }) });
    const { root, bar } = buildCommandBar();
    const input = root.querySelector('#ai-command-input');

    input.value = 'x';
    await bar.execute();
    // `{error}` responses reject in sendOrThrow and are reported as failures.
    expect(toasts().at(-1).type).toBe('error');
    expect(toasts().at(-1).message).toContain('AI is not configured');
    expect(input.disabled).toBe(false);

    response = { executed: true };
    input.value = 'x';
    await bar.execute();
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Done' });
    expect(input.value).toBe('');

    response = { action: 'unknown' };
    input.value = 'x';
    await bar.execute();
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Command produced no result' });

    response = { confirmation: 'Close 3 tabs in 1 window?', parsedCommand: { action: 'close' } };
    input.value = 'x';
    await bar.execute();
    expect(root.querySelector('.command-confirmation').textContent).toBe('Close 3 tabs in 1 window?');
    expect(root.querySelector('#command-results button').textContent).toBe('Close tabs');
  });

  test('find results: Group sends the matched ids; Dismiss clears; failures are reported', async () => {
    const sent = [];
    let groupResponse = {};
    installChromeMock({ runtimeHandler: routedHandler({ createTabGroup: () => groupResponse }, sent) });
    const { root, bar } = buildCommandBar();
    const results = root.querySelector('#command-results');
    const tabs = [{ id: 1, title: 'A', url: 'https://a/' }, { id: 2, url: 'https://b/' }];

    bar.showFindResults({ matchedTabs: tabs });
    expect(results.querySelector('.find-results-header').textContent).toBe('Found 2 tabs');
    expect(results.querySelectorAll('.find-result-title').map((t) => t.textContent)).toEqual(['A', 'https://b/']);
    results.querySelectorAll('button')[0].click();
    await flush();
    expect(sent.at(-1)).toEqual({ action: 'createTabGroup', tabIds: [1, 2], title: 'AI Results', color: 'blue' });
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Grouped 2 tabs' });
    expect(results.children).toHaveLength(0);

    bar.showFindResults({ matchedTabs: [tabs[0]] });
    expect(results.querySelector('.find-results-header').textContent).toBe('Found 1 tab');
    groupResponse = { error: 'nope' };
    results.querySelectorAll('button')[0].click();
    await flush();
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Could not group tabs: nope' });

    results.querySelectorAll('button')[2].click();
    expect(results.children).toHaveLength(0);
  });

  test('Close all asks first; Cancel returns to the results; Yes closes exactly the found tabs', async () => {
    const sent = [];
    installChromeMock({ runtimeHandler: routedHandler({ closeTabs: {} }, sent) });
    const { root, bar } = buildCommandBar();
    const results = root.querySelector('#command-results');
    const tabs = [{ id: 4, title: 'A' }];

    bar.showFindResults({ matchedTabs: tabs });
    results.querySelectorAll('button')[1].click();
    expect(results.querySelector('.command-confirmation').textContent).toBe('Close 1 tab?');
    results.querySelectorAll('button')[1].click(); // Cancel
    expect(results.querySelector('.find-results-header').textContent).toBe('Found 1 tab');
    expect(sent).toHaveLength(0);

    results.querySelectorAll('button')[1].click();
    results.querySelectorAll('button')[0].click(); // Yes, close
    await flush();
    expect(sent).toEqual([{ action: 'closeTabs', tabIds: [4] }]);
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Closed 1 tabs' });
  });

  test('Close confirmation failure is reported', async () => {
    installChromeMock({ runtimeHandler: routedHandler({ closeTabs: { error: 'boom' } }) });
    const { root, bar } = buildCommandBar();
    bar.showCloseConfirmation([{ id: 1 }, { id: 2 }]);
    expect(root.querySelector('.command-confirmation').textContent).toBe('Close 2 tabs?');
    root.querySelector('#command-results button').click();
    await flush();
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Could not close tabs: boom' });
  });

  test('a stale confirmation (superseded by a newer render) sends nothing', async () => {
    const sent = [];
    installChromeMock({ runtimeHandler: routedHandler({ confirmNLCommand: { message: 'ok' } }, sent) });
    const { root, bar } = buildCommandBar();
    bar.showConfirmation({ confirmation: 'Close 30 tabs?', parsedCommand: { action: 'close' } });
    const staleConfirm = root.querySelector('#command-results button');
    bar.showConfirmation({ confirmation: 'Move 25 tabs?', parsedCommand: { action: 'move' } });
    staleConfirm.click();
    await flush();
    expect(sent).toHaveLength(0);
  });

  test('confirmation failure re-renders the same confirmation and unlocks input', async () => {
    let fail = true;
    installChromeMock({
      runtimeHandler: routedHandler({ confirmNLCommand: () => (fail ? { error: 'changed' } : {}) }),
    });
    const { root, bar } = buildCommandBar();
    const input = root.querySelector('#ai-command-input');
    bar.showConfirmation({ confirmation: 'Discard 3 tabs?', parsedCommand: { action: 'discard' } });
    root.querySelector('#command-results button').click();
    expect(input.disabled).toBe(true);
    await flush();
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Execution failed: changed' });
    expect(root.querySelector('.command-confirmation').textContent).toBe('Discard 3 tabs?');
    expect(root.querySelector('#command-results button').className).toBe('action-btn danger');
    expect(input.disabled).toBe(false);

    fail = false;
    input.value = 'discard';
    root.querySelector('#command-results button').click();
    await flush();
    expect(toasts().at(-1)).toEqual({ type: 'success', message: 'Done' });
    expect(input.value).toBe('');
    expect(root.querySelector('#command-results').children).toHaveLength(0);
  });

  test('Cancel on a confirmation clears it', () => {
    installChromeMock();
    const { root, bar } = buildCommandBar();
    bar.showConfirmation({ confirmation: 'x', parsedCommand: {} });
    root.querySelectorAll('#command-results button')[1].click();
    expect(root.querySelector('#command-results').children).toHaveLength(0);
  });

  test('a find-result row reports a tab that can no longer be focused', async () => {
    installChromeMock({ runtimeHandler: routedHandler({ focusTab: { error: 'No tab with id: 9' } }) });
    const { root, bar } = buildCommandBar();
    bar.showFindResults({ matchedTabs: [{ id: 9 }] });
    const row = root.querySelector('.find-result-item');
    expect(row.getAttribute('aria-label')).toBe('Switch to tab');
    row.click();
    await flush();
    expect(toasts().at(-1)).toEqual({ type: 'error', message: 'Could not switch to tab: That tab is already closed.' });
  });
});
