// keyboard-activate.js — Make click-only <div> controls keyboard operable,
// plus the small accessible menu primitives shared by the Tabs, Groups and
// Windows views (row ⋯ overflow menus, toolbar split buttons, collapse toggle).

/**
 * Give a non-button element button semantics: focusable (tabindex=0),
 * role="button", and Enter/Space activation. Keys pressed on nested
 * controls (e.g. a Close button inside a header) are left to those controls.
 *
 * @param {HTMLElement} el
 * @param {object} [opts]
 * @param {boolean} [opts.expanded] - set aria-expanded (for disclosure headers)
 * @param {string} [opts.label] - optional aria-label
 */
export function makeKeyboardActivatable(el, { expanded, label } = {}) {
  if (el.tagName === 'BUTTON') return el; // already keyboard operable
  el.setAttribute('tabindex', '0');
  el.setAttribute('role', 'button');
  if (expanded !== undefined) el.setAttribute('aria-expanded', String(Boolean(expanded)));
  if (label) el.setAttribute('aria-label', label);
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    el.click();
  });
  return el;
}

/** Keep a disclosure header's aria-expanded in sync with its collapsed state. */
export function setExpanded(el, expanded) {
  el.setAttribute('aria-expanded', String(Boolean(expanded)));
}

// ── Menus ──

/** The one menu currently open in the panel (opening another closes it). */
let openMenuState = null;

function menuItems(menu) {
  return Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'))
    .filter((item) => !item.disabled && !item.hidden);
}

function positionMenu(button, menu, anchor = button) {
  // Fixed positioning keeps the menu clear of overflow:hidden cards and the
  // scrolling view; it is skipped where layout APIs are unavailable.
  if (typeof anchor.getBoundingClientRect !== 'function') return;
  if (typeof window === 'undefined') return;
  const rect = anchor.getBoundingClientRect();
  const viewportW = document.documentElement?.clientWidth || window.innerWidth || 0;
  const viewportH = window.innerHeight || document.documentElement?.clientHeight || 0;
  menu.style.position = 'fixed';
  if (menu.dataset.align === 'start') {
    menu.style.right = 'auto';
    menu.style.left = `${Math.max(8, rect.left)}px`;
  } else {
    menu.style.left = 'auto';
    menu.style.right = `${Math.max(8, viewportW - rect.right)}px`;
    // Never let a right-aligned menu run off the left edge.
    if (typeof menu.getBoundingClientRect === 'function' && menu.getBoundingClientRect().left < 8) {
      menu.style.right = 'auto';
      menu.style.left = '8px';
    }
  }
  const height = menu.offsetHeight || 0;
  const below = rect.bottom + 4;
  const above = rect.top - 4 - height;
  menu.style.top = `${below + height > viewportH - 8 && above > 8 ? above : below}px`;
}

function closeMenu(state, { restoreFocus = false } = {}) {
  if (!state || state.menu.hidden) return;
  state.menu.hidden = true;
  state.button.setAttribute('aria-expanded', 'false');
  state.wrapper?.classList.remove('menu-open');
  if (openMenuState === state) openMenuState = null;
  state.detach?.();
  state.detach = null;
  if (restoreFocus) state.button.focus();
}

function openMenu(state, { focus = 'first' } = {}) {
  if (openMenuState && openMenuState !== state) closeMenu(openMenuState);
  state.menu.hidden = false;
  state.button.setAttribute('aria-expanded', 'true');
  state.wrapper?.classList.add('menu-open');
  openMenuState = state;
  positionMenu(state.button, state.menu, state.wrapper || state.button);

  const items = menuItems(state.menu);
  const target = focus === 'last' ? items[items.length - 1] : items[0];
  target?.focus();

  // Close on outside click, scroll or resize. Registered lazily so nothing
  // touches the document at import time.
  const doc = state.button.ownerDocument || globalThis.document;
  const onDocClick = (e) => {
    if (state.wrapper?.contains(e.target) || state.menu.contains(e.target)) return;
    if (e.target === state.button || state.button.contains?.(e.target)) return;
    closeMenu(state);
  };
  const onScroll = (e) => {
    if (state.menu.contains?.(e.target)) return;
    closeMenu(state);
  };
  doc?.addEventListener?.('click', onDocClick, true);
  doc?.addEventListener?.('scroll', onScroll, true);
  const win = typeof window !== 'undefined' ? window : null;
  win?.addEventListener?.('resize', onScroll);
  state.detach = () => {
    doc?.removeEventListener?.('click', onDocClick, true);
    doc?.removeEventListener?.('scroll', onScroll, true);
    win?.removeEventListener?.('resize', onScroll);
  };
}

/**
 * Wire an existing button + role="menu" element as an accessible menu button
 * (WAI-ARIA menu button pattern): Enter/Space/ArrowDown opens and focuses the
 * first item, ArrowUp opens on the last, arrows/Home/End move between items,
 * Escape closes and returns focus to the button, Tab closes. Selecting an
 * item closes the menu before its click handler runs.
 *
 * @returns {{ open: Function, close: Function, isOpen: Function }}
 */
export function wireMenuButton(button, menu, { wrapper = null } = {}) {
  const state = { button, menu, wrapper, detach: null };
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  if (menu.id) button.setAttribute('aria-controls', menu.id);
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  for (const item of menuItems(menu)) item.setAttribute('tabindex', '-1');

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(state);
    else closeMenu(state);
  });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      openMenu(state, { focus: e.key === 'ArrowUp' ? 'last' : 'first' });
    } else if (e.key === 'Escape' && !menu.hidden) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(state, { restoreFocus: true });
    }
  });

  // Selecting an item closes the menu first (capture phase, so the item's own
  // handler runs with the menu already closed); the bubble listener keeps the
  // click from toggling a row header underneath.
  menu.addEventListener('click', (e) => {
    const item = e.target?.closest?.('[role="menuitem"], [role="menuitemcheckbox"]');
    if (item && !item.disabled) closeMenu(state, { restoreFocus: true });
  }, true);
  menu.addEventListener('click', (e) => e.stopPropagation());

  menu.addEventListener('keydown', (e) => {
    const items = menuItems(menu);
    const index = items.indexOf(menu.ownerDocument?.activeElement ?? e.target);
    const current = index >= 0 ? index : items.indexOf(e.target);
    let next = null;
    switch (e.key) {
      case 'ArrowDown': next = items[(current + 1) % items.length]; break;
      case 'ArrowUp': next = items[(current - 1 + items.length) % items.length]; break;
      case 'Home': next = items[0]; break;
      case 'End': next = items[items.length - 1]; break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        closeMenu(state, { restoreFocus: true });
        return;
      case 'Tab':
        closeMenu(state);
        return;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        // Native buttons activate themselves; keep the key from row headers
        // and the panel's single-key shortcuts.
        e.stopPropagation();
        return;
      default:
        // Swallow single-key panel shortcuts (1-4, F, /) while in a menu.
        e.stopPropagation();
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  });

  return {
    open: (opts) => openMenu(state, opts),
    close: (opts) => closeMenu(state, opts),
    isOpen: () => !menu.hidden,
  };
}

/**
 * Build a ⋯ overflow menu for a row.
 *
 * Items: { label, onSelect, className?, danger?, title?, checked?, hidden? }.
 * Danger items are grouped at the end behind a separator so destructive
 * actions are never adjacent to benign ones.
 *
 * @param {object} opts
 * @param {string} opts.label - accessible name of the ⋯ button
 * @param {Array<object>} opts.items
 * @returns {{ wrapper: HTMLElement, button: HTMLElement, menu: HTMLElement,
 *             items: HTMLElement[], open: Function, close: Function, isOpen: Function }}
 */
export function createOverflowMenu({ label, items }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'row-menu-wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-menu-btn';
  button.textContent = '⋯'; // ⋯
  button.setAttribute('aria-label', label);
  button.title = label;

  const menu = document.createElement('div');
  menu.className = 'row-menu';

  const benign = items.filter((item) => !item.danger);
  const danger = items.filter((item) => item.danger);
  const built = [];
  const addItem = (spec) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `row-menu-item${spec.danger ? ' danger' : ''}${spec.className ? ` ${spec.className}` : ''}`;
    if (spec.checked !== undefined) {
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', String(Boolean(spec.checked)));
    } else {
      item.setAttribute('role', 'menuitem');
    }
    item.textContent = spec.label;
    if (spec.title) item.title = spec.title;
    if (spec.hidden) item.hidden = true;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      spec.onSelect?.(e);
    });
    menu.appendChild(item);
    built.push(item);
  };
  benign.forEach(addItem);
  if (benign.length > 0 && danger.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'row-menu-separator';
    sep.setAttribute('role', 'separator');
    menu.appendChild(sep);
  }
  danger.forEach(addItem);

  wrapper.appendChild(button);
  wrapper.appendChild(menu);
  // Clicks/keys inside the wrapper must not toggle the row header.
  wrapper.addEventListener('click', (e) => e.stopPropagation());

  const api = wireMenuButton(button, menu, { wrapper });
  return { wrapper, button, menu, items: built, ...api };
}

/**
 * Wire a collapse/expand-all icon toggle (aria-pressed = "everything is
 * collapsed"). `isAllCollapsed()` reports the current state; `onToggle(collapse)`
 * performs it. Returns a `sync()` to call after individual rows change.
 */
export function wireCollapseToggle(button, { isAllCollapsed, onToggle }) {
  if (!button) return { sync() {} };
  const sync = () => {
    const pressed = Boolean(isAllCollapsed());
    // Fixed name + aria-pressed (toggle pattern); the tooltip says what a
    // click will do next.
    button.setAttribute('aria-label', 'Collapse all');
    button.setAttribute('aria-pressed', String(pressed));
    button.title = pressed ? 'Expand all' : 'Collapse all';
    button.classList.toggle('is-collapsed', pressed);
  };
  button.addEventListener('click', async () => {
    const collapse = !isAllCollapsed();
    await onToggle(collapse);
    sync();
  });
  sync();
  return { sync };
}
