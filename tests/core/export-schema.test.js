import { describe, expect, test } from 'bun:test';

import {
  MAX_PORTABLE_IMPORT_BYTES,
  MAX_PORTABLE_NESTING_DEPTH,
  MAX_PORTABLE_SECTION_RECORDS,
  MAX_PORTABLE_STRING_LENGTH,
  MAX_PORTABLE_TABS_PER_RECORD,
  MAX_PORTABLE_TOTAL_TABS,
  PORTABLE_EXPORT_VERSION,
  createPortableExportDocument,
  mergePortableSections,
  parsePortableExportDocument,
  sanitizeAISettings,
  validateStashSection,
} from '../../core/export-schema.js';
import { PORTABLE_SETTINGS_KEYS, SETTINGS_DEFAULTS } from '../../core/settings.js';

const EXPORTED_AT = '2026-07-14T12:00:00.000Z';

function tab(index = 1, overrides = {}) {
  return {
    title: `Tab ${index}`,
    url: `https://example.test/${index}`,
    ...overrides,
  };
}

function session(id = 'session-1', timestamp = 1, tabs = [tab()]) {
  return {
    id,
    name: id,
    version: 2,
    createdAt: timestamp,
    modifiedAt: timestamp,
    windows: [{ tabCount: tabs.length, tabs }],
  };
}

function stash(id = 'stash-1', timestamp = 1, tabs = [tab()]) {
  return {
    id,
    name: id,
    createdAt: timestamp,
    tabCount: tabs.length,
    windows: [{ tabCount: tabs.length, tabs }],
  };
}

function manualGroup(name = 'Group', timestamp = 1, tabUrls = ['https://example.test/']) {
  return {
    name,
    color: 'blue',
    createdAt: timestamp,
    modifiedAt: timestamp,
    tabUrls,
  };
}

function bookmark(id = 'bookmark-1', timestamp = 1, tabs = [tab()]) {
  return {
    id,
    date: '2026-07-14',
    time: '12:00 PM',
    createdAt: timestamp,
    formats: {
      byWindows: [{ name: 'Window 1', tabs }],
    },
  };
}

function aiSettings(overrides = {}) {
  return {
    enabled: true,
    providerId: 'openai',
    usePassphrase: true,
    providerConfigs: {
      openai: {
        model: 'gpt-4.1-nano',
        apiKey: {
          ciphertext: 'ciphertext',
          salt: 'salt',
          iv: 'iv',
          usesPassphrase: true,
        },
      },
      custom: {
        model: 'default',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: { ciphertext: 'custom-secret' },
      },
    },
    ...overrides,
  };
}

function portableAISettings(overrides = {}) {
  return {
    enabled: true,
    providerId: 'openai',
    providerConfigs: {
      openai: { model: 'gpt-4.1-nano' },
      custom: { model: 'default', baseUrl: 'http://localhost:11434/v1' },
    },
    ...overrides,
  };
}

function fullSections(overrides = {}) {
  return {
    sessions: [session()],
    stashes: [stash()],
    manualGroups: { 'group-1': manualGroup() },
    keepAwakeDomains: ['example.test'],
    bookmarks: [bookmark()],
    settings: { theme: 'dark', maxTabsPerWindow: 50, recommendedTabsPerWindow: 20 },
    focusProfilePrefs: {
      coding: {
        blockedCategories: ['social'],
        allowlist: [{ type: 'domain', value: 'example.test' }],
        blockedDomains: [],
        strictMode: false,
        aiBlocking: false,
        duration: 25,
        tabAction: 'kebab',
      },
    },
    focusHistory: [{
      id: 'history-record-1',
      runId: 'run-1',
      profileId: 'coding',
      startedAt: 1,
      endedAt: 2,
    }],
    aiSettings: portableAISettings(),
    ...overrides,
  };
}

function v2(kind, sections, overrides = {}) {
  return {
    version: PORTABLE_EXPORT_VERSION,
    kind,
    exportedAt: EXPORTED_AT,
    ...sections,
    ...overrides,
  };
}

function ownKeyScan(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') found.push(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) ownKeyScan(descriptor.value, found);
  }
  return found;
}

describe('portable export v2 envelope and sanitization', () => {
  test('exports the fixed constants and exact settings allowlist', () => {
    expect(PORTABLE_EXPORT_VERSION).toBe(2);
    expect(MAX_PORTABLE_IMPORT_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_PORTABLE_SECTION_RECORDS).toBe(10_000);
    expect(MAX_PORTABLE_TABS_PER_RECORD).toBe(10_000);
    expect(MAX_PORTABLE_TOTAL_TABS).toBe(100_000);
    expect(MAX_PORTABLE_STRING_LENGTH).toBe(16_384);
    expect(MAX_PORTABLE_NESTING_DEPTH).toBe(12);
    expect(PORTABLE_SETTINGS_KEYS).toEqual(Object.keys(SETTINGS_DEFAULTS));
    expect(Object.isFrozen(PORTABLE_SETTINGS_KEYS)).toBeTrue();
  });

  test('creates and parses a complete canonical full document', () => {
    const created = createPortableExportDocument('full', fullSections(), EXPORTED_AT);
    const parsed = parsePortableExportDocument(created);

    expect(parsed.version).toBe(2);
    expect(parsed.kind).toBe('full');
    expect(parsed.exportedAt).toBe(EXPORTED_AT);
    expect(Object.keys(parsed)).toEqual([
      'version',
      'kind',
      'exportedAt',
      'sessions',
      'stashes',
      'manualGroups',
      'keepAwakeDomains',
      'bookmarks',
      'settings',
      'focusProfilePrefs',
      'focusHistory',
      'aiSettings',
    ]);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.getPrototypeOf(parsed.manualGroups)).toBeNull();
    expect(Object.getPrototypeOf(parsed.focusProfilePrefs)).toBeNull();
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.stashes).toHaveLength(1);
  });

  test('requires only the named section for every partial kind', () => {
    for (const [kind, section, value] of [
      ['sessions', 'sessions', [session()]],
      ['stashes', 'stashes', [stash()]],
      ['settings', 'settings', { theme: 'light' }],
    ]) {
      const created = createPortableExportDocument(kind, { [section]: value }, EXPORTED_AT);
      expect(Object.keys(created)).toEqual(['version', 'kind', 'exportedAt', section]);
      expect(parsePortableExportDocument(created)).toEqual(created);
    }
  });

  test('accepts current run IDs and published legacy history IDs as separate identities', () => {
    const merged = mergePortableSections(
      {
        focusHistory: [
          { id: 'legacy-shared', result: 'local-legacy' },
          { id: 'current-record', runId: 'run-shared', result: 'local-current' },
        ],
      },
      {
        focusHistory: [
          { id: 'legacy-shared', result: 'imported-legacy' },
          { id: 'other-record', runId: 'run-shared', result: 'imported-current' },
          { id: 'run-shared', result: 'legacy-namespace-is-distinct' },
        ],
      },
      { tombstones: { sessions: {}, manualGroups: {} }, now: 100 },
    );

    expect(merged.focusHistory).toHaveLength(3);
    expect(merged.focusHistory.find((entry) => entry.id === 'legacy-shared').result)
      .toBe('local-legacy');
    expect(merged.focusHistory.find((entry) => entry.runId === 'run-shared').result)
      .toBe('local-current');
    expect(merged.focusHistory.find((entry) => entry.id === 'run-shared' && !entry.runId).result)
      .toBe('legacy-namespace-is-distinct');
  });

  test('omits structured-clone undefined object fields only while creating an export', () => {
    const storedStash = stash('stored-stash');
    storedStash.windows[0].tabs[0].favIconUrl = undefined;
    storedStash.windows[0].tabs[0].title = undefined;
    const storedSession = session('stored-session');
    storedSession.windows[0].tabs[0].pendingUrl = undefined;

    const created = createPortableExportDocument('full', fullSections({
      sessions: [storedSession],
      stashes: [storedStash],
    }), EXPORTED_AT);
    expect(Object.hasOwn(created.stashes[0].windows[0].tabs[0], 'favIconUrl')).toBeFalse();
    expect(Object.hasOwn(created.stashes[0].windows[0].tabs[0], 'title')).toBeFalse();
    expect(Object.hasOwn(created.sessions[0].windows[0].tabs[0], 'pendingUrl')).toBeFalse();

    const merged = mergePortableSections(
      { sessions: [storedSession], stashes: [storedStash] },
      {},
      { tombstones: { sessions: {}, manualGroups: {} }, now: 100 },
    );
    expect(Object.hasOwn(merged.stashes[0].windows[0].tabs[0], 'favIconUrl')).toBeFalse();
    expect(Object.hasOwn(merged.sessions[0].windows[0].tabs[0], 'pendingUrl')).toBeFalse();

    expect(() => parsePortableExportDocument(v2('stashes', {
      stashes: [storedStash],
    }))).toThrow(/JSON|undefined|value/i);
  });

  test('canonicalizes export source strings exactly once before schema validation', () => {
    const sentinel = 'single-traversal-export-sentinel';
    const originalEncode = TextEncoder.prototype.encode;
    let sentinelEncodes = 0;
    TextEncoder.prototype.encode = function countedEncode(value) {
      if (value === sentinel) sentinelEncodes += 1;
      return originalEncode.call(this, value);
    };
    try {
      const created = createPortableExportDocument('sessions', {
        sessions: [session('single-pass', 1, [tab(1, { title: sentinel })])],
      }, EXPORTED_AT);
      expect(created.sessions[0].windows[0].tabs[0].title).toBe(sentinel);
      expect(sentinelEncodes).toBe(1);
    } finally {
      TextEncoder.prototype.encode = originalEncode;
    }
  });

  test('serializes deterministically across input record key orders', () => {
    const first = fullSections({
      manualGroups: {
        zed: manualGroup('Zed'),
        alpha: { modifiedAt: 1, createdAt: 1, tabUrls: [], color: 'red', name: 'Alpha' },
      },
      focusProfilePrefs: {
        zed: { strictMode: false, nested: { z: 1, a: 2 } },
        alpha: { strictMode: true },
      },
    });
    const second = fullSections({
      manualGroups: {
        alpha: { name: 'Alpha', color: 'red', tabUrls: [], createdAt: 1, modifiedAt: 1 },
        zed: manualGroup('Zed'),
      },
      focusProfilePrefs: {
        alpha: { strictMode: true },
        zed: { nested: { a: 2, z: 1 }, strictMode: false },
      },
    });

    expect(JSON.stringify(createPortableExportDocument('full', first, EXPORTED_AT)))
      .toBe(JSON.stringify(createPortableExportDocument('full', second, EXPORTED_AT)));
  });

  test('constructs AI export fields without copying secrets or storage metadata', () => {
    const sanitized = sanitizeAISettings(aiSettings({
      installId: 'install-secret',
      cache: { token: 'cached-secret' },
      unknown: 'drop-me',
    }));
    expect(sanitized).toEqual({
      enabled: true,
      providerId: 'openai',
      providerConfigs: {
        custom: { baseUrl: 'http://localhost:11434/v1', model: 'default' },
        openai: { model: 'gpt-4.1-nano' },
      },
    });
    const document = createPortableExportDocument('full', fullSections({
      aiSettings: aiSettings(),
    }), EXPORTED_AT);
    const forbidden = new Set([
      'apiKey', 'token', 'credential', 'installId', 'focusState', 'driveSync',
      'cache', 'usePassphrase', 'usesPassphrase', 'ciphertext', 'salt', 'iv',
    ]);
    expect(ownKeyScan(document).filter((key) => forbidden.has(key))).toEqual([]);
  });
});

describe('portable v1 compatibility', () => {
  test('normalizes the current full export shape to a complete in-memory v2 document', () => {
    const parsed = parsePortableExportDocument({
      version: 1,
      exportedAt: EXPORTED_AT,
      sessions: [session()],
      manualGroups: { legacy: manualGroup('Legacy') },
      keepAwakeDomains: ['legacy.test'],
      stashes: [stash()],
    });
    expect(parsed.version).toBe(2);
    expect(parsed.kind).toBe('full');
    for (const section of [
      'sessions', 'stashes', 'manualGroups', 'keepAwakeDomains', 'bookmarks',
      'settings', 'focusProfilePrefs', 'focusHistory', 'aiSettings',
    ]) {
      expect(Object.hasOwn(parsed, section)).toBeTrue();
    }
    expect(parsed.bookmarks).toEqual([]);
    expect(parsed.settings).toEqual({});
    expect(parsed.aiSettings).toEqual({ enabled: false, providerId: null, providerConfigs: {} });
  });

  test('infers each current v1 partial kind without adding unrelated sections', () => {
    for (const [kind, section, value] of [
      ['sessions', 'sessions', [session('legacy-session')]],
      ['stashes', 'stashes', [stash('legacy-stash')]],
      ['settings', 'settings', { theme: 'dark' }],
    ]) {
      const parsed = parsePortableExportDocument({
        version: 1,
        exportedAt: EXPORTED_AT,
        [section]: value,
      });
      expect(parsed.kind).toBe(kind);
      expect(Object.keys(parsed)).toEqual(['version', 'kind', 'exportedAt', section]);
    }
  });

  test('normalizes legacy Drive settings and unversioned session/stash backups', () => {
    const savedAt = Date.UTC(2026, 6, 14, 12, 0, 0);
    const expectedExportedAt = new Date(savedAt).toISOString();

    const settingsDocument = parsePortableExportDocument({
      version: 1,
      savedAt,
      settings: { theme: 'dark' },
    });
    expect(settingsDocument).toMatchObject({
      version: 2,
      kind: 'settings',
      exportedAt: expectedExportedAt,
      settings: { theme: 'dark' },
    });

    for (const [kind, section, value] of [
      ['sessions', 'sessions', [session('drive-session')]],
      ['stashes', 'stashes', [stash('drive-stash')]],
    ]) {
      const parsed = parsePortableExportDocument({
        [section]: value,
        exportedAt: savedAt,
      });
      expect(parsed.kind).toBe(kind);
      expect(parsed.exportedAt).toBe(expectedExportedAt);
      expect(parsed[section]).toHaveLength(1);
    }

    const missingVersionSettings = parsePortableExportDocument({
      savedAt,
      settings: { theme: 'light' },
    });
    expect(missingVersionSettings.kind).toBe('settings');
    expect(missingVersionSettings.exportedAt).toBe(expectedExportedAt);
  });
});

describe('portable schema preflight rejection', () => {
  test('rejects unsupported envelopes, missing sections, extras, and malformed timestamps', () => {
    expect(() => parsePortableExportDocument(v2('full', fullSections(), { version: 3 })))
      .toThrow(/version/i);
    expect(() => parsePortableExportDocument(v2('unknown', {}))).toThrow(/kind/i);
    expect(() => parsePortableExportDocument(v2('full', { ...fullSections(), stashes: undefined })))
      .toThrow();
    const missing = v2('full', fullSections());
    delete missing.bookmarks;
    expect(() => parsePortableExportDocument(missing)).toThrow(/bookmarks|required/i);
    expect(() => parsePortableExportDocument(v2('sessions', {
      sessions: [session()],
      stashes: [stash()],
    }))).toThrow(/stashes|section|unknown/i);
    expect(() => parsePortableExportDocument(v2('sessions', { sessions: [session()] }, {
      exportedAt: 'not-an-iso-date',
    }))).toThrow(/exportedAt|date|timestamp/i);
    expect(() => parsePortableExportDocument(v2('sessions', { sessions: [session()] }, {
      extra: true,
    }))).toThrow(/extra|unknown/i);
    expect(() => createPortableExportDocument('full', { sessions: [] }, EXPORTED_AT))
      .toThrow(/required|section/i);
  });

  test('rejects malformed stable IDs, duplicates, timestamps, maps, and tab structures', () => {
    const inheritedId = Object.create({ id: 'inherited' });
    Object.assign(inheritedId, session('own'));
    delete inheritedId.id;
    for (const sessions of [
      [{ ...session('missing'), id: undefined }],
      [inheritedId],
      [session('duplicate'), session('duplicate')],
      [{ ...session('timestamp'), modifiedAt: '1' }],
      [{ ...session('windows'), windows: {} }],
      [{ ...session('tabs'), windows: [{ tabs: {} }] }],
    ]) {
      expect(() => parsePortableExportDocument(v2('sessions', { sessions }))).toThrow();
    }

    expect(() => parsePortableExportDocument(v2('full', fullSections({ manualGroups: [] }))))
      .toThrow(/manualGroups|map|object/i);
    expect(() => parsePortableExportDocument(v2('full', fullSections({ settings: [] }))))
      .toThrow(/settings|object/i);
    expect(() => parsePortableExportDocument(v2('full', fullSections({ focusProfilePrefs: [] }))))
      .toThrow(/focusProfilePrefs|object|map/i);
    expect(() => parsePortableExportDocument(v2('full', fullSections({ aiSettings: [] }))))
      .toThrow(/aiSettings|object/i);
    expect(() => parsePortableExportDocument(v2('full', fullSections({
      focusHistory: [{}],
    })))).toThrow(/focusHistory|runId|ID/i);
    expect(() => parsePortableExportDocument(v2('full', fullSections({
      focusHistory: [{ runId: 'duplicate' }, { runId: 'duplicate' }],
    })))).toThrow(/focusHistory|runId|duplicate/i);
  });

  test('rejects non-JSON values, accessors, sparse arrays, symbols, cycles, and polluted keys', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined, 1n, Symbol('bad'), () => {}]) {
      const document = v2('settings', { settings: { theme: 'dark', bad } });
      expect(() => parsePortableExportDocument(document)).toThrow(/JSON|finite|value|symbol/i);
    }

    const cycle = {};
    cycle.self = cycle;
    expect(() => parsePortableExportDocument(v2('settings', { settings: { cycle } })))
      .toThrow(/cycle/i);

    const accessor = {};
    Object.defineProperty(accessor, 'theme', {
      enumerable: true,
      get() { throw new Error('getter must not run'); },
    });
    expect(() => parsePortableExportDocument(v2('settings', { settings: accessor })))
      .toThrow(/data|property|inspect/i);

    const sparse = new Array(2);
    sparse[1] = session('sparse');
    expect(() => parsePortableExportDocument(v2('sessions', { sessions: sparse })))
      .toThrow(/sparse|array|own/i);

    const symbolRecord = { theme: 'dark' };
    symbolRecord[Symbol('secret')] = true;
    expect(() => parsePortableExportDocument(v2('settings', { settings: symbolRecord })))
      .toThrow(/symbol|key/i);

    for (const dangerous of ['__proto__', 'constructor', 'prototype']) {
      const root = JSON.parse(JSON.stringify(v2('settings', { settings: { theme: 'dark' } })));
      Object.defineProperty(root.settings, dangerous, { value: 'polluted', enumerable: true });
      expect(() => parsePortableExportDocument(root)).toThrow(/prototype|key|pollution/i);
    }
  });

  test('rejects a hostile oversized sparse array before walking its declared length', () => {
    const oversized = [];
    oversized.length = MAX_PORTABLE_TOTAL_TABS + 1;
    expect(() => parsePortableExportDocument(v2('sessions', { sessions: oversized })))
      .toThrow(/array.*100,?000|100,?000.*array|array.*limit/i);
  });

  test('rejects an oversized object before sorting its hostile own-key list', () => {
    const keys = Array.from(
      { length: MAX_PORTABLE_TOTAL_TABS + 1 },
      (_, index) => `key-${index}`,
    );
    const hostile = new Proxy({}, {
      ownKeys() { return keys; },
    });
    const originalSort = Array.prototype.sort;
    let oversizedSortCalled = false;
    Array.prototype.sort = function guardedSort(...args) {
      if (this.length > MAX_PORTABLE_TOTAL_TABS) {
        oversizedSortCalled = true;
        throw new Error('oversized key list reached sort');
      }
      return originalSort.apply(this, args);
    };
    try {
      expect(() => parsePortableExportDocument(v2('full', fullSections({
        focusProfilePrefs: hostile,
      })))).toThrow(/object|property|100,?000|traversal|limit/i);
      expect(oversizedSortCalled).toBeFalse();
    } finally {
      Array.prototype.sort = originalSort;
    }
  });

  test('rejects imported AI secrets and unknown provider fields instead of sanitizing them', () => {
    const apiKey = v2('full', fullSections({
      aiSettings: {
        enabled: true,
        providerId: 'openai',
        providerConfigs: { openai: { model: 'gpt-4.1-nano', apiKey: { ciphertext: 'secret' } } },
      },
    }));
    expect(() => parsePortableExportDocument(apiKey)).toThrow(/apiKey|secret|forbidden/i);

    const nestedApiKey = v2('full', fullSections({
      aiSettings: {
        enabled: true,
        providerId: 'custom',
        providerConfigs: { custom: { model: 'default', baseUrl: 'http://localhost', nested: { apiKey: 'secret' } } },
      },
    }));
    expect(() => parsePortableExportDocument(nestedApiKey)).toThrow(/apiKey|unknown|forbidden/i);

    const unknownProviderField = v2('full', fullSections({
      aiSettings: {
        enabled: true,
        providerId: 'openai',
        providerConfigs: { openai: { model: 'gpt-4.1-nano', temperature: 0.5 } },
      },
    }));
    expect(() => parsePortableExportDocument(unknownProviderField))
      .toThrow(/temperature|unknown|field/i);
  });

  test('rejects forbidden secret/cache fields outside AI rather than exporting them', () => {
    for (const forbidden of ['token', 'credential', 'installId', 'focusState', 'driveSync', 'cache']) {
      const unsafe = session(`unsafe-${forbidden}`);
      unsafe.metadata = { [forbidden]: 'must-not-export' };
      expect(() => createPortableExportDocument('sessions', { sessions: [unsafe] }, EXPORTED_AT))
        .toThrow(/forbidden|secret|field|key/i);
    }
  });

  test('validates stash sections directly through the exported transaction boundary', () => {
    const valid = validateStashSection([stash('beta'), stash('alpha')]);
    expect(valid.map((entry) => entry.id)).toEqual(['alpha', 'beta']);
    expect(Object.getPrototypeOf(valid[0])).toBeNull();

    for (const invalid of [
      {},
      [null],
      [{ ...stash('missing'), id: undefined }],
      [{ id: 'missing-created-at' }],
      [stash('duplicate'), stash('duplicate')],
      [{ ...stash('timestamp'), createdAt: '1' }],
      [{ ...stash('windows'), windows: {} }],
      [{ ...stash('tabs'), windows: [{ tabs: {} }] }],
    ]) {
      expect(() => validateStashSection(invalid)).toThrow();
    }
  });

  test('revalidates a mutated parsed stash without trusting prior canonicalization', () => {
    const parsed = createPortableExportDocument('stashes', {
      stashes: [stash('mutable-stash')],
    }, EXPORTED_AT);
    parsed.stashes[0].metadata = {
      apiKey: 'must-not-pass-the-transaction-boundary',
      nested: { invalid: undefined },
    };
    expect(() => validateStashSection(parsed.stashes)).toThrow(/apiKey|secret|JSON|undefined/i);
  });
});

describe('portable resource boundaries', () => {
  test('rejects more than 10,000 records in every record-bearing section', () => {
    const tooManyStrings = Array.from(
      { length: MAX_PORTABLE_SECTION_RECORDS + 1 },
      (_, index) => `domain-${index}.test`,
    );
    const cases = [
      ['sessions', Array.from({ length: MAX_PORTABLE_SECTION_RECORDS + 1 },
        (_, index) => session(`session-${index}`, 1, []))],
      ['stashes', Array.from({ length: MAX_PORTABLE_SECTION_RECORDS + 1 },
        (_, index) => stash(`stash-${index}`, 1, []))],
      ['keepAwakeDomains', tooManyStrings],
      ['bookmarks', Array.from({ length: MAX_PORTABLE_SECTION_RECORDS + 1 },
        (_, index) => bookmark(`bookmark-${index}`, index, []))],
      ['focusHistory', Array.from({ length: MAX_PORTABLE_SECTION_RECORDS + 1 },
        (_, index) => ({ runId: `run-${index}` }))],
    ];
    for (const [section, value] of cases) {
      expect(() => parsePortableExportDocument(v2('full', fullSections({ [section]: value }))))
        .toThrow(/10,?000|record|limit/i);
    }

    const groups = Object.create(null);
    const prefs = Object.create(null);
    for (let index = 0; index <= MAX_PORTABLE_SECTION_RECORDS; index += 1) {
      groups[`group-${index}`] = manualGroup(`Group ${index}`, 1, []);
      prefs[`profile-${index}`] = { strictMode: false };
    }
    expect(() => parsePortableExportDocument(v2('full', fullSections({ manualGroups: groups }))))
      .toThrow(/10,?000|record|limit/i);
    expect(() => parsePortableExportDocument(v2('full', fullSections({ focusProfilePrefs: prefs }))))
      .toThrow(/10,?000|record|limit/i);
  });

  test('rejects more than 10,000 tabs in one session or stash record', () => {
    const tabs = Array.from({ length: MAX_PORTABLE_TABS_PER_RECORD + 1 },
      () => ({ url: 'https://x.test/' }));
    expect(() => parsePortableExportDocument(v2('sessions', {
      sessions: [session('too-many-tabs', 1, tabs)],
    }))).toThrow(/10,?000|tab|limit/i);
    expect(() => validateStashSection([stash('too-many-tabs', 1, tabs)]))
      .toThrow(/10,?000|tab|limit/i);
  });

  test('rejects more than 100,000 tabs across otherwise bounded records', () => {
    const tenThousandTabs = Array.from({ length: MAX_PORTABLE_TABS_PER_RECORD },
      () => ({ url: 'https://x.test/' }));
    const sessions = Array.from({ length: MAX_PORTABLE_TOTAL_TABS / MAX_PORTABLE_TABS_PER_RECORD },
      (_, index) => session(`max-${index}`, 1, tenThousandTabs));
    sessions.push(session('overflow', 1, [{ url: 'https://x.test/' }]));
    expect(() => parsePortableExportDocument(v2('sessions', { sessions })))
      .toThrow(/100,?000|total|tab|limit/i);
  });

  test('rejects overlong strings and nesting beyond depth 12', () => {
    expect(() => parsePortableExportDocument(v2('sessions', {
      sessions: [session('x'.repeat(MAX_PORTABLE_STRING_LENGTH + 1), 1, [])],
    }))).toThrow(/string|length|16,?384/i);

    let nested = 'leaf';
    for (let index = 0; index <= MAX_PORTABLE_NESTING_DEPTH; index += 1) {
      nested = { next: nested };
    }
    expect(() => parsePortableExportDocument(v2('full', fullSections({
      focusProfilePrefs: { coding: nested },
    })))).toThrow(/depth|nest/i);
  });

  test('rejects cumulative in-memory cost above 25 MiB before section merge', () => {
    const prefs = Object.create(null);
    for (let index = 0; index < 1_600; index += 1) {
      prefs[`profile-${index}`] = { blob: 'x'.repeat(MAX_PORTABLE_STRING_LENGTH) };
    }
    expect(() => parsePortableExportDocument(v2('full', fullSections({
      focusProfilePrefs: prefs,
    })))).toThrow(/25|MiB|byte|budget|size/i);
  });

  test('rejects before merge inputs can be observed or mutated', () => {
    const existing = Object.freeze(fullSections());
    let incomingIdReads = 0;
    const incomingSession = session('incoming');
    Object.defineProperty(incomingSession, 'id', {
      enumerable: true,
      get() {
        incomingIdReads += 1;
        return 'incoming';
      },
    });
    expect(() => mergePortableSections(existing, { sessions: [incomingSession] }, {
      tombstones: { sessions: {}, manualGroups: {} },
      now: 10,
    })).toThrow(/data|property|inspect/i);
    expect(incomingIdReads).toBe(0);
  });

  test('rejects more than 10,000 tombstones in either external authority map', () => {
    for (const kind of ['sessions', 'manualGroups']) {
      const entries = Object.create(null);
      for (let index = 0; index <= MAX_PORTABLE_SECTION_RECORDS; index += 1) {
        entries[`deleted-${index}`] = index;
      }
      expect(() => mergePortableSections({}, {}, {
        tombstones: {
          sessions: kind === 'sessions' ? entries : {},
          manualGroups: kind === 'manualGroups' ? entries : {},
        },
        now: 100,
      })).toThrow(/tombstone|10,?000|limit/i);
    }
  });

  test('permits existing secrets only inside AI settings during merge', () => {
    const unsafeSession = session('local-secret');
    unsafeSession.metadata = { token: 'must-not-survive' };
    expect(() => mergePortableSections(
      { sessions: [unsafeSession] },
      { sessions: [] },
      { tombstones: { sessions: {}, manualGroups: {} }, now: 100 },
    )).toThrow(/token|secret|forbidden/i);
  });
});

describe('secret-free portable section merge', () => {
  test('keeps distinct legacy bookmark tuples containing delimiter characters', () => {
    const first = bookmark(undefined, 7, []);
    delete first.id;
    first.date = 'a';
    first.time = 'b\u0000c';
    const second = bookmark(undefined, 7, []);
    delete second.id;
    second.date = 'a\u0000b';
    second.time = 'c';

    const parsed = parsePortableExportDocument(v2('full', fullSections({
      bookmarks: [first, second],
    })));
    expect(parsed.bookmarks).toHaveLength(2);

    const merged = mergePortableSections(
      { bookmarks: [first] },
      { bookmarks: [second] },
      { tombstones: { sessions: {}, manualGroups: {} }, now: 100 },
    );
    expect(merged.bookmarks).toHaveLength(2);
  });

  test('applies every fixed collision rule with deterministic output', () => {
    const localBookmark = bookmark('bookmark-collision', 1);
    const importedBookmark = { ...bookmark('bookmark-collision', 2), imported: true };
    const localLegacy = { ...bookmark(undefined, 3), id: undefined, local: true };
    delete localLegacy.id;
    const importedLegacy = { ...localLegacy, local: false, imported: true };
    const importedNewLegacy = { ...localLegacy, time: '12:01 PM', imported: true };
    const existing = fullSections({
      sessions: [session('collision', 1), session('local-only', 1)],
      stashes: [stash('collision', 1), stash('local-only', 1)],
      manualGroups: {
        collision: manualGroup('Local Group'),
        local: manualGroup('Local Only'),
      },
      keepAwakeDomains: ['zed.test', 'shared.test'],
      bookmarks: [localBookmark, localLegacy],
      settings: { theme: 'dark', maxTabsPerWindow: 50, recommendedTabsPerWindow: 20 },
      focusProfilePrefs: { coding: { duration: 25 }, local: { duration: 10 } },
      focusHistory: [
        { runId: 'history-collision', result: 'local-run' },
        { runId: 'history-local', result: 'local-only' },
      ],
    });
    const incoming = fullSections({
      sessions: [session('collision', 2), session('imported-only', 2)],
      stashes: [stash('collision', 2), stash('imported-only', 2)],
      manualGroups: {
        collision: manualGroup('Imported Group'),
        imported: manualGroup('Imported Only'),
      },
      keepAwakeDomains: ['alpha.test', 'shared.test'],
      bookmarks: [importedBookmark, importedLegacy, importedNewLegacy],
      settings: { theme: 'light' },
      focusProfilePrefs: { coding: { duration: 50 }, imported: { duration: 40 } },
      focusHistory: [
        { runId: 'history-collision', result: 'imported-run' },
        { runId: 'history-imported', result: 'imported-only' },
      ],
    });

    const merged = mergePortableSections(existing, incoming, {
      tombstones: { sessions: {}, manualGroups: {} },
      now: 100,
    });

    expect(merged.sessions.find((entry) => entry.id === 'collision').createdAt).toBe(1);
    expect(merged.sessions.map((entry) => entry.id)).toEqual(['collision', 'imported-only', 'local-only']);
    expect(merged.stashes.find((entry) => entry.id === 'collision').createdAt).toBe(1);
    expect(merged.stashes.map((entry) => entry.id)).toEqual(['collision', 'imported-only', 'local-only']);
    expect(merged.manualGroups.collision.name).toBe('Local Group');
    expect(Object.keys(merged.manualGroups)).toEqual(['collision', 'imported', 'local']);
    expect(merged.focusProfilePrefs.coding.duration).toBe(25);
    expect(Object.keys(merged.focusProfilePrefs)).toEqual(['coding', 'imported', 'local']);
    expect(merged.keepAwakeDomains).toEqual(['alpha.test', 'shared.test', 'zed.test']);
    expect(merged.bookmarks.find((entry) => entry.id === 'bookmark-collision')).toEqual(localBookmark);
    expect(merged.bookmarks.filter((entry) => !entry.id)).toHaveLength(2);
    expect(merged.bookmarks.find((entry) => !entry.id && entry.time === '12:00 PM').local).toBeTrue();
    expect(merged.focusHistory.find((entry) => entry.runId === 'history-collision').result).toBe('local-run');
    expect(merged.settings.theme).toBe('light');
    expect(merged.settings.maxTabsPerWindow).toBe(50);
    expect(JSON.stringify(merged)).toBe(JSON.stringify(mergePortableSections(existing, incoming, {
      tombstones: { sessions: {}, manualGroups: {} },
      now: 100,
    })));
  });

  test('preserves encrypted AI credentials and passphrase metadata byte-for-byte', () => {
    const encrypted = {
      ciphertext: 'existing-ciphertext',
      salt: 'existing-salt',
      iv: 'existing-iv',
      usesPassphrase: true,
      extraEncryptionMetadata: { version: 7 },
    };
    const existingAI = {
      enabled: true,
      providerId: 'openai',
      usePassphrase: { version: 3, required: true },
      providerConfigs: {
        openai: { model: 'old-model', apiKey: encrypted },
        custom: {
          model: 'old-custom',
          baseUrl: 'http://old.local/v1',
          apiKey: { ciphertext: 'custom-ciphertext' },
        },
      },
    };
    const before = structuredClone(existingAI);
    const openAIKeyBytes = JSON.stringify(existingAI.providerConfigs.openai.apiKey);
    const customKeyBytes = JSON.stringify(existingAI.providerConfigs.custom.apiKey);
    const passphraseBytes = JSON.stringify(existingAI.usePassphrase);
    const merged = mergePortableSections(
      { ...fullSections(), aiSettings: existingAI },
      { aiSettings: {
        enabled: false,
        providerId: 'custom',
        providerConfigs: {
          openai: { model: 'new-model' },
          custom: { model: 'new-custom', baseUrl: 'http://new.local/v1' },
        },
      } },
      { tombstones: { sessions: {}, manualGroups: {} }, now: 100 },
    );

    expect(existingAI).toEqual(before);
    expect(merged.aiSettings.enabled).toBeFalse();
    expect(merged.aiSettings.providerId).toBe('custom');
    expect(merged.aiSettings.usePassphrase).toEqual(before.usePassphrase);
    expect(merged.aiSettings.providerConfigs.openai.apiKey).toEqual(before.providerConfigs.openai.apiKey);
    expect(merged.aiSettings.providerConfigs.custom.apiKey).toEqual(before.providerConfigs.custom.apiKey);
    expect(JSON.stringify(merged.aiSettings.providerConfigs.openai.apiKey)).toBe(openAIKeyBytes);
    expect(JSON.stringify(merged.aiSettings.providerConfigs.custom.apiKey)).toBe(customKeyBytes);
    expect(JSON.stringify(merged.aiSettings.usePassphrase)).toBe(passphraseBytes);
    expect(merged.aiSettings.providerConfigs.openai.model).toBe('new-model');
    expect(merged.aiSettings.providerConfigs.custom).toMatchObject({
      model: 'new-custom',
      baseUrl: 'http://new.local/v1',
    });
  });

  test('revives explicitly imported sessions and groups above tombstones without clearing them', () => {
    const tombstones = {
      sessions: { revived: 50 },
      manualGroups: { revived: 70 },
    };
    const before = structuredClone(tombstones);
    const merged = mergePortableSections(
      fullSections({ sessions: [], manualGroups: {} }),
      {
        sessions: [session('revived', 20)],
        manualGroups: { revived: manualGroup('Revived', 30) },
      },
      { tombstones, now: 10 },
    );

    expect(merged.sessions).toHaveLength(1);
    expect(merged.sessions[0].modifiedAt).toBe(51);
    expect(merged.manualGroups.revived.modifiedAt).toBe(71);
    expect(tombstones).toEqual(before);
    expect(Object.hasOwn(merged, 'tombstones')).toBeFalse();
  });
});
