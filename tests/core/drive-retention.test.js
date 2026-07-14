import { describe, expect, test } from 'bun:test';

async function retentionModule() {
  return import('../../core/drive-retention.js');
}

function file(id, name, scope, modifiedTime = '2026-06-01T12:00:00.000Z') {
  return { id, name, scope, modifiedTime, size: '42' };
}

describe('classifyDatedDriveFile', () => {
  test('accepts every bounded normal and archive family in its exact scope', async () => {
    const { classifyDatedDriveFile } = await retentionModule();
    const fixtures = [
      [file('sessions', 'sessions-2026-06-01.json', 'sessions'), 'sessions'],
      [file('stashes', 'stashes-2026-06-01.json', 'stashes'), 'stashes'],
      [file('named-stash', 'stash-Research-work-1780272000000.json', 'stashes'), 'stashes'],
      [file('bookmarks-json', 'bookmarks-2026-06-01.json', 'bookmarks'), 'bookmarks-json'],
      [file('bookmarks-ms', 'bookmarks-2026-06-01-1780272000000.json', 'bookmarks'), 'bookmarks-json'],
      [file('bookmarks-html', 'bookmarks-2026-06-01.html', 'bookmarks'), 'bookmarks-html'],
      [file('portable', 'tabkebab-export-1780272000000.json', 'profile'), 'portable-export'],
      [file('archive-sync', 'tabkebab-sync-2026-06-01T12-34-56.json', 'archive'), 'archive-sync'],
      [file('archive-settings', 'tabkebab-settings-2026-06-01T12-34-56.json', 'archive'), 'archive-settings'],
      [file('archive-sessions', 'sessions-2026-05-31-2026-06-01T12-34-56.json', 'archive'), 'archive-sessions'],
      [file('archive-stashes', 'stashes-2026-05-31-2026-06-01T12-34-56.json', 'archive'), 'archive-stashes'],
      [file('archive-named-stash', 'stash-Research-work-1780272000000-2026-06-01T12-34-56.json', 'archive'), 'archive-stashes'],
      [file('archive-bookmarks-json', 'bookmarks-2026-05-31-2026-06-01T12-34-56.json', 'archive'), 'archive-bookmarks-json'],
      [file('archive-bookmarks-ms', 'bookmarks-2026-05-31-1780272000000-2026-06-01T12-34-56.json', 'archive'), 'archive-bookmarks-json'],
      [file('archive-bookmarks-html', 'bookmarks-2026-05-31-2026-06-01T12-34-56.html', 'archive'), 'archive-bookmarks-html'],
    ];

    for (const [fixture, category] of fixtures) {
      const result = classifyDatedDriveFile(fixture);
      expect(result?.category, fixture.name).toBe(category);
      expect(Number.isFinite(result?.timestamp), fixture.name).toBeTrue();
    }
  });

  test('returns the exact embedded timestamp and validates leap dates and archive originals', async () => {
    const { classifyDatedDriveFile } = await retentionModule();

    expect(classifyDatedDriveFile(file('date', 'sessions-2024-02-29.json', 'sessions'))).toEqual({
      category: 'sessions',
      timestamp: Date.parse('2024-02-29T00:00:00.000Z'),
    });
    expect(classifyDatedDriveFile(file('milliseconds', 'bookmarks-2026-06-01-1780272000000.json', 'bookmarks'))).toEqual({
      category: 'bookmarks-json',
      timestamp: 1780272000000,
    });
    expect(classifyDatedDriveFile(file('archive', 'tabkebab-sync-2026-06-01T12-34-56.json', 'archive'))).toEqual({
      category: 'archive-sync',
      timestamp: Date.parse('2026-06-01T12:34:56.000Z'),
    });
    expect(classifyDatedDriveFile(file('non-leap', 'sessions-2023-02-29.json', 'sessions'))).toBeNull();
    expect(classifyDatedDriveFile(file(
      'bad-original',
      'sessions-2026-02-30-2026-06-01T12-34-56.json',
      'archive',
    ))).toBeNull();
    expect(classifyDatedDriveFile(file(
      'bad-original-ms',
      'stash-name-780272000000-2026-06-01T12-34-56.json',
      'archive',
    ))).toBeNull();
    expect(classifyDatedDriveFile({
      id: 'independent',
      name: 'sessions-2026-06-01.json',
      scope: 'sessions',
      modifiedTime: 'not-a-date',
    })).toEqual({
      category: 'sessions',
      timestamp: Date.parse('2026-06-01T00:00:00.000Z'),
    });
  });

  test('rejects every valid family when listed in a different scope', async () => {
    const { classifyDatedDriveFile } = await retentionModule();
    const wrongScopes = [
      file('session', 'sessions-2026-06-01.json', 'stashes'),
      file('stash', 'stashes-2026-06-01.json', 'sessions'),
      file('named-stash', 'stash-name-1780272000000.json', 'profile'),
      file('bookmark-json', 'bookmarks-2026-06-01.json', 'sessions'),
      file('bookmark-ms', 'bookmarks-2026-06-01-1780272000000.json', 'profile'),
      file('bookmark-html', 'bookmarks-2026-06-01.html', 'stashes'),
      file('portable', 'tabkebab-export-1780272000000.json', 'bookmarks'),
      file('archive', 'tabkebab-sync-2026-06-01T12-34-56.json', 'profile'),
    ];
    for (const fixture of wrongScopes) expect(classifyDatedDriveFile(fixture)).toBeNull();
  });

  test('rejects canonical, unrelated, malformed, wrong-scope, and non-record inputs', async () => {
    const { classifyDatedDriveFile } = await retentionModule();
    const rejected = [
      file('sync', 'tabkebab-sync.json', 'profile'),
      file('settings', 'tabkebab-settings.json', 'profile'),
      file('user-json', 'notes.json', 'profile'),
      file('user-html', 'bookmarks.html', 'bookmarks'),
      file('bad-day', 'sessions-2026-02-30.json', 'sessions'),
      file('bad-month', 'stashes-2026-13-01.json', 'stashes'),
      file('bad-ms-short', 'stash-name-780272000000.json', 'stashes'),
      file('bad-ms-long', 'tabkebab-export-17802720000000.json', 'profile'),
      file('stash-unicode', 'stash-naïve-1780272000000.json', 'stashes'),
      file('stash-slash', 'stash-name/path-1780272000000.json', 'stashes'),
      file('stash-dot', 'stash-name.part-1780272000000.json', 'stashes'),
      file('stash-underscore', 'stash-name_part-1780272000000.json', 'stashes'),
      file('stash-space', 'stash-name part-1780272000000.json', 'stashes'),
      file('stash-suffix', 'stash-name-1780272000000-extra.json', 'stashes'),
      file('bad-ms-extra', 'bookmarks-2026-06-01-1780272000000-extra.json', 'bookmarks'),
      file('bad-time-hour', 'tabkebab-sync-2026-06-01T24-00-00.json', 'archive'),
      file('bad-time-minute', 'tabkebab-settings-2026-06-01T23-60-00.json', 'archive'),
      file('bad-time-second', 'sessions-2026-05-31-2026-06-01T23-59-60.json', 'archive'),
      file('bad-archive-day', 'bookmarks-2026-05-31-2026-02-30T12-00-00.html', 'archive'),
      file('unknown-archive', 'notes-2026-06-01T12-00-00.json', 'archive'),
      file('portable-archive', 'tabkebab-export-1780272000000-2026-06-01T12-00-00.json', 'archive'),
      file('case', 'Sessions-2026-06-01.json', 'sessions'),
      file('extension-case', 'sessions-2026-06-01.JSON', 'sessions'),
      file('extra-extension', 'sessions-2026-06-01.json.bak', 'sessions'),
      file('wrong-scope', 'sessions-2026-06-01.json', 'profile'),
      file('archive-wrong-scope', 'tabkebab-sync-2026-06-01T12-00-00.json', 'profile'),
      null,
      [],
      'sessions-2026-06-01.json',
    ];

    for (const fixture of rejected) {
      expect(classifyDatedDriveFile(fixture), JSON.stringify(fixture)).toBeNull();
    }
  });
});

describe('selectDriveRetentionDeletions', () => {
  test('protects canonical names in every scope before parsing', async () => {
    const { selectDriveRetentionDeletions } = await retentionModule();
    const files = [
      file('sync-profile', 'tabkebab-sync.json', 'profile', '2024-01-01T00:00:00.000Z'),
      file('settings-wrong-scope', 'tabkebab-settings.json', 'sessions', '2024-01-01T00:00:00.000Z'),
    ];

    const result = selectDriveRetentionDeletions(files, Date.parse('2026-07-01T00:00:00.000Z'));

    expect(result.deleteFiles).toEqual([]);
    expect(result.keptCanonical).toEqual(files);
    expect(result.keptNewest).toEqual([]);
    expect(result.ignoredUndated).toEqual([]);
  });

  test('deletes only old non-newest files and preserves cutoff equality, young files, and all newest ties', async () => {
    const { selectDriveRetentionDeletions } = await retentionModule();
    const cutoff = Date.parse('2026-07-01T00:00:00.000Z');
    const files = [
      file('sessions-old-a', 'sessions-2026-01-01.json', 'sessions', '2026-01-10T00:00:00.000Z'),
      file('sessions-old-b', 'sessions-2026-01-02.json', 'sessions', '2026-02-10T00:00:00.000Z'),
      file('sessions-newest-a', 'sessions-2026-01-03.json', 'sessions', '2026-03-10T00:00:00.000Z'),
      file('sessions-newest-b', 'sessions-2026-01-04.json', 'sessions', '2026-03-10T00:00:00.000Z'),
      file('stashes-equality', 'stashes-2026-01-01.json', 'stashes', '2026-07-01T00:00:00.000Z'),
      file('stashes-young', 'stashes-2026-01-02.json', 'stashes', '2026-07-02T00:00:00.000Z'),
      file('stashes-newest', 'stash-dynamic-name-1780272000000.json', 'stashes', '2026-07-03T00:00:00.000Z'),
    ];

    const result = selectDriveRetentionDeletions(files, cutoff);

    expect(result.deleteFiles.map(({ id }) => id)).toEqual(['sessions-old-a', 'sessions-old-b']);
    expect(result.keptNewest.map(({ id }) => id)).toEqual([
      'sessions-newest-a',
      'sessions-newest-b',
      'stashes-newest',
    ]);
    expect(result.ignoredUndated).toEqual([]);
  });

  test('treats offset-equivalent modified times as newest ties', async () => {
    const { selectDriveRetentionDeletions } = await retentionModule();
    const files = [
      file('old', 'sessions-2026-01-01.json', 'sessions', '2025-01-01T00:00:00.000Z'),
      file('utc-newest', 'sessions-2026-01-02.json', 'sessions', '2026-03-01T10:00:00.000Z'),
      file('offset-newest', 'sessions-2026-01-03.json', 'sessions', '2026-03-01T12:00:00.000+02:00'),
    ];

    const result = selectDriveRetentionDeletions(files, Date.parse('2026-07-01T00:00:00.000Z'));

    expect(result.deleteFiles).toEqual([files[0]]);
    expect(result.keptNewest).toEqual([files[1], files[2]]);
  });

  test('preserves input order for deletions even when timestamps are reverse chronological', async () => {
    const { selectDriveRetentionDeletions } = await retentionModule();
    const files = [
      file('middle', 'sessions-2026-01-02.json', 'sessions', '2025-02-01T00:00:00.000Z'),
      file('oldest', 'sessions-2026-01-01.json', 'sessions', '2025-01-01T00:00:00.000Z'),
      file('newest', 'sessions-2026-01-03.json', 'sessions', '2025-03-01T00:00:00.000Z'),
    ];

    const result = selectDriveRetentionDeletions(files, Date.parse('2026-07-01T00:00:00.000Z'));

    expect(result.deleteFiles).toEqual([files[0], files[1]]);
  });

  test('bounds dynamic stash names into one category and keeps only the shared newest', async () => {
    const { selectDriveRetentionDeletions } = await retentionModule();
    const files = [
      file('alpha', 'stash-alpha-1780272000000.json', 'stashes', '2026-01-01T00:00:00.000Z'),
      file('beta', 'stash-beta-1780358400000.json', 'stashes', '2026-02-01T00:00:00.000Z'),
    ];

    const result = selectDriveRetentionDeletions(files, Date.parse('2026-07-01T00:00:00.000Z'));

    expect(result.deleteFiles).toEqual([files[0]]);
    expect(result.keptNewest).toEqual([files[1]]);
  });

  test('computes newest ties independently for every bounded category', async () => {
    const { selectDriveRetentionDeletions } = await retentionModule();
    const namesByCategory = [
      ['sessions', 'sessions', [
        'sessions-2026-01-01.json', 'sessions-2026-01-02.json', 'sessions-2026-01-03.json',
      ]],
      ['stashes', 'stashes', [
        'stashes-2026-01-01.json', 'stash-alpha-1780272000000.json', 'stash-beta-1780358400000.json',
      ]],
      ['bookmarks-json', 'bookmarks', [
        'bookmarks-2026-01-01.json', 'bookmarks-2026-01-02.json', 'bookmarks-2026-01-03-1780272000000.json',
      ]],
      ['bookmarks-html', 'bookmarks', [
        'bookmarks-2026-01-01.html', 'bookmarks-2026-01-02.html', 'bookmarks-2026-01-03.html',
      ]],
      ['portable-export', 'profile', [
        'tabkebab-export-1780272000000.json', 'tabkebab-export-1780358400000.json', 'tabkebab-export-1780444800000.json',
      ]],
      ['archive-sync', 'archive', [
        'tabkebab-sync-2026-01-01T00-00-00.json', 'tabkebab-sync-2026-01-02T00-00-00.json', 'tabkebab-sync-2026-01-03T00-00-00.json',
      ]],
      ['archive-settings', 'archive', [
        'tabkebab-settings-2026-01-01T00-00-00.json', 'tabkebab-settings-2026-01-02T00-00-00.json', 'tabkebab-settings-2026-01-03T00-00-00.json',
      ]],
      ['archive-sessions', 'archive', [
        'sessions-2025-12-01-2026-01-01T00-00-00.json', 'sessions-2025-12-02-2026-01-02T00-00-00.json', 'sessions-2025-12-03-2026-01-03T00-00-00.json',
      ]],
      ['archive-stashes', 'archive', [
        'stashes-2025-12-01-2026-01-01T00-00-00.json', 'stash-alpha-1780272000000-2026-01-02T00-00-00.json', 'stash-beta-1780358400000-2026-01-03T00-00-00.json',
      ]],
      ['archive-bookmarks-json', 'archive', [
        'bookmarks-2025-12-01-2026-01-01T00-00-00.json', 'bookmarks-2025-12-02-2026-01-02T00-00-00.json', 'bookmarks-2025-12-03-1780272000000-2026-01-03T00-00-00.json',
      ]],
      ['archive-bookmarks-html', 'archive', [
        'bookmarks-2025-12-01-2026-01-01T00-00-00.html', 'bookmarks-2025-12-02-2026-01-02T00-00-00.html', 'bookmarks-2025-12-03-2026-01-03T00-00-00.html',
      ]],
    ];
    const files = namesByCategory.flatMap(([category, scope, names]) => [
      file(`${category}-old`, names[0], scope, '2025-01-01T00:00:00.000Z'),
      file(`${category}-tie-a`, names[1], scope, '2025-02-01T00:00:00.000Z'),
      file(`${category}-tie-b`, names[2], scope, '2025-02-01T00:00:00.000Z'),
    ]);

    const result = selectDriveRetentionDeletions(files, Date.parse('2026-07-01T00:00:00.000Z'));

    expect(result.deleteFiles.map(({ id }) => id)).toEqual(
      namesByCategory.map(([category]) => `${category}-old`),
    );
    expect(result.keptNewest.map(({ id }) => id)).toEqual(
      namesByCategory.flatMap(([category]) => [`${category}-tie-a`, `${category}-tie-b`]),
    );
  });

  test('treats invalid metadata, malformed names, and wrong scopes as ignored undated', async () => {
    const { selectDriveRetentionDeletions } = await retentionModule();
    const files = [
      file('missing-time', 'sessions-2026-01-01.json', 'sessions', undefined),
      file('invalid-time', 'stashes-2026-01-01.json', 'stashes', 'not-a-time'),
      file('null-time', 'stashes-2026-01-02.json', 'stashes', null),
      file('numeric-time', 'stashes-2026-01-03.json', 'stashes', 0),
      file('normalized-invalid-time', 'stashes-2026-01-04.json', 'stashes', '2026-02-30T00:00:00.000Z'),
      file('missing-id', 'bookmarks-2026-01-01.json', 'bookmarks', '2026-01-01T00:00:00.000Z'),
      file('malformed', 'sessions-2026-02-30.json', 'sessions', '2026-01-01T00:00:00.000Z'),
      file('wrong-scope', 'sessions-2026-01-01.json', 'profile', '2026-01-01T00:00:00.000Z'),
      file('unrelated', 'my-notes.json', 'profile', '2026-01-01T00:00:00.000Z'),
    ];
    delete files[0].modifiedTime;
    delete files.find(({ id }) => id === 'missing-id').id;

    const result = selectDriveRetentionDeletions(files, Date.parse('2026-07-01T00:00:00.000Z'));

    expect(result.deleteFiles).toEqual([]);
    expect(result.keptNewest).toEqual([]);
    expect(result.ignoredUndated).toEqual(files);
  });

  test('is stable, immutable, returns original objects, and never duplicates an identical file ID', async () => {
    const { selectDriveRetentionDeletions } = await retentionModule();
    const files = [
      file('duplicate', 'sessions-2026-01-01.json', 'sessions', '2026-01-01T00:00:00.000Z'),
      file('duplicate', 'sessions-2026-01-01.json', 'sessions', '2026-01-01T00:00:00.000Z'),
      file('newest', 'sessions-2026-01-02.json', 'sessions', '2026-03-01T00:00:00.000Z'),
    ];
    const snapshot = structuredClone(files);

    const result = selectDriveRetentionDeletions(files, Date.parse('2026-07-01T00:00:00.000Z'));

    expect(result.deleteFiles).toEqual([files[0]]);
    expect(result.deleteFiles[0]).toBe(files[0]);
    expect(files).toEqual(snapshot);
  });

  test('fails closed when one Drive ID has conflicting metadata', async () => {
    const { selectDriveRetentionDeletions } = await retentionModule();
    const files = [
      file('conflict', 'sessions-2026-01-01.json', 'sessions', '2026-01-01T00:00:00.000Z'),
      file('conflict', 'stashes-2026-01-01.json', 'stashes', '2026-01-01T00:00:00.000Z'),
    ];

    expect(() => selectDriveRetentionDeletions(files, Date.parse('2026-07-01T00:00:00.000Z')))
      .toThrow(/conflicting.*id/i);
  });

  test('deduplicates identical IDs in every protection output bucket', async () => {
    const { selectDriveRetentionDeletions } = await retentionModule();
    const canonical = file('canonical', 'tabkebab-sync.json', 'profile', '2025-01-01T00:00:00.000Z');
    const newest = file('newest', 'sessions-2026-01-02.json', 'sessions', '2026-03-01T00:00:00.000Z');
    const ignored = file('ignored', 'notes.json', 'profile', '2025-01-01T00:00:00.000Z');
    const files = [canonical, { ...canonical }, newest, { ...newest }, ignored, { ...ignored }];

    const result = selectDriveRetentionDeletions(files, Date.parse('2026-07-01T00:00:00.000Z'));

    expect(result.keptCanonical).toEqual([canonical]);
    expect(result.keptNewest).toEqual([newest]);
    expect(result.ignoredUndated).toEqual([ignored]);
  });

  test('rejects invalid top-level inputs and every non-finite cutoff', async () => {
    const { selectDriveRetentionDeletions } = await retentionModule();

    for (const files of [null, undefined, {}, 'files']) {
      expect(() => selectDriveRetentionDeletions(files, 0)).toThrow();
    }
    for (const cutoff of [NaN, Infinity, -Infinity, '0', null, undefined]) {
      expect(() => selectDriveRetentionDeletions([], cutoff)).toThrow();
    }
  });
});
