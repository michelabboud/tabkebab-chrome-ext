import { describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { sendOrThrow } from '../../sidepanel/message-client.js';

let importNonce = 0;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function driveFile(id, name, scope, modifiedTime) {
  return { id, name, scope, modifiedTime, size: '1' };
}

function warningText(warnings) {
  return warnings
    .flatMap((args) => args.map((value) => value instanceof Error
      ? `${value.message}\n${value.stack || ''}`
      : String(value)))
    .join('\n');
}

async function importDriveClient(label) {
  return import(`../../core/drive-client.js?${label}=${++importNonce}`);
}

async function importWorker(label) {
  return import(`../../service-worker.js?${label}=${++importNonce}`);
}

function folderRouter({ pages = {}, failCopy = false, calls = [] } = {}) {
  const ids = {
    TabKebab: 'root-id',
    Profile: 'profile-id',
    Old: 'old-profile-id',
    New: 'new-profile-id',
    sessions: 'sessions-id',
    stashes: 'stashes-id',
    bookmarks: 'bookmarks-id',
    archive: 'archive-id',
  };

  return async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || 'GET';
    calls.push({ url: url.toString(), method });

    if (failCopy && method === 'POST' && /\/files\/[^/]+\/copy$/.test(url.pathname)) {
      return jsonResponse({}, 400);
    }

    if (method === 'PATCH') return jsonResponse({ id: 'patched' });
    if (method === 'POST' && url.pathname.endsWith('/files')) return jsonResponse({ id: 'created-id' });
    if (method !== 'GET') return jsonResponse({});

    const query = url.searchParams.get('q') || '';
    const parentMatch = query.match(/'([^']+)' in parents/);
    const nameMatch = query.match(/name='([^']+)'/);

    if (query.includes("name='TabKebab'") && !parentMatch) {
      return jsonResponse({ files: [{ id: ids.TabKebab, name: 'TabKebab' }] });
    }

    if (nameMatch && parentMatch && query.includes("mimeType='application/vnd.google-apps.folder'")) {
      const name = nameMatch[1];
      return jsonResponse({ files: [{ id: ids[name] || `${name}-id`, name }] });
    }

    if (nameMatch && parentMatch) {
      const key = `${parentMatch[1]}:${nameMatch[1]}`;
      const file = pages[key]?.[0];
      return jsonResponse({ files: file ? [file] : [] });
    }

    if (parentMatch) {
      const folderId = parentMatch[1];
      const pageToken = url.searchParams.get('pageToken') || 'first';
      const page = pages[`${folderId}:${pageToken}`] || { files: [] };
      return jsonResponse(page);
    }

    return jsonResponse({ files: [] });
  };
}

describe('Drive inventory and recoverability boundaries', () => {
  test('paginates and annotates profile plus every subfolder without trusting remote scope fields', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    const originalFetch = globalThis.fetch;
    const calls = [];
    const scopes = [
      ['profile-id', 'profile'],
      ['sessions-id', 'sessions'],
      ['stashes-id', 'stashes'],
      ['bookmarks-id', 'bookmarks'],
      ['archive-id', 'archive'],
    ];
    const pages = Object.fromEntries(scopes.flatMap(([id, scope]) => [
      [`${id}:first`, {
        files: [{ id: `${scope}-1`, name: `${scope}-one.json`, scope: 'hostile' }],
        nextPageToken: `${scope} token/+`,
      }],
      [`${id}:${scope} token/+`, {
        files: [{ id: `${scope}-2`, name: `${scope}-two.json` }],
      }],
    ]));

    globalThis.fetch = folderRouter({ pages, calls });
    try {
      const { listAllDriveFiles } = await importDriveClient('inventory');
      const files = await listAllDriveFiles();

      expect(files.map(({ id, scope }) => [id, scope])).toEqual(scopes.flatMap(([, scope]) => [
        [`${scope}-1`, scope],
        [`${scope}-2`, scope],
      ]));
      const listCalls = calls.filter(({ url }) => new URL(url).searchParams.get('q')?.includes("mimeType='application/json'"));
      expect(listCalls).toHaveLength(10);
      expect(listCalls.filter(({ url }) => new URL(url).searchParams.has('pageToken'))).toHaveLength(5);
      for (const { url } of listCalls) {
        const query = new URL(url).searchParams.get('q');
        expect(new URL(url).searchParams.get('fields')).toContain('nextPageToken');
        expect(query).toContain("mimeType='application/json'");
        expect(query).toContain("mimeType='text/html'");
      }
      const rootQuery = calls
        .map(({ url }) => new URL(url).searchParams.get('q') || '')
        .find((query) => query.includes("name='TabKebab'"));
      expect(rootQuery).toContain("'root' in parents");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fails a repeated page token instead of looping or returning an incomplete inventory', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    const originalFetch = globalThis.fetch;
    const calls = [];
    const pages = {
      'profile-id:first': { files: [], nextPageToken: 'repeat' },
      'profile-id:repeat': { files: [], nextPageToken: 'repeat' },
    };
    globalThis.fetch = folderRouter({ pages, calls });
    try {
      const { listAllDriveFiles } = await importDriveClient('repeated-token');
      await expect(listAllDriveFiles()).rejects.toThrow(/page token/i);
      expect(calls.length).toBeLessThan(20);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('aborts the complete inventory when any subfolder page fails', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    const originalFetch = globalThis.fetch;
    const baseFetch = folderRouter();
    let deleteCalls = 0;
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(String(input));
      const query = url.searchParams.get('q') || '';
      if (query.includes("'sessions-id' in parents") && query.includes("mimeType='application/json'")) {
        return jsonResponse({}, 400);
      }
      if ((options.method || 'GET') === 'DELETE') deleteCalls++;
      return baseFetch(input, options);
    };
    try {
      const { listAllDriveFiles } = await importDriveClient('subfolder-failure');
      await expect(listAllDriveFiles()).rejects.toThrow('Drive API error: 400');
      expect(deleteCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects malformed pages, tokens, IDs, and names instead of returning a partial inventory', async () => {
    const malformedPages = [
      {},
      { files: [], nextPageToken: 123 },
      { files: [{ id: 'bad/id', name: 'dated.json' }] },
      { files: [{ id: 'safe-id', name: '' }] },
    ];

    for (const malformedPage of malformedPages) {
      installChromeMock({ local: { driveProfileName: 'Profile' } });
      const originalFetch = globalThis.fetch;
      const baseFetch = folderRouter();
      globalThis.fetch = async (input, options = {}) => {
        const url = new URL(String(input));
        const query = url.searchParams.get('q') || '';
        if (query.includes("'profile-id' in parents") && query.includes("mimeType='application/json'")) {
          return jsonResponse(malformedPage);
        }
        return baseFetch(input, options);
      };
      try {
        const { listAllDriveFiles } = await importDriveClient('malformed-page');
        await expect(listAllDriveFiles()).rejects.toThrow(/invalid/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test('rejects missing or non-string auth tokens before the first Drive request', async () => {
    for (const token of [null, '', '   ', { unexpected: true }]) {
      installChromeMock({ local: { driveProfileName: 'Profile' } });
      chrome.identity.getAuthToken = (_options, callback) => callback(token);
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls++;
        return jsonResponse({ files: [] });
      };
      try {
        const { listAllDriveFiles } = await importDriveClient('invalid-token');
        await expect(listAllDriveFiles()).rejects.toThrow(/auth.*token/i);
        expect(fetchCalls).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test('fails closed when root or profile folder lookup is ambiguous', async () => {
    for (const ambiguousName of ['TabKebab', 'Profile']) {
      installChromeMock({ local: { driveProfileName: 'Profile' } });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        const query = url.searchParams.get('q') || '';
        const name = query.match(/name='([^']+)'/)?.[1];
        if (name === ambiguousName) {
          return jsonResponse({
            files: [
              { id: `${ambiguousName}-one`, name: ambiguousName },
              { id: `${ambiguousName}-two`, name: ambiguousName },
            ],
          });
        }
        if (name) return jsonResponse({ files: [{ id: `${name}-id`, name }] });
        return jsonResponse({ files: [] });
      };
      try {
        const { getSubfolderId } = await importDriveClient('ambiguous-folder');
        await expect(getSubfolderId('sessions')).rejects.toThrow(/multiple|ambiguous/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test('uses a changed Drive profile immediately instead of a stale cached folder', async () => {
    installChromeMock({ local: { driveProfileName: 'Old' } });
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = folderRouter({ calls });
    try {
      const { getSubfolderId } = await importDriveClient('profile-change');
      await getSubfolderId('sessions');
      await chrome.storage.local.set({ driveProfileName: 'New' });
      await getSubfolderId('sessions');

      const folderQueries = calls
        .map(({ url }) => new URL(url).searchParams.get('q') || '')
        .filter((query) => query.includes("mimeType='application/vnd.google-apps.folder'"));
      expect(folderQueries.some((query) => query.includes("name='Old'"))).toBeTrue();
      expect(folderQueries.some((query) => query.includes("name='New'"))).toBeTrue();

      const callsBeforeRemoval = calls.length;
      await chrome.storage.local.remove('driveProfileName');
      await expect(getSubfolderId('sessions')).rejects.toThrow(/profile/i);
      expect(calls).toHaveLength(callsBeforeRemoval);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects a corrupted persisted profile name before any Drive request', async () => {
    for (const driveProfileName of [null, '', '   ', "Profile' or trashed=false", 'x'.repeat(51)]) {
      installChromeMock({ local: { driveProfileName } });
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls++;
        return jsonResponse({ files: [] });
      };
      try {
        const { listAllDriveFiles } = await importDriveClient('invalid-profile');
        await expect(listAllDriveFiles()).rejects.toThrow(/profile/i);
        expect(fetchCalls).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test('does not PATCH canonical JSON when its archive copy fails', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    const originalFetch = globalThis.fetch;
    const calls = [];
    const pages = {
      'profile-id:tabkebab-sync.json': [{ id: 'sync-id', name: 'tabkebab-sync.json' }],
    };
    globalThis.fetch = folderRouter({ pages, failCopy: true, calls });
    try {
      const { writeSyncFile } = await importDriveClient('archive-json');
      await expect(writeSyncFile({ version: 1 })).rejects.toThrow('Drive API error: 400');
      expect(calls.filter(({ method }) => method === 'PATCH')).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not PATCH raw HTML when its archive copy fails', async () => {
    installChromeMock({ local: { driveProfileName: 'Profile' } });
    const originalFetch = globalThis.fetch;
    const calls = [];
    const pages = {
      'bookmarks-id:bookmarks-2026-06-01.html': [{ id: 'html-id', name: 'bookmarks-2026-06-01.html' }],
    };
    globalThis.fetch = folderRouter({ pages, failCopy: true, calls });
    try {
      const { exportRawToSubfolder } = await importDriveClient('archive-html');
      await expect(exportRawToSubfolder('bookmarks', 'bookmarks-2026-06-01.html', '<html></html>', 'text/html'))
        .rejects.toThrow('Drive API error: 400');
      expect(calls.filter(({ method }) => method === 'PATCH')).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('shared Drive cleanup coordinator', () => {
  function cleanupFiles() {
    return [
      driveFile('old-a', 'sessions-2026-01-01.json', 'sessions', '2026-01-01T00:00:00.000Z'),
      driveFile('old-b', 'sessions-2026-01-02.json', 'sessions', '2026-02-01T00:00:00.000Z'),
      driveFile('newest', 'sessions-2026-01-03.json', 'sessions', '2026-03-01T00:00:00.000Z'),
      driveFile('canonical', 'tabkebab-sync.json', 'profile', '2025-01-01T00:00:00.000Z'),
      driveFile('undated', 'notes.json', 'profile', '2025-01-01T00:00:00.000Z'),
    ];
  }

  test('actual scheduled cleanup and cleanDriveFiles handler route through the same coordinator', async () => {
    const worker = await importWorker('actual-entrypoints');
    const exerciseDependencies = () => {
      const deleted = [];
      return {
        deleted,
        dependencies: {
          getSettings: async () => ({
            autoSaveRetentionDays: 7,
            driveRetentionDays: 30,
            neverDeleteFromDrive: false,
          }),
          getStorage: async (key) => {
            if (key === 'sessions') return [];
            if (key === 'driveSync') return { connected: true };
            return null;
          },
          setStorage: async () => {},
          now: () => Date.parse('2026-07-01T00:00:00.000Z'),
          listFiles: async () => cleanupFiles(),
          deleteFile: async (id) => deleted.push(id),
        },
      };
    };

    const scheduled = exerciseDependencies();
    const scheduledResult = await worker.runRetentionCleanup(scheduled.dependencies);
    const manual = exerciseDependencies();
    const manualResult = await worker.handleMessage(
      { action: 'cleanDriveFiles', days: 30 },
      manual.dependencies,
    );

    expect(scheduled.deleted).toEqual(['old-a', 'old-b']);
    expect(manual.deleted).toEqual(scheduled.deleted);
    expect(manualResult).toEqual(scheduledResult);
  });

  test('manual and scheduled modes use the same selection and exact deterministic IDs', async () => {
    const { runDriveFileRetention } = await importWorker('shared-coordinator');
    const execute = async (mode) => {
      const deleted = [];
      const result = await runDriveFileRetention({
        mode,
        days: 30,
        neverDeleteFromDrive: false,
        connected: true,
      }, {
        now: () => Date.parse('2026-07-01T00:00:00.000Z'),
        listFiles: async () => cleanupFiles(),
        deleteFile: async (id) => deleted.push(id),
      });
      return { deleted, result };
    };

    const manual = await execute('manual');
    const scheduled = await execute('scheduled');

    expect(manual.deleted).toEqual(['old-a', 'old-b']);
    expect(scheduled.deleted).toEqual(manual.deleted);
    expect(scheduled.result).toEqual(manual.result);
    expect(manual.result).toEqual({
      deleted: 2,
      keptCanonical: 1,
      keptNewest: 1,
      ignoredUndated: 1,
      errors: [],
    });
  });

  test('continues deterministic deletes and returns only plain serializable partial errors', async () => {
    const { runDriveFileRetention } = await importWorker('partial-delete');
    const attempts = [];
    const result = await runDriveFileRetention({
      mode: 'manual',
      days: 30,
      neverDeleteFromDrive: false,
      connected: true,
    }, {
      now: () => Date.parse('2026-07-01T00:00:00.000Z'),
      listFiles: async () => cleanupFiles(),
      deleteFile: async (id) => {
        attempts.push(id);
        if (id === 'old-a') throw new Error('synthetic delete rejection SECRET_MARKER');
      },
    });

    expect(attempts).toEqual(['old-a', 'old-b']);
    expect(result).toEqual({
      deleted: 1,
      keptCanonical: 1,
      keptNewest: 1,
      ignoredUndated: 1,
      errors: [{ fileId: 'old-a', name: 'sessions-2026-01-01.json', message: 'Drive file deletion failed' }],
    });
    expect(() => structuredClone(result)).not.toThrow();
    expect(result.errors[0]).not.toHaveProperty('stack');
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
  });

  test('performs zero deletes when listing or selection fails', async () => {
    const { runDriveFileRetention } = await importWorker('zero-delete');
    for (const listFiles of [
      async () => { throw new Error('synthetic list rejection'); },
      async () => ({ not: 'an array' }),
    ]) {
      let deleteCalls = 0;
      await expect(runDriveFileRetention({
        mode: 'manual', days: 30, neverDeleteFromDrive: false, connected: true,
      }, {
        now: () => Date.parse('2026-07-01T00:00:00.000Z'),
        listFiles,
        deleteFile: async () => { deleteCalls++; },
      })).rejects.toThrow();
      expect(deleteCalls).toBe(0);
    }

    let conflictingDeleteCalls = 0;
    await expect(runDriveFileRetention({
      mode: 'manual', days: 30, neverDeleteFromDrive: false, connected: true,
    }, {
      now: () => Date.parse('2026-07-01T00:00:00.000Z'),
      listFiles: async () => [
        driveFile('same-id', 'sessions-2026-01-01.json', 'sessions', '2025-01-01T00:00:00.000Z'),
        driveFile('same-id', 'stashes-2026-01-01.json', 'stashes', '2025-01-01T00:00:00.000Z'),
      ],
      deleteFile: async () => { conflictingDeleteCalls++; },
    })).rejects.toThrow(/conflicting/i);
    expect(conflictingDeleteCalls).toBe(0);
  });

  test('guards never-delete, disconnected, and scheduled-disabled retention before listing', async () => {
    const { runDriveFileRetention } = await importWorker('cleanup-guards');
    const cases = [
      { mode: 'manual', days: 30, neverDeleteFromDrive: true, connected: true },
      { mode: 'manual', days: 30, neverDeleteFromDrive: false, connected: false },
      { mode: 'scheduled', days: 0, neverDeleteFromDrive: false, connected: true },
      ...[undefined, null, 0, 1, 'false', {}].map((neverDeleteFromDrive) => ({
        mode: 'manual', days: 30, neverDeleteFromDrive, connected: true,
      })),
      ...[undefined, null, 0, 1, 'true', {}].map((connected) => ({
        mode: 'manual', days: 30, neverDeleteFromDrive: false, connected,
      })),
    ];

    for (const options of cases) {
      let listCalls = 0;
      let deleteCalls = 0;
      const result = await runDriveFileRetention(options, {
        listFiles: async () => { listCalls++; return cleanupFiles(); },
        deleteFile: async () => { deleteCalls++; },
      });
      expect(result).toEqual({
        deleted: 0, keptCanonical: 0, keptNewest: 0, ignoredUndated: 0, errors: [],
      });
      expect(listCalls).toBe(0);
      expect(deleteCalls).toBe(0);
    }
  });

  test('rejects missing, coerced, fractional, and out-of-range days before listing', async () => {
    const { runDriveFileRetention } = await importWorker('cleanup-days');
    const invalidDays = [undefined, null, '30', NaN, Infinity, 0, -1, 1.5, 366];
    for (const days of invalidDays) {
      let listCalls = 0;
      await expect(runDriveFileRetention({
        mode: 'manual', days, neverDeleteFromDrive: false, connected: true,
      }, {
        listFiles: async () => { listCalls++; return []; },
        deleteFile: async () => {},
      })).rejects.toThrow(/days/i);
      expect(listCalls).toBe(0);
    }

    let scheduledListCalls = 0;
    await expect(runDriveFileRetention({
      mode: 'scheduled', days: '30', neverDeleteFromDrive: false, connected: true,
    }, {
      listFiles: async () => { scheduledListCalls++; return []; },
      deleteFile: async () => {},
    })).rejects.toThrow(/days/i);
    expect(scheduledListCalls).toBe(0);

    await expect(runDriveFileRetention({
      mode: 'manual', days: undefined, neverDeleteFromDrive: true, connected: false,
    }, {
      listFiles: async () => { throw new Error('must not list'); },
      deleteFile: async () => {},
    })).rejects.toThrow(/days/i);
    await expect(runDriveFileRetention({
      mode: 'scheduled', days: '0', neverDeleteFromDrive: true, connected: false,
    }, {
      listFiles: async () => { throw new Error('must not list'); },
      deleteFile: async () => {},
    })).rejects.toThrow(/days/i);

    for (const days of [1, 365]) {
      let listCalls = 0;
      await expect(runDriveFileRetention({
        mode: 'manual', days, neverDeleteFromDrive: false, connected: true,
      }, {
        now: () => Date.parse('2026-07-01T00:00:00.000Z'),
        listFiles: async () => { listCalls++; return []; },
        deleteFile: async () => {},
      })).resolves.toEqual({
        deleted: 0, keptCanonical: 0, keptNewest: 0, ignoredUndated: 0, errors: [],
      });
      expect(listCalls).toBe(1);
    }

    let invalidNowListCalls = 0;
    await expect(runDriveFileRetention({
      mode: 'manual', days: 30, neverDeleteFromDrive: false, connected: true,
    }, {
      now: () => NaN,
      listFiles: async () => { invalidNowListCalls++; return []; },
      deleteFile: async () => {},
    })).rejects.toThrow(/current time/i);
    expect(invalidNowListCalls).toBe(0);
  });

  test('scrubs a non-Error delete rejection to the exact plain error contract', async () => {
    const { runDriveFileRetention } = await importWorker('plain-delete-error');
    const result = await runDriveFileRetention({
      mode: 'manual', days: 30, neverDeleteFromDrive: false, connected: true,
    }, {
      now: () => Date.parse('2026-07-01T00:00:00.000Z'),
      listFiles: async () => cleanupFiles(),
      deleteFile: async (id) => {
        if (id === 'old-a') throw { token: 'must-not-cross', responseBody: 'private' };
      },
    });

    expect(result.errors).toEqual([{
      fileId: 'old-a',
      name: 'sessions-2026-01-01.json',
      message: 'Drive file deletion failed',
    }]);
    expect(JSON.stringify(result)).not.toContain('must-not-cross');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  test('actual cleanDriveFiles runtime failure returns and logs only a generic error', async () => {
    installChromeMock({
      local: {
        driveProfileName: 'Profile',
        driveSync: { connected: true },
        tabkebabSettings: { neverDeleteFromDrive: false, driveRetentionDays: 30 },
      },
    });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings = [];
    globalThis.fetch = async () => { throw new Error('SECRET_TOP_LEVEL_MARKER response-body'); };
    console.warn = (...args) => warnings.push(args);
    try {
      await importWorker('generic-runtime-error');
      const response = await chrome.runtime.sendMessage({ action: 'cleanDriveFiles', days: 30 });

      expect(response).toEqual({ error: 'Drive cleanup failed' });
      expect(warningText(warnings)).not.toContain('SECRET_TOP_LEVEL_MARKER');
      expect(warningText(warnings)).not.toContain('response-body');
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
  });

  test('actual scheduled cleanup logs no listing error details', async () => {
    const { runRetentionCleanup } = await importWorker('generic-scheduled-error');
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args);
    try {
      const result = await runRetentionCleanup({
        getSettings: async () => ({
          autoSaveRetentionDays: 7,
          driveRetentionDays: 30,
          neverDeleteFromDrive: false,
        }),
        getStorage: async (key) => key === 'driveSync' ? { connected: true } : [],
        setStorage: async () => {},
        listFiles: async () => { throw new Error('SECRET_SCHEDULED_MARKER response-body'); },
        deleteFile: async () => {},
      });

      expect(result).toEqual({
        deleted: 0, keptCanonical: 0, keptNewest: 0, ignoredUndated: 0, errors: [],
      });
      expect(warningText(warnings)).not.toContain('SECRET_SCHEDULED_MARKER');
      expect(warningText(warnings)).not.toContain('response-body');
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('checked cleanup UI boundary', () => {
  async function createSettingsManager(daysValue, { confirm = async () => true } = {}) {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: () => null };
    let SettingsManager;
    try {
      ({ SettingsManager } = await import(`../../sidepanel/components/settings-manager.js?ui=${++importNonce}`));
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    }

    const daysInput = { value: daysValue };
    const button = {
      disabled: false,
      textContent: 'Clean Drive Files',
      addEventListener() {},
    };
    const root = {
      querySelectorAll: () => [],
      querySelector(selector) {
        if (selector === '#drive-cleanup-days') return daysInput;
        if (selector === '#btn-clean-drive') return button;
        return null;
      },
    };
    const notifications = [];
    let confirmCalls = 0;
    const manager = new SettingsManager(root, {
      confirm: async (options) => {
        confirmCalls++;
        return confirm(options);
      },
      notify: (message, type) => notifications.push({ message, type }),
    });
    return { manager, notifications, button, getConfirmCalls: () => confirmCalls };
  }

  test('formats complete and partial results without claiming partial success', async () => {
    const { formatDriveCleanupResult } = await import('../../sidepanel/drive-cleanup-result.js');

    expect(formatDriveCleanupResult({
      deleted: 2, keptCanonical: 2, keptNewest: 3, ignoredUndated: 4, errors: [],
    })).toEqual({
      type: 'success',
      message: 'Deleted 2 Drive files. Protected 2 canonical, 3 newest, and 4 undated files.',
    });

    const partial = formatDriveCleanupResult({
      deleted: 1,
      keptCanonical: 2,
      keptNewest: 3,
      ignoredUndated: 4,
      errors: [{ fileId: 'failed', name: 'file.json', message: 'denied' }],
    });
    expect(partial.type).toBe('error');
    expect(partial.message).toContain('Cleanup incomplete');
    expect(partial.message).toContain('Deleted 1');
    expect(partial.message).toContain('1 file failed');
    expect(partial.message).toContain('Protected 2 canonical, 3 newest, and 4 undated');
    expect(partial.message).not.toContain('success');
  });

  test('settings manager message boundary rejects returned and transport errors', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: () => null };
    try {
      const { SettingsManager } = await import(`../../sidepanel/components/settings-manager.js?checked=${++importNonce}`);
      const manager = Object.create(SettingsManager.prototype);

      installChromeMock({ runtimeHandler: async () => ({ error: 'worker cleanup failed' }) });
      await expect(manager.send({ action: 'cleanDriveFiles', days: 30 })).rejects.toThrow('worker cleanup failed');

      const transportError = new Error('runtime transport failed');
      installChromeMock({ failures: { 'runtime.sendMessage': transportError } });
      await expect(manager.send({ action: 'cleanDriveFiles', days: 30 })).rejects.toBe(transportError);
    } finally {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    }
  });

  test('actual settings cleanup wiring reports complete and partial worker results accurately', async () => {
    const complete = await createSettingsManager('30');
    installChromeMock({ runtimeHandler: async () => ({
      deleted: 2, keptCanonical: 2, keptNewest: 3, ignoredUndated: 4, errors: [],
    }) });
    await complete.manager.cleanDriveFiles();
    expect(complete.notifications).toEqual([{
      type: 'success',
      message: 'Deleted 2 Drive files. Protected 2 canonical, 3 newest, and 4 undated files.',
    }]);
    expect(complete.button).toMatchObject({ disabled: false, textContent: 'Clean Drive Files' });

    const partial = await createSettingsManager('30');
    installChromeMock({ runtimeHandler: async () => ({
      deleted: 1,
      keptCanonical: 2,
      keptNewest: 3,
      ignoredUndated: 4,
      errors: [{ fileId: 'failed', name: 'old.json', message: 'denied' }],
    }) });
    await partial.manager.cleanDriveFiles();
    expect(partial.notifications).toHaveLength(1);
    expect(partial.notifications[0].type).toBe('error');
    expect(partial.notifications[0].message).toContain('Cleanup incomplete');
    expect(partial.notifications[0].message).not.toContain('success');
  });

  test('actual settings cleanup wiring turns returned, transport, and malformed responses into failure only', async () => {
    for (const configure of [
      () => installChromeMock({ runtimeHandler: async () => ({ error: 'worker cleanup failed' }) }),
      () => installChromeMock({ failures: { 'runtime.sendMessage': new Error('runtime transport failed') } }),
      () => installChromeMock({ runtimeHandler: async () => ({ deleted: 3, errors: [] }) }),
    ]) {
      const ui = await createSettingsManager('30');
      configure();
      await ui.manager.cleanDriveFiles();
      expect(ui.notifications).toHaveLength(1);
      expect(ui.notifications[0].type).toBe('error');
      expect(ui.notifications[0].message).toStartWith('Cleanup failed:');
      expect(ui.notifications[0].message).not.toContain('Protected');
    }
  });

  test('actual settings cleanup rejects invalid raw days before confirm or messaging', async () => {
    for (const rawDays of ['', '0', '-1', '1.5', '30days', '366']) {
      const ui = await createSettingsManager(rawDays);
      const harness = installChromeMock({ runtimeHandler: async () => {
        throw new Error('must not send');
      } });
      await ui.manager.cleanDriveFiles();
      expect(ui.getConfirmCalls()).toBe(0);
      expect(harness.calls.runtime.sendMessage).toEqual([]);
      expect(ui.notifications).toEqual([{
        message: 'Cleanup days must be a whole number from 1 to 365',
        type: 'error',
      }]);
    }
  });

  test('sendOrThrow preserves a complete cleanup result', async () => {
    const response = { deleted: 1, keptCanonical: 2, keptNewest: 3, ignoredUndated: 4, errors: [] };
    installChromeMock({ runtimeHandler: async () => response });
    await expect(sendOrThrow({ action: 'cleanDriveFiles', days: 30 })).resolves.toEqual(response);
  });
});
