import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installFakeDom } from '../helpers/fake-dom.js';
import { installChromeMock } from '../helpers/chrome-mock.js';
import {
  AISettings,
  KEEP_AWAKE_PREVIEW_COUNT,
  aiSelectionToSettings,
  aiSettingsToSelection,
  filterKeepAwakeDomains,
} from '../../sidepanel/components/ai-settings.js';
import {
  SettingsManager,
  computeSectionScrollTop,
} from '../../sidepanel/components/settings-manager.js';
import {
  DRIVE_DISCONNECTED_MESSAGE,
  DriveSync,
  friendlyDriveConnectError,
} from '../../sidepanel/components/drive-sync.js';
import {
  FocusBanner,
  FocusPanel,
  PROFILE_ICONS,
  focusRemainingMs,
  shouldConfirmFocusEnd,
} from '../../sidepanel/components/focus-panel.js';
import { BUILTIN_PROFILES } from '../../core/focus-profiles.js';

const htmlPromise = Bun.file(new URL('../../sidepanel/panel.html', import.meta.url)).text();

async function settingsMarkup() {
  const html = await htmlPromise;
  const start = html.indexOf('<section id="view-settings"');
  return html.slice(start, html.indexOf('</section>', start));
}

let dom;
beforeEach(() => {
  dom = installFakeDom();
  dom.el('div', { id: 'toast-container' });
});
afterEach(() => dom.restore());

// ─────────────────────────── Settings markup ───────────────────────────

describe('U4 settings layout', () => {
  test('cards are ordered by frequency, ending with Backup & restore and About', async () => {
    const markup = await settingsMarkup();
    const order = [
      'settings-general-section',
      'settings-features-section',
      'settings-sleep-section',
      'settings-ai-section',
      'settings-automation-section',
      'settings-limits-section',
      'settings-bookmarks-section',
      'settings-drive-section',
      'settings-backup-section',
    ].map((id) => markup.indexOf(`id="${id}"`)).concat(markup.indexOf('about-section'));
    expect(order.every((index) => index >= 0)).toBeTrue();
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('sticky index chips target existing sections', async () => {
    const markup = await settingsMarkup();
    expect(markup).toContain('class="settings-index"');
    const targets = [...markup.matchAll(/data-settings-target="([\w-]+)"/g)].map((m) => m[1]);
    expect(targets).toEqual([
      'settings-general-section',
      'settings-features-section',
      'settings-sleep-section',
      'settings-ai-section',
      'settings-automation-section',
      'settings-bookmarks-section',
      'settings-drive-section',
    ]);
    for (const id of targets) expect(markup).toContain(`id="${id}"`);
  });

  test('advanced groups are collapsed <details> by default', async () => {
    const markup = await settingsMarkup();
    expect(markup).toMatch(/<details class="[^"]*settings-card-collapsible[^"]*" id="settings-limits-section">/);
    expect(markup).toContain('<details class="settings-subdetails" id="settings-bookmark-formats">');
    expect(markup).toContain('<details class="settings-subdetails" id="settings-drive-retention">');
    expect(markup).not.toMatch(/<details[^>]*\sopen[\s>]/);
    // Retention row id kept for SettingsManager.updateRetentionState.
    expect(markup).toContain('id="drive-retention-row"');
  });

  test('AI uses the provider select with Off first; no enable checkbox', async () => {
    const markup = await settingsMarkup();
    expect(markup).not.toContain('id="ai-enabled"');
    expect(markup).toMatch(/<select id="ai-provider"[^>]*>\s*<option value="">Off<\/option>/);
    // The select lives outside the collapsible config so it is always reachable.
    expect(markup.indexOf('id="ai-provider"')).toBeLessThan(markup.indexOf('id="ai-config"'));
  });

  test('Export/Import live in Backup & restore; Sync Now starts hidden', async () => {
    const markup = await settingsMarkup();
    const backup = markup.slice(markup.indexOf('id="settings-backup-section"'));
    expect(backup).toContain('id="btn-export-settings"');
    expect(backup).toContain('id="btn-import-settings"');
    const general = markup.slice(
      markup.indexOf('id="settings-general-section"'),
      markup.indexOf('id="settings-sleep-section"'),
    );
    expect(general).not.toContain('btn-export-settings');
    expect(markup).toMatch(/<button id="btn-sync-now"[^>]*\bhidden\b/);
  });

  test('settings markup has no inline style attributes and labels its fields', async () => {
    const markup = await settingsMarkup();
    expect(markup).not.toMatch(/\sstyle="/);
    const ids = [...markup.matchAll(/<(?:input|select)[^>]*\sid="([\w-]+)"[^>]*class="(?:setting-number|setting-select)/g)]
      .map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      const labelled = markup.includes(`for="${id}"`) || new RegExp(`id="${id}"[^>]*aria-label=`).test(markup);
      expect(labelled).toBeTrue();
    }
    expect(markup).toContain('for="keep-awake-domain-input"');
    expect(markup).toContain('for="keep-awake-filter"');
  });
});

// ─────────────────────────── AI select contract ───────────────────────────

describe('U4 AI provider select maps to stored enabled + providerId', () => {
  test('selection helpers', () => {
    expect(aiSelectionToSettings('openai', null)).toEqual({ enabled: true, providerId: 'openai' });
    expect(aiSelectionToSettings('', 'claude')).toEqual({ enabled: false, providerId: 'claude' });
    expect(aiSelectionToSettings('', null)).toEqual({ enabled: false, providerId: null });
    expect(aiSettingsToSelection({ enabled: true, providerId: 'gemini' })).toBe('gemini');
    expect(aiSettingsToSelection({ enabled: false, providerId: 'gemini' })).toBe('');
    expect(aiSettingsToSelection({ enabled: true, providerId: null })).toBe('');
    expect(aiSettingsToSelection(null)).toBe('');
  });

  function aiManager(selected, currentSettings) {
    const manager = Object.create(AISettings.prototype);
    manager.root = { querySelector: () => null, querySelectorAll: () => [] };
    manager.providerSelect = { value: selected, disabled: false };
    manager.passphraseToggle = { checked: false, indeterminate: false, disabled: false };
    manager.passphraseInput = { value: '', disabled: false };
    manager.currentSettings = currentSettings;
    manager.providerSettings = currentSettings.providerConfigs;
    manager.refresh = async () => true;
    manager.onAvailabilityChanged = async () => {};
    const sent = [];
    manager.send = async (message) => {
      sent.push(message);
      return { saved: true, unlocked: true };
    };
    return { manager, sent };
  }

  test('saving "Off" disables AI and keeps the last provider', async () => {
    const { manager, sent } = aiManager('', {
      enabled: true,
      providerId: 'claude',
      protectionMode: 'device',
      providerConfigs: {},
    });
    expect(await manager.saveSettings()).toBeTrue();
    expect(sent[0].action).toBe('saveAISettings');
    expect(sent[0].settings.enabled).toBe(false);
    expect(sent[0].settings.providerId).toBe('claude');
  });

  test('saving a provider enables AI with that provider', async () => {
    const { manager, sent } = aiManager('gemini', {
      enabled: false,
      providerId: null,
      protectionMode: 'device',
      providerConfigs: {},
    });
    expect(await manager.saveSettings()).toBeTrue();
    expect(sent[0].settings).toMatchObject({ enabled: true, providerId: 'gemini' });
  });

  test('picking a provider expands config; Off collapses it and hides Test', () => {
    const manager = Object.create(AISettings.prototype);
    manager.providerSelect = { value: 'openai' };
    manager.providerPanels = { openai: { hidden: true }, claude: { hidden: true } };
    manager.configSection = { hidden: true };
    manager.testButton = { hidden: true };
    manager.offHintEl = { hidden: false, textContent: '' };
    manager.currentSettings = { enabled: true };

    manager.showProviderConfig();
    expect(manager.configSection.hidden).toBeFalse();
    expect(manager.providerPanels.openai.hidden).toBeFalse();
    expect(manager.providerPanels.claude.hidden).toBeTrue();
    expect(manager.testButton.hidden).toBeFalse();
    expect(manager.offHintEl.hidden).toBeTrue();

    manager.providerSelect.value = '';
    manager.showProviderConfig();
    expect(manager.configSection.hidden).toBeTrue();
    expect(manager.testButton.hidden).toBeTrue();
    expect(manager.offHintEl.hidden).toBeFalse();
    expect(manager.offHintEl.textContent).toContain('Save to turn AI off');
  });
});

// ─────────────────────────── Keep-awake list ───────────────────────────

describe('U4 keep-awake list', () => {
  function keepAwakeManager() {
    const manager = Object.create(AISettings.prototype);
    manager.keepAwakeListEl = dom.el('div', { id: 'keep-awake-domain-list' });
    manager.keepAwakeCountEl = dom.el('span', { id: 'keep-awake-count' });
    manager.keepAwakeFilterEl = dom.el('input', { id: 'keep-awake-filter' });
    manager.keepAwakeShowAllBtn = dom.el('button', { id: 'btn-keep-awake-show-all' });
    manager.keepAwakeShowAll = false;
    return manager;
  }

  const domains = Array.from({ length: 37 }, (_, i) => `site${String(i).padStart(2, '0')}.com`);

  test('shows a count, a preview, and Show all', () => {
    const manager = keepAwakeManager();
    manager.renderKeepAwakeList(domains);
    expect(manager.keepAwakeCountEl.textContent).toBe('37 domains');
    expect(manager.keepAwakeListEl.children).toHaveLength(KEEP_AWAKE_PREVIEW_COUNT);
    expect(manager.keepAwakeShowAllBtn.hidden).toBeFalse();
    expect(manager.keepAwakeShowAllBtn.textContent).toBe('Show all 37');

    manager.keepAwakeShowAll = true;
    manager.renderKeepAwakeRows();
    expect(manager.keepAwakeListEl.children).toHaveLength(37);
  });

  test('filter narrows the list and the count', () => {
    const manager = keepAwakeManager();
    manager.renderKeepAwakeList(domains);
    manager.keepAwakeFilterEl.value = 'SITE1';
    manager.renderKeepAwakeRows();
    expect(manager.keepAwakeListEl.children).toHaveLength(10);
    expect(manager.keepAwakeCountEl.textContent).toBe('10 of 37 domains');
    expect(manager.keepAwakeShowAllBtn.hidden).toBeTrue();
    expect(filterKeepAwakeDomains(['b.com', 'a.com'], '')).toEqual(['a.com', 'b.com']);
  });

  test('remove buttons carry an accessible name', () => {
    const manager = keepAwakeManager();
    manager.renderKeepAwakeList(['slack.com']);
    expect(manager.keepAwakeCountEl.textContent).toBe('1 domain');
    const removeBtn = manager.keepAwakeListEl.children[0].children[1];
    expect(removeBtn.getAttribute('aria-label')).toBe('Remove slack.com from keep-awake list');
    expect(removeBtn.className).toBe('remove-btn');
  });
});

// ─────────────────────────── Index scrolling ───────────────────────────

describe('U4 settings index', () => {
  test('scroll offset clears the sticky index', () => {
    expect(computeSectionScrollTop({
      containerScrollTop: 100, containerTop: 200, sectionTop: 650, stickyHeight: 40, gap: 8,
    })).toBe(502);
    expect(computeSectionScrollTop({ sectionTop: 10, stickyHeight: 40 })).toBe(0);
  });

  test('chip click scrolls the view container (not the page) and opens collapsed sections', () => {
    const container = dom.el('div', { className: 'view-container' });
    const root = dom.el('section', { id: 'view-settings', parent: container });
    const index = dom.el('nav', { id: 'settings-index', parent: root });
    const chip = dom.el('button', { parent: index });
    chip.dataset.settingsTarget = 'settings-limits-section';
    const section = dom.el('details', { id: 'settings-limits-section', parent: root });
    section.open = false;
    const scrolls = [];
    container.scrollTop = 0;
    container.scrollTo = (options) => scrolls.push(options);
    container.getBoundingClientRect = () => ({ top: 100 });
    section.getBoundingClientRect = () => ({ top: 700 });
    let rootScrolled = false;
    section.scrollIntoView = () => { rootScrolled = true; };

    const manager = new SettingsManager(root, { confirm: async () => true, notify() {} });
    chip.click();

    expect(section.open).toBeTrue();
    expect(rootScrolled).toBeFalse();
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0].top).toBe(592);
    expect(chip.getAttribute('aria-current')).toBe('true');
    expect(manager.scrollToSection('missing-section')).toBeNull();
  });
});

// ─────────────────────────── Drive ───────────────────────────

describe('U4 Drive card', () => {
  function driveUI() {
    const root = dom.el('div');
    const els = {};
    for (const [tag, id] of [
      ['div', 'drive-status'], ['button', 'btn-connect-drive'], ['button', 'btn-sync-now'],
      ['button', 'btn-disconnect-drive'], ['div', 'drive-settings-connected'],
    ]) els[id] = dom.el(tag, { id, parent: root });
    return { drive: new DriveSync(root, { notify() {}, confirm: async () => true }), els };
  }

  test('Sync Now is hidden until connected, like Disconnect', () => {
    const { drive, els } = driveUI();
    drive.updateUI({ connected: false });
    expect(els['btn-sync-now'].hidden).toBeTrue();
    expect(els['btn-disconnect-drive'].hidden).toBeTrue();
    expect(els['btn-connect-drive'].hidden).toBeFalse();
    expect(els['drive-status'].textContent).toBe(DRIVE_DISCONNECTED_MESSAGE);

    drive.updateUI({ connected: true, lastSyncedAt: null });
    expect(els['btn-sync-now'].hidden).toBeFalse();
    expect(els['btn-sync-now'].disabled).toBeFalse();
    expect(els['btn-disconnect-drive'].hidden).toBeFalse();
    expect(els['btn-connect-drive'].hidden).toBeTrue();
  });

  test('known chrome.identity errors become actionable copy', () => {
    expect(friendlyDriveConnectError(new Error('The user turned off browser signin')))
      .toContain('Sign in to Chrome first');
    expect(friendlyDriveConnectError(new Error('The user did not approve access.')))
      .toContain('not granted');
    expect(friendlyDriveConnectError(new Error('quota'))).toBe('Failed to connect: quota');
  });
});

// ─────────────────────────── Focus ───────────────────────────

function fakeContainer() {
  const elements = new Map();
  const make = () => ({
    listeners: {},
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    textContent: '',
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); },
    setAttribute() {},
    querySelectorAll() { return []; },
  });
  return {
    innerHTML: '',
    elements,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, make());
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
  };
}

function focusPanel(overrides = {}) {
  const panel = Object.create(FocusPanel.prototype);
  Object.assign(panel, {
    container: fakeContainer(),
    profiles: BUILTIN_PROFILES,
    settings: {},
    _profilePrefs: {},
    timerInterval: null,
    notify() {},
    ...overrides,
  });
  return panel;
}

describe('U4 focus setup', () => {
  async function renderSetup(aiAvailable) {
    installChromeMock();
    const panel = focusPanel();
    panel.send = async ({ action }) => {
      if (action === 'isAIAvailable') return { available: aiAvailable };
      if (action === 'getFocusHistory') return [];
      return null;
    };
    await panel._renderSetup();
    return panel;
  }

  test('profile chips, duration and Start come before the Customize section', async () => {
    const panel = await renderSetup(true);
    const html = panel.container.innerHTML;
    const order = [
      'focus-profile-picker', 'id="focus-duration"', 'id="btn-start-focus"',
      'id="focus-customize"', 'name="focus-action"', 'id="focus-category-chips"',
      'id="focus-allowlist-tags"', 'id="focus-blocked-tags"',
    ].map((needle) => html.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBeTrue();
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('<label class="focus-label" for="focus-duration">');
  });

  test('profile icons are SVGs, not "?" or ">>" glyphs', async () => {
    const panel = await renderSetup(true);
    const html = panel.container.innerHTML;
    expect(html).not.toContain('<span class="focus-profile-icon" aria-hidden="true">?</span>');
    expect(html).not.toContain('&gt;&gt;');
    for (const id of ['coding', 'writing', 'research', 'meeting']) {
      expect(PROFILE_ICONS[id]).toStartWith('<svg');
      expect(html).toContain(PROFILE_ICONS[id]);
    }
  });

  test('AI Detection is disabled with a setup path when no AI is configured', async () => {
    const panel = await renderSetup(false);
    const checkbox = panel.container.elements.get('#focus-ai-blocking');
    expect(checkbox.disabled).toBeTrue();
    expect(checkbox.checked).toBeFalse();
    expect(panel.container.elements.get('#focus-ai-hint').textContent).toBe('Set up AI to use this');
    expect(panel.container.elements.get('#btn-focus-setup-ai').hidden).toBeFalse();
    expect(panel.container.elements.get('#focus-ai-row').hidden).toBeFalse();

    const ready = await renderSetup(true);
    expect(ready.container.elements.get('#focus-ai-blocking').disabled).toBeFalse();
    expect(ready.container.elements.get('#btn-focus-setup-ai').hidden).toBeTrue();
  });

  test('active category chips are pressed accent chips with a check', () => {
    const panel = focusPanel();
    panel._blockedCategories = ['social'];
    const chips = { innerHTML: '', querySelectorAll: () => [] };
    panel.container.querySelector = (selector) => (selector === '#focus-category-chips' ? chips : null);
    panel._renderCategoryChips();
    expect(chips.innerHTML).toMatch(/focus-category-chip active"\s+data-category="social" aria-pressed="true"/);
    expect(chips.innerHTML).toContain('aria-pressed="false"');
    expect(chips.innerHTML).toContain('focus-category-check');
  });
});

describe('U4 focus HUD', () => {
  function hudState(overrides = {}) {
    return {
      status: 'active',
      runId: 'run-1',
      duration: 50,
      startedAt: Date.now(),
      pausedElapsed: 0,
      profileName: 'Coding',
      profileColor: 'cyan',
      distractionsBlocked: 0,
      focusTabCount: 6,
      ...overrides,
    };
  }

  test('uses theme tokens and puts the percent inline with the timer', () => {
    const panel = focusPanel({ state: hudState() });
    panel._renderHUD();
    panel._stopTimer();
    const html = panel.container.innerHTML;
    expect(html).toContain('--focus-profile-color: var(--focus-accent');
    expect(html).not.toMatch(/#22d3ee|#a78bfa|#34d399|#60a5fa/);
    expect(html).toMatch(/<div class="focus-timer-sub">remaining · <span class="focus-progress-pct" id="focus-pct">0%<\/span><\/div>/);
    expect(html).toContain('role="progressbar"');
    expect(panel._getProfileColor('green')).toBe('var(--focus-green, #047857)');
  });

  test('ending a timed run early asks first; declining keeps the run', async () => {
    const asked = [];
    const sent = [];
    const panel = focusPanel({ state: hudState() });
    panel.confirm = async (options) => { asked.push(options); return false; };
    panel.send = async (message) => { sent.push(message); return null; };
    expect(await panel.requestEnd()).toBeFalse();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ title: 'End focus early?', confirmLabel: 'End session', danger: true });
    expect(asked[0].message).toMatch(/^You have (?:50:00|4\d:\d\d) left\. Your stats so far will be saved\.$/);
    expect(sent).toEqual([]);
  });

  test('confirming ends the run and shows the report', async () => {
    const panel = focusPanel({ state: hudState() });
    panel.confirm = async () => true;
    const sent = [];
    panel.send = async (message) => {
      sent.push(message);
      return { profileName: 'Coding', actualDurationMs: 60_000, distractionsBlocked: 1, focusTabCount: 2 };
    };
    expect(await panel.requestEnd()).toBeTrue();
    expect(sent[0]).toMatchObject({ action: 'endFocus', expectedRunId: 'run-1' });
    expect(panel.state).toBeNull();
    expect(panel.container.innerHTML).toContain('Focus Session Complete');
  });

  test('open-ended runs and the last minute end without a confirm', () => {
    expect(shouldConfirmFocusEnd(hudState({ duration: 0 }))).toBeFalse();
    const now = Date.now();
    expect(shouldConfirmFocusEnd(hudState({ duration: 1, startedAt: now - 30_000 }), now)).toBeFalse();
    expect(shouldConfirmFocusEnd(hudState({ duration: 25, startedAt: now }), now)).toBeTrue();
    // A paused run's clock stops at pausedAt.
    const paused = hudState({ status: 'paused', duration: 10, startedAt: now - 300_000, pausedAt: now - 240_000 });
    expect(focusRemainingMs(paused, now)).toBe(540_000);
  });
});

describe('U4 focus banner', () => {
  test('describes the run and follows FocusPanel state', () => {
    const now = Date.now();
    expect(FocusBanner.describe({
      status: 'active', profileName: 'Coding', duration: 50, startedAt: now - 2_000, pausedElapsed: 0,
    }, now)).toBe('Focus · Coding · 49:58 left');
    expect(FocusBanner.describe({
      status: 'paused', profileName: 'Writing', duration: 0, startedAt: now - 65_000, pausedAt: now, pausedElapsed: 0,
    }, now)).toBe('Focus · Writing · 1:05 elapsed · paused');

    const root = dom.el('section', { id: 'view-focus' });
    dom.el('div', { id: 'focus-container', parent: root });
    const panel = new FocusPanel(root, { listenForRuntimeEvents: false });
    const anchor = dom.el('div', { className: 'view-container' });
    const inserted = [];
    anchor.before = (el) => inserted.push(el);
    expect(panel.mountBanner(anchor)).toBe(panel.banner.el);
    expect(inserted).toEqual([panel.banner.el]);
    expect(panel.banner.el.hidden).toBeTrue();

    panel.state = { status: 'active', profileName: 'Coding', duration: 25, startedAt: Date.now(), pausedElapsed: 0 };
    expect(panel.banner.el.hidden).toBeFalse();
    panel.state = null;
    expect(panel.banner.el.hidden).toBeTrue();
    expect(panel.banner.timer).toBeNull();
  });
});
