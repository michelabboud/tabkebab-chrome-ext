// more-menu.js — Behaviour for the <details class="more-menu"> "⋯" menus that
// hold rare view actions (Export / Import). <details>/<summary> already give
// keyboard and screen-reader support; this adds Escape and outside-click
// close, and makes the file-picker <label> items keyboard operable.

function menusIn(rootEl) {
  return rootEl?.querySelectorAll?.('details.more-menu') || [];
}

export function closeMoreMenu(rootEl) {
  for (const menu of menusIn(rootEl)) {
    if (menu.open) menu.open = false;
    menu.removeAttribute?.('open');
  }
}

export function wireMoreMenu(rootEl, doc = globalThis.document) {
  const menus = menusIn(rootEl);
  for (const menu of menus) {
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !menu.open) return;
      e.preventDefault();
      e.stopPropagation();
      menu.open = false;
      menu.querySelector('summary')?.focus();
    });

    // <label><input type="file" hidden></label> is clickable but not
    // focusable; give it button semantics so keyboard users can import.
    for (const label of menu.querySelectorAll('label.file-label')) {
      const input = label.querySelector('input');
      if (!input) continue;
      label.setAttribute('tabindex', '0');
      label.setAttribute('role', 'button');
      label.addEventListener('keydown', (e) => {
        if (e.target !== label) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        input.click();
      });
    }
  }
  if (menus.length > 0 && doc?.addEventListener) {
    doc.addEventListener('click', (e) => {
      for (const menu of menus) {
        if (menu.open && !menu.contains(e.target)) menu.open = false;
      }
    });
  }
}
