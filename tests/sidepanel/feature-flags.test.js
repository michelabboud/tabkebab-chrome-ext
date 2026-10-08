// feature-flags.test.js — Settings → Features on the panel side: hiding,
// shortcut remapping, view fallback, walkthrough skipping, Features card.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installFakeDom, keydown } from '../helpers/fake-dom.js';
import { FEATURE_KEYS } from '../../core/settings.js';
import {
  FEATURE_OFF_CLASS,
  applyFeatureFlags,
  fallbackSubtabFor,
  fallbackViewFor,
  featuresEnabled,
  getFeatureFlags,
  isFeatureEnabled,
  onFeatureFlagsChange,
  pruneDisabledFeatureNodes,
  resetFeatureFlagsForTests,
  visibleViewShortcuts,
} from '../../sidepanel/feature-flags.js';
import { VIEW_SHORTCUTS, setupRovingTablist } from '../../sidepanel/panel-helpers.js';
import { FirstRunWalkthrough } from '../../sidepanel/components/first-run-walkthrough.js';
import { SettingsManager } from '../../sidepanel/components/settings-manager.js';

const ALL_ON = Object.fromEntries(FEATURE_KEYS.map((key) => [key, true]));
const htmlPromise = Bun.file(new URL('../../sidepanel/panel.html', import.meta.url)).text();
const cssPromise = Bun.file(new URL('../../sidepanel/panel.css', import.meta.url)).text();
const panelPromise = Bun.file(new URL('../../sidepanel/panel.js', import.meta.url)).text();

let dom;
beforeEach(() => {
  dom = installFakeDom();
  resetFeatureFlagsForTests();
});
afterEach(() => {
  resetFeatureFlagsForTests();
  dom.restore();
});

function tagged(tag, feature, { id, parent } = {}) {
  const element = dom.el(tag, { id, parent });
  element.dataset.feature = feature;
  return element;
}

describe('applyFeatureFlags', () => {
  test('hides tagged controls while their feature is off and restores them when on', () => {
    const stashNav = tagged('button', 'stash', { id: 'nav-tab-stash' });
    const aiStatus = tagged('button', 'ai', { id: 'btn-ai-status' });
    const commandBar = tagged('div', 'ai commandBar', { id: 'command-bar' });
    const always = dom.el('button', { id: 'nav-tab-tabs' });

    applyFeatureFlags({ stash: false, commandBar: false });
    expect(stashNav.classList.contains(FEATURE_OFF_CLASS)).toBe(true);
    expect(aiStatus.classList.contains(FEATURE_OFF_CLASS)).toBe(false);
    expect(commandBar.classList.contains(FEATURE_OFF_CLASS)).toBe(true);
    expect(always.classList.contains(FEATURE_OFF_CLASS)).toBe(false);
    expect(document.body.dataset.featuresOff).toBe('stash commandBar');
    expect(isFeatureEnabled('stash')).toBe(false);
    expect(isFeatureEnabled('ai')).toBe(true);

    applyFeatureFlags({ ...ALL_ON });
    expect(stashNav.classList.contains(FEATURE_OFF_CLASS)).toBe(false);
    expect(commandBar.classList.contains(FEATURE_OFF_CLASS)).toBe(false);
    expect(document.body.dataset.featuresOff).toBe('');
  });

  test('legacy/missing switches read as on, and listeners fire only on change', () => {
    const seen = [];
    onFeatureFlagsChange((features) => seen.push(features.ai));
    applyFeatureFlags(undefined);
    expect(getFeatureFlags()).toEqual(ALL_ON);
    expect(seen).toEqual([]);
    applyFeatureFlags({ ai: false });
    applyFeatureFlags({ ai: false });
    applyFeatureFlags({});
    expect(seen).toEqual([false, true]);
    expect(featuresEnabled('ai commandBar', { ai: true, commandBar: false })).toBe(false);
  });

  test('help content for switched-off features is left out', () => {
    const body = dom.el('div');
    tagged('div', 'focus', { id: 'help-focus', parent: body });
    tagged('div', 'search', { id: 'help-search', parent: body });
    dom.el('div', { id: 'help-tabs', parent: body });
    applyFeatureFlags({ focus: false });
    pruneDisabledFeatureNodes(body);
    expect(body.querySelector('#help-focus')).toBeNull();
    expect(body.querySelector('#help-search')).not.toBeNull();
    expect(body.querySelector('#help-tabs')).not.toBeNull();
  });
});

describe('view shortcuts and fallback', () => {
  test('all on: number keys are unchanged', () => {
    expect(visibleViewShortcuts(ALL_ON)).toEqual({ ...VIEW_SHORTCUTS });
  });

  test('number keys skip switched-off views', () => {
    expect(visibleViewShortcuts({ ...ALL_ON, windows: false }))
      .toEqual({ 1: 'tabs', 2: 'stash', 3: 'sessions' });
    expect(visibleViewShortcuts({ ...ALL_ON, windows: false, stash: false, sessions: false }))
      .toEqual({ 1: 'tabs' });
  });

  test('an open view whose feature is switched off falls back to Tabs', () => {
    const off = { ...ALL_ON, stash: false, focus: false, duplicates: false };
    expect(fallbackViewFor('stash', off)).toBe('tabs');
    expect(fallbackViewFor('focus', off)).toBe('tabs');
    expect(fallbackViewFor('windows', off)).toBeNull();
    expect(fallbackViewFor('settings', off)).toBeNull();
    expect(fallbackViewFor('tabs', off)).toBeNull();
    expect(fallbackSubtabFor('duplicates', off)).toBe('domains');
    expect(fallbackSubtabFor('groups', off)).toBeNull();
  });

  test('arrow keys in the view bar skip switched-off tabs', () => {
    const nav = dom.el('nav');
    const tabs = ['tabs', 'windows', 'stash'].map((view) => {
      const tab = dom.el('button', { parent: nav });
      tab.dataset.view = view;
      if (view === 'windows') tab.dataset.feature = 'windows';
      return tab;
    });
    const activated = [];
    setupRovingTablist(tabs, { activate: (tab) => activated.push(tab.dataset.view) });
    applyFeatureFlags({ windows: false });
    keydown(tabs[0], 'ArrowRight');
    expect(activated).toEqual(['stash']);
    applyFeatureFlags({});
    keydown(tabs[0], 'ArrowRight');
    expect(activated).toEqual(['stash', 'windows']);
  });

  test('panel.js wires the switches into load, settings changes, shortcuts and help', async () => {
    const panel = await panelPromise;
    expect(panel).toContain('applyPanelFeatures(settings.features)');
    expect(panel).toContain('applyPanelFeatures(newSettings.features)');
    expect(panel).toContain('onFeaturesChanged: (features) => applyPanelFeatures(features)');
    expect(panel).toContain('const tabKeys = visibleViewShortcuts();');
    expect(panel).toContain("isFeatureEnabled('focus')");
    expect(panel).toContain("if (!isFeatureEnabled('search')) return;");
    expect(panel).toContain('pruneDisabledFeatureNodes(body)');
    expect(panel).toContain('fallbackViewFor(visibleViewName())');
  });
});

describe('panel markup', () => {
  test('controls are tagged with the feature that owns them', async () => {
    const html = await htmlPromise;
    const expectTag = (id, feature) => {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*data-feature="${feature}"|data-feature="${feature}"[^>]*id="${id}"`));
    };
    expectTag('nav-tab-windows', 'windows');
    expectTag('nav-tab-stash', 'stash');
    expectTag('nav-tab-sessions', 'sessions');
    expectTag('subtab-duplicates', 'duplicates');
    expectTag('btn-focus', 'focus');
    expectTag('btn-search', 'search');
    expectTag('btn-ai-status', 'ai');
    expectTag('btn-drive-status', 'drive');
    expectTag('command-bar', 'ai commandBar');
    expectTag('btn-smart-group', 'ai');
    expectTag('settings-ai-section', 'ai');
    expectTag('settings-drive-section', 'drive');
    expectTag('settings-bookmarks-section', 'bookmarks');
    expectTag('settings-automation-section', 'automation');
  });

  test('the Features card follows General, has a chip, and one toggle per feature', async () => {
    const html = await htmlPromise;
    expect(html.indexOf('id="settings-general-section"'))
      .toBeLessThan(html.indexOf('id="settings-features-section"'));
    expect(html.indexOf('id="settings-features-section"'))
      .toBeLessThan(html.indexOf('id="settings-sleep-section"'));
    expect(html).toContain('data-settings-target="settings-features-section"');
    const toggles = [...html.matchAll(/data-feature-setting="(\w+)"/g)].map((m) => m[1]);
    expect(toggles.sort()).toEqual([...FEATURE_KEYS].sort());
  });

  test('CSS hides switched-off controls, including ones rendered later', async () => {
    const css = await cssPromise;
    expect(css).toContain('.feature-off { display: none !important; }');
    for (const key of FEATURE_KEYS) {
      expect(css).toContain(`body[data-features-off~="${key}"] [data-feature~="${key}"]`);
    }
    expect(css).toContain('body[data-features-off~="stash"] .stash-btn');
    expect(css).toContain('body[data-features-off~="ai"] .ai-feature');
  });
});

describe('first-run walkthrough', () => {
  function walkthroughRoot() {
    const root = dom.el('section', { id: 'first-run-walkthrough' });
    for (const id of [
      'walkthrough-step', 'walkthrough-title', 'walkthrough-description',
      'walkthrough-action', 'walkthrough-back', 'walkthrough-next', 'walkthrough-dismiss',
    ]) dom.el('button', { id, parent: root });
    return root;
  }

  test('skips steps for switched-off features', () => {
    const root = walkthroughRoot();
    const enabled = { stash: false };
    const walkthrough = new FirstRunWalkthrough(root, {
      storage: { get: async () => ({}), set: async () => {} },
      notify() {},
      isFeatureEnabled: (name) => enabled[name] !== false,
    });
    walkthrough.launch();
    expect(root.querySelector('#walkthrough-step').textContent).toBe('1 of 2');
    walkthrough.next();
    expect(root.querySelector('#walkthrough-title').textContent).toBe('Group related tabs');
    expect(root.querySelector('#walkthrough-next').textContent).toBe('Finish');
    walkthrough.next();
    expect(root.hidden).toBe(true);

    enabled.stash = true;
    walkthrough.launch();
    expect(root.querySelector('#walkthrough-step').textContent).toBe('1 of 4');
  });
});

describe('Features settings card', () => {
  function featuresCard() {
    const root = dom.el('section', { id: 'view-settings' });
    const inputs = {};
    for (const key of FEATURE_KEYS) {
      const input = dom.el('input', { id: `feature-${key}`, parent: root });
      input.type = 'checkbox';
      input.dataset.featureSetting = key;
      inputs[key] = input;
    }
    const theme = dom.el('select', { id: 'setting-theme', parent: root });
    theme.dataset.setting = 'theme';
    return { root, inputs, theme };
  }

  test('renders the stored switches (missing read as on)', () => {
    const { root, inputs } = featuresCard();
    const manager = new SettingsManager(root, { notify() {} });
    manager.renderSettings({ theme: 'system', features: { ai: false } });
    expect(inputs.ai.checked).toBe(false);
    expect(inputs.drive.checked).toBe(true);
    manager.renderSettings({ theme: 'system' });
    expect(inputs.ai.checked).toBe(true);
  });

  test('a toggle saves immediately and applies live', async () => {
    const { root, inputs } = featuresCard();
    const sent = [];
    const applied = [];
    const manager = new SettingsManager(root, {
      notify() {},
      onFeaturesChanged: (features) => applied.push(features),
    });
    manager.send = async (msg) => {
      sent.push(msg);
      return { features: { ...ALL_ON, ...msg.settings.features } };
    };
    manager.renderSettings({ features: ALL_ON });

    inputs.stash.checked = false;
    inputs.stash.dispatchEvent({ type: 'change', bubbles: true, preventDefault() {}, stopPropagation() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toEqual([{
      action: 'saveSettings',
      settings: { features: { ...ALL_ON, stash: false } },
    }]);
    expect(applied).toEqual([{ ...ALL_ON, stash: false }]);
  });

  test('a failed save reports the error and does not apply', async () => {
    const { root, inputs } = featuresCard();
    const notes = [];
    const applied = [];
    const manager = new SettingsManager(root, {
      notify: (message, type) => notes.push([message, type]),
      onFeaturesChanged: (features) => applied.push(features),
    });
    manager.send = async () => { throw new Error('nope'); };
    inputs.ai.checked = false;
    await manager.saveFeaturesFromUI();
    expect(applied).toEqual([]);
    expect(notes[0]).toEqual(['Failed to save settings: nope', 'error']);
  });
});
