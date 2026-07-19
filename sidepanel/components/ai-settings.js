// ai-settings.js — AI settings UI component

import { showToast } from './toast.js';
import { sendOrThrow } from '../message-client.js';

const PROVIDERS_WITH_KEY = ['openai', 'claude', 'gemini', 'custom'];
const ALL_PROVIDERS = ['openai', 'claude', 'gemini', 'chrome-ai', 'custom'];
const PROVIDER_DEFAULTS = Object.freeze({
  openai: { model: 'gpt-4.1-nano' },
  claude: { model: 'claude-haiku-4-5' },
  gemini: { model: 'gemini-2.5-flash' },
  'chrome-ai': { model: 'default' },
  custom: { model: 'default', baseUrl: 'http://localhost:11434/v1' },
});

const SAVE_FIRST_MESSAGE = 'Save AI settings before testing or loading models.';
const UNLOCK_FIRST_MESSAGE = 'Unlock this provider before testing or loading models.';
const REENTER_ALL_KEYS_MESSAGE = 'Re-enter every saved API key before changing key protection.';

function hasExactResponseShape(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === fields.length &&
    fields.every((field, index) => keys[index] === [...fields].sort()[index]);
}

export class AISettings {
  constructor(rootEl, { onAvailabilityChanged = async () => {} } = {}) {
    this.root = rootEl;
    this.onAvailabilityChanged = onAvailabilityChanged;
    this.currentSettings = null;
    this.activeOperation = null;
    this.saveInFlight = false;
    this.unlockInFlight = false;
    this.unlockStateGeneration = 0;
    this.refreshGeneration = 0;
    this.providerSelectionGeneration = 0;
    this.providerActionGeneration = 0;

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

    // Per-provider restart unlock
    this.unlockSection = rootEl.querySelector('#ai-unlock-section');
    this.unlockPassphraseInput = rootEl.querySelector('#ai-unlock-passphrase');
    this.unlockButton = rootEl.querySelector('#btn-unlock-ai');
    this.unlockResultEl = rootEl.querySelector('#ai-unlock-result');

    // Test / save
    this.testResultEl = rootEl.querySelector('#ai-test-result');

    // Wire events
    this.enabledCheckbox.addEventListener('change', () => this.toggleEnabled());
    this.providerSelect.addEventListener('change', () => {
      this.handleProviderChange().catch(() => {
        this.hideUnlockSection();
        showToast('Could not refresh AI provider lock status', 'error');
      });
    });
    this.passphraseToggle.addEventListener('change', () => this.togglePassphrase());

    this.testButton = rootEl.querySelector('#btn-test-ai');
    this.saveButton = rootEl.querySelector('#btn-save-ai');
    this.testButton.addEventListener('click', () => this.testConnection());
    this.saveButton.addEventListener('click', () => this.saveSettings());
    rootEl.querySelector('#btn-clear-ai-cache').addEventListener('click', () => this.clearCache());
    this.unlockButton?.addEventListener('click', () => {
      this.unlockSelectedProvider().catch(() => {
        showToast('Could not unlock this AI provider', 'error');
      });
    });

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

  async refresh({ operation = null } = {}) {
    let releaseRefresh = null;
    if (operation === null) {
      releaseRefresh = this.beginExclusiveOperation('refresh', [
        this.enabledCheckbox,
        this.providerSelect,
        this.passphraseToggle,
        this.passphraseInput,
        this.unlockPassphraseInput,
        this.unlockButton,
        this.testButton,
        this.saveButton,
      ]);
      if (!releaseRefresh) return false;
    } else if (this.activeOperation !== operation) {
      return false;
    }

    try {
    const refreshGeneration = (this.refreshGeneration || 0) + 1;
    this.refreshGeneration = refreshGeneration;
    const settings = await this.send({ action: 'getAISettings' });
    if (refreshGeneration !== this.refreshGeneration) return false;
    this.currentSettings = settings;
    // Compatibility aliases retained for DOM-free policy tests and callers that
    // inspect the last public snapshot. Neither alias contains private blobs.
    this.settings = settings;
    this.providerSettings = settings.providerConfigs || {};

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
    for (const pid of ALL_PROVIDERS) {
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
    const urlInput = this.root.querySelector('#custom-base-url');
    if (urlInput) {
      urlInput.value = configs.custom?.baseUrl || PROVIDER_DEFAULTS.custom.baseUrl;
    }

    // Blob-authoritative protection state. Mixed mode remains indeterminate
    // until the user deliberately chooses one uniform mode.
    this.passphraseToggle.indeterminate = settings.protectionMode === 'mixed';
    this.passphraseToggle.checked = settings.protectionMode === 'passphrase';
    this.passphraseSection.hidden = !this.passphraseToggle.checked;
    this.passphraseInput.value = '';

    // Clear the key inputs (we don't show encrypted keys)
    for (const pid of PROVIDERS_WITH_KEY) {
      const keyInput = this.root.querySelector(`#${pid}-api-key`);
      if (keyInput) {
        keyInput.value = '';
        keyInput.placeholder = configs[pid]?.hasApiKey
          ? 'Key saved (enter new to replace)'
          : (pid === 'custom' ? '(leave blank if not needed)' : `Enter ${pid} API key...`);
      }
    }

    await this.refreshUnlockState();
    if (refreshGeneration !== this.refreshGeneration) return false;

    // Check Chrome AI availability
    await this.checkChromeAI();
    if (refreshGeneration !== this.refreshGeneration) return false;

    // Hide test result
    this.testResultEl.hidden = true;

    // Refresh keep-awake exception list
    await this.refreshKeepAwakeList();
    return refreshGeneration === this.refreshGeneration;
    } finally {
      releaseRefresh?.();
    }
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
    this.passphraseToggle.indeterminate = false;
    this.passphraseSection.hidden = !this.passphraseToggle.checked;
    if (!this.passphraseToggle.checked) this.passphraseInput.value = '';
  }

  async handleProviderChange() {
    const releaseProviderStatus = this.beginExclusiveOperation('provider-status', [
      this.providerSelect,
      this.unlockPassphraseInput,
      this.unlockButton,
      this.testButton,
      this.saveButton,
    ]);
    if (!releaseProviderStatus) return false;
    try {
      const selectionGeneration = (this.providerSelectionGeneration || 0) + 1;
      this.providerSelectionGeneration = selectionGeneration;
      this.providerActionGeneration = (this.providerActionGeneration || 0) + 1;
      const providerId = this.providerSelect.value;
      this.showProviderConfig();
      try {
        return await this.refreshUnlockState();
      } catch (error) {
        if (this.providerSelectionGeneration !== selectionGeneration ||
            this.providerSelect.value !== providerId) return false;
        throw error;
      }
    } finally {
      releaseProviderStatus();
    }
  }

  hideUnlockSection({ preserveResult = false } = {}) {
    if (this.unlockSection) this.unlockSection.hidden = true;
    if (this.unlockPassphraseInput) this.unlockPassphraseInput.value = '';
    if (this.unlockResultEl && !preserveResult) {
      this.unlockResultEl.hidden = true;
      this.unlockResultEl.textContent = '';
      this.unlockResultEl.className = 'drive-status';
    }
  }

  async providerNeedsPassphrase(providerId) {
    const response = await this.send({ action: 'needsAIPassphrase', providerId });
    if (!hasExactResponseShape(response, ['needsPassphrase']) ||
        typeof response.needsPassphrase !== 'boolean') {
      throw new Error('Invalid AI lock-status response');
    }
    return response.needsPassphrase;
  }

  async refreshUnlockState({ preserveResult = false } = {}) {
    const requestGeneration = (this.unlockStateGeneration || 0) + 1;
    this.unlockStateGeneration = requestGeneration;
    const providerId = this.providerSelect.value;
    this.hideUnlockSection({ preserveResult });
    if (this.unlockPassphraseInput) this.unlockPassphraseInput.disabled = true;
    if (this.unlockButton) this.unlockButton.disabled = true;

    try {
      if (!providerId) return false;

      const needsPassphrase = await this.providerNeedsPassphrase(providerId);
      if (this.unlockStateGeneration !== requestGeneration ||
          this.providerSelect.value !== providerId) return false;
      if (!needsPassphrase) return false;

      if (this.unlockSection) this.unlockSection.hidden = false;
      if (this.unlockResultEl) {
        this.unlockResultEl.hidden = true;
        this.unlockResultEl.textContent = '';
        this.unlockResultEl.className = 'drive-status';
      }
      return true;
    } catch (error) {
      if (this.unlockStateGeneration !== requestGeneration ||
          this.providerSelect.value !== providerId) return false;
      throw error;
    } finally {
      if (this.unlockStateGeneration === requestGeneration &&
          this.providerSelect.value === providerId &&
          !this.activeOperation) {
        if (this.unlockPassphraseInput) this.unlockPassphraseInput.disabled = false;
        if (this.unlockButton) this.unlockButton.disabled = false;
      }
    }
  }

  async unlockSelectedProvider() {
    if (this.unlockSection?.hidden ||
        this.unlockPassphraseInput?.disabled ||
        this.unlockButton?.disabled) return false;
    const providerId = this.providerSelect.value;
    const passphrase = this.unlockPassphraseInput?.value;
    if (!providerId || typeof passphrase !== 'string' || passphrase.length === 0) {
      if (this.unlockResultEl) {
        this.unlockResultEl.hidden = false;
        this.unlockResultEl.textContent = 'Enter the provider passphrase.';
        this.unlockResultEl.className = 'drive-status';
      }
      return false;
    }

    const releaseUnlock = this.beginUnlockOwnership();
    if (!releaseUnlock) return false;
    if (this.unlockResultEl) {
      this.unlockResultEl.hidden = false;
      this.unlockResultEl.textContent = 'Unlocking...';
      this.unlockResultEl.className = 'drive-status';
    }

    try {
      const response = await this.send({
        action: 'unlockAIApiKey',
        providerId,
        passphrase,
      });
      if (!hasExactResponseShape(response, ['unlocked']) || response.unlocked !== true) {
        throw new Error('Invalid AI unlock response');
      }
      if (this.providerSelect.value !== providerId ||
          this.unlockPassphraseInput.value !== passphrase) return false;

      this.unlockPassphraseInput.value = '';
      if (this.unlockResultEl) {
        this.unlockResultEl.hidden = false;
        this.unlockResultEl.textContent = 'Provider unlocked.';
        this.unlockResultEl.className = 'drive-status connected';
      }

      try {
        await this.onAvailabilityChanged();
      } catch {
        showToast('Provider unlocked, but AI status could not refresh', 'error');
      }

      try {
        await this.refreshUnlockState({ preserveResult: true });
      } catch {
        showToast('Provider unlocked, but lock status could not refresh', 'error');
      }
      return true;
    } catch {
      if (this.unlockResultEl) {
        this.unlockResultEl.hidden = false;
        this.unlockResultEl.textContent = 'Incorrect passphrase.';
        this.unlockResultEl.className = 'drive-status';
      }
      return false;
    } finally {
      releaseUnlock();
    }
  }

  beginUnlockOwnership() {
    return this.beginExclusiveOperation('unlock', [
      this.providerSelect,
      this.unlockPassphraseInput,
      this.unlockButton,
      this.testButton,
      this.saveButton,
    ]);
  }

  beginExclusiveOperation(name, extraControls = []) {
    if (this.activeOperation) return null;
    const operation = Symbol(name);
    this.activeOperation = operation;
    this.saveInFlight = name === 'save';
    this.unlockInFlight = name === 'unlock';
    const controls = new Set([
      ...extraControls,
      ...(this.root?.querySelectorAll?.(
        '#ai-config input, #ai-config select, #ai-config button',
      ) || []),
    ].filter(Boolean));
    const priorDisabled = new Map();
    for (const control of controls) {
      priorDisabled.set(control, control.disabled === true);
      control.disabled = true;
    }
    return () => {
      if (this.activeOperation !== operation) return;
      for (const [control, disabled] of priorDisabled) control.disabled = disabled;
      this.activeOperation = null;
      this.saveInFlight = false;
      this.unlockInFlight = false;
    };
  }

  hasUnsavedProviderConfiguration(providerId) {
    if (this.currentSettings?.providerId !== providerId) return true;
    const persisted = this.currentSettings?.providerConfigs?.[providerId] ||
      this.providerSettings?.[providerId];
    if (!persisted) return true;

    if (PROVIDERS_WITH_KEY.includes(providerId)) {
      const keyInput = this.root.querySelector(`#${providerId}-api-key`);
      if (typeof keyInput?.value === 'string' && keyInput.value.length > 0) return true;
    }

    const modelInput = this.root.querySelector(`#${providerId}-model`);
    if (modelInput && modelInput.value !== persisted.model) return true;

    if (providerId === 'custom') {
      const baseUrl = this.root.querySelector('#custom-base-url')?.value;
      if (baseUrl !== persisted.baseUrl) return true;
    }
    return false;
  }

  async providerActionBlockReason(providerId) {
    if (this.hasUnsavedProviderConfiguration(providerId)) return SAVE_FIRST_MESSAGE;
    const needsPassphrase = await this.providerNeedsPassphrase(providerId);
    if (this.providerSelect.value !== providerId ||
        this.hasUnsavedProviderConfiguration(providerId)) {
      return SAVE_FIRST_MESSAGE;
    }
    if (needsPassphrase) return UNLOCK_FIRST_MESSAGE;
    return null;
  }

  async checkChromeAI() {
    const el = this.root.querySelector('#chrome-ai-availability');
    if (!el) return;

    try {
      const result = await this.send({ action: 'testAIConnection', providerId: 'chrome-ai' });
      if (result.success) {
        el.textContent = 'Available and ready to use';
        el.className = 'drive-status connected';
      } else {
        el.textContent = 'Not available — see Setup Guide below';
        el.className = 'drive-status';
      }
    } catch {
      el.textContent = 'Not available — see Setup Guide below';
      el.className = 'drive-status';
    }
  }

  // ── Dynamic Model Loading ──

  async loadModels(providerId) {
    const btn = this.root.querySelector(`.btn-load-models[data-provider="${providerId}"]`);
    const select = this.root.querySelector(`#${providerId}-model`);
    if (!select) return false;

    const selectionGeneration = this.providerSelectionGeneration || 0;
    const actionGeneration = (this.providerActionGeneration || 0) + 1;
    this.providerActionGeneration = actionGeneration;
    const releaseOperation = this.beginExclusiveOperation('models', [
      this.providerSelect,
      this.testButton,
      this.saveButton,
      btn,
    ]);
    if (!releaseOperation) return false;

    try {
      let blockReason;
      try {
        blockReason = await this.providerActionBlockReason(providerId);
      } catch {
        if (this.isCurrentProviderAction(providerId, selectionGeneration, actionGeneration)) {
          showToast('Could not verify AI provider readiness', 'error');
        }
        return false;
      }
      if (!this.isCurrentProviderAction(providerId, selectionGeneration, actionGeneration)) {
        return false;
      }
      if (blockReason) {
        showToast(blockReason, 'error');
        return false;
      }

      const prevText = btn?.textContent;
      if (btn) btn.textContent = '...';

      try {
        const result = await this.send({ action: 'listModels', providerId });
        if (!hasExactResponseShape(result, ['models']) ||
            !Array.isArray(result.models) || result.models.length > 1_000 ||
            result.models.some((model) =>
              !hasExactResponseShape(model, ['id', 'name']) ||
              typeof model.id !== 'string' || model.id.length === 0 ||
              typeof model.name !== 'string' || model.name.length === 0)) {
          throw new Error('Invalid AI model-list response');
        }
        const models = result.models;
        if (!this.isCurrentProviderAction(providerId, selectionGeneration, actionGeneration) ||
            this.hasUnsavedProviderConfiguration(providerId)) return false;

        if (models.length === 0) {
          showToast('No models found. Check API key and try again.', 'error');
          return false;
        }

        const currentValue = select.value;

        select.innerHTML = '';
        for (const model of models) {
          const option = document.createElement('option');
          option.value = model.id;
          option.textContent = model.name;
          select.appendChild(option);
        }

        const values = models.map(({ id }) => id);
        if (values.includes(currentValue)) select.value = currentValue;

        showToast(`Loaded ${models.length} models`, 'success');
        return true;
      } catch {
        if (this.isCurrentProviderAction(providerId, selectionGeneration, actionGeneration)) {
          showToast('Failed to load models', 'error');
        }
        return false;
      } finally {
        if (btn) btn.textContent = prevText || 'Load';
      }
    } finally {
      releaseOperation();
    }
  }

  isCurrentProviderAction(providerId, selectionGeneration, actionGeneration) {
    return this.providerSelect.value === providerId &&
      (this.providerSelectionGeneration || 0) === selectionGeneration &&
      this.providerActionGeneration === actionGeneration;
  }

  // ── Test Connection ──

  async testConnection() {
    const providerId = this.providerSelect.value;
    if (!providerId) {
      showToast('Select a provider first', 'error');
      return false;
    }

    const selectionGeneration = this.providerSelectionGeneration || 0;
    const actionGeneration = (this.providerActionGeneration || 0) + 1;
    this.providerActionGeneration = actionGeneration;
    const releaseOperation = this.beginExclusiveOperation('test', [
      this.providerSelect,
      this.testButton,
      this.saveButton,
    ]);
    if (!releaseOperation) return false;

    try {
      let blockReason;
      try {
        blockReason = await this.providerActionBlockReason(providerId);
      } catch {
        if (this.isCurrentProviderAction(providerId, selectionGeneration, actionGeneration)) {
          this.testResultEl.hidden = false;
          this.testResultEl.textContent = 'Could not verify AI provider readiness.';
          this.testResultEl.className = 'drive-status';
        }
        return false;
      }
      if (!this.isCurrentProviderAction(providerId, selectionGeneration, actionGeneration)) {
        return false;
      }
      if (blockReason) {
        this.testResultEl.hidden = false;
        this.testResultEl.textContent = blockReason;
        this.testResultEl.className = 'drive-status';
        return false;
      }

      this.testResultEl.hidden = false;
      this.testResultEl.textContent = 'Testing...';
      this.testResultEl.className = 'drive-status';

      try {
        const result = await this.send({ action: 'testAIConnection', providerId });
        if (!hasExactResponseShape(result, ['success']) ||
            typeof result.success !== 'boolean') {
          throw new Error('Invalid AI connection-test response');
        }
        if (!this.isCurrentProviderAction(providerId, selectionGeneration, actionGeneration) ||
            this.hasUnsavedProviderConfiguration(providerId)) return false;
        if (result.success) {
          this.testResultEl.textContent = 'Connection successful!';
          this.testResultEl.className = 'drive-status connected';
        } else {
          this.testResultEl.textContent = 'Connection failed — check your settings';
          this.testResultEl.className = 'drive-status';
        }
        return result.success;
      } catch {
        if (!this.isCurrentProviderAction(providerId, selectionGeneration, actionGeneration)) {
          return false;
        }
        this.testResultEl.textContent = 'Connection test failed.';
        this.testResultEl.className = 'drive-status';
        return false;
      }
    } finally {
      releaseOperation();
    }
  }

  // ── Save Settings ──

  beginSaveOwnership() {
    return this.beginExclusiveOperation('save', [
      this.enabledCheckbox,
      this.providerSelect,
      this.passphraseToggle,
      this.passphraseInput,
      this.unlockPassphraseInput,
      this.unlockButton,
      this.testButton,
      this.saveButton,
    ]);
  }

  async saveSettings() {
    if (this.activeOperation || this.saveInFlight || this.unlockInFlight) return false;
    const providerId = this.providerSelect.value;
    const enabled = this.enabledCheckbox.checked;

    if (enabled && !providerId) {
      showToast('Select a provider to enable AI', 'error');
      return false;
    }

    const currentSettings = this.currentSettings;
    if (!currentSettings) {
      showToast('Refresh AI settings before saving', 'error');
      return false;
    }

    const protectionMode = this.passphraseToggle.indeterminate
      ? 'mixed'
      : (this.passphraseToggle.checked ? 'passphrase' : 'device');
    const keyUpdates = [];
    for (const pid of PROVIDERS_WITH_KEY) {
      const plainKey = this.root.querySelector(`#${pid}-api-key`)?.value;
      if (typeof plainKey === 'string' && plainKey.length > 0) {
        keyUpdates.push({ providerId: pid, plainKey });
      }
    }

    const currentMode = currentSettings.protectionMode;
    const savedKeyProviders = PROVIDERS_WITH_KEY.filter(
      (pid) => currentSettings.providerConfigs?.[pid]?.hasApiKey === true,
    );
    const updatedProviders = new Set(keyUpdates.map(({ providerId: id }) => id));
    const changesUniformProtection = currentMode !== 'mixed' && protectionMode !== currentMode;
    const changesMixedProtection = currentMode === 'mixed' &&
      (protectionMode !== 'mixed' || keyUpdates.length > 0);
    if ((changesUniformProtection || changesMixedProtection) &&
        savedKeyProviders.some((pid) => !updatedProviders.has(pid))) {
      showToast(REENTER_ALL_KEYS_MESSAGE, 'error');
      return false;
    }
    if (protectionMode === 'mixed' && keyUpdates.length > 0) {
      showToast(REENTER_ALL_KEYS_MESSAGE, 'error');
      return false;
    }

    let passphrase = null;
    if (protectionMode === 'passphrase' && keyUpdates.length > 0) {
      passphrase = this.passphraseInput.value;
      if (typeof passphrase !== 'string' || passphrase.length === 0) {
        showToast('Enter a passphrase before saving API keys', 'error');
        return false;
      }
    }

    const providerConfigs = {};
    for (const pid of ALL_PROVIDERS) {
      const persisted = currentSettings.providerConfigs?.[pid] || PROVIDER_DEFAULTS[pid];
      providerConfigs[pid] = {
        model: this.root.querySelector(`#${pid}-model`)?.value ||
          persisted.model || PROVIDER_DEFAULTS[pid].model,
      };
    }
    providerConfigs.custom.baseUrl = this.root.querySelector('#custom-base-url')?.value ||
      currentSettings.providerConfigs?.custom?.baseUrl || PROVIDER_DEFAULTS.custom.baseUrl;

    const settings = {
      enabled,
      providerId: providerId || null,
      providerConfigs,
      protectionMode,
    };

    const releaseSave = this.beginSaveOwnership();
    if (!releaseSave) return false;
    const saveOperation = this.activeOperation;
    try {
      let response;
      try {
        response = await this.send({
          action: 'saveAISettings',
          settings,
          keyUpdates,
          passphrase,
        });
        if (!hasExactResponseShape(response, ['saved', 'unlocked']) ||
            response.saved !== true || typeof response.unlocked !== 'boolean') {
          throw new Error('Invalid AI settings response');
        }
      } catch (err) {
        if (err?.message === REENTER_ALL_KEYS_MESSAGE) {
          showToast(REENTER_ALL_KEYS_MESSAGE, 'error');
        } else {
          showToast('Failed to save AI settings', 'error');
        }
        return false;
      }

      // The plaintext was committed to encrypted local state. Clear only the
      // exact submitted value so no newer programmatic edit can be erased.
      for (const { providerId: updatedProviderId, plainKey } of keyUpdates) {
        const input = this.root.querySelector(`#${updatedProviderId}-api-key`);
        if (input?.value === plainKey) input.value = '';
      }
      if (passphrase !== null && this.passphraseInput?.value === passphrase) {
        this.passphraseInput.value = '';
      }

      let refreshed = true;
      try {
        await this.refresh({ operation: saveOperation });
      } catch {
        refreshed = false;
        showToast('AI settings were saved, but the view could not refresh', 'error');
      }

      try {
        await this.onAvailabilityChanged?.();
      } catch {
        showToast('AI settings were saved, but AI status could not refresh', 'error');
      }

      if (!refreshed) return true;
      if (!response.unlocked) {
        showToast('AI settings saved, but the selected provider is locked. Unlock it to continue.', 'error');
        return true;
      }
      showToast('AI settings saved', 'success');
      return true;
    } finally {
      releaseSave();
    }
  }

  // ── Clear Cache ──

  async clearCache() {
    try {
      await this.send({ action: 'clearAICache' });
      showToast('AI cache cleared', 'success');
      return true;
    } catch (err) {
      showToast('Failed to clear AI cache: ' + err.message, 'error');
      return false;
    }
  }

  // ── Keep Awake Exception List ──

  async refreshKeepAwakeList() {
    if (!this.keepAwakeListEl) return null;

    try {
      const list = await this.send({ action: 'getKeepAwakeList' });
      this.renderKeepAwakeList(list || []);
      return null;
    } catch (err) {
      this.keepAwakeListEl.innerHTML = '<div class="keep-awake-domain-list-empty">Failed to load</div>';
      return err;
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
      await this.send({ action: 'setKeepAwake', scope: 'domain', domain, keepAwake: true });
      input.value = '';
      const refreshError = await this.refreshKeepAwakeList();
      if (refreshError) {
        showToast('Domain changed, but the list could not refresh: ' + refreshError.message, 'error');
        return;
      }
      showToast(`Added ${domain}`, 'success');
    } catch (err) {
      showToast('Failed to add domain: ' + err.message, 'error');
    }
  }

  async removeKeepAwakeDomain(domain) {
    try {
      const list = await this.send({ action: 'getKeepAwakeList' });
      const filtered = (list || []).filter(d => d !== domain);
      await this.send({ action: 'saveKeepAwakeList', domains: filtered });
      const refreshError = await this.refreshKeepAwakeList();
      if (refreshError) {
        showToast('Domain was removed, but the list could not refresh: ' + refreshError.message, 'error');
        return;
      }
      showToast(`Removed ${domain}`, 'success');
    } catch (err) {
      showToast('Failed to remove domain: ' + err.message, 'error');
    }
  }

  async resetKeepAwakeDefaults() {
    try {
      // Clear the storage key so getKeepAwakeList re-seeds defaults
      await this.send({ action: 'saveKeepAwakeList', domains: null });
      // Force re-seed by calling getKeepAwakeList (which seeds when null)
      const refreshError = await this.refreshKeepAwakeList();
      if (refreshError) {
        showToast('Defaults were restored, but the list could not refresh: ' + refreshError.message, 'error');
        return;
      }
      showToast('Reset to defaults', 'success');
    } catch (err) {
      showToast('Failed to reset: ' + err.message, 'error');
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
      const refreshError = await this.refreshKeepAwakeList();
      if (refreshError) {
        showToast('Suggestions were applied, but the list could not refresh: ' + refreshError.message, 'error');
        return;
      }
      showToast(`Added ${added} domain${added !== 1 ? 's' : ''} to keep-awake list`, 'success');
      this.keepAwakeSuggestionsEl.hidden = true;
    } catch (err) {
      showToast('Failed to apply suggestions: ' + err.message, 'error');
    }
  }

  // ── Helpers ──

  send(msg) {
    return sendOrThrow(msg);
  }
}
