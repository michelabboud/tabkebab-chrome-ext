import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { installChromeMock } from '../helpers/chrome-mock.js';

let workerNonce = 0;
async function freshWorker(label) {
  return import(`../../service-worker.js?ws4=${label}-${++workerNonce}`);
}

const DAY = 24 * 60 * 60 * 1000;

// ── Minimal in-memory IndexedDB for stash writes ──

const stashRecords = new Map();
let originalIndexedDB;

function installMemoryIndexedDB() {
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        abort() {},
        objectStore() {
          return {
            put(record) {
              stashRecords.set(record.id, structuredClone(record));
              return {};
            },
            delete(id) {
              stashRecords.delete(id);
              return {};
            },
            clear() {
              stashRecords.clear();
              return {};
            },
            get(id) {
              const req = { result: stashRecords.get(id), onsuccess: null, onerror: null };
              queueMicrotask(() => req.onsuccess?.());
              return req;
            },
          };
        },
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
  };
  globalThis.indexedDB = {
    open() {
      const request = { result: db, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
}

beforeAll(() => {
  originalIndexedDB = globalThis.indexedDB;
  installMemoryIndexedDB();
});
afterAll(() => {
  if (originalIndexedDB === undefined) delete globalThis.indexedDB;
  else globalThis.indexedDB = originalIndexedDB;
});
beforeEach(() => stashRecords.clear());

// ── Bookmark tree helpers ──

function flatten(nodes, depth = 0, out = []) {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children) flatten(node.children, depth + 1, out);
  }
  return out;
}

/** Depth relative to the bookmark bar: bar children = 1. */
function bookmarkEntries(harness) {
  const [treeRoot] = harness.snapshot().bookmarks;
  return flatten(treeRoot.children, 0);
}

function maxFolderDepth(harness) {
  return Math.max(0, ...bookmarkEntries(harness)
    .filter(({ node }) => !node.url)
    .map(({ depth }) => depth));
}

function findFolder(harness, title) {
  return bookmarkEntries(harness).find(({ node }) => !node.url && node.title === title)?.node;
}

function bookmarkUrls(harness) {
  return bookmarkEntries(harness).filter(({ node }) => node.url).map(({ node }) => node.url);
}

function snapshotData(tabCount = 2) {
  return {
    id: 'snap',
    date: '2026-10-08',
    time: '10:00',
    createdAt: 1,
    formats: {
      byWindows: [{
        name: 'Window 1',
        tabs: Array.from({ length: tabCount }, (_, i) => ({ title: `Tab ${i}`, url: `https://t${i}.test/` })),
      }],
    },
  };
}

async function makeNestedRoot(levels) {
  let parentId = '1';
  for (const title of levels) {
    const folder = await chrome.bookmarks.create({ parentId, title });
    parentId = folder.id;
  }
  return chrome.bookmarks.create({ parentId, title: 'TabKebab' });
}

// ── 4.1 ──

describe('bookmark HTML export search (4.1)', () => {
  test('search highlighting never re-parses titles as HTML', async () => {
    const worker = await freshWorker('html');
    const html = worker.generateBookmarkHtml({
      date: '2026-10-08',
      time: '10:00',
      formats: {
        byWindows: [{ name: 'Window 1', tabs: [{ title: '<img src=x onerror=alert(1)>', url: 'https://x.test/' }] }],
      },
    });
    const script = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));
    expect(script).not.toContain('innerHTML');
    expect(script).not.toContain('outerHTML');
    expect(html).not.toContain('<img src=x');

    // Execute the real highlight helpers against a tiny DOM double.
    const source = script.match(/function setPlainText[\s\S]*?\n  }\n\n  function clearHighlights[\s\S]*?\n  }\n\n  function highlightText[\s\S]*?\n  }/)[0];
    const textNode = (text) => ({ nodeType: 3, textContent: text });
    const fakeDocument = {
      createTextNode: textNode,
      createElement(tag) {
        const el = { tag, children: [], appendChild(child) { this.children.push(child); } };
        Object.defineProperty(el, 'textContent', { get() { return this.children.map((c) => c.textContent).join(''); } });
        return el;
      },
    };
    const el = {
      children: [textNode('<img src=x onerror=alert(1)>')],
      get firstChild() { return this.children[0]; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      appendChild(child) { this.children.push(child); },
      get textContent() { return this.children.map((c) => c.textContent).join(''); },
      set innerHTML(_value) { throw new Error('innerHTML must not be used'); },
    };
    const highlightText = new Function('document', 'allTabs', `${source}; return highlightText;`)(fakeDocument, []);
    highlightText(el, 'img');
    expect(el.children.map((c) => c.tag || 'text')).toEqual(['text', 'mark', 'text']);
    expect(el.children[1].textContent).toBe('img');
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

// ── 4.2 ──

describe('managed alarm reconciliation (4.2)', () => {
  const settings = {
    autoSaveIntervalHours: 24,
    autoKebabAfterHours: 0,
    autoStashAfterDays: 0,
    autoSyncToDriveIntervalHours: 0,
    autoBookmarkOnStash: false,
  };

  test('keeps unchanged alarms, recreates changed ones with a first delay, clears disabled ones', async () => {
    const harness = installChromeMock({ local: { tabkebabSettings: { ...settings, autoSyncToDriveIntervalHours: 3 } } });
    const worker = await freshWorker('alarms');
    await chrome.alarms.create('autoSaveSession', { periodInMinutes: 1440 });
    await chrome.alarms.create('retentionCleanup', { periodInMinutes: 720 });
    await chrome.alarms.create('autoSyncDrive', { periodInMinutes: 60 });
    await chrome.alarms.create('autoKebab', { periodInMinutes: 60 });
    const before = harness.calls.alarms.create.length;
    const clearsBefore = harness.calls.alarms.clear.length;

    await worker.reconfigureManagedAlarms();

    const created = harness.calls.alarms.create.slice(before).map(([name, info]) => [name, info]);
    expect(created).toEqual([['autoSyncDrive', { delayInMinutes: 180, periodInMinutes: 180 }]]);
    const cleared = harness.calls.alarms.clear.slice(clearsBefore).map(([name]) => name);
    expect(cleared).toEqual(['autoKebab']);
    const names = harness.snapshot().alarms.map(({ name }) => name).sort();
    expect(names).toEqual(['autoSaveSession', 'autoSyncDrive', 'retentionCleanup']);
  });

  test('repeated reconciliation (startup / settings save) does not reset running alarms', async () => {
    const harness = installChromeMock({ local: { tabkebabSettings: settings } });
    const worker = await freshWorker('alarms-repeat');
    await worker.reconfigureManagedAlarms();
    const after = harness.calls.alarms.create.length;
    await worker.reconfigureManagedAlarms();
    await worker.reconfigureManagedAlarms();
    expect(harness.calls.alarms.create.length).toBe(after);
    expect(worker.desiredManagedAlarmPeriods(settings)).toMatchObject({
      autoSaveSession: 1440,
      retentionCleanup: 720,
      autoKebab: null,
    });
  });
});

// ── 4.9 / 4.5 automation ──

describe('auto-kebab and auto-stash skip in-use and private tabs (4.9, 4.5)', () => {
  test('auto-kebab never discards an audible tab', async () => {
    const old = Date.now() - 5 * DAY;
    const harness = installChromeMock({
      local: { tabkebabSettings: { autoKebabAfterHours: 1 } },
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://focus.test/', active: true },
        { id: 2, windowId: 1, url: 'https://music.test/', audible: true, lastAccessed: old },
        { id: 3, windowId: 1, url: 'https://idle.test/', lastAccessed: old },
      ],
    });
    const worker = await freshWorker('kebab');
    await worker.handleAlarm({ name: 'autoKebab' });
    expect(harness.calls.tabs.discard.map(([id]) => id)).toEqual([3]);
  });

  test('auto-stash skips audible, pinned and incognito tabs', async () => {
    const old = Date.now() - 5 * DAY;
    const harness = installChromeMock({
      local: { tabkebabSettings: { autoStashAfterDays: 1 } },
      windows: [{ id: 1, focused: true }, { id: 2, incognito: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://focus.test/', active: true },
        { id: 2, windowId: 1, url: 'https://music.test/', audible: true, lastAccessed: old },
        { id: 3, windowId: 1, url: 'https://pinned.test/', pinned: true, lastAccessed: old },
        { id: 4, windowId: 1, url: 'https://idle.test/', lastAccessed: old },
        { id: 5, windowId: 2, url: 'https://private.test/', incognito: true, lastAccessed: old },
      ],
    });
    const worker = await freshWorker('autostash');
    await worker.autoStashOldTabs();

    const stashes = [...stashRecords.values()];
    expect(stashes).toHaveLength(1);
    expect(stashes[0].windows.flatMap((w) => w.tabs.map((t) => t.url))).toEqual(['https://idle.test/']);
    expect(harness.snapshot().tabs.map(({ id }) => id)).toEqual([1, 2, 3, 5]);
  });

  test('auto-save skips incognito tabs', async () => {
    const harness = installChromeMock({
      windows: [{ id: 1, focused: true }, { id: 2, incognito: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://a.test/', title: 'A' },
        { id: 2, windowId: 1, url: 'https://b.test/', title: 'B' },
        { id: 3, windowId: 2, url: 'https://private.test/', title: 'P', incognito: true },
      ],
    });
    const worker = await freshWorker('autosave');
    await worker.autoSaveSession();
    const sessions = harness.snapshot().local.sessions;
    const urls = sessions[0].windows.flatMap((w) => w.tabs.map((t) => t.url));
    expect(urls).toEqual(['https://a.test/', 'https://b.test/']);
  });
});

// ── 4.3 ──

describe('auto-bookmark on stash bookmarks exactly the captured tabs (4.3)', () => {
  const autoBookmarkSettings = {
    autoBookmarkOnStash: true,
    bookmarkByDomains: true,
    bookmarkDestination: 'chrome',
  };

  function recordOrder(events) {
    const create = chrome.bookmarks.create.bind(chrome.bookmarks);
    chrome.bookmarks.create = async (props) => {
      if (props.url) events.push(`bookmark:${props.url}`);
      return create(props);
    };
    const remove = chrome.tabs.remove.bind(chrome.tabs);
    chrome.tabs.remove = async (ids) => {
      events.push(`close:${[].concat(ids).join(',')}`);
      return remove(ids);
    };
  }

  test('stashWindow bookmarks the stashed window tabs before closing them', async () => {
    const harness = installChromeMock({
      local: { tabkebabSettings: autoBookmarkSettings },
      windows: [{ id: 1 }, { id: 2, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://stash-a.test/', title: 'A' },
        { id: 2, windowId: 1, url: 'https://stash-b.test/', title: 'B' },
        { id: 3, windowId: 2, url: 'https://keep.test/', title: 'Keep', active: true },
      ],
    });
    const worker = await freshWorker('stash-window-bookmark');
    const events = [];
    recordOrder(events);

    const result = await worker.handleMessage({ action: 'stashWindow', windowId: 1, windowNumber: 1 });
    expect(result.success).toBeTrue();
    expect(bookmarkUrls(harness).sort()).toEqual(['https://stash-a.test/', 'https://stash-b.test/']);
    const closeIndex = events.findIndex((e) => e.startsWith('close:'));
    expect(closeIndex).toBeGreaterThan(events.lastIndexOf('bookmark:https://stash-b.test/'));
    expect(findFolder(harness, '2026-10-08') ?? findFolder(harness, new Date().toISOString().slice(0, 10))).toBeDefined();
  });

  test('stashGroup and stashDomain also auto-bookmark their captured tabs', async () => {
    const harness = installChromeMock({
      local: { tabkebabSettings: autoBookmarkSettings },
      windows: [{ id: 1, focused: true }],
      groups: [{ id: 10, windowId: 1, title: 'Research' }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://grouped.test/', title: 'G', groupId: 10 },
        { id: 2, windowId: 1, url: 'https://domain.test/one', title: 'D1' },
        { id: 3, windowId: 1, url: 'https://domain.test/two', title: 'D2' },
        { id: 4, windowId: 1, url: 'https://keep.test/', title: 'Keep', active: true },
      ],
    });
    const worker = await freshWorker('stash-group-domain-bookmark');

    expect((await worker.handleMessage({ action: 'stashGroup', groupId: 10 })).success).toBeTrue();
    expect(bookmarkUrls(harness)).toEqual(['https://grouped.test/']);

    expect((await worker.handleMessage({ action: 'stashDomain', domain: 'domain.test' })).success).toBeTrue();
    expect(bookmarkUrls(harness).sort()).toEqual([
      'https://domain.test/one',
      'https://domain.test/two',
      'https://grouped.test/',
    ]);
    expect(bookmarkUrls(harness)).not.toContain('https://keep.test/');
  });

  test('a stash auto-bookmark writes only Chrome bookmarks, never the local history or Drive', async () => {
    const harness = installChromeMock({
      local: {
        tabkebabSettings: { ...autoBookmarkSettings, bookmarkDestination: 'all', exportHtmlBookmarkToDrive: true },
        driveSync: { connected: true },
      },
      windows: [{ id: 1 }, { id: 2, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://stash-a.test/', title: 'A' },
        { id: 3, windowId: 2, url: 'https://keep.test/', title: 'Keep', active: true },
      ],
    });
    const originalFetch = globalThis.fetch;
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      throw new Error('network disabled in test');
    };
    try {
      const worker = await freshWorker('stash-bookmark-chrome-only');
      const result = await worker.handleMessage({ action: 'stashWindow', windowId: 1 });
      expect(result.success).toBeTrue();
      expect(bookmarkUrls(harness)).toEqual(['https://stash-a.test/']);
      expect(harness.snapshot().local.tabkebabBookmarks).toBeUndefined();
      expect(fetched).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a bookmark failure never blocks the stash', async () => {
    installChromeMock({
      local: { tabkebabSettings: autoBookmarkSettings },
      windows: [{ id: 1 }, { id: 2, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://stash-a.test/', title: 'A' },
        { id: 3, windowId: 2, url: 'https://keep.test/', active: true },
      ],
      failures: { 'bookmarks.getTree': new Error('bookmarks unavailable') },
    });
    const worker = await freshWorker('stash-bookmark-failure');
    const result = await worker.handleMessage({ action: 'stashWindow', windowId: 1 });
    expect(result.success).toBeTrue();
    expect(stashRecords.size).toBe(1);
  });

  test('manual bookmark export excludes incognito tabs (4.5)', async () => {
    const harness = installChromeMock({
      windows: [{ id: 1, focused: true }, { id: 2, incognito: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://public.test/', title: 'Public', active: true },
        { id: 2, windowId: 2, url: 'https://private.test/', title: 'Private', incognito: true },
      ],
    });
    const worker = await freshWorker('bookmark-incognito');
    await worker.createBookmarks({ byWindows: true, byGroups: true, byDomains: true, destination: 'chrome' });
    expect(bookmarkUrls(harness).every((url) => url === 'https://public.test/')).toBeTrue();
    expect(bookmarkUrls(harness).length).toBe(3);
  });
});

// ── 4.4 / 4.11 ──

describe('Chrome bookmark export layout (4.4, 4.11)', () => {
  test('the scheduled snapshot replaces the day folder instead of duplicating it', async () => {
    const harness = installChromeMock({
      local: { tabkebabSettings: { autoBookmarkOnStash: true, bookmarkByWindows: true, bookmarkByDomains: true, bookmarkDestination: 'chrome' } },
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 1, windowId: 1, url: 'https://a.test/', title: 'A', active: true }],
    });
    const worker = await freshWorker('alarm-replace');
    await worker.handleAlarm({ name: 'autoBookmark' });
    await worker.handleAlarm({ name: 'autoBookmark' });
    await worker.handleAlarm({ name: 'autoBookmark' });

    const dateFolder = findFolder(harness, new Date().toISOString().slice(0, 10));
    expect(dateFolder.children.map((c) => c.title)).toEqual(['Windows', 'Domains']);
    expect(bookmarkUrls(harness)).toEqual(['https://a.test/', 'https://a.test/']);
  });

  test('replacement keeps stash bookmark folders of the same day', async () => {
    const harness = installChromeMock();
    const worker = await freshWorker('replace-keeps-stash');
    await worker.saveToChromeBookmarks(snapshotData(1), '2026-10-08', { stashLabel: 'Stash 09:00' });
    await worker.saveToChromeBookmarks(snapshotData(1), '2026-10-08');
    await worker.saveToChromeBookmarks(snapshotData(1), '2026-10-08');
    const dateFolder = findFolder(harness, '2026-10-08');
    expect(dateFolder.children.map((c) => c.title)).toEqual(['Stash 09:00', 'Windows']);
  });

  test('default layout under the bar fits MAX_BOOKMARK_DEPTH exactly', async () => {
    const harness = installChromeMock();
    const worker = await freshWorker('depth-1');
    expect(worker.MAX_BOOKMARK_DEPTH).toBe(4);
    await worker.saveToChromeBookmarks(snapshotData(), '2026-10-08');
    expect(maxFolderDepth(harness)).toBe(4);
    expect(findFolder(harness, 'Window 1')).toBeDefined();
  });

  test('a stash export under the bar drops the section layer first', async () => {
    const harness = installChromeMock();
    const worker = await freshWorker('depth-stash');
    await worker.saveToChromeBookmarks(snapshotData(), '2026-10-08', { stashLabel: 'Stash 10:00' });
    expect(maxFolderDepth(harness)).toBeLessThanOrEqual(4);
    const stashFolder = findFolder(harness, 'Stash 10:00');
    expect(stashFolder.children.map((c) => c.title)).toEqual(['Windows · Window 1']);
  });

  test('root at depth 2 (stored id, renamed) flattens the section layer', async () => {
    const harness = installChromeMock();
    const worker = await freshWorker('depth-2');
    const outer = await chrome.bookmarks.create({ parentId: '1', title: 'Archive' });
    const root = await chrome.bookmarks.create({ parentId: outer.id, title: 'My Tab Snapshots' });
    await chrome.storage.local.set({ bookmarkRootFolderId: root.id });

    await worker.saveToChromeBookmarks(snapshotData(), '2026-10-08');
    expect(maxFolderDepth(harness)).toBeLessThanOrEqual(4);
    expect(findFolder(harness, 'TabKebab')).toBeUndefined();
    const dateFolder = findFolder(harness, '2026-10-08');
    expect(dateFolder.parentId).toBe(root.id);
    expect(dateFolder.children.map((c) => c.title)).toEqual(['Windows · Window 1']);
  });

  test('root at depth 3 (found by title) flattens section and item layers', async () => {
    const harness = installChromeMock();
    const worker = await freshWorker('depth-3');
    const root = await makeNestedRoot(['A', 'B']);

    await worker.saveToChromeBookmarks(snapshotData(), '2026-10-08');
    expect(maxFolderDepth(harness)).toBeLessThanOrEqual(4);
    const dateFolder = findFolder(harness, '2026-10-08');
    expect(dateFolder.parentId).toBe(root.id);
    expect(dateFolder.children.map((c) => c.title)).toEqual(['Windows · Window 1 · Tab 0', 'Windows · Window 1 · Tab 1']);
    expect(harness.snapshot().local.bookmarkRootFolderId).toBe(root.id);
  });

  test('root at the depth limit creates no folders at all', async () => {
    const harness = installChromeMock();
    const worker = await freshWorker('depth-4');
    const root = await makeNestedRoot(['A', 'B', 'C']);
    const before = maxFolderDepth(harness);

    await worker.saveToChromeBookmarks(snapshotData(1), '2026-10-08');
    expect(maxFolderDepth(harness)).toBe(before);
    const [rootNode] = await chrome.bookmarks.get(root.id);
    expect(rootNode.children.map((c) => c.title)).toEqual(['2026-10-08 · Windows · Window 1 · Tab 0']);
  });

  test('depth helpers never exceed the budget', async () => {
    const worker = await freshWorker('depth-helpers');
    expect(worker.bookmarkDepthBudget(1)).toBe(3);
    expect(worker.bookmarkDepthBudget(6)).toBe(0);
    const kinds = ['date', 'stash', 'section', 'item'];
    for (let budget = 0; budget <= 5; budget++) {
      expect(worker.planBookmarkFolderLevels(kinds, budget).size).toBeLessThanOrEqual(budget);
    }
    expect([...worker.planBookmarkFolderLevels(kinds, 3)]).toEqual(['date', 'stash', 'item']);
    expect([...worker.planBookmarkFolderLevels(kinds, 2)]).toEqual(['date', 'stash']);
    expect([...worker.planBookmarkFolderLevels(kinds, 1)]).toEqual(['date']);
  });

  test('the stored root id is reused; a deleted root is recreated and re-stored', async () => {
    const harness = installChromeMock();
    const worker = await freshWorker('root-id');
    await worker.saveToChromeBookmarks(snapshotData(1), '2026-10-08');
    const firstId = harness.snapshot().local.bookmarkRootFolderId;
    expect(firstId).toBeString();

    await chrome.bookmarks.update(firstId, { title: 'Renamed' });
    await worker.saveToChromeBookmarks(snapshotData(1), '2026-10-09');
    expect(findFolder(harness, 'TabKebab')).toBeUndefined();
    expect(harness.snapshot().local.bookmarkRootFolderId).toBe(firstId);

    await chrome.bookmarks.removeTree(firstId);
    await worker.saveToChromeBookmarks(snapshotData(1), '2026-10-10');
    const newId = harness.snapshot().local.bookmarkRootFolderId;
    expect(findFolder(harness, 'TabKebab').id).toBe(newId);
    const rootCreates = harness.calls.bookmarks.create.filter(([props]) => props.title === 'TabKebab');
    expect(rootCreates).toHaveLength(2);
  });

  test('retention keeps only the newest N date folders and ignores other folders', async () => {
    const harness = installChromeMock();
    const worker = await freshWorker('retention');
    expect(worker.BOOKMARK_RETENTION_COUNT).toBe(30);
    const root = await chrome.bookmarks.create({ parentId: '1', title: 'TabKebab' });
    for (let day = 1; day <= 35; day++) {
      const date = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
      await chrome.bookmarks.create({ parentId: root.id, title: date });
    }
    await chrome.bookmarks.create({ parentId: root.id, title: 'Notes' });
    await chrome.bookmarks.create({ parentId: root.id, title: '2020-1-1' });

    await worker.saveToChromeBookmarks(snapshotData(1), '2026-10-08');
    const titles = (await chrome.bookmarks.getChildren(root.id)).map((n) => n.title);
    const dated = titles.filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t)).sort();
    expect(dated).toHaveLength(30);
    expect(dated.at(-1)).toBe('2026-10-08');
    expect(dated[0]).toBe('2026-01-07');
    expect(titles).toContain('Notes');
    expect(titles).toContain('2020-1-1');
    expect(harness.calls.bookmarks.removeTree.length).toBe(6);
  });

  test('exports stop at the bookmark cap and report truncation', async () => {
    const harness = installChromeMock();
    const worker = await freshWorker('cap');
    expect(worker.MAX_BOOKMARKS_PER_EXPORT).toBe(5000);
    const result = await worker.saveToChromeBookmarks(snapshotData(10), '2026-10-08', { maxBookmarks: 6 });
    expect(result).toMatchObject({ created: 6, truncated: true });
    // root (not counted) + date + Windows + Window 1 + 3 tabs
    expect(bookmarkUrls(harness)).toHaveLength(3);

    const full = await worker.saveToChromeBookmarks(snapshotData(2), '2026-10-09', { maxBookmarks: 100 });
    expect(full.truncated).toBeFalse();
  });
});

// ── 4.10 ──

describe('side panel open requires a user gesture (4.10)', () => {
  test('the worker never calls chrome.sidePanel.open outside a gesture handler', () => {
    const source = readFileSync(new URL('../../service-worker.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/chrome\.sidePanel\.open\(/);
  });

  test('Focus distraction handling never calls chrome.sidePanel.open (no gesture there)', () => {
    const source = readFileSync(new URL('../../core/focus.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/chrome\.sidePanel\.open\(/);
  });
});

describe('stash names count only the tabs actually stored', () => {
  test('stashWindow and stashGroup names exclude non-restorable tabs', async () => {
    installChromeMock({
      windows: [{ id: 1 }, { id: 2, focused: true }],
      groups: [{ id: 10, windowId: 2, title: 'Research' }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://a.test/', title: 'A' },
        { id: 2, windowId: 1, url: 'chrome://settings/', title: 'Settings' },
        { id: 3, windowId: 1, url: 'https://b.test/', title: 'B' },
        { id: 4, windowId: 2, url: 'https://g.test/', title: 'G', groupId: 10 },
        { id: 5, windowId: 2, url: 'chrome://history/', title: 'H', groupId: 10 },
        { id: 6, windowId: 2, url: 'https://keep.test/', title: 'Keep', active: true },
      ],
    });
    const worker = await freshWorker('stash-names');

    const windowResult = await worker.handleMessage({ action: 'stashWindow', windowId: 1, windowNumber: 1 });
    expect(windowResult.stash.name).toBe('Window 1 (2 tabs)');
    expect(windowResult.stash.tabCount).toBe(2);

    const groupResult = await worker.handleMessage({ action: 'stashGroup', groupId: 10 });
    expect(groupResult.stash.name).toBe('Research [group] (1 tabs)');
    expect(groupResult.stash.tabCount).toBe(1);
  });
});
