// first-run-walkthrough.js — Inline, once-per-profile side-panel introduction

import { showToast } from './toast.js';

export const FIRST_RUN_WALKTHROUGH_KEY = 'firstRunWalkthroughSeen';

export const FIRST_RUN_STEPS = Object.freeze([
  {
    title: 'Welcome to TabKebab',
    description: 'Use one simple loop to clear tab clutter without losing your place.',
  },
  {
    title: 'Group related tabs',
    description: 'Start in Tabs and group open pages by domain so each topic is easy to scan.',
    actionLabel: 'Open Tabs',
    destination: { view: 'tabs' },
  },
  {
    title: 'Stash what you do not need now',
    description: 'Use Stash on a domain, group, or window to save those tabs and close them safely.',
    actionLabel: 'Find tabs to stash',
    destination: { view: 'tabs' },
  },
  {
    title: 'Restore when you are ready',
    description: 'Open Stash later and restore the saved tabs in one click.',
    actionLabel: 'Open Stash',
    destination: { view: 'stash' },
  },
]);

function errorMessage(error) {
  return error?.message || String(error);
}

export class FirstRunWalkthrough {
  constructor(rootEl, {
    storage = globalThis.chrome?.storage?.local,
    navigate = () => {},
    notify = showToast,
  } = {}) {
    this.root = rootEl;
    this.storage = storage;
    this.navigate = navigate;
    this.notify = notify;
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
    this.actionEl.addEventListener('click', () => this.runStepAction());
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

  launch(stepIndex = 0) {
    this.currentStep = Math.max(0, Math.min(stepIndex, FIRST_RUN_STEPS.length - 1));
    this.root.hidden = false;
    this.render();
  }

  dismiss() {
    this.root.hidden = true;
  }

  previous() {
    if (this.currentStep > 0) {
      this.currentStep -= 1;
      this.render();
    }
  }

  next() {
    if (this.currentStep >= FIRST_RUN_STEPS.length - 1) {
      this.dismiss();
      return;
    }
    this.currentStep += 1;
    this.render();
  }

  runStepAction() {
    const destination = FIRST_RUN_STEPS[this.currentStep].destination;
    if (destination) this.navigate({ ...destination });
  }

  render() {
    const step = FIRST_RUN_STEPS[this.currentStep];
    this.stepEl.textContent = `${this.currentStep + 1} of ${FIRST_RUN_STEPS.length}`;
    this.titleEl.textContent = step.title;
    this.descriptionEl.textContent = step.description;
    this.actionEl.hidden = !step.actionLabel;
    this.actionEl.textContent = step.actionLabel || '';
    this.backEl.hidden = this.currentStep === 0;
    this.nextEl.textContent =
      this.currentStep === FIRST_RUN_STEPS.length - 1 ? 'Finish' : 'Next';
  }
}
