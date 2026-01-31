// confirm-dialog.js — Lightweight inline confirmation dialog (not window.confirm)

let overlay = null;

function getOverlay() {
  if (!overlay) {
    overlay = document.getElementById('confirm-overlay');
  }
  return overlay;
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
  return new Promise((resolve) => {
    const el = getOverlay();
    el.innerHTML = '';
    el.hidden = false;

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const titleEl = document.createElement('div');
    titleEl.className = 'confirm-title';
    titleEl.textContent = title;

    const msgEl = document.createElement('div');
    msgEl.className = 'confirm-message';
    msgEl.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'action-btn secondary';
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = danger ? 'action-btn danger' : 'action-btn primary';
    confirmBtn.textContent = confirmLabel;

    function close(result) {
      el.hidden = true;
      el.innerHTML = '';
      resolve(result);
    }

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    el.addEventListener('click', (e) => {
      if (e.target === el) close(false);
    }, { once: true });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(titleEl);
    dialog.appendChild(msgEl);
    dialog.appendChild(actions);
    el.appendChild(dialog);

    confirmBtn.focus();
  });
}
