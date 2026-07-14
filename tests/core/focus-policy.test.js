import { describe, expect, test } from 'bun:test';

async function loadPolicy() {
  return import('../../core/focus-policy.js');
}

describe('Focus allowlist policy', () => {
  test('legacy strings and typed domains allow exact hosts and true subdomains', async () => {
    const { domainMatches } = await loadPolicy();
    const allowlist = ['legacy.test', { type: 'domain', value: 'Typed.Test' }];

    expect(domainMatches('https://legacy.test/path', allowlist)).toBe(true);
    expect(domainMatches('https://deep.legacy.test/path', allowlist)).toBe(true);
    expect(domainMatches('https://typed.test/path', allowlist)).toBe(true);
    expect(domainMatches('https://child.typed.test/path', allowlist)).toBe(true);
  });

  test('domain matching rejects sibling and suffix lookalikes', async () => {
    const { domainMatches } = await loadPolicy();
    const allowlist = [{ type: 'domain', value: 'example.com' }];

    expect(domainMatches('https://example.com.evil.test/', allowlist)).toBe(false);
    expect(domainMatches('https://notexample.com/', allowlist)).toBe(false);
    expect(domainMatches('https://example.co/', allowlist)).toBe(false);
  });

  test('URL entries match only the canonical exact URL, never a prefix', async () => {
    const { urlMatches } = await loadPolicy();
    const allowlist = [{ type: 'url', value: 'https://example.test/allowed' }];

    expect(urlMatches('https://example.test/allowed', allowlist)).toBe(true);
    expect(urlMatches('https://example.test/allowed/extra', allowlist)).toBe(false);
    expect(urlMatches('https://example.test/allowed?extra=1', allowlist)).toBe(false);
  });

  test('URL matching preserves path, query, and fragment case', async () => {
    const { urlMatches } = await loadPolicy();
    const allowlist = [{ type: 'url', value: 'https://example.test/Path?Q=One#Part' }];

    expect(urlMatches('https://EXAMPLE.test/Path?Q=One#Part', allowlist)).toBe(true);
    expect(urlMatches('https://example.test/path?Q=One#Part', allowlist)).toBe(false);
    expect(urlMatches('https://example.test/Path?q=One#Part', allowlist)).toBe(false);
    expect(urlMatches('https://example.test/Path?Q=One#part', allowlist)).toBe(false);
  });

  test('group matching uses rebound groupIds, including Chrome group ID zero', async () => {
    const { groupMatches } = await loadPolicy();
    const allowlist = [{ type: 'group', value: 'Deep Work', groupId: 9, groupIds: [0, 4] }];

    expect(groupMatches({ groupId: 0 }, allowlist)).toBe(true);
    expect(groupMatches({ groupId: 4 }, allowlist)).toBe(true);
    expect(groupMatches({ groupId: 9 }, allowlist)).toBe(false);
    expect(groupMatches({ groupId: -1 }, allowlist)).toBe(false);
  });

  test('same-title Chrome groups all rebind by exact title', async () => {
    const { resolveGroupAllowlist } = await loadPolicy();
    const resolved = resolveGroupAllowlist(
      [{ type: 'group', value: 'Deep Work', groupId: 88 }],
      [
        { id: 0, title: 'Deep Work' },
        { id: 7, title: 'Deep Work' },
        { id: 8, title: 'deep work' },
      ],
    );

    expect(resolved).toEqual([{ type: 'group', value: 'Deep Work', groupIds: [0, 7] }]);
  });

  test('rebinding replaces stale scalar and runtime IDs without mutating input', async () => {
    const { resolveGroupAllowlist } = await loadPolicy();
    const input = [
      'legacy.test',
      { type: 'domain', value: 'typed.test' },
      { type: 'group', value: 'Writing', groupId: 91, groupIds: [92] },
    ];
    const before = structuredClone(input);

    const resolved = resolveGroupAllowlist(input, [{ id: 3, title: 'Writing' }]);

    expect(resolved).toEqual([
      'legacy.test',
      { type: 'domain', value: 'typed.test' },
      { type: 'group', value: 'Writing', groupIds: [3] },
    ]);
    expect(resolved).not.toBe(input);
    expect(resolved[1]).not.toBe(input[1]);
    expect(resolved[2]).not.toBe(input[2]);
    expect(input).toEqual(before);
  });

  test('state rebinding is pure and replaces only runtime allowlist bindings', async () => {
    const { rebindFocusAllowlist } = await loadPolicy();
    const state = {
      status: 'paused',
      strictMode: true,
      allowedDomains: [{ type: 'group', value: 'Research', groupIds: [70], groupId: 71 }],
      blockedDomains: ['blocked.test'],
    };
    const before = structuredClone(state);

    const rebound = rebindFocusAllowlist(state, [{ id: 5, title: 'Research' }]);

    expect(rebound).toEqual({
      status: 'paused',
      strictMode: true,
      allowedDomains: [{ type: 'group', value: 'Research', groupIds: [5] }],
      blockedDomains: ['blocked.test'],
    });
    expect(rebound).not.toBe(state);
    expect(state).toEqual(before);
  });

  test('internal Chrome and extension pages are always allowed', async () => {
    const { isAllowed, isInternalUrl } = await loadPolicy();

    expect(isInternalUrl('chrome://settings/')).toBe(true);
    expect(isInternalUrl('chrome-extension://extension-id/panel.html')).toBe(true);
    expect(isInternalUrl('about:blank')).toBe(false);
    expect(isAllowed('chrome://newtab/', [])).toBe(true);
    expect(isAllowed({ url: 'chrome-extension://extension-id/panel.html' }, [])).toBe(true);
  });

  test('isAllowed delegates domain, exact URL, and group entries to one predicate', async () => {
    const { isAllowed } = await loadPolicy();
    const allowlist = [
      { type: 'domain', value: 'domain.test' },
      { type: 'url', value: 'https://url.test/Exact' },
      { type: 'group', value: 'Group', groupIds: [6] },
    ];

    expect(isAllowed({ url: 'https://sub.domain.test/' }, allowlist)).toBe(true);
    expect(isAllowed({ url: 'https://url.test/Exact' }, allowlist)).toBe(true);
    expect(isAllowed({ url: 'https://other.test/', groupId: 6 }, allowlist)).toBe(true);
    expect(isAllowed({ url: 'https://url.test/Exact/extra', groupId: -1 }, allowlist)).toBe(false);
  });

  test('policy evaluation allows internal pages before every blocking mode', async () => {
    const { evaluateFocusPolicy } = await loadPolicy();
    const state = {
      strictMode: true,
      allowedDomains: [],
      blockedDomains: ['settings'],
      blockedCategories: ['social'],
    };

    expect(evaluateFocusPolicy('chrome://settings/', state)).toEqual({
      blocked: false,
      reason: null,
      category: null,
    });
  });

  test('allowlist entries win over explicit and curated blocklists', async () => {
    const { evaluateFocusPolicy } = await loadPolicy();
    const state = {
      strictMode: true,
      allowedDomains: ['reddit.com'],
      blockedDomains: ['reddit.com'],
      blockedCategories: ['social'],
    };

    expect(evaluateFocusPolicy('https://reddit.com/r/focus', state)).toEqual({
      blocked: false,
      reason: null,
      category: null,
    });
  });

  test('explicit blocked domains preserve their reason and category', async () => {
    const { evaluateFocusPolicy } = await loadPolicy();

    expect(evaluateFocusPolicy('https://child.blocked.test/', {
      allowedDomains: [],
      blockedDomains: ['blocked.test'],
      strictMode: false,
      blockedCategories: [],
    })).toEqual({ blocked: true, reason: 'blocklist', category: 'Blocked Domain' });
  });

  test('strict mode with an empty allowlist blocks every non-internal URL', async () => {
    const { evaluateFocusPolicy } = await loadPolicy();
    const state = {
      allowedDomains: [],
      blockedDomains: [],
      strictMode: true,
      blockedCategories: [],
    };

    for (const url of ['https://ordinary.test/', 'about:blank', 'mailto:person@example.test']) {
      expect(evaluateFocusPolicy(url, state)).toEqual({
        blocked: true,
        reason: 'strict',
        category: 'Not in allowed list',
      });
    }
  });

  test('curated category matches preserve the existing category result', async () => {
    const { evaluateFocusPolicy } = await loadPolicy();

    expect(evaluateFocusPolicy('https://old.reddit.com/r/focus', {
      allowedDomains: [],
      blockedDomains: [],
      strictMode: false,
      blockedCategories: ['social'],
    })).toEqual({ blocked: true, reason: 'category', category: 'Social Media' });
  });

  test('non-strict unmatched URLs remain unblocked', async () => {
    const { evaluateFocusPolicy } = await loadPolicy();

    expect(evaluateFocusPolicy('about:blank', {
      allowedDomains: [],
      blockedDomains: [],
      strictMode: false,
      blockedCategories: [],
    })).toEqual({ blocked: false, reason: null, category: null });
  });

  test('domain entry construction canonicalizes valid hosts and rejects invalid input', async () => {
    const { createAllowlistEntry } = await loadPolicy();

    expect(createAllowlistEntry('domain', '  Example.COM.  ', [])).toEqual({
      type: 'domain',
      value: 'example.com',
    });
    expect(createAllowlistEntry('domain', 'localhost', [])).toEqual({
      type: 'domain',
      value: 'localhost',
    });
    expect(createAllowlistEntry('domain', '', [])).toBeNull();
    expect(createAllowlistEntry('domain', 'not a domain', [])).toBeNull();
    expect(createAllowlistEntry('domain', 'example.com/path', [])).toBeNull();
    expect(createAllowlistEntry('domain', 'example.com:8443', [])).toBeNull();
  });

  test('URL entry construction uses canonical href without lowercasing path data', async () => {
    const { createAllowlistEntry, urlMatches } = await loadPolicy();

    expect(createAllowlistEntry('url', 'HTTPS://Example.COM/Path?Q=One#Part', [])).toEqual({
      type: 'url',
      value: 'https://example.com/Path?Q=One#Part',
    });
    expect(createAllowlistEntry('url', 'relative/path', [])).toBeNull();
    expect(createAllowlistEntry('url', '', [])).toBeNull();
    expect(urlMatches('not a URL', [{ type: 'url', value: 'https://example.com/' }])).toBe(false);
  });

  test('group entry construction stores an exact live title and rejects missing or untitled groups', async () => {
    const { createAllowlistEntry } = await loadPolicy();
    const groups = [
      { id: 0, title: 'Deep Work' },
      { id: 4, title: '' },
    ];

    expect(createAllowlistEntry('group', '0', groups)).toEqual({
      type: 'group',
      value: 'Deep Work',
    });
    expect(createAllowlistEntry('group', 4, groups)).toBeNull();
    expect(createAllowlistEntry('group', 99, groups)).toBeNull();
    expect(createAllowlistEntry('unknown', 'value', groups)).toBeNull();
  });
});
