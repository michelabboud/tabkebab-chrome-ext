import { describe, expect, test } from 'bun:test';

import { createPortableExportDocument } from '../../core/export-schema.js';
import { installChromeMock } from '../helpers/chrome-mock.js';

let workerNonce = 0;

async function freshWorker(label) {
  return import(`../../service-worker.js?task10=${label}-${++workerNonce}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function session(id = 'session-1') {
  return {
    id,
    name: id,
    version: 2,
    createdAt: 1,
    modifiedAt: 1,
    windows: [{ tabCount: 1, tabs: [{ title: 'Tab', url: 'https://example.test/' }] }],
  };
}

function stash(id = 'stash-1') {
  return {
    id,
    name: id,
    createdAt: 1,
    tabCount: 1,
    windows: [{ tabCount: 1, tabs: [{ title: 'Tab', url: 'https://example.test/' }] }],
  };
}

function sessionsDocument() {
  return createPortableExportDocument(
    'sessions',
    { sessions: [session()] },
    '2026-07-19T00:00:00.000Z',
  );
}

function settingsDocument(kind = 'settings') {
  const settings = {
    autoSaveIntervalHours: 2,
    autoKebabAfterHours: 0,
    autoStashAfterDays: 0,
    autoSyncToDriveIntervalHours: 3,
    autoBookmarkOnStash: true,
    bookmarkByWindows: true,
  };
  if (kind === 'settings') {
    return createPortableExportDocument(
      'settings',
      { settings },
      '2026-07-19T00:00:00.000Z',
    );
  }
  return createPortableExportDocument(
    'full',
    {
      sessions: [],
      stashes: [],
      manualGroups: {},
      keepAwakeDomains: [],
      bookmarks: [],
      settings,
      focusProfilePrefs: {},
      focusHistory: [],
      aiSettings: { enabled: false, providerId: null, providerConfigs: {} },
    },
    '2026-07-19T00:00:00.000Z',
  );
}

function importSummary() {
  return {
    imported: { sessions: 0, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
    skipped: { sessions: 0, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
  };
}

function rawFullDocument(overrides = {}) {
  return {
    version: 2,
    kind: 'full',
    exportedAt: '2026-07-19T00:00:00.000Z',
    sessions: [],
    stashes: [],
    manualGroups: {},
    keepAwakeDomains: [],
    bookmarks: [],
    settings: {},
    focusProfilePrefs: {},
    focusHistory: [],
    aiSettings: { enabled: false, providerId: null, providerConfigs: {} },
    ...overrides,
  };
}

describe('portable import worker boundary', () => {
  test('re-parses hostile documents before any repository operation', async () => {
    const harness = installChromeMock({ local: { unrelated: { preserved: true } } });
    const worker = await freshWorker('hostile-imports');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
    harness.calls.storage.local.get.length = 0;
    harness.calls.storage.local.set.length = 0;
    harness.calls.storage.local.remove.length = 0;
    let applyCalls = 0;
    const applyPortableImport = async () => {
      applyCalls += 1;
      throw new Error('must not apply');
    };

    const overBudgetPrefs = Object.fromEntries(Array.from(
      { length: 8_900 },
      (_, index) => [`profile-${index}`, { note: 'x'.repeat(3_000) }],
    ));
    let overDepthPrefs = { leaf: true };
    for (let depth = 0; depth < 20; depth += 1) {
      overDepthPrefs = { next: overDepthPrefs };
    }

    const hostileDocuments = [
      { error: 'pretend worker response' },
      {
        version: 2,
        kind: 'unknown',
        exportedAt: '2026-07-19T00:00:00.000Z',
        sessions: [],
      },
      {
        version: 2,
        kind: 'settings',
        exportedAt: '2026-07-19T00:00:00.000Z',
        settings: { theme: 'dark', apiKey: 'must-never-import' },
      },
      JSON.parse('{"version":2,"kind":"sessions","exportedAt":"2026-07-19T00:00:00.000Z","sessions":[],"__proto__":{"polluted":true}}'),
      rawFullDocument({ focusProfilePrefs: overBudgetPrefs }),
      rawFullDocument({ focusProfilePrefs: { coding: overDepthPrefs } }),
      rawFullDocument({
        sessions: [{ id: 'invalid-session-name', name: null, createdAt: 1, windows: [] }],
      }),
      rawFullDocument({
        stashes: [{ id: 'missing-stash-name', createdAt: 1, windows: [] }],
      }),
      rawFullDocument({
        manualGroups: { broken: { name: 'Broken', color: 'blue' } },
      }),
      rawFullDocument({
        manualGroups: {
          broken: { name: null, color: 'blue', tabUrls: [] },
        },
      }),
      rawFullDocument({
        focusProfilePrefs: {
          coding: { blockedCategories: { bad: true }, blockedDomains: { bad: true } },
        },
      }),
    ];

    for (const document of hostileDocuments) {
      await expect(worker.handleMessage(
        { action: 'importPortableData', document },
        { applyPortableImport },
      )).rejects.toThrow();
    }

    expect(applyCalls).toBe(0);
    expect(harness.calls.storage.local.get).toEqual([]);
    expect(harness.calls.storage.local.set).toEqual([]);
    expect(harness.calls.storage.local.remove).toEqual([]);
    expect(harness.snapshot().local.unrelated).toEqual({ preserved: true });
  });

  test('passes only a worker-normalized document to the importer and rejects extra action fields', async () => {
    installChromeMock();
    const worker = await freshWorker('normalized-import');
    let received;
    const summary = {
      imported: { sessions: 1, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
      skipped: { sessions: 0, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
    };

    await expect(worker.handleMessage(
      { action: 'importPortableData', document: sessionsDocument() },
      { applyPortableImport: async (document) => { received = document; return summary; } },
    )).resolves.toEqual(summary);
    expect(received.kind).toBe('sessions');
    expect(Object.getPrototypeOf(received)).toBeNull();

    await expect(worker.handleMessage(
      { action: 'importPortableData', document: sessionsDocument(), trusted: true },
      { applyPortableImport: async () => summary },
    )).rejects.toThrow('unexpected fields');
  });

  test('holds the shared lock through import apply so a later affected mutation cannot be rolled back', async () => {
    installChromeMock();
    const worker = await freshWorker('import-lock');
    const entered = deferred();
    const gate = deferred();
    const order = [];

    const importing = worker.handleMessage(
      { action: 'importPortableData', document: sessionsDocument() },
      {
        applyPortableImport: async () => {
          order.push('import:start');
          entered.resolve();
          await gate.promise;
          order.push('import:end');
          return {
            imported: { sessions: 1, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
            skipped: { sessions: 0, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
          };
        },
      },
    );
    await entered.promise;
    const preferenceWrite = worker.handleMessage(
      {
        action: 'saveFocusProfilePrefs',
        profileId: 'coding',
        preferences: { duration: 25 },
      },
      { saveFocusProfilePrefs: async () => { order.push('prefs'); return { saved: true }; } },
    );
    await flushMicrotasks();
    expect(order).toEqual(['import:start']);

    gate.resolve();
    await Promise.all([importing, preferenceWrite]);
    expect(order).toEqual(['import:start', 'import:end', 'prefs']);
  });

  test('keeps a queued mutation behind a rejecting import through its rollback boundary', async () => {
    installChromeMock();
    const worker = await freshWorker('import-rollback-lock');
    const entered = deferred();
    const gate = deferred();
    const order = [];

    const importing = worker.handleMessage(
      { action: 'importPortableData', document: sessionsDocument() },
      {
        applyPortableImport: async () => {
          order.push('import:apply');
          entered.resolve();
          await gate.promise;
          order.push('import:rollback-complete');
          throw new Error('synthetic rolled-back import');
        },
      },
    );
    await entered.promise;
    const preferenceWrite = worker.handleMessage(
      {
        action: 'saveFocusProfilePrefs',
        profileId: 'coding',
        preferences: { duration: 25 },
      },
      {
        saveFocusProfilePrefs: async () => {
          order.push('prefs:committed');
          return { saved: true };
        },
      },
    );
    await flushMicrotasks();
    expect(order).toEqual(['import:apply']);

    gate.resolve();
    await expect(importing).rejects.toThrow('synthetic rolled-back import');
    await expect(preferenceWrite).resolves.toEqual({ saved: true });
    expect(order).toEqual([
      'import:apply',
      'import:rollback-complete',
      'prefs:committed',
    ]);
  });

  test('serializes lifecycle alarm reconciliation before a queued settings import', async () => {
    installChromeMock();
    const worker = await freshWorker('lifecycle-alarm-lock');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
    const entered = deferred();
    const gate = deferred();
    const order = [];

    const lifecycle = worker.reconfigureManagedAlarms({
      reconfigure: async () => {
        order.push('lifecycle:old:start');
        entered.resolve();
        await gate.promise;
        order.push('lifecycle:old:end');
      },
    });
    await entered.promise;
    const importing = worker.handleMessage(
      { action: 'importPortableData', document: settingsDocument() },
      {
        applyPortableImport: async () => {
          order.push('import:apply');
          return importSummary();
        },
        getSettings: async () => ({ autoSaveIntervalHours: 2 }),
        reconfigureAlarms: async () => { order.push('import:new-alarms'); },
      },
    );
    await flushMicrotasks();
    expect(order).toEqual(['lifecycle:old:start']);

    gate.resolve();
    await Promise.all([lifecycle, importing]);
    expect(order).toEqual([
      'lifecycle:old:start',
      'lifecycle:old:end',
      'import:apply',
      'import:new-alarms',
    ]);
  });

  test('settings and full imports reconfigure managed alarms from persisted canonical settings', async () => {
    const harness = installChromeMock();
    const worker = await freshWorker('import-alarms');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();

    const canonicalSettings = {
      autoSaveIntervalHours: 2,
      autoKebabAfterHours: 0,
      autoStashAfterDays: 0,
      autoSyncToDriveIntervalHours: 3,
      autoBookmarkOnStash: true,
      bookmarkByWindows: true,
      bookmarkByGroups: false,
      bookmarkByDomains: false,
    };

    for (const kind of ['settings', 'full']) {
      await chrome.alarms.clearAll();
      await expect(worker.handleMessage(
        { action: 'importPortableData', document: settingsDocument(kind) },
        {
          applyPortableImport: async () => importSummary(),
          getSettings: async () => canonicalSettings,
        },
      )).resolves.toEqual(importSummary());

      const alarms = new Map(harness.snapshot().alarms.map((alarm) => [alarm.name, alarm]));
      expect([...alarms.keys()].sort()).toEqual([
        'autoBookmark',
        'autoSaveSession',
        'autoSyncDrive',
        'retentionCleanup',
      ]);
      expect(alarms.get('autoSaveSession').periodInMinutes).toBe(120);
      expect(alarms.get('autoSyncDrive').periodInMinutes).toBe(180);
      expect(alarms.get('autoBookmark').periodInMinutes).toBe(720);
      expect(alarms.get('retentionCleanup').periodInMinutes).toBe(720);
    }
  });

  test('reports an explicit committed warning when post-import alarm refresh fails', async () => {
    installChromeMock();
    const worker = await freshWorker('import-alarm-warning');
    const result = await worker.handleMessage(
      { action: 'importPortableData', document: settingsDocument() },
      {
        applyPortableImport: async () => importSummary(),
        getSettings: async () => ({ autoSaveIntervalHours: 2 }),
        reconfigureAlarms: async () => { throw new Error('synthetic alarm failure'); },
      },
    );

    expect(result.imported).toEqual(importSummary().imported);
    expect(result.skipped).toEqual(importSummary().skipped);
    expect(result.committed).toBeTrue();
    expect(result.warning).toContain('imported');
    expect(result.warning).toContain('automation schedules');
    expect(result.warning).not.toContain('synthetic alarm failure');
  });

  test('awaits Chrome alarm creation failures and returns the committed warning', async () => {
    installChromeMock();
    const worker = await freshWorker('import-real-alarm-failure');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();

    const originalCreate = chrome.alarms.create.bind(chrome.alarms);
    chrome.alarms.create = (name, alarmInfo) => {
      if (name !== 'autoSaveSession') return originalCreate(name, alarmInfo);
      return {
        then(_resolve, reject) {
          reject(new Error('synthetic Chrome alarm create failure'));
        },
      };
    };

    const result = await worker.handleMessage(
      { action: 'importPortableData', document: settingsDocument() },
      {
        applyPortableImport: async () => importSummary(),
        getSettings: async () => ({
          autoSaveIntervalHours: 2,
          autoKebabAfterHours: 0,
          autoStashAfterDays: 0,
          autoSyncToDriveIntervalHours: 0,
          autoBookmarkOnStash: false,
          bookmarkByWindows: false,
          bookmarkByGroups: false,
          bookmarkByDomains: false,
        }),
      },
    );

    expect(result.committed).toBeTrue();
    expect(result.warning).toContain('automation schedules');
  });

  test('returns the committed warning when a stale managed alarm cannot be cleared', async () => {
    const harness = installChromeMock();
    const worker = await freshWorker('import-real-alarm-clear-failure');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
    await chrome.alarms.create('autoStash', { periodInMinutes: 360 });

    const originalClear = chrome.alarms.clear.bind(chrome.alarms);
    chrome.alarms.clear = async (name) => {
      if (name === 'autoStash') throw new Error('synthetic Chrome alarm clear failure');
      return originalClear(name);
    };

    const result = await worker.handleMessage(
      { action: 'importPortableData', document: settingsDocument() },
      {
        applyPortableImport: async () => importSummary(),
        getSettings: async () => ({
          autoSaveIntervalHours: 2,
          autoKebabAfterHours: 0,
          autoStashAfterDays: 0,
          autoSyncToDriveIntervalHours: 0,
          autoBookmarkOnStash: false,
          bookmarkByWindows: false,
          bookmarkByGroups: false,
          bookmarkByDomains: false,
        }),
      },
    );

    expect(result.committed).toBeTrue();
    expect(result.warning).toContain('automation schedules');
    expect(harness.snapshot().alarms.some(({ name }) => name === 'autoStash')).toBeTrue();
    expect(harness.snapshot().alarms.some(({ name }) => name === 'autoSaveSession')).toBeTrue();
  });

  test('every import-affected worker action has one outer mutation-lock boundary', async () => {
    const source = await Bun.file(new URL('../../service-worker.js', import.meta.url)).text();
    const actionBody = (action) => {
      const start = source.indexOf(`case '${action}'`);
      expect(start).toBeGreaterThan(-1);
      const nextCase = source.indexOf("case '", start + 6);
      const nextDefault = source.indexOf('default:', start + 6);
      const candidates = [nextCase, nextDefault].filter((index) => index >= 0);
      return source.slice(start, Math.min(...candidates));
    };

    for (const action of [
      'saveSettings',
      'importDriveSettings',
      'undoDriveSettings',
      'saveFocusProfilePrefs',
      'saveAISettings',
      'setAIApiKey',
      'saveKeepAwakeList',
      'toggleKeepAwakeDomain',
      'setKeepAwake',
      'stashWindow',
      'stashGroup',
      'stashDomain',
      'restoreStash',
      'deleteStash',
      'undoDeleteStash',
      'importStashes',
      'startFocus',
      'endFocus',
      'pauseFocus',
      'resumeFocus',
      'extendFocus',
    ]) {
      expect(actionBody(action)).toContain('withStateMutationLock');
    }

    expect(actionBody('createBookmarks')).toContain('return createBookmarks(');
    expect(source).toMatch(/export async function createBookmarks[\s\S]*?withStateMutationLock/);
    expect(source).toMatch(/export async function autoStashOldTabs[\s\S]*?withStateMutationLock/);

    const autoStashUnlocked = source.slice(
      source.indexOf('async function autoStashOldTabsUnlocked'),
      source.indexOf('export async function autoStashOldTabs'),
    );
    const bookmarksUnlocked = source.slice(
      source.indexOf('async function createBookmarksUnlocked'),
      source.indexOf('export async function createBookmarks'),
    );
    expect(autoStashUnlocked).not.toContain('withStateMutationLock');
    expect(bookmarksUnlocked).not.toContain('withStateMutationLock');
  });

  test('Focus preference action validates one profile and preserves other profiles in one write', async () => {
    const harness = installChromeMock({
      local: { focusProfilePrefs: { writing: { duration: 40, strictMode: false } } },
    });
    const worker = await freshWorker('focus-preferences');
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.calls.storage.local.set.length = 0;

    await expect(worker.handleMessage({
      action: 'saveFocusProfilePrefs',
      profileId: 'coding',
      preferences: { duration: 25, strictMode: true },
    })).resolves.toEqual({ saved: true });
    expect(harness.snapshot().local.focusProfilePrefs).toEqual({
      coding: { duration: 25, strictMode: true },
      writing: { duration: 40, strictMode: false },
    });
    expect(harness.calls.storage.local.set).toHaveLength(1);

    const writes = harness.calls.storage.local.set.length;
    await expect(worker.handleMessage({
      action: 'saveFocusProfilePrefs',
      profileId: '__proto__',
      preferences: {},
    })).rejects.toThrow();
    await expect(worker.handleMessage({
      action: 'saveFocusProfilePrefs',
      profileId: 'coding',
      preferences: { apiKey: 'forbidden' },
    })).rejects.toThrow();
    await expect(worker.handleMessage({
      action: 'saveFocusProfilePrefs',
      profileId: 'coding',
      preferences: { blockedCategories: { bad: true }, blockedDomains: { bad: true } },
    })).rejects.toThrow();
    expect(harness.calls.storage.local.set).toHaveLength(writes);
  });
});

describe('portable export worker boundary', () => {
  test('builds canonical single-record exports inside the worker without widening the generic action', async () => {
    installChromeMock();
    const worker = await freshWorker('record-exports');
    const sessions = createPortableExportDocument(
      'sessions',
      { sessions: [session('one'), session('two')] },
      '2026-07-19T00:00:00.000Z',
    );
    const stashes = createPortableExportDocument(
      'stashes',
      { stashes: [stash('one'), stash('two')] },
      '2026-07-19T00:00:00.000Z',
    );
    const buildPortableExportPayload = async (kind) => (
      kind === 'sessions' ? sessions : stashes
    );

    await expect(worker.handleMessage(
      { action: 'buildPortableSessionExport', sessionId: 'two' },
      { buildPortableExportPayload },
    )).resolves.toEqual(createPortableExportDocument(
      'sessions',
      { sessions: [session('two')] },
      sessions.exportedAt,
    ));
    await expect(worker.handleMessage(
      { action: 'buildPortableStashExport', stashId: 'one' },
      { buildPortableExportPayload },
    )).resolves.toEqual(createPortableExportDocument(
      'stashes',
      { stashes: [stash('one')] },
      stashes.exportedAt,
    ));
    await expect(worker.handleMessage(
      { action: 'buildPortableSessionExport', sessionId: 'missing' },
      { buildPortableExportPayload },
    )).rejects.toThrow('Session not found');
    await expect(worker.handleMessage(
      { action: 'buildPortableStashExport', stashId: 'one', trusted: true },
      { buildPortableExportPayload },
    )).rejects.toThrow('unexpected fields');
  });

  test('single-record exports accept every schema-valid legacy whitespace ID', async () => {
    installChromeMock();
    const worker = await freshWorker('record-export-whitespace-ids');
    const sessionId = ' legacy session ';
    const stashId = '   ';
    const documents = {
      sessions: createPortableExportDocument(
        'sessions',
        { sessions: [session(sessionId)] },
        '2026-07-19T00:00:00.000Z',
      ),
      stashes: createPortableExportDocument(
        'stashes',
        { stashes: [stash(stashId)] },
        '2026-07-19T00:00:00.000Z',
      ),
    };
    const buildPortableExportPayload = async (kind) => documents[kind];

    await expect(worker.handleMessage(
      { action: 'buildPortableSessionExport', sessionId },
      { buildPortableExportPayload },
    )).resolves.toEqual(documents.sessions);
    await expect(worker.handleMessage(
      { action: 'buildPortableStashExport', stashId },
      { buildPortableExportPayload },
    )).resolves.toEqual(documents.stashes);
  });

  test('accepts only kind and holds the shared lock across every export read', async () => {
    installChromeMock();
    const worker = await freshWorker('export-lock');
    const entered = deferred();
    const gate = deferred();
    const order = [];
    const document = sessionsDocument();

    const exporting = worker.handleMessage(
      { action: 'buildPortableExport', kind: 'sessions' },
      {
        buildPortableExportPayload: async (kind) => {
          order.push(`export:${kind}:start`);
          entered.resolve();
          await gate.promise;
          order.push(`export:${kind}:end`);
          return document;
        },
      },
    );
    await entered.promise;
    const settingsWrite = worker.handleMessage(
      { action: 'saveSettings', settings: { theme: 'dark' } },
      { saveSettings: async () => { order.push('settings'); return { theme: 'dark' }; } },
    );
    await flushMicrotasks();
    expect(order).toEqual(['export:sessions:start']);

    gate.resolve();
    await expect(exporting).resolves.toEqual(document);
    await settingsWrite;
    expect(order).toEqual(['export:sessions:start', 'export:sessions:end', 'settings']);

    await expect(worker.handleMessage(
      { action: 'buildPortableExport', kind: 'sessions', sessionId: 'caller-filter' },
      { buildPortableExportPayload: async () => document },
    )).rejects.toThrow('unexpected fields');
    await expect(worker.handleMessage(
      { action: 'buildPortableExport', kind: 'invalid' },
      { buildPortableExportPayload: async () => document },
    )).rejects.toThrow('kind');
  });

  test('keeps a full snapshot coherent from local read through later stash read', async () => {
    installChromeMock();
    const worker = await freshWorker('full-export-coherence');
    const entered = deferred();
    const gate = deferred();
    const order = [];
    const state = { theme: 'light', stashId: 'old-stash' };

    const exporting = worker.handleMessage(
      { action: 'buildPortableExport', kind: 'full' },
      {
        buildPortableExportPayload: async () => {
          const localTheme = state.theme;
          order.push('export:local-read');
          entered.resolve();
          await gate.promise;
          const stashSnapshot = stash(state.stashId);
          order.push('export:stash-read');
          return createPortableExportDocument(
            'full',
            {
              sessions: [],
              stashes: [stashSnapshot],
              manualGroups: {},
              keepAwakeDomains: [],
              bookmarks: [],
              settings: { theme: localTheme },
              focusProfilePrefs: {},
              focusHistory: [],
              aiSettings: { enabled: false, providerId: null, providerConfigs: {} },
            },
            '2026-07-19T00:00:00.000Z',
          );
        },
      },
    );
    await entered.promise;
    const importing = worker.handleMessage(
      { action: 'importPortableData', document: settingsDocument('full') },
      {
        applyPortableImport: async () => {
          state.theme = 'dark';
          state.stashId = 'new-stash';
          order.push('import:committed');
          return importSummary();
        },
        getSettings: async () => ({ autoSaveIntervalHours: 2 }),
        reconfigureAlarms: async () => {},
      },
    );
    await flushMicrotasks();
    expect(order).toEqual(['export:local-read']);

    gate.resolve();
    const document = await exporting;
    await importing;
    expect(document.settings.theme).toBe('light');
    expect(document.stashes.map(({ id }) => id)).toEqual(['old-stash']);
    expect(state).toEqual({ theme: 'dark', stashId: 'new-stash' });
    expect(order).toEqual([
      'export:local-read',
      'export:stash-read',
      'import:committed',
    ]);
  });
});
