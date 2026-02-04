// sidepanel/components/focus-panel.js — Focus Mode UI: setup, timer HUD, report, history

import { showToast } from './toast.js';

export class FocusPanel {
  constructor(rootEl) {
    this.root = rootEl;
    this.container = rootEl.querySelector('#focus-container');
    this.state = null;
    this.profiles = [];
    this.timerInterval = null;

    // Listen for focus events from service worker
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'focusDistraction') {
        this._flashDistraction(msg.domain, msg.count);
      }
      if (msg.type === 'focusEnded') {
        this.state = null;
        this._showReport(msg.record);
      }
    });
  }

  async refresh() {
    this._stopTimer();
    this.state = await this.send({ action: 'getFocusState' });
    this.profiles = await this.send({ action: 'getFocusProfiles' });
    const settings = await this.send({ action: 'getSettings' });
    this.settings = settings;

    if (this.state?.status === 'active' || this.state?.status === 'paused') {
      this._renderHUD();
    } else {
      this._renderSetup();
    }
  }

  // ── Setup View ──

  _renderSetup() {
    const settings = this.settings || {};
    const defaultProfile = settings.focusDefaultProfile || 'coding';
    const defaultDuration = settings.focusDefaultDuration || 25;
    const defaultAction = settings.focusTabAction || 'kebab';
    const profile = this.profiles.find(p => p.id === defaultProfile) || this.profiles[0];

    this.container.innerHTML = `
      <div class="focus-setup">
        <h2 class="focus-title">Start Focus Session</h2>

        <div class="focus-profile-picker">
          ${this.profiles.map(p => `
            <button class="focus-profile-chip ${p.id === profile.id ? 'active' : ''}"
                    data-profile="${p.id}"
                    style="--profile-color: var(--focus-${p.color})">
              <span class="focus-profile-icon">${this._esc(p.icon)}</span>
              <span>${this._esc(p.name)}</span>
            </button>
          `).join('')}
        </div>

        <div class="focus-duration-row">
          <label class="focus-label">Duration</label>
          <input type="number" id="focus-duration" class="input focus-duration-input" value="${profile.suggestedDuration || defaultDuration}" min="1" max="480">
          <span class="focus-unit">min</span>
          <label class="focus-open-ended-label">
            <input type="checkbox" id="focus-open-ended">
            Open-ended
          </label>
        </div>

        <div class="focus-action-section">
          <label class="focus-label">When focus starts:</label>
          <div class="focus-radio-group">
            <label><input type="radio" name="focus-action" value="kebab" ${defaultAction === 'kebab' ? 'checked' : ''}> Kebab non-focus tabs</label>
            <label><input type="radio" name="focus-action" value="stash" ${defaultAction === 'stash' ? 'checked' : ''}> Stash non-focus tabs</label>
            <label><input type="radio" name="focus-action" value="group" ${defaultAction === 'group' ? 'checked' : ''}> Group focus tabs only</label>
            <label><input type="radio" name="focus-action" value="none" ${defaultAction === 'none' ? 'checked' : ''}> Do nothing (monitor only)</label>
          </div>
        </div>

        <div class="focus-domains-section">
          <div class="focus-domain-group">
            <label class="focus-label">Allowed domains</label>
            <div class="focus-domain-tags" id="focus-allowed-tags"></div>
            <div class="focus-domain-add">
              <input type="text" id="focus-add-allowed" class="input" placeholder="Add domain...">
              <button class="action-btn secondary focus-add-btn" id="btn-add-allowed">+</button>
            </div>
          </div>
          <div class="focus-domain-group">
            <label class="focus-label">Blocked domains</label>
            <div class="focus-domain-tags" id="focus-blocked-tags"></div>
            <div class="focus-domain-add">
              <input type="text" id="focus-add-blocked" class="input" placeholder="Add domain...">
              <button class="action-btn secondary focus-add-btn" id="btn-add-blocked">+</button>
            </div>
          </div>
        </div>

        <button class="action-btn focus-start-btn" id="btn-start-focus">Start Focus</button>

        <div class="focus-history-section">
          <h3 class="focus-subtitle" id="focus-history-toggle">Recent Sessions</h3>
          <div id="focus-history-list" class="focus-history-list" hidden></div>
        </div>
      </div>
    `;

    // Store current selections
    this._selectedProfile = profile;
    this._allowedDomains = [...(profile.allowedDomains || [])];
    this._blockedDomains = [...(profile.blockedDomains || [])];

    this._renderDomainTags();
    this._wireSetupEvents();
    this._loadHistory();
  }

  _renderDomainTags() {
    const allowedEl = this.container.querySelector('#focus-allowed-tags');
    const blockedEl = this.container.querySelector('#focus-blocked-tags');
    if (allowedEl) {
      allowedEl.innerHTML = this._allowedDomains.map(d =>
        `<span class="focus-domain-tag">${this._esc(d)}<button class="focus-tag-remove" data-type="allowed" data-domain="${this._esc(d)}">&times;</button></span>`
      ).join('') || '<span class="focus-domain-empty">Any domain allowed</span>';
    }
    if (blockedEl) {
      blockedEl.innerHTML = this._blockedDomains.map(d =>
        `<span class="focus-domain-tag focus-domain-tag-blocked">${this._esc(d)}<button class="focus-tag-remove" data-type="blocked" data-domain="${this._esc(d)}">&times;</button></span>`
      ).join('') || '<span class="focus-domain-empty">No domains blocked</span>';
    }

    // Wire remove buttons
    this.container.querySelectorAll('.focus-tag-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        const domain = btn.dataset.domain;
        if (type === 'allowed') {
          this._allowedDomains = this._allowedDomains.filter(d => d !== domain);
        } else {
          this._blockedDomains = this._blockedDomains.filter(d => d !== domain);
        }
        this._renderDomainTags();
      });
    });
  }

  _wireSetupEvents() {
    // Profile picker
    this.container.querySelectorAll('.focus-profile-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const profileId = chip.dataset.profile;
        const profile = this.profiles.find(p => p.id === profileId);
        if (!profile) return;
        this._selectedProfile = profile;
        this._allowedDomains = [...(profile.allowedDomains || [])];
        this._blockedDomains = [...(profile.blockedDomains || [])];

        this.container.querySelectorAll('.focus-profile-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');

        const durInput = this.container.querySelector('#focus-duration');
        if (durInput) durInput.value = profile.suggestedDuration || 25;

        this._renderDomainTags();
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

    // Add domain buttons
    const addAllowed = this.container.querySelector('#btn-add-allowed');
    const addBlocked = this.container.querySelector('#btn-add-blocked');
    const allowedInput = this.container.querySelector('#focus-add-allowed');
    const blockedInput = this.container.querySelector('#focus-add-blocked');

    const addDomain = (input, list, type) => {
      const val = input.value.trim().toLowerCase();
      if (!val) return;
      if (type === 'allowed' && !this._allowedDomains.includes(val)) {
        this._allowedDomains.push(val);
      } else if (type === 'blocked' && !this._blockedDomains.includes(val)) {
        this._blockedDomains.push(val);
      }
      input.value = '';
      this._renderDomainTags();
    };

    addAllowed?.addEventListener('click', () => addDomain(allowedInput, this._allowedDomains, 'allowed'));
    addBlocked?.addEventListener('click', () => addDomain(blockedInput, this._blockedDomains, 'blocked'));
    allowedInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addDomain(allowedInput, this._allowedDomains, 'allowed'); });
    blockedInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addDomain(blockedInput, this._blockedDomains, 'blocked'); });

    // Start button
    this.container.querySelector('#btn-start-focus')?.addEventListener('click', () => this._startSession());

    // History toggle
    this.container.querySelector('#focus-history-toggle')?.addEventListener('click', () => {
      const list = this.container.querySelector('#focus-history-list');
      if (list) list.hidden = !list.hidden;
    });
  }

  async _startSession() {
    const openEnded = this.container.querySelector('#focus-open-ended')?.checked;
    const durInput = this.container.querySelector('#focus-duration');
    const duration = openEnded ? 0 : (parseInt(durInput?.value) || 25);
    const tabAction = this.container.querySelector('input[name="focus-action"]:checked')?.value || 'none';

    try {
      this.state = await this.send({
        action: 'startFocus',
        profileId: this._selectedProfile.id,
        duration,
        tabAction,
        allowedDomains: this._allowedDomains,
        blockedDomains: this._blockedDomains,
      });
      this._renderHUD();
      showToast(`Focus started: ${this._selectedProfile.name}`, 'success');
    } catch (e) {
      showToast('Failed to start focus session', 'error');
    }
  }

  // ── Active Timer HUD ──

  _renderHUD() {
    const state = this.state;
    if (!state) return;

    const isPaused = state.status === 'paused';

    this.container.innerHTML = `
      <div class="focus-hud">
        <div class="focus-hud-header">
          <span class="focus-hud-label">FOCUS MODE - ${this._esc(state.profileName)}</span>
          <button class="action-btn secondary focus-end-early-btn" id="btn-end-early">End Early</button>
        </div>

        <div class="focus-timer-display">
          <div class="focus-timer-value" id="focus-timer">${this._calcTimeDisplay()}</div>
          <div class="focus-timer-sub">${state.duration > 0 ? 'remaining' : 'elapsed'}</div>
        </div>

        <div class="focus-progress-wrap">
          <div class="progress-bar">
            <div class="progress-bar-fill focus-progress-fill" id="focus-progress" style="width: ${this._calcProgress()}%"></div>
          </div>
          <span class="focus-progress-pct" id="focus-pct">${Math.round(this._calcProgress())}%</span>
        </div>

        <div class="focus-stats-row">
          <div class="focus-stat">
            <span class="focus-stat-value" id="focus-distractions">${state.distractionsBlocked}</span>
            <span class="focus-stat-label">Distractions blocked</span>
          </div>
          <div class="focus-stat">
            <span class="focus-stat-value">${state.focusTabCount}</span>
            <span class="focus-stat-label">Focus tabs</span>
          </div>
        </div>

        <div class="focus-hud-actions">
          <button class="action-btn secondary" id="btn-pause-focus">${isPaused ? 'Resume' : 'Pause'}</button>
          <button class="action-btn secondary" id="btn-extend-focus">+5 min</button>
          <button class="action-btn danger" id="btn-end-focus">End Session</button>
        </div>
      </div>
    `;

    this._wireHUDEvents();
    this._startTimer();
  }

  _wireHUDEvents() {
    this.container.querySelector('#btn-pause-focus')?.addEventListener('click', async () => {
      if (this.state?.status === 'paused') {
        this.state = await this.send({ action: 'resumeFocus' });
      } else {
        this.state = await this.send({ action: 'pauseFocus' });
      }
      this._renderHUD();
    });

    this.container.querySelector('#btn-extend-focus')?.addEventListener('click', async () => {
      this.state = await this.send({ action: 'extendFocus', minutes: 5 });
      showToast('Extended by 5 minutes', 'success');
    });

    const endHandler = async () => {
      const record = await this.send({ action: 'endFocus' });
      this.state = null;
      if (record) {
        this._showReport(record);
      } else {
        this.refresh();
      }
    };

    this.container.querySelector('#btn-end-focus')?.addEventListener('click', endHandler);
    this.container.querySelector('#btn-end-early')?.addEventListener('click', endHandler);
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
  }

  _calcTimeDisplay() {
    if (!this.state) return '0:00';
    if (this.state.duration === 0) {
      // Open-ended: show elapsed
      const elapsed = Date.now() - this.state.startedAt - this.state.pausedElapsed;
      return this._formatMs(elapsed);
    }
    const totalMs = this.state.duration * 60 * 1000;
    const elapsed = Date.now() - this.state.startedAt - this.state.pausedElapsed;
    const remaining = Math.max(0, totalMs - elapsed);
    return this._formatMs(remaining);
  }

  _calcProgress() {
    if (!this.state || this.state.duration === 0) return 0;
    const totalMs = this.state.duration * 60 * 1000;
    const elapsed = Date.now() - this.state.startedAt - this.state.pausedElapsed;
    return Math.min(100, (elapsed / totalMs) * 100);
  }

  _formatMs(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
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
    if (!record) { this.refresh(); return; }

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

    this.container.querySelector('#btn-focus-another')?.addEventListener('click', () => this.refresh());
    this.container.querySelector('#btn-focus-close')?.addEventListener('click', () => {
      // Return to tabs view
      const tabsBtn = document.querySelector('.tab-nav [data-view="tabs"]');
      if (tabsBtn) tabsBtn.click();
    });
  }

  // ── History ──

  async _loadHistory() {
    const history = await this.send({ action: 'getFocusHistory' });
    const listEl = this.container.querySelector('#focus-history-list');
    if (!listEl || !history || history.length === 0) {
      const toggle = this.container.querySelector('#focus-history-toggle');
      if (toggle) toggle.style.display = 'none';
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
  }

  // ── Helpers ──

  send(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }
}
