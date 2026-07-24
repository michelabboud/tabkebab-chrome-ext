import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workerSource = readFileSync(new URL('../../service-worker.js', import.meta.url), 'utf8');

async function loadWorker() {
  return import('../../service-worker.js?stash-capture-invariants');
}

describe('stash capture commit invariant', () => {
  test('all four stash sites use the shared save-before-close boundary', async () => {
    const worker = await loadWorker();
    expect(worker.persistCapturedStash).toBeFunction();
    if (typeof worker.persistCapturedStash !== 'function') return;

    const callSites = workerSource.match(/await persistCapturedStash\(\{/g) || [];
    expect(callSites).toHaveLength(4);
  });

  test('a rejected stash write never closes a captured tab', async () => {
    const worker = await loadWorker();
    expect(worker.persistCapturedStash).toBeFunction();
    if (typeof worker.persistCapturedStash !== 'function') return;

    const closed = [];
    await expect(worker.persistCapturedStash({
      stash: { id: 'stash-1', tabCount: 1, windows: [{ tabCount: 1, tabs: [{}] }] },
      capturedTabs: [{ id: 7, url: 'https://captured.test/' }],
      emptyError: 'No stashable tabs in window',
      save: async () => { throw new Error('synthetic stash write failure'); },
      close: async (ids) => { closed.push(...ids); },
    })).rejects.toThrow('synthetic stash write failure');
    expect(closed).toEqual([]);
  });

  test('a zero-representable stash reports an error without saving or closing', async () => {
    const worker = await loadWorker();
    expect(worker.persistCapturedStash).toBeFunction();
    if (typeof worker.persistCapturedStash !== 'function') return;

    let saves = 0;
    const closed = [];
    await expect(worker.persistCapturedStash({
      stash: { id: 'stash-1', tabCount: 0, windows: [{ tabCount: 0, tabs: [] }] },
      capturedTabs: [],
      emptyError: 'No stashable tabs in window',
      save: async () => { saves += 1; },
      close: async (ids) => { closed.push(...ids); },
    })).resolves.toEqual({ error: 'No stashable tabs in window' });
    expect(saves).toBe(0);
    expect(closed).toEqual([]);
  });

  test('only represented non-internal tabs are closed after persistence succeeds', async () => {
    const worker = await loadWorker();
    expect(worker.persistCapturedStash).toBeFunction();
    if (typeof worker.persistCapturedStash !== 'function') return;

    const order = [];
    const closed = [];
    await expect(worker.persistCapturedStash({
      stash: { id: 'stash-1', tabCount: 2, windows: [{ tabCount: 2, tabs: [{}, {}] }] },
      capturedTabs: [
        { id: 7, url: 'https://captured.test/' },
        { id: 8, url: 'chrome://settings/' },
      ],
      emptyError: 'No stashable tabs in window',
      save: async () => { order.push('save'); },
      close: async (ids) => { order.push('close'); closed.push(...ids); },
    })).resolves.toMatchObject({ success: true, stash: { id: 'stash-1' } });
    expect(order).toEqual(['save', 'close']);
    expect(closed).toEqual([7]);
  });
});
