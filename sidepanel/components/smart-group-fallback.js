const COPY = Object.freeze({
  'zero-config:unavailable':
    "Chrome's built-in AI isn't available here yet. This Chrome version may not support it, or the on-device model may still need to download. You can keep going now with domain grouping or set up an API key.",
  'configured:unavailable':
    'Your configured AI is unavailable right now. Nothing is blocked: keep going with domain grouping or check your API-key settings.',
  'configured:timeout':
    'Smart Group took too long and was stopped safely. Nothing is blocked: keep going with domain grouping or check your API-key settings.',
  'zero-config:timeout':
    "Chrome's built-in AI took too long and was stopped safely. Nothing is blocked: keep going with domain grouping or set up an API key.",
  'configured:failed':
    'Your configured AI could not finish Smart Group. Nothing is blocked: keep going with domain grouping or check your API-key settings.',
  'zero-config:failed':
    "Chrome's built-in AI could not finish Smart Group. Nothing is blocked: keep going with domain grouping or set up an API key.",
});

export class SmartGroupFallback {
  constructor(rootEl, {
    onDomainFallback = async () => {},
    navigate = () => {},
  } = {}) {
    this.root = rootEl;
    this.messageEl = rootEl?.querySelector('#smart-group-fallback-message');
    this.domainButton = rootEl?.querySelector('#btn-smart-group-domain-fallback');
    this.settingsLink = rootEl?.querySelector('#link-smart-group-settings');
    this.onDomainFallback = onDomainFallback;
    this.navigate = navigate;

    if (this.domainButton) {
      this.domainButton.textContent = 'Use domain grouping instead';
    }
    if (this.settingsLink) {
      this.settingsLink.textContent = 'Set up an API key';
    }

    this.domainButton?.addEventListener('click', () => {
      this.hide();
      void this.onDomainFallback();
    });
    this.settingsLink?.addEventListener('click', (event) => {
      event.preventDefault();
      this.navigate({ view: 'settings', sectionId: 'settings-ai-section' });
    });
  }

  show({ reason, source }) {
    const safeSource = source === 'zero-config' ? 'zero-config' : 'configured';
    const safeReason = ['unavailable', 'timeout', 'failed'].includes(reason)
      ? reason
      : 'failed';
    if (this.messageEl) {
      this.messageEl.textContent = COPY[`${safeSource}:${safeReason}`];
    }
    if (this.root) this.root.hidden = false;
  }

  hide() {
    if (this.root) this.root.hidden = true;
  }
}
