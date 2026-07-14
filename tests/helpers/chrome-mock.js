const eventListeners = new WeakMap();

let activeHarness = null;

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function cloneArgs(args) {
  return args.map((arg) => (typeof arg === 'function' ? arg : clone(arg)));
}

function clearEvent(event) {
  eventListeners.get(event)?.clear();
}

export function createChromeEvent() {
  const listeners = new Set();
  const event = {
    addListener(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Chrome event listeners must be functions');
      }
      listeners.add(listener);
    },

    removeListener(listener) {
      listeners.delete(listener);
    },

    hasListener(listener) {
      return listeners.has(listener);
    },

    async dispatch(...args) {
      return Promise.all([...listeners].map((listener) => listener(...args)));
    },
  };

  eventListeners.set(event, listeners);
  activeHarness?.events.add(event);
  return event;
}

export function createRuntimePortPair(name = 'test-port') {
  const clientOnMessage = createChromeEvent();
  const clientOnDisconnect = createChromeEvent();
  const workerOnMessage = createChromeEvent();
  const workerOnDisconnect = createChromeEvent();
  let disconnected = false;

  async function disconnectPair() {
    if (disconnected) return;
    disconnected = true;
    await Promise.all([
      clientOnDisconnect.dispatch(clientPort),
      workerOnDisconnect.dispatch(workerPort),
    ]);
  }

  function ensureConnected() {
    if (disconnected) {
      throw new Error(`Port "${name}" is disconnected`);
    }
  }

  const clientPort = {
    name,
    onMessage: clientOnMessage,
    onDisconnect: clientOnDisconnect,
    postMessage(message) {
      ensureConnected();
      return workerOnMessage.dispatch(clone(message), workerPort);
    },
    disconnect: disconnectPair,
  };

  const workerPort = {
    name,
    sender: {
      id: 'tabkebab-test-extension',
      url: 'chrome-extension://tabkebab-test-extension/sidepanel/panel.html',
    },
    onMessage: workerOnMessage,
    onDisconnect: workerOnDisconnect,
    postMessage(message) {
      ensureConnected();
      return clientOnMessage.dispatch(clone(message), clientPort);
    },
    disconnect: disconnectPair,
  };

  return { clientPort, workerPort };
}

function createCalls() {
  const methods = (names) => Object.fromEntries(names.map((name) => [name, []]));

  return {
    storage: {
      local: methods(['get', 'set', 'remove', 'clear', 'getBytesInUse', 'setAccessLevel']),
      session: methods(['get', 'set', 'remove', 'clear', 'getBytesInUse', 'setAccessLevel']),
    },
    runtime: methods(['sendMessage', 'connect']),
    tabs: methods([
      'query',
      'get',
      'create',
      'update',
      'remove',
      'discard',
      'move',
      'group',
      'ungroup',
      'goBack',
      'reload',
      'sendMessage',
    ]),
    windows: methods(['get', 'getAll', 'getCurrent', 'getLastFocused', 'create', 'update', 'remove']),
    tabGroups: methods(['get', 'query', 'update', 'move']),
    alarms: methods(['create', 'get', 'getAll', 'clear', 'clearAll']),
    action: methods([
      'setBadgeText',
      'getBadgeText',
      'setBadgeBackgroundColor',
      'getBadgeBackgroundColor',
      'setTitle',
      'getTitle',
      'setIcon',
      'enable',
      'disable',
    ]),
    sidePanel: methods(['open', 'setOptions', 'getOptions', 'setPanelBehavior']),
    bookmarks: methods([
      'get',
      'getTree',
      'getChildren',
      'create',
      'update',
      'move',
      'remove',
      'removeTree',
      'search',
    ]),
    identity: methods([
      'getAuthToken',
      'removeCachedAuthToken',
      'clearAllCachedAuthTokens',
      'launchWebAuthFlow',
      'getProfileUserInfo',
    ]),
  };
}

function makeFailureQueues(failures) {
  return new Map(
    Object.entries(failures).map(([path, configured]) => [
      path,
      Array.isArray(configured) ? [...configured] : [configured],
    ]),
  );
}

function makeEventSet(names) {
  return Object.fromEntries(names.map((name) => [name, createChromeEvent()]));
}

function nextId(items, minimum = 1) {
  return Math.max(minimum - 1, ...items.map(({ id }) => Number(id) || 0)) + 1;
}

function normalizeWindow(window, id) {
  return {
    id,
    focused: false,
    incognito: false,
    alwaysOnTop: false,
    type: 'normal',
    state: 'normal',
    ...clone(window),
    id,
  };
}

function normalizeTab(tab, id, windowId, index) {
  return {
    id,
    windowId,
    index,
    groupId: -1,
    active: false,
    highlighted: false,
    pinned: false,
    audible: false,
    discarded: false,
    autoDiscardable: true,
    status: 'complete',
    title: '',
    url: 'about:blank',
    mutedInfo: { muted: false },
    ...clone(tab),
    id,
    windowId,
    index,
  };
}

function normalizeGroup(group, id, windowId) {
  return {
    id,
    windowId,
    title: '',
    color: 'grey',
    collapsed: false,
    ...clone(group),
    id,
    windowId,
  };
}

function wildcardMatches(value, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

export function installChromeMock(overrides = {}) {
  resetChromeMock();

  const {
    local = {},
    session = {},
    tabs = [],
    windows = [],
    groups = [],
    failures = {},
    runtimeHandler = null,
  } = overrides;

  const hadChrome = Object.hasOwn(globalThis, 'chrome');
  const previousChrome = globalThis.chrome;
  const calls = createCalls();
  const failureQueues = makeFailureQueues(failures);
  const storageState = {
    local: clone(local),
    session: clone(session),
  };
  const state = {
    tabs: [],
    windows: [],
    groups: [],
    alarms: new Map(),
    bookmarks: [
      { id: '0', title: '', children: [{ id: '1', parentId: '0', title: 'Bookmarks bar', children: [] }] },
    ],
    action: {
      badgeText: '',
      badgeBackgroundColor: null,
      title: '',
      enabled: true,
    },
    sidePanel: {
      behavior: {},
      options: new Map(),
    },
    identity: {
      authToken: 'test-auth-token',
      profile: { email: '', id: '' },
    },
  };

  activeHarness = {
    calls,
    events: new Set(),
    hadChrome,
    previousChrome,
    state,
    storageState,
    runtimeHandler,
    connections: new Set(),
  };

  for (const seededWindow of windows) {
    const id = seededWindow.id ?? nextId(state.windows);
    state.windows.push(normalizeWindow(seededWindow, id));
  }

  for (const seededTab of tabs) {
    const windowId = seededTab.windowId ?? state.windows[0]?.id ?? 1;
    if (!state.windows.some(({ id }) => id === windowId)) {
      state.windows.push(normalizeWindow({}, windowId));
    }
    const siblingCount = state.tabs.filter((tab) => tab.windowId === windowId).length;
    const id = seededTab.id ?? nextId(state.tabs);
    state.tabs.push(normalizeTab(seededTab, id, windowId, seededTab.index ?? siblingCount));
  }

  for (const seededGroup of groups) {
    const windowId = seededGroup.windowId ?? state.windows[0]?.id ?? 1;
    if (!state.windows.some(({ id }) => id === windowId)) {
      state.windows.push(normalizeWindow({}, windowId));
    }
    const id = seededGroup.id ?? nextId(state.groups);
    state.groups.push(normalizeGroup(seededGroup, id, windowId));
  }

  function record(domain, method, args) {
    if (domain === 'storage') {
      const [operation, ...operationArgs] = args;
      calls.storage[method][operation].push(cloneArgs(operationArgs));
      return;
    }
    calls[domain][method].push(cloneArgs(args));
  }

  function failOnce(path, args) {
    const queue = failureQueues.get(path);
    if (!queue?.length) return;
    let failure = queue.shift();
    if (typeof failure === 'function') failure = failure(...args);
    if (failure == null || failure === false) return;
    throw failure instanceof Error ? failure : new Error(String(failure));
  }

  function reindexTabs(windowId) {
    state.tabs
      .filter((tab) => tab.windowId === windowId)
      .sort((left, right) => left.index - right.index)
      .forEach((tab, index) => {
        tab.index = index;
      });
  }

  function findTab(tabId) {
    const tab = state.tabs.find(({ id }) => id === tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return tab;
  }

  function findWindow(windowId) {
    const window = state.windows.find(({ id }) => id === windowId);
    if (!window) throw new Error(`No window with id: ${windowId}`);
    return window;
  }

  function findGroup(groupId) {
    const group = state.groups.find(({ id }) => id === groupId);
    if (!group) throw new Error(`No tab group with id: ${groupId}`);
    return group;
  }

  function populatedWindow(window, populate) {
    const result = clone(window);
    if (populate) {
      result.tabs = state.tabs
        .filter(({ windowId }) => windowId === window.id)
        .sort((left, right) => left.index - right.index)
        .map((tab) => clone(tab));
    }
    return result;
  }

  const storageOnChanged = createChromeEvent();

  function createStorageArea(areaName) {
    const area = storageState[areaName];

    function select(keys) {
      if (keys == null) return clone(area);

      if (typeof keys === 'string') {
        return Object.hasOwn(area, keys) ? { [keys]: clone(area[keys]) } : {};
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys.filter((key) => Object.hasOwn(area, key)).map((key) => [key, clone(area[key])]),
        );
      }

      if (typeof keys === 'object') {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            Object.hasOwn(area, key) ? clone(area[key]) : clone(fallback),
          ]),
        );
      }

      throw new TypeError('Storage keys must be null, a string, an array, or an object');
    }

    return {
      async get(keys = null) {
        record('storage', areaName, ['get', keys]);
        failOnce(`storage.${areaName}.get`, [keys]);
        return select(keys);
      },

      async set(items) {
        record('storage', areaName, ['set', items]);
        failOnce(`storage.${areaName}.set`, [items]);
        if (!items || typeof items !== 'object' || Array.isArray(items)) {
          throw new TypeError('Storage items must be an object');
        }

        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          const change = { newValue: clone(value) };
          if (Object.hasOwn(area, key)) change.oldValue = clone(area[key]);
          changes[key] = change;
          area[key] = clone(value);
        }

        if (Object.keys(changes).length) {
          await storageOnChanged.dispatch(changes, areaName);
        }
      },

      async remove(keys) {
        record('storage', areaName, ['remove', keys]);
        failOnce(`storage.${areaName}.remove`, [keys]);
        const requested = Array.isArray(keys) ? keys : [keys];
        const changes = {};
        for (const key of requested) {
          if (!Object.hasOwn(area, key)) continue;
          changes[key] = { oldValue: clone(area[key]) };
          delete area[key];
        }
        if (Object.keys(changes).length) {
          await storageOnChanged.dispatch(changes, areaName);
        }
      },

      async clear() {
        record('storage', areaName, ['clear']);
        failOnce(`storage.${areaName}.clear`, []);
        const changes = Object.fromEntries(
          Object.entries(area).map(([key, value]) => [key, { oldValue: clone(value) }]),
        );
        for (const key of Object.keys(area)) delete area[key];
        if (Object.keys(changes).length) {
          await storageOnChanged.dispatch(changes, areaName);
        }
      },

      async getBytesInUse(keys = null) {
        record('storage', areaName, ['getBytesInUse', keys]);
        failOnce(`storage.${areaName}.getBytesInUse`, [keys]);
        return new TextEncoder().encode(JSON.stringify(select(keys))).byteLength;
      },

      async setAccessLevel(accessOptions) {
        record('storage', areaName, ['setAccessLevel', accessOptions]);
        failOnce(`storage.${areaName}.setAccessLevel`, [accessOptions]);
      },
    };
  }

  const runtimeEvents = makeEventSet([
    'onMessage',
    'onConnect',
    'onStartup',
    'onInstalled',
    'onSuspend',
    'onUpdateAvailable',
  ]);
  const tabsEvents = makeEventSet([
    'onActivated',
    'onAttached',
    'onCreated',
    'onDetached',
    'onHighlighted',
    'onMoved',
    'onRemoved',
    'onReplaced',
    'onUpdated',
    'onZoomChange',
  ]);
  const windowsEvents = makeEventSet(['onCreated', 'onFocusChanged', 'onRemoved']);
  const tabGroupsEvents = makeEventSet(['onCreated', 'onMoved', 'onRemoved', 'onUpdated']);
  const alarmsOnAlarm = createChromeEvent();
  const actionOnClicked = createChromeEvent();
  const bookmarksEvents = makeEventSet([
    'onChanged',
    'onChildrenReordered',
    'onCreated',
    'onImportBegan',
    'onImportEnded',
    'onMoved',
    'onRemoved',
  ]);

  const runtime = {
    id: 'tabkebab-test-extension',
    lastError: undefined,
    ...runtimeEvents,

    getManifest() {
      return { manifest_version: 3, name: 'TabKebab Test', version: '0.0.0' };
    },

    getURL(path = '') {
      return `chrome-extension://tabkebab-test-extension/${path.replace(/^\//, '')}`;
    },

    async sendMessage(...args) {
      record('runtime', 'sendMessage', args);
      failOnce('runtime.sendMessage', args);
      const message = args.length > 1 && typeof args[0] === 'string' ? args[1] : args[0];
      if (activeHarness.runtimeHandler) {
        return activeHarness.runtimeHandler(message, {
          id: runtime.id,
          url: runtime.getURL('sidepanel/panel.html'),
        });
      }

      let response;
      let responseWasSent = false;
      let resolveResponse;
      const responsePromise = new Promise((resolve) => {
        resolveResponse = resolve;
      });
      const results = await runtime.onMessage.dispatch(
        clone(message),
        { id: runtime.id, url: runtime.getURL('sidepanel/panel.html') },
        (value) => {
          if (responseWasSent) return;
          responseWasSent = true;
          response = value;
          resolveResponse();
        },
      );
      if (responseWasSent) return clone(response);
      const returned = results.find((value) => value !== undefined && value !== true);
      if (returned !== undefined) return clone(returned);
      if (results.includes(true)) {
        await responsePromise;
        return clone(response);
      }
      return undefined;
    },

    connect(...args) {
      record('runtime', 'connect', args);
      failOnce('runtime.connect', args);
      const connectInfo =
        args.length > 1 && typeof args[0] === 'string' ? args[1] : args[0] ?? {};
      const pair = createRuntimePortPair(connectInfo.name ?? '');
      activeHarness.connections.add(pair);
      void runtime.onConnect.dispatch(pair.workerPort);
      return pair.clientPort;
    },
  };

  const tabsApi = {
    ...tabsEvents,
    TAB_ID_NONE: -1,

    async query(queryInfo = {}) {
      record('tabs', 'query', [queryInfo]);
      failOnce('tabs.query', [queryInfo]);
      let result = [...state.tabs];
      const focusedWindowId = state.windows.find(({ focused }) => focused)?.id;

      for (const key of [
        'active',
        'audible',
        'autoDiscardable',
        'discarded',
        'groupId',
        'highlighted',
        'pinned',
        'status',
        'windowId',
      ]) {
        if (queryInfo[key] !== undefined) {
          result = result.filter((tab) => tab[key] === queryInfo[key]);
        }
      }

      if (queryInfo.currentWindow || queryInfo.lastFocusedWindow) {
        result = result.filter(({ windowId }) => windowId === focusedWindowId);
      }

      if (queryInfo.url !== undefined) {
        const patterns = Array.isArray(queryInfo.url) ? queryInfo.url : [queryInfo.url];
        result = result.filter((tab) => patterns.some((pattern) => wildcardMatches(tab.url, pattern)));
      }

      return result
        .sort((left, right) => left.windowId - right.windowId || left.index - right.index)
        .map((tab) => clone(tab));
    },

    async get(tabId) {
      record('tabs', 'get', [tabId]);
      failOnce('tabs.get', [tabId]);
      return clone(findTab(tabId));
    },

    async create(createProperties = {}) {
      record('tabs', 'create', [createProperties]);
      failOnce('tabs.create', [createProperties]);
      let windowId = createProperties.windowId;
      if (windowId === undefined) {
        windowId = state.windows.find(({ focused }) => focused)?.id ?? state.windows[0]?.id;
      }
      if (windowId === undefined) {
        windowId = nextId(state.windows);
        state.windows.push(normalizeWindow({ focused: true }, windowId));
      } else {
        findWindow(windowId);
      }

      const siblings = state.tabs
        .filter((tab) => tab.windowId === windowId)
        .sort((left, right) => left.index - right.index);
      const requestedIndex = createProperties.index;
      const index =
        requestedIndex === undefined || requestedIndex < 0
          ? siblings.length
          : Math.min(requestedIndex, siblings.length);
      for (const sibling of siblings) {
        if (sibling.index >= index) sibling.index++;
      }

      const id = nextId(state.tabs);
      const tab = normalizeTab(
        {
          ...createProperties,
          active: createProperties.active ?? true,
          highlighted: createProperties.active ?? true,
          url: createProperties.url ?? 'about:blank',
          title: createProperties.title ?? '',
        },
        id,
        windowId,
        index,
      );
      if (tab.active) {
        for (const sibling of siblings) {
          sibling.active = false;
          sibling.highlighted = false;
        }
      }
      state.tabs.push(tab);
      await tabsApi.onCreated.dispatch(clone(tab));
      return clone(tab);
    },

    async update(tabIdOrProperties, maybeProperties) {
      const hasId = typeof tabIdOrProperties === 'number';
      const updateProperties = hasId ? maybeProperties ?? {} : tabIdOrProperties ?? {};
      const tabId = hasId
        ? tabIdOrProperties
        : state.tabs.find(({ active, windowId }) =>
            active && windowId === state.windows.find(({ focused }) => focused)?.id,
          )?.id;
      record('tabs', 'update', hasId ? [tabId, updateProperties] : [updateProperties]);
      failOnce('tabs.update', hasId ? [tabId, updateProperties] : [updateProperties]);
      const tab = findTab(tabId);
      const changeInfo = {};

      for (const [key, value] of Object.entries(updateProperties)) {
        if (key === 'muted') {
          tab.mutedInfo = { ...tab.mutedInfo, muted: Boolean(value) };
          changeInfo.mutedInfo = clone(tab.mutedInfo);
        } else {
          tab[key] = clone(value);
          changeInfo[key] = clone(value);
        }
      }

      if (updateProperties.active) {
        for (const sibling of state.tabs) {
          if (sibling.windowId === tab.windowId && sibling.id !== tab.id) {
            sibling.active = false;
            sibling.highlighted = false;
          }
        }
        tab.highlighted = true;
        await tabsApi.onActivated.dispatch({ tabId: tab.id, windowId: tab.windowId });
      }

      await tabsApi.onUpdated.dispatch(tab.id, changeInfo, clone(tab));
      return clone(tab);
    },

    async remove(tabIds) {
      record('tabs', 'remove', [tabIds]);
      failOnce('tabs.remove', [tabIds]);
      const requested = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const tabId of requested) {
        const tab = findTab(tabId);
        state.tabs.splice(state.tabs.indexOf(tab), 1);
        reindexTabs(tab.windowId);
        await tabsApi.onRemoved.dispatch(tabId, {
          windowId: tab.windowId,
          isWindowClosing: false,
        });
      }
    },

    async discard(tabId) {
      record('tabs', 'discard', [tabId]);
      failOnce('tabs.discard', [tabId]);
      const tab = findTab(tabId);
      tab.discarded = true;
      tab.status = 'unloaded';
      await tabsApi.onUpdated.dispatch(tab.id, { discarded: true }, clone(tab));
      return clone(tab);
    },

    async move(tabIds, moveProperties) {
      record('tabs', 'move', [tabIds, moveProperties]);
      failOnce('tabs.move', [tabIds, moveProperties]);
      const requested = Array.isArray(tabIds) ? tabIds : [tabIds];
      const moving = requested.map(findTab);
      const affectedWindows = new Set(moving.map(({ windowId }) => windowId));
      const destinationWindowId = moveProperties.windowId ?? moving[0].windowId;
      findWindow(destinationWindowId);
      affectedWindows.add(destinationWindowId);

      for (const tab of moving) state.tabs.splice(state.tabs.indexOf(tab), 1);
      for (const windowId of affectedWindows) reindexTabs(windowId);

      const destination = state.tabs
        .filter(({ windowId }) => windowId === destinationWindowId)
        .sort((left, right) => left.index - right.index);
      const insertionIndex =
        moveProperties.index === undefined || moveProperties.index < 0
          ? destination.length
          : Math.min(moveProperties.index, destination.length);
      destination.splice(insertionIndex, 0, ...moving);
      destination.forEach((tab, index) => {
        tab.windowId = destinationWindowId;
        tab.index = index;
      });
      for (const tab of moving) state.tabs.push(tab);
      for (const windowId of affectedWindows) reindexTabs(windowId);

      await Promise.all(
        moving.map((tab) =>
          tabsApi.onMoved.dispatch(tab.id, {
            windowId: destinationWindowId,
            fromIndex: tab.index,
            toIndex: tab.index,
          }),
        ),
      );
      const result = moving.map((tab) => clone(tab));
      return Array.isArray(tabIds) ? result : result[0];
    },

    async group(groupOptions) {
      record('tabs', 'group', [groupOptions]);
      failOnce('tabs.group', [groupOptions]);
      const tabIds = Array.isArray(groupOptions.tabIds)
        ? groupOptions.tabIds
        : [groupOptions.tabIds];
      const selected = tabIds.map(findTab);
      if (!selected.length) throw new Error('At least one tab is required to create a group');
      const windowId = groupOptions.createProperties?.windowId ?? selected[0].windowId;
      let groupId = groupOptions.groupId;
      if (groupId === undefined) {
        groupId = nextId(state.groups);
        const group = normalizeGroup({}, groupId, windowId);
        state.groups.push(group);
        await tabGroupsApi.onCreated.dispatch(clone(group));
      } else {
        findGroup(groupId);
      }

      for (const tab of selected) {
        tab.groupId = groupId;
        tab.windowId = windowId;
      }
      return groupId;
    },

    async ungroup(tabIds) {
      record('tabs', 'ungroup', [tabIds]);
      failOnce('tabs.ungroup', [tabIds]);
      const requested = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const tabId of requested) findTab(tabId).groupId = -1;
    },

    async goBack(tabId) {
      record('tabs', 'goBack', [tabId]);
      failOnce('tabs.goBack', [tabId]);
      return clone(findTab(tabId));
    },

    async reload(tabId, reloadProperties) {
      record('tabs', 'reload', [tabId, reloadProperties]);
      failOnce('tabs.reload', [tabId, reloadProperties]);
    },

    async sendMessage(tabId, message, options) {
      record('tabs', 'sendMessage', [tabId, message, options]);
      failOnce('tabs.sendMessage', [tabId, message, options]);
    },
  };

  const windowsApi = {
    ...windowsEvents,
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,

    async get(windowId, getInfo = {}) {
      record('windows', 'get', [windowId, getInfo]);
      failOnce('windows.get', [windowId, getInfo]);
      return populatedWindow(findWindow(windowId), getInfo.populate);
    },

    async getAll(getInfo = {}) {
      record('windows', 'getAll', [getInfo]);
      failOnce('windows.getAll', [getInfo]);
      let result = [...state.windows];
      if (getInfo.windowTypes) {
        result = result.filter(({ type }) => getInfo.windowTypes.includes(type));
      }
      return result.map((window) => populatedWindow(window, getInfo.populate));
    },

    async getCurrent(getInfo = {}) {
      record('windows', 'getCurrent', [getInfo]);
      failOnce('windows.getCurrent', [getInfo]);
      const window = state.windows.find(({ focused }) => focused) ?? state.windows[0];
      if (!window) throw new Error('No current window');
      return populatedWindow(window, getInfo.populate);
    },

    async getLastFocused(getInfo = {}) {
      record('windows', 'getLastFocused', [getInfo]);
      failOnce('windows.getLastFocused', [getInfo]);
      const window = state.windows.find(({ focused }) => focused) ?? state.windows[0];
      if (!window) throw new Error('No focused window');
      return populatedWindow(window, getInfo.populate);
    },

    async create(createData = {}) {
      record('windows', 'create', [createData]);
      failOnce('windows.create', [createData]);
      const id = nextId(state.windows);
      if (createData.focused !== false) {
        for (const existing of state.windows) existing.focused = false;
      }
      const window = normalizeWindow(
        { ...createData, focused: createData.focused !== false },
        id,
      );
      state.windows.push(window);

      if (createData.tabId !== undefined) {
        const tab = findTab(createData.tabId);
        const oldWindowId = tab.windowId;
        tab.windowId = id;
        tab.index = 0;
        reindexTabs(oldWindowId);
      } else {
        const urls = Array.isArray(createData.url)
          ? createData.url
          : [createData.url ?? 'chrome://newtab/'];
        urls.forEach((url, index) => {
          state.tabs.push(
            normalizeTab({ url, active: index === 0, highlighted: index === 0 }, nextId(state.tabs), id, index),
          );
        });
      }

      await windowsApi.onCreated.dispatch(populatedWindow(window, true));
      return populatedWindow(window, true);
    },

    async update(windowId, updateInfo) {
      record('windows', 'update', [windowId, updateInfo]);
      failOnce('windows.update', [windowId, updateInfo]);
      const window = findWindow(windowId);
      if (updateInfo.focused) {
        for (const existing of state.windows) existing.focused = existing.id === windowId;
        await windowsApi.onFocusChanged.dispatch(windowId);
      }
      Object.assign(window, clone(updateInfo));
      return populatedWindow(window, false);
    },

    async remove(windowId) {
      record('windows', 'remove', [windowId]);
      failOnce('windows.remove', [windowId]);
      const window = findWindow(windowId);
      state.windows.splice(state.windows.indexOf(window), 1);
      state.tabs = state.tabs.filter((tab) => tab.windowId !== windowId);
      state.groups = state.groups.filter((group) => group.windowId !== windowId);
      await windowsApi.onRemoved.dispatch(windowId);
    },
  };

  const tabGroupsApi = {
    ...tabGroupsEvents,
    TAB_GROUP_ID_NONE: -1,

    async get(groupId) {
      record('tabGroups', 'get', [groupId]);
      failOnce('tabGroups.get', [groupId]);
      return clone(findGroup(groupId));
    },

    async query(queryInfo = {}) {
      record('tabGroups', 'query', [queryInfo]);
      failOnce('tabGroups.query', [queryInfo]);
      return state.groups
        .filter((group) =>
          Object.entries(queryInfo).every(([key, value]) => group[key] === value),
        )
        .map((group) => clone(group));
    },

    async update(groupId, updateProperties) {
      record('tabGroups', 'update', [groupId, updateProperties]);
      failOnce('tabGroups.update', [groupId, updateProperties]);
      const group = findGroup(groupId);
      Object.assign(group, clone(updateProperties));
      await tabGroupsApi.onUpdated.dispatch(clone(group));
      return clone(group);
    },

    async move(groupId, moveProperties) {
      record('tabGroups', 'move', [groupId, moveProperties]);
      failOnce('tabGroups.move', [groupId, moveProperties]);
      const group = findGroup(groupId);
      if (moveProperties.windowId !== undefined) group.windowId = moveProperties.windowId;
      const movedTabs = state.tabs.filter((tab) => tab.groupId === groupId);
      if (moveProperties.windowId !== undefined) {
        for (const tab of movedTabs) tab.windowId = moveProperties.windowId;
      }
      await tabGroupsApi.onMoved.dispatch(clone(group));
      return clone(group);
    },
  };

  const alarmsApi = {
    onAlarm: alarmsOnAlarm,

    async create(nameOrInfo, maybeInfo) {
      const name = typeof nameOrInfo === 'string' ? nameOrInfo : '';
      const alarmInfo = typeof nameOrInfo === 'string' ? maybeInfo ?? {} : nameOrInfo ?? {};
      record('alarms', 'create', typeof nameOrInfo === 'string' ? [name, alarmInfo] : [alarmInfo]);
      failOnce('alarms.create', [name, alarmInfo]);
      state.alarms.set(name, { name, ...clone(alarmInfo) });
    },

    async get(name) {
      record('alarms', 'get', [name]);
      failOnce('alarms.get', [name]);
      return clone(state.alarms.get(name));
    },

    async getAll() {
      record('alarms', 'getAll', []);
      failOnce('alarms.getAll', []);
      return [...state.alarms.values()].map((alarm) => clone(alarm));
    },

    async clear(name) {
      record('alarms', 'clear', [name]);
      failOnce('alarms.clear', [name]);
      return state.alarms.delete(name);
    },

    async clearAll() {
      record('alarms', 'clearAll', []);
      failOnce('alarms.clearAll', []);
      const hadAlarms = state.alarms.size > 0;
      state.alarms.clear();
      return hadAlarms;
    },
  };

  function makeRecordedStateMethod(domain, method, implementation = () => undefined) {
    return async (...args) => {
      record(domain, method, args);
      failOnce(`${domain}.${method}`, args);
      return clone(await implementation(...args));
    };
  }

  const actionApi = {
    onClicked: actionOnClicked,
    setBadgeText: makeRecordedStateMethod('action', 'setBadgeText', ({ text }) => {
      state.action.badgeText = text;
    }),
    getBadgeText: makeRecordedStateMethod('action', 'getBadgeText', () => state.action.badgeText),
    setBadgeBackgroundColor: makeRecordedStateMethod(
      'action',
      'setBadgeBackgroundColor',
      ({ color }) => {
        state.action.badgeBackgroundColor = clone(color);
      },
    ),
    getBadgeBackgroundColor: makeRecordedStateMethod(
      'action',
      'getBadgeBackgroundColor',
      () => state.action.badgeBackgroundColor,
    ),
    setTitle: makeRecordedStateMethod('action', 'setTitle', ({ title }) => {
      state.action.title = title;
    }),
    getTitle: makeRecordedStateMethod('action', 'getTitle', () => state.action.title),
    setIcon: makeRecordedStateMethod('action', 'setIcon'),
    enable: makeRecordedStateMethod('action', 'enable', () => {
      state.action.enabled = true;
    }),
    disable: makeRecordedStateMethod('action', 'disable', () => {
      state.action.enabled = false;
    }),
  };

  const sidePanelApi = {
    open: makeRecordedStateMethod('sidePanel', 'open'),
    setOptions: makeRecordedStateMethod('sidePanel', 'setOptions', (options) => {
      const key = options.tabId ?? 'default';
      state.sidePanel.options.set(key, clone(options));
    }),
    getOptions: makeRecordedStateMethod('sidePanel', 'getOptions', ({ tabId } = {}) =>
      state.sidePanel.options.get(tabId ?? 'default') ?? {},
    ),
    setPanelBehavior: makeRecordedStateMethod('sidePanel', 'setPanelBehavior', (behavior) => {
      state.sidePanel.behavior = clone(behavior);
    }),
  };

  function flattenBookmarks(nodes = state.bookmarks) {
    return nodes.flatMap((node) => [node, ...flattenBookmarks(node.children ?? [])]);
  }

  function findBookmark(id) {
    const bookmark = flattenBookmarks().find((node) => node.id === String(id));
    if (!bookmark) throw new Error(`No bookmark with id: ${id}`);
    return bookmark;
  }

  function findBookmarkParent(id, nodes = state.bookmarks) {
    for (const node of nodes) {
      if (node.children?.some((child) => child.id === String(id))) return node;
      const nested = findBookmarkParent(id, node.children ?? []);
      if (nested) return nested;
    }
    return null;
  }

  const bookmarksApi = {
    ...bookmarksEvents,
    async get(ids) {
      record('bookmarks', 'get', [ids]);
      failOnce('bookmarks.get', [ids]);
      const requested = Array.isArray(ids) ? ids : [ids];
      return requested.map((id) => clone(findBookmark(id)));
    },
    async getTree() {
      record('bookmarks', 'getTree', []);
      failOnce('bookmarks.getTree', []);
      return clone(state.bookmarks);
    },
    async getChildren(id) {
      record('bookmarks', 'getChildren', [id]);
      failOnce('bookmarks.getChildren', [id]);
      return clone(findBookmark(id).children ?? []);
    },
    async create(bookmark) {
      record('bookmarks', 'create', [bookmark]);
      failOnce('bookmarks.create', [bookmark]);
      const parent = findBookmark(bookmark.parentId ?? '1');
      parent.children ??= [];
      const created = {
        id: String(nextId(flattenBookmarks())),
        parentId: parent.id,
        title: '',
        ...clone(bookmark),
      };
      if (!created.url) created.children = [];
      parent.children.push(created);
      await bookmarksApi.onCreated.dispatch(created.id, clone(created));
      return clone(created);
    },
    async update(id, changes) {
      record('bookmarks', 'update', [id, changes]);
      failOnce('bookmarks.update', [id, changes]);
      const bookmark = findBookmark(id);
      Object.assign(bookmark, clone(changes));
      await bookmarksApi.onChanged.dispatch(String(id), clone(changes));
      return clone(bookmark);
    },
    async move(id, destination) {
      record('bookmarks', 'move', [id, destination]);
      failOnce('bookmarks.move', [id, destination]);
      const bookmark = findBookmark(id);
      const oldParent = findBookmarkParent(id);
      oldParent.children.splice(oldParent.children.indexOf(bookmark), 1);
      const newParent = findBookmark(destination.parentId ?? oldParent.id);
      newParent.children ??= [];
      const index = destination.index ?? newParent.children.length;
      newParent.children.splice(index, 0, bookmark);
      bookmark.parentId = newParent.id;
      await bookmarksApi.onMoved.dispatch(String(id), {
        parentId: newParent.id,
        oldParentId: oldParent.id,
        index,
      });
      return clone(bookmark);
    },
    async remove(id) {
      record('bookmarks', 'remove', [id]);
      failOnce('bookmarks.remove', [id]);
      const parent = findBookmarkParent(id);
      const bookmark = findBookmark(id);
      if (bookmark.children?.length) throw new Error('Cannot remove a non-empty bookmark folder');
      parent.children.splice(parent.children.indexOf(bookmark), 1);
      await bookmarksApi.onRemoved.dispatch(String(id), { parentId: parent.id });
    },
    async removeTree(id) {
      record('bookmarks', 'removeTree', [id]);
      failOnce('bookmarks.removeTree', [id]);
      const parent = findBookmarkParent(id);
      const bookmark = findBookmark(id);
      parent.children.splice(parent.children.indexOf(bookmark), 1);
      await bookmarksApi.onRemoved.dispatch(String(id), { parentId: parent.id });
    },
    async search(query) {
      record('bookmarks', 'search', [query]);
      failOnce('bookmarks.search', [query]);
      const term = typeof query === 'string' ? query : query.query ?? '';
      return flattenBookmarks()
        .filter((bookmark) => `${bookmark.title} ${bookmark.url ?? ''}`.includes(term))
        .map((bookmark) => clone(bookmark));
    },
  };

  function invokeIdentityCallback(path, args, value) {
    const callback = args.at(-1);
    if (typeof callback !== 'function') return false;
    try {
      failOnce(path, args.slice(0, -1));
      callback(clone(value));
    } catch (error) {
      runtime.lastError = { message: error.message };
      callback(undefined);
      runtime.lastError = undefined;
    }
    return true;
  }

  const identityApi = {
    getAuthToken(...args) {
      record('identity', 'getAuthToken', args);
      if (invokeIdentityCallback('identity.getAuthToken', args, state.identity.authToken)) return;
      failOnce('identity.getAuthToken', args);
      return Promise.resolve(state.identity.authToken);
    },
    async removeCachedAuthToken(details) {
      record('identity', 'removeCachedAuthToken', [details]);
      failOnce('identity.removeCachedAuthToken', [details]);
      if (details?.token === state.identity.authToken) state.identity.authToken = null;
    },
    async clearAllCachedAuthTokens() {
      record('identity', 'clearAllCachedAuthTokens', []);
      failOnce('identity.clearAllCachedAuthTokens', []);
      state.identity.authToken = null;
    },
    launchWebAuthFlow(...args) {
      record('identity', 'launchWebAuthFlow', args);
      const redirectUrl = args[0]?.url ?? '';
      if (invokeIdentityCallback('identity.launchWebAuthFlow', args, redirectUrl)) return;
      failOnce('identity.launchWebAuthFlow', args);
      return Promise.resolve(redirectUrl);
    },
    getProfileUserInfo(...args) {
      record('identity', 'getProfileUserInfo', args);
      if (invokeIdentityCallback('identity.getProfileUserInfo', args, state.identity.profile)) return;
      failOnce('identity.getProfileUserInfo', args);
      return Promise.resolve(clone(state.identity.profile));
    },
  };

  globalThis.chrome = {
    storage: {
      local: createStorageArea('local'),
      session: createStorageArea('session'),
      onChanged: storageOnChanged,
    },
    runtime,
    tabs: tabsApi,
    windows: windowsApi,
    tabGroups: tabGroupsApi,
    alarms: alarmsApi,
    action: actionApi,
    sidePanel: sidePanelApi,
    bookmarks: bookmarksApi,
    identity: identityApi,
  };

  function snapshot() {
    return {
      local: clone(storageState.local),
      session: clone(storageState.session),
      tabs: state.tabs
        .slice()
        .sort((left, right) => left.windowId - right.windowId || left.index - right.index)
        .map((tab) => clone(tab)),
      windows: state.windows.map((window) => populatedWindow(window, false)),
      groups: state.groups.map((group) => clone(group)),
      alarms: [...state.alarms.values()].map((alarm) => clone(alarm)),
      bookmarks: clone(state.bookmarks),
      action: clone(state.action),
      sidePanel: {
        behavior: clone(state.sidePanel.behavior),
        options: [...state.sidePanel.options.values()].map((options) => clone(options)),
      },
    };
  }

  return {
    calls,
    setRuntimeHandler(handler) {
      if (handler !== null && typeof handler !== 'function') {
        throw new TypeError('Runtime handler must be a function or null');
      }
      activeHarness.runtimeHandler = handler;
    },
    snapshot,
    connect(name = 'test-port') {
      return runtime.connect({ name });
    },
  };
}

export function resetChromeMock() {
  if (!activeHarness) return;

  const harness = activeHarness;
  const disconnections = [...harness.connections].map(({ clientPort }) =>
    clientPort.disconnect(),
  );
  for (const event of harness.events) clearEvent(event);
  if (harness.hadChrome) {
    globalThis.chrome = harness.previousChrome;
  } else {
    delete globalThis.chrome;
  }
  activeHarness = null;
  return Promise.all(disconnections);
}

export function readStorageArea(areaName) {
  if (!activeHarness) throw new Error('Chrome mock is not installed');
  if (areaName !== 'local' && areaName !== 'session') {
    throw new TypeError(`Unknown storage area: ${areaName}`);
  }
  return clone(activeHarness.storageState[areaName]);
}
