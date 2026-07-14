import { describe, expect, test } from 'bun:test';

import { restoreSession } from '../../core/sessions.js';
import { restoreStashTabs } from '../../core/stash-db.js';
import { installChromeMock } from '../helpers/chrome-mock.js';

const OPEN_ROUTE = 'https://app.test/#/one';
const SAVED_ROUTE = 'https://app.test/#/two';

function installRouteChrome(local = {}) {
  return installChromeMock({
    local,
    windows: [{ id: 1, focused: true }],
    tabs: [{
      id: 10,
      windowId: 1,
      index: 0,
      active: true,
      url: OPEN_ROUTE,
      title: 'Route one',
    }],
  });
}

function expectedCompleteOutcome() {
  return {
    requestedCount: 1,
    restoredCount: 1,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    errors: [],
    complete: true,
    windowsCreated: 0,
    groupsRestored: 0,
  };
}

describe('hash-route restoration', () => {
  test('restoreSession creates a saved route when a different route is open', async () => {
    const session = {
      id: 'hash-session',
      name: 'Hash session',
      version: 2,
      createdAt: 1,
      modifiedAt: 1,
      windows: [{ tabs: [{ url: SAVED_ROUTE, title: 'Route two' }] }],
    };
    const harness = installRouteChrome({ sessions: [session] });

    const result = await restoreSession(session.id, { mode: 'here', discarded: false });

    expect(result).toEqual(expectedCompleteOutcome());
    expect(harness.calls.tabs.create).toEqual([[{
      windowId: 1,
      url: SAVED_ROUTE,
      active: false,
    }]]);
    expect(harness.snapshot().tabs.filter((tab) => tab.url === SAVED_ROUTE)).toHaveLength(1);
  });

  test('restoreStashTabs creates a saved route when a different route is open', async () => {
    const stash = {
      id: 'hash-stash',
      name: 'Hash stash',
      createdAt: 1,
      windows: [{ tabs: [{ url: SAVED_ROUTE, title: 'Route two' }] }],
    };
    const harness = installRouteChrome();

    const result = await restoreStashTabs(stash, { mode: 'here', discarded: false });

    expect(result).toEqual(expectedCompleteOutcome());
    expect(harness.calls.tabs.create).toEqual([[{
      windowId: 1,
      url: SAVED_ROUTE,
      active: false,
    }]]);
    expect(harness.snapshot().tabs.filter((tab) => tab.url === SAVED_ROUTE)).toHaveLength(1);
  });
});
