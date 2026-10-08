// U1 "Foundation & global shell" (docs/reports/uiux-review.md): navigation
// order + shortcuts, ARIA tab pattern, stats strip, header status icons,
// toasts, help dialog focus trap, tokens and global CSS guards.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installFakeDom, keydown } from '../helpers/fake-dom.js';
import {
  PRIMARY_VIEWS,
  VIEW_SHORTCUTS,
  applyStatusIcon,
  countDuplicateTabs,
  formatStatsStrip,
  nextRovingIndex,
  resolveStatusIconState,
  scrollIntoContainer,
  selectTab,
  setupRovingTablist,
  shouldShowStatsStrip,
  statusIconLabel,
} from '../../sidepanel/panel-helpers.js';
import {
  TOAST_DURATION_ACTION,
  TOAST_DURATION_DEFAULT,
  TOAST_DURATION_ERROR,
  resolveToastDuration,
  showToast,
  showUndoToast,
} from '../../sidepanel/components/toast.js';
import { createFocusTrap, isModalOpen } from '../../sidepanel/components/confirm-dialog.js';

const read = (path) => Bun.file(new URL(`../../${path}`, import.meta.url)).text();

let dom;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { dom.restore(); });

describe('navigation order and shortcuts', () => {
  test('Tabs comes first and 1-4 follow the nav order', () => {
    expect(PRIMARY_VIEWS).toEqual(['tabs', 'windows', 'stash', 'sessions']);
    expect(VIEW_SHORTCUTS).toEqual({ 1: 'tabs', 2: 'windows', 3: 'stash', 4: 'sessions' });
  });

  test('panel.html nav renders the tabs in the same order with the ARIA tab pattern', async () => {
    const html = await read('sidepanel/panel.html');
    const nav = html.slice(html.indexOf('<nav class="tab-nav"'), html.indexOf('</nav>', html.indexOf('<nav class="tab-nav"')));
    expect(nav).toContain('role="tablist"');
    const tabs = [...nav.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
    expect(tabs.map((t) => t.match(/data-view="(\w+)"/)[1])).toEqual(PRIMARY_VIEWS);
    for (const [index, tab] of tabs.entries()) {
      const view = PRIMARY_VIEWS[index];
      expect(tab).toContain(`id="nav-tab-${view}"`);
      expect(tab).toContain(`aria-controls="view-${view}"`);
      expect(tab).toContain(`aria-selected="${index === 0}"`);
      expect(tab).toContain(`tabindex="${index === 0 ? 0 : -1}"`);
    }
  });

  test('panel.js maps number keys through VIEW_SHORTCUTS and builds help rows from it', async () => {
    const panel = await read('sidepanel/panel.js');
    expect(panel).toContain('const tabKeys = { ...VIEW_SHORTCUTS };');
    expect(panel).not.toMatch(/'1':\s*'windows'/);
    expect(panel).toMatch(/Object\.entries\(VIEW_SHORTCUTS\)/);
    expect(panel).toContain('setupRovingTablist(navButtons)');
    expect(panel).toContain("panel.setAttribute('role', 'tabpanel')");
  });

  test('Settings and Focus get a selected state and hide the stats strip', async () => {
    const panel = await read('sidepanel/panel.js');
    expect(panel).toContain("setHeaderViewButton(settingsBtn, target === 'settings')");
    expect(panel).toContain("setHeaderViewButton(focusBtn, target === 'focus')");
    expect(panel).toContain("btn.setAttribute('aria-current', 'page')");
    expect(panel).toContain('statsBar.hidden = !shouldShowStatsStrip(target)');
    expect(shouldShowStatsStrip('settings')).toBe(false);
    expect(shouldShowStatsStrip('focus')).toBe(false);
    for (const view of PRIMARY_VIEWS) expect(shouldShowStatsStrip(view)).toBe(true);
  });
});

describe('roving tabindex', () => {
  test('nextRovingIndex wraps and supports Home/End', () => {
    expect(nextRovingIndex('ArrowRight', 0, 4)).toBe(1);
    expect(nextRovingIndex('ArrowRight', 3, 4)).toBe(0);
    expect(nextRovingIndex('ArrowLeft', 0, 4)).toBe(3);
    expect(nextRovingIndex('Home', 2, 4)).toBe(0);
    expect(nextRovingIndex('End', 0, 4)).toBe(3);
    expect(nextRovingIndex('Enter', 0, 4)).toBe(-1);
    expect(nextRovingIndex('ArrowRight', 0, 0)).toBe(-1);
  });

  function makeTabs() {
    const list = dom.el('nav');
    list.setAttribute('role', 'tablist');
    return PRIMARY_VIEWS.map((view) => {
      const tab = dom.el('button', { parent: list });
      tab.setAttribute('role', 'tab');
      tab.dataset.view = view;
      return tab;
    });
  }

  test('selectTab keeps exactly one tab stop and aria-selected in sync', () => {
    const tabs = makeTabs();
    selectTab(tabs, tabs[2]);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false']);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1']);
    expect(tabs[2].classList.contains('active')).toBe(true);

    // Settings open: nothing selected, but the tablist stays reachable.
    selectTab(tabs, null);
    expect(tabs.every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1']);
  });

  test('arrow keys move focus and activate the next tab', () => {
    const tabs = makeTabs();
    const activated = [];
    selectTab(tabs, tabs[0]);
    setupRovingTablist(tabs, { activate: (tab) => { activated.push(tab.dataset.view); selectTab(tabs, tab); } });

    tabs[0].focus();
    const event = keydown(tabs[0], 'ArrowRight');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tabs[1]);
    keydown(tabs[1], 'ArrowLeft');
    keydown(tabs[0], 'ArrowLeft');
    keydown(tabs[3], 'Home');
    expect(activated).toEqual(['windows', 'tabs', 'sessions', 'tabs']);
    expect(tabs[0].getAttribute('tabindex')).toBe('0');

    const modified = keydown(tabs[0], 'ArrowRight', { altKey: true });
    expect(modified.defaultPrevented).toBe(false);
  });
});

describe('stats strip', () => {
  test('formats one line with plurals and sleeping count', () => {
    expect(formatStatsStrip({ totalWindows: 3, totalTabs: 27, activeTabs: 27, discardedTabs: 0 }))
      .toBe('3 windows · 27 tabs · 0 sleeping');
    expect(formatStatsStrip({ totalWindows: 1, totalTabs: 1, activeTabs: 0 }))
      .toBe('1 window · 1 tab · 1 sleeping');
    expect(formatStatsStrip()).toBe('0 windows · 0 tabs · 0 sleeping');
  });

  test('markup is a single strip, not three cards plus a hint', async () => {
    const html = await read('sidepanel/panel.html');
    expect(html).toMatch(/<div id="global-stats-bar" class="global-stats-bar"[^>]*title="[^"]*[Ss]leeping/);
    expect(html).not.toContain('stat-card');
    expect(html).not.toContain('stats-hint');
    expect(html).not.toContain('header-meta');
  });
});

describe('header status icons', () => {
  test('off when not set up, ok when working, error only when failing', () => {
    expect(resolveStatusIconState({ configured: false, healthy: false })).toBe('off');
    expect(resolveStatusIconState({ configured: false, healthy: true })).toBe('off');
    expect(resolveStatusIconState({ configured: true, healthy: true })).toBe('ok');
    expect(resolveStatusIconState({ configured: true, healthy: false })).toBe('error');
  });

  test('labels describe the state and the action', () => {
    expect(statusIconLabel('ai', 'off')).toBe('AI: off — click to set up');
    expect(statusIconLabel('ai', 'ok', { provider: 'OpenAI' })).toBe('AI: on (OpenAI)');
    expect(statusIconLabel('drive', 'off')).toBe('Google Drive: off — click to set up');
    expect(statusIconLabel('drive', 'ok')).toBe('Google Drive: connected');
    expect(statusIconLabel('drive', 'error')).toMatch(/needs attention/);
  });

  test('applyStatusIcon sets data-state, tooltip and accessible name', () => {
    const btn = dom.el('button');
    applyStatusIcon(btn, 'drive', 'off');
    expect(btn.dataset.state).toBe('off');
    expect(btn.getAttribute('aria-label')).toBe('Google Drive: off — click to set up');
    expect(btn.dataset.tooltip).toBe(btn.getAttribute('aria-label'));
    expect(btn.getAttribute('title')).toBe(btn.getAttribute('aria-label'));
  });

  test('CSS keeps "off" neutral; the AI icon is no longer a star', async () => {
    const [css, html] = await Promise.all([read('sidepanel/panel.css'), read('sidepanel/panel.html')]);
    expect(css).toMatch(/\.status-icon\[data-state="off"\]\s*{\s*color: var\(--text-tertiary\);/);
    expect(css).toMatch(/\.status-icon\[data-state="error"\]::after\s*{\s*background: var\(--danger\);/);
    expect(css).not.toMatch(/\.status-icon\.disconnected/);
    const aiButton = html.slice(html.indexOf('id="btn-ai-status"'), html.indexOf('</button>', html.indexOf('id="btn-ai-status"')));
    expect(aiButton).not.toContain('<polygon');
    expect(aiButton).toContain('data-state="off"');
    expect(aiButton).toContain('aria-hidden="true"');
  });
});

describe('toasts', () => {
  let container;
  let timers;
  let realSetTimeout;
  let realClearTimeout;

  beforeEach(() => {
    container = dom.el('div', { id: 'toast-container' });
    timers = new Map();
    let nextId = 1;
    realSetTimeout = globalThis.setTimeout;
    realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
    globalThis.clearTimeout = (id) => { timers.delete(id); };
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  const pendingDurations = () => [...timers.values()].map((t) => t.ms);

  test('durations: 3.5s plain, 6s errors, 8s (min 6s) with an action', () => {
    expect(resolveToastDuration({ type: 'success' })).toBe(TOAST_DURATION_DEFAULT);
    expect(TOAST_DURATION_DEFAULT).toBeGreaterThanOrEqual(3000);
    expect(TOAST_DURATION_DEFAULT).toBeLessThanOrEqual(4000);
    expect(resolveToastDuration({ type: 'error' })).toBe(TOAST_DURATION_ERROR);
    expect(resolveToastDuration({ type: 'info', hasAction: true })).toBe(TOAST_DURATION_ACTION);
    expect(resolveToastDuration({ type: 'info', duration: 3000, hasAction: true })).toBe(6000);
    expect(resolveToastDuration({ type: 'info', duration: 5000 })).toBe(5000);
  });

  test('container is a polite live region; errors are alerts', () => {
    showToast('Saved', 'success');
    expect(container.getAttribute('role')).toBe('status');
    expect(container.getAttribute('aria-live')).toBe('polite');
    expect(container.children[0].getAttribute('role')).toBeNull();

    showToast('Broken', 'error');
    expect(container.children[1].getAttribute('role')).toBe('alert');
    expect(pendingDurations()).toEqual([TOAST_DURATION_DEFAULT, TOAST_DURATION_ERROR]);
  });

  test('every toast has a named close button; message stays the first child', () => {
    const handle = showToast('Hello');
    const toast = container.children[0];
    expect(toast.children[0].textContent).toBe('Hello');
    const close = toast.querySelector('.toast-close');
    expect(close.getAttribute('aria-label')).toBe('Dismiss notification');
    close.click();
    expect(toast.style.opacity).toBe('0');
    expect(handle.duration).toBe(TOAST_DURATION_DEFAULT);
  });

  test('timer pauses on hover and focus, and resumes afterwards', () => {
    showToast('Hover me', 'info');
    const toast = container.children[0];
    expect(timers.size).toBe(1);
    toast.dispatchEvent({ type: 'mouseenter', bubbles: false, preventDefault() {}, stopPropagation() {} });
    expect(timers.size).toBe(0);
    toast.dispatchEvent({ type: 'focusin', bubbles: false, preventDefault() {}, stopPropagation() {} });
    toast.dispatchEvent({ type: 'mouseleave', bubbles: false, preventDefault() {}, stopPropagation() {} });
    expect(timers.size).toBe(0); // still focused
    toast.dispatchEvent({ type: 'focusout', bubbles: false, preventDefault() {}, stopPropagation() {} });
    expect(timers.size).toBe(1);
  });

  test('showUndoToast shows an 8s Undo action that runs once and dismisses', () => {
    let undone = 0;
    showUndoToast('Stashed 2 tabs from github.com', () => { undone += 1; });
    const toast = container.children[0];
    expect(toast.className).toBe('toast success');
    expect(pendingDurations()).toEqual([TOAST_DURATION_ACTION]);
    const undo = toast.querySelector('.toast-action');
    expect(undo.textContent).toBe('Undo');
    undo.click();
    expect(undone).toBe(1);
    expect(toast.style.opacity).toBe('0');
  });

  test('options form and legacy positional form both work', () => {
    let hits = 0;
    showToast('Deleted', { type: 'success', action: { label: 'Undo', callback: () => { hits += 1; } } });
    showToast('Closed', 'success', 8000, { label: 'Undo', callback: () => { hits += 1; } });
    expect(container.children.map((t) => t.querySelector('.toast-action')?.textContent)).toEqual(['Undo', 'Undo']);
    expect(pendingDurations()).toEqual([8000, 8000]);
  });
});

describe('help dialog focus trap', () => {
  test('traps Tab, closes on Escape and "?", restores focus', () => {
    const opener = dom.el('button', { id: 'btn-help' });
    opener.focus();
    const dialog = dom.el('div');
    dialog.setAttribute('role', 'dialog');
    const close = dom.el('button', { parent: dialog });
    const link = dom.el('a', { parent: dialog });
    link.setAttribute('href', 'https://example.test');

    let closed = 0;
    const trap = createFocusTrap(dialog, { onClose: () => { closed += 1; }, initialFocus: close, closeKeys: ['?'] });
    expect(isModalOpen()).toBe(true);
    expect(document.activeElement).toBe(close);

    keydown(close, 'Tab');
    expect(document.activeElement).toBe(link);
    keydown(link, 'Tab');
    expect(document.activeElement).toBe(close);
    keydown(close, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(link);

    let panelSaw = false;
    document.addEventListener('keydown', () => { panelSaw = true; });
    keydown(link, 'Escape');
    keydown(link, '?');
    expect(closed).toBe(2);
    expect(panelSaw).toBe(false);

    trap.release();
    expect(isModalOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  test('panel builds the help overlay as a modal dialog using the trap', async () => {
    const panel = await read('sidepanel/panel.js');
    expect(panel).toContain("panel.setAttribute('role', 'dialog')");
    expect(panel).toContain("panel.setAttribute('aria-modal', 'true')");
    expect(panel).toContain("panel.setAttribute('aria-labelledby', 'help-dialog-title')");
    expect(panel).toContain("closeBtn.setAttribute('aria-label', 'Close help')");
    expect(panel).toMatch(/createFocusTrap\(panel, \{[\s\S]*?initialFocus: closeBtn/);
    expect(panel).toContain('if (isModalOpen()) return;');
  });
});

describe('duplicates badge', () => {
  test('counts extra copies only', () => {
    expect(countDuplicateTabs([{ tabs: [1, 2, 3] }, { tabs: [4, 5] }])).toBe(3);
    expect(countDuplicateTabs(null)).toBe(0);
    expect(countDuplicateTabs([{ tabs: [] }])).toBe(0);
  });

  test('panel no longer adds blank pages to the badge', async () => {
    const panel = await read('sidepanel/panel.js');
    const check = panel.slice(panel.indexOf('async function checkDuplicates'), panel.indexOf('\ncheckDuplicates();'));
    expect(check).not.toContain('findEmptyPages');
    expect(check).toContain('countDuplicateTabs(dupes)');
  });
});

describe('scrolling never moves the document root', () => {
  test('scrollIntoContainer scrolls the .view-container', () => {
    const container = dom.el('main', { className: 'view-container' });
    const section = dom.el('div', { parent: container });
    container.scrollTop = 40;
    let scrolled = null;
    container.scrollTo = (opts) => { scrolled = opts; };
    container.getBoundingClientRect = () => ({ top: 100 });
    section.getBoundingClientRect = () => ({ top: 300 });
    let rootScroll = false;
    section.scrollIntoView = () => { rootScroll = true; };

    scrollIntoContainer(section, { align: 'start', win: { matchMedia: () => ({ matches: true }) } });
    expect(scrolled).toEqual({ top: 232, behavior: 'auto' });
    expect(rootScroll).toBe(false);

    let nearest = null;
    section.scrollIntoView = (opts) => { nearest = opts; };
    scrollIntoContainer(section, { win: { matchMedia: () => ({ matches: false }) } });
    expect(nearest).toEqual({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  });

  test('panel.js has no block:start scrollIntoView calls', async () => {
    const panel = await read('sidepanel/panel.js');
    expect(panel).not.toMatch(/scrollIntoView\(\{[^}]*block: 'start'/);
  });
});

describe('panel.css foundation', () => {
  let css;
  beforeEach(async () => { css = await read('sidepanel/panel.css'); });

  function block(selectorStart) {
    const start = css.indexOf(selectorStart);
    expect(start).toBeGreaterThan(-1);
    const open = css.indexOf('{', start + selectorStart.length - 1);
    return css.slice(open + 1, css.indexOf('}', open));
  }

  function tokens(body) {
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  }

  test('light tokens use the AA replacements', () => {
    const light = tokens(block(':root {'));
    expect(light).toMatchObject({
      '--kebab': '#b45309',
      '--kebab-hover': '#92400e',
      '--success': '#047857',
      '--danger': '#dc2626',
      '--danger-hover': '#b91c1c',
      '--text-tertiary': '#6b7280',
      '--text-secondary': '#4b5563',
      '--focus-accent': '#0e7490',
      '--fs-xs': '11px',
      '--fs-sm': '12px',
      '--fs-md': '13px',
      '--fs-lg': '15px',
      '--fs-xl': '18px',
    });
    expect(light['--focus-accent-soft']).toBeDefined();
    expect(light['--border-input']).toBeDefined();
  });

  test('OS-dark and forced-dark token blocks are identical', () => {
    const mediaDark = tokens(block(':root:not([data-theme="light"]) {'));
    const forcedDark = tokens(block(':root[data-theme="dark"] {'));
    expect(forcedDark).toEqual(mediaDark);
    expect(mediaDark).toMatchObject({
      '--text-tertiary': '#8b8f98',
      '--border': '#34343a',
      '--border-strong': '#52525b',
      '--accent-fill': '#2563eb',
      '--on-danger': '#111827',
      '--on-kebab': '#111827',
      '--on-success': '#111827',
      '--focus-accent': '#22d3ee',
    });
    expect(mediaDark['--focus-accent-soft']).toBeDefined();
  });

  test('filled buttons and toasts use the on-* text tokens', () => {
    expect(css).not.toMatch(/color:\s*#fff\b/);
    expect(block('.action-btn {')).toContain('background: var(--accent-fill)');
    expect(block('.action-btn.danger {')).toContain('color: var(--on-danger)');
    expect(block('.action-btn.kebab {')).toContain('color: var(--on-kebab)');
    expect(block('.toast.success {')).toContain('color: var(--on-success)');
  });

  test('visible focus ring, no transition: all, reduced motion, root never scrolls', () => {
    expect(css).toMatch(/:where\(button, a, select, input, textarea, summary, \[role="tab"\], \[role="button"\], \[tabindex\]\):focus-visible\s*{\s*outline: 2px solid var\(--focus-ring\);\s*outline-offset: 2px;/);
    expect(css).not.toMatch(/transition:\s*all\b/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('animation-duration: 0.01ms !important');
    expect(reduced).toMatch(/body\.focus-blink\s*{\s*animation: none !important;\s*outline:/);
    expect(block('html {')).toContain('overflow: hidden');
  });

  test('font sizes go through the type scale', () => {
    const literal = [...css.matchAll(/font-size:\s*([0-9.]+px)/g)].map((m) => m[1]);
    expect(literal).toEqual(['48px']); // the Focus timer display numerals only
  });

  test('icon buttons share a 24px minimum hit target', () => {
    expect(css).toMatch(/\.icon-hit,\s*\.settings-btn,\s*\.help-close,\s*\.toast-close\s*{\s*min-width: var\(--hit-min\);\s*min-height: var\(--hit-min\);/);
  });
});
