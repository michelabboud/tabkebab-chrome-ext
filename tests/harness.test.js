import { describe, expect, test } from 'bun:test';

import {
  createChromeEvent,
  createRuntimePortPair,
  installChromeMock,
  readStorageArea,
} from './helpers/chrome-mock.js';

let previousStorageEvent;
let previousStorageListener;
let previousClientPort;
let previousWorkerPort;
let previousPortDisconnects;

describe('Chrome mock harness', () => {
  test('a test can mutate storage and listeners without leaking them', async () => {
    previousStorageEvent = chrome.storage.onChanged;
    previousStorageListener = () => {};
    previousStorageEvent.addListener(previousStorageListener);

    await chrome.storage.local.set({ leaked: true });

    expect(readStorageArea('local')).toEqual({ leaked: true });
    expect(previousStorageEvent.hasListener(previousStorageListener)).toBe(true);
  });

  test('the preload gives the next test isolated storage and listeners', () => {
    expect(readStorageArea('local')).toEqual({});
    expect(readStorageArea('session')).toEqual({});
    expect(chrome.storage.onChanged).not.toBe(previousStorageEvent);
    expect(previousStorageEvent.hasListener(previousStorageListener)).toBe(false);
  });

  test('a test can open a runtime port without leaking it', () => {
    const harness = installChromeMock();
    previousPortDisconnects = { client: 0, worker: 0 };
    chrome.runtime.onConnect.addListener((port) => {
      previousWorkerPort = port;
    });

    previousClientPort = harness.connect('isolated-port');
    previousClientPort.onDisconnect.addListener(() => previousPortDisconnects.client++);
    previousWorkerPort.onDisconnect.addListener(() => previousPortDisconnects.worker++);
  });

  test('the preload disconnects both ends of ports from the prior test', () => {
    expect(previousPortDisconnects).toEqual({ client: 1, worker: 1 });
    expect(() => previousClientPort.postMessage({ stale: true })).toThrow('disconnected');
    expect(() => previousWorkerPort.postMessage({ stale: true })).toThrow('disconnected');
  });

  test('local and session storage remain separate', async () => {
    await chrome.storage.local.set({ shared: 'local', localOnly: true });
    await chrome.storage.session.set({ shared: 'session', sessionOnly: true });

    expect(await chrome.storage.local.get(['shared', 'sessionOnly'])).toEqual({
      shared: 'local',
    });
    expect(await chrome.storage.session.get(['shared', 'localOnly'])).toEqual({
      shared: 'session',
    });
  });

  test('storage setters emit Chrome-shaped change records', async () => {
    const changes = [];
    chrome.storage.onChanged.addListener((changeRecord, areaName) => {
      changes.push([changeRecord, areaName]);
    });

    await chrome.storage.local.set({ theme: 'dark', enabled: true });
    await chrome.storage.local.set({ theme: 'light' });

    expect(changes).toEqual([
      [
        {
          theme: { newValue: 'dark' },
          enabled: { newValue: true },
        },
        'local',
      ],
      [
        {
          theme: { oldValue: 'dark', newValue: 'light' },
        },
        'local',
      ],
    ]);
  });

  test('storage.getBytesInUse records only its own API call', async () => {
    const harness = installChromeMock({ local: { theme: 'dark' } });

    expect(await chrome.storage.local.getBytesInUse('theme')).toBeGreaterThan(0);
    expect(harness.calls.storage.local.getBytesInUse).toEqual([['theme']]);
    expect(harness.calls.storage.local.get).toEqual([]);
  });

  test('seeded tabs, windows, and groups mutate through Chrome APIs', async () => {
    const harness = installChromeMock({
      tabs: [
        {
          id: 11,
          windowId: 7,
          index: 0,
          groupId: -1,
          active: true,
          pinned: false,
          url: 'https://one.test/',
          title: 'One',
        },
      ],
      windows: [{ id: 7, focused: true, state: 'normal', type: 'normal' }],
      groups: [
        { id: 31, windowId: 7, title: 'Work', color: 'blue', collapsed: false },
      ],
    });

    const created = await chrome.tabs.create({
      windowId: 7,
      active: false,
      url: 'https://two.test/',
    });
    await chrome.tabs.update(created.id, { pinned: true });
    await chrome.tabs.group({ tabIds: [created.id], groupId: 31 });
    await chrome.windows.update(7, { state: 'maximized' });
    await chrome.tabGroups.update(31, { title: 'Deep Work', color: 'purple' });

    const snapshot = harness.snapshot();
    expect(snapshot.tabs).toContainEqual(
      expect.objectContaining({
        id: created.id,
        windowId: 7,
        groupId: 31,
        pinned: true,
        url: 'https://two.test/',
      }),
    );
    expect(snapshot.windows).toContainEqual(
      expect.objectContaining({ id: 7, state: 'maximized' }),
    );
    expect(snapshot.groups).toContainEqual(
      expect.objectContaining({ id: 31, title: 'Deep Work', color: 'purple' }),
    );
    expect(harness.calls.tabs.create).toHaveLength(1);
    expect(harness.calls.tabs.update).toHaveLength(1);
    expect(harness.calls.tabs.group).toHaveLength(1);
  });

  test('windows.create focuses a new window by default', async () => {
    const harness = installChromeMock({
      windows: [{ id: 1, focused: true, state: 'normal', type: 'normal' }],
    });

    const created = await chrome.windows.create({ url: 'https://new.test/' });

    expect(created.focused).toBe(true);
    expect(harness.snapshot().windows).toEqual([
      expect.objectContaining({ id: 1, focused: false }),
      expect.objectContaining({ id: created.id, focused: true }),
    ]);
  });

  test('windows.create preserves focus when the new window opts out', async () => {
    const harness = installChromeMock({
      windows: [{ id: 1, focused: true, state: 'normal', type: 'normal' }],
    });

    const created = await chrome.windows.create({
      focused: false,
      url: 'https://background.test/',
    });

    expect(created.focused).toBe(false);
    expect(harness.snapshot().windows).toEqual([
      expect.objectContaining({ id: 1, focused: true }),
      expect.objectContaining({ id: created.id, focused: false }),
    ]);
  });

  test('events remove listeners and await asynchronous listeners', async () => {
    const event = createChromeEvent();
    const received = [];
    const listener = async (value) => {
      await Promise.resolve();
      received.push(value);
    };

    event.addListener(listener);
    expect(event.hasListener(listener)).toBe(true);
    await event.dispatch('first');
    event.removeListener(listener);
    await event.dispatch('second');

    expect(event.hasListener(listener)).toBe(false);
    expect(received).toEqual(['first']);
  });

  test('runtime ports deliver only to their peer and disconnect both ends once', async () => {
    const { clientPort, workerPort } = createRuntimePortPair('chrome-ai');
    const clientMessages = [];
    const workerMessages = [];
    let clientDisconnects = 0;
    let workerDisconnects = 0;

    clientPort.onMessage.addListener((message) => clientMessages.push(message));
    workerPort.onMessage.addListener((message) => workerMessages.push(message));
    clientPort.onDisconnect.addListener(() => clientDisconnects++);
    workerPort.onDisconnect.addListener(() => workerDisconnects++);

    await clientPort.postMessage({ request: 1 });
    expect(clientMessages).toEqual([]);
    expect(workerMessages).toEqual([{ request: 1 }]);

    await workerPort.postMessage({ response: 1 });
    expect(clientMessages).toEqual([{ response: 1 }]);
    expect(workerMessages).toEqual([{ request: 1 }]);

    await clientPort.disconnect();
    await workerPort.disconnect();
    expect(clientDisconnects).toBe(1);
    expect(workerDisconnects).toBe(1);
  });

  test('runtime.connect returns the client and dispatches its worker peer', async () => {
    let connectedWorker;
    chrome.runtime.onConnect.addListener((port) => {
      connectedWorker = port;
    });

    const client = chrome.runtime.connect({ name: 'focus-ai' });
    expect(client.name).toBe('focus-ai');
    expect(connectedWorker?.name).toBe('focus-ai');

    const messages = [];
    connectedWorker.onMessage.addListener((message) => messages.push(message));
    await client.postMessage({ type: 'classify' });
    expect(messages).toEqual([{ type: 'classify' }]);
  });

  test('runtime.sendMessage awaits an asynchronous sendResponse channel', async () => {
    chrome.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
      setTimeout(() => sendResponse({ ok: true }), 0);
      return true;
    });

    await expect(chrome.runtime.sendMessage({ type: 'delayed' })).resolves.toEqual({
      ok: true,
    });
  });

  test('failure injection rejects once and then allows the next call', async () => {
    installChromeMock({
      failures: {
        'storage.local.set': [new Error('disk unavailable')],
      },
    });

    await expect(chrome.storage.local.set({ first: true })).rejects.toThrow(
      'disk unavailable',
    );
    await expect(chrome.storage.local.set({ second: true })).resolves.toBeUndefined();
    expect(readStorageArea('local')).toEqual({ second: true });
  });
});
