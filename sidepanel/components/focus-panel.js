// sidepanel/components/focus-panel.js — Focus Mode UI: setup, timer HUD, report, history

import { showToast } from './toast.js';
import { showConfirm } from './confirm-dialog.js';
import {
  createAllowlistEntry,
  normalizeAllowlistPreferences,
  normalizeBlockedDomain,
  normalizeBlockedDomains,
} from '../../core/focus-policy.js';
import { createFocusRunCommand, handleFocusPanelMessage } from '../focus-events.js';
import { sendOrThrow } from '../message-client.js';
import { renderActionableEmptyState } from './actionable-empty-state.js';

const PROFILE_PREFS_KEY = 'focusProfilePrefs';
const CUSTOMIZE_OPEN_KEY = 'tabkebab.focusCustomizeOpen';
/** Ending a timed run with more than this left asks for confirmation. */
export const END_CONFIRM_THRESHOLD_MS = 60_000;

const SVG_ATTRS = 'width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

/** Inline SVG icons for the built-in profiles (text glyphs read as placeholders). */
export const PROFILE_ICONS = Object.freeze({
  coding: `<svg ${SVG_ATTRS}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  writing: `<svg ${SVG_ATTRS}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  research: `<svg ${SVG_ATTRS}><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  meeting: `<svg ${SVG_ATTRS}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
});

/** Theme tokens for profile colours. Cyan maps to the contrast-safe Focus accent. */
const PROFILE_COLOR_TOKENS = Object.freeze({
  cyan: 'var(--focus-accent, var(--focus-cyan, #0e7490))',
  purple: 'var(--focus-purple, #8b5cf6)',
  green: 'var(--focus-green, #047857)',
  blue: 'var(--focus-blue, #2563eb)',
});

const BLOCK_CATEGORIES = Object.freeze([
  { id: 'social', name: 'Social Media', icon: '💬' },
  { id: 'video', name: 'Video', icon: '📺' },
  { id: 'gaming', name: 'Gaming', icon: '🎮' },
  { id: 'news', name: 'News', icon: '📰' },
  { id: 'shopping', name: 'Shopping', icon: '🛒' },
  { id: 'entertainment', name: 'Entertainment', icon: '🎭' },
]);

function readCustomizeOpen() {
  try {
    return globalThis.localStorage?.getItem(CUSTOMIZE_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCustomizeOpen(open) {
  try {
    globalThis.localStorage?.setItem(CUSTOMIZE_OPEN_KEY, open ? '1' : '0');
  } catch {}
}

/** Milliseconds the run has been focusing; a paused run is frozen at pausedAt. */
export function focusElapsedMs(state, now = Date.now()) {
  if (!state) return 0;
  const stoppedAt = state.status === 'paused' && Number.isFinite(state.pausedAt)
    ? state.pausedAt
    : now;
  return Math.max(0, stoppedAt - (state.startedAt || 0) - (state.pausedElapsed || 0));
}

/** Remaining milliseconds for a timed run, or null for an open-ended one. */
export function focusRemainingMs(state, now = Date.now()) {
  if (!state || !(Number(state.duration) > 0)) return null;
  return Math.max(0, state.duration * 60_000 - focusElapsedMs(state, now));
}

/** Whether ending this run now should ask "End focus early?" first. */
export function shouldConfirmFocusEnd(state, now = Date.now()) {
  const remaining = focusRemainingMs(state, now);
  return remaining !== null && remaining > END_CONFIRM_THRESHOLD_MS;
}

function formatClock(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A slim cross-view cue ("Focus · Coding · 49:58 left · End") shown while a
 * run is active. The element is created here; the shell mounts it once with
 * FocusPanel#mountBanner(beforeEl). CSS hides it while the Focus view is open.
 */
export class FocusBanner {
  constructor({ onOpen = null, onEnd = null } = {}) {
    this.onOpen = onOpen;
    this.onEnd = onEnd;
    this.state = null;
    this.timer = null;
    this.el = null;
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      this.el = document.createElement('div');
      this.el.className = 'focus-banner';
      this.el.id = 'focus-banner';
      this.el.hidden = true;
      this.el.setAttribute?.('role', 'region');
      this.el.setAttribute?.('aria-label', 'Focus session');
      this.el.innerHTML = `
        <button type="button" class="focus-banner-open" data-focus-banner="open">
          <span class="focus-banner-dot" aria-hidden="true"></span>
          <span class="focus-banner-text"></span>
        </button>
        <button type="button" class="focus-banner-end" data-focus-banner="end">End</button>
      `;
      this.el.addEventListener?.('click', (event) => {
        const action = event.target?.closest?.('[data-focus-banner]')?.dataset.focusBanner;
        if (action === 'open') this.onOpen?.();
        if (action === 'end') this.onEnd?.();
      });
    }
  }

  /** Text for the banner, e.g. "Focus · Coding · 49:58 left". */
  static describe(state, now = Date.now()) {
    if (!state) return '';
    const name = state.profileName || 'Focus';
    const remaining = focusRemainingMs(state, now);
    const time = remaining === null
      ? `${formatClock(focusElapsedMs(state, now))} elapsed`
      : `${formatClock(remaining)} left`;
    const paused = state.status === 'paused' ? ' · paused' : '';
    return `Focus · ${name} · ${time}${paused}`;
  }

  update(state) {
    const active = state?.status === 'active' || state?.status === 'paused';
    this.state = active ? state : null;
    if (!this.el) return;
    this.el.hidden = !active;
    this.el.classList?.toggle?.('paused', state?.status === 'paused');
    this._tick();
    if (active && !this.timer) {
      this.timer = setInterval(() => this._tick(), 1000);
    } else if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _tick() {
    const text = this.el?.querySelector?.('.focus-banner-text');
    if (text) text.textContent = FocusBanner.describe(this.state);
  }
}

/**
 * Start a new render of the panel container. Returns a predicate that turns
 * true once any later render (setup, HUD or report) has replaced this one, so
 * a superseded async render stops before wiring events onto the new DOM.
 */
function beginRender(panel) {
  const generation = (panel._renderGeneration || 0) + 1;
  panel._renderGeneration = generation;
  return () => generation !== panel._renderGeneration;
}

export class FocusPanel {
  constructor(rootEl, {
    listenForRuntimeEvents = true,
    notify = showToast,
    confirm = showConfirm,
    navigate = null,
  } = {}) {
    this.root = rootEl;
    this.container = rootEl.querySelector('#focus-container');
    this.confirm = confirm;
    this.navigate = navigate;
    this.banner = new FocusBanner({
      onOpen: () => this._openFocusView(),
      onEnd: () => {
        // The banner may show a run started in another window's panel; its
        // state (from durable storage) is the run the user is ending.
        const shown = this.banner?.state;
        if (shown?.runId && this.state?.runId !== shown.runId) this.state = shown;
        void this.requestEnd().catch((err) => {
          showToast('Failed to end focus session: ' + err.message, 'error');
        });
      },
    });
    this.state = null;
    this.profiles = [];
    this.timerInterval = null;
    this._profilePrefs = {};
    this.notify = notify;
    // Monotonic tokens: a slower, superseded async render or preference load
    // must never wire events or apply state over a newer one.
    this._renderGeneration = 0;
    this._refreshSeq = 0;
    this._prefsLoadSeq = 0;

    // Listen for focus events from service worker
    if (listenForRuntimeEvents) {
      chrome.runtime.onMessage.addListener((msg) => this.handleFocusMessage(msg));
    }
  }

  /** Run state; every assignment also refreshes the cross-view banner. */
  get state() {
    return this._state ?? null;
  }

  set state(value) {
    this._state = value ?? null;
    this.banner?.update?.(this._state);
  }

  /** Insert the cross-view Focus banner before `beforeEl` (e.g. .view-container). */
  mountBanner(beforeEl) {
    const el = this.banner?.el;
    if (!el || !beforeEl) return null;
    if (typeof beforeEl.before === 'function') beforeEl.before(el);
    else if (beforeEl.parentNode?.insertBefore) beforeEl.parentNode.insertBefore(el, beforeEl);
    else return null;
    this.banner.update(this.state);
    return el;
  }

  _openFocusView() {
    if (typeof this.navigate === 'function') {
      this.navigate({ view: 'focus' });
      return;
    }
    globalThis.document?.getElementById?.('btn-focus')?.click?.();
  }

  _openAISettings() {
    if (typeof this.navigate === 'function') {
      this.navigate({ view: 'settings', sectionId: 'settings-ai-section' });
      return;
    }
    // The header AI status icon already opens Settings at the AI section.
    globalThis.document?.getElementById?.('btn-ai-status')?.click?.();
  }

  handleFocusMessage(msg) {
    return handleFocusPanelMessage(msg, this);
  }

  async refresh() {
    this._stopTimer();
    const refreshSeq = (this._refreshSeq || 0) + 1;
    this._refreshSeq = refreshSeq;
    const state = await this.send({ action: 'getFocusState' });
    const profiles = await this.send({ action: 'getFocusProfiles' });
    const settings = await this.send({ action: 'getSettings' });
    if (refreshSeq !== this._refreshSeq) return;
    this.state = state;
    this.profiles = profiles;
    this.settings = settings;

    if (this.state?.status === 'active' || this.state?.status === 'paused') {
      this._renderHUD();
    } else {
      await this._renderSetup();
    }
  }

  // ── Setup View ──

  async _renderSetup() {
    const isStale = beginRender(this);
    if (!this.profiles.length) {
      renderActionableEmptyState(this.container, {
        message: 'Focus profiles are unavailable, so a focus session cannot start yet.',
        actionLabel: 'Retry profiles',
        onAction: async () => {
          try {
            await this.refresh();
          } catch (error) {
            this.notify(
              `Failed to load focus profiles: ${error?.message || String(error)}`,
              'error',
            );
          }
        },
      });
      return;
    }

    const settings = this.settings || {};
    const defaultProfile = settings.focusDefaultProfile || 'coding';
    const defaultDuration = settings.focusDefaultDuration || 25;
    const defaultAction = settings.focusTabAction || 'kebab';
    const profile = this.profiles.find(p => p.id === defaultProfile) || this.profiles[0];

    const customizeOpen = readCustomizeOpen();
    this.container.innerHTML = `
      <div class="focus-setup">
        <h2 class="focus-title">Start Focus Session</h2>

        <div class="focus-profile-picker" role="group" aria-label="Focus profile">
          ${this.profiles.map(p => `
            <button type="button" class="focus-profile-chip ${p.id === profile.id ? 'active' : ''}"
                    data-profile="${this._esc(p.id)}"
                    aria-pressed="${p.id === profile.id ? 'true' : 'false'}"
                    style="--profile-color: ${this._getProfileColor(p.color)}">
              <span class="focus-profile-icon" aria-hidden="true">${this._profileIcon(p)}</span>
              <span>${this._esc(p.name)}</span>
            </button>
          `).join('')}
        </div>

        <div class="focus-duration-row">
          <label class="focus-label" for="focus-duration">Duration</label>
          <input type="number" id="focus-duration" class="input focus-duration-input" value="${profile.suggestedDuration || defaultDuration}" min="1" max="480">
          <span class="focus-unit">min</span>
          <label class="focus-open-ended-label">
            <input type="checkbox" id="focus-open-ended">
            Open-ended
          </label>
        </div>

        <button type="button" class="action-btn focus-start-btn" id="btn-start-focus">Start Focus</button>

        <details class="focus-customize" id="focus-customize"${customizeOpen ? ' open' : ''}>
          <summary class="focus-customize-summary">Customize</summary>
          <div class="focus-customize-body">
            <fieldset class="focus-action-section">
              <legend class="focus-label">When focus starts</legend>
              <div class="focus-radio-group">
                <label><input type="radio" name="focus-action" value="kebab" ${defaultAction === 'kebab' ? 'checked' : ''}> Kebab non-focus tabs</label>
                <label><input type="radio" name="focus-action" value="stash" ${defaultAction === 'stash' ? 'checked' : ''}> Stash non-focus tabs</label>
                <label><input type="radio" name="focus-action" value="group" ${defaultAction === 'group' ? 'checked' : ''}> Group focus tabs only</label>
                <label><input type="radio" name="focus-action" value="none" ${defaultAction === 'none' ? 'checked' : ''}> Do nothing (monitor only)</label>
              </div>
            </fieldset>

            <div class="focus-blocking-section">
              <span class="focus-label">Blocking</span>
              <div class="focus-blocking-options">
                <label class="focus-toggle-row">
                  <input type="checkbox" id="focus-strict-mode">
                  <span class="focus-toggle-label">Strict Mode</span>
                  <span class="focus-toggle-hint">Block everything except allowed entries</span>
                </label>
                <div class="focus-toggle-row focus-ai-row" id="focus-ai-row">
                  <input type="checkbox" id="focus-ai-blocking" aria-describedby="focus-ai-hint" disabled>
                  <label class="focus-toggle-label" for="focus-ai-blocking">AI Detection</label>
                  <span class="focus-toggle-hint" id="focus-ai-hint">Checking AI…</span>
                  <button type="button" class="settings-link-btn focus-ai-setup" id="btn-focus-setup-ai" hidden>Set up AI</button>
                </div>
              </div>
              <div class="focus-categories">
                <span class="focus-label" id="focus-categories-label">Block categories</span>
                <div class="focus-category-chips" id="focus-category-chips" role="group" aria-labelledby="focus-categories-label"></div>
              </div>
            </div>

            <div class="focus-allowlist-section">
              <span class="focus-label">Allowed (whitelist)</span>
              <p class="focus-hint">Domains include true subdomains, URLs are exact, and Chrome groups rebind by exact title at each run.</p>
              <div class="focus-allowlist-tags" id="focus-allowlist-tags"></div>
              <div class="focus-allowlist-add">
                <select id="focus-add-type" class="input focus-add-type-select" aria-label="Allowed entry type">
                  <option value="domain">Domain</option>
                  <option value="url">URL</option>
                  <option value="group">Chrome Group</option>
                </select>
                <input type="text" id="focus-add-value" class="input" placeholder="e.g. github.com" aria-label="Allowed domain or URL">
                <select id="focus-add-group" class="input" aria-label="Allowed Chrome group" hidden></select>
                <button type="button" class="action-btn secondary focus-add-btn" id="btn-add-allowlist" aria-label="Add to allowed list">+</button>
              </div>
            </div>

            <div class="focus-domains-section">
              <div class="focus-domain-group">
                <span class="focus-label">Blocked domains (additional)</span>
                <div class="focus-domain-tags" id="focus-blocked-tags"></div>
                <div class="focus-domain-add">
                  <input type="text" id="focus-add-blocked" class="input" placeholder="Add domain..." aria-label="Domain to block">
                  <button type="button" class="action-btn secondary focus-add-btn" id="btn-add-blocked" aria-label="Add blocked domain">+</button>
                </div>
              </div>
            </div>
          </div>
        </details>

        <div class="focus-history-section">
          <button type="button" class="focus-subtitle focus-history-toggle" id="focus-history-toggle" aria-expanded="false" aria-controls="focus-history-list">Recent Sessions</button>
          <div id="focus-history-list" class="focus-history-list" hidden></div>
        </div>
      </div>
    `;

    // Store current selections
    this._selectedProfile = profile;
    this._allowlist = normalizeAllowlistPreferences(profile.allowedDomains);
    this._blockedDomains = normalizeBlockedDomains(profile.blockedDomains);
    this._blockedCategories = [...(profile.blockedCategories || [])];
    this._strictMode = false;
    this._aiBlocking = false;
    this._chromeGroups = [];

    // Load saved preferences for default profile (overrides defaults)
    await this._loadProfilePrefs(profile.id);
    if (isStale()) return;

    // Update UI with loaded preferences
    const strictCb = this.container.querySelector('#focus-strict-mode');
    const aiCb = this.container.querySelector('#focus-ai-blocking');
    if (strictCb) strictCb.checked = this._strictMode;
    if (aiCb) aiCb.checked = this._aiAvailable === true && this._aiBlocking;

    await this._loadChromeGroups();
    if (isStale()) return;
    this._renderAllowlistTags();
    this._renderDomainTags();
    this._renderCategoryChips();
    await this._checkAIAvailability();
    if (isStale()) return;
    this._wireSetupEvents();
    await this._loadHistory();
  }

  async _loadChromeGroups() {
    try {
      const groups = await chrome.tabGroups.query({});
      this._chromeGroups = groups.map(g => ({
        id: g.id,
        title: g.title || '',
        displayTitle: g.title || `Group ${g.id} (untitled)`,
        color: g.color,
      }));
      this._updateGroupDropdown();
    } catch {
      this._chromeGroups = [];
      this._updateGroupDropdown();
    }
  }

  _updateGroupDropdown() {
    const select = this.container.querySelector('#focus-add-group');
    if (!select) return;
    select.innerHTML = this._chromeGroups.length === 0
      ? '<option value="">No groups available</option>'
      : this._chromeGroups.map(g =>
          `<option value="${g.id}">${this._esc(g.displayTitle)}</option>`
        ).join('');
  }

  async _loadAllProfilePrefs() {
    try {
      const result = await chrome.storage.local.get(PROFILE_PREFS_KEY);
      this._profilePrefs = result[PROFILE_PREFS_KEY] || {};
    } catch {
      this._profilePrefs = {};
    }
  }

  /**
   * Apply saved preferences for one profile. Returns false when a newer load
   * started while this one was pending, in which case nothing is applied.
   */
  async _loadProfilePrefs(profileId) {
    const loadSeq = (this._prefsLoadSeq || 0) + 1;
    this._prefsLoadSeq = loadSeq;
    await this._loadAllProfilePrefs();
    if (loadSeq !== this._prefsLoadSeq) return false;
    const prefs = this._profilePrefs[profileId];
    if (!prefs) return true;

    // Apply saved preferences
    if (prefs.blockedCategories) this._blockedCategories = [...prefs.blockedCategories];
    if (prefs.allowlist) {
      this._allowlist = normalizeAllowlistPreferences(prefs.allowlist);
    }
    if (prefs.blockedDomains) this._blockedDomains = normalizeBlockedDomains(prefs.blockedDomains);
    if (prefs.strictMode !== undefined) this._strictMode = prefs.strictMode;
    if (prefs.aiBlocking !== undefined) this._aiBlocking = prefs.aiBlocking;
    if (prefs.duration !== undefined) {
      const durInput = this.container.querySelector('#focus-duration');
      if (durInput) durInput.value = prefs.duration;
    }
    if (prefs.tabAction) {
      const radio = [...this.container.querySelectorAll('input[name="focus-action"]')]
        .find((input) => input.value === prefs.tabAction);
      if (radio) radio.checked = true;
    }
    return true;
  }

  async _saveProfilePrefs(profileId) {
    this._allowlist = normalizeAllowlistPreferences(this._allowlist);
    const prefs = {
      blockedCategories: this._blockedCategories,
      allowlist: this._allowlist,
      blockedDomains: this._blockedDomains,
      strictMode: this._strictMode,
      aiBlocking: this._aiBlocking,
      duration: parseInt(this.container.querySelector('#focus-duration')?.value) || 25,
      tabAction: this.container.querySelector('input[name="focus-action"]:checked')?.value || 'none',
    };
    await this.send({
      action: 'saveFocusProfilePrefs',
      profileId,
      preferences: prefs,
    });
    this._profilePrefs = { ...this._profilePrefs, [profileId]: prefs };
  }

  _renderAllowlistTags() {
    const container = this.container.querySelector('#focus-allowlist-tags');
    if (!container) return;

    if (this._allowlist.length === 0) {
      container.innerHTML = '<span class="focus-domain-empty">No items — non-strict allows all; strict blocks every non-internal page.</span>';
      return;
    }

    container.innerHTML = this._allowlist.map((entry, idx) => {
      const icon = entry.type === 'group' ? '📁' : entry.type === 'url' ? '🔗' : '🌐';
      const label = entry.type === 'group' ? entry.value : entry.value;
      return `
        <span class="focus-allowlist-tag" data-type="${entry.type}">
          <span class="focus-tag-icon" aria-hidden="true">${icon}</span>
          <span>${this._esc(label)}</span>
          <button type="button" class="focus-tag-remove" data-idx="${idx}" aria-label="Remove ${this._esc(label)} from allowed list">&times;</button>
        </span>
      `;
    }).join('');

    container.querySelectorAll('.focus-tag-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        this._allowlist.splice(idx, 1);
        this._renderAllowlistTags();
      });
    });
  }

  async _checkAIAvailability() {
    let available = false;
    try {
      const result = await this.send({ action: 'isAIAvailable' });
      available = result?.available === true;
    } catch {}
    this._applyAIAvailability(available);
    return available;
  }

  /**
   * AI Detection is always listed so the option is discoverable, but it is
   * disabled with a "Set up AI" path when no AI provider is usable.
   */
  _applyAIAvailability(available) {
    this._aiAvailable = available;
    const aiRow = this.container.querySelector('#focus-ai-row');
    const aiCb = this.container.querySelector('#focus-ai-blocking');
    const hint = this.container.querySelector('#focus-ai-hint');
    const setupBtn = this.container.querySelector('#btn-focus-setup-ai');
    if (aiRow) {
      aiRow.hidden = false;
      aiRow.classList?.toggle?.('disabled', !available);
    }
    if (aiCb) {
      aiCb.disabled = !available;
      aiCb.checked = available && this._aiBlocking === true;
    }
    if (hint) {
      hint.textContent = available
        ? 'Use AI to identify distracting sites'
        : 'Set up AI to use this';
    }
    if (setupBtn) setupBtn.hidden = available;
  }

  _renderCategoryChips() {
    const container = this.container.querySelector('#focus-category-chips');
    if (!container) return;

    container.innerHTML = BLOCK_CATEGORIES.map(cat => {
      const active = this._blockedCategories.includes(cat.id);
      return `
      <button type="button" class="focus-category-chip ${active ? 'active' : ''}"
              data-category="${cat.id}" aria-pressed="${active ? 'true' : 'false'}">
        <span class="focus-category-check" aria-hidden="true">✓</span>
        <span aria-hidden="true">${cat.icon}</span>
        <span>${cat.name}</span>
      </button>
    `;
    }).join('');

    container.querySelectorAll('.focus-category-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const catId = chip.dataset.category;
        if (this._blockedCategories.includes(catId)) {
          this._blockedCategories = this._blockedCategories.filter(c => c !== catId);
          chip.classList.remove('active');
          chip.setAttribute('aria-pressed', 'false');
        } else {
          this._blockedCategories.push(catId);
          chip.classList.add('active');
          chip.setAttribute('aria-pressed', 'true');
        }
      });
    });
  }

  _renderDomainTags() {
    const blockedEl = this.container.querySelector('#focus-blocked-tags');
    if (!blockedEl) return;
    blockedEl.innerHTML = this._blockedDomains.map(d =>
      `<span class="focus-domain-tag focus-domain-tag-blocked">${this._esc(d)}<button type="button" class="focus-tag-remove" data-type="blocked" data-domain="${this._esc(d)}" aria-label="Remove ${this._esc(d)} from blocked domains">&times;</button></span>`
    ).join('') || '<span class="focus-domain-empty">No domains blocked</span>';

    // Wire only the blocked-domain remove buttons; allowlist tags own theirs.
    blockedEl.querySelectorAll('.focus-tag-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const domain = btn.dataset.domain;
        this._blockedDomains = this._blockedDomains.filter(d => d !== domain);
        this._renderDomainTags();
      });
    });
  }

  _wireSetupEvents() {
    // Profile picker
    this.container.querySelectorAll('.focus-profile-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const profileId = chip.dataset.profile;
        const profile = this.profiles.find(p => p.id === profileId);
        if (!profile) return;
        this._selectedProfile = profile;

        // Set defaults from profile
        this._allowlist = normalizeAllowlistPreferences(profile.allowedDomains);
        this._blockedDomains = normalizeBlockedDomains(profile.blockedDomains);
        this._blockedCategories = [...(profile.blockedCategories || [])];
        this._strictMode = false;
        this._aiBlocking = false;

        const durInput = this.container.querySelector('#focus-duration');
        if (durInput) durInput.value = profile.suggestedDuration || 25;

        // Load saved preferences (overrides defaults). A newer chip click
        // supersedes this one; never apply or render its stale preferences.
        if (!await this._loadProfilePrefs(profileId)) return;

        this.container.querySelectorAll('.focus-profile-chip').forEach(c => {
          c.classList.remove('active');
          c.setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');

        // Update UI to reflect loaded preferences
        const strictCb = this.container.querySelector('#focus-strict-mode');
        const aiCb = this.container.querySelector('#focus-ai-blocking');
        if (strictCb) strictCb.checked = this._strictMode;
        if (aiCb) aiCb.checked = this._aiAvailable === true && this._aiBlocking;

        this._renderAllowlistTags();
        this._renderDomainTags();
        this._renderCategoryChips();
      });
    });

    // Open-ended toggle
    const openEndedCb = this.container.querySelector('#focus-open-ended');
    const durInput = this.container.querySelector('#focus-duration');
    if (openEndedCb && durInput) {
      openEndedCb.addEventListener('change', () => {
        durInput.disabled = openEndedCb.checked;
        if (openEndedCb.checked) durInput.value = '';
      });
    }

    // Allowlist type toggle
    const addTypeSelect = this.container.querySelector('#focus-add-type');
    const addValueInput = this.container.querySelector('#focus-add-value');
    const addGroupSelect = this.container.querySelector('#focus-add-group');
    if (addTypeSelect && addValueInput && addGroupSelect) {
      addTypeSelect.addEventListener('change', () => {
        const isGroup = addTypeSelect.value === 'group';
        addValueInput.hidden = isGroup;
        addGroupSelect.hidden = !isGroup;
        addValueInput.placeholder = isGroup
          ? ''
          : addTypeSelect.value === 'url' ? 'https://example.com/exact-path' : 'e.g. github.com';
      });
    }

    // Add to allowlist
    const addAllowlistBtn = this.container.querySelector('#btn-add-allowlist');
    addAllowlistBtn?.addEventListener('click', () => {
      const type = addTypeSelect?.value || 'domain';
      const value = type === 'group' ? addGroupSelect?.value : addValueInput?.value;
      const entry = createAllowlistEntry(type, value, this._chromeGroups);
      if (!entry) {
        showToast(
          type === 'group'
            ? 'Select a titled Chrome group.'
            : `Enter a valid ${type === 'url' ? 'absolute URL' : 'domain'}.`,
          'error',
        );
        return;
      }

      const duplicate = this._allowlist.some((candidate) => (
        candidate?.type === entry.type && candidate?.value === entry.value
      ));
      if (duplicate) {
        showToast('That allowlist entry already exists.', 'error');
        return;
      }

      this._allowlist.push(entry);
      if (type !== 'group') addValueInput.value = '';
      this._renderAllowlistTags();
    });

    // Add blocked domain
    const addBlocked = this.container.querySelector('#btn-add-blocked');
    const blockedInput = this.container.querySelector('#focus-add-blocked');
    const addBlockedDomain = () => {
      const raw = blockedInput?.value ?? '';
      if (!raw.trim()) return;
      const val = normalizeBlockedDomain(raw);
      if (!val) {
        showToast('Enter a valid domain.', 'error');
        return;
      }
      blockedInput.value = '';
      if (!this._blockedDomains.includes(val)) {
        this._blockedDomains.push(val);
        this._renderDomainTags();
      }
    };
    addBlocked?.addEventListener('click', addBlockedDomain);
    blockedInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBlockedDomain(); });

    // Start button
    this.container.querySelector('#btn-start-focus')?.addEventListener('click', () => this._startSession());

    // History toggle
    const historyToggle = this.container.querySelector('#focus-history-toggle');
    historyToggle?.addEventListener('click', () => {
      const list = this.container.querySelector('#focus-history-list');
      if (!list) return;
      list.hidden = !list.hidden;
      historyToggle.setAttribute?.('aria-expanded', String(!list.hidden));
    });

    // Customize section remembers its open state for this viewer.
    const customize = this.container.querySelector('#focus-customize');
    customize?.addEventListener('toggle', () => writeCustomizeOpen(customize.open === true));

    // AI Detection: route to Settings → AI when no provider is usable.
    this.container.querySelector('#btn-focus-setup-ai')
      ?.addEventListener('click', () => this._openAISettings());
  }

  async _startSession() {
    const openEnded = this.container.querySelector('#focus-open-ended')?.checked;
    const durInput = this.container.querySelector('#focus-duration');
    const duration = openEnded ? 0 : (parseInt(durInput?.value) || 25);
    const tabAction = this.container.querySelector('input[name="focus-action"]:checked')?.value || 'none';
    this._strictMode = this.container.querySelector('#focus-strict-mode')?.checked || false;
    const aiCb = this.container.querySelector('#focus-ai-blocking');
    this._aiBlocking = (aiCb?.checked && !aiCb.disabled) || false;

    try {
      // Save preferences for this profile before starting the run.
      await this._saveProfilePrefs(this._selectedProfile.id);
      this.state = await this.send({
        action: 'startFocus',
        profileId: this._selectedProfile.id,
        duration,
        tabAction,
        allowedDomains: this._allowlist, // New flexible allowlist format
        blockedDomains: this._blockedDomains,
        strictMode: this._strictMode,
        blockedCategories: this._blockedCategories,
        aiBlocking: this._aiBlocking,
      });
      this._renderHUD();
      showToast(`Focus started: ${this._selectedProfile.name}`, 'success');
    } catch (err) {
      showToast('Failed to start focus session: ' + err.message, 'error');
    }
  }

  // ── Active Timer HUD ──

  /** CSS colour for a profile, from theme tokens so light/dark both apply. */
  _getProfileColor(colorName) {
    return PROFILE_COLOR_TOKENS[colorName] || PROFILE_COLOR_TOKENS.cyan;
  }

  /** SVG icon for built-in profiles; escaped text for custom ones. */
  _profileIcon(profile) {
    return PROFILE_ICONS[profile?.id] || this._esc(profile?.icon);
  }

  _renderHUD() {
    const state = this.state;
    if (!state) return;
    beginRender(this);
    const openEnded = !(Number(state.duration) > 0);

    const isPaused = state.status === 'paused';
    const profileColor = this._getProfileColor(state.profileColor);
    const pct = Math.round(this._calcProgress());

    this.container.innerHTML = `
      <div class="focus-hud${isPaused ? ' paused' : ''}" style="--focus-profile-color: ${profileColor}">
        <div class="focus-hud-header">
          <span class="focus-hud-label">Focus mode · ${this._esc(state.profileName)}</span>
          ${isPaused ? '<span class="focus-hud-status">Paused</span>' : ''}
        </div>

        <div class="focus-timer-display">
          <div class="focus-timer-value" id="focus-timer" role="timer">${this._calcTimeDisplay()}</div>
          <div class="focus-timer-sub">${openEnded
            ? 'elapsed'
            : `remaining · <span class="focus-progress-pct" id="focus-pct">${pct}%</span>`}</div>
        </div>

        ${openEnded ? '' : `<div class="focus-progress-wrap">
          <div class="progress-bar focus-progress-track" id="focus-progress-track" role="progressbar"
               aria-label="Session progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
            <div class="progress-bar-fill focus-progress-fill" id="focus-progress" style="width: ${this._calcProgress()}%"></div>
          </div>
        </div>`}

        <div class="focus-stats-row">
          <div class="focus-stat">
            <span class="focus-stat-value" id="focus-distractions">${this._esc(state.distractionsBlocked)}</span>
            <span class="focus-stat-label">Distractions blocked</span>
          </div>
          <div class="focus-stat">
            <span class="focus-stat-value">${this._esc(state.focusTabCount)}</span>
            <span class="focus-stat-label">Focus tabs</span>
          </div>
        </div>

        <div class="focus-hud-actions">
          <button type="button" class="action-btn secondary" id="btn-pause-focus">${isPaused ? 'Resume' : 'Pause'}</button>
          ${openEnded ? '' : '<button type="button" class="action-btn secondary" id="btn-extend-focus">+5 min</button>'}
          <button type="button" class="action-btn danger" id="btn-end-focus">End Session</button>
        </div>
      </div>
    `;

    this._wireHUDEvents();
    this._startTimer();
  }

  /**
   * End the current run. A timed run with more than a minute left asks for
   * confirmation first; open-ended runs end immediately.
   */
  async requestEnd() {
    const state = this.state;
    if (!state) return false;
    if (shouldConfirmFocusEnd(state)) {
      const confirmFn = this.confirm || showConfirm;
      const ok = await confirmFn({
        title: 'End focus early?',
        message: `You have ${formatClock(focusRemainingMs(state))} left. Your stats so far will be saved.`,
        confirmLabel: 'End session',
        cancelLabel: 'Keep focusing',
        danger: true,
      });
      if (!ok) return false;
      // The run may have ended or changed while the dialog was open.
      if (!this.state || this.state.runId !== state.runId) return false;
    }

    const record = await this.send(createFocusRunCommand('endFocus', this.state));
    if (record) {
      this.state = null;
      this._showReport(record);
    } else {
      await this.refresh();
    }
    return true;
  }

  _wireHUDEvents() {
    this.container.querySelector('#btn-pause-focus')?.addEventListener('click', async () => {
      try {
        const action = this.state?.status === 'paused' ? 'resumeFocus' : 'pauseFocus';
        const nextState = await this.send(createFocusRunCommand(action, this.state));
        if (!nextState) {
          await this.refresh();
          return;
        }
        this.state = nextState;
        this._renderHUD();
      } catch (err) {
        showToast('Failed to update focus session: ' + err.message, 'error');
      }
    });

    this.container.querySelector('#btn-extend-focus')?.addEventListener('click', async () => {
      try {
        const nextState = await this.send(createFocusRunCommand(
          'extendFocus',
          this.state,
          { minutes: 5 },
        ));
        if (!nextState) {
          await this.refresh();
          return;
        }
        this.state = nextState;
        showToast('Extended by 5 minutes', 'success');
      } catch (err) {
        showToast('Failed to extend focus session: ' + err.message, 'error');
      }
    });

    this.container.querySelector('#btn-end-focus')?.addEventListener('click', async () => {
      try {
        await this.requestEnd();
      } catch (err) {
        showToast('Failed to end focus session: ' + err.message, 'error');
      }
    });
  }

  _startTimer() {
    this._stopTimer();
    this.timerInterval = setInterval(() => this._tickUI(), 1000);
  }

  _stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  _tickUI() {
    if (!this.state || this.state.status === 'paused') return;

    const timerEl = this.container.querySelector('#focus-timer');
    const progressEl = this.container.querySelector('#focus-progress');
    const pctEl = this.container.querySelector('#focus-pct');

    if (timerEl) timerEl.textContent = this._calcTimeDisplay();
    const pct = this._calcProgress();
    if (progressEl) progressEl.style.width = pct + '%';
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
    this.container.querySelector('#focus-progress-track')
      ?.setAttribute?.('aria-valuenow', String(Math.round(pct)));
  }

  _calcTimeDisplay() {
    if (!this.state) return '0:00';
    const remaining = focusRemainingMs(this.state);
    // Open-ended: show elapsed
    return this._formatMs(remaining === null ? focusElapsedMs(this.state) : remaining);
  }

  _calcProgress() {
    if (!this.state || !(Number(this.state.duration) > 0)) return 0;
    const totalMs = this.state.duration * 60 * 1000;
    return Math.min(100, (focusElapsedMs(this.state) / totalMs) * 100);
  }

  _formatMs(ms) {
    return formatClock(ms);
  }

  // ── Distraction flash ──

  _flashDistraction(domain, count) {
    const distractionsEl = this.container.querySelector('#focus-distractions');
    if (distractionsEl) {
      distractionsEl.textContent = count;
      distractionsEl.classList.add('focus-distraction-flash');
      setTimeout(() => distractionsEl.classList.remove('focus-distraction-flash'), 600);
    }
    showToast(`Blocked: ${domain} \u2014 stay focused!`, 'error', 3000);
  }

  // ── Report ──

  _showReport(record) {
    this._stopTimer();
    beginRender(this);
    if (!record) {
      void this.refresh().catch((err) => {
        showToast('Failed to load Focus Mode: ' + err.message, 'error');
      });
      return;
    }

    const durationMin = Math.round(record.actualDurationMs / 60000);

    this.container.innerHTML = `
      <div class="focus-report">
        <h2 class="focus-report-title">Focus Session Complete</h2>

        <div class="focus-report-summary">
          <span class="focus-report-profile">${this._esc(record.profileName)}</span>
          <span class="focus-report-sep">&middot;</span>
          <span>${durationMin} minute${durationMin !== 1 ? 's' : ''}</span>
        </div>

        <div class="focus-report-stats">
          <div class="focus-report-stat">
            <span class="focus-report-stat-label">Distractions blocked</span>
            <span class="focus-report-stat-value">${record.distractionsBlocked}</span>
          </div>
          <div class="focus-report-stat">
            <span class="focus-report-stat-label">Focus tabs</span>
            <span class="focus-report-stat-value">${record.focusTabCount}</span>
          </div>
        </div>

        <div class="focus-report-actions">
          <button class="action-btn" id="btn-focus-another">Start Another</button>
          <button class="action-btn secondary" id="btn-focus-close">Close</button>
        </div>
      </div>
    `;

    this.container.querySelector('#btn-focus-another')?.addEventListener('click', async () => {
      try {
        await this.refresh();
      } catch (err) {
        showToast('Failed to load Focus Mode: ' + err.message, 'error');
      }
    });
    this.container.querySelector('#btn-focus-close')?.addEventListener('click', () => {
      // Return to tabs view
      const tabsBtn = document.querySelector('.tab-nav [data-view="tabs"]');
      if (tabsBtn) tabsBtn.click();
    });
  }

  // ── History ──

  async _loadHistory() {
    try {
      const history = await this.send({ action: 'getFocusHistory' });
      const listEl = this.container.querySelector('#focus-history-list');
      if (!listEl || !history || history.length === 0) {
        const toggle = this.container.querySelector('#focus-history-toggle');
        if (toggle) toggle.hidden = true;
        return;
      }

      listEl.innerHTML = history.slice(0, 20).map(h => {
        const dur = Math.round(h.actualDurationMs / 60000);
        const date = new Date(h.startedAt);
        const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        return `
          <div class="focus-history-item">
            <span class="focus-history-profile">${this._esc(h.profileName)}</span>
            <span class="focus-history-dur">${dur}m</span>
            <span class="focus-history-distractions">${h.distractionsBlocked} blocked</span>
            <span class="focus-history-date">${dateStr} ${timeStr}</span>
          </div>
        `;
      }).join('');
    } catch (err) {
      showToast('Failed to load focus history: ' + err.message, 'error');
    }
  }

  // ── Helpers ──

  send(msg) {
    return sendOrThrow(msg);
  }

  /** Escape for both text content and quoted attribute values. */
  _esc(str) {
    return escapeHtml(str);
  }
}
