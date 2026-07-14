import { describe, expect, test } from 'bun:test';

import { restoreStashTabs } from '../../core/stash-db.js';
import { installChromeMock } from '../helpers/chrome-mock.js';

function makeStash(id, tabs) {
  return {
    id,
    name: id,
    createdAt: 1,
    tabCount: tabs.length,
    windows: [{ tabCount: tabs.length, tabs }],
  };
}

async function getDispositionHandler() {
  const worker = await import('../../service-worker.js');
  return worker.applyStashRestoreDisposition;
}

describe('restoreStash handler disposition', () => {
  test('retains an unchanged stash when one saved URL is invalid', async () => {
    const applyDisposition = await getDispositionHandler();
    const stash = makeStash('invalid-url-stash', [
      { url: 'https://restore.test/valid' },
      { url: 'chrome://settings/' },
    ]);
    const original = structuredClone(stash);
    const deleted = [];
    const saved = [];
    installChromeMock({ windows: [{ id: 1, focused: true }] });

    const result = await restoreStashTabs(stash, { mode: 'here', discarded: false });
    await applyDisposition(stash, result, true, {
      deleteSource: async (id) => deleted.push(id),
      saveSource: async (record) => saved.push(record),
    });

    expect(result).toEqual({
      requestedCount: 2,
      restoredCount: 1,
      skippedDuplicate: 0,
      skippedInvalid: 1,
      errors: [],
      complete: false,
      windowsCreated: 0,
      groupsRestored: 0,
    });
    expect(deleted).toEqual([]);
    expect(saved).toEqual([]);
    expect(stash).toEqual(original);
  });

  test('retains an unchanged stash when one tab creation rejects', async () => {
    const applyDisposition = await getDispositionHandler();
    const stash = makeStash('create-error-stash', [
      { url: 'https://restore.test/valid' },
      { url: 'https://restore.test/failure' },
    ]);
    const original = structuredClone(stash);
    const deleted = [];
    const saved = [];
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      failures: { 'tabs.create': [null, new Error('synthetic create failure')] },
    });

    const result = await restoreStashTabs(stash, { mode: 'here', discarded: false });
    await applyDisposition(stash, result, true, {
      deleteSource: async (id) => deleted.push(id),
      saveSource: async (record) => saved.push(record),
    });

    expect(result).toEqual({
      requestedCount: 2,
      restoredCount: 1,
      skippedDuplicate: 0,
      skippedInvalid: 0,
      errors: [{
        scope: 'create',
        url: 'https://restore.test/failure',
        message: 'synthetic create failure',
      }],
      complete: false,
      windowsCreated: 0,
      groupsRestored: 0,
    });
    expect(deleted).toEqual([]);
    expect(saved).toEqual([]);
    expect(stash).toEqual(original);
  });
});
