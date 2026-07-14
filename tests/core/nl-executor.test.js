import { describe, expect, test } from 'bun:test';

import { executeNLAction, filterTabs, isValidTabFilter } from '../../core/nl-executor.js';
import { installChromeMock } from '../helpers/chrome-mock.js';

let workerImportNonce = 0;

function ids(tabs) {
  return tabs.map((tab) => tab.id);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(message);
}

async function importWorkerWithAi(tabs, complete) {
  const harness = installChromeMock({
    windows: [{ id: 1, focused: true }],
    tabs,
  });
  const { AIClient } = await import('../../core/ai/ai-client.js');
  const originalComplete = AIClient.complete;
  AIClient.complete = complete;
  try {
    await import(`../../service-worker.js?nl-command=${++workerImportNonce}`);
  } catch (error) {
    AIClient.complete = originalComplete;
    throw error;
  }
  return {
    harness,
    restore() {
      AIClient.complete = originalComplete;
    },
  };
}

describe('executeNLAction live-tab authority', () => {
  const liveTab = {
    id: 11,
    windowId: 1,
    active: true,
    url: 'https://github.com/approved',
    title: 'Approved',
  };
  const injectedTab = {
    id: 12,
    windowId: 1,
    active: false,
    url: 'https://safe.test/not-approved',
    title: 'Not approved',
  };

  function installActionTabs() {
    return installChromeMock({
      windows: [{ id: 1, focused: true }],
      tabs: [liveTab, injectedTab],
    });
  }

  test('ignores injected parsed tabIds for close, group, move, and focus actions', async () => {
    let harness = installActionTabs();
    await executeNLAction({ action: 'close', tabIds: [12] }, [liveTab]);
    expect(harness.calls.tabs.remove).toEqual([[[11]]]);
    expect(harness.snapshot().tabs).toContainEqual(expect.objectContaining({ id: 12 }));

    harness = installActionTabs();
    await executeNLAction({ action: 'group', tabIds: [12], groupName: 'Approved' }, [liveTab]);
    expect(harness.calls.tabs.group[0][0].tabIds).toEqual([11]);

    harness = installActionTabs();
    await executeNLAction({ action: 'move', tabIds: [12] }, [liveTab]);
    expect(harness.calls.windows.create).toEqual([[{ tabId: 11 }]]);

    harness = installActionTabs();
    await executeNLAction({ action: 'focus', tabIds: [12] }, [liveTab]);
    expect(harness.calls.tabs.get).toEqual([[11]]);
  });
});

describe('filterTabs domain identity', () => {
  test('matches an exact host and true subdomains only', () => {
    const tabs = [
      { id: 1, url: 'https://github.com/openai/codex', title: 'Exact' },
      { id: 2, url: 'https://docs.github.com/en', title: 'Subdomain' },
      { id: 3, url: 'https://notgithub.com/', title: 'Suffix lookalike' },
      { id: 4, url: 'https://github.com.evil.test/', title: 'Sibling lookalike' },
    ];

    expect(ids(filterTabs(tabs, { domain: 'github.com' }))).toEqual([1, 2]);
  });

  test('compares uppercase filter and tab hosts case-insensitively', () => {
    const tabs = [
      { id: 1, url: 'https://GITHUB.COM/one', title: 'One' },
      { id: 2, url: 'https://Docs.GitHub.Com/two', title: 'Two' },
    ];

    expect(ids(filterTabs(tabs, { domain: 'GITHUB.COM' }))).toEqual([1, 2]);
  });

  test('accepts one trailing dot on either host', () => {
    const tabs = [
      { id: 1, url: 'https://github.com./one', title: 'Tab dot' },
      { id: 2, url: 'https://docs.github.com/two', title: 'Filter dot' },
    ];

    expect(ids(filterTabs([tabs[0]], { domain: 'github.com' }))).toEqual([1]);
    expect(ids(filterTabs([tabs[1]], { domain: 'github.com.' }))).toEqual([2]);
  });

  test('fails closed for malformed committed URLs', () => {
    const tabs = [{
      id: 1,
      url: 'not a valid URL',
      pendingUrl: 'https://github.com/pending-must-not-replace-a-committed-url',
      title: 'Malformed',
    }];

    expect(filterTabs(tabs, { domain: 'github.com' })).toEqual([]);
  });

  test('uses pendingUrl only when there is no committed URL', () => {
    const tabs = [
      { id: 1, pendingUrl: 'https://github.com/pending', title: 'Missing URL' },
      { id: 2, url: '', pendingUrl: 'https://docs.github.com/pending', title: 'Empty URL' },
    ];

    expect(ids(filterTabs(tabs, { domain: 'github.com' }))).toEqual([1, 2]);
  });

  test('skips host filtering only when the domain property is absent', () => {
    const tabs = [
      { id: 1, url: 'https://one.test/path', title: 'Release Notes' },
      { id: 2, url: 'https://two.test/path', title: 'Other' },
    ];

    expect(ids(filterTabs(tabs, { titleContains: 'release' }))).toEqual([1]);
  });

  test('fails closed without throwing for present non-string domain values', () => {
    const tabs = [{ id: 1, url: 'https://github.com/', title: 'GitHub' }];

    for (const domain of [undefined, 42, {}, []]) {
      expect(() => filterTabs(tabs, { domain })).not.toThrow();
      expect(filterTabs(tabs, { domain })).toEqual([]);
    }
  });

  test('fails closed for present empty domain values', () => {
    const tabs = [{ id: 1, url: 'https://github.com/', title: 'GitHub' }];

    for (const domain of ['', '   ', null]) {
      expect(filterTabs(tabs, { domain })).toEqual([]);
    }
  });

  test('preserves AND semantics across domain, title, and URL text', () => {
    const tabs = [
      { id: 1, url: 'https://docs.github.com/codex/guide', title: 'Codex Guide' },
      { id: 2, url: 'https://docs.github.com/other', title: 'Codex Guide' },
      { id: 3, url: 'https://docs.github.com/codex/guide', title: 'Other Guide' },
      { id: 4, url: 'https://docs.notgithub.com/codex/guide', title: 'Codex Guide' },
    ];

    expect(ids(filterTabs(tabs, {
      domain: 'github.com',
      titleContains: 'codex',
      urlContains: '/codex/',
    }))).toEqual([1]);
  });

  test('fails closed for non-plain filters and filters with no recognized predicate', () => {
    const tabs = [{ id: 1, url: 'https://github.com/', title: 'GitHub' }];

    for (const filter of ['domain', [{ domain: 'github.com' }], { bogus: 1 }]) {
      expect(() => filterTabs(tabs, filter)).not.toThrow();
      expect(filterTabs(tabs, filter)).toEqual([]);
    }
  });

  test('rejects whitespace-only title and URL predicates', () => {
    const tabs = [{ id: 1, url: 'https://github.com/', title: 'Git Hub' }];

    expect(isValidTabFilter({ titleContains: '   ' })).toBe(false);
    expect(isValidTabFilter({ urlContains: '\t' })).toBe(false);
    expect(filterTabs(tabs, { titleContains: ' ' })).toEqual([]);
  });

  test('exports canonical host helpers with exact and subdomain semantics', async () => {
    const { canonicalHostname, hostnameMatches } = await import('../../core/url-match.js');

    expect(canonicalHostname(' HTTPS://GitHub.COM./path ')).toBe('github.com');
    expect(canonicalHostname('   ')).toBeNull();
    expect(canonicalHostname(null)).toBeNull();
    expect(hostnameMatches('https://docs.github.com/path', 'github.com')).toBe(true);
    expect(hostnameMatches('https://notgithub.com/path', 'github.com')).toBe(false);
    expect(hostnameMatches('not a URL', 'github.com')).toBe(false);
  });
});

describe('natural-language destructive command authority', () => {
  test('re-queries live tabs after delayed AI parsing before showing a close preview', async () => {
    const gate = deferred();
    let completeCalls = 0;
    const context = await importWorkerWithAi([
      { id: 11, windowId: 1, active: true, url: 'https://github.com/original', title: 'Original' },
    ], async () => {
      completeCalls++;
      return gate.promise;
    });

    try {
      const previewPromise = chrome.runtime.sendMessage({
        action: 'executeNLCommand',
        command: 'close GitHub tabs',
      });
      await waitFor(() => completeCalls === 1, 'NL command did not reach deferred AI parsing');
      await chrome.tabs.update(11, { url: 'https://safe.test/navigated-away' });
      gate.resolve({
        parsed: {
          action: 'close',
          filter: { domain: 'github.com' },
          confirmation: 'Close GitHub tabs?',
        },
      });

      expect(await previewPromise).toEqual({ error: 'No tabs matched that description' });
      expect(context.harness.calls.tabs.remove).toEqual([]);
    } finally {
      gate.resolve({ parsed: { action: 'close', filter: { domain: 'github.com' } } });
      context.restore();
    }
  });

  test('revalidates the original filter at confirmation and closes no navigated-away tab', async () => {
    const context = await importWorkerWithAi([
      { id: 11, windowId: 1, active: true, url: 'https://github.com/original', title: 'Original' },
    ], async () => ({
      parsed: {
        action: 'close',
        filter: { domain: 'github.com' },
        confirmation: 'Close GitHub tabs?',
      },
    }));

    try {
      const preview = await chrome.runtime.sendMessage({
        action: 'executeNLCommand',
        command: 'close GitHub tabs',
      });
      expect(preview.parsedCommand.tabIds).toEqual([11]);

      await chrome.tabs.update(11, { url: 'https://safe.test/navigated-away' });
      expect(await chrome.runtime.sendMessage({
        action: 'confirmNLCommand',
        parsedCommand: preview.parsedCommand,
      })).toEqual({ error: 'No tabs matched that description' });
      expect(context.harness.calls.tabs.remove).toEqual([]);
      expect(context.harness.snapshot().tabs).toContainEqual(
        expect.objectContaining({ id: 11, url: 'https://safe.test/navigated-away' }),
      );
    } finally {
      context.restore();
    }
  });

  test('does not close a matching committed URL that has a pending navigation out of scope', async () => {
    const context = await importWorkerWithAi([
      { id: 11, windowId: 1, active: true, url: 'https://github.com/original', title: 'Original' },
    ], async () => ({
      parsed: {
        action: 'close',
        filter: { domain: 'github.com' },
        confirmation: 'Close GitHub tabs?',
      },
    }));

    try {
      const preview = await chrome.runtime.sendMessage({
        action: 'executeNLCommand',
        command: 'close GitHub tabs',
      });
      expect(preview.parsedCommand.tabIds).toEqual([11]);

      await chrome.tabs.update(11, { pendingUrl: 'https://safe.test/navigation-in-flight' });
      expect(await chrome.runtime.sendMessage({
        action: 'confirmNLCommand',
        parsedCommand: preview.parsedCommand,
      })).toEqual({ error: 'No tabs matched that description' });
      expect(context.harness.calls.tabs.remove).toEqual([]);
      expect(context.harness.snapshot().tabs).toContainEqual(expect.objectContaining({
        id: 11,
        url: 'https://github.com/original',
        pendingUrl: 'https://safe.test/navigation-in-flight',
      }));
    } finally {
      context.restore();
    }
  });

  test('does not close a pending destination using the stale committed-page title', async () => {
    const context = await importWorkerWithAi([
      {
        id: 11,
        windowId: 1,
        active: true,
        url: 'https://releases.test/notes',
        title: 'Release notes',
      },
    ], async () => ({
      parsed: {
        action: 'close',
        filter: { titleContains: 'release' },
        confirmation: 'Close release tabs?',
      },
    }));

    try {
      const preview = await chrome.runtime.sendMessage({
        action: 'executeNLCommand',
        command: 'close release tabs',
      });
      expect(preview.parsedCommand.tabIds).toEqual([11]);

      await chrome.tabs.update(11, { pendingUrl: 'https://safe.test/navigation-in-flight' });
      expect(await chrome.runtime.sendMessage({
        action: 'confirmNLCommand',
        parsedCommand: preview.parsedCommand,
      })).toEqual({ error: 'No tabs matched that description' });
      expect(context.harness.calls.tabs.remove).toEqual([]);
      expect(context.harness.snapshot().tabs).toContainEqual(expect.objectContaining({
        id: 11,
        title: 'Release notes',
        pendingUrl: 'https://safe.test/navigation-in-flight',
      }));
    } finally {
      context.restore();
    }
  });

  test('confirmation intersects live matches with preview-approved IDs and never expands', async () => {
    const context = await importWorkerWithAi([
      { id: 11, windowId: 1, active: true, url: 'https://github.com/approved', title: 'Approved' },
      { id: 12, windowId: 1, active: false, url: 'https://safe.test/not-approved', title: 'Safe' },
    ], async () => ({
      parsed: {
        action: 'close',
        filter: { domain: 'github.com' },
        confirmation: 'Close GitHub tabs?',
      },
    }));

    try {
      const preview = await chrome.runtime.sendMessage({
        action: 'executeNLCommand',
        command: 'close GitHub tabs',
      });
      expect(preview.parsedCommand.tabIds).toEqual([11]);
      await chrome.tabs.update(12, { url: 'https://docs.github.com/new-live-match' });

      expect(await chrome.runtime.sendMessage({
        action: 'confirmNLCommand',
        parsedCommand: preview.parsedCommand,
      })).toEqual({ executed: true, message: 'Closed 1 tab(s)' });
      expect(context.harness.calls.tabs.remove).toEqual([[[11]]]);
      expect(context.harness.snapshot().tabs).toContainEqual(
        expect.objectContaining({ id: 12, url: 'https://docs.github.com/new-live-match' }),
      );
    } finally {
      context.restore();
    }
  });

  test('confirmation rejects a command without a recognized filter and closes nothing', async () => {
    const context = await importWorkerWithAi([
      { id: 11, windowId: 1, active: true, url: 'https://github.com/', title: 'GitHub' },
    ], async () => {
      throw new Error('AI should not be called by confirmation');
    });

    try {
      expect(await chrome.runtime.sendMessage({
        action: 'confirmNLCommand',
        parsedCommand: {
          action: 'close',
          filter: { bogus: 1 },
          tabIds: [11],
        },
      })).toEqual({ error: 'Invalid command confirmation' });
      expect(context.harness.calls.tabs.remove).toEqual([]);
    } finally {
      context.restore();
    }
  });
});
