import { describe, expect, test } from 'bun:test';

import {
  MAX_PORTABLE_IMPORT_BYTES,
  createPortableExportDocument,
} from '../../core/export-schema.js';
import {
  ImportRollbackError,
  PORTABLE_KIND_SECTIONS,
  applyPortableImport,
  buildFullExportPayload,
  buildPortableExportPayload,
  downloadJson,
  readPortableImportFile,
} from '../../core/export-import.js';
import { SETTINGS_DEFAULTS } from '../../core/settings.js';

const EXPORTED_AT = '2026-07-19T12:00:00.000Z';
const FULL_LOCAL_KEYS = [
  'sessions',
  'manualGroups',
  'keepAwakeDomains',
  'tabkebabBookmarks',
  'tabkebabSettings',
  'focusProfilePrefs',
  'focusHistory',
  'aiSettings',
];
const DEFAULT_KEEP_AWAKE_DOMAINS = [
  'gmail.com', 'outlook.com', 'outlook.live.com', 'mail.yahoo.com', 'proton.me',
  'calendar.google.com', 'outlook.office.com',
  'claude.ai', 'chat.openai.com', 'aistudio.google.com', 'gemini.google.com',
  'codex.openai.com',
];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function tab(id = 'tab-1') {
  return { title: id, url: `https://${id}.test/` };
}

function session(id, timestamp = 1) {
  return {
    id,
    name: id,
    version: 2,
    createdAt: timestamp,
    modifiedAt: timestamp,
    windows: [{ tabCount: 1, tabs: [tab(`${id}-tab`)] }],
  };
}

function stash(id, timestamp = 1) {
  return {
    id,
    name: id,
    createdAt: timestamp,
    tabCount: 1,
    windows: [{ tabCount: 1, tabs: [tab(`${id}-tab`)] }],
  };
}

function manualGroup(id, timestamp = 1) {
  return {
    name: id,
    color: 'blue',
    createdAt: timestamp,
    modifiedAt: timestamp,
    tabUrls: [`https://${id}.test/`],
  };
}

function bookmark(id, timestamp = 1) {
  return {
    id,
    date: '2026-07-19',
    time: '3:00 PM',
    createdAt: timestamp,
    formats: { byWindows: [{ name: 'Window', tabs: [tab(`${id}-tab`)] }] },
  };
}

function history(runId, timestamp = 1) {
  return {
    runId,
    profileId: 'coding',
    startedAt: timestamp,
    endedAt: timestamp + 1,
  };
}

function publicAISettings(overrides = {}) {
  return {
    enabled: true,
    providerId: 'openai',
    providerConfigs: {
      openai: { model: 'gpt-4.1-nano' },
      custom: { model: 'local', baseUrl: 'http://localhost:11434/v1' },
    },
    ...overrides,
  };
}

function storedAISettings(overrides = {}) {
  return {
    enabled: false,
    providerId: 'openai',
    usePassphrase: true,
    providerConfigs: {
      openai: {
        model: 'stored-model',
        apiKey: {
          ciphertext: 'ciphertext-exact',
          salt: 'salt-exact',
          iv: 'iv-exact',
          usesPassphrase: true,
        },
      },
    },
    ...overrides,
  };
}

function fullSections(overrides = {}) {
  return {
    sessions: [session('incoming-session')],
    stashes: [stash('incoming-stash')],
    manualGroups: { 'incoming-group': manualGroup('incoming-group') },
    keepAwakeDomains: ['incoming.test'],
    bookmarks: [bookmark('incoming-bookmark')],
    settings: { theme: 'dark' },
    focusProfilePrefs: { coding: { strictMode: true } },
    focusHistory: [history('incoming-run')],
    aiSettings: publicAISettings(),
    ...overrides,
  };
}

function portable(kind, sections) {
  return createPortableExportDocument(kind, sections, EXPORTED_AT);
}

function storageSeed(overrides = {}) {
  return {
    sessions: [session('stored-session')],
    manualGroups: { 'stored-group': manualGroup('stored-group') },
    keepAwakeDomains: ['stored.test'],
    tabkebabBookmarks: [bookmark('stored-bookmark')],
    tabkebabSettings: { theme: 'light' },
    focusProfilePrefs: { writing: { strictMode: false } },
    focusHistory: [history('stored-run')],
    aiSettings: storedAISettings(),
    ...overrides,
  };
}

function commitValues(state, values) {
  for (const [key, value] of Object.entries(values)) state[key] = clone(value);
}

function makeStorage(initial = {}, { onSetMany, onRemoveMany } = {}) {
  const state = Object.assign(Object.create(null), clone(initial));
  const calls = { getMany: [], setMany: [], removeMany: [] };
  return {
    state,
    calls,
    async getMany(keys) {
      calls.getMany.push(clone(keys));
      const result = Object.create(null);
      for (const key of keys) {
        if (Object.hasOwn(state, key)) result[key] = clone(state[key]);
      }
      return result;
    },
    async setMany(values) {
      const call = calls.setMany.length + 1;
      calls.setMany.push(clone(values));
      const commit = () => commitValues(state, values);
      if (await onSetMany?.({ call, values: clone(values), state, commit }) === true) return;
      commit();
    },
    async removeMany(keys) {
      const call = calls.removeMany.length + 1;
      calls.removeMany.push(clone(keys));
      const commit = () => {
        for (const key of keys) delete state[key];
      };
      if (await onRemoveMany?.({ call, keys: clone(keys), state, commit }) === true) return;
      commit();
    },
    snapshot() {
      return clone(state);
    },
  };
}

function makeStashRepository(initial = [], { onReplace } = {}) {
  let state = clone(initial);
  const calls = { list: 0, replace: [] };
  return {
    calls,
    async list() {
      calls.list += 1;
      return clone(state);
    },
    async replace(stashes) {
      const call = calls.replace.length + 1;
      calls.replace.push(clone(stashes));
      const commit = () => { state = clone(stashes); };
      if (await onReplace?.({ call, stashes: clone(stashes), commit }) === true) return;
      commit();
    },
    snapshot() {
      return clone(state);
    },
  };
}

function tombstones(overrides = {}) {
  return { sessions: {}, manualGroups: {}, ...overrides };
}

function countOwnKey(value, expected) {
  if (!value || typeof value !== 'object') return 0;
  let count = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === expected) count += 1;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      count += countOwnKey(descriptor.value, expected);
    }
  }
  return count;
}

describe('portable export orchestration', () => {
  test('publishes the exact immutable kind-to-section contract', () => {
    expect(PORTABLE_KIND_SECTIONS).toEqual({
      full: [
        'sessions',
        'stashes',
        'manualGroups',
        'keepAwakeDomains',
        'bookmarks',
        'settings',
        'focusProfilePrefs',
        'focusHistory',
        'aiSettings',
      ],
      sessions: ['sessions'],
      stashes: ['stashes'],
      settings: ['settings'],
    });
    expect(Object.isFrozen(PORTABLE_KIND_SECTIONS)).toBeTrue();
    for (const sections of Object.values(PORTABLE_KIND_SECTIONS)) {
      expect(Object.isFrozen(sections)).toBeTrue();
    }
  });

  test('builds one canonical, secret-free full snapshot from exactly eight local keys and stashes', async () => {
    const initial = storageSeed({
      driveSync: { token: 'excluded' },
      driveProfileName: 'excluded',
      focusState: { runId: 'excluded' },
      tabkebabSettingsPrevious: { theme: 'excluded' },
      aiResponseCache: { response: 'excluded' },
      installId: 'excluded',
      oauthState: 'excluded',
    });
    const before = clone(initial);
    const storage = makeStorage(initial);
    const stashRepository = makeStashRepository([stash('stored-stash')]);
    let clockCalls = 0;

    const result = await buildFullExportPayload({
      storage,
      stashRepository,
      now: () => {
        clockCalls += 1;
        return new Date(EXPORTED_AT);
      },
    });

    expect(clockCalls).toBe(1);
    expect(storage.calls.getMany).toEqual([FULL_LOCAL_KEYS]);
    expect(stashRepository.calls.list).toBe(1);
    expect(storage.snapshot()).toEqual(before);
    expect(stashRepository.snapshot()).toEqual([stash('stored-stash')]);
    expect(result.version).toBe(2);
    expect(result.kind).toBe('full');
    expect(result.exportedAt).toBe(EXPORTED_AT);
    expect(Object.keys(result)).toEqual([
      'version', 'kind', 'exportedAt', ...PORTABLE_KIND_SECTIONS.full,
    ]);
    expect(result.sessions).toEqual(initial.sessions);
    expect(result.stashes).toEqual([stash('stored-stash')]);
    expect(result.bookmarks).toEqual(initial.tabkebabBookmarks);
    expect(result.settings).toEqual({
      ...SETTINGS_DEFAULTS,
      ...initial.tabkebabSettings,
    });
    expect(countOwnKey(result, 'apiKey')).toBe(0);
    for (const excluded of [
      'driveSync', 'driveProfileName', 'focusState', 'tabkebabSettingsPrevious',
      'aiResponseCache', 'installId', 'oauthState', 'usePassphrase',
    ]) {
      expect(countOwnKey(result, excluded)).toBe(0);
    }
  });

  test('materializes effective default keep-awake domains when the storage key is absent', async () => {
    for (const storedValue of [undefined, null]) {
      const source = storageSeed();
      if (storedValue === undefined) delete source.keepAwakeDomains;
      else source.keepAwakeDomains = storedValue;
      const sourceStorage = makeStorage(source);
      const sourceStashes = makeStashRepository([]);

      const document = await buildFullExportPayload({
        storage: sourceStorage,
        stashRepository: sourceStashes,
        now: () => EXPORTED_AT,
      });

      expect(sourceStorage.calls.getMany).toEqual([FULL_LOCAL_KEYS]);
      expect(document.keepAwakeDomains).toEqual(DEFAULT_KEEP_AWAKE_DOMAINS.toSorted());

      const targetStorage = makeStorage();
      const targetStashes = makeStashRepository([]);
      await applyPortableImport(document, {
        storage: targetStorage,
        stashRepository: targetStashes,
        now: () => 10_000,
      });
      expect(targetStorage.snapshot().keepAwakeDomains)
        .toEqual(DEFAULT_KEEP_AWAKE_DOMAINS.toSorted());
    }
  });

  test('exports effective complete settings from absent and partial one-key snapshots', async () => {
    for (const [storedPatch, expectedTheme] of [
      [undefined, 'system'],
      [null, 'system'],
      [{ theme: 'dark' }, 'dark'],
    ]) {
      const sourceStorage = makeStorage(storedPatch === undefined
        ? { unrelated: 'preserved' }
        : { tabkebabSettings: storedPatch, unrelated: 'preserved' });
      const document = await buildPortableExportPayload('settings', {
        storage: sourceStorage,
        now: () => EXPORTED_AT,
      });

      expect(sourceStorage.calls.getMany).toEqual([['tabkebabSettings']]);
      expect(document.settings).toEqual({ ...SETTINGS_DEFAULTS, theme: expectedTheme });

      const targetStorage = makeStorage({
        tabkebabSettings: {
          theme: expectedTheme === 'dark' ? 'light' : 'dark',
          autoKebabAfterHours: 0,
          autoSyncToDriveIntervalHours: 12,
        },
      });
      await applyPortableImport(document, {
        storage: targetStorage,
        stashRepository: makeStashRepository([]),
        now: () => 10_000,
      });
      expect(targetStorage.snapshot().tabkebabSettings)
        .toEqual({ ...SETTINGS_DEFAULTS, theme: expectedTheme });
    }
  });

  test('partial exports read only their named repository and invalid kinds read nothing', async () => {
    const cases = [
      {
        kind: 'sessions',
        sections: { sessions: [session('only-session')] },
        getMany: [['sessions']],
        stashReads: 0,
      },
      {
        kind: 'stashes',
        sections: { stashes: [stash('only-stash')] },
        getMany: [],
        stashReads: 1,
      },
      {
        kind: 'settings',
        sections: { settings: { ...SETTINGS_DEFAULTS, theme: 'dark' } },
        getMany: [['tabkebabSettings']],
        stashReads: 0,
      },
    ];

    for (const entry of cases) {
      const storage = makeStorage({
        sessions: entry.sections.sessions,
        tabkebabSettings: entry.sections.settings,
        unrelated: 'untouched',
      });
      const stashRepository = makeStashRepository(entry.sections.stashes || []);
      const result = await buildPortableExportPayload(entry.kind, {
        storage,
        stashRepository,
        now: () => EXPORTED_AT,
      });
      expect(result).toEqual(portable(entry.kind, entry.sections));
      expect(storage.calls.getMany).toEqual(entry.getMany);
      expect(stashRepository.calls.list).toBe(entry.stashReads);
    }

    const storage = makeStorage(storageSeed());
    const stashRepository = makeStashRepository([stash('never-read')]);
    let clockCalls = 0;
    await expect(buildPortableExportPayload('constructor', {
      storage,
      stashRepository,
      now: () => {
        clockCalls += 1;
        return EXPORTED_AT;
      },
    })).rejects.toThrow(/kind|full|sessions|stashes|settings/i);
    expect(clockCalls).toBe(0);
    expect(storage.calls.getMany).toEqual([]);
    expect(stashRepository.calls.list).toBe(0);
  });

  test('the full wrapper preserves the generic builder contract', async () => {
    const firstStorage = makeStorage(storageSeed());
    const firstStashes = makeStashRepository([stash('stored-stash')]);
    const secondStorage = makeStorage(storageSeed());
    const secondStashes = makeStashRepository([stash('stored-stash')]);

    const wrapped = await buildFullExportPayload({
      storage: firstStorage,
      stashRepository: firstStashes,
      now: () => EXPORTED_AT,
    });
    const generic = await buildPortableExportPayload('full', {
      storage: secondStorage,
      stashRepository: secondStashes,
      now: () => EXPORTED_AT,
    });

    expect(wrapped).toEqual(generic);
    expect(firstStorage.calls.getMany).toEqual(secondStorage.calls.getMany);
    expect(firstStashes.calls.list).toBe(secondStashes.calls.list);
  });
});

describe('portable file and download boundaries', () => {
  test('rejects oversize files before text and accepts the exact byte ceiling', async () => {
    const document = portable('sessions', { sessions: [session('file-session')] });
    let exactTextCalls = 0;
    const exact = {
      size: MAX_PORTABLE_IMPORT_BYTES,
      async text() {
        exactTextCalls += 1;
        return JSON.stringify(document);
      },
    };
    expect(await readPortableImportFile(exact, ['full', 'sessions'])).toEqual(document);
    expect(exactTextCalls).toBe(1);

    let oversizedTextCalls = 0;
    const oversized = {
      size: MAX_PORTABLE_IMPORT_BYTES + 1,
      async text() {
        oversizedTextCalls += 1;
        return JSON.stringify(document);
      },
    };
    await expect(readPortableImportFile(oversized, ['sessions'])).rejects.toThrow(/25|MiB|large|size/i);
    expect(oversizedTextCalls).toBe(0);
  });

  test('validates file shape, accepted-kind collections, JSON, schema, and normalized kind', async () => {
    const sessions = portable('sessions', { sessions: [] });
    const file = (text, size = text.length) => ({ size, text: async () => text });

    for (const invalidFile of [null, {}, { size: -1, text: async () => '{}' }, {
      size: 1.5,
      text: async () => '{}',
    }, { size: 2 }]) {
      await expect(readPortableImportFile(invalidFile, ['sessions'])).rejects.toThrow();
    }
    for (const invalidKinds of [null, [], 'sessions', ['sessions', 'unknown'], new Set()]) {
      await expect(readPortableImportFile(file(JSON.stringify(sessions)), invalidKinds)).rejects.toThrow();
    }

    await expect(readPortableImportFile(file('{'), ['sessions'])).rejects.toThrow();
    await expect(readPortableImportFile(file(JSON.stringify({
      version: 2,
      kind: 'sessions',
      exportedAt: EXPORTED_AT,
    })), ['sessions'])).rejects.toThrow(/sessions|required/i);
    await expect(readPortableImportFile(file(JSON.stringify(sessions)), ['stashes']))
      .rejects.toThrow(/kind|sessions|stashes/i);
    expect(await readPortableImportFile(file(JSON.stringify(sessions)), new Set(['sessions'])))
      .toEqual(sessions);
  });

  test('panel preflight rejects UI-breaking record shapes before worker messaging', async () => {
    const invalidDocuments = [
      {
        version: 2,
        kind: 'sessions',
        exportedAt: EXPORTED_AT,
        sessions: [{ id: 'bad-session', name: null, createdAt: 1, windows: [] }],
      },
      {
        version: 2,
        kind: 'stashes',
        exportedAt: EXPORTED_AT,
        stashes: [{ id: 'bad-stash', createdAt: 1, windows: [] }],
      },
      {
        version: 2,
        kind: 'full',
        exportedAt: EXPORTED_AT,
        ...fullSections({
          manualGroups: { broken: { name: 'Broken', color: 'blue' } },
        }),
      },
      {
        version: 2,
        kind: 'full',
        exportedAt: EXPORTED_AT,
        ...fullSections({
          focusProfilePrefs: {
            coding: { blockedCategories: { bad: true }, blockedDomains: { bad: true } },
          },
        }),
      },
    ];

    for (const document of invalidDocuments) {
      const text = JSON.stringify(document);
      const file = { size: new TextEncoder().encode(text).byteLength, async text() { return text; } };
      await expect(readPortableImportFile(file, [document.kind])).rejects.toThrow();
    }
  });

  test('creates one object URL and always removes the anchor and revokes on click failure', () => {
    const originalDocument = globalThis.document;
    const originalURL = globalThis.URL;
    const appended = [];
    const removed = [];
    const revoked = [];
    const anchors = [];
    let shouldThrow = false;
    let createShouldThrow = false;
    let urlIndex = 0;

    globalThis.document = {
      createElement(tag) {
        expect(tag).toBe('a');
        if (createShouldThrow) throw new Error('anchor creation failed');
        const anchor = {
          href: '',
          download: '',
          click() {
            if (shouldThrow) throw new Error('click failed');
          },
        };
        anchors.push(anchor);
        return anchor;
      },
      body: {
        appendChild(anchor) { appended.push(anchor); },
        removeChild(anchor) { removed.push(anchor); },
      },
    };
    globalThis.URL = {
      createObjectURL(blob) {
        expect(blob).toBeInstanceOf(Blob);
        urlIndex += 1;
        return `blob:test-${urlIndex}`;
      },
      revokeObjectURL(url) { revoked.push(url); },
    };

    try {
      const payload = portable('settings', { settings: { theme: 'dark' } });
      downloadJson(payload, 'settings.json');
      shouldThrow = true;
      expect(() => downloadJson(payload, 'settings-failed.json')).toThrow('click failed');
      createShouldThrow = true;
      expect(() => downloadJson(payload, 'settings-no-anchor.json'))
        .toThrow('anchor creation failed');

      expect(anchors).toHaveLength(2);
      expect(appended).toEqual(anchors);
      expect(removed).toEqual(anchors);
      expect(revoked).toEqual(['blob:test-1', 'blob:test-2', 'blob:test-3']);
      expect(anchors[0]).toMatchObject({ href: 'blob:test-1', download: 'settings.json' });
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      globalThis.URL = originalURL;
    }
  });
});

describe('transactional portable import', () => {
  test('partial kinds snapshot, read, and write only their affected repositories', async () => {
    const sessionStorage = makeStorage({
      sessions: [session('local-session')],
      driveSyncTombstones: tombstones(),
      unrelated: { exact: 'preserve' },
    });
    const sessionStashes = makeStashRepository([stash('never-read')]);
    const sessionResult = await applyPortableImport(portable('sessions', {
      sessions: [session('local-session'), session('new-session')],
    }), {
      storage: sessionStorage,
      stashRepository: sessionStashes,
      now: () => 100,
    });
    expect(sessionStorage.calls.getMany).toEqual([
      ['sessions'],
      ['driveSyncTombstones'],
    ]);
    expect(sessionStorage.calls.setMany).toHaveLength(1);
    expect(Object.keys(sessionStorage.calls.setMany[0])).toEqual(['sessions']);
    expect(sessionStorage.calls.removeMany).toEqual([]);
    expect(sessionStashes.calls).toEqual({ list: 0, replace: [] });
    expect(sessionStorage.snapshot().unrelated).toEqual({ exact: 'preserve' });
    expect(sessionResult).toEqual({
      imported: { sessions: 1, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
      skipped: { sessions: 1, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
    });
    expect(Object.getPrototypeOf(sessionResult.imported)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(sessionResult.skipped)).toBe(Object.prototype);

    const stashStorage = makeStorage({ unrelated: 'preserve' });
    const stashRepository = makeStashRepository([stash('local-stash')]);
    const stashResult = await applyPortableImport(portable('stashes', {
      stashes: [stash('local-stash'), stash('new-stash')],
    }), {
      storage: stashStorage,
      stashRepository,
      now: () => 100,
    });
    expect(stashStorage.calls).toEqual({ getMany: [], setMany: [], removeMany: [] });
    expect(stashRepository.calls.list).toBe(1);
    expect(stashRepository.calls.replace).toHaveLength(1);
    expect(stashResult.imported.stashes).toBe(1);
    expect(stashResult.skipped.stashes).toBe(1);

    const settingsStorage = makeStorage({
      tabkebabSettings: { theme: 'light' },
      unrelated: 'preserve',
    });
    const settingsStashes = makeStashRepository([stash('never-read')]);
    const settingsResult = await applyPortableImport(portable('settings', {
      settings: { theme: 'dark' },
    }), {
      storage: settingsStorage,
      stashRepository: settingsStashes,
      now: () => 100,
    });
    expect(settingsStorage.calls.getMany).toEqual([['tabkebabSettings']]);
    expect(settingsStorage.calls.setMany).toEqual([{ tabkebabSettings: { theme: 'dark' } }]);
    expect(settingsStorage.calls.removeMany).toEqual([]);
    expect(settingsStashes.calls).toEqual({ list: 0, replace: [] });
    expect(settingsResult).toEqual({
      imported: { sessions: 0, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
      skipped: { sessions: 0, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
    });
  });

  test('full import merges every section once with deterministic counts and preserved AI secrets', async () => {
    const encryptedKey = storedAISettings().providerConfigs.openai.apiKey;
    const initial = storageSeed({
      sessions: [session('session-collision')],
      manualGroups: { 'group-collision': manualGroup('group-collision') },
      keepAwakeDomains: ['local.test'],
      tabkebabBookmarks: [bookmark('bookmark-collision')],
      focusProfilePrefs: { coding: { strictMode: false } },
      focusHistory: [history('run-collision')],
      driveSyncTombstones: tombstones({
        sessions: { 'session-new': 50 },
        manualGroups: { 'group-new': 60 },
      }),
      unrelated: { exact: ['preserve'] },
    });
    const beforeTombstones = clone(initial.driveSyncTombstones);
    const storage = makeStorage(initial);
    const stashRepository = makeStashRepository([stash('stash-collision')]);
    let clockCalls = 0;
    const document = portable('full', fullSections({
      sessions: [session('session-collision', 2), session('session-new', 3)],
      stashes: [stash('stash-collision', 2), stash('stash-new', 3)],
      manualGroups: {
        'group-collision': manualGroup('group-collision', 2),
        'group-new': manualGroup('group-new', 3),
      },
      keepAwakeDomains: ['imported.test'],
      bookmarks: [bookmark('bookmark-collision', 2), bookmark('bookmark-new', 3)],
      settings: { theme: 'dark' },
      focusProfilePrefs: {
        coding: { strictMode: true },
        review: { strictMode: true },
      },
      focusHistory: [history('run-collision', 2), history('run-new', 3)],
      aiSettings: publicAISettings({
        providerConfigs: { openai: { model: 'imported-model' } },
      }),
    }));

    const result = await applyPortableImport(document, {
      storage,
      stashRepository,
      now: () => {
        clockCalls += 1;
        return 100;
      },
    });

    expect(clockCalls).toBe(1);
    expect(storage.calls.getMany).toEqual([
      FULL_LOCAL_KEYS,
      ['driveSyncTombstones'],
    ]);
    expect(storage.calls.setMany).toHaveLength(1);
    expect(Object.keys(storage.calls.setMany[0])).toEqual(FULL_LOCAL_KEYS);
    expect(storage.calls.removeMany).toEqual([]);
    expect(stashRepository.calls.list).toBe(1);
    expect(stashRepository.calls.replace).toHaveLength(1);
    expect(result).toEqual({
      imported: { sessions: 1, stashes: 1, manualGroups: 1, bookmarks: 1, focusHistory: 1 },
      skipped: { sessions: 1, stashes: 1, manualGroups: 1, bookmarks: 1, focusHistory: 1 },
    });

    const after = storage.snapshot();
    expect(after.sessions.find(({ id }) => id === 'session-new').modifiedAt).toBe(100);
    expect(after.manualGroups['group-new'].modifiedAt).toBe(100);
    expect(after.driveSyncTombstones).toEqual(beforeTombstones);
    expect(after.unrelated).toEqual({ exact: ['preserve'] });
    expect(after.aiSettings.providerConfigs.openai.apiKey).toEqual(encryptedKey);
    expect(JSON.stringify(after.aiSettings.providerConfigs.openai.apiKey))
      .toBe(JSON.stringify(encryptedKey));
    expect(after.aiSettings.providerConfigs.openai.model).toBe('imported-model');
    expect(after.aiSettings.usePassphrase).toBeTrue();
    expect(after.focusProfilePrefs.coding).toEqual({ strictMode: false });
    expect(after.focusProfilePrefs.review).toEqual({ strictMode: true });
  });

  test('validates every incoming section before the first local or stash write', async () => {
    const storage = makeStorage({
      ...storageSeed(),
      driveSyncTombstones: tombstones(),
    });
    const stashRepository = makeStashRepository([stash('stored-stash')]);
    const invalid = {
      version: 2,
      kind: 'full',
      exportedAt: EXPORTED_AT,
      ...fullSections({
        aiSettings: {
          enabled: true,
          providerId: 'openai',
          providerConfigs: { openai: { model: 'model', apiKey: 'must-reject' } },
        },
      }),
    };

    await expect(applyPortableImport(invalid, {
      storage,
      stashRepository,
      now: () => 100,
    })).rejects.toThrow(/apiKey|secret|unknown|forbidden/i);
    expect(storage.calls.setMany).toEqual([]);
    expect(storage.calls.removeMany).toEqual([]);
    expect(stashRepository.calls.replace).toEqual([]);
  });

  test('rolls back every kind exactly and rethrows the original cause', async () => {
    const cases = [
      {
        kind: 'sessions',
        initial: { driveSyncTombstones: tombstones(), unrelated: 'safe' },
        sections: { sessions: [session('new-session')] },
        expectedRemovals: [['sessions']],
      },
      {
        kind: 'settings',
        initial: { tabkebabSettings: { theme: 'light' }, unrelated: 'safe' },
        sections: { settings: { theme: 'dark' } },
        expectedRemovals: [],
      },
    ];

    for (const entry of cases) {
      const originalCause = new Error(`${entry.kind} write failed`);
      const storage = makeStorage(entry.initial, {
        onSetMany: ({ call, commit }) => {
          if (call !== 1) return false;
          commit();
          throw originalCause;
        },
      });
      const stashRepository = makeStashRepository([stash('unrelated-stash')]);
      const before = storage.snapshot();
      let caught;
      try {
        await applyPortableImport(portable(entry.kind, entry.sections), {
          storage,
          stashRepository,
          now: () => 100,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(originalCause);
      expect(storage.snapshot()).toEqual(before);
      expect(storage.calls.removeMany).toEqual(entry.expectedRemovals);
      expect(stashRepository.calls).toEqual({ list: 0, replace: [] });
    }

    const stashCause = new Error('stash write failed');
    const stashStorage = makeStorage({ unrelated: 'safe' });
    const stashRepository = makeStashRepository([stash('prior')], {
      onReplace: ({ call, commit }) => {
        if (call !== 1) return false;
        commit();
        throw stashCause;
      },
    });
    await expect(applyPortableImport(portable('stashes', {
      stashes: [stash('incoming')],
    }), {
      storage: stashStorage,
      stashRepository,
      now: () => 100,
    })).rejects.toBe(stashCause);
    expect(stashStorage.calls).toEqual({ getMany: [], setMany: [], removeMany: [] });
    expect(stashRepository.snapshot()).toEqual([stash('prior')]);
    expect(stashRepository.calls.replace).toHaveLength(2);
  });

  test('restores full storage and stashes after a later stash commit fails', async () => {
    const originalCause = new Error('full stash replacement failed');
    const initial = storageSeed({
      focusHistory: undefined,
      driveSyncTombstones: tombstones({ sessions: { retained: 9 } }),
      unrelated: { nested: ['exact'] },
    });
    delete initial.aiSettings;
    const storage = makeStorage(initial);
    const stashRepository = makeStashRepository([stash('prior')], {
      onReplace: ({ call, commit }) => {
        if (call !== 1) return false;
        commit();
        throw originalCause;
      },
    });
    const beforeStorage = storage.snapshot();
    const beforeStashes = stashRepository.snapshot();

    await expect(applyPortableImport(portable('full', fullSections()), {
      storage,
      stashRepository,
      now: () => 100,
    })).rejects.toBe(originalCause);

    expect(storage.snapshot()).toEqual(beforeStorage);
    expect(stashRepository.snapshot()).toEqual(beforeStashes);
    expect(stashRepository.calls.replace).toHaveLength(2);
    expect(storage.calls.setMany).toHaveLength(2);
    expect(storage.calls.setMany[1].focusHistory).toBeUndefined();
    expect(storage.calls.removeMany).toEqual([['aiSettings']]);
    expect(storage.snapshot().driveSyncTombstones).toEqual({
      sessions: { retained: 9 },
      manualGroups: {},
    });
    expect(storage.snapshot().unrelated).toEqual({ nested: ['exact'] });
  });

  test('does not replace or roll back stashes when the preceding full local commit fails', async () => {
    const originalCause = new Error('full local write failed');
    const initial = storageSeed({
      driveSyncTombstones: tombstones(),
      unrelated: { exact: 'preserve' },
    });
    const storage = makeStorage(initial, {
      onSetMany: ({ call, commit }) => {
        if (call !== 1) return false;
        commit();
        throw originalCause;
      },
    });
    const stashRepository = makeStashRepository([stash('prior')]);
    const before = storage.snapshot();

    await expect(applyPortableImport(portable('full', fullSections()), {
      storage,
      stashRepository,
      now: () => 100,
    })).rejects.toBe(originalCause);

    expect(storage.snapshot()).toEqual(before);
    expect(storage.calls.setMany).toHaveLength(2);
    expect(stashRepository.calls.list).toBe(1);
    expect(stashRepository.calls.replace).toEqual([]);
    expect(stashRepository.snapshot()).toEqual([stash('prior')]);
  });

  test('reports safe rollback failures, preserves the cause, and attempts every reverse step', async () => {
    const originalCause = new Error('apply contains private payload https://private.test/');
    const stashRollbackFailure = new Error('stash restore native detail');
    const storageRollbackFailure = new Error('storage restore native detail');
    const removalRollbackFailure = new Error('remove absent native detail');
    const initial = storageSeed({
      driveSyncTombstones: tombstones(),
      unrelated: 'preserve',
    });
    delete initial.aiSettings;
    const storage = makeStorage(initial, {
      onSetMany: ({ call }) => {
        if (call === 2) throw storageRollbackFailure;
        return false;
      },
      onRemoveMany: () => { throw removalRollbackFailure; },
    });
    const stashRepository = makeStashRepository([stash('prior')], {
      onReplace: ({ call, commit }) => {
        if (call === 1) {
          commit();
          throw originalCause;
        }
        throw stashRollbackFailure;
      },
    });

    let caught;
    try {
      await applyPortableImport(portable('full', fullSections()), {
        storage,
        stashRepository,
        now: () => 100,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ImportRollbackError);
    expect(caught.cause).toBe(originalCause);
    expect(caught.message).toBe('Import failed and rollback was incomplete');
    expect(caught.rollbackFailures).toHaveLength(3);
    expect(caught.rollbackFailures).toEqual([
      {
        scope: 'stashes',
        operation: 'restore',
        message: 'Failed to restore the prior stash snapshot',
      },
      {
        scope: 'localStorage',
        operation: 'restore',
        message: 'Failed to restore prior local storage values',
      },
      {
        scope: 'localStorage',
        operation: 'removeAbsent',
        message: 'Failed to remove local storage keys created by the import',
      },
    ]);
    expect(caught.rollbackFailures.every((failure) => {
      return Object.getPrototypeOf(failure) === Object.prototype &&
        !(failure.message instanceof Error) &&
        !JSON.stringify(failure).includes('private.test');
    })).toBeTrue();
    expect(stashRepository.calls.replace).toHaveLength(2);
    expect(storage.calls.setMany).toHaveLength(2);
    expect(storage.calls.removeMany).toEqual([['aiSettings']]);
    expect(storage.snapshot().driveSyncTombstones).toEqual(tombstones());
    expect(storage.snapshot().unrelated).toBe('preserve');
  });

  test('rejects unsupported kinds and invalid clocks before repository reads', async () => {
    const storage = makeStorage(storageSeed());
    const stashRepository = makeStashRepository([stash('never-read')]);

    await expect(applyPortableImport({ kind: 'constructor' }, {
      storage,
      stashRepository,
      now: () => 100,
    })).rejects.toThrow(/kind|full|sessions|stashes|settings/i);
    await expect(applyPortableImport(portable('settings', { settings: {} }), {
      storage,
      stashRepository,
      now: () => Number.NaN,
    })).rejects.toThrow(/now|timestamp|integer|clock/i);
    expect(storage.calls).toEqual({ getMany: [], setMany: [], removeMany: [] });
    expect(stashRepository.calls).toEqual({ list: 0, replace: [] });
  });
});

describe('IndexedDB replacement boundary', () => {
  test('revalidates before opening IndexedDB and replaces in one clear-plus-put transaction', async () => {
    const originalIndexedDB = globalThis.indexedDB;
    const operations = [];
    let openCalls = 0;
    let transactionCalls = 0;
    const db = {
      objectStoreNames: { contains: () => true },
      transaction(storeName, mode) {
        transactionCalls += 1;
        operations.push(['transaction', storeName, mode]);
        const tx = {
          error: null,
          objectStore(name) {
            expect(name).toBe('stashes');
            return {
              clear() {
                operations.push(['clear']);
                return { error: null, onerror: null };
              },
              put(record) {
                operations.push(['put', clone(record)]);
                return { error: null, onerror: null };
              },
            };
          },
          abort() {},
          oncomplete: null,
          onerror: null,
          onabort: null,
        };
        setTimeout(() => tx.oncomplete?.(), 0);
        return tx;
      },
    };
    globalThis.indexedDB = {
      open() {
        openCalls += 1;
        const request = { result: db, error: null, onsuccess: null, onerror: null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    };

    try {
      const nonce = `${Date.now()}-${Math.random()}`;
      const { replaceAllStashes } = await import(`../../core/stash-db.js?replace=${nonce}`);
      await expect(replaceAllStashes([{ id: 'invalid-without-createdAt' }])).rejects.toThrow();
      expect(openCalls).toBe(0);

      await replaceAllStashes([stash('beta', 2), stash('alpha', 1)]);
      expect(openCalls).toBe(1);
      expect(transactionCalls).toBe(1);
      expect(operations).toEqual([
        ['transaction', 'stashes', 'readwrite'],
        ['clear'],
        ['put', stash('alpha', 1)],
        ['put', stash('beta', 2)],
      ]);
    } finally {
      if (originalIndexedDB === undefined) delete globalThis.indexedDB;
      else globalThis.indexedDB = originalIndexedDB;
    }
  });
});
