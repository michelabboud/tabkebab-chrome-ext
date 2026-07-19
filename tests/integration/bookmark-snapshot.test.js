import { describe, expect, test } from 'bun:test';

import { installChromeMock, readStorageArea } from '../helpers/chrome-mock.js';

let workerNonce = 0;

async function freshWorker(label) {
  return import(`../../service-worker.js?task9-bookmarks=${label}-${++workerNonce}`);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bookmarkDriveRouter({ uploaded, events }) {
  const ids = {
    TabKebab: 'root-id',
    Profile: 'profile-id',
    bookmarks: 'bookmarks-id',
  };
  return async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || 'GET';
    if (method === 'POST' && url.pathname.endsWith('/files') && url.searchParams.get('uploadType') === 'multipart') {
      events.push('drive-write');
      const file = options.body instanceof FormData
        ? [...options.body.entries()].find(([name]) => name === 'file')?.[1]
        : null;
      if (!(file instanceof Blob)) throw new Error('Expected bookmark upload Blob');
      uploaded.push(JSON.parse(await file.text()));
      return jsonResponse({ id: 'uploaded-bookmark-id' });
    }

    const query = url.searchParams.get('q') || '';
    const parentMatch = query.match(/'([^']+)' in parents/);
    const nameMatch = query.match(/name='([^']+)'/);
    if (nameMatch && query.includes("mimeType='application/vnd.google-apps.folder'")) {
      return jsonResponse({ files: [{ id: ids[nameMatch[1]] || `${nameMatch[1]}-id`, name: nameMatch[1] }] });
    }
    if (parentMatch && nameMatch) return jsonResponse({ files: [] });
    return jsonResponse({ files: [] });
  };
}

describe('stable bookmark snapshot identity', () => {
  test('worker local and Drive actions assign a UUID before either destination write', async () => {
    const harness = installChromeMock({
      local: {
        driveProfileName: 'Profile',
        driveSync: { connected: true },
      },
      windows: [{ id: 1, focused: true }],
      tabs: [{
        id: 1,
        windowId: 1,
        index: 0,
        active: true,
        title: 'Fixture',
        url: 'https://bookmark-fixture.test/',
      }],
    });
    const originalRandomUUID = crypto.randomUUID;
    const originalFetch = globalThis.fetch;
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    const uuids = ['bookmark-local-uuid', 'bookmark-drive-uuid'];
    const events = [];
    const uploaded = [];
    crypto.randomUUID = () => {
      const value = uuids.shift();
      events.push(`uuid:${value}`);
      return value;
    };
    chrome.storage.local.set = async (values) => {
      if (Object.hasOwn(values, 'tabkebabBookmarks')) events.push('local-write');
      return originalSet(values);
    };
    globalThis.fetch = bookmarkDriveRouter({ uploaded, events });

    try {
      const worker = await freshWorker('stable-id');
      const localResult = await worker.handleMessage({
        action: 'createBookmarks',
        options: {
          byWindows: true,
          byGroups: false,
          byDomains: false,
          destination: 'indexeddb',
        },
      });
      expect(localResult).toMatchObject({ created: 1, destinations: ['Local Storage'] });
      const localSnapshot = readStorageArea('local').tabkebabBookmarks[0];
      expect(localSnapshot.id).toBe('bookmark-local-uuid');
      expect(events.indexOf('uuid:bookmark-local-uuid')).toBeLessThan(events.indexOf('local-write'));

      const driveResult = await worker.handleMessage({
        action: 'createBookmarks',
        options: {
          byWindows: true,
          byGroups: false,
          byDomains: false,
          destination: 'drive',
        },
      });
      expect(driveResult).toMatchObject({ created: 1, destinations: ['Google Drive'] });
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0].id).toBe('bookmark-drive-uuid');
      expect(events.indexOf('uuid:bookmark-drive-uuid')).toBeLessThan(events.indexOf('drive-write'));
      expect(uploaded[0].id).not.toBe(`${uploaded[0].createdAt}:${uploaded[0].date}:${uploaded[0].time}`);
      expect(harness.calls.identity.getAuthToken.length).toBeGreaterThan(0);
    } finally {
      crypto.randomUUID = originalRandomUUID;
      chrome.storage.local.set = originalSet;
      globalThis.fetch = originalFetch;
    }
  });
});
