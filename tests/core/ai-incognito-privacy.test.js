import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('AI features never read incognito tabs', () => {
  test('every AI handler reads tabs with excludeIncognito', () => {
    const src = read('core/background/ai.js');
    const calls = src.match(/getAllTabs\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('excludeIncognito: true');
  });

  test('Focus AI checks skip incognito tabs', () => {
    const src = read('core/background/focus.js');
    const guards = src.match(/state\.aiBlocking && [^{]*\{/g) || [];
    expect(guards.length).toBe(2);
    for (const g of guards) expect(g).toContain('!tab.incognito');
  });
});

describe('Smart group refuses incognito snapshots', () => {
  test('throws before contacting any AI provider', async () => {
    const { installChromeMock } = await import('../helpers/chrome-mock.js');
    installChromeMock();
    const win = { id: 7, type: 'normal', incognito: true, focused: true };
    globalThis.chrome.windows.getAll = async () => [win];
    globalThis.chrome.tabs.query = async () => [
      { id: 1, windowId: 7, incognito: true, pinned: false, url: 'https://a.test/', title: 'secret' },
      { id: 2, windowId: 7, incognito: true, pinned: false, url: 'https://b.test/', title: 'secret 2' },
    ];
    globalThis.chrome.tabGroups.query = async () => [];
    let fetched = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetched = true; throw new Error('no network'); };
    try {
      const { applySmartGroupsToChrome } = await import(`../../core/grouping.js?incognito=${Date.now()}`);
      await expect(applySmartGroupsToChrome()).rejects.toThrow(/incognito/);
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
