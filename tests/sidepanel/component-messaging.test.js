import { describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';

const COMPONENTS = [
  ['AISettings', '../../sidepanel/components/ai-settings.js'],
  ['CommandBar', '../../sidepanel/components/command-bar.js'],
  ['DriveSync', '../../sidepanel/components/drive-sync.js'],
  ['DuplicateFinder', '../../sidepanel/components/duplicate-finder.js'],
  ['FocusPanel', '../../sidepanel/components/focus-panel.js'],
  ['GroupEditor', '../../sidepanel/components/group-editor.js'],
  ['SessionManager', '../../sidepanel/components/session-manager.js'],
  ['SettingsManager', '../../sidepanel/components/settings-manager.js'],
  ['StashList', '../../sidepanel/components/stash-list.js'],
  ['TabList', '../../sidepanel/components/tab-list.js'],
  ['WindowList', '../../sidepanel/components/window-list.js'],
];

const AUDITED_SIDE_PANEL_FILES = [
  'sidepanel/components/actionable-empty-state.js',
  'sidepanel/components/ai-settings.js',
  'sidepanel/components/command-bar.js',
  'sidepanel/components/confirm-dialog.js',
  'sidepanel/components/drive-sync.js',
  'sidepanel/components/duplicate-finder.js',
  'sidepanel/components/first-run-walkthrough.js',
  'sidepanel/components/focus-panel.js',
  'sidepanel/components/global-search.js',
  'sidepanel/components/group-editor.js',
  'sidepanel/components/session-manager.js',
  'sidepanel/components/settings-manager.js',
  'sidepanel/components/smart-group-fallback.js',
  'sidepanel/components/stash-list.js',
  'sidepanel/components/tab-list.js',
  'sidepanel/components/toast.js',
  'sidepanel/components/window-list.js',
  'sidepanel/panel.js',
];

async function importComponentsWithoutDocument() {
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const previousDocument = globalThis.document;
  delete globalThis.document;

  try {
    return await Promise.all(COMPONENTS.map(async ([name, path]) => {
      const module = await import(path);
      return [name, module[name]];
    }));
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  }
}

async function read(relativePath) {
  return Bun.file(new URL(`../../${relativePath}`, import.meta.url)).text();
}

function installToastDocument() {
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const previousDocument = globalThis.document;
  const toasts = [];
  const createElement = () => {
    const element = {
      children: [],
      style: {},
      className: '',
      textContent: '',
      listeners: {},
      appendChild(child) { this.children.push(child); },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      remove() {},
    };
    Object.defineProperty(element, 'innerHTML', {
      get() { return this._innerHTML || ''; },
      set(value) {
        this._innerHTML = value;
        this.children = [];
      },
    });
    return element;
  };
  const container = createElement();
  container.appendChild = (toast) => {
    const captured = {
      type: toast.className.replace(/^toast\s+/, ''),
      message: toast.children[0]?.textContent,
    };
    const actionButton = toast.children.find((child) => child.className === 'toast-action');
    if (actionButton) {
      captured.action = {
        label: actionButton.textContent,
        click: actionButton.listeners.click,
      };
    }
    toasts.push(captured);
  };
  globalThis.document = {
    createElement,
    getElementById: (id) => id === 'toast-container' ? container : null,
  };
  return {
    createElement,
    toasts,
    restore() {
      if (hadDocument) globalThis.document = previousDocument;
      else delete globalThis.document;
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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

const REQUEST_PATTERN = /\b(?:this\.send|sendOrThrow|Storage\.(?:get|set|remove)|chrome\.storage\.(?:local|sync|session)\.[A-Za-z]+|chrome\.(?:tabs|windows|tabGroups|bookmarks|downloads|identity)\.[A-Za-z]+)\s*\(/g;

function findUnsafeRequestSites(relativePath, source) {
  const unsafe = [];
  for (const match of source.matchAll(REQUEST_PATTERN)) {
    const before = source.slice(0, match.index);
    const linePrefix = before.slice(before.lastIndexOf('\n') + 1);
    const direct = /(?:await|return)\s*$/.test(linePrefix);
    const knownReturnedCallback = relativePath === 'sidepanel/panel.js' &&
      match[0].startsWith('sendOrThrow') &&
      /loadFocusState\s*:\s*\(\)\s*=>\s*$/.test(linePrefix);
    const promiseAllStart = before.lastIndexOf('await Promise.all(');
    const promiseAllOpen = promiseAllStart >= 0 && (() => {
      let depth = 0;
      const openingParen = source.indexOf('(', promiseAllStart);
      for (let index = openingParen; index < match.index; index += 1) {
        if (source[index] === '(') depth += 1;
        else if (source[index] === ')') depth -= 1;
      }
      return depth > 0;
    })();
    const statementEnd = source.indexOf(';', match.index);
    const explicitlyCaught = source.slice(match.index, statementEnd < 0 ? source.length : statementEnd)
      .includes('.catch(');
    if (!direct && !knownReturnedCallback && !promiseAllOpen && !explicitlyCaught) {
      unsafe.push(`${relativePath}:${source.slice(0, match.index).split('\n').length}`);
    }
  }
  return unsafe;
}

describe('checked component messaging boundary', () => {
  test('all request/response component modules import without touching the DOM', async () => {
    const classes = await importComponentsWithoutDocument();

    expect(classes.map(([name]) => name)).toEqual(COMPONENTS.map(([name]) => name));
    for (const [, Component] of classes) expect(Component).toBeFunction();
  });

  test('every prototype adapter rejects background errors and preserves successful values', async () => {
    const classes = await importComponentsWithoutDocument();
    const message = { action: 'checkedAction' };

    for (const [name, Component] of classes) {
      installChromeMock({ runtimeHandler: () => ({ error: `${name} failed` }) });
      await expect(Component.prototype.send.call({}, message))
        .rejects.toEqual(new Error(`${name} failed`));

      const successful = { component: name };
      installChromeMock();
      chrome.runtime.sendMessage = async () => successful;
      await expect(Component.prototype.send.call({}, message)).resolves.toBe(successful);

      installChromeMock({ runtimeHandler: () => null });
      await expect(Component.prototype.send.call({}, message)).resolves.toBeNull();
    }
  });

  test('raw runtime requests remain only in the one helper', async () => {
    const matches = [];
    const glob = new Bun.Glob('sidepanel/**/*.js');

    for await (const relativePath of glob.scan({ cwd: new URL('../..', import.meta.url).pathname })) {
      const text = await read(relativePath);
      if (text.includes('chrome.runtime.sendMessage')) matches.push(relativePath);
    }

    expect(matches.sort()).toEqual(['sidepanel/message-client.js']);
  });

  test('focus actions and Task 10 portable controls handle checked promises before effects', async () => {
    for (const relativePath of [
      'sidepanel/components/command-bar.js',
      'sidepanel/components/group-editor.js',
      'sidepanel/components/tab-list.js',
      'sidepanel/components/window-list.js',
    ]) {
      const text = await read(relativePath);
      expect(text).not.toMatch(/(?<!await )this\.send\(\{ action: 'focusTab'[^;]*\);/s);
    }

    const panel = await read('sidepanel/panel.js');
    expect(panel).toContain("sendOrThrow({ action: 'getFocusState' })");
    expect(panel).not.toContain('chrome.runtime.sendMessage');

    for (const relativePath of [
      'sidepanel/components/session-manager.js',
      'sidepanel/components/settings-manager.js',
      'sidepanel/components/stash-list.js',
    ]) {
      const text = await read(relativePath);
      expect(text).toMatch(/const result = await this\.send\(\{ action: 'importPortableData',[\s\S]*?formatPortableImportSummary\(result/);
      expect(text).toMatch(/finally\s*{[^}]*target\.value\s*=\s*''/s);
    }
  });

  test('a rejected Focus preference save leaves the committed preference cache unchanged', async () => {
    const classes = await importComponentsWithoutDocument();
    const FocusPanel = classes.find(([name]) => name === 'FocusPanel')[1];
    const committed = { coding: { strictMode: false } };
    const panel = Object.create(FocusPanel.prototype);
    panel._profilePrefs = committed;
    panel._allowlist = [];
    panel._blockedCategories = [];
    panel._blockedDomains = [];
    panel._strictMode = true;
    panel._aiBlocking = false;
    panel.container = {
      querySelector(selector) {
        if (selector === '#focus-duration') return { value: '25' };
        if (selector === 'input[name="focus-action"]:checked') return { value: 'none' };
        return null;
      },
    };
    installChromeMock({
      runtimeHandler: async () => ({ error: 'preferences rejected' }),
    });

    await expect(panel._saveProfilePrefs('coding')).rejects.toThrow('preferences rejected');
    expect(panel._profilePrefs).toBe(committed);
    expect(panel._profilePrefs).toEqual({ coding: { strictMode: false } });
  });

  test('component families keep success effects behind checked resolution and handled refreshes', async () => {
    const sources = Object.fromEntries(await Promise.all([
      'ai-settings',
      'command-bar',
      'drive-sync',
      'duplicate-finder',
      'focus-panel',
      'group-editor',
      'session-manager',
      'settings-manager',
      'stash-list',
      'tab-list',
      'window-list',
    ].map(async (name) => [name, await read(`sidepanel/components/${name}.js`)])));

    expect(sources['ai-settings']).toMatch(/await this\.send\(\{ action: 'clearAICache' \}\);[\s\S]*?AI cache cleared/);
    expect(sources['command-bar']).toContain('Execution failed: ');
    expect(sources['drive-sync']).not.toContain('sendMessage');
    expect(sources['drive-sync']).not.toContain('this.send =');
    expect(sources['duplicate-finder']).toContain('Duplicates were closed, but the view could not refresh: ');
    expect(sources['focus-panel']).toContain('this._profilePrefs = { ...this._profilePrefs, [profileId]: prefs };');
    expect(sources['group-editor']).toContain('Kebab All incomplete');
    expect(sources['session-manager']).toMatch(/const result = await this\.send\(\{ action: 'importPortableData',[\s\S]*?const refreshed = await this\.refresh[\s\S]*?formatPortableImportSummary\(result/);
    expect(sources['settings-manager']).toMatch(/const result = await this\.send\(\{ action: 'importPortableData',[\s\S]*?const refreshed = await this\.refresh[\s\S]*?formatPortableImportSummary\(result/);
    expect(sources['stash-list']).toMatch(/const result = await this\.send\(\{ action: 'importPortableData',[\s\S]*?const refreshed = await this\.refresh[\s\S]*?formatPortableImportSummary\(result/);
    expect(sources['tab-list']).toContain('refreshCommittedState(committedMessage)');
    expect(sources['window-list']).toContain('refreshCommittedState(committedMessage)');
  });

  test('Settings and Drive instances cannot shadow the exact prototype adapter', async () => {
    const classes = await importComponentsWithoutDocument();
    const SettingsManager = classes.find(([name]) => name === 'SettingsManager')[1];
    const DriveSync = classes.find(([name]) => name === 'DriveSync')[1];
    const listener = { addEventListener() {} };
    const settingsRoot = {
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const driveElements = {
      '#drive-status': { classList: { add() {}, remove() {} } },
      '#btn-connect-drive': listener,
      '#btn-sync-now': { ...listener, disabled: false, textContent: 'Sync Now' },
      '#btn-disconnect-drive': listener,
      '#btn-undo-drive-settings': null,
    };
    const driveRoot = { querySelector: (selector) => driveElements[selector] ?? null };

    const settings = new SettingsManager(settingsRoot, {
      confirm: async () => true,
      notify() {},
    });
    const drive = new DriveSync(driveRoot, {
      confirm: async () => true,
      notify() {},
    });

    expect(Object.hasOwn(settings, 'send')).toBeFalse();
    expect(Object.hasOwn(drive, 'send')).toBeFalse();
    expect(Object.hasOwn(drive, 'sendMessage')).toBeFalse();
    expect(SettingsManager.prototype.send.toString().replace(/\s+/g, ''))
      .toBe('send(msg){returnsendOrThrow(msg);}');
    expect(DriveSync.prototype.send.toString().replace(/\s+/g, ''))
      .toBe('send(msg){returnsendOrThrow(msg);}');
  });

  test('incomplete stash restore retains exact recovery feedback when projection refresh fails', async () => {
    const classes = await importComponentsWithoutDocument();
    const StashList = classes.find(([name]) => name === 'StashList')[1];
    const dom = installToastDocument();
    try {
      installChromeMock({
        runtimeHandler: async ({ action }) => {
          if (action === 'restoreStash') {
            return {
              requestedCount: 5,
              restoredCount: 2,
              skippedDuplicate: 1,
              skippedInvalid: 1,
              errors: [{ scope: 'create', message: 'private failure' }],
              complete: false,
            };
          }
          if (action === 'listStashes') return { error: 'projection failed' };
          throw new Error(`Unexpected action: ${action}`);
        },
      });
      const manager = Object.create(StashList.prototype);
      manager.root = {};

      await manager.restoreStash('stash-current', { mode: 'windows' });

      expect(dom.toasts).toEqual([{
        type: 'error',
        message: 'Restored 2 of 5 tabs \u2014 1 duplicate skipped \u2014 1 invalid \u2014 1 failed. Stash kept for recovery. View could not refresh: projection failed.',
      }]);
      expect(dom.toasts[0].message).not.toContain('Stash was restored');
    } finally {
      dom.restore();
    }
  });

  test('WindowList safely owns a rejected Bring to Front operation', async () => {
    const classes = await importComponentsWithoutDocument();
    const WindowList = classes.find(([name]) => name === 'WindowList')[1];
    expect(WindowList.prototype.bringWindowToFront).toBeFunction();
    const dom = installToastDocument();
    try {
      const harness = installChromeMock({
        windows: [{ id: 44, focused: false }],
        failures: { 'windows.update': new Error('private window detail') },
      });
      const manager = Object.create(WindowList.prototype);

      await expect(manager.bringWindowToFront(44)).resolves.toBeFalse();

      expect(harness.calls.windows.update).toEqual([[44, { focused: true }]]);
      expect(dom.toasts).toEqual([{
        type: 'error',
        message: 'Could not bring window to front — try again.',
      }]);
      expect(dom.toasts[0].message).not.toContain('private window detail');
    } finally {
      dom.restore();
    }
  });

  test('DuplicateFinder keeps checked Undo after committed close when its scan fails', async () => {
    const classes = await importComponentsWithoutDocument();
    const DuplicateFinder = classes.find(([name]) => name === 'DuplicateFinder')[1];
    const dom = installToastDocument();
    const calls = [];
    try {
      installChromeMock({
        runtimeHandler: async (message) => {
          calls.push(message);
          if (message.action === 'closeTabs') return { success: true };
          if (message.action === 'findDuplicates') return { error: 'scan projection failed' };
          if (message.action === 'findEmptyPages') return [];
          if (message.action === 'reopenTabs') return { error: 'reopen rejected' };
          throw new Error(`Unexpected action: ${message.action}`);
        },
      });
      const finder = Object.create(DuplicateFinder.prototype);
      finder.listEl = {
        querySelectorAll: () => [{ dataset: { tabId: '2' } }],
      };
      finder.duplicates = [{
        url: 'https://duplicate.test/',
        tabs: [
          { id: 1, url: 'https://duplicate.test/' },
          { id: 2, url: 'https://duplicate.test/' },
        ],
      }];

      await finder.closeAllDuplicates();

      expect(dom.toasts[0]).toMatchObject({
        type: 'error',
        message: 'Duplicates were closed, but the view could not refresh: scan projection failed',
        action: { label: 'Undo' },
      });
      expect(dom.toasts[0].action.click).toBeFunction();
      dom.toasts[0].action.click();
      await flushMicrotasks();

      expect(calls).toContainEqual({
        action: 'reopenTabs',
        urls: ['https://duplicate.test/'],
      });
      expect(dom.toasts.at(-1)).toEqual({
        type: 'error',
        message: 'Undo failed: reopen rejected',
      });
    } finally {
      dom.restore();
    }
  });

  test('AISettings adds an existing keep-awake domain with one idempotent checked request', async () => {
    const classes = await importComponentsWithoutDocument();
    const AISettings = classes.find(([name]) => name === 'AISettings')[1];
    const dom = installToastDocument();
    const input = { value: ' Example.Test ' };
    let refreshes = 0;
    try {
      const harness = installChromeMock({ runtimeHandler: async () => ({ success: true }) });
      const manager = Object.create(AISettings.prototype);
      manager.root = { querySelector: () => input };
      manager.refreshKeepAwakeList = async () => {
        refreshes += 1;
        return null;
      };

      await manager.addKeepAwakeDomain();

      expect(harness.calls.runtime.sendMessage).toEqual([[
        { action: 'setKeepAwake', scope: 'domain', domain: 'example.test', keepAwake: true },
      ]]);
      expect(input.value).toBe('');
      expect(refreshes).toBe(1);
      expect(dom.toasts).toEqual([{ type: 'success', message: 'Added example.test' }]);
    } finally {
      dom.restore();
    }
  });

  test('AISettings rejected keep-awake add preserves input and renders no fake success', async () => {
    const classes = await importComponentsWithoutDocument();
    const AISettings = classes.find(([name]) => name === 'AISettings')[1];
    const dom = installToastDocument();
    const input = { value: 'existing.test' };
    let refreshes = 0;
    try {
      const harness = installChromeMock({
        runtimeHandler: async () => ({ error: 'domain mutation rejected' }),
      });
      const manager = Object.create(AISettings.prototype);
      manager.root = { querySelector: () => input };
      manager.refreshKeepAwakeList = async () => {
        refreshes += 1;
        return null;
      };

      await manager.addKeepAwakeDomain();

      expect(harness.calls.runtime.sendMessage).toEqual([[
        { action: 'setKeepAwake', scope: 'domain', domain: 'existing.test', keepAwake: true },
      ]]);
      expect(input.value).toBe('existing.test');
      expect(refreshes).toBe(0);
      expect(dom.toasts).toEqual([{
        type: 'error',
        message: 'Failed to add domain: domain mutation rejected',
      }]);
    } finally {
      dom.restore();
    }
  });

  test('CommandBar restores the exact confirmation controls after confirmed execution rejects', async () => {
    const classes = await importComponentsWithoutDocument();
    const CommandBar = classes.find(([name]) => name === 'CommandBar')[1];
    const dom = installToastDocument();
    try {
      installChromeMock({
        runtimeHandler: async () => ({ error: 'confirmed execution rejected' }),
      });
      const manager = Object.create(CommandBar.prototype);
      manager.pending = false;
      manager.inputEl = { value: 'close old tabs', disabled: false };
      manager.resultsEl = dom.createElement();
      const result = {
        confirmation: 'Close 3 old tabs?',
        parsedCommand: { action: 'close', filter: { title: 'old' } },
      };
      const snapshot = () => ({
        message: manager.resultsEl.children[0]?.textContent,
        buttons: manager.resultsEl.children[1]?.children.map(({ textContent }) => textContent),
      });

      manager.showConfirmation(result);
      const expected = snapshot();
      const confirmButton = manager.resultsEl.children[1].children[0];
      await confirmButton.listeners.click();

      expect(snapshot()).toEqual(expected);
      expect(expected).toEqual({
        message: 'Close 3 old tabs?',
        buttons: ['Confirm', 'Cancel'],
      });
      expect(manager.inputEl.value).toBe('close old tabs');
      expect(manager.pending).toBeFalse();
      expect(manager.inputEl.disabled).toBeFalse();
      expect(dom.toasts).toEqual([{
        type: 'error',
        message: 'Execution failed: confirmed execution rejected',
      }]);
    } finally {
      dom.restore();
    }
  });

  test.each(['success', 'failure'])(
    'CommandBar ignores stale confirmed-command %s after a newer confirmation renders',
    async (outcome) => {
      const classes = await importComponentsWithoutDocument();
      const CommandBar = classes.find(([name]) => name === 'CommandBar')[1];
      const dom = installToastDocument();
      const gate = deferred();
      try {
        installChromeMock();
        chrome.runtime.sendMessage = () => gate.promise;
        const manager = Object.create(CommandBar.prototype);
        manager.pending = false;
        manager.inputEl = { value: 'old command', disabled: false };
        manager.resultsEl = dom.createElement();
        const oldResult = {
          confirmation: 'Run old command?',
          parsedCommand: { action: 'old' },
        };
        const newResult = {
          confirmation: 'Run newer command?',
          parsedCommand: { action: 'new' },
        };
        const snapshot = () => ({
          message: manager.resultsEl.children[0]?.textContent,
          buttons: manager.resultsEl.children[1]?.children.map(({ textContent }) => textContent),
        });

        manager.showConfirmation(oldResult);
        const oldConfirm = manager.resultsEl.children[1].children[0];
        const oldExecution = oldConfirm.listeners.click();
        const busyState = {
          pending: manager.pending,
          inputDisabled: manager.inputEl.disabled,
          markup: manager.resultsEl.innerHTML,
        };

        manager.showConfirmation(newResult);
        const newerSnapshot = snapshot();
        if (outcome === 'success') gate.resolve({ message: 'Old command completed' });
        else gate.reject(new Error('old command rejected'));
        await oldExecution;

        expect(busyState).toEqual({
          pending: true,
          inputDisabled: true,
          markup: '<p class="loading-text">Executing...</p>',
        });
        expect(newerSnapshot).toEqual({
          message: 'Run newer command?',
          buttons: ['Confirm', 'Cancel'],
        });
        expect(snapshot()).toEqual(newerSnapshot);
        expect(manager.pending).toBeFalse();
        expect(manager.inputEl.disabled).toBeFalse();
        expect(manager.inputEl.value).toBe('old command');
        expect(dom.toasts).toEqual([]);
      } finally {
        dom.restore();
      }
    },
  );

  test('DriveSync owns a previous-settings storage rejection before confirmation', async () => {
    const classes = await importComponentsWithoutDocument();
    const DriveSync = classes.find(([name]) => name === 'DriveSync')[1];
    installChromeMock({
      failures: { 'storage.local.get': new Error('private storage detail') },
    });
    const notices = [];
    let confirmations = 0;
    const manager = Object.create(DriveSync.prototype);
    manager.confirm = async () => {
      confirmations += 1;
      return true;
    };
    manager.notify = (message, type) => notices.push({ message, type });

    await expect(manager.undoSettingsLoad()).resolves.toBeFalse();

    expect(confirmations).toBe(0);
    expect(notices).toEqual([{
      message: 'Settings restore failed — try again.',
      type: 'error',
    }]);
    expect(notices[0].message).not.toContain('private storage detail');
  });

  test('DriveSync owns a confirmation rejection without starting Undo', async () => {
    const classes = await importComponentsWithoutDocument();
    const DriveSync = classes.find(([name]) => name === 'DriveSync')[1];
    const harness = installChromeMock({
      local: { tabkebabSettingsPrevious: { theme: 'light' } },
    });
    const notices = [];
    const manager = Object.create(DriveSync.prototype);
    manager.confirm = async () => { throw new Error('private confirmation detail'); };
    manager.notify = (message, type) => notices.push({ message, type });

    await expect(manager.undoSettingsLoad()).resolves.toBeFalse();

    expect(harness.calls.runtime.sendMessage).toEqual([]);
    expect(notices).toEqual([{
      message: 'Settings restore failed — try again.',
      type: 'error',
    }]);
    expect(notices[0].message).not.toContain('private confirmation detail');
  });

  test('request scanner rejects concise event arrows but allows only the known returned callback', () => {
    expect(findUnsafeRequestSites(
      'sidepanel/components/example.js',
      "button.addEventListener('click', () => chrome.windows.update(7, { focused: true }));",
    )).toEqual(['sidepanel/components/example.js:1']);
    expect(findUnsafeRequestSites(
      'sidepanel/components/example.js',
      "button.addEventListener('click', () => Storage.get('driveSync'));",
    )).toEqual(['sidepanel/components/example.js:1']);
    expect(findUnsafeRequestSites(
      'sidepanel/components/example.js',
      "button.addEventListener('click', () => chrome.storage.local.get('driveSync'));",
    )).toEqual(['sidepanel/components/example.js:1']);
    expect(findUnsafeRequestSites(
      'sidepanel/panel.js',
      "  loadFocusState: () => sendOrThrow({ action: 'getFocusState' }),",
    )).toEqual([]);
  });

  test('every side-panel request site is awaited, returned, or owned by awaited Promise.all', async () => {
    const root = new URL('../..', import.meta.url).pathname;
    const inventory = ['sidepanel/panel.js'];
    const glob = new Bun.Glob('sidepanel/components/*.js');
    for await (const relativePath of glob.scan({ cwd: root })) {
      inventory.push(relativePath);
    }
    inventory.sort();
    expect(inventory).toEqual(AUDITED_SIDE_PANEL_FILES);

    const files = await Promise.all(inventory.map(async (relativePath) => [relativePath, await read(relativePath)]));
    const unsafe = files.flatMap(([relativePath, source]) => findUnsafeRequestSites(relativePath, source));

    expect(unsafe).toEqual([]);

    const groupSource = await read('sidepanel/components/group-editor.js');
    for (const method of [
      'discardChromeGroup',
      'stashChromeGroup',
      'ungroupChromeGroup',
      'closeChromeGroup',
      'setAllChromeGroupsCollapsed',
    ]) {
      expect(groupSource).toContain(`async ${method}(`);
    }
  });
});
