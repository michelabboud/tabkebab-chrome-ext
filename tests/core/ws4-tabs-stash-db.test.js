import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { closeTabs, getAllTabs, excludeIncognitoTabs } from '../../core/tabs-api.js';

describe('closeTabs (4.8)', () => {
  test('closes every live tab when a stale id stops the batch remove midway', async () => {
    const harness = installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://a.test/' },
        { id: 2, windowId: 1, url: 'https://b.test/' },
        { id: 3, windowId: 1, url: 'https://c.test/' },
        { id: 4, windowId: 1, url: 'https://d.test/', active: true },
      ],
    });

    const closed = await closeTabs([1, 99, 2, 3]);

    expect(closed).toBe(3);
    const remaining = harness.snapshot().tabs.map(({ id }) => id);
    expect(remaining).toEqual([4]);
  });

  test('returns the full count on a clean batch and 0 when every id is stale', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://a.test/' },
        { id: 2, windowId: 1, url: 'https://b.test/', active: true },
      ],
    });
    expect(await closeTabs([1])).toBe(1);
    expect(await closeTabs([50, 51])).toBe(0);
    expect(await closeTabs([])).toBe(0);
  });

  test('rethrows errors other than a missing tab', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [{ id: 1, windowId: 1, url: 'https://a.test/' }],
      failures: { 'tabs.remove': new Error('Tabs cannot be edited right now') },
    });
    await expect(closeTabs([1])).rejects.toThrow('Tabs cannot be edited right now');
  });
});

describe('getAllTabs incognito filtering (4.5)', () => {
  test('excludeIncognito drops private tabs; the default keeps them', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }, { id: 2, incognito: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://public.test/' },
        { id: 2, windowId: 2, url: 'https://private.test/', incognito: true },
      ],
    });
    expect((await getAllTabs({ allWindows: true })).map(({ id }) => id)).toEqual([1, 2]);
    expect((await getAllTabs({ allWindows: true, excludeIncognito: true })).map(({ id }) => id)).toEqual([1]);
    expect(excludeIncognitoTabs([{ id: 1 }, { id: 2, incognito: true }])).toEqual([{ id: 1 }]);
  });

  test('saved sessions never contain incognito tabs', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }, { id: 2, incognito: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://public.test/', title: 'Public' },
        { id: 2, windowId: 2, url: 'https://private.test/', title: 'Private', incognito: true },
      ],
    });
    const { saveSession } = await import('../../core/sessions.js?ws4-incognito');
    const session = await saveSession('Test');
    const urls = session.windows.flatMap((w) => w.tabs.map((t) => t.url));
    expect(urls).toEqual(['https://public.test/']);
  });
});

describe('manifest (4.6)', () => {
  test('requests unlimitedStorage', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
    expect(manifest.permissions).toContain('unlimitedStorage');
  });
});

describe('stash-db write transactions settle on abort (4.7)', () => {
  function installAbortingIndexedDB({ fire }) {
    const db = {
      objectStoreNames: { contains: () => true },
      transaction() {
        const tx = {
          error: null,
          objectStore() {
            const request = () => ({ error: null, onerror: null, onsuccess: null, result: undefined });
            return {
              put: request,
              delete: request,
              clear: request,
              get() {
                const req = request();
                queueMicrotask(() => req.onsuccess?.());
                return req;
              },
            };
          },
          abort() {},
          oncomplete: null,
          onerror: null,
          onabort: null,
        };
        setTimeout(() => fire(tx), 0);
        return tx;
      },
    };
    const original = globalThis.indexedDB;
    globalThis.indexedDB = {
      open() {
        const request = { result: db, error: null, onsuccess: null, onerror: null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    };
    return () => {
      if (original === undefined) delete globalThis.indexedDB;
      else globalThis.indexedDB = original;
    };
  }

  test('saveStash, deleteStash, clearAllStashes and importStashes reject on abort without onerror', async () => {
    const restore = installAbortingIndexedDB({
      fire: (tx) => {
        tx.error = new DOMException('Quota exceeded', 'QuotaExceededError');
        tx.onabort?.();
      },
    });
    try {
      const db = await import(`../../core/stash-db.js?ws4-abort=${Date.now()}`);
      const stash = { id: 's1', createdAt: 1, windows: [] };
      await expect(db.saveStash(stash)).rejects.toThrow('Quota exceeded');
      await expect(db.deleteStash('s1')).rejects.toThrow('Quota exceeded');
      await expect(db.clearAllStashes()).rejects.toThrow('Quota exceeded');
      await expect(db.importStashes([stash])).rejects.toThrow('Quota exceeded');
    } finally {
      restore();
    }
  });

  test('an abort with no error object still rejects; commit resolves', async () => {
    let mode = 'abort';
    const restore = installAbortingIndexedDB({
      fire: (tx) => (mode === 'abort' ? tx.onabort?.() : tx.oncomplete?.()),
    });
    try {
      const db = await import(`../../core/stash-db.js?ws4-abort-plain=${Date.now()}`);
      await expect(db.saveStash({ id: 's1' })).rejects.toThrow('aborted');
      mode = 'complete';
      await expect(db.saveStash({ id: 's1' })).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });
});
