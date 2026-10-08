import { afterEach, describe, expect, test } from 'bun:test';

const previousDocument = globalThis.document;
const previousSetTimeout = globalThis.setTimeout;

function createElement() {
  return {
    children: [],
    hidden: false,
    textContent: '',
    className: '',
    style: {},
    listeners: {},
    disabled: false,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    click() {
      return this.listeners.click?.({
        currentTarget: this,
        preventDefault() {},
      });
    },
    remove() {},
  };
}

function installToastDocument() {
  const toasts = [];
  const container = createElement();
  container.appendChild = (toast) => {
    toasts.push({
      type: toast.className.replace(/^toast\s+/, ''),
      message: toast.children[0]?.textContent,
    });
  };
  globalThis.document = {
    createElement,
    getElementById: (id) => id === 'toast-container' ? container : null,
  };
  globalThis.setTimeout = () => 0;
  return toasts;
}

function createFallbackRoot() {
  const elements = {
    '#smart-group-fallback-message': createElement(),
    '#btn-smart-group-domain-fallback': createElement(),
    '#link-smart-group-settings': createElement(),
  };
  return {
    hidden: true,
    querySelector(selector) {
      return elements[selector] || null;
    },
    elements,
  };
}

function createTabListHarness(resultOrError) {
  const fallbackCalls = [];
  const done = [];
  const list = {
    smartGroupBtn: createElement(),
    groupBtn: createElement(),
    ungroupBtn: createElement(),
    smartGroupFallback: {
      hide() {},
      show(value) {
        fallbackCalls.push(value);
      },
    },
    showProgress() {},
    hideProgress() {},
    showDone(value) {
      done.push(value);
    },
    async refresh() {},
    async send(message) {
      expect(message).toEqual({ action: 'applySmartGroups' });
      if (resultOrError instanceof Error) throw resultOrError;
      return resultOrError;
    },
  };
  return { list, fallbackCalls, done };
}

afterEach(() => {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  globalThis.setTimeout = previousSetTimeout;
});

describe('Smart Group graceful degradation', () => {
  test('has no always-on zero-config note; the on-device hint starts hidden', async () => {
    const html = await Bun.file(
      new URL('../../sidepanel/panel.html', import.meta.url),
    ).text();

    expect(html).not.toContain('id="smart-group-zero-config-note"');
    expect(html).not.toContain('No key or account is needed');
    expect(html).toMatch(/<p id="smart-group-ai-hint"[^>]*\shidden>/);
    // The settings path is a button that navigates, not a fragment link.
    expect(html).not.toContain('href="#settings-ai-section"');
    expect(html).toMatch(/<button id="link-smart-group-settings" type="button"/);
  });

  test('shows the ready hint and button title only after a successful probe', async () => {
    const { SmartGroupFallback, SMART_GROUP_READY_TITLE } =
      await import('../../sidepanel/components/smart-group-fallback.js');
    const hintEl = createElement();
    hintEl.hidden = true;
    const smartGroupButton = createElement();
    const sends = [];
    const ready = new SmartGroupFallback(createFallbackRoot(), {
      probe: async () => 'available',
      hintEl,
      smartGroupButton,
      send: async (message) => { sends.push(message); return { enabled: false }; },
    });
    await expect(ready.ready).resolves.toBe('available');
    expect(hintEl.hidden).toBe(false);
    expect(smartGroupButton.title).toBe(SMART_GROUP_READY_TITLE);
    expect(sends).toEqual([{ action: 'getAISettings' }]);

    // Showing the fallback hides the hint so the two never contradict.
    ready.show({ reason: 'unavailable', source: 'zero-config' });
    expect(hintEl.hidden).toBe(true);

    for (const status of ['unavailable', 'downloadable']) {
      const quietHint = createElement();
      quietHint.hidden = true;
      const quietButton = createElement();
      const quiet = new SmartGroupFallback(createFallbackRoot(), {
        probe: async () => status,
        hintEl: quietHint,
        smartGroupButton: quietButton,
        send: async () => { throw new Error('should not ask for settings'); },
      });
      await quiet.ready;
      expect(quietHint.hidden).toBe(true);
      expect(quietButton.title).toBeUndefined();
    }
  });

  test('stays quiet when a configured cloud provider would run Smart group', async () => {
    const { SmartGroupFallback } =
      await import('../../sidepanel/components/smart-group-fallback.js');
    const hintEl = createElement();
    hintEl.hidden = true;
    const fallback = new SmartGroupFallback(createFallbackRoot(), {
      probe: async () => 'available',
      hintEl,
      smartGroupButton: createElement(),
      send: async () => ({
        enabled: true,
        providerId: 'openai',
        providerConfigs: { openai: { hasApiKey: true } },
      }),
    });
    await expect(fallback.ready).resolves.toBe('configured');
    expect(hintEl.hidden).toBe(true);
  });

  test('probeOnDeviceAI maps Prompt API states and never throws', async () => {
    const { probeOnDeviceAI } =
      await import('../../sidepanel/components/smart-group-fallback.js');
    expect(await probeOnDeviceAI({})).toBe('unavailable');
    expect(await probeOnDeviceAI({ LanguageModel: { availability: async () => 'available' } }))
      .toBe('available');
    expect(await probeOnDeviceAI({ LanguageModel: { availability: async () => 'downloadable' } }))
      .toBe('downloadable');
    expect(await probeOnDeviceAI({ LanguageModel: { availability: async () => { throw new Error('x'); } } }))
      .toBe('unavailable');
    expect(await probeOnDeviceAI({ self: { ai: { languageModel: { capabilities: async () => ({ available: 'readily' }) } } } }))
      .toBe('available');
  });

  test('offers working domain and API-key settings paths inline', async () => {
    const root = createFallbackRoot();
    const destinations = [];
    let domainFallbacks = 0;
    const { SmartGroupFallback } =
      await import('../../sidepanel/components/smart-group-fallback.js');
    const fallback = new SmartGroupFallback(root, {
      onDomainFallback: () => { domainFallbacks += 1; },
      navigate: (destination) => destinations.push(destination),
      probe: async () => 'unavailable',
    });

    fallback.show({ reason: 'unavailable', source: 'zero-config' });

    expect(root.hidden).toBe(false);
    expect(root.elements['#smart-group-fallback-message'].textContent)
      .toBe("On-device AI isn't ready in this Chrome. Group by domain now, or add an API key for topic grouping.");
    expect(root.elements['#btn-smart-group-domain-fallback'].textContent)
      .toBe('Group by domain');
    expect(root.elements['#link-smart-group-settings'].textContent)
      .toBe('Add an API key');

    root.elements['#btn-smart-group-domain-fallback'].click();
    root.elements['#link-smart-group-settings'].click();

    expect(domainFallbacks).toBe(1);
    expect(destinations).toEqual([
      { view: 'settings', sectionId: 'settings-ai-section' },
    ]);
  });

  test('reports a built-in-AI-unavailable result inline without refreshing or toasting', async () => {
    const toasts = installToastDocument();
    const { TabList } = await import('../../sidepanel/components/tab-list.js');
    const harness = createTabListHarness({
      aiApplied: false,
      aiSource: 'zero-config',
      aiFailure: 'unavailable',
      fallbackAction: 'domain',
    });
    let refreshes = 0;
    harness.list.refresh = async () => { refreshes += 1; };

    await TabList.prototype.smartGroup.call(harness.list);

    expect(harness.fallbackCalls).toEqual([{
      reason: 'unavailable',
      source: 'zero-config',
    }]);
    expect(refreshes).toBe(0);
    expect(toasts).toEqual([]);
  });

  test('reports a configured-key provider failure with the same working paths', async () => {
    const toasts = installToastDocument();
    const { TabList } = await import('../../sidepanel/components/tab-list.js');
    const harness = createTabListHarness({
      aiApplied: false,
      aiSource: 'configured',
      aiFailure: 'failed',
      fallbackAction: 'domain',
    });

    await TabList.prototype.smartGroup.call(harness.list);

    expect(harness.fallbackCalls).toEqual([{
      reason: 'failed',
      source: 'configured',
    }]);
    expect(toasts).toEqual([]);
  });

  test('reports timeout and unexpected worker failures inline instead of raw error toasts', async () => {
    const toasts = installToastDocument();
    const { TabList } = await import('../../sidepanel/components/tab-list.js');
    const timeout = createTabListHarness({
      aiApplied: false,
      aiSource: 'configured',
      aiFailure: 'timeout',
      fallbackAction: 'domain',
    });
    const rejected = createTabListHarness(new Error('raw provider detail'));

    await TabList.prototype.smartGroup.call(timeout.list);
    await TabList.prototype.smartGroup.call(rejected.list);

    expect(timeout.fallbackCalls).toEqual([{
      reason: 'timeout',
      source: 'configured',
    }]);
    expect(rejected.fallbackCalls).toEqual([{
      reason: 'failed',
      source: 'configured',
    }]);
    expect(toasts).toEqual([]);
  });

  test('completes a zero-config built-in AI success without showing fallback UI', async () => {
    const toasts = installToastDocument();
    const { TabList } = await import('../../sidepanel/components/tab-list.js');
    const harness = createTabListHarness({
      aiApplied: true,
      aiSource: 'zero-config',
      tabsMoved: 4,
      windowsCreated: 1,
      groupsCreated: 2,
      errors: 0,
      alreadyOrganized: false,
    });

    await TabList.prototype.smartGroup.call(harness.list);

    expect(harness.fallbackCalls).toEqual([]);
    expect(harness.done).toEqual(['4 tabs moved, 1 windows created, 2 groups created']);
    expect(toasts).toEqual([{
      type: 'success',
      message: "Tabs smart-grouped privately with Chrome's built-in AI",
    }]);
  });
});
