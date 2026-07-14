import { describe, expect, test } from 'bun:test';

import { findDuplicates, findEmptyPages, normalizeUrl } from '../../core/duplicates.js';
import { installChromeMock } from '../helpers/chrome-mock.js';

describe('duplicate URL identity', () => {
  test('keeps hash routes and ordinary fragments distinct', () => {
    expect(normalizeUrl('https://app.test/#/one')).toBe('https://app.test/#/one');
    expect(normalizeUrl('https://app.test/#/two')).toBe('https://app.test/#/two');
    expect(normalizeUrl('https://docs.test/page#intro')).toBe('https://docs.test/page#intro');
    expect(normalizeUrl('https://docs.test/page#details')).toBe('https://docs.test/page#details');
  });

  test('keeps existing query and trailing-slash normalization behavior', () => {
    expect(normalizeUrl('https://app.test/path/')).toBe('https://app.test/path');
    expect(normalizeUrl('https://app.test/path///?view=all#route')).toBe(
      'https://app.test/path?view=all#route',
    );
    expect(normalizeUrl('https://app.test/?view=all#route')).toBe(
      'https://app.test/?view=all#route',
    );
  });

  test('groups identical hash-route copies but not different routes', async () => {
    installChromeMock({
      tabs: [
        { id: 1, windowId: 1, url: 'https://app.test/#/one', title: 'One A' },
        { id: 2, windowId: 1, url: 'https://app.test/#/one', title: 'One B' },
        { id: 3, windowId: 1, url: 'https://app.test/#/two', title: 'Two A' },
        { id: 4, windowId: 1, url: 'https://app.test/#/two', title: 'Two B' },
      ],
      windows: [{ id: 1, focused: true }],
    });

    const groups = await findDuplicates();

    expect(groups.map((group) => group.url)).toEqual([
      'https://app.test/#/one',
      'https://app.test/#/two',
    ]);
    expect(groups.map((group) => group.tabs.map((tab) => tab.id))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('retains each exact original URL in duplicate tab records', async () => {
    const originalUrl = 'https://app.test/path/?view=all#same-route';
    installChromeMock({
      tabs: [
        { id: 1, windowId: 1, url: originalUrl, title: 'First' },
        { id: 2, windowId: 1, url: originalUrl, title: 'Second' },
      ],
      windows: [{ id: 1, focused: true }],
    });

    const [group] = await findDuplicates();

    expect(group.tabs).toEqual([
      expect.objectContaining({ id: 1, url: originalUrl }),
      expect.objectContaining({ id: 2, url: originalUrl }),
    ]);
    expect(group.url).toBe('https://app.test/path?view=all#same-route');
  });

  test('does not offer Chrome new-tab pages as duplicates', async () => {
    installChromeMock({
      tabs: [
        { id: 1, windowId: 1, url: 'chrome://newtab/', title: 'New Tab' },
        { id: 2, windowId: 1, url: 'chrome://newtab/', title: 'New Tab' },
      ],
      windows: [{ id: 1, focused: true }],
    });

    expect(await findDuplicates()).toEqual([]);
  });

  test('keeps distinct opaque-origin Chrome pages separate', async () => {
    expect(normalizeUrl('chrome://settings/')).toBe('chrome://settings/');
    expect(normalizeUrl('chrome://extensions/')).toBe('chrome://extensions/');

    installChromeMock({
      tabs: [
        { id: 1, windowId: 1, url: 'chrome://settings/', title: 'Settings' },
        { id: 2, windowId: 1, url: 'chrome://extensions/', title: 'Extensions' },
      ],
      windows: [{ id: 1, focused: true }],
    });

    expect(await findDuplicates()).toEqual([]);
  });

  test('does not offer inactive Chrome new-tab pages as empty cleanup targets', async () => {
    installChromeMock({
      tabs: [
        { id: 1, windowId: 1, active: false, url: 'chrome://newtab/', title: 'New Tab' },
        { id: 2, windowId: 1, active: false, url: 'chrome://new-tab-page/', title: 'New Tab Page' },
        { id: 3, windowId: 1, active: false, url: 'about:blank', title: 'Blank' },
      ],
      windows: [{ id: 1, focused: true }],
    });

    expect(await findEmptyPages()).toEqual([
      expect.objectContaining({ id: 3, url: 'about:blank' }),
    ]);
  });
});

describe('collectUndoUrls', () => {
  test('captures selected original URLs in group and tab order without deduplicating', async () => {
    const { collectUndoUrls } = await import('../../core/duplicates.js');
    const groups = [
      {
        url: 'normalized-group-one',
        tabs: [
          { id: 1, url: 'https://one.test/#keep' },
          { id: 2, url: 'https://repeat.test/#route' },
          { id: 3, url: 'https://repeat.test/#route' },
          { id: 4, url: null },
        ],
      },
      {
        url: 'normalized-group-two',
        tabs: [
          { id: 5, url: 'https://two.test/#selected' },
          { id: 6 },
          { id: 7, url: 42 },
        ],
      },
    ];

    const urls = collectUndoUrls(groups, [3, 2, 4, 5, 6, 7, 999]);

    expect(urls).toEqual([
      'https://repeat.test/#route',
      'https://repeat.test/#route',
      'https://two.test/#selected',
    ]);
  });

  test('returns a fresh snapshot unaffected by later group or result mutation', async () => {
    const { collectUndoUrls } = await import('../../core/duplicates.js');
    const groups = [{ tabs: [{ id: 1, url: 'https://app.test/#/one' }] }];

    const first = collectUndoUrls(groups, [1]);
    groups[0].tabs[0].url = 'https://app.test/#/changed';
    first.push('https://app.test/#/local-mutation');
    const second = collectUndoUrls(groups, [1]);

    expect(first).toEqual([
      'https://app.test/#/one',
      'https://app.test/#/local-mutation',
    ]);
    expect(second).toEqual(['https://app.test/#/changed']);
    expect(second).not.toBe(first);
  });
});
