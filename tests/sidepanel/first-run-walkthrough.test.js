import { afterEach, describe, expect, test } from 'bun:test';

const previousDocument = globalThis.document;

function createElement() {
  return {
    children: [],
    hidden: false,
    textContent: '',
    className: '',
    dataset: {},
    listeners: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    click() {
      return this.listeners.click?.({ currentTarget: this });
    },
  };
}

function installDocument() {
  globalThis.document = { createElement };
}

function createWalkthroughRoot() {
  const elements = Object.fromEntries([
    'walkthrough-step',
    'walkthrough-title',
    'walkthrough-description',
    'walkthrough-action',
    'walkthrough-back',
    'walkthrough-next',
    'walkthrough-dismiss',
  ].map((id) => [id, createElement()]));

  return {
    hidden: true,
    querySelector(selector) {
      return elements[selector.replace(/^#/, '')] || null;
    },
    elements,
  };
}

afterEach(() => {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
});

describe('first-run walkthrough', () => {
  test('is wired as an inline panel section with a settings relaunch control', async () => {
    const [html, script, css] = await Promise.all([
      Bun.file(new URL('../../sidepanel/panel.html', import.meta.url)).text(),
      Bun.file(new URL('../../sidepanel/panel.js', import.meta.url)).text(),
      Bun.file(new URL('../../sidepanel/panel.css', import.meta.url)).text(),
    ]);

    expect(html).toContain('id="first-run-walkthrough"');
    expect(html).toContain('id="btn-relaunch-walkthrough"');
    expect(html).toContain('id="settings-automation-section"');
    expect(script).toContain("from './components/first-run-walkthrough.js'");
    expect(script).toContain('walkthrough.startIfNeeded()');
    expect(script).toContain("getElementById('btn-relaunch-walkthrough')");
    expect(css).toContain('.first-run-walkthrough');
    expect(html).not.toMatch(/walkthrough-(?:drawer|slideover|slide-over)/);
  });

  test('runs once, persists the seen flag, and remains dismissible on every step', async () => {
    installDocument();
    const writes = [];
    const root = createWalkthroughRoot();
    const { FIRST_RUN_WALKTHROUGH_KEY, FirstRunWalkthrough } =
      await import('../../sidepanel/components/first-run-walkthrough.js');
    const walkthrough = new FirstRunWalkthrough(root, {
      storage: {
        get: async () => ({}),
        set: async (value) => writes.push(value),
      },
    });

    await expect(walkthrough.startIfNeeded()).resolves.toBe(true);
    expect(root.hidden).toBe(false);
    expect(writes).toEqual([{ [FIRST_RUN_WALKTHROUGH_KEY]: true }]);

    for (let index = 0; index < 4; index += 1) {
      expect(root.elements['walkthrough-step'].textContent).toBe(`${index + 1} of 4`);
      root.elements['walkthrough-dismiss'].click();
      expect(root.hidden).toBe(true);
      walkthrough.launch(index);
      expect(root.hidden).toBe(false);
      if (index < 3) root.elements['walkthrough-next'].click();
    }
  });

  test('does not auto-run after the seen flag is present, but settings can relaunch it', async () => {
    installDocument();
    let writes = 0;
    const root = createWalkthroughRoot();
    const { FIRST_RUN_WALKTHROUGH_KEY, FirstRunWalkthrough } =
      await import('../../sidepanel/components/first-run-walkthrough.js');
    const walkthrough = new FirstRunWalkthrough(root, {
      storage: {
        get: async () => ({ [FIRST_RUN_WALKTHROUGH_KEY]: true }),
        set: async () => { writes += 1; },
      },
    });

    await expect(walkthrough.startIfNeeded()).resolves.toBe(false);
    expect(root.hidden).toBe(true);

    walkthrough.launch();
    expect(root.hidden).toBe(false);
    expect(root.elements['walkthrough-title'].textContent).toBe('Welcome to TabKebab');
    expect(writes).toBe(0);
  });

  test('keeps the panel usable when the seen flag cannot be read', async () => {
    installDocument();
    const notices = [];
    const root = createWalkthroughRoot();
    const { FirstRunWalkthrough } =
      await import('../../sidepanel/components/first-run-walkthrough.js');
    const walkthrough = new FirstRunWalkthrough(root, {
      storage: {
        get: async () => { throw new Error('storage unavailable'); },
        set: async () => {},
      },
      notify: (message, type) => notices.push({ message, type }),
    });

    await expect(walkthrough.startIfNeeded()).resolves.toBe(false);
    expect(root.hidden).toBe(true);
    expect(notices).toEqual([{
      message: 'Getting started could not check first-run status: storage unavailable',
      type: 'error',
    }]);
  });

  test('shows the walkthrough but reports when the seen flag cannot be saved', async () => {
    installDocument();
    const notices = [];
    const root = createWalkthroughRoot();
    const { FirstRunWalkthrough } =
      await import('../../sidepanel/components/first-run-walkthrough.js');
    const walkthrough = new FirstRunWalkthrough(root, {
      storage: {
        get: async () => ({}),
        set: async () => { throw new Error('quota exceeded'); },
      },
      notify: (message, type) => notices.push({ message, type }),
    });

    await expect(walkthrough.startIfNeeded()).resolves.toBe(true);
    expect(root.hidden).toBe(false);
    expect(notices).toEqual([{
      message: 'Getting started is open, but its first-run flag could not be saved: quota exceeded',
      type: 'error',
    }]);
  });

  test('step actions navigate to the real panel sections', async () => {
    installDocument();
    const destinations = [];
    const root = createWalkthroughRoot();
    const { FirstRunWalkthrough } =
      await import('../../sidepanel/components/first-run-walkthrough.js');
    const walkthrough = new FirstRunWalkthrough(root, {
      storage: { get: async () => ({}), set: async () => {} },
      navigate: (destination) => destinations.push(destination),
    });

    walkthrough.launch(1);
    root.elements['walkthrough-action'].click();
    walkthrough.launch(2);
    root.elements['walkthrough-action'].click();
    walkthrough.launch(3);
    root.elements['walkthrough-action'].click();

    expect(destinations).toEqual([
      { view: 'tabs' },
      { view: 'tabs' },
      { view: 'stash' },
    ]);
  });
});

describe('actionable empty states', () => {
  test('renders a real button that invokes its action', async () => {
    installDocument();
    const { renderActionableEmptyState } =
      await import('../../sidepanel/components/actionable-empty-state.js');
    const container = createElement();
    let actions = 0;

    const button = renderActionableEmptyState(container, {
      message: 'Nothing here yet.',
      actionLabel: 'Create one',
      onAction: () => { actions += 1; },
    });

    expect(container.children[0].className).toContain('empty-state');
    expect(container.children[0].children[0].textContent).toBe('Nothing here yet.');
    expect(button.textContent).toBe('Create one');
    button.click();
    expect(actions).toBe(1);
  });

  test('session empty states focus naming and open auto-save settings', async () => {
    installDocument();
    const { SessionManager } =
      await import('../../sidepanel/components/session-manager.js');
    const savedListEl = createElement();
    const autoListEl = createElement();
    const destinations = [];
    let focusCount = 0;
    const sessionName = { focus: () => { focusCount += 1; } };
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      savedListEl,
      autoListEl,
      navigate: (destination) => destinations.push(destination),
      root: {
        querySelector(selector) {
          if (selector === '#session-name') return sessionName;
          return null;
        },
      },
    });

    SessionManager.prototype.render.call(manager, []);
    savedListEl.children[0].children[1].click();
    autoListEl.children[0].children[1].click();

    expect(focusCount).toBe(1);
    expect(destinations).toEqual([
      { view: 'settings', sectionId: 'settings-automation-section' },
    ]);
  });

  test('stash empty state opens the tabs view where stash actions live', async () => {
    installDocument();
    const { StashList } =
      await import('../../sidepanel/components/stash-list.js');
    const listEl = createElement();
    const destinations = [];

    StashList.prototype.render.call({
      listEl,
      navigate: (destination) => destinations.push(destination),
    }, []);
    listEl.children[0].children[1].click();

    expect(destinations).toEqual([{ view: 'tabs' }]);
  });

  test('focus profile empty state retries loading and reports retry failure', async () => {
    installDocument();
    const { FocusPanel } =
      await import('../../sidepanel/components/focus-panel.js');
    const container = createElement();
    const notices = [];
    let attempts = 0;
    const panel = {
      profiles: [],
      container,
      notify: (message, type) => notices.push({ message, type }),
      async refresh() {
        attempts += 1;
        throw new Error('worker asleep');
      },
    };

    await FocusPanel.prototype._renderSetup.call(panel);
    await container.children[0].children[1].click();

    expect(attempts).toBe(1);
    expect(notices).toEqual([{
      message: 'Failed to load focus profiles: worker asleep',
      type: 'error',
    }]);
  });
});
