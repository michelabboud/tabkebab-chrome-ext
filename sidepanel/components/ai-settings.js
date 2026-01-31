// ai-settings.js — AI settings UI component

import { showToast } from './toast.js';

const PROVIDERS_WITH_KEY = ['openai', 'claude', 'gemini', 'custom'];

export class AISettings {
  constructor(rootEl) {
    this.root = rootEl;

    // Toggle
    this.enabledCheckbox = rootEl.querySelector('#ai-enabled');
    this.configSection = rootEl.querySelector('#ai-config');

    // Provider
    this.providerSelect = rootEl.querySelector('#ai-provider');
    this.providerPanels = {
      openai: rootEl.querySelector('#ai-config-openai'),
      claude: rootEl.querySelector('#ai-config-claude'),
      gemini: rootEl.querySelector('#ai-config-gemini'),
      'chrome-ai': rootEl.querySelector('#ai-config-chrome-ai'),
      custom: rootEl.querySelector('#ai-config-custom'),
    };

    // Passphrase
    this.passphraseToggle = rootEl.querySelector('#ai-passphrase-enabled');
    this.passphraseSection = rootEl.querySelector('#ai-passphrase-section');
    this.passphraseInput = rootEl.querySelector('#ai-passphrase');

    // Test / save
    this.testResultEl = rootEl.querySelector('#ai-test-result');

    // Wire events
    this.enabledCheckbox.addEventListener('change', () => this.toggleEnabled());
    this.providerSelect.addEventListener('change', () => this.showProviderConfig());
    this.passphraseToggle.addEventListener('change', () => this.togglePassphrase());

    rootEl.querySelector('#btn-test-ai').addEventListener('click', () => this.testConnection());
    rootEl.querySelector('#btn-save-ai').addEventListener('click', () => this.saveSettings());
    rootEl.querySelector('#btn-clear-ai-cache').addEventListener('click', () => this.clearCache());

    // Key show/hide toggles
    this.setupKeyToggle('openai');
    this.setupKeyToggle('claude');
    this.setupKeyToggle('gemini');
    this.setupKeyToggle('custom');

    // Dynamic model loading buttons
    rootEl.querySelectorAll('.btn-load-models').forEach(btn => {
      btn.addEventListener('click', () => this.loadModels(btn.dataset.provider));
    });

    // Keep Awake exception list
    this.keepAwakeListEl = rootEl.querySelector('#keep-awake-domain-list');
    this.keepAwakeSuggestionsEl = rootEl.querySelector('#keep-awake-suggestions');

    const addKeepAwakeBtn = rootEl.querySelector('#btn-add-keep-awake');
    const keepAwakeInput = rootEl.querySelector('#keep-awake-domain-input');
    if (addKeepAwakeBtn) {
      addKeepAwakeBtn.addEventListener('click', () => this.addKeepAwakeDomain());
    }
    if (keepAwakeInput) {
      keepAwakeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.addKeepAwakeDomain();
      });
    }

    const suggestBtn = rootEl.querySelector('#btn-suggest-keep-awake');
    if (suggestBtn) {
      suggestBtn.addEventListener('click', () => this.suggestKeepAwake());
    }

    const resetBtn = rootEl.querySelector('#btn-reset-keep-awake');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.resetKeepAwakeDefaults());
    }
  }

  setupKeyToggle(providerId) {
    const btn = this.root.querySelector(`#btn-toggle-${providerId}-key`);
    const input = this.root.querySelector(`#${providerId}-api-key`);
    if (btn && input) {
      btn.addEventListener('click', () => {
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.textContent = isPassword ? 'Hide' : 'Show';
      });
    }
  }

  // ── Refresh (called when Settings view activates) ──

  async refresh() {
    const settings = await this.send({ action: 'getAISettings' });

    this.enabledCheckbox.checked = settings.enabled || false;
    this.configSection.hidden = !settings.enabled;

    if (settings.providerId) {
      this.providerSelect.value = settings.providerId;
    } else {
      this.providerSelect.value = '';
    }

    this.showProviderConfig();

    // Populate saved model selections
    const configs = settings.providerConfigs || {};
    for (const pid of ['openai', 'claude', 'gemini', 'custom']) {
      if (configs[pid]?.model) {
        const select = this.root.querySelector(`#${pid}-model`);
        if (select) {
          // Ensure the saved model exists as an option
          this.ensureOption(select, configs[pid].model);
          select.value = configs[pid].model;
        }
      }
    }

    // Custom base URL
    if (configs.custom?.baseUrl) {
      const urlInput = this.root.querySelector('#custom-base-url');
      if (urlInput) urlInput.value = configs.custom.baseUrl;
    }

    // Passphrase toggle
    this.passphraseToggle.checked = settings.usePassphrase || false;
    this.passphraseSection.hidden = !settings.usePassphrase;

    // Clear the key inputs (we don't show encrypted keys)
    for (const pid of PROVIDERS_WITH_KEY) {
      const keyInput = this.root.querySelector(`#${pid}-api-key`);
      if (keyInput) {
        keyInput.value = '';
        keyInput.placeholder = configs[pid]?.apiKey
          ? 'Key saved (enter new to replace)'
          : (pid === 'custom' ? '(leave blank if not needed)' : `Enter ${pid} API key...`);
      }
    }

    // Check Chrome AI availability
    this.checkChromeAI();

    // Hide test result
    this.testResultEl.hidden = true;

    // Refresh keep-awake exception list
    this.refreshKeepAwakeList();
  }

  /**
   * Ensure a select element has an option for the given value.
   * If not, add it so the saved model can be selected.
   */
  ensureOption(select, value) {
    for (const opt of select.options) {
      if (opt.value === value) return;
    }
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }

  // ── Toggle handlers ──

  toggleEnabled() {
    this.configSection.hidden = !this.enabledCheckbox.checked;
  }

  showProviderConfig() {
    const selected = this.providerSelect.value;
    for (const [id, panel] of Object.entries(this.providerPanels)) {
      if (panel) panel.hidden = id !== selected;
    }
  }

  togglePassphrase() {
    this.passphraseSection.hidden = !this.passphraseToggle.checked;
  }

  async checkChromeAI() {
    const el = this.root.querySelector('#chrome-ai-availability');
    if (!el) return;

    try {
      const result = await this.send({ action: 'testAIConnection', providerId: 'chrome-ai', config: {} });
      el.textContent = result.success
        ? 'Available and ready to use'
        : 'Not available in this browser';
      el.className = result.success ? 'drive-status connected' : 'drive-status';
    } catch {
      el.textContent = 'Not available';
      el.className = 'drive-status';
    }
  }

  // ── Dynamic Model Loading ──

  async loadModels(providerId) {
    const btn = this.root.querySelector(`.btn-load-models[data-provider="${providerId}"]`);
    const select = this.root.querySelector(`#${providerId}-model`);
    if (!select) return;

    const prevText = btn?.textContent;
    if (btn) {
      btn.textContent = '...';
      btn.disabled = true;
    }

    try {
      const config = this.buildProviderConfig(providerId);
      const result = await this.send({ action: 'listModels', providerId, config });
      const models = result?.models || [];

      if (models.length === 0) {
        showToast('No models found. Check API key and try again.', 'error');
        return;
      }

      // Save current selection
      const currentValue = select.value;

      // Replace options
      select.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        select.appendChild(opt);
      }

      // Restore selection if it still exists
      const values = models.map(m => m.id);
      if (values.includes(currentValue)) {
        select.value = currentValue;
      }

      showToast(`Loaded ${models.length} models`, 'success');
    } catch (err) {
      showToast('Failed to load models: ' + err.message, 'error');
    } finally {
      if (btn) {
        btn.textContent = prevText || 'Load';
        btn.disabled = false;
      }
    }
  }

  // ── Test Connection ──

  async testConnection() {
    const providerId = this.providerSelect.value;
    if (!providerId) {
      showToast('Select a provider first', 'error');
      return;
    }

    this.testResultEl.hidden = false;
    this.testResultEl.textContent = 'Testing...';
    this.testResultEl.className = 'drive-status';

    const config = this.buildProviderConfig(providerId);

    // For key-based providers (except custom which is optional), we need a key to test
    if (!['chrome-ai', 'custom'].includes(providerId) && !config.apiKey) {
      this.testResultEl.textContent = 'Enter an API key to test';
      return;
    }

    try {
      const result = await this.send({ action: 'testAIConnection', providerId, config });
      if (result.success) {
        this.testResultEl.textContent = 'Connection successful!';
        this.testResultEl.className = 'drive-status connected';
      } else {
        this.testResultEl.textContent = 'Connection failed — check your settings';
        this.testResultEl.className = 'drive-status';
      }
    } catch (err) {
      this.testResultEl.textContent = `Error: ${err.message}`;
      this.testResultEl.className = 'drive-status';
    }
  }

  // ── Save Settings ──

  async saveSettings() {
    const providerId = this.providerSelect.value;
    const enabled = this.enabledCheckbox.checked;
    const usePassphrase = this.passphraseToggle.checked;
    const passphrase = usePassphrase ? this.passphraseInput.value : null;

    if (enabled && !providerId) {
      showToast('Select a provider to enable AI', 'error');
      return;
    }

    // Build settings object
    const currentSettings = await this.send({ action: 'getAISettings' });
    const settings = {
      ...currentSettings,
      enabled,
      providerId: providerId || null,
      usePassphrase,
    };

    // Save model selections + custom config
    if (!settings.providerConfigs) settings.providerConfigs = {};

    for (const pid of ['openai', 'claude', 'gemini', 'custom']) {
      if (!settings.providerConfigs[pid]) settings.providerConfigs[pid] = {};
      const modelSelect = this.root.querySelector(`#${pid}-model`);
      if (modelSelect) settings.providerConfigs[pid].model = modelSelect.value;
    }

    // Custom base URL
    const customBaseUrl = this.root.querySelector('#custom-base-url')?.value;
    if (customBaseUrl) {
      settings.providerConfigs.custom.baseUrl = customBaseUrl;
    }

    // Save the settings (without keys first)
    await this.send({ action: 'saveAISettings', settings });

    // Save API keys via encryption (only if a new key was entered)
    for (const pid of PROVIDERS_WITH_KEY) {
      const keyInput = this.root.querySelector(`#${pid}-api-key`);
      const newKey = keyInput?.value;
      if (newKey) {
        await this.send({
          action: 'setAIApiKey',
          providerId: pid,
          plainKey: newKey,
          passphrase: passphrase || null,
        });
      }
    }

    showToast('AI settings saved', 'success');
    this.refresh();
  }

  // ── Clear Cache ──

  async clearCache() {
    await this.send({ action: 'clearAICache' });
    showToast('AI cache cleared', 'success');
  }

  // ── Keep Awake Exception List ──

  async refreshKeepAwakeList() {
    if (!this.keepAwakeListEl) return;

    try {
      const list = await this.send({ action: 'getKeepAwakeList' });
      this.renderKeepAwakeList(list || []);
    } catch {
      this.keepAwakeListEl.innerHTML = '<div class="keep-awake-domain-list-empty">Failed to load</div>';
    }
  }

  renderKeepAwakeList(domains) {
    this.keepAwakeListEl.innerHTML = '';

    if (domains.length === 0) {
      this.keepAwakeListEl.innerHTML = '<div class="keep-awake-domain-list-empty">No domains in keep-awake list</div>';
      return;
    }

    const sorted = [...domains].sort();
    for (const domain of sorted) {
      const row = document.createElement('div');
      row.className = 'keep-awake-domain-row';

      const label = document.createElement('span');
      label.className = 'domain-label';
      label.textContent = domain;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = '\u00D7';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', () => this.removeKeepAwakeDomain(domain));

      row.appendChild(label);
      row.appendChild(removeBtn);
      this.keepAwakeListEl.appendChild(row);
    }
  }

  async addKeepAwakeDomain() {
    const input = this.root.querySelector('#keep-awake-domain-input');
    const domain = (input?.value || '').trim().toLowerCase();
    if (!domain) {
      showToast('Enter a domain', 'error');
      return;
    }

    try {
      const result = await this.send({ action: 'toggleKeepAwakeDomain', domain });
      if (result.isKeepAwake) {
        showToast(`Added ${domain}`, 'success');
      } else {
        // Domain was already in the list, toggling removed it — add it back
        await this.send({ action: 'toggleKeepAwakeDomain', domain });
        showToast(`${domain} already in list`, 'info');
      }
      input.value = '';
      this.refreshKeepAwakeList();
    } catch {
      showToast('Failed to add domain', 'error');
    }
  }

  async removeKeepAwakeDomain(domain) {
    try {
      const list = await this.send({ action: 'getKeepAwakeList' });
      const filtered = (list || []).filter(d => d !== domain);
      await this.send({ action: 'saveKeepAwakeList', domains: filtered });
      showToast(`Removed ${domain}`, 'success');
      this.refreshKeepAwakeList();
    } catch {
      showToast('Failed to remove domain', 'error');
    }
  }

  async resetKeepAwakeDefaults() {
    try {
      // Clear the storage key so getKeepAwakeList re-seeds defaults
      await this.send({ action: 'saveKeepAwakeList', domains: null });
      // Force re-seed by calling getKeepAwakeList (which seeds when null)
      showToast('Reset to defaults', 'success');
      this.refreshKeepAwakeList();
    } catch {
      showToast('Failed to reset', 'error');
    }
  }

  async suggestKeepAwake() {
    const btn = this.root.querySelector('#btn-suggest-keep-awake');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Thinking...';
    }

    try {
      const result = await this.send({ action: 'classifyKeepAwake' });
      const suggestions = result?.suggestions || [];

      if (suggestions.length === 0) {
        showToast('No new suggestions', 'info');
        return;
      }

      this.renderKeepAwakeSuggestions(suggestions);
    } catch (err) {
      showToast('AI suggestion failed: ' + err.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Suggest (AI)';
      }
    }
  }

  renderKeepAwakeSuggestions(suggestions) {
    if (!this.keepAwakeSuggestionsEl) return;

    this.keepAwakeSuggestionsEl.hidden = false;
    this.keepAwakeSuggestionsEl.innerHTML = '';

    const heading = document.createElement('h4');
    heading.textContent = 'AI Suggestions';
    this.keepAwakeSuggestionsEl.appendChild(heading);

    for (const s of suggestions) {
      const row = document.createElement('div');
      row.className = 'keep-awake-suggestion-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.domain = s.domain;

      const domainEl = document.createElement('span');
      domainEl.className = 'suggestion-domain';
      domainEl.textContent = s.domain;

      const reasonEl = document.createElement('span');
      reasonEl.className = 'suggestion-reason';
      reasonEl.textContent = s.reason;

      row.appendChild(checkbox);
      row.appendChild(domainEl);
      row.appendChild(reasonEl);
      this.keepAwakeSuggestionsEl.appendChild(row);
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    toolbar.style.marginTop = '8px';

    const applyBtn = document.createElement('button');
    applyBtn.className = 'action-btn secondary';
    applyBtn.textContent = 'Apply Selected';
    applyBtn.addEventListener('click', () => this.applySuggestions());

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'action-btn secondary';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      this.keepAwakeSuggestionsEl.hidden = true;
    });

    toolbar.appendChild(applyBtn);
    toolbar.appendChild(dismissBtn);
    this.keepAwakeSuggestionsEl.appendChild(toolbar);
  }

  async applySuggestions() {
    const checkboxes = this.keepAwakeSuggestionsEl.querySelectorAll('input[type="checkbox"]:checked');
    const domains = [...checkboxes].map(cb => cb.dataset.domain).filter(Boolean);

    if (domains.length === 0) {
      showToast('No domains selected', 'error');
      return;
    }

    try {
      const list = await this.send({ action: 'getKeepAwakeList' });
      const existing = new Set(list || []);
      let added = 0;
      for (const d of domains) {
        if (!existing.has(d)) {
          existing.add(d);
          added++;
        }
      }
      await this.send({ action: 'saveKeepAwakeList', domains: [...existing] });
      showToast(`Added ${added} domain${added !== 1 ? 's' : ''} to keep-awake list`, 'success');
      this.keepAwakeSuggestionsEl.hidden = true;
      this.refreshKeepAwakeList();
    } catch {
      showToast('Failed to apply suggestions', 'error');
    }
  }

  // ── Helpers ──

  buildProviderConfig(providerId) {
    const config = {};
    if (providerId === 'openai') {
      config.apiKey = this.root.querySelector('#openai-api-key')?.value || '';
      config.model = this.root.querySelector('#openai-model')?.value || 'gpt-4.1-nano';
    } else if (providerId === 'claude') {
      config.apiKey = this.root.querySelector('#claude-api-key')?.value || '';
      config.model = this.root.querySelector('#claude-model')?.value || 'claude-haiku-4-5';
    } else if (providerId === 'gemini') {
      config.apiKey = this.root.querySelector('#gemini-api-key')?.value || '';
      config.model = this.root.querySelector('#gemini-model')?.value || 'gemini-2.5-flash';
    } else if (providerId === 'custom') {
      config.apiKey = this.root.querySelector('#custom-api-key')?.value || '';
      config.baseUrl = this.root.querySelector('#custom-base-url')?.value || 'http://localhost:11434/v1';
      config.model = this.root.querySelector('#custom-model')?.value || 'default';
    }
    return config;
  }

  send(msg) {
    return chrome.runtime.sendMessage(msg);
  }
}
