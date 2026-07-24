import { describe, expect, test } from 'bun:test';

import { MAX_DRIVE_STRING_LENGTH } from '../../core/drive-sync.js';
import * as stashListModule from '../../sidepanel/components/stash-list.js';

describe('stash favicon render gate', () => {
  test('rejects executable and oversized values', () => {
    expect(stashListModule.safeFaviconUrl).toBeFunction();
    if (typeof stashListModule.safeFaviconUrl !== 'function') return;

    expect(stashListModule.safeFaviconUrl('javascript:alert(1)')).toBeNull();
    expect(stashListModule.safeFaviconUrl(`https://icons.test/${'x'.repeat(MAX_DRIVE_STRING_LENGTH)}`))
      .toBeNull();
  });

  test('passes valid network and embedded favicon values', () => {
    expect(stashListModule.safeFaviconUrl).toBeFunction();
    if (typeof stashListModule.safeFaviconUrl !== 'function') return;

    expect(stashListModule.safeFaviconUrl('https://icons.test/favicon.png'))
      .toBe('https://icons.test/favicon.png');
    expect(stashListModule.safeFaviconUrl('data:image/png;base64,AAAA'))
      .toBe('data:image/png;base64,AAAA');
  });
});
