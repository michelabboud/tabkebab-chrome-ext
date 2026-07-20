import { describe, expect, test } from 'bun:test';

import { deleteSessions, saveSession } from '../../core/sessions.js';
import { sanitizeCapturedGroupTitle, sanitizeCapturedTab } from '../../core/tab-restore.js';
import { MAX_DRIVE_STRING_LENGTH, readLocalDriveSyncDocument } from '../../core/drive-sync.js';
import { buildPortableExportPayload } from '../../core/export-import.js';
import { installChromeMock, readStorageArea } from '../helpers/chrome-mock.js';

const OVERSIZED = 'x'.repeat(MAX_DRIVE_STRING_LENGTH + 4_000);
const OVERSIZED_DATA_FAVICON = `data:image/png;base64,${'A'.repeat(MAX_DRIVE_STRING_LENGTH + 4_000)}`;

function liveTab(id, overrides = {}) {
  return {
    id,
    windowId: 1,
    index: id,
    active: false,
    url: `https://capture.test/${id}`,
    title: `Tab ${id}`,
    pinned: false,
    ...overrides,
  };
}

function storedSessions() {
  return readStorageArea('local').sessions;
}

describe('capture-time sanitization (F10 regression)', () => {
  test('a page-controlled oversized title cannot poison delete, sync, or export', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [liveTab(1, { title: OVERSIZED }), liveTab(2)],
    });

    const session = await saveSession('poison title capture');
    const [stored] = storedSessions();
    const capturedTitles = stored.windows[0].tabs.map((tab) => tab.title.length);
    expect(capturedTitles.every((length) => length <= 500)).toBe(true);

    // The reproduced F10 failure chain must now succeed end to end.
    await expect(readLocalDriveSyncDocument()).resolves.toMatchObject({ version: 2 });
    await expect(buildPortableExportPayload('sessions')).resolves.toMatchObject({
      kind: 'sessions',
    });
    await expect(deleteSessions([session.id])).resolves.toMatchObject({
      deletedIds: [session.id],
    });
    expect(storedSessions()).toEqual([]);
  });

  test('an oversized data: favicon is dropped at capture while the tab survives', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [liveTab(1, { favIconUrl: OVERSIZED_DATA_FAVICON }), liveTab(2)],
    });

    await saveSession('poison favicon capture');
    const [stored] = storedSessions();
    expect(stored.windows[0].tabs).toHaveLength(2);
    expect(stored.windows[0].tabs[0].favIconUrl).toBe('');
    await expect(readLocalDriveSyncDocument()).resolves.toMatchObject({ version: 2 });
  });

  test('a javascript: favicon is dropped at capture', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [liveTab(1, { favIconUrl: 'javascript:alert(1)' }), liveTab(2)],
    });

    await saveSession('unsafe favicon scheme');
    const [stored] = storedSessions();
    expect(stored.windows[0].tabs[0].favIconUrl).toBe('');
  });

  test('a tab with an unrepresentable URL is skipped at capture; siblings survive', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [liveTab(1, { url: `https://capture.test/?q=${OVERSIZED}` }), liveTab(2)],
    });

    await saveSession('oversized URL capture');
    const [stored] = storedSessions();
    expect(stored.windows[0].tabs).toHaveLength(1);
    expect(stored.windows[0].tabs[0].url).toBe('https://capture.test/2');
    await expect(readLocalDriveSyncDocument()).resolves.toMatchObject({ version: 2 });
  });

  test('an oversized session name is bounded at capture', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [liveTab(1), liveTab(2)],
    });

    const session = await saveSession(OVERSIZED);
    expect(session.name).toHaveLength(500);
  });

  test('a session with no representable tabs returns the stash-style error and writes nothing', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [liveTab(1, { url: `https://capture.test/?q=${OVERSIZED}` })],
    });

    await expect(saveSession('nothing representable')).resolves.toEqual({
      error: 'No stashable tabs in session',
    });
    expect(storedSessions()).toBeUndefined();
  });
});

describe('pre-existing poisoned sessions heal on canonicalization', () => {
  function poisonedStoredSession(id, tabOverrides = {}) {
    return {
      id,
      name: 'poisoned',
      version: 2,
      createdAt: 1,
      modifiedAt: 1,
      windows: [{
        tabCount: 1,
        tabs: [{
          url: 'https://poison.test/',
          title: OVERSIZED,
          favIconUrl: OVERSIZED_DATA_FAVICON,
          pinned: false,
          ...tabOverrides,
        }],
      }],
    };
  }

  function cleanStoredSession(id) {
    return {
      id,
      name: 'clean',
      version: 2,
      createdAt: 2,
      modifiedAt: 2,
      windows: [{
        tabCount: 1,
        tabs: [{ url: 'https://clean.test/', title: 'Clean', favIconUrl: '', pinned: false }],
      }],
    };
  }

  test('one poisoned record no longer blocks deleting a different session', async () => {
    installChromeMock({
      local: { sessions: [poisonedStoredSession('poisoned-id'), cleanStoredSession('clean-id')] },
    });

    await expect(deleteSessions(['clean-id'])).resolves.toMatchObject({
      deletedIds: ['clean-id'],
    });

    // The write-back persists the healed shape: bounded title, dropped favicon.
    const [healed] = storedSessions();
    expect(healed.id).toBe('poisoned-id');
    expect(healed.windows[0].tabs[0].title).toHaveLength(500);
    expect(healed.windows[0].tabs[0].favIconUrl).toBe('');
  });

  test('the poisoned session itself becomes deletable', async () => {
    installChromeMock({
      local: { sessions: [poisonedStoredSession('poisoned-id'), cleanStoredSession('clean-id')] },
    });

    await expect(deleteSessions(['poisoned-id'])).resolves.toMatchObject({
      deletedIds: ['poisoned-id'],
    });
    expect(storedSessions().map((session) => session.id)).toEqual(['clean-id']);
  });

  test('a stored tab whose URL cannot be represented is dropped, not fatal', async () => {
    installChromeMock({
      local: {
        sessions: [
          poisonedStoredSession('poisoned-id', { url: `https://poison.test/?q=${OVERSIZED}` }),
          cleanStoredSession('clean-id'),
        ],
      },
    });

    await expect(deleteSessions(['clean-id'])).resolves.toMatchObject({
      deletedIds: ['clean-id'],
    });
    const [healed] = storedSessions();
    expect(healed.windows[0].tabs).toEqual([]);
    expect(healed.windows[0].tabCount).toBe(0);
  });

  test('sync-only reads heal poisoned sessions and persist the corrected tab count', async () => {
    installChromeMock({
      local: {
        sessions: [poisonedStoredSession('poisoned-id', {
          url: `https://poison.test/?q=${OVERSIZED}`,
        })],
      },
    });

    await expect(readLocalDriveSyncDocument()).resolves.toMatchObject({
      version: 2,
      sessions: [{ id: 'poisoned-id', windows: [{ tabCount: 0, tabs: [] }] }],
    });
    expect(storedSessions()[0].windows[0]).toMatchObject({ tabCount: 0, tabs: [] });
  });

  test('session-only exports heal poisoned sessions and persist the corrected shape', async () => {
    installChromeMock({
      local: { sessions: [poisonedStoredSession('poisoned-id')] },
    });

    await expect(buildPortableExportPayload('sessions')).resolves.toMatchObject({
      kind: 'sessions',
      sessions: [{ id: 'poisoned-id' }],
    });
    const [healed] = storedSessions();
    expect(healed.windows[0].tabCount).toBe(1);
    expect(healed.windows[0].tabs[0].title).toHaveLength(500);
    expect(healed.windows[0].tabs[0].favIconUrl).toBe('');
  });

  test('legal legacy values between the capture and canonical bounds stay untouched', async () => {
    const legacyTitle = 'y'.repeat(2_000);
    installChromeMock({
      local: {
        sessions: [{
          ...cleanStoredSession('legacy-id'),
          windows: [{
            tabCount: 1,
            tabs: [{ url: 'https://legacy.test/', title: legacyTitle, favIconUrl: '', pinned: false }],
          }],
        }, cleanStoredSession('clean-id')],
      },
    });

    await expect(deleteSessions(['clean-id'])).resolves.toMatchObject({
      deletedIds: ['clean-id'],
    });
    const [kept] = storedSessions();
    expect(kept.windows[0].tabs[0].title).toBe(legacyTitle);
  });
});

describe('sanitizeCapturedTab / sanitizeCapturedGroupTitle', () => {
  test('rejects tabs that cannot be represented', () => {
    expect(sanitizeCapturedTab(null)).toBeNull();
    expect(sanitizeCapturedTab([])).toBeNull();
    expect(sanitizeCapturedTab({ title: 'no url' })).toBeNull();
    expect(sanitizeCapturedTab({ url: '   ' })).toBeNull();
    expect(sanitizeCapturedTab({ url: `https://a.test/?q=${OVERSIZED}` })).toBeNull();
  });

  test('bounds page-controlled fields and preserves identity fields', () => {
    const captured = sanitizeCapturedTab({
      url: ' https://keep.test/path#hash ',
      title: OVERSIZED,
      favIconUrl: OVERSIZED_DATA_FAVICON,
      pinned: 1,
      groupId: 7,
    });
    expect(captured.url).toBe('https://keep.test/path#hash');
    expect(captured.title).toHaveLength(500);
    expect(captured.favIconUrl).toBe('');
    expect(captured.pinned).toBe(true);
    expect(captured.groupId).toBe(7);
  });

  test('keeps allowed favicon schemes within bounds and rejects the rest', () => {
    const okFavicon = 'data:image/png;base64,AAAA';
    expect(sanitizeCapturedTab({ url: 'https://a.test/', favIconUrl: okFavicon }).favIconUrl)
      .toBe(okFavicon);
    expect(sanitizeCapturedTab({ url: 'https://a.test/', favIconUrl: 'javascript:alert(1)' }).favIconUrl)
      .toBe('');
    expect(sanitizeCapturedTab({ url: 'https://a.test/', favIconUrl: 'ftp://a.test/icon' }).favIconUrl)
      .toBe('');
  });

  test('bounds captured group titles to the runtime 200-character limit', () => {
    expect(sanitizeCapturedGroupTitle(OVERSIZED)).toHaveLength(200);
    expect(sanitizeCapturedGroupTitle('Research')).toBe('Research');
    expect(sanitizeCapturedGroupTitle(undefined)).toBe('');
  });
});
