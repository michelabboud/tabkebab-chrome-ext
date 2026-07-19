import { describe, expect, test } from 'bun:test';

import { encryptApiKey } from '../../core/ai/crypto.js';
import { applyPortableImport } from '../../core/export-import.js';
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

function editableAISettings(overrides = {}) {
  return {
    enabled: true,
    providerId: 'openai',
    providerConfigs: {
      openai: { model: 'gpt-4.1-nano' },
      claude: { model: 'claude-haiku-4-5' },
      gemini: { model: 'gemini-2.5-flash' },
      'chrome-ai': { model: 'default' },
      custom: { model: 'default', baseUrl: 'http://localhost:11434/v1' },
    },
    protectionMode: 'device',
    ...overrides,
  };
}

function publicAIProjection(overrides = {}) {
  const editable = editableAISettings();
  return {
    ...editable,
    providerConfigs: Object.fromEntries(Object.entries(editable.providerConfigs).map(
      ([providerId, config]) => [providerId, {
        ...config,
        hasApiKey: false,
        usesPassphrase: false,
      }],
    )),
    ...overrides,
  };
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
  test('cannot redirect a preserved Custom credential through a full portable import', async () => {
    const installId = `portable-custom-install-${crypto.randomUUID()}`;
    const apiKey = `portable-custom-key-${crypto.randomUUID()}`;
    const firstBaseUrl = 'https://first-provider.example.test/v1';
    const redirectedBaseUrl = 'https://redirect.example.test/v1';
    const harness = installChromeMock({ local: { installId } });
    const encryptedKey = await encryptApiKey(apiKey);
    const localAISettings = {
      enabled: true,
      providerId: 'custom',
      providerConfigs: {
        custom: {
          model: 'local-model',
          baseUrl: firstBaseUrl,
          apiKey: encryptedKey,
        },
      },
      usePassphrase: false,
    };
    await chrome.storage.local.set({ aiSettings: localAISettings });
    const beforeKeyBytes = JSON.stringify(encryptedKey);

    const worker = await freshWorker('custom-origin-import');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
    const document = rawFullDocument({
      aiSettings: {
        enabled: true,
        providerId: 'custom',
        providerConfigs: {
          custom: { model: 'imported-model', baseUrl: redirectedBaseUrl },
        },
      },
    });
    await expect(worker.handleMessage(
      { action: 'importPortableData', document },
      {
        applyPortableImport: (parsed) => applyPortableImport(parsed, {
          stashRepository: { list: async () => [], replace: async () => {} },
          now: () => 100,
        }),
        getSettings: async () => ({}),
        reconfigureAlarms: async () => {},
      },
    )).resolves.toEqual(importSummary());

    const storedCustom = harness.snapshot().local.aiSettings.providerConfigs.custom;
    expect(storedCustom.baseUrl).toBe(firstBaseUrl);
    expect(storedCustom.model).toBe('imported-model');
    expect(JSON.stringify(storedCustom.apiKey)).toBe(beforeKeyBytes);

    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), headers: options.headers || {} });
      return { ok: true, status: 200 };
    };
    try {
      await expect(worker.handleMessage({
        action: 'testAIConnection',
        providerId: 'custom',
      })).resolves.toEqual({ success: true });
      expect(requests).toHaveLength(1);
      expect(requests[0].url.startsWith(firstBaseUrl)).toBeTrue();
      expect(requests[0].url.includes(redirectedBaseUrl)).toBeFalse();
      expect(requests[0].headers.Authorization).toBe(`Bearer ${apiKey}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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
      'unlockAIApiKey',
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
      const body = actionBody(action);
      expect(body).toContain('withStateMutationLock');
      expect(body.match(/withStateMutationLock/g)).toHaveLength(1);
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

describe('AI credential worker boundary', () => {
  test('getAISettings returns only the exact public AI projection', async () => {
    installChromeMock();
    const expected = publicAIProjection({
      providerConfigs: {
        ...publicAIProjection().providerConfigs,
        openai: { model: 'gpt-4.1-nano', hasApiKey: true, usesPassphrase: true },
      },
      protectionMode: 'passphrase',
    });
    const calls = [];
    const aiClient = {
      async getPublicSettings(...args) {
        calls.push(args);
        return expected;
      },
    };
    const worker = await freshWorker('ai-public-settings');
    await expect(worker.handleMessage(
      { action: 'getAISettings' },
      { aiClient },
    )).resolves.toEqual(expected);
    expect(calls).toEqual([[]]);
  });

  test('needsAIPassphrase validates one provider and returns the exact boolean envelope', async () => {
    installChromeMock();
    const calls = [];
    const aiClient = {
      async needsPassphrase(...args) {
        calls.push(args);
        return true;
      },
    };
    const worker = await freshWorker('ai-needs-passphrase');
    await expect(worker.handleMessage({
      action: 'needsAIPassphrase',
      providerId: 'openai',
    }, { aiClient })).resolves.toEqual({ needsPassphrase: true });
    expect(calls).toEqual([['openai']]);
  });

  test('unlockAIApiKey returns no key and maps void success to the exact unlock envelope', async () => {
    installChromeMock();
    const passphrase = `task12-passphrase-${crypto.randomUUID()}`;
    const calls = [];
    const aiClient = {
      async unlockApiKey(...args) {
        calls.push(args);
      },
    };
    const worker = await freshWorker('ai-unlock');
    const result = await worker.handleMessage({
      action: 'unlockAIApiKey',
      providerId: 'openai',
      passphrase,
    }, { aiClient });
    expect(result).toEqual({ unlocked: true });
    expect(calls).toEqual([['openai', passphrase]]);
    expect(JSON.stringify(result)).not.toContain(passphrase);
  });

  test('saveAISettings delegates one atomic request and preserves the exact committed-lock result', async () => {
    installChromeMock();
    const settings = editableAISettings();
    const keyUpdates = [];
    const calls = [];
    const aiClient = {
      async saveConfiguration(...args) {
        calls.push(args);
        return { saved: true, unlocked: false };
      },
    };
    const worker = await freshWorker('ai-atomic-save');
    await expect(worker.handleMessage({
      action: 'saveAISettings',
      settings,
      keyUpdates,
      passphrase: null,
    }, { aiClient })).resolves.toEqual({ saved: true, unlocked: false });
    expect(calls).toEqual([[settings, keyUpdates, null]]);
  });

  test('test and model actions reconstruct private config and receive only provider identity', async () => {
    installChromeMock();
    const testCalls = [];
    const listCalls = [];
    const privateMarker = `private-model-field-${crypto.randomUUID()}`;
    const aiClient = {
      async testConnection(...args) {
        testCalls.push(args);
        return 1;
      },
      async listModels(...args) {
        listCalls.push(args);
        return [{ id: 'safe-model', name: 'Safe model', privateMarker }];
      },
    };
    const worker = await freshWorker('ai-private-reconstruction');
    await expect(worker.handleMessage({
      action: 'testAIConnection',
      providerId: 'openai',
    }, { aiClient })).resolves.toEqual({ success: true });
    const listResult = await worker.handleMessage({
      action: 'listModels',
      providerId: 'openai',
    }, { aiClient });
    expect(listResult).toEqual({ models: [{ id: 'safe-model', name: 'Safe model' }] });
    expect(JSON.stringify(listResult)).not.toContain(privateMarker);
    expect(testCalls).toEqual([['openai']]);
    expect(listCalls).toEqual([['openai']]);
    expect(testCalls.map((args) => args.length)).toEqual([1]);
    expect(listCalls.map((args) => args.length)).toEqual([1]);
  });

  test('rejects injected private provider fields before provider work without echoing plaintext', async () => {
    installChromeMock();
    const secret = `task12-key-${crypto.randomUUID()}`;
    const providerCalls = [];
    const aiClient = {
      async testConnection(...args) {
        providerCalls.push(args);
        return true;
      },
      async listModels(...args) {
        providerCalls.push(args);
        return [];
      },
    };
    const worker = await freshWorker('ai-private-injection');
    for (const message of [
      { action: 'testAIConnection', providerId: 'openai', config: { apiKey: secret } },
      { action: 'testAIConnection', providerId: 'openai', apiKey: secret },
      { action: 'testAIConnection', providerId: 'openai', passphrase: secret },
      { action: 'listModels', providerId: 'custom', config: { apiKey: secret } },
      { action: 'listModels', providerId: 'custom', baseUrl: `https://${secret}.invalid/v1` },
      { action: 'listModels', providerId: 'custom', endpoint: `https://${secret}.invalid/v1` },
    ]) {
      let rejection = null;
      try {
        await worker.handleMessage(message, { aiClient });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect(rejection.message).not.toContain(secret);
    }
    expect(providerCalls).toEqual([]);
  });

  test('AI state actions reject extra or missing fields before entering core methods', async () => {
    installChromeMock();
    const coreCalls = [];
    const aiClient = {
      async getPublicSettings(...args) { coreCalls.push(args); return {}; },
      async needsPassphrase(...args) { coreCalls.push(args); return false; },
      async unlockApiKey(...args) { coreCalls.push(args); },
      async saveConfiguration(...args) {
        coreCalls.push(args);
        return { saved: true, unlocked: true };
      },
    };
    const worker = await freshWorker('ai-strict-actions');
    for (const message of [
      { action: 'getAISettings', config: {} },
      { action: 'needsAIPassphrase', providerId: 'openai', apiKey: 'injected' },
      { action: 'unlockAIApiKey', providerId: 'openai' },
      {
        action: 'saveAISettings',
        settings: editableAISettings(),
        keyUpdates: [],
        passphrase: null,
        config: {},
      },
    ]) {
      await expect(worker.handleMessage(message, { aiClient })).rejects.toThrow();
    }
    expect(coreCalls).toEqual([]);
  });

  test('the obsolete split setAIApiKey route is unavailable and cannot reach key storage', async () => {
    installChromeMock();
    const secret = `task12-removed-route-${crypto.randomUUID()}`;
    const calls = [];
    const aiClient = {
      async setApiKey(...args) {
        calls.push(args);
      },
    };
    const worker = await freshWorker('ai-removed-route');
    await expect(worker.handleMessage({
      action: 'setAIApiKey',
      providerId: 'openai',
      plainKey: secret,
      passphrase: null,
    }, { aiClient })).resolves.toEqual({ error: 'Unknown action' });
    expect(calls).toEqual([]);
    const source = await Bun.file(new URL('../../service-worker.js', import.meta.url)).text();
    expect(source).not.toContain("case 'setAIApiKey'");
  });

  test('atomic save and unlock remain queued behind an in-flight portable import', async () => {
    installChromeMock();
    const worker = await freshWorker('ai-lock-serialization');
    const entered = deferred();
    const gate = deferred();
    const order = [];
    const aiClient = {
      async saveConfiguration() {
        order.push('save:core');
        return { saved: true, unlocked: true };
      },
      async unlockApiKey() {
        order.push('unlock:core');
      },
    };
    try {
      const importing = worker.handleMessage(
        { action: 'importPortableData', document: sessionsDocument() },
        {
          applyPortableImport: async () => {
            order.push('import:start');
            entered.resolve();
            await gate.promise;
            order.push('import:end');
            return importSummary();
          },
        },
      );
      await entered.promise;

      const saving = worker.handleMessage({
        action: 'saveAISettings',
        settings: editableAISettings(),
        keyUpdates: [],
        passphrase: null,
      }, { aiClient }).then(
        (value) => { order.push('save:settled'); return { ok: true, value }; },
        (error) => { order.push('save:settled'); return { ok: false, error }; },
      );
      const unlocking = worker.handleMessage({
        action: 'unlockAIApiKey',
        providerId: 'openai',
        passphrase: 'synthetic-passphrase',
      }, { aiClient }).then(
        (value) => { order.push('unlock:settled'); return { ok: true, value }; },
        (error) => { order.push('unlock:settled'); return { ok: false, error }; },
      );

      await flushMicrotasks();
      const beforeRelease = [...order];
      gate.resolve();
      await importing;
      const [saveResult, unlockResult] = await Promise.all([saving, unlocking]);

      expect(beforeRelease).toEqual(['import:start']);
      expect(saveResult).toEqual({ ok: true, value: { saved: true, unlocked: true } });
      expect(unlockResult).toEqual({ ok: true, value: { unlocked: true } });
      expect(order).toEqual([
        'import:start',
        'import:end',
        'save:core',
        'unlock:core',
        'save:settled',
        'unlock:settled',
      ]);
    } finally {
      gate.resolve();
    }
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
