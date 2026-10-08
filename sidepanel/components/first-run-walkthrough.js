// first-run-walkthrough.js — Inline, once-per-profile side-panel introduction

import { showToast } from './toast.js';

export const FIRST_RUN_WALKTHROUGH_KEY = 'firstRunWalkthroughSeen';

// Descriptions may mark a control name with **double asterisks**; it renders
// as <strong> (never as HTML).
export const FIRST_RUN_STEPS = Object.freeze([
  {
    title: 'Welcome to TabKebab',
    description: 'Group, stash, restore: three steps to a calmer tab bar.',
  },
  {
    title: 'Group related tabs',
    description: '**Group by domain** gathers each site\'s tabs into one Chrome group, so every topic is easy to scan.',
    actionLabel: 'Show me',
    destination: { view: 'tabs' },
    subtab: 'domains',
    highlight: ['#btn-group-by-domain'],
  },
  {
    title: 'Stash tabs for later',
    description: 'Hit **Stash** on any domain, group or window. The tabs close, but nothing is lost.',
    actionLabel: 'Show me',
    destination: { view: 'tabs' },
    subtab: 'domains',
    highlight: ['#sub-domains .stash-btn', '.stash-btn', '#sub-domains .domain-group-header'],
    feature: 'stash',
    missingHint: 'Open a few tabs first: each domain row gets its own Stash button.',
  },
  {
    title: 'Restore when you\'re ready',
    description: 'Open **Stash** any time and bring the tabs back in one click.',
    actionLabel: 'Open Stash',
    destination: { view: 'stash' },
    feature: 'stash',
  },
]);

export const HIGHLIGHT_CLASSES = Object.freeze(['highlight-section', 'walkthrough-target']);
const HIGHLIGHT_MS = 2400;
const FIND_RETRY_MS = 120;
const FIND_ATTEMPTS = 8;

function isShown(el) {
  if (!el || el.hidden) return false;
  if (typeof el.closest === 'function' && el.closest('[hidden]')) return false;
  return true;
}

function defaultFindTarget(selectors) {
  const doc = globalThis.document;
  if (!doc?.querySelectorAll) return null;
  for (const selector of selectors) {
    for (const el of doc.querySelectorAll(selector)) {
      if (isShown(el)) return el;
    }
  }
  return null;
}

function defaultSelectSubtab(name) {
  const tab = globalThis.document?.querySelector?.(`#view-tabs .sub-nav [data-subtab="${name}"]`);
  if (tab && !tab.classList?.contains('active')) tab.click();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error) {
  return error?.message || String(error);
}

export class FirstRunWalkthrough {
  constructor(rootEl, {
    storage = globalThis.chrome?.storage?.local,
    navigate = () => {},
    notify = showToast,
    findTarget = defaultFindTarget,
    selectSubtab = defaultSelectSubtab,
    delay = wait,
    isFeatureEnabled = () => true,
  } = {}) {
    this.root = rootEl;
    this.storage = storage;
    this.navigate = navigate;
    this.notify = notify;
    this.findTarget = findTarget;
    this.selectSubtab = selectSubtab;
    this.delay = delay;
    this.isFeatureEnabled = isFeatureEnabled;
    this._highlighted = null;
    this.currentStep = 0;

    this.stepEl = rootEl.querySelector('#walkthrough-step');
    this.titleEl = rootEl.querySelector('#walkthrough-title');
    this.descriptionEl = rootEl.querySelector('#walkthrough-description');
    this.actionEl = rootEl.querySelector('#walkthrough-action');
    this.backEl = rootEl.querySelector('#walkthrough-back');
    this.nextEl = rootEl.querySelector('#walkthrough-next');
    this.dismissEl = rootEl.querySelector('#walkthrough-dismiss');

    this.dismissEl.addEventListener('click', () => this.dismiss());
    this.backEl.addEventListener('click', () => this.previous());
    this.nextEl.addEventListener('click', () => this.next());
    this.actionEl.addEventListener('click', () => { void this.runStepAction(); });
  }

  async startIfNeeded() {
    let stored;
    try {
      stored = await this.storage.get(FIRST_RUN_WALKTHROUGH_KEY);
    } catch (error) {
      this.notify(
        `Getting started could not check first-run status: ${errorMessage(error)}`,
        'error',
      );
      return false;
    }

    if (stored?.[FIRST_RUN_WALKTHROUGH_KEY]) return false;

    this.launch();
    try {
      await this.storage.set({ [FIRST_RUN_WALKTHROUGH_KEY]: true });
    } catch (error) {
      this.notify(
        `Getting started is open, but its first-run flag could not be saved: ${errorMessage(error)}`,
        'error',
      );
    }
    return true;
  }

  /**
   * Steps for the features that are switched on (Settings → Features). A
   * step tied to a switched-off feature is skipped.
   */
  get steps() {
    return FIRST_RUN_STEPS.filter((step) => !step.feature || this.isFeatureEnabled(step.feature));
  }

  launch(stepIndex = 0) {
    this.currentStep = Math.max(0, Math.min(stepIndex, this.steps.length - 1));
    this.root.hidden = false;
    this.render();
  }

  dismiss() {
    this.clearHighlight();
    this.root.hidden = true;
  }

  previous() {
    if (this.currentStep > 0) {
      this.currentStep -= 1;
      this.render();
    }
  }

  next() {
    if (this.currentStep >= this.steps.length - 1) {
      this.dismiss();
      return;
    }
    this.currentStep += 1;
    this.render();
  }

  /**
   * Step actions do something visible: open the right view and point at the
   * control the step talks about (highlight + scroll + focus).
   * @returns {Promise<HTMLElement|null>} the highlighted control, if any
   */
  async runStepAction() {
    const step = this.steps[this.currentStep];
    if (!step) return null;
    if (step.destination) this.navigate({ ...step.destination });
    if (step.subtab) this.selectSubtab(step.subtab);
    if (!step.highlight) return null;

    let target = null;
    for (let attempt = 0; attempt < FIND_ATTEMPTS && !target; attempt += 1) {
      if (attempt > 0) await this.delay(FIND_RETRY_MS);
      target = this.findTarget(step.highlight);
    }
    if (!target) {
      if (step.missingHint) this.notify(step.missingHint, 'info');
      return null;
    }
    this.highlight(target);
    return target;
  }

  highlight(target) {
    this.clearHighlight();
    target.classList?.add(...HIGHLIGHT_CLASSES);
    target.scrollIntoView?.({ block: 'nearest' });
    target.focus?.({ preventScroll: true });
    this._highlighted = target;
    this._highlightTimer = setTimeout(() => this.clearHighlight(), HIGHLIGHT_MS);
  }

  clearHighlight() {
    clearTimeout(this._highlightTimer);
    this._highlighted?.classList?.remove(...HIGHLIGHT_CLASSES);
    this._highlighted = null;
  }

  renderDescription(text) {
    const parts = String(text).split(/\*\*(.+?)\*\*/g);
    if (parts.length === 1 || typeof globalThis.document?.createElement !== 'function') {
      this.descriptionEl.textContent = text.replace(/\*\*/g, '');
      return;
    }
    const nodes = parts.map((part, index) => {
      const el = globalThis.document.createElement(index % 2 === 1 ? 'strong' : 'span');
      el.textContent = part;
      return el;
    });
    this.descriptionEl.replaceChildren(...nodes);
  }

  render() {
    const steps = this.steps;
    this.currentStep = Math.max(0, Math.min(this.currentStep, steps.length - 1));
    const step = steps[this.currentStep];
    this.stepEl.textContent = `${this.currentStep + 1} of ${steps.length}`;
    this.titleEl.textContent = step.title;
    this.renderDescription(step.description);
    this.actionEl.hidden = !step.actionLabel;
    this.actionEl.textContent = step.actionLabel || '';
    this.backEl.hidden = this.currentStep === 0;
    this.nextEl.textContent =
      this.currentStep === steps.length - 1 ? 'Finish' : 'Next';
  }
}
