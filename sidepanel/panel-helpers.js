// panel-helpers.js — Pure helpers for panel.js (kept DOM-light so they are testable).

/**
 * Coalesce bursts of calls into one trailing call after `delayMs` of quiet.
 * Returns a function with `.flush()` (run now if pending) and `.cancel()`.
 */
export function createDebounced(fn, delayMs, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  const debounced = () => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      fn();
    }, delayMs);
  };
  debounced.cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  debounced.flush = () => {
    if (timer === null) return;
    debounced.cancel();
    fn();
  };
  return debounced;
}

/**
 * Decide whether a single-key panel shortcut (1-4, F, /, ?, Escape) may run.
 * Shortcuts never fire with Ctrl/Meta/Alt held (so browser shortcuts such as
 * Ctrl/Cmd+F keep working), while a modal dialog is open, once another
 * handler has claimed the event, or while the user is typing.
 */
export function isPlainShortcutAllowed(e, { dialogOpen = false } = {}) {
  if (!e || dialogOpen || e.defaultPrevented) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const target = e.target;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (target?.isContentEditable) return false;
  return true;
}

/**
 * Which controller key should refresh when tabs change, given the visible
 * view and the active Tabs sub-view. Views that don't show live tab state
 * (stash, sessions, settings, focus) return null.
 */
export function resolveTabsChangedRefreshKey({ visibleView, activeSubtab }) {
  if (visibleView === 'windows') return 'windows';
  if (visibleView === 'tabs') {
    return { domains: 'tabs', groups: 'groups', duplicates: 'duplicates' }[activeSubtab || 'domains'] || 'tabs';
  }
  return null;
}

/** True when `el` is a form control or contenteditable the user may be typing in. */
export function isEditingElement(el) {
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el?.isContentEditable === true;
}

/**
 * Wrap an automatic refresh so it never re-renders under the user. While
 * `isBusy()` is true (typing in the view, a drag in progress) the call is
 * remembered instead of run; `.resume()` runs one deferred refresh once the
 * view is idle again.
 */
export function createDeferrableRefresh(run, { isBusy }) {
  let pending = false;
  const request = () => {
    if (isBusy()) {
      pending = true;
      return;
    }
    pending = false;
    run();
  };
  request.resume = () => {
    if (!pending || isBusy()) return;
    pending = false;
    run();
  };
  request.isPending = () => pending;
  return request;
}

// ── Navigation ──

/** Primary views in nav order. The number keys follow this order. */
export const PRIMARY_VIEWS = Object.freeze(['tabs', 'windows', 'stash', 'sessions']);

/** Single-key view shortcuts: 1 Tabs · 2 Windows · 3 Stash · 4 Sessions. */
export const VIEW_SHORTCUTS = Object.freeze(
  Object.fromEntries(PRIMARY_VIEWS.map((view, index) => [String(index + 1), view])),
);

/** Views where the global stats strip carries no information. */
const STATS_HIDDEN_VIEWS = new Set(['settings', 'focus']);

export function shouldShowStatsStrip(view) {
  return !STATS_HIDDEN_VIEWS.has(view);
}

/**
 * Roving-tabindex target for an ARIA tablist key press.
 * Returns the index to move to, or -1 when the key is not a tablist key.
 */
export function nextRovingIndex(key, current, count) {
  if (!count) return -1;
  const from = current >= 0 ? current : 0;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (from + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return -1;
  }
}

/**
 * Mark `selected` as the selected tab of `tabs` (aria-selected + .active) and
 * give it the single tab stop. With `selected` null no tab is selected (a
 * view outside the tablist, e.g. Settings, is open) but the previously
 * focusable tab keeps the tab stop so the tablist stays reachable.
 */
export function selectTab(tabs, selected) {
  const list = [...tabs];
  const keeper = selected
    || list.find((tab) => tab.getAttribute('tabindex') === '0')
    || list[0];
  for (const tab of list) {
    const isSelected = tab === selected;
    tab.classList.toggle('active', isSelected);
    tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    tab.setAttribute('tabindex', tab === keeper ? '0' : '-1');
  }
}

/** A tab switched off in Settings → Features (or otherwise hidden) is skipped. */
function isRovingTabAvailable(tab) {
  return !tab.hidden && !tab.classList?.contains?.('feature-off');
}

/**
 * Wire the ARIA tab pattern onto `tabs` (buttons with role="tab"):
 * arrow keys / Home / End move focus and activate (automatic activation).
 * `activate(tab)` performs the switch (usually `tab.click()`).
 */
export function setupRovingTablist(tabs, { activate = (tab) => tab.click() } = {}) {
  const all = [...tabs];
  for (const tab of all) {
    tab.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const list = all.filter((candidate) => candidate === tab || isRovingTabAvailable(candidate));
      const index = nextRovingIndex(e.key, list.indexOf(tab), list.length);
      if (index < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const target = list[index];
      target.focus();
      activate(target);
    });
  }
}

// ── Stats strip ──

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "3 windows · 27 tabs · 0 sleeping" from a getWindowStats() result. */
export function formatStatsStrip(data = {}) {
  const windows = Number(data.totalWindows) || 0;
  const tabs = Number(data.totalTabs) || 0;
  const sleeping = Number.isFinite(data.discardedTabs)
    ? data.discardedTabs
    : Math.max(0, tabs - (Number.isFinite(data.activeTabs) ? data.activeTabs : tabs));
  return `${plural(windows, 'window', 'windows')} · ${plural(tabs, 'tab', 'tabs')} · ${sleeping} sleeping`;
}

// ── Duplicates badge ──

/** Extra copies across duplicate groups (blank pages are not counted). */
export function countDuplicateTabs(groups) {
  if (!Array.isArray(groups)) return 0;
  return groups.reduce((sum, group) => sum + Math.max(0, (group?.tabs?.length || 0) - 1), 0);
}

// ── Header status icons (Drive / AI) ──

/**
 * 'off'   — not set up / opted out (neutral grey, no dot)
 * 'ok'    — configured and working (green dot)
 * 'error' — configured but failing (red)
 */
export function resolveStatusIconState({ configured, healthy }) {
  if (!configured) return 'off';
  return healthy ? 'ok' : 'error';
}

const STATUS_LABELS = {
  drive: {
    off: 'Google Drive: off — click to set up',
    ok: 'Google Drive: connected',
    error: 'Google Drive: needs attention — click to reconnect',
  },
  ai: {
    off: 'AI: off — click to set up',
    ok: 'AI: on',
    error: 'AI: not working — click to fix',
  },
};

export function statusIconLabel(kind, state, { provider = '' } = {}) {
  const label = STATUS_LABELS[kind]?.[state] || STATUS_LABELS[kind]?.off || '';
  if (kind === 'ai' && state === 'ok' && provider) return `AI: on (${provider})`;
  return label;
}

/** Apply a status state to a header icon button (data-state, tooltip, accessible name). */
export function applyStatusIcon(button, kind, state, detail) {
  if (!button) return;
  const label = statusIconLabel(kind, state, detail);
  button.dataset.state = state;
  button.dataset.tooltip = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
}

// ── Scrolling ──

/** True when the user asked the OS to reduce motion. */
export function prefersReducedMotion(win = globalThis) {
  try {
    return Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

/**
 * Scroll `el` into view inside its scrolling `.view-container` only — never
 * the document root (scrolling <html> clipped the header permanently).
 * `align: 'start'` puts the element at the top of the container; otherwise
 * the minimum scroll ('nearest') is used.
 */
export function scrollIntoContainer(el, { align = 'nearest', win = globalThis } = {}) {
  if (!el) return;
  const behavior = prefersReducedMotion(win) ? 'auto' : 'smooth';
  const container = el.closest?.('.view-container');
  if (align === 'start' && container && typeof container.scrollTo === 'function' &&
      typeof el.getBoundingClientRect === 'function') {
    const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 8;
    container.scrollTo({ top: Math.max(0, top), behavior });
    return;
  }
  el.scrollIntoView?.({ behavior, block: 'nearest', inline: 'nearest' });
}
