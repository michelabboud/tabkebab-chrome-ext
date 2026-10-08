// toast.js — Lightweight notification toasts
//
// Accessibility:
// - #toast-container is a polite live region (role="status"); error toasts
//   are role="alert" so screen readers announce them assertively.
// - Toasts with an action button stay up long enough to reach the button
//   (≥ 6s, 8s by default); errors 6s; everything else 3.5s.
// - The auto-dismiss timer pauses while the toast is hovered or has focus.
// - Every toast has a close button with an accessible name.

export const TOAST_DURATION_DEFAULT = 3500;
export const TOAST_DURATION_ERROR = 6000;
export const TOAST_DURATION_ACTION = 8000;
export const TOAST_DURATION_ACTION_MIN = 6000;

/**
 * Pick how long a toast stays visible.
 * An explicit duration is honoured, except that toasts with an action are
 * never shorter than TOAST_DURATION_ACTION_MIN.
 */
export function resolveToastDuration({ type = 'info', duration, hasAction = false } = {}) {
  const explicit = Number.isFinite(duration) && duration > 0 ? duration : null;
  if (hasAction) return Math.max(explicit ?? TOAST_DURATION_ACTION, TOAST_DURATION_ACTION_MIN);
  if (explicit !== null) return explicit;
  return type === 'error' ? TOAST_DURATION_ERROR : TOAST_DURATION_DEFAULT;
}

function setAttr(el, name, value) {
  if (typeof el?.setAttribute === 'function') el.setAttribute(name, value);
}

function ensureLiveRegion(container) {
  if (!container || container.dataset?.liveRegion === 'ready') return;
  setAttr(container, 'role', 'status');
  setAttr(container, 'aria-live', 'polite');
  setAttr(container, 'aria-relevant', 'additions');
  if (container.dataset) container.dataset.liveRegion = 'ready';
}

function normalizeArgs(typeOrOptions, duration, action) {
  if (typeOrOptions && typeof typeOrOptions === 'object') {
    return {
      type: typeOrOptions.type || 'info',
      duration: typeOrOptions.duration,
      action: typeOrOptions.action || null,
    };
  }
  return { type: typeOrOptions || 'info', duration, action: action || null };
}

/**
 * Show a toast notification.
 *
 * Positional form (backwards compatible):
 *   showToast(message, type?, duration?, action?)
 * Options form:
 *   showToast(message, { type?, duration?, action? })
 *
 * @param {string} message - The message to display
 * @param {string|Object} [typeOrOptions='info'] - 'info' | 'success' | 'error' | 'warning', or an options object
 * @param {number} [duration] - Auto-dismiss duration in ms (defaults by type/action)
 * @param {{label: string, callback: Function}} [action] - Optional action button
 * @returns {{ element: Object, dismiss: Function }|null}
 */
export function showToast(message, typeOrOptions = 'info', duration, action = null) {
  const container = document.getElementById('toast-container');
  if (!container) return null;
  ensureLiveRegion(container);

  const opts = normalizeArgs(typeOrOptions, duration, action);
  const hasAction = Boolean(opts.action && opts.action.label && typeof opts.action.callback === 'function');
  const totalMs = resolveToastDuration({ type: opts.type, duration: opts.duration, hasAction });

  const toast = document.createElement('div');
  toast.className = `toast ${opts.type}`;
  if (opts.type === 'error') setAttr(toast, 'role', 'alert');
  if (toast.dataset) toast.dataset.duration = String(totalMs);

  const textSpan = document.createElement('span');
  textSpan.className = 'toast-message';
  textSpan.textContent = message;
  toast.appendChild(textSpan);

  let dismissed = false;
  let timer = null;
  let remaining = totalMs;
  let startedAt = 0;
  let hovered = false;
  let focused = false;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimer();
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 200ms ease';
    setTimeout(() => toast.remove(), 200);
  };

  const startTimer = () => {
    if (dismissed || timer !== null) return;
    startedAt = Date.now();
    timer = setTimeout(dismiss, remaining);
  };

  const pauseTimer = () => {
    if (timer === null) return;
    clearTimer();
    remaining = Math.max(1000, remaining - (Date.now() - startedAt));
  };

  const syncTimer = () => {
    if (hovered || focused) pauseTimer();
    else startTimer();
  };

  if (hasAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = opts.action.label;
    btn.addEventListener('click', () => {
      dismiss();
      try {
        const result = opts.action.callback();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        // The caller owns error reporting for its action.
      }
    });
    toast.appendChild(btn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.textContent = '×';
  setAttr(closeBtn, 'aria-label', 'Dismiss notification');
  closeBtn.addEventListener('click', dismiss);
  toast.appendChild(closeBtn);

  toast.addEventListener('mouseenter', () => { hovered = true; syncTimer(); });
  toast.addEventListener('mouseleave', () => { hovered = false; syncTimer(); });
  toast.addEventListener('focusin', () => { focused = true; syncTimer(); });
  toast.addEventListener('focusout', () => { focused = false; syncTimer(); });

  container.appendChild(toast);
  startTimer();

  return { element: toast, dismiss, duration: totalMs };
}

/**
 * Show a toast with an "Undo" button (8s, pauses on hover/focus).
 *
 *   showUndoToast('Stashed 4 tabs from github.com', () => restoreStash(id));
 *
 * @param {string} message
 * @param {Function} onUndo - Called when the user presses Undo (may be async).
 * @param {{type?: string, duration?: number, label?: string}} [options]
 */
export function showUndoToast(message, onUndo, { type = 'success', duration, label = 'Undo' } = {}) {
  return showToast(message, {
    type,
    duration,
    action: typeof onUndo === 'function' ? { label, callback: onUndo } : null,
  });
}
