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
import { SettingsManager } from './components/settings-manager.js';
import { GlobalSearch } from './components/global-search.js';
import { FocusPanel } from './components/focus-panel.js';

// --- Initialize view controllers ---

const settingsRoot = document.getElementById('view-settings');
const driveSyncCtrl = new DriveSync(settingsRoot);
const aiSettingsCtrl = new AISettings(settingsRoot);
const settingsManagerCtrl = new SettingsManager(settingsRoot);

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
      settingsManagerCtrl.refresh();
    },
  },
};

// --- AI command bar ---
const commandBar = new CommandBar(document.getElementById('command-bar'));

// --- Global search ---
const globalSearch = new GlobalSearch();
document.getElementById('btn-search').addEventListener('click', () => globalSearch.toggle());

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
      const activeSub = document.querySelector('#view-tabs .sub-nav [role="tab"].active');
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

// --- Focus panel ---
const focusPanel = new FocusPanel(document.getElementById('view-focus'));
const focusBtn = document.getElementById('btn-focus');

function showFocusView() {
  navButtons.forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-selected', 'false');
  });
  settingsBtn.classList.remove('active');
  focusBtn.classList.add('active');
  views.forEach(v => v.classList.toggle('hidden', v.id !== 'view-focus'));
  focusPanel.refresh();
}

focusBtn.addEventListener('click', showFocusView);

// Also deselect focus btn when primary nav or settings is clicked
navButtons.forEach(btn => {
  btn.addEventListener('click', () => focusBtn.classList.remove('active'));
});
settingsBtn.addEventListener('click', () => focusBtn.classList.remove('active'));

// Update focus button pulse state on load and focus events
async function updateFocusBtnState() {
  try {
    const state = await chrome.runtime.sendMessage({ action: 'getFocusState' });
    focusBtn.classList.toggle('focus-active', !!(state?.status === 'active' || state?.status === 'paused'));
  } catch {}
}
updateFocusBtnState();

// --- Sub-navigation (Domains / Groups / Duplicates inside Tabs view) ---
const subNavButtons = document.querySelectorAll('#view-tabs .sub-nav [role="tab"]');
const subViews = document.querySelectorAll('#view-tabs .sub-view');

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

// --- Global stats bar ---
async function refreshGlobalStats() {
  try {
    const data = await chrome.runtime.sendMessage({ action: 'getWindowStats' });
    if (!data) return;
    document.getElementById('stat-windows').textContent = data.totalWindows ?? 0;
    document.getElementById('stat-tabs').textContent = data.totalTabs ?? 0;
    const pct = data.totalTabs > 0
      ? Math.round((data.activeTabs / data.totalTabs) * 100)
      : 100;
    document.getElementById('stat-kebab').textContent = pct + '%';
  } catch {
    // Stats not available yet
  }
}

// --- Duplicate badge ---
function updateDupeBadge(count) {
  const badge = document.getElementById('dupe-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

document.addEventListener('dupesUpdated', (e) => {
  updateDupeBadge(e.detail.count);
});

// --- Periodic duplicate check (every 60s) ---
async function checkDuplicates() {
  try {
    const dupes = await chrome.runtime.sendMessage({ action: 'findDuplicates' });
    const count = dupes
      ? dupes.reduce((sum, g) => sum + g.tabs.length - 1, 0)
      : 0;
    updateDupeBadge(count);
  } catch {
    // Ignore — service worker may not be ready
  }
}

checkDuplicates();
setInterval(checkDuplicates, 60000);

// --- Listen for tab changes from service worker ---
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'tabsChanged') {
    controllers.tabs.refresh();
    refreshGlobalStats();
  }
  if (message.type === 'focusEnded' || message.type === 'focusDistraction') {
    updateFocusBtnState();
  }
});

// --- Theme support ---
function applyTheme(theme) {
  const html = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    html.setAttribute('data-theme', theme);
  } else {
    html.removeAttribute('data-theme');
  }
}

// --- Default view ---
function applyDefaultView(view) {
  if (!view || view === 'tabs') return; // tabs is already the default active view
  const targetBtn = document.querySelector(`.tab-nav [data-view="${view}"]`);
  if (targetBtn) targetBtn.click();
}

// --- Load settings on startup ---
async function initSettings() {
  try {
    const settings = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (settings) {
      applyTheme(settings.theme);
      applyDefaultView(settings.defaultView);
    }
  } catch {
    // Settings not available yet
  }
}

initSettings();

// --- Re-apply theme/view when settings change ---
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.tabkebabSettings) {
      const newSettings = changes.tabkebabSettings.newValue;
      if (newSettings) {
        applyTheme(newSettings.theme);
      }
    }
    if (changes.aiSettings) {
      updateAIVisibility();
    }
  }
});

// --- Initial load ---
controllers.tabs.refresh();
refreshGlobalStats();

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

    // Update AI provider label
    const providerLabel = document.getElementById('ai-provider-label');
    if (providerLabel && available) {
      try {
        const aiSettings = await chrome.runtime.sendMessage({ action: 'getAISettings' });
        const providerNames = {
          openai: 'OpenAI',
          claude: 'Claude',
          gemini: 'Gemini',
          'chrome-ai': 'Chrome AI',
          custom: 'Custom',
        };
        providerLabel.textContent = providerNames[aiSettings?.providerId] || '';
      } catch {
        providerLabel.textContent = '';
      }
    } else if (providerLabel) {
      providerLabel.textContent = '';
    }
  } catch {
    // AI not available — keep hidden
    document.body.classList.remove('ai-available');
  }
}

updateAIVisibility();

// --- Help button ---
document.getElementById('btn-help').addEventListener('click', () => toggleHelp());

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  // Ctrl+K / Cmd+K: toggle search (works even when focused in inputs)
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    globalSearch.toggle();
    return;
  }

  // Skip when typing in inputs
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') {
      e.target.blur();
      e.preventDefault();
    }
    return;
  }

  // 1-4: switch main tabs
  const tabKeys = { '1': 'windows', '2': 'tabs', '3': 'stash', '4': 'sessions' };
  if (tabKeys[e.key]) {
    e.preventDefault();
    const btn = document.querySelector(`.tab-nav [data-view="${tabKeys[e.key]}"]`);
    if (btn) btn.click();
    return;
  }

  // F: toggle focus view
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    showFocusView();
    return;
  }

  // /: focus AI command bar
  if (e.key === '/') {
    e.preventDefault();
    const aiInput = document.getElementById('ai-command-input');
    if (aiInput && !aiInput.closest('[hidden]')) {
      aiInput.focus();
    }
    return;
  }

  // Escape: close settings or help
  if (e.key === 'Escape') {
    const helpOverlay = document.getElementById('help-overlay');
    if (helpOverlay) { helpOverlay.remove(); return; }
    const settingsView = document.getElementById('view-settings');
    if (settingsView && !settingsView.classList.contains('hidden')) {
      const tabsBtn = document.querySelector('.tab-nav [data-view="tabs"]');
      if (tabsBtn) tabsBtn.click();
    }
    return;
  }

  // ?: show help overlay
  if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleHelp();
    return;
  }
});

// --- Help overlay ---
function toggleHelp() {
  let overlay = document.getElementById('help-overlay');
  if (overlay) {
    overlay.remove();
    return;
  }
  overlay = document.createElement('div');
  overlay.id = 'help-overlay';
  overlay.className = 'help-overlay';
  overlay.innerHTML = `
    <div class="help-panel">
      <div class="help-header">
        <h2>TabKebab Help</h2>
        <button class="help-close" aria-label="Close">&times;</button>
      </div>
      <div class="help-body">
        <div class="help-group">
          <h3>Views</h3>
          <div class="help-feature"><strong>Windows</strong> &mdash; See all open windows, tab counts, health indicators, and consolidate windows.</div>
          <div class="help-feature"><strong>Tabs</strong> &mdash; Group tabs by domain or AI, manage custom groups, find duplicates.</div>
          <div class="help-feature"><strong>Stash</strong> &mdash; Save and close tabs to free memory. Restore them later.</div>
          <div class="help-feature"><strong>Sessions</strong> &mdash; Snapshot all windows and restore entire sessions.</div>
        </div>
        <div class="help-group">
          <h3>Key Features</h3>
          <div class="help-feature"><strong>Kebab</strong> &mdash; Discard inactive tabs to save memory. Keep-awake domains are protected.</div>
          <div class="help-feature"><strong>Smart Group</strong> &mdash; AI groups tabs by topic instead of domain (requires AI setup in Settings).</div>
          <div class="help-feature"><strong>Drive Sync</strong> &mdash; Back up sessions, stashes, and bookmarks to Google Drive.</div>
          <div class="help-feature"><strong>Bookmarks</strong> &mdash; Export tabs as Chrome bookmarks, local JSON, or Drive HTML.</div>
          <div class="help-feature"><strong>Focus Mode</strong> &mdash; Start a timed focus session. Distracting tabs are blocked, non-focus tabs can be kebab'd or stashed.</div>
        </div>
        <div class="help-group">
          <h3>Keyboard Shortcuts</h3>
          <div class="help-row"><kbd>1</kbd><span>Windows view</span></div>
          <div class="help-row"><kbd>2</kbd><span>Tabs view</span></div>
          <div class="help-row"><kbd>3</kbd><span>Stash view</span></div>
          <div class="help-row"><kbd>4</kbd><span>Sessions view</span></div>
          <div class="help-row"><kbd>F</kbd><span>Focus Mode</span></div>
          <div class="help-row"><kbd>Ctrl+K</kbd><span>Search everything</span></div>
          <div class="help-row"><kbd>/</kbd><span>Focus AI command bar</span></div>
          <div class="help-row"><kbd>Esc</kbd><span>Close / unfocus</span></div>
          <div class="help-row"><kbd>?</kbd><span>Toggle this help</span></div>
        </div>
        <div class="help-group">
          <h3>Tips</h3>
          <div class="help-feature">Click any tab to switch to it. Click the &times; to close it.</div>
          <div class="help-feature">Drag tabs between custom groups in the Groups sub-view.</div>
          <div class="help-feature">Use the AI command bar to run natural language actions like &ldquo;close YouTube tabs&rdquo;.</div>
          <div class="help-feature">Stashed tabs are stored in IndexedDB and survive extension updates.</div>
        </div>
        <div class="help-footer">
          <a href="https://github.com/michelabboud/tabkebab-chrome-ext/blob/main/GUIDE.md" target="_blank" rel="noopener">Full Guide</a>
          <span class="about-sep">|</span>
          <a href="https://github.com/michelabboud/tabkebab-chrome-ext/issues" target="_blank" rel="noopener">Report Issue</a>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('.help-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}
