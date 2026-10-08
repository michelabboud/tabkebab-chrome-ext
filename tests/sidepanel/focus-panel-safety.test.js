import { describe, expect, test } from 'bun:test';

import { installChromeMock } from '../helpers/chrome-mock.js';
import { FocusPanel } from '../../sidepanel/components/focus-panel.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function fakeElement() {
  const element = {
    listeners: {},
    hidden: false,
    value: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {} },
    innerHTML: '',
    textContent: '',
    placeholder: '',
    addEventListener(name, listener) {
      (this.listeners[name] ||= []).push(listener);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return element;
}

/** A container that hands back one stable element per selector. */
function fakeContainer() {
  const elements = new Map();
  return {
    innerHTML: '',
    elements,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, fakeElement());
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
  };
}

function makePanel(overrides = {}) {
  const panel = Object.create(FocusPanel.prototype);
  Object.assign(panel, {
    container: fakeContainer(),
    state: null,
    profiles: [{ id: 'coding', name: 'Coding', icon: 'C', color: 'cyan', allowedDomains: [] }],
    settings: {},
    _profilePrefs: {},
    notify: () => {},
    timerInterval: null,
    ...overrides,
  });
  return panel;
}

describe('1.7 focus panel escaping', () => {
  test('_esc escapes quotes for attribute contexts as well as markup', () => {
    const panel = makePanel();
    expect(panel._esc(`a"b'c<d>&e`)).toBe('a&quot;b&#39;c&lt;d&gt;&amp;e');
    expect(panel._esc(null)).toBe('');
    expect(panel._esc(5)).toBe('5');
  });

  test('a blocked domain containing a quote cannot break out of its data attribute', () => {
    const panel = makePanel();
    const blockedEl = fakeElement();
    panel.container.querySelector = (selector) => (selector === '#focus-blocked-tags' ? blockedEl : null);
    panel._blockedDomains = ['x.com" onclick="alert(1)'];
    panel._renderDomainTags();
    expect(blockedEl.innerHTML).toContain('data-domain="x.com&quot; onclick=&quot;alert(1)"');
    expect(blockedEl.innerHTML).not.toContain('" onclick="');
  });
});

describe('1.3 open-ended HUD', () => {
  function renderHUD(duration) {
    const panel = makePanel({
      state: {
        status: 'active',
        runId: 'run-a',
        duration,
        startedAt: Date.now(),
        pausedElapsed: 0,
        profileName: 'Coding',
        profileColor: 'cyan',
        distractionsBlocked: 0,
        focusTabCount: 1,
      },
    });
    panel._renderHUD();
    panel._stopTimer();
    return panel.container.innerHTML;
  }

  test('hides +5 min for an open-ended session and shows it for a timed one', () => {
    expect(renderHUD(0)).not.toContain('btn-extend-focus');
    expect(renderHUD(25)).toContain('btn-extend-focus');
  });
});

describe('1.8 render generation guard', () => {
  test('two overlapping setup renders wire the Start button exactly once', async () => {
    installChromeMock();
    const panel = makePanel();
    const firstAiCheck = deferred();
    let aiChecks = 0;
    panel.send = async ({ action }) => {
      if (action === 'isAIAvailable') {
        aiChecks++;
        if (aiChecks === 1) return firstAiCheck.promise;
        return { available: false };
      }
      if (action === 'getFocusHistory') return [];
      return null;
    };

    const first = panel._renderSetup();
    while (aiChecks < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    await panel._renderSetup();
    firstAiCheck.resolve({ available: false });
    await first;

    const startButton = panel.container.elements.get('#btn-start-focus');
    expect(startButton.listeners.click).toHaveLength(1);
  });

  test('a superseded refresh does not overwrite newer panel state', async () => {
    installChromeMock();
    const panel = makePanel();
    const slowState = deferred();
    let stateReads = 0;
    panel._renderSetup = async () => {};
    panel._renderHUD = () => {};
    panel.send = async ({ action }) => {
      if (action === 'getFocusState') {
        stateReads++;
        return stateReads === 1 ? slowState.promise : { status: 'active', runId: 'new' };
      }
      if (action === 'getFocusProfiles') return panel.profiles;
      return {};
    };

    const first = panel.refresh();
    await panel.refresh();
    slowState.resolve({ status: 'active', runId: 'old' });
    await first;
    expect(panel.state.runId).toBe('new');
  });
});

describe('1.9 profile preference load ordering', () => {
  test('a slower, earlier profile load cannot apply over a newer selection', async () => {
    installChromeMock();
    const prefs = {
      coding: { strictMode: true, blockedDomains: ['coding.test'] },
      writing: { strictMode: false, blockedDomains: ['writing.test'] },
    };
    const slow = deferred();
    let reads = 0;
    chrome.storage.local.get = async () => {
      reads++;
      if (reads === 1) {
        await slow.promise;
      }
      return { focusProfilePrefs: prefs };
    };

    const panel = makePanel();
    panel._blockedDomains = [];
    panel._strictMode = false;

    const firstLoad = panel._loadProfilePrefs('coding');
    const secondApplied = await panel._loadProfilePrefs('writing');
    slow.resolve();
    const firstApplied = await firstLoad;

    expect(secondApplied).toBeTrue();
    expect(firstApplied).toBeFalse();
    expect(panel._blockedDomains).toEqual(['writing.test']);
    expect(panel._strictMode).toBeFalse();
  });

  test('stored blocked-domain preferences are normalized on load', async () => {
    installChromeMock({
      local: {
        focusProfilePrefs: {
          coding: { blockedDomains: ['https://www.reddit.com/r/all', '*.x.com', 'bad value'] },
        },
      },
    });
    const panel = makePanel();
    panel._blockedDomains = [];
    await panel._loadProfilePrefs('coding');
    expect(panel._blockedDomains).toEqual(['www.reddit.com', 'x.com']);
  });
});
