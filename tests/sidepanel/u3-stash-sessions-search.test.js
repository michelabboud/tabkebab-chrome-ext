// U3 of docs/reports/uiux-review.md: Stash, Sessions, Smart Group, Command
// bar, Onboarding and Search.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { installFakeDom, keydown } from '../helpers/fake-dom.js';

import { showStashedToast, undoStash, StashList } from '../../sidepanel/components/stash-list.js';
import { SessionManager } from '../../sidepanel/components/session-manager.js';
import { CommandBar } from '../../sidepanel/components/command-bar.js';
import { GlobalSearch } from '../../sidepanel/components/global-search.js';
import { friendlyErrorMessage } from '../../sidepanel/restore-feedback.js';
import {
  defaultSessionName,
  displayStashName,
  formatRecordDate,
} from '../../sidepanel/record-format.js';
import { wireMoreMenu, closeMoreMenu } from '../../sidepanel/more-menu.js';

let dom;
let toastContainer;

beforeEach(() => {
  dom = installFakeDom();
  toastContainer = dom.el('div', { id: 'toast-container' });
});

afterEach(() => {
  dom.restore();
});

function toasts() {
  return toastContainer.children.map((toast) => ({
    type: toast.className.replace(/^toast\s+/, '').split(' ')[0],
    message: toast.children[0]?.textContent,
  }));
}

async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const read = (path) => Bun.file(new URL(`../../${path}`, import.meta.url)).text();

// ── Record formatting ──

describe('record formatting', () => {
  test('drops the legacy "(N tabs)" suffix from stash names', () => {
    expect(displayStashName('www.amazon.com (2 tabs)')).toBe('www.amazon.com');
    expect(displayStashName('Window 1 (1 tab)')).toBe('Window 1');
    expect(displayStashName('Research [group]')).toBe('Research [group]');
    expect(displayStashName('')).toBe('Untitled stash');
  });

  test('default session name is a readable timestamp', () => {
    const at = new Date(2026, 9, 8, 14, 5);
    expect(defaultSessionName(at, { locale: 'en-GB' })).toBe('Session — 8 Oct, 14:05');
    expect(defaultSessionName(at, { locale: 'en-US' })).toMatch(/^Session — Oct 8, 0?2:05\sPM$/);
  });

  test('record dates omit the year only for the current year', () => {
    const now = new Date(2026, 9, 8);
    expect(formatRecordDate(new Date(2026, 9, 8, 9, 18), { now, locale: 'en-GB' })).toBe('8 Oct, 09:18');
    expect(formatRecordDate(new Date(2025, 0, 2, 9, 18), { now, locale: 'en-GB' })).toContain('2025');
    expect(formatRecordDate('not a date')).toBe('');
  });
});

describe('friendly error messages', () => {
  test('maps raw platform errors to actionable copy and passes ours through', () => {
    expect(friendlyErrorMessage(new Error('Could not establish connection. Receiving end does not exist.')))
      .toBe("TabKebab's background service was restarting. Try again.");
    expect(friendlyErrorMessage(new Error('The user turned off browser signin')))
      .toBe('Sign in to Chrome first (Chrome menu → Sign in), then try again.');
    expect(friendlyErrorMessage(new Error('Stash not found')))
      .toBe('That stash no longer exists. It may already have been restored or deleted.');
    expect(friendlyErrorMessage(new Error('No tab with id: 42.'))).toBe('That tab is already closed.');
    expect(friendlyErrorMessage(new Error('QuotaExceededError: ...')))
      .toBe('Browser storage is full. Delete some stashes or sessions, then try again.');
    expect(friendlyErrorMessage(new Error('Unexpected token < in JSON at position 0')))
      .toBe("That file isn't a valid TabKebab JSON export.");
    expect(friendlyErrorMessage(new Error('No tabs matched that description')))
      .toBe('No tabs matched that description');
    expect(friendlyErrorMessage(null)).toBe('Something went wrong. Try again.');
  });
});

// ── Stash undo ──

describe('stash toast Undo', () => {
  function harness(responses) {
    const sent = [];
    const notices = [];
    const send = async (message) => {
      sent.push(message);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    const notify = (message, type, duration, action) => notices.push({ message, type, duration, action });
    return { sent, notices, send, notify };
  }

  const domainStash = { id: 's1', name: 'github.com', source: 'domain', tabCount: 3 };

  test('the stash toast carries an 8s Undo that reopens the tabs here and deletes the stash', async () => {
    const h = harness([{
      requestedCount: 3, restoredCount: 3, skippedDuplicate: 0, skippedInvalid: 0,
      errors: [], complete: true, windowsCreated: 0, groupsRestored: 0,
    }]);
    const undone = [];
    showStashedToast(domainStash, {
      from: 'github.com', send: h.send, notify: h.notify, onUndone: (outcome) => undone.push(outcome),
    });

    expect(h.notices[0].message).toBe('Stashed 3 tabs from github.com');
    expect(h.notices[0].type).toBe('success');
    expect(h.notices[0].duration).toBe(8000);
    expect(h.notices[0].action.label).toBe('Undo');

    await h.notices[0].action.callback();
    expect(h.sent).toEqual([{
      action: 'restoreStash',
      stashId: 's1',
      options: { mode: 'here' },
      ifUnrestored: true,
      deleteAfterRestore: true,
    }]);
    expect(h.notices[1]).toMatchObject({ message: 'Restored 3 tabs', type: 'success' });
    expect(undone).toEqual(['restored']);

    // A second click on the same toast does nothing.
    await h.notices[0].action.callback();
    expect(h.sent).toHaveLength(1);
  });

  test('a window stash undo reopens it as its own window', async () => {
    const h = harness([{ requestedCount: 1, restoredCount: 1, errors: [], complete: true, windowsCreated: 1 }]);
    await undoStash({ id: 'w', source: 'window', tabCount: 1 }, { send: h.send, notify: h.notify });
    expect(h.sent[0].options).toEqual({ mode: 'windows' });
  });

  test('undo is safe when the stash was already restored elsewhere', async () => {
    const h = harness([{ alreadyRestored: true, reason: 'missing' }]);
    await expect(undoStash(domainStash, { send: h.send, notify: h.notify })).resolves.toBe('already-restored');
    expect(h.notices).toEqual([{
      message: 'Nothing to undo — these tabs were already restored.',
      type: 'info',
      duration: undefined,
      action: undefined,
    }]);
  });

  test('undo failures read as plain language, not platform errors', async () => {
    const h = harness([new Error('Could not establish connection. Receiving end does not exist.')]);
    await expect(undoStash(domainStash, { send: h.send, notify: h.notify })).resolves.toBe('failed');
    expect(h.notices[0]).toMatchObject({
      message: "Undo failed: TabKebab's background service was restarting. Try again.",
      type: 'error',
    });
  });

  test('singular count and no Undo without a stash id', () => {
    const h = harness([]);
    showStashedToast({ tabCount: 1 }, { from: 'Window 2', send: h.send, notify: h.notify });
    expect(h.notices).toEqual([{ message: 'Stashed 1 tab from Window 2', type: 'success', duration: undefined, action: undefined }]);
  });
});

// ── Stash and session cards ──

function buildStashList() {
  const root = dom.el('div');
  dom.el('div', { id: 'stash-list', parent: root });
  dom.el('button', { id: 'btn-export-stashes', parent: root });
  dom.el('input', { id: 'btn-import-stashes', parent: root });
  return new StashList(root);
}

function buildSessionManager() {
  const root = dom.el('div');
  for (const id of ['session-list-saved', 'session-list-auto']) dom.el('div', { id, parent: root });
  for (const id of ['btn-save-session', 'btn-export']) dom.el('button', { id, parent: root });
  for (const id of ['btn-import', 'session-name']) dom.el('input', { id, parent: root });
  return { manager: new SessionManager(root), root };
}

describe('stash card hierarchy', () => {
  test('Restore is primary, Delete is a ghost button, icons have accessible names, no "(N tabs)" in the title', () => {
    installChromeMock();
    const list = buildStashList();
    const card = list.createStashCard({
      id: 'a',
      name: 'www.amazon.com (2 tabs)',
      source: 'domain',
      createdAt: Date.now(),
      tabCount: 2,
      windows: [{ tabs: [{ url: 'https://www.amazon.com/' }, { url: 'https://www.amazon.com/b' }] }],
    });

    expect(card.querySelector('.stash-name').textContent).toBe('www.amazon.com');
    expect(card.querySelector('.stash-meta').textContent).toMatch(/^2 tabs · /);
    const buttons = card.querySelector('.stash-actions').querySelectorAll('button');
    const byText = Object.fromEntries(buttons.map((b) => [b.textContent, b]));
    expect(byText.Restore.className).toBe('action-btn');
    expect(byText['Restore here'].className).toBe('action-btn secondary');
    expect(byText.Delete.className).toBe('action-btn ghost-danger');
    expect(byText.Delete.getAttribute('aria-label')).toBe('Delete stash www.amazon.com');
    expect(byText['⤓'].getAttribute('aria-label')).toBe('Export www.amazon.com');
    expect(byText['⤓'].className).toContain('secondary');
    for (const b of buttons) expect(b.type).toBe('button');
  });
});

describe('session cards and default name', () => {
  test('session card puts Restore first as primary and Delete as a ghost button', () => {
    installChromeMock();
    const { manager } = buildSessionManager();
    const card = manager.createSessionCard({
      id: 's', name: 'Work', createdAt: Date.now(),
      windows: [{ tabCount: 2, tabs: [] }, { tabCount: 1, tabs: [], groups: [{}] }],
    }, false);
    expect(card.querySelector('.session-meta').textContent).toMatch(/^3 tabs · 2 windows · 1 group · /);
    const buttons = card.querySelector('.session-actions').querySelectorAll('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Restore', 'Restore here', '⤓', 'Delete']);
    expect(buttons[0].className).toBe('action-btn');
    expect(buttons[3].className).toBe('action-btn ghost-danger');
    expect(buttons[2].getAttribute('aria-label')).toBe('Export Work');
  });

  test('saving with an empty name uses a timestamped default instead of an error', async () => {
    const sent = [];
    installChromeMock({
      runtimeHandler: async (message) => {
        sent.push(message);
        return message.action === 'listSessions' ? [] : { success: true };
      },
    });
    const { manager, root } = buildSessionManager();
    root.querySelector('#session-name').value = '   ';
    const now = new Date(2026, 9, 8, 14, 5);

    await manager.saveSession({ now });

    const expectedName = defaultSessionName(now);
    expect(sent[0]).toEqual({ action: 'saveSession', name: expectedName });
    expect(toasts().at(-1)).toEqual({ type: 'success', message: `Session "${expectedName}" saved` });
    expect(toasts().some((t) => t.message === 'Enter a session name')).toBeFalse();
  });

  test('a typed name is still used as-is', async () => {
    const sent = [];
    installChromeMock({
      runtimeHandler: async (message) => { sent.push(message); return message.action === 'listSessions' ? [] : {}; },
    });
    const { manager, root } = buildSessionManager();
    root.querySelector('#session-name').value = '  Research  ';
    await manager.saveSession();
    expect(sent[0]).toEqual({ action: 'saveSession', name: 'Research' });
  });
});

// ── Export / Import placement ──

describe('Export / Import live in a ⋯ menu under Stash and Sessions', () => {
  test('markup keeps the ids but moves them into details.more-menu with labelled triggers', async () => {
    const html = await read('sidepanel/panel.html');
    const stashView = html.slice(html.indexOf('id="view-stash"'), html.indexOf('</section>', html.indexOf('id="view-stash"')));
    const sessionView = html.slice(html.indexOf('id="view-sessions"'), html.indexOf('</section>', html.indexOf('id="view-sessions"')));
    for (const [view, ids, label] of [
      [stashView, ['btn-export-stashes', 'btn-import-stashes'], 'More stash actions'],
      [sessionView, ['btn-export', 'btn-import'], 'More session actions'],
    ]) {
      const menu = view.slice(view.indexOf('<details class="more-menu">'), view.indexOf('</details>'));
      expect(menu).toContain(`aria-label="${label}"`);
      for (const id of ids) expect(menu).toContain(`id="${id}"`);
    }
    expect(sessionView).toContain('aria-label="Session name (optional)"');
    // The stash list no longer ends with equal-weight Export/Import buttons.
    expect(stashView.indexOf('id="stash-list"')).toBeGreaterThan(stashView.indexOf('</details>'));
  });

  test('menus close on Escape (focus back on the trigger) and on outside clicks', () => {
    const root = dom.el('div');
    const menu = dom.el('details', { className: 'more-menu', parent: root });
    const summary = dom.el('summary', { parent: menu });
    const item = dom.el('button', { parent: menu });
    const outside = dom.el('button');
    wireMoreMenu(root);

    menu.open = true;
    keydown(item, 'Escape');
    expect(menu.open).toBeFalse();
    expect(document.activeElement).toBe(summary);

    menu.open = true;
    item.click();
    expect(menu.open).toBeTrue();
    outside.click();
    expect(menu.open).toBeFalse();

    menu.open = true;
    menu.setAttribute('open', '');
    closeMoreMenu(root);
    expect(menu.open).toBeFalse();
  });

  test('the Import file label is keyboard operable', () => {
    const root = dom.el('div');
    const menu = dom.el('details', { className: 'more-menu', parent: root });
    const label = dom.el('label', { className: 'more-menu-item file-label', parent: menu });
    const input = dom.el('input', { parent: label });
    let opened = 0;
    input.addEventListener('click', () => { opened += 1; });
    wireMoreMenu(root);

    expect(label.getAttribute('tabindex')).toBe('0');
    expect(label.getAttribute('role')).toBe('button');
    keydown(label, 'Enter');
    keydown(label, ' ');
    expect(opened).toBe(2);
  });
});

// ── Command bar ──

function buildCommandBar() {
  const root = dom.el('div', { id: 'command-bar' });
  dom.el('textarea', { id: 'ai-command-input', parent: root });
  dom.el('div', { id: 'command-results', parent: root });
  dom.el('button', { id: 'btn-ai-command', parent: root });
  return { root, bar: new CommandBar(root) };
}

describe('command bar', () => {
  test('shows the indeterminate progress bar while thinking', async () => {
    let resolve;
    installChromeMock({ runtimeHandler: () => new Promise((r) => { resolve = r; }) });
    const { root, bar } = buildCommandBar();
    root.querySelector('#ai-command-input').value = 'find docs';
    const run = bar.execute();
    expect(root.querySelector('#command-results').innerHTML).toContain('progress-bar-fill indeterminate');
    resolve({ executed: true, message: 'Done' });
    await run;
  });

  test('stash confirmations use a danger button; non-destructive ones do not', () => {
    const { root, bar } = buildCommandBar();
    const results = root.querySelector('#command-results');
    bar.showConfirmation({ confirmation: 'Stash 4 tabs?', parsedCommand: { action: 'stash' } });
    let confirm = results.querySelectorAll('button')[0];
    expect(confirm.textContent).toBe('Stash tabs');
    expect(confirm.className).toBe('action-btn danger');

    bar.showConfirmation({ confirmation: 'Group 30 tabs?', parsedCommand: { action: 'group' } });
    confirm = results.querySelectorAll('button')[0];
    expect(confirm.textContent).toBe('Confirm');
    expect(confirm.className).toBe('action-btn');
  });

  test('find results are keyboard-operable buttons with names', async () => {
    const sent = [];
    installChromeMock({ runtimeHandler: async (message) => { sent.push(message); return {}; } });
    const { root, bar } = buildCommandBar();
    bar.showFindResults({ matchedTabs: [{ id: 7, title: 'Docs', url: 'https://docs.test/' }] });
    const row = root.querySelector('.find-result-item');
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabindex')).toBe('0');
    expect(row.getAttribute('aria-label')).toBe('Switch to Docs');
    keydown(row, 'Enter');
    await flush();
    expect(sent).toEqual([{ action: 'focusTab', tabId: 7 }]);
  });

  test('markup: single-row labelled input and the provider label reads "via …"', async () => {
    const [html, css] = await Promise.all([read('sidepanel/panel.html'), read('sidepanel/features.css')]);
    expect(html).toMatch(/<textarea id="ai-command-input"[^>]*rows="1"/);
    expect(html).toMatch(/<textarea id="ai-command-input"[^>]*aria-label="/);
    expect(css).toContain(".ai-provider-label:not(:empty)::before");
    expect(css).toContain("content: 'via '");
  });
});

// ── Global search ──

describe('global search accessibility', () => {
  // The fake DOM does not parse innerHTML; give the overlay its input and
  // results children so the component can wire them, and keep the markup.
  function parseSearchOverlayMarkup() {
    const markup = [];
    const create = document.createElement.bind(document);
    document.createElement = (tag) => {
      const el = create(tag);
      if (tag !== 'div') return el;
      const proto = Object.getPrototypeOf(el);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
      Object.defineProperty(el, 'innerHTML', {
        configurable: true,
        get() { return descriptor.get.call(el); },
        set(value) {
          descriptor.set.call(el, value);
          if (String(value).includes('search-input')) {
            markup.push(String(value));
            const input = create('input');
            input.className = 'search-input';
            const results = create('div');
            results.className = 'search-results';
            el.append(input, results);
          }
        },
      });
      return el;
    };
    return markup;
  }

  async function openSearch() {
    installChromeMock();
    const markup = parseSearchOverlayMarkup();
    const navStash = dom.el('button', { className: 'tab-nav' });
    const stashNav = dom.el('button', { parent: navStash });
    stashNav.dataset.view = 'stash';
    stashNav.setAttribute('data-view', 'stash');
    let navClicks = 0;
    stashNav.addEventListener('click', () => { navClicks += 1; });
    const search = new GlobalSearch({
      send: async ({ action }) => {
        if (action === 'getGroupedTabs') return [{ domain: 'a.test', tabs: [{ id: 1, windowId: 1, title: 'Alpha', url: 'https://a.test/' }] }];
        if (action === 'listStashes') return [{ id: 'st', name: 'a.test (1 tab)', createdAt: 1, tabCount: 1, windows: [{ tabs: [{ url: 'https://a.test/x' }] }] }];
        return [];
      },
    });
    const opener = dom.el('button');
    opener.focus();
    search.open();
    await flush();
    return { search, opener, markup, navClicks: () => navClicks };
  }

  test('dialog semantics, labelled input and keyboard-operable result rows', async () => {
    const { search, markup } = await openSearch();
    expect(search.overlay.getAttribute('role')).toBe('dialog');
    expect(search.overlay.getAttribute('aria-modal')).toBe('true');
    expect(markup[0]).toMatch(/class="search-input"[^>]*aria-label="Search tabs, stashes and sessions"/);
    expect(search.flatItems).toHaveLength(2);
    for (const item of search.flatItems) {
      expect(item.getAttribute('role')).toBe('button');
      expect(item.getAttribute('tabindex')).toBe('0');
      expect(item.getAttribute('aria-label')).toBeTruthy();
    }
    // Stash names drop the legacy count.
    expect(search.flatItems[1].getAttribute('aria-label')).toBe('Open stash: a.test');
  });

  test('Enter on a focused row activates it exactly once and focus returns to the opener', async () => {
    const { search, opener, navClicks } = await openSearch();
    const stashRow = search.flatItems[1];
    expect(search.overlay.contains(stashRow)).toBeTrue();
    stashRow.focus();
    keydown(stashRow, 'Enter');
    await flush();
    expect(navClicks()).toBe(1);
    expect(search.overlay).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

// ── Smart Group / walkthrough CSS hooks ──

describe('features.css covers the U3 hooks', () => {
  test('defines styles for the new classes', async () => {
    const css = await read('sidepanel/features.css');
    for (const selector of [
      '.ghost-danger', '.record-actions-spacer', '.more-menu', '.walkthrough-skip',
      '.walkthrough-target', '.smart-group-ai-hint', '.view-heading-row',
    ]) {
      expect(css).toContain(selector);
    }
    expect(css).toMatch(/\.walkthrough-actions\s*{[^}]*flex-wrap:\s*nowrap/);
  });
});
