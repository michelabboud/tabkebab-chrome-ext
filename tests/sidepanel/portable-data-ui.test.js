import { describe, expect, test } from 'bun:test';

async function source(relativePath) {
  return Bun.file(new URL(`../../${relativePath}`, import.meta.url)).text();
}

describe('portable data UI ownership', () => {
  test('formats deterministic worker import counts without claiming success for malformed summaries', async () => {
    const {
      formatPortableImportSummary,
      portableImportToastType,
    } = await import('../../sidepanel/portable-import-summary.js');
    expect(formatPortableImportSummary({
      imported: { sessions: 2, stashes: 1, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
      skipped: { sessions: 1, stashes: 0, manualGroups: 1, bookmarks: 0, focusHistory: 0 },
    }, 'Data import')).toBe('Data import complete — 3 new records, 2 duplicates skipped');
    expect(() => formatPortableImportSummary({ imported: {}, skipped: null }, 'Import'))
      .toThrow('Invalid import summary');

    const warningResult = {
      imported: { sessions: 0, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
      skipped: { sessions: 0, stashes: 0, manualGroups: 0, bookmarks: 0, focusHistory: 0 },
      committed: true,
      warning: 'Data was imported, but automation schedules could not be refreshed.',
    };
    expect(formatPortableImportSummary(warningResult, 'Settings import'))
      .toContain('Settings import complete — 0 new records, 0 duplicates skipped. Warning:');
    expect(portableImportToastType(warningResult)).toBe('error');
    expect(portableImportToastType({})).toBe('success');
    expect(() => formatPortableImportSummary({ ...warningResult, committed: false }, 'Import'))
      .toThrow('Invalid import warning');
  });

  test('all JSON file paths use the shared bounded helpers and worker actions', async () => {
    const files = {
      sessions: await source('sidepanel/components/session-manager.js'),
      stashes: await source('sidepanel/components/stash-list.js'),
      settings: await source('sidepanel/components/settings-manager.js'),
    };

    for (const text of Object.values(files)) {
      expect(text).toContain('readPortableImportFile');
      expect(text).toContain('downloadJson');
      expect(text).toContain("action: 'importPortableData'");
      expect(text).not.toContain('file.text(');
      expect(text).not.toContain('JSON.parse(');
      expect(text).not.toContain('new Blob(');
      expect(text).not.toContain('URL.createObjectURL(');
      expect(text).not.toMatch(/version:\s*1\b/);
    }

    expect(files.sessions).toContain("action: 'buildPortableExport', kind: 'full'");
    expect(files.sessions).toContain("action: 'buildPortableSessionExport'");
    expect(files.sessions).toContain("readPortableImportFile(file, ['full', 'sessions'])");
    expect(files.stashes).toContain("action: 'buildPortableExport', kind: 'stashes'");
    expect(files.stashes).toContain("action: 'buildPortableStashExport'");
    expect(files.stashes).toContain("readPortableImportFile(file, ['stashes'])");
    expect(files.settings).toContain("action: 'buildPortableExport', kind: 'settings'");
    expect(files.settings).toContain("readPortableImportFile(file, ['settings'])");
  });

  test('every file input resets in finally and success copy derives from the worker summary', async () => {
    for (const relativePath of [
      'sidepanel/components/session-manager.js',
      'sidepanel/components/stash-list.js',
      'sidepanel/components/settings-manager.js',
    ]) {
      const text = await source(relativePath);
      expect(text).toMatch(/finally\s*{[^}]*target\.value\s*=\s*''/s);
      expect(text).toContain('formatPortableImportSummary');
      expect(text).toContain('portableImportToastType');
    }
  });

  test('Focus preference writes cross the checked worker boundary', async () => {
    const text = await source('sidepanel/components/focus-panel.js');
    expect(text).toContain("action: 'saveFocusProfilePrefs'");
    expect(text).not.toContain('chrome.storage.local.set');
  });
});
