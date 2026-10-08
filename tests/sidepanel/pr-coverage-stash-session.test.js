// PR coverage: Stash and Sessions views (stash-list.js, session-manager.js) —
// per-id concurrent restore tracking, progress rendering, empty states,
// delete + Undo, Drive button visibility, refresh-failure messaging.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { installFakeDom } from '../helpers/fake-dom.js';

import { StashList, safeFaviconUrl, showStashedToast } from '../../sidepanel/components/stash-list.js';
import { SessionManager } from '../../sidepanel/components/session-manager.js';
import { MAX_DRIVE_STRING_LENGTH } from '../../core/drive-sync.js';

let dom;
let toastContainer;
let overlay;

beforeEach(() => {
  dom = installFakeDom();
  toastContainer = dom.el('div', { id: 'toast-container' });
  overlay = dom.el('div', { id: 'confirm-overlay' });
});

afterEach(() => {
  dom.restore();
});

function toasts() {
  return toastContainer.children.map((toast) => ({
    type: toast.className.replace(/^toast\s+/, '').split(' ')[0],
    message: toast.children[0]?.textContent,
    action: toast.querySelector('.toast-action')?.textContent ?? null,
    duration: toast.dataset.duration,
  }));
}

function lastToastAction() {
  return toastContainer.children.at(-1).querySelector('.toast-action');
}

async function flush(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function routedHandler(routes, sent = []) {
  return async (message) => {
    sent.push(message);
    const route = routes[message.action];
    if (typeof route === 'function') return route(message);
    return route;
  };
}

function buildStashList(opts) {
  const root = dom.el('div');
  dom.el('div', { id: 'stash-list', parent: root });
  dom.el('button', { id: 'btn-export-stashes', parent: root });
  dom.el('input', { id: 'btn-import-stashes', parent: root });
  return { root, list: new StashList(root, opts) };
}

function buildSessionManager(opts) {
  const root = dom.el('div');
  const nav = dom.el('div', { className: 'session-sub-nav', parent: root });
  for (const tab of ['saved', 'auto']) {
    const btn = dom.el('button', { parent: nav });
    btn.setAttribute('role', 'tab');
    btn.dataset.sessionTab = tab;
    btn.setAttribute('data-session-tab', tab);
  }
  for (const id of ['session-list-saved', 'session-list-auto']) dom.el('div', { id, parent: root });
  for (const id of ['btn-save-session', 'btn-export']) dom.el('button', { id, parent: root });
  for (const id of ['btn-import', 'session-name']) dom.el('input', { id, parent: root });
  return { root, manager: new SessionManager(root, opts) };
}

/** The fake DOM does not parse innerHTML; give a card's progress block real children. */
function addProgressChildren(card) {
  const progress = card.querySelector('.restore-progress');
  progress.replaceChildren();
  const bar = dom.document.createElement('div');
  bar.className = 'restore-progress-bar';
  const fill = dom.document.createElement('div');
  fill.className = 'restore-progress-fill';
  bar.appendChild(fill);
  const label = dom.document.createElement('div');
  label.className = 'restore-progress-label';
  progress.append(bar, label);
  return { progress, fill, label };
}

function stash(overrides = {}) {
  return {
    id: 's1',
    name: 'github.com (3 tabs)',
    source: 'domain',
    createdAt: Date.now(),
    tabCount: 3,
    windows: [{ tabs: [{ url: 'https://a.test/' }, { url: 'https://b.test/' }, { url: 'https://c.test/' }] }],
    ...overrides,
  };
}

// ── safeFaviconUrl ──

describe('safeFaviconUrl', () => {
  test('allows http(s), chrome and data; rejects other schemes, junk and over-long values', () => {
    expect(safeFaviconUrl('https://x.test/f.ico')).toBe('https://x.test/f.ico');
    expect(safeFaviconUrl('chrome://favicon/x')).toBe('chrome://favicon/x');
    expect(safeFaviconUrl('data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
    expect(safeFaviconUrl('javascript:alert(1)')).toBeNull();
    expect(safeFaviconUrl('file:///etc/passwd')).toBeNull();
    expect(safeFaviconUrl('not a url')).toBeNull();
    expect(safeFaviconUrl('')).toBeNull();
    expect(safeFaviconUrl(42)).toBeNull();
    expect(safeFaviconUrl(`https://x.test/${'a'.repeat(MAX_DRIVE_STRING_LENGTH)}`)).toBeNull();
  });
});

// ── showStashedToast ──

describe('showStashedToast', () => {
  test('a failing onUndone refresh never surfaces as an error and Undo runs once', async () => {
    const sent = [];
    const notified = [];
    let onUndoneCalls = 0;
    showStashedToast({ id: 'x', tabCount: 1, source: 'domain' }, {
      from: 'a.test',
      send: async (m) => { sent.push(m); return { requestedCount: 1, restoredCount: 1, skippedDuplicate: 0, skippedInvalid: 0, errors: [], complete: true }; },
      notify: (...args) => notified.push(args),
      onUndone: () => { onUndoneCalls += 1; throw new Error('refresh failed'); },
    });
    expect(notified[0][0]).toBe('Stashed 1 tab from a.test');
    expect(notified[0][2]).toBe(8000);
    const undo = notified[0][3].callback;
    await undo();
    await undo();
    expect(sent).toHaveLength(1);
    expect(onUndoneCalls).toBe(1);
  });

  test('a non-integer tabCount reads as 0 tabs', () => {
    const notified = [];
    showStashedToast({ tabCount: '3' }, { notify: (...args) => notified.push(args) });
    expect(notified).toEqual([['Stashed 0 tabs', 'success']]);
  });
});

// ── StashList ──

describe('StashList cards', () => {
  test('empty state offers a way to find tabs to stash', () => {
    installChromeMock();
    const navigated = [];
    const { root, list } = buildStashList({ navigate: (to) => navigated.push(to) });
    list.render([]);
    const action = root.querySelector('.empty-state-action');
    expect(action.textContent).toBe('Find tabs to stash');
    action.click();
    expect(navigated).toEqual([{ view: 'tabs' }]);
  });

  test('favicons are capped at five with a +N counter; unsafe favicons use the fallback', () => {
    installChromeMock();
    const { list } = buildStashList();
    const tabs = Array.from({ length: 7 }, (_, i) => ({
      url: `https://t${i}.test/`,
      favIconUrl: i === 0 ? 'javascript:alert(1)' : `https://t${i}.test/f.ico`,
    }));
    const card = list.createStashCard(stash({ tabCount: 7, windows: [{ tabs: tabs.slice(0, 4) }, { tabs: tabs.slice(4) }] }));
    const imgs = card.querySelectorAll('.stash-preview-favicon');
    expect(imgs).toHaveLength(5);
    expect(imgs[0].src.startsWith('data:image/svg+xml')).toBe(true);
    expect(imgs[1].src).toBe('https://t1.test/f.ico');
    expect(card.querySelector('.stash-preview-more').textContent).toBe('+2');
    expect(card.querySelector('.stash-meta').textContent).toMatch(/^7 tabs · 2 windows · /);
    expect(card.querySelector('.stash-name').textContent).toBe('github.com');
  });

  test('restored stashes get a badge; Drive button hidden unless Drive is connected', () => {
    installChromeMock();
    const { list } = buildStashList();
    let card = list.createStashCard(stash({ restoredAt: Date.now(), source: undefined }));
    expect(card.querySelector('.stash-restored-badge').textContent).toBe('Restored');
    expect(card.querySelector('.stash-source-badge').textContent).toBe('window');
    expect(card.querySelectorAll('button')[3].hidden).toBe(true);

    list.driveConnected = true;
    card = list.createStashCard(stash());
    const driveBtn = card.querySelectorAll('button')[3];
    expect(driveBtn.hidden).toBe(false);
    expect(driveBtn.getAttribute('aria-label')).toBe('Save github.com to Google Drive');
  });

  test('buildMetaText falls back to the stored tab count when tabCount is missing', () => {
    installChromeMock();
    const { list } = buildStashList();
    expect(list.buildMetaText({ windows: [{}] }, 4, new Date())).toBe('4 tabs');
    expect(list.buildMetaText(null, 0)).toBe('0 tabs');
  });

  test('refresh reads Drive connection state from storage', async () => {
    installChromeMock({
      local: { driveSync: { connected: true } },
      runtimeHandler: routedHandler({ listStashes: [stash()] }),
    });
    const { root, list } = buildStashList();
    expect(await list.refresh()).toBe(true);
    expect(list.driveConnected).toBe(true);
    expect(root.querySelectorAll('.stash-card')).toHaveLength(1);
  });

  test('refresh failure notifies only when asked', async () => {
    installChromeMock({ runtimeHandler: routedHandler({ listStashes: { error: 'Stash not found' } }) });
    const { list } = buildStashList();
    expect(await list.refresh({ notifyFailure: false })).toBe(false);
    expect(toasts()).toHaveLength(0);
    expect(await list.refresh()).toBe(false);
    expect(toasts()[0].message).toBe('Could not load stashes: That stash no longer exists. It may already have been restored or deleted.');
  });
});

describe('StashList actions', () => {
  test('restoring an already-restored stash asks first; cancelling sends nothing', async () => {
    const sent = [];
    installChromeMock({ runtimeHandler: routedHandler({ listStashes: [] }, sent) });
    const { list } = buildStashList();
    const card = list.createStashCard(stash({ restoredAt: 1 }));
    card.querySelectorAll('button')[0].click();
    await flush();
    expect(overlay.querySelector('.confirm-title').textContent).toBe('Restore again?');
    overlay.querySelectorAll('button')[0].click();
    await flush();
    expect(sent.some((m) => m.action === 'restoreStash')).toBe(false);
  });

  test('confirmed re-restore sends the right mode and resets the button', async () => {
    const sent = [];
    installChromeMock({
      runtimeHandler: routedHandler({
        listStashes: [],
        restoreStash: { requestedCount: 3, restoredCount: 3, skippedDuplicate: 0, skippedInvalid: 0, errors: [], complete: true },
      }, sent),
    });
    const { list } = buildStashList();
    const card = list.createStashCard(stash({ restoredAt: 1 }));
    const hereBtn = card.querySelectorAll('button')[1];
    hereBtn.click();
    await flush();
    overlay.querySelectorAll('button')[1].click();
    await flush(40);
    expect(sent.find((m) => m.action === 'restoreStash')).toEqual({ action: 'restoreStash', stashId: 's1', options: { mode: 'here' } });
    expect(hereBtn.disabled).toBe(false);
    expect(hereBtn.textContent).toBe('Restore here');
    expect(list.isRestoreActive('s1')).toBe(false);
  });

  test('restore whose view refresh fails explains both outcomes in one error', async () => {
    installChromeMock({
      runtimeHandler: routedHandler({
        listStashes: { error: 'offline' },
        restoreStash: { requestedCount: 1, restoredCount: 1, skippedDuplicate: 0, skippedInvalid: 0, errors: [], complete: true },
      }),
    });
    const { list } = buildStashList();
    await list.restoreStash('s1', { mode: 'windows' });
    const last = toasts().at(-1);
    expect(last.type).toBe('error');
    expect(last.message).toContain('View could not refresh: offline.');
  });

  test('restore failure is reported in plain language', async () => {
    installChromeMock({ runtimeHandler: routedHandler({ restoreStash: { error: 'No tab with id: 3.' } }) });
    const { list } = buildStashList();
    await list.restoreStash('s1', {});
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Restore failed: That tab is already closed.' });
  });

  test('concurrent restores of the same id are tracked per call', () => {
    installChromeMock();
    const { list } = buildStashList();
    list.beginRestore('s1');
    list.beginRestore('s1');
    expect(list.endRestore('s1')).toBe(false);
    expect(list.isRestoreActive('s1')).toBe(true);
    expect(list.endRestore('s1')).toBe(true);
    expect(list.isRestoreActive('s1')).toBe(false);
    // Ending an id that never began is harmless.
    expect(list.endRestore('never')).toBe(true);
  });

  test('progress broadcasts update only active restores, once per frame, then hide', async () => {
    installChromeMock();
    const { list } = buildStashList();
    list.render([stash()]);
    const { progress, fill, label } = addProgressChildren(list.listEl.querySelector('.stash-card'));

    // Not active yet: ignored.
    list._onRestoreProgress({ action: 'restoreProgress', restoreId: 's1', created: 1, loaded: 0, total: 4 });
    expect(list._progressRafId).toBeNull();

    list.beginRestore('s1');
    list._onRestoreProgress({ action: 'restoreProgress', restoreId: 's1', created: 1, loaded: 0, total: 4 });
    list._onRestoreProgress({ action: 'restoreProgress', restoreId: 's1', created: 4, loaded: 0, total: 4 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(progress.classList.contains('active')).toBe(true);
    expect(label.textContent).toBe('Creating tabs... (4 / 4)');
    expect(fill.classList.contains('loading')).toBe(true);

    list.updateProgress('s1', 4, 2, 4);
    expect(label.textContent).toBe('Loading... 2 / 4 tabs ready');
    expect(fill.style.width).toBe('50%');
    list.updateProgress('s1', 4, 4, 4);
    expect(label.textContent).toBe('Finishing up...');
    expect(fill.classList.contains('loading')).toBe(false);

    list.endRestore('s1');
    list.hideProgress('s1');
    expect(progress.classList.contains('active')).toBe(false);
    expect(fill.style.width).toBe('0%');
    // Unknown ids are a no-op.
    list.updateProgress('missing', 1, 1, 1);
    list.hideProgress('missing');
  });

  test('Drive upload reports success and failure and re-enables the button', async () => {
    let fail = false;
    installChromeMock({ runtimeHandler: routedHandler({ exportStashToDrive: () => (fail ? { error: 'denied' } : {}) }) });
    const { list } = buildStashList();
    list.driveConnected = true;
    const card = list.createStashCard(stash());
    const driveBtn = card.querySelectorAll('button')[3];
    driveBtn.click();
    await flush();
    expect(toasts().at(-1)).toMatchObject({ type: 'success', message: '"github.com" saved to Drive' });
    expect(driveBtn.disabled).toBe(false);
    fail = true;
    driveBtn.click();
    await flush();
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Drive upload failed: denied' });
    expect(driveBtn.disabled).toBe(false);
  });

  test('delete shows an 8s Undo; Undo restores the record and refreshes', async () => {
    const sent = [];
    installChromeMock({ runtimeHandler: routedHandler({ deleteStash: {}, undoDeleteStash: {}, listStashes: [] }, sent) });
    const { list } = buildStashList();
    const record = stash();
    await list.deleteStash(record);
    expect(toasts().at(-1)).toMatchObject({ type: 'success', message: 'Deleted "github.com"', action: 'Undo', duration: '8000' });
    lastToastAction().click();
    await flush();
    expect(sent.find((m) => m.action === 'undoDeleteStash')).toEqual({ action: 'undoDeleteStash', stash: record });
    expect(toasts().at(-1)).toMatchObject({ type: 'success', message: 'Restored "github.com"' });
  });

  test('delete failure keeps the record; Undo and refresh failures are reported', async () => {
    let routes = { deleteStash: { error: 'locked' } };
    installChromeMock({ runtimeHandler: (m) => routedHandler(routes)(m) });
    const { list } = buildStashList();
    await list.deleteStash(stash());
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Delete failed: locked', action: null });

    routes = { deleteStash: {}, listStashes: { error: 'offline' }, undoDeleteStash: { error: 'gone' } };
    await list.deleteStash(stash());
    expect(toasts().at(-1)).toMatchObject({
      type: 'error',
      message: 'Deleted "github.com", but the view could not refresh: offline',
      action: 'Undo',
    });
    lastToastAction().click();
    await flush();
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Undo failed: gone' });

    routes = { deleteStash: {}, listStashes: { error: 'offline' }, undoDeleteStash: {} };
    await list.deleteStash(stash());
    lastToastAction().click();
    await flush();
    expect(toasts().at(-1).message).toBe('Restored "github.com", but the view could not refresh: offline');
  });

  test('exportStashes reports an empty export as info and failures as errors', async () => {
    let response = { stashes: [] };
    installChromeMock({ runtimeHandler: routedHandler({ buildPortableExport: () => response }) });
    const { list } = buildStashList();
    await list.exportStashes();
    expect(toasts().at(-1)).toMatchObject({ type: 'info', message: 'No stashes to export' });
    response = { error: 'disk' };
    await list.exportStashes();
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Export failed: disk' });
  });

  test('importStashes ignores an empty file selection and resets the input after failure', async () => {
    installChromeMock();
    const { list } = buildStashList();
    const target = { files: [], value: 'C:\\fake' };
    await list.importStashes({ target });
    expect(target.value).toBe('C:\\fake');

    const bad = { files: [{ name: 'x.json', size: 5, text: async () => 'nope', type: 'application/json' }], value: 'C:\\x' };
    await list.importStashes({ target: bad });
    expect(bad.value).toBe('');
    expect(toasts().at(-1).type).toBe('error');
    expect(toasts().at(-1).message.startsWith('Import failed: ')).toBe(true);
  });
});

// ── SessionManager ──

describe('SessionManager', () => {
  test('sub-tabs switch lists and keep aria-selected in sync', () => {
    installChromeMock();
    const { root, manager } = buildSessionManager();
    const [savedTab, autoTab] = root.querySelectorAll('.session-sub-nav [role="tab"]');
    autoTab.click();
    expect(autoTab.getAttribute('aria-selected')).toBe('true');
    expect(savedTab.getAttribute('aria-selected')).toBe('false');
    expect(manager.savedListEl.hidden).toBe(true);
    expect(manager.autoListEl.hidden).toBe(false);
    savedTab.click();
    expect(manager.savedListEl.hidden).toBe(false);
    expect(manager.autoListEl.hidden).toBe(true);
  });

  test('render splits saved and [Auto] sessions, strips the prefix and badges the auto count', () => {
    installChromeMock();
    const { root, manager } = buildSessionManager();
    manager.render([
      { id: 'a', name: 'Work', createdAt: Date.now(), windows: [] },
      { id: 'b', name: '[Auto] Hourly', createdAt: Date.now(), windows: [] },
      { id: 'c', name: '[Auto] Daily', createdAt: Date.now(), windows: [] },
    ]);
    expect(manager.savedListEl.querySelectorAll('.session-card')).toHaveLength(1);
    const autoNames = manager.autoListEl.querySelectorAll('.session-name').map((el) => el.textContent);
    expect(autoNames).toEqual(['Hourly', 'Daily']);
    expect(manager.autoListEl.querySelector('.session-card').classList.contains('session-auto')).toBe(true);
    const autoTab = root.querySelector('[data-session-tab="auto"]');
    expect(autoTab.querySelector('.session-auto-count').textContent).toBe('2');

    // Re-render replaces the badge rather than stacking; zero autos removes it.
    manager.render([{ id: 'a', name: 'Work', createdAt: Date.now(), windows: [] }]);
    expect(autoTab.querySelectorAll('.session-auto-count')).toHaveLength(0);
    expect(manager.autoListEl.querySelector('.empty-state-action').textContent).toBe('Set up auto-save');
  });

  test('empty states: saved focuses the name input, auto navigates to automation settings', () => {
    installChromeMock();
    const navigated = [];
    const { root, manager } = buildSessionManager({ navigate: (to) => navigated.push(to) });
    manager.render(null);
    manager.savedListEl.querySelector('.empty-state-action').click();
    expect(dom.document.activeElement).toBe(root.querySelector('#session-name'));
    manager.autoListEl.querySelector('.empty-state-action').click();
    expect(navigated).toEqual([{ view: 'settings', sectionId: 'settings-automation-section' }]);

    manager.render([{ id: 'b', name: '[Auto] X', windows: [] }]);
    expect(manager.savedListEl.querySelector('.empty-state-action').textContent).toBe('Name a session');
  });

  test('buildMetaText handles legacy v1 sessions and missing dates', () => {
    installChromeMock();
    const { manager } = buildSessionManager();
    expect(manager.buildMetaText({ tabs: [{}, {}] })).toBe('2 tabs');
    expect(manager.buildMetaText({})).toBe('0 tabs');
    expect(manager.buildMetaText({ windows: [{ tabs: [{}] }] })).toBe('1 tab · 1 window');
  });

  test('restore buttons send the mode, report failures, and track concurrent restores per id', async () => {
    const sent = [];
    const releases = [];
    installChromeMock({
      runtimeHandler: routedHandler({
        restoreSession: () => new Promise((resolve) => releases.push(resolve)),
      }, sent),
    });
    const { manager } = buildSessionManager();
    const card = manager.createSessionCard({ id: 'x', name: 'Work', windows: [] }, false);
    manager.savedListEl.appendChild(card);
    const { progress } = addProgressChildren(card);
    const [restoreBtn, hereBtn] = card.querySelectorAll('button');

    restoreBtn.click();
    hereBtn.click();
    await flush();
    expect(sent.map((m) => m.options.mode)).toEqual(['windows', 'here']);
    expect(restoreBtn.textContent).toBe('Restoring...');
    manager.updateProgress('x', 2, 1, 4);
    expect(progress.classList.contains('active')).toBe(true);

    releases[0]({ requestedCount: 1, restoredCount: 1, skippedDuplicate: 0, skippedInvalid: 0, errors: [], complete: true });
    await flush();
    // The other restore of the same id is still running: progress stays.
    expect(manager.isRestoreActive('x')).toBe(true);
    expect(progress.classList.contains('active')).toBe(true);
    expect(restoreBtn.disabled).toBe(false);
    expect(restoreBtn.textContent).toBe('Restore');

    releases[1]({ error: 'No tab with id: 1' });
    await flush();
    expect(manager.isRestoreActive('x')).toBe(false);
    expect(progress.classList.contains('active')).toBe(false);
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Restore failed: That tab is already closed.' });
  });

  test('progress for an auto-save card is found in the auto list', () => {
    installChromeMock();
    const { manager } = buildSessionManager();
    const card = manager.createSessionCard({ id: 'auto1', name: '[Auto] A', windows: [] }, true);
    manager.autoListEl.appendChild(card);
    const { label, fill } = addProgressChildren(card);
    manager.updateProgress('auto1', 3, 0, 3);
    expect(label.textContent).toBe('Creating tabs... (3 / 3)');
    manager.updateProgress('auto1', 3, 1, 3);
    expect(label.textContent).toBe('Loading... 1 / 3 tabs ready');
    expect(fill.style.width).toBe('33%');
    manager.hideProgress('auto1');
    expect(fill.style.width).toBe('0%');
  });

  test('delete shows Undo; a vanished session reports and refreshes; failures are plain', async () => {
    const sent = [];
    let deleteResponse = { deleted: true };
    let undoResponse = { restored: true };
    installChromeMock({
      runtimeHandler: routedHandler({
        deleteSession: () => deleteResponse,
        undoDeleteSession: () => undoResponse,
        listSessions: [],
      }, sent),
    });
    const { manager } = buildSessionManager();
    const session = { id: 'x', name: 'Work', windows: [] };

    expect(await manager.deleteSessionRecord(session)).toBe(true);
    expect(toasts().at(-1)).toMatchObject({ type: 'success', message: 'Deleted "Work"', action: 'Undo', duration: '8000' });
    lastToastAction().click();
    await flush();
    expect(sent.find((m) => m.action === 'undoDeleteSession')).toEqual({ action: 'undoDeleteSession', session });
    expect(toasts().at(-1)).toMatchObject({ type: 'success', message: 'Restored "Work"' });

    // Worker did not confirm the restore.
    await manager.deleteSessionRecord(session);
    undoResponse = { restored: false };
    lastToastAction().click();
    await flush();
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Undo failed: Worker did not confirm the restore' });

    deleteResponse = { deleted: false };
    expect(await manager.deleteSessionRecord(session)).toBe(false);
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Session was not deleted because it no longer exists' });

    deleteResponse = { error: 'locked' };
    expect(await manager.deleteSessionRecord(session)).toBe(false);
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Delete failed: locked' });
  });

  test('delete and undo whose refresh fails still offer Undo and say the view is stale', async () => {
    installChromeMock({
      runtimeHandler: routedHandler({
        deleteSession: { deleted: true },
        undoDeleteSession: { restored: true },
        listSessions: { error: 'offline' },
      }),
    });
    const { manager } = buildSessionManager();
    await manager.deleteSessionRecord({ id: 'x', name: 'Work' });
    expect(toasts().at(-1)).toMatchObject({
      type: 'error',
      message: 'Deleted "Work", but the view could not refresh',
      action: 'Undo',
    });
    lastToastAction().click();
    await flush();
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Restored "Work", but the view could not refresh' });
  });

  test('save whose refresh fails reports the save and the refresh error', async () => {
    installChromeMock({ runtimeHandler: routedHandler({ saveSession: {}, listSessions: { error: 'offline' } }) });
    const { root, manager } = buildSessionManager();
    root.querySelector('#session-name').value = 'Mine';
    await manager.saveSession();
    expect(root.querySelector('#session-name').value).toBe('');
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Session "Mine" was saved, but the view could not refresh: offline' });
  });

  test('save failure keeps the typed name', async () => {
    installChromeMock({ runtimeHandler: routedHandler({ saveSession: { error: 'locked' } }) });
    const { root, manager } = buildSessionManager();
    root.querySelector('#session-name').value = 'Mine';
    await manager.saveSession();
    expect(root.querySelector('#session-name').value).toBe('Mine');
    expect(toasts().at(-1).message).toBe('Could not save session: locked');
  });

  test('per-session export failure and full export failure are reported', async () => {
    installChromeMock({
      runtimeHandler: routedHandler({ buildPortableSessionExport: { error: 'x' }, buildPortableExport: { error: 'y' } }),
    });
    const { manager } = buildSessionManager();
    const card = manager.createSessionCard({ id: 'x', name: 'Work', windows: [] }, false);
    card.querySelectorAll('button')[2].click();
    await flush();
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Export failed: x' });
    await manager.export();
    expect(toasts().at(-1)).toMatchObject({ type: 'error', message: 'Export failed: y' });
  });

  test('refresh failure notifies with a friendly message by default', async () => {
    installChromeMock({ runtimeHandler: routedHandler({ listSessions: { error: 'QuotaExceededError: x' } }) });
    const { manager } = buildSessionManager();
    expect(await manager.refresh()).toBe(false);
    expect(toasts().at(-1).message).toBe('Could not load sessions: Browser storage is full. Delete some stashes or sessions, then try again.');
  });
});
