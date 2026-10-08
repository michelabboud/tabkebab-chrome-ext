// smart-group-fallback.js — Smart group availability hint + inline fallback.
//
// On load we probe Chrome's on-device AI. Only a successful probe shows the
// one-line "on-device AI is ready" hint; nothing is shown up front otherwise.
// When Smart group cannot run, the fallback offers two working paths: group by
// domain now, or add an API key for topic grouping.

import { sendOrThrow } from '../message-client.js';
import { CHROME_AI_LANGUAGE_OPTIONS } from '../../core/ai/provider-chrome.js';

const COPY = Object.freeze({
  'zero-config:unavailable':
    "On-device AI isn't ready in this Chrome. Group by domain now, or add an API key for topic grouping.",
  'zero-config:timeout':
    'On-device AI took too long, so Smart group stopped safely. Group by domain now, or add an API key for topic grouping.',
  'zero-config:failed':
    "On-device AI couldn't finish Smart group. Group by domain now, or add an API key for topic grouping.",
  'configured:unavailable':
    "Your AI provider isn't reachable right now. Group by domain now, or check your API key.",
  'configured:timeout':
    'Your AI provider took too long, so Smart group stopped safely. Group by domain now, or check your API key.',
  'configured:failed':
    "Your AI provider couldn't finish Smart group. Group by domain now, or check your API key.",
});

const SETTINGS_LABEL = Object.freeze({
  'zero-config': 'Add an API key',
  configured: 'Check AI settings',
});

export const SMART_GROUP_READY_TITLE =
  'Groups tabs by topic using on-device AI. Nothing leaves this computer.';

function languageModelApi(scope = globalThis) {
  if (typeof scope.LanguageModel !== 'undefined') return scope.LanguageModel;
  if (scope.self?.ai?.languageModel) return scope.self.ai.languageModel;
  return null;
}

/**
 * Probe Chrome's on-device Prompt API without starting a download.
 * @returns {Promise<'available'|'downloadable'|'unavailable'>}
 */
export async function probeOnDeviceAI(scope = globalThis) {
  const api = languageModelApi(scope);
  if (!api) return 'unavailable';
  try {
    let status;
    if (typeof api.availability === 'function') {
      status = await api.availability(CHROME_AI_LANGUAGE_OPTIONS);
    } else if (typeof api.capabilities === 'function') {
      const caps = await api.capabilities();
      status = caps?.available === 'readily' ? 'available' : caps?.available;
    }
    if (status === 'available') return 'available';
    if (['downloadable', 'downloading', 'after-download'].includes(status)) return 'downloadable';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export class SmartGroupFallback {
  constructor(rootEl, {
    onDomainFallback = async () => {},
    navigate = () => {},
    probe = probeOnDeviceAI,
    hintEl = globalThis.document?.getElementById?.('smart-group-ai-hint') ?? null,
    smartGroupButton = globalThis.document?.getElementById?.('btn-smart-group') ?? null,
    send = sendOrThrow,
  } = {}) {
    this.root = rootEl;
    this.messageEl = rootEl?.querySelector('#smart-group-fallback-message');
    this.domainButton = rootEl?.querySelector('#btn-smart-group-domain-fallback');
    this.settingsLink = rootEl?.querySelector('#link-smart-group-settings');
    this.hintEl = hintEl;
    this.smartGroupButton = smartGroupButton;
    this.onDomainFallback = onDomainFallback;
    this.navigate = navigate;
    this.onDeviceStatus = 'unknown';
    this.send = send;

    if (this.domainButton) {
      this.domainButton.textContent = 'Group by domain';
    }
    if (this.settingsLink) {
      this.settingsLink.textContent = SETTINGS_LABEL['zero-config'];
    }

    this.domainButton?.addEventListener('click', () => {
      this.hide();
      void this.onDomainFallback();
    });
    this.settingsLink?.addEventListener('click', (event) => {
      event?.preventDefault?.();
      this.navigate({ view: 'settings', sectionId: 'settings-ai-section' });
    });

    this.ready = this.checkAvailability(probe);
  }

  /** Probe on-device AI once and reveal the hint only when it is usable. */
  async checkAvailability(probe = probeOnDeviceAI) {
    let status = 'unavailable';
    try {
      status = await probe();
    } catch {
      status = 'unavailable';
    }
    // A configured cloud provider takes precedence over on-device AI, so the
    // "nothing leaves this computer" hint would be wrong; stay quiet then.
    if (status === 'available' && await this.usesConfiguredProvider()) {
      status = 'configured';
    }
    this.onDeviceStatus = status;
    const ready = status === 'available';
    if (this.hintEl) this.hintEl.hidden = !ready;
    if (ready && this.smartGroupButton) {
      this.smartGroupButton.title = SMART_GROUP_READY_TITLE;
    }
    return status;
  }

  async usesConfiguredProvider() {
    try {
      const settings = await this.send({ action: 'getAISettings' });
      if (settings?.enabled !== true) return false;
      if (settings.providerId === 'custom') return true;
      return settings.providerId !== 'chrome-ai' &&
        settings.providerConfigs?.[settings.providerId]?.hasApiKey === true;
    } catch {
      return false;
    }
  }

  show({ reason, source }) {
    const safeSource = source === 'zero-config' ? 'zero-config' : 'configured';
    const safeReason = ['unavailable', 'timeout', 'failed'].includes(reason)
      ? reason
      : 'failed';
    if (this.messageEl) {
      this.messageEl.textContent = COPY[`${safeSource}:${safeReason}`];
    }
    if (this.settingsLink) {
      this.settingsLink.textContent = SETTINGS_LABEL[safeSource];
    }
    // The fallback replaces the hint: never show "ready" and "not ready" together.
    if (this.hintEl) this.hintEl.hidden = true;
    if (this.root) this.root.hidden = false;
  }

  hide() {
    if (this.root) this.root.hidden = true;
  }
}
