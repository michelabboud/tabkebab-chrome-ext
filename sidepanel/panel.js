// panel.js — Side panel entry point, navigation, and message bus

import { TabList } from './components/tab-list.js';
import { SessionManager } from './components/session-manager.js';
import { DuplicateFinder } from './components/duplicate-finder.js';
import { GroupEditor } from './components/group-editor.js';
import { DriveSync } from './components/drive-sync.js';
import { WindowList } from './components/window-list.js';
import { AISettings } from './components/ai-settings.js';
import { CommandBar } from './components/command-bar.js';
import { StashList } from './components/stash-list.js';

// --- Initialize view controllers ---
const driveSyncCtrl = new DriveSync(document.getElementById('view-settings'));
const aiSettingsCtrl = new AISettings(document.getElementById('view-settings'));

const controllers = {
  tabs: new TabList(document.getElementById('sub-domains')),
  sessions: new SessionManager(document.getElementById('view-sessions')),
  duplicates: new DuplicateFinder(document.getElementById('sub-duplicates')),
  groups: new GroupEditor(document.getElementById('sub-groups')),
  windows: new WindowList(document.getElementById('view-windows')),
  stash: new StashList(document.getElementById('view-stash')),
  settings: {
    refresh() {
      driveSyncCtrl.refresh();
      aiSettingsCtrl.refresh();
    },
  },
};

// --- AI command bar ---
const commandBar = new CommandBar(document.getElementById('command-bar'));

// --- Sub-tab mapping (subtab name → controller key) ---
const subControllers = { domains: 'tabs', groups: 'groups', duplicates: 'duplicates' };

// --- Primary navigation (Sessions / Windows / Tabs) ---
const navButtons = document.querySelectorAll('.tab-nav [role="tab"]');
const views = document.querySelectorAll('.view');
const settingsBtn = document.getElementById('btn-settings');

navButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.view;

    // Deselect all primary nav + gear
    navButtons.forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    settingsBtn.classList.remove('active');

    // Activate clicked tab
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    // Show the target view, hide all others
    views.forEach(v => v.classList.toggle('hidden', v.id !== `view-${target}`));

    // Refresh the activated controller
    if (target === 'tabs') {
      // Refresh the active sub-tab's controller
      const activeSub = document.querySelector('.sub-nav [role="tab"].active');
      const subKey = subControllers[activeSub?.dataset.subtab || 'domains'];
      controllers[subKey]?.refresh?.();
    } else {
      controllers[target]?.refresh?.();
    }
  });
});

// --- Settings gear icon ---
settingsBtn.addEventListener('click', () => {
  // Deselect all primary nav
  navButtons.forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-selected', 'false');
  });
  settingsBtn.classList.add('active');

  // Show settings view, hide all others
  views.forEach(v => v.classList.toggle('hidden', v.id !== 'view-settings'));
  controllers.settings?.refresh?.();
});

// --- Sub-navigation (Domains / Groups / Duplicates inside Tabs view) ---
const subNavButtons = document.querySelectorAll('.sub-nav [role="tab"]');
const subViews = document.querySelectorAll('.sub-view');

subNavButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.subtab;

    // Deselect all sub-tabs
    subNavButtons.forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    // Show the target sub-view, hide others
    subViews.forEach(v => v.classList.toggle('hidden', v.id !== `sub-${target}`));

    // Refresh the activated sub-controller
    const key = subControllers[target];
    controllers[key]?.refresh?.();
  });
});

// --- Listen for tab changes from service worker ---
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'tabsChanged') {
    controllers.tabs.refresh();
  }
});

// --- Initial load ---
controllers.tabs.refresh();

// --- Toggle AI-dependent UI elements ---
async function updateAIVisibility() {
  try {
    const result = await chrome.runtime.sendMessage({ action: 'isAIAvailable' });
    const available = result?.available || false;

    // Toggle body class so CSS can show/hide .ai-feature elements
    document.body.classList.toggle('ai-available', available);

    // Show/hide command bar
    const commandBarEl = document.getElementById('command-bar');
    if (commandBarEl) commandBarEl.hidden = !available;

    // Show/hide Smart Group button
    const smartGroupBtn = document.getElementById('btn-smart-group');
    if (smartGroupBtn) smartGroupBtn.hidden = !available;

    // Show/hide AI Suggest keep-awake button
    const suggestKeepAwakeBtn = document.getElementById('btn-suggest-keep-awake');
    if (suggestKeepAwakeBtn) suggestKeepAwakeBtn.hidden = !available;
  } catch {
    // AI not available — keep hidden
    document.body.classList.remove('ai-available');
  }
}

updateAIVisibility();

// Re-check when settings might change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.aiSettings) {
    updateAIVisibility();
  }
});
