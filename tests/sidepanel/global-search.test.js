import { describe, expect, test } from 'bun:test';

import { getAllTabsGroupedByDomain } from '../../core/grouping.js';
import {
  flattenGroupedTabs,
  GlobalSearch,
  SEARCH_UNAVAILABLE_MESSAGE,
} from '../../sidepanel/components/global-search.js';
import { installChromeMock } from '../helpers/chrome-mock.js';

describe('grouped-array global search contract', () => {
  test('flattens two groups in group and tab order without reusing the response array', () => {
    const alphaOne = { id: 1, title: 'Alpha one' };
    const alphaTwo = { id: 2, title: 'Alpha two' };
    const beta = { id: 3, title: 'Beta' };
    const grouped = [
      { domain: 'alpha.test', tabs: [alphaOne, alphaTwo] },
      { domain: 'beta.test', tabs: [beta] },
    ];

    const flattened = flattenGroupedTabs(grouped);

    expect(flattened).toEqual([alphaOne, alphaTwo, beta]);
    expect(flattened).not.toBe(grouped);
  });

  test('accepts a valid empty grouped response', () => {
    expect(flattenGroupedTabs([])).toEqual([]);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['non-array primitive', 'groups'],
    ['error-shaped object', { error: 'worker failed' }],
    ['obsolete groups wrapper', { groups: [] }],
    ['null group', [null]],
    ['array group', [[]]],
    ['primitive group', ['alpha.test']],
    ['group without tabs', [{ domain: 'alpha.test' }]],
    ['group with non-array tabs', [{ domain: 'alpha.test', tabs: null }]],
    ['group with inherited tabs', [Object.create({ tabs: [] })]],
  ])('rejects malformed %s responses', (_label, grouped) => {
    expect(() => flattenGroupedTabs(grouped)).toThrow(new Error('Grouped tabs are unavailable'));
  });

  test('rejects an error-shaped array response', () => {
    const grouped = [];
    grouped.error = 'worker failed';

    expect(() => flattenGroupedTabs(grouped)).toThrow(new Error('Grouped tabs are unavailable'));
  });

  test('the worker grouping fixture returns the array contract rather than a wrapper', async () => {
    installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: 'https://alpha.test/one' },
        { id: 2, windowId: 1, url: 'https://beta.test/two' },
      ],
    });

    const grouped = await getAllTabsGroupedByDomain();

    expect(Array.isArray(grouped)).toBeTrue();
    expect(grouped).not.toHaveProperty('groups');
    expect(grouped.every((group) => Array.isArray(group.tabs))).toBeTrue();
  });
});

function seedStaleResults(search) {
  search._tabs = [{ id: 'stale-tab' }];
  search._stashes = [{ id: 'stale-stash' }];
  search._sessions = [{ id: 'stale-session' }];
  search.flatItems = [{ id: 'stale-result' }];
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.listeners = {};
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (value === '') this.children = [];
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  prepend(child) {
    this.children.unshift(child);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(name, listener) {
    this.listeners[name] = listener;
  }

  querySelector(selector) {
    if (this.id === 'search-overlay') {
      if (selector === '.search-input') {
        this._searchInput ||= new FakeElement('input');
        return this._searchInput;
      }
      if (selector === '.search-results') {
        this._searchResults ||= new FakeElement('div');
        return this._searchResults;
      }
    }
    if (!selector.startsWith('.')) return null;
    const className = selector.slice(1);
    return this.children.find((child) => child.className === className) || null;
  }

  focus() {
    this.focused = true;
  }

  remove() {
    this.removed = true;
  }
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

async function withFakeDocument(operation) {
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  try {
    return await operation();
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  }
}

async function withSearchDocument(operation) {
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const previousDocument = globalThis.document;
  const overlays = [];
  globalThis.document = {
    body: {
      appendChild(element) {
        overlays.push(element);
      },
    },
    createElement: (tagName) => new FakeElement(tagName),
    querySelector: () => null,
  };
  try {
    return await operation(overlays);
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  }
}

describe('global search loading outcomes', () => {
  test('uses all three checked calls and renders unavailable once after a rejection', async () => {
    const calls = [];
    const failure = new Error('sessions unavailable');
    const search = new GlobalSearch({
      send: async (message) => {
        calls.push(message);
        if (message.action === 'listSessions') throw failure;
        return [];
      },
    });
    seedStaleResults(search);
    const unavailable = [];
    let normalSearches = 0;
    search.renderUnavailable = (message) => unavailable.push(message);
    search._search = () => { normalSearches += 1; };

    await search._fetchAll();

    expect(calls).toEqual([
      { action: 'getGroupedTabs' },
      { action: 'listStashes' },
      { action: 'listSessions' },
    ]);
    expect(unavailable).toEqual([SEARCH_UNAVAILABLE_MESSAGE]);
    expect(normalSearches).toBe(0);
    expect(search._tabs).toEqual([]);
    expect(search._stashes).toEqual([]);
    expect(search._sessions).toEqual([]);
    expect(search.flatItems).toEqual([]);
  });

  test('clears stale results and renders unavailable for malformed grouped data', async () => {
    const search = new GlobalSearch({
      send: async ({ action }) => action === 'getGroupedTabs' ? { groups: [] } : [],
    });
    seedStaleResults(search);
    const unavailable = [];
    let normalSearches = 0;
    search.renderUnavailable = (message) => unavailable.push(message);
    search._search = () => { normalSearches += 1; };

    await search._fetchAll();

    expect(unavailable).toEqual([SEARCH_UNAVAILABLE_MESSAGE]);
    expect(normalSearches).toBe(0);
    expect(search._tabs).toEqual([]);
    expect(search._stashes).toEqual([]);
    expect(search._sessions).toEqual([]);
    expect(search.flatItems).toEqual([]);
  });

  test('treats valid empty arrays as a successful empty search', async () => {
    const search = new GlobalSearch({ send: async () => [] });
    const unavailable = [];
    const searches = [];
    search.renderUnavailable = (message) => unavailable.push(message);
    search._search = (query) => searches.push(query);

    await search._fetchAll();

    expect(unavailable).toEqual([]);
    expect(searches).toEqual(['']);
    expect(search._tabs).toEqual([]);
    expect(search._stashes).toEqual([]);
    expect(search._sessions).toEqual([]);
  });

  test.each([
    ['null stashes', null, []],
    ['false sessions', [], false],
    ['object stashes', {}, []],
    ['stash without own windows', [{}], []],
    ['session with inherited windows', [], [Object.create({ windows: [] })]],
    ['null stash window', [{ windows: [null] }], []],
    ['stash window without own tabs', [{ windows: [{}] }], []],
    ['session window with inherited tabs', [], [{ windows: [Object.create({ tabs: [] })] }]],
    ['non-array session tabs', [], [{ windows: [{ tabs: false }] }]],
  ])('rejects %s before committing search caches', async (_label, stashes, sessions) => {
    const search = new GlobalSearch({
      send: async ({ action }) => {
        if (action === 'getGroupedTabs') return [];
        if (action === 'listStashes') return stashes;
        return sessions;
      },
    });
    seedStaleResults(search);
    const unavailable = [];
    let normalSearches = 0;
    search.renderUnavailable = (message) => unavailable.push(message);
    search._search = () => { normalSearches += 1; };

    await search._fetchAll();

    expect(search._loadState).toBe('unavailable');
    expect(unavailable).toEqual([SEARCH_UNAVAILABLE_MESSAGE]);
    expect(normalSearches).toBe(0);
    expect(search._tabs).toEqual([]);
    expect(search._stashes).toEqual([]);
    expect(search._sessions).toEqual([]);
  });

  test('accepts current stash and session record arrays before cache commit', async () => {
    const stashes = [{ id: 'stash-current', windows: [{ tabs: [] }] }];
    const sessions = [{ id: 'session-current', windows: [{ tabs: [] }] }];
    const search = new GlobalSearch({
      send: async ({ action }) => {
        if (action === 'getGroupedTabs') return [];
        if (action === 'listStashes') return stashes;
        return sessions;
      },
    });
    search._search = () => {};

    await search._fetchAll();

    expect(search._loadState).toBe('ready');
    expect(search._stashes).toEqual(stashes);
    expect(search._sessions).toEqual(sessions);
  });

  test('a slower fetch cannot replace a newer fetch in the same open lifecycle', async () => {
    const gates = Array.from({ length: 6 }, () => deferred());
    let callIndex = 0;
    const search = new GlobalSearch({ send: () => gates[callIndex++].promise });
    search._search = () => {};

    const firstFetch = search._fetchAll();
    const secondFetch = search._fetchAll();
    gates[3].resolve([{ domain: 'new.test', tabs: [{ id: 'new-tab' }] }]);
    gates[4].resolve([{ id: 'new-stash', windows: [] }]);
    gates[5].resolve([{ id: 'new-session', windows: [] }]);
    await secondFetch;

    gates[0].resolve([{ domain: 'old.test', tabs: [{ id: 'old-tab' }] }]);
    gates[1].resolve([{ id: 'old-stash', windows: [] }]);
    gates[2].resolve([{ id: 'old-session', windows: [] }]);
    await firstFetch;

    expect(search._loadState).toBe('ready');
    expect(search._tabs).toEqual([{ id: 'new-tab' }]);
    expect(search._stashes.map(({ id }) => id)).toEqual(['new-stash']);
    expect(search._sessions.map(({ id }) => id)).toEqual(['new-session']);
  });

  test('a failed fetch from a closed lifecycle cannot clear a reopened search', async () => {
    const first = Array.from({ length: 3 }, () => deferred());
    let callIndex = 0;
    const currentResponses = [
      [{ domain: 'current.test', tabs: [{ id: 'current-tab' }] }],
      [{ id: 'current-stash', windows: [] }],
      [{ id: 'current-session', windows: [] }],
    ];
    const search = new GlobalSearch({
      send: () => callIndex < 3 ? first[callIndex++].promise : currentResponses[callIndex++ - 3],
    });
    search._search = () => {};
    const unavailable = [];
    search.renderUnavailable = (message) => unavailable.push(message);

    await withSearchDocument(async () => {
      search.open();
      search.close();
      search.open();
      await flushMicrotasks();

      first[0].resolve([]);
      first[1].resolve([]);
      first[2].reject(new Error('stale private failure'));
      await flushMicrotasks();
    });

    expect(search._loadState).toBe('ready');
    expect(search._tabs).toEqual([{ id: 'current-tab' }]);
    expect(search._stashes.map(({ id }) => id)).toEqual(['current-stash']);
    expect(search._sessions.map(({ id }) => id)).toEqual(['current-session']);
    expect(unavailable).toEqual([]);
  });

  test('renders one accessible unavailable result with the exact copy', () => {
    const children = [];
    const search = new GlobalSearch();
    search.resultsEl = {
      replaceChildren(...next) {
        children.splice(0, children.length, ...next);
      },
    };
    const hadDocument = Object.hasOwn(globalThis, 'document');
    const previousDocument = globalThis.document;
    globalThis.document = {
      createElement: () => ({
        className: '',
        role: '',
        textContent: '',
        setAttribute(name, value) {
          this[name] = value;
        },
      }),
    };

    try {
      search.renderUnavailable(SEARCH_UNAVAILABLE_MESSAGE);
    } finally {
      if (hadDocument) globalThis.document = previousDocument;
      else delete globalThis.document;
    }

    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      className: 'search-empty',
      role: 'alert',
      textContent: 'Search unavailable — try again.',
    });
  });

  test('current stash and session schemas match nested tabs and render canonical metadata', async () => {
    const search = new GlobalSearch();
    const renderResults = search._renderResults.bind(search);
    search._loadState = 'ready';
    search._tabs = [];
    search._stashes = [{
      id: 'stash-current',
      name: 'Current stash',
      createdAt: 1_700_000_000_000,
      tabCount: 7,
      windows: [{
        tabCount: 2,
        tabs: [
          { title: 'Nested needle title', url: 'https://stash.test/one' },
          { title: 'Other', url: 'https://stash.test/two' },
        ],
      }],
    }];
    search._sessions = [{
      id: 'session-current',
      name: 'Current session',
      createdAt: 1_710_000_000_000,
      windows: [{
        tabCount: 2,
        tabs: [
          { title: 'Session tab', url: 'https://needle.session.test/path' },
          { title: 'Other', url: 'https://session.test/two' },
        ],
      }],
    }];
    let captured;
    search._renderResults = (tabs, stashes, sessions) => {
      captured = { tabs, stashes, sessions };
    };

    search._search('needle');

    expect(captured.stashes).toHaveLength(1);
    expect(captured.stashes[0]._matchCount).toBe(1);
    expect(captured.sessions).toHaveLength(1);
    expect(captured.sessions[0]).toMatchObject({ _matchCount: 1, _totalTabs: 2 });

    await withFakeDocument(() => {
      search.resultsEl = new FakeElement();
      search._formatDate = (value) => `date:${value}`;
      renderResults([], captured.stashes, captured.sessions);

      const stashItem = search.resultsEl.children.find((node) => node.dataset.type === 'stash');
      const sessionItem = search.resultsEl.children.find((node) => node.dataset.type === 'session');
      expect(stashItem.querySelector('.search-item-url').textContent)
        .toBe('7 tabs \u00B7 1 matched \u00B7 date:1700000000000');
      expect(sessionItem.querySelector('.search-item-url').textContent)
        .toBe('2 tabs \u00B7 1 matched \u00B7 date:1710000000000');
    });
  });

  test('typing after unavailable cannot replace the alert with ordinary no-results', async () => {
    const search = new GlobalSearch({ send: async () => { throw new Error('worker unavailable'); } });
    search.input = { value: 'typed later' };
    const rendered = [];
    let normalSearches = 0;
    search.renderUnavailable = (message) => rendered.push(message);
    search._search = () => { normalSearches += 1; };

    await search._fetchAll();
    search._onInput();
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(search._loadState).toBe('unavailable');
    expect(rendered).toEqual([SEARCH_UNAVAILABLE_MESSAGE]);
    expect(normalSearches).toBe(0);
  });

  test('a successful reload resets unavailable state before searching', async () => {
    let unavailable = true;
    const search = new GlobalSearch({
      send: async () => {
        if (unavailable) throw new Error('worker unavailable');
        return [];
      },
    });
    const searches = [];
    search.renderUnavailable = () => {};
    search._search = (query) => searches.push(query);

    await search._fetchAll();
    unavailable = false;
    await search._fetchAll();

    expect(search._loadState).toBe('ready');
    expect(searches).toEqual(['']);
  });

  test.each([
    ['tab activation', { 'tabs.update': new Error('private tab failure') }],
    ['window focus', { 'windows.update': new Error('private window failure') }],
  ])('failed %s keeps search open and renders one safe accessible error', async (_label, failures) => {
    installChromeMock({
      windows: [{ id: 9, focused: true }],
      tabs: [{ id: 7, windowId: 9, url: 'https://activation.test/' }],
      failures,
    });
    const search = new GlobalSearch();
    let closed = 0;
    search.overlay = { remove: () => { closed += 1; } };
    search.resultsEl = new FakeElement();
    const item = { dataset: { type: 'tab', tabId: '7', windowId: '9' } };

    await withFakeDocument(async () => {
      await search._activateResult(item);
    });

    expect(closed).toBe(0);
    const alert = search.resultsEl.querySelector('.search-action-error');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toBe('Could not open tab \u2014 try again.');
  });

  test('successful tab activation awaits both Chrome operations before closing', async () => {
    const harness = installChromeMock({
      windows: [{ id: 9, focused: true }],
      tabs: [{ id: 7, windowId: 9, url: 'https://activation.test/' }],
    });
    const search = new GlobalSearch();
    let closed = 0;
    search.overlay = { remove: () => { closed += 1; } };
    search.resultsEl = new FakeElement();
    search.input = null;

    await search._activateResult({ dataset: { type: 'tab', tabId: '7', windowId: '9' } });

    expect(harness.calls.tabs.update).toEqual([[7, { active: true }]]);
    expect(harness.calls.windows.update).toEqual([[9, { focused: true }]]);
    expect(closed).toBe(1);
  });

  test('stale tab activation success cannot focus or close a reopened search', async () => {
    const gate = deferred();
    const harness = installChromeMock({
      windows: [{ id: 9, focused: true }],
      tabs: [{ id: 7, windowId: 9, url: 'https://activation.test/' }],
    });
    chrome.tabs.update = () => gate.promise;
    const search = new GlobalSearch({ send: async () => [] });
    search._search = () => {};

    await withSearchDocument(async () => {
      search.open();
      await flushMicrotasks();
      const activation = search._activateResult({ dataset: { type: 'tab', tabId: '7', windowId: '9' } });
      search.close();
      search.open();
      const reopenedOverlay = search.overlay;
      gate.resolve({ id: 7 });

      await activation;

      expect(search.overlay).toBe(reopenedOverlay);
      expect(harness.calls.windows.update).toEqual([]);
    });
  });

  test('stale tab activation failure cannot render into a reopened search', async () => {
    const gate = deferred();
    installChromeMock({
      windows: [{ id: 9, focused: true }],
      tabs: [{ id: 7, windowId: 9, url: 'https://activation.test/' }],
    });
    chrome.tabs.update = () => gate.promise;
    const search = new GlobalSearch({ send: async () => [] });
    search._search = () => {};

    await withSearchDocument(async () => {
      search.open();
      await flushMicrotasks();
      const activation = search._activateResult({ dataset: { type: 'tab', tabId: '7', windowId: '9' } });
      search.close();
      search.open();
      const reopenedOverlay = search.overlay;
      gate.reject(new Error('stale private failure'));

      await activation;

      expect(search.overlay).toBe(reopenedOverlay);
      expect(search.resultsEl.querySelector('.search-action-error')).toBeNull();
    });
  });
});
