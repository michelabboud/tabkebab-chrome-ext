// toast.js — Lightweight notification toasts

const container = document.getElementById('toast-container');

/**
 * Show a toast notification.
 * @param {string} message - The message to display
 * @param {string} [type='info'] - Toast type: 'info', 'success', 'error'
 * @param {number} [duration=3000] - Auto-dismiss duration in ms
 * @param {Object} [action] - Optional action button { label, callback }
 */
export function showToast(message, type = 'info', duration = 3000, action = null) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  toast.appendChild(textSpan);

  let dismissed = false;

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 200ms ease';
    setTimeout(() => toast.remove(), 200);
  };

  if (action && action.label && action.callback) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.callback();
      dismiss();
    });
    toast.appendChild(btn);
  }

  container.appendChild(toast);
  setTimeout(dismiss, duration);
}
