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
