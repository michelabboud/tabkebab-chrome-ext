// keyboard-activate.js — Make click-only <div> controls keyboard operable.

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
