// confirm-dialog.js — Lightweight inline confirmation dialog (not window.confirm)
//
// Modal behaviour: Escape cancels, Tab/Shift+Tab are trapped inside the
// dialog, and focus returns to the element that was focused before opening.

let activeDialog = null; // { close(result) } while a dialog is open

function getOverlay() {
  return document.getElementById('confirm-overlay');
}

/** True while a confirmation dialog is showing. */
export function isConfirmOpen() {
  return activeDialog !== null;
}

/**
 * Show a confirmation dialog. Returns a Promise that resolves true (confirm) or false (cancel).
 * @param {object} opts
 * @param {string} opts.title - Dialog title
 * @param {string} opts.message - Description text
 * @param {string} [opts.confirmLabel='Confirm'] - Confirm button text
 * @param {string} [opts.cancelLabel='Cancel'] - Cancel button text
 * @param {boolean} [opts.danger=false] - Style confirm button as danger
 */
export function showConfirm({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  // Only one dialog at a time: a newer request cancels the older one so its
  // caller is never left awaiting a promise that can no longer settle.
  activeDialog?.close(false);

  return new Promise((resolve) => {
    const el = getOverlay();
    const previouslyFocused = document.activeElement;
    el.innerHTML = '';
    el.hidden = false;

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    const titleEl = document.createElement('div');
    titleEl.className = 'confirm-title';
    titleEl.id = 'confirm-dialog-title';
    titleEl.textContent = title;
    dialog.setAttribute('aria-labelledby', titleEl.id);

    const msgEl = document.createElement('div');
    msgEl.className = 'confirm-message';
    msgEl.id = 'confirm-dialog-message';
    msgEl.textContent = message;
    dialog.setAttribute('aria-describedby', msgEl.id);

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'action-btn secondary';
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = danger ? 'action-btn danger' : 'action-btn primary';
    confirmBtn.textContent = confirmLabel;

    const focusable = [cancelBtn, confirmBtn];

    const onKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(false);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        const index = focusable.indexOf(document.activeElement);
        const next = e.shiftKey
          ? (index <= 0 ? focusable.length - 1 : index - 1)
          : (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
        focusable[next].focus();
      }
    };

    const onFocusIn = (e) => {
      // Keep focus inside the dialog if something outside receives it.
      if (!dialog.contains(e.target)) confirmBtn.focus();
    };

    const onBackdropClick = (e) => {
      if (e.target === el) close(false);
    };

    let settled = false;
    function close(result) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      el.removeEventListener('click', onBackdropClick);
      el.hidden = true;
      el.innerHTML = '';
      if (activeDialog === handle) activeDialog = null;
      if (previouslyFocused && previouslyFocused !== document.body &&
          previouslyFocused.isConnected !== false && typeof previouslyFocused.focus === 'function') {
        try { previouslyFocused.focus(); } catch { /* element no longer focusable */ }
      }
      resolve(result);
    }
    const handle = { close };
    activeDialog = handle;

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    el.addEventListener('click', onBackdropClick);
    // Capture phase so the dialog sees keys before the panel's global
    // shortcut handler (which would otherwise act on Escape / 1-4 / F).
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('focusin', onFocusIn, true);

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(titleEl);
    dialog.appendChild(msgEl);
    dialog.appendChild(actions);
    el.appendChild(dialog);

    confirmBtn.focus();
  });
}
