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
import { showToast } from './components/toast.js';
import { routePanelFocusMessage } from './focus-events.js';
import { sendOrThrow } from './message-client.js';
import { startChromeAIBroker } from './chrome-ai-broker.js';
import { FirstRunWalkthrough } from './components/first-run-walkthrough.js';
import { createFocusTrap, isConfirmOpen, isModalOpen } from './components/confirm-dialog.js';
import {
  VIEW_SHORTCUTS,
  applyStatusIcon,
  countDuplicateTabs,
  createDebounced,
  createDeferrableRefresh,
  formatStatsStrip,
  isEditingElement,
  isPlainShortcutAllowed,
  resolveStatusIconState,
  resolveTabsChangedRefreshKey,
  scrollIntoContainer,
  selectTab,
  setupRovingTablist,
  shouldShowStatsStrip,
} from './panel-helpers.js';

// Chrome's Prompt API is document-only. Keep one named broker alive for this
// panel document and permanently stop reconnecting when the document exits.
const chromeAIBroker = startChromeAIBroker();
window.addEventListener('pagehide', () => chromeAIBroker.disconnect(), { once: true });

async function refreshController(controller, label) {
  try {
    await controller?.refresh?.();
  } catch (err) {
    showToast(`Failed to refresh ${label}: ${err.message}`, 'error');
  }
}

// --- Initialize view controllers ---

const settingsRoot = document.getElementById('view-settings');
const driveSyncCtrl = new DriveSync(settingsRoot);
const aiSettingsCtrl = new AISettings(settingsRoot, {
  async onAvailabilityChanged() {
    await Promise.all([
      updateAIVisibility(),
      updateAIStatusIcon(),
    ]);
  },
});
const settingsManagerCtrl = new SettingsManager(settingsRoot);

const controllers = {
  tabs: new TabList(document.getElementById('sub-domains'), {
    navigate: navigatePanel,
  }),
  sessions: new SessionManager(document.getElementById('view-sessions'), {
    navigate: navigatePanel,
  }),
  duplicates: new DuplicateFinder(document.getElementById('sub-duplicates')),
  groups: new GroupEditor(document.getElementById('sub-groups')),
  windows: new WindowList(document.getElementById('view-windows')),
  stash: new StashList(document.getElementById('view-stash'), {
    navigate: navigatePanel,
  }),
  settings: {
    async refresh() {
      await Promise.all([
        driveSyncCtrl.refresh(),
        aiSettingsCtrl.refresh(),
        settingsManagerCtrl.refresh(),
      ]);
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

// --- Primary navigation (Tabs / Windows / Stash / Sessions) ---
// ARIA tab pattern: .tab-nav is the tablist, each primary view is the
// tabpanel of its tab, arrow keys move between tabs (roving tabindex).
// Settings and Focus open from header buttons; while one is open no nav tab
// is selected and the header button shows the selected state instead.
const navButtons = document.querySelectorAll('.tab-nav [role="tab"]');
const views = document.querySelectorAll('.view');
const settingsBtn = document.getElementById('btn-settings');
const focusBtn = document.getElementById('btn-focus');
const statsBar = document.getElementById('global-stats-bar');

navButtons.forEach(btn => {
  const panel = document.getElementById(btn.getAttribute('aria-controls') || `view-${btn.dataset.view}`);
  if (!panel) return;
  panel.setAttribute('role', 'tabpanel');
  if (btn.id) panel.setAttribute('aria-labelledby', btn.id);
});
for (const [id, label] of [['view-settings', 'Settings'], ['view-focus', 'Focus Mode']]) {
  const region = document.getElementById(id);
  if (region) {
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', label);
  }
}

function setHeaderViewButton(btn, selected) {
  if (!btn) return;
  btn.classList.toggle('active', selected);
  if (selected) btn.setAttribute('aria-current', 'page');
  else btn.removeAttribute('aria-current');
}

/** Show one view (primary, settings or focus) and sync every selected state. */
function showView(target) {
  const navBtn = [...navButtons].find(b => b.dataset.view === target) || null;
  selectTab(navButtons, navBtn);
  setHeaderViewButton(settingsBtn, target === 'settings');
  setHeaderViewButton(focusBtn, target === 'focus');
  views.forEach(v => v.classList.toggle('hidden', v.id !== `view-${target}`));
  if (statsBar) statsBar.hidden = !shouldShowStatsStrip(target);
}

function visibleViewName() {
  return [...views].find(v => !v.classList.contains('hidden'))?.id?.replace(/^view-/, '') || 'tabs';
}

function navigatePanel({ view, sectionId } = {}) {
  if (view === 'settings') {
    settingsBtn.click();
  } else if (view === 'focus') {
    showFocusView();
  } else {
    document.querySelector(`.tab-nav [data-view="${view}"]`)?.click();
  }

  if (sectionId) {
    requestAnimationFrame(() => {
      // Scroll the view container only, never the document root (which
      // used to clip the header permanently).
      scrollIntoContainer(document.getElementById(sectionId), { align: 'start' });
    });
  }
}

navButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.view;
    showView(target);

    // Refresh the activated controller
    if (target === 'tabs') {
      // Refresh the active sub-tab's controller
      const activeSub = document.querySelector('#view-tabs .sub-nav [role="tab"].active');
      const subKey = subControllers[activeSub?.dataset.subtab || 'domains'];
      void refreshController(controllers[subKey], 'tabs');
    } else {
      void refreshController(controllers[target], target);
    }
  });
});
setupRovingTablist(navButtons);

// --- Settings gear icon ---
settingsBtn.addEventListener('click', () => {
  showView('settings');
  void refreshController(controllers.settings, 'settings');
});

// In-page fragment links (e.g. href="#settings-ai-section") would scroll the
// document root; route them through the panel navigation instead.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented) return;
  const link = e.target?.closest?.('a[href^="#"]');
  const id = link?.getAttribute('href')?.slice(1);
  if (!id) return;
  const target = document.getElementById(id);
  if (!target) return;
  e.preventDefault();
  const view = target.closest('.view')?.id?.replace(/^view-/, '');
  if (view && view !== visibleViewName()) navigatePanel({ view, sectionId: id });
  else scrollIntoContainer(target, { align: 'start' });
});

// --- First-run walkthrough ---
const walkthroughRoot = document.getElementById('first-run-walkthrough');
const walkthrough = new FirstRunWalkthrough(walkthroughRoot, {
  navigate: navigatePanel,
});
document.getElementById('btn-relaunch-walkthrough').addEventListener('click', () => {
  walkthrough.launch();
  scrollIntoContainer(walkthroughRoot, { align: 'start' });
});
void walkthrough.startIfNeeded();

// --- Focus panel ---
const focusPanel = new FocusPanel(document.getElementById('view-focus'), {
  // The global listener below routes the event once so component and shell
  // effects share one run-identity decision.
  listenForRuntimeEvents: false,
});

function showFocusView() {
  showView('focus');
  void refreshController(focusPanel, 'Focus Mode');
}

focusBtn.addEventListener('click', showFocusView);

// Update focus button pulse state on load and focus events
async function updateFocusBtnState() {
  try {
    const state = await sendOrThrow({ action: 'getFocusState' });
    const isRuntimeState = state?.status === 'active' || state?.status === 'paused';
    focusPanel.state = isRuntimeState ? state : null;
    focusBtn.classList.toggle('focus-active', isRuntimeState);
    return focusPanel.state;
  } catch {}
}
updateFocusBtnState();

// --- Sub-navigation (Domains / Groups / Duplicates inside Tabs view) ---
const subNavButtons = document.querySelectorAll('#view-tabs .sub-nav [role="tab"]');
const subViews = document.querySelectorAll('#view-tabs .sub-view');

subNavButtons.forEach(btn => {
  const panelId = `sub-${btn.dataset.subtab}`;
  if (!btn.id) btn.id = `subnav-tab-${btn.dataset.subtab}`;
  btn.setAttribute('aria-controls', panelId);
  const panel = document.getElementById(panelId);
  if (panel) {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', btn.id);
  }
});
selectTab(subNavButtons, [...subNavButtons].find(b => b.classList.contains('active')) || subNavButtons[0]);
setupRovingTablist(subNavButtons);

subNavButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.subtab;

    selectTab(subNavButtons, btn);

    // Show the target sub-view, hide others
    subViews.forEach(v => v.classList.toggle('hidden', v.id !== `sub-${target}`));

    // Refresh the activated sub-controller
    const key = subControllers[target];
    void refreshController(controllers[key], target);
  });
});

// --- Global stats bar ---
async function refreshGlobalStats() {
  try {
    const data = await sendOrThrow({ action: 'getWindowStats' });
    if (!data || !statsBar) return;
    statsBar.textContent = formatStatsStrip(data);
  } catch {
    // Stats not available yet
  }
}

// --- Duplicate badge ---
// The badge counts duplicate tabs only (the extra copies), matching the
// "Close All Duplicates (N)" button. Blank pages are not included.
function updateDupeBadge(count) {
  const badge = document.getElementById('dupe-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.title = `${count} duplicate tab${count === 1 ? '' : 's'}`;
    badge.setAttribute('aria-label', badge.title);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

document.addEventListener('dupesUpdated', (e) => {
  // Prefer an explicit duplicates-only count; otherwise re-query so blank
  // pages included in a combined `count` never inflate the badge.
  const duplicateCount = e.detail?.duplicateCount;
  if (Number.isFinite(duplicateCount)) updateDupeBadge(duplicateCount);
  else void checkDuplicates();
});

// --- Periodic duplicate check (every 60s) ---
async function checkDuplicates() {
  try {
    const dupes = await sendOrThrow({ action: 'findDuplicates' });
    updateDupeBadge(countDuplicateTabs(dupes));
  } catch {
    // Ignore — service worker may not be ready
  }
}

checkDuplicates();
setInterval(checkDuplicates, 60000);

// --- Listen for tab changes from service worker ---
// tabsChanged arrives in bursts (one per tab event). Coalesce them and
// refresh whichever live-tab view is visible so its rendered tab ids stay
// current (stale ids would otherwise be acted on by close/ungroup buttons).
function refreshVisibleTabViews() {
  const visibleView = [...views].find(v => !v.classList.contains('hidden'))?.id?.replace(/^view-/, '');
  const activeSubtab = document.querySelector('#view-tabs .sub-nav [role="tab"].active')?.dataset.subtab;
  const key = resolveTabsChangedRefreshKey({ visibleView, activeSubtab });
  if (key) void refreshController(controllers[key], key);
  void refreshGlobalStats();
}
// Re-rendering a view wipes in-progress input (manual group name/URL, search
// boxes) and cancels drags, so automatic refreshes wait until the user is done.
let tabDragActive = false;
function isVisibleViewBusy() {
  if (tabDragActive) return true;
  const visibleViewEl = [...views].find(v => !v.classList.contains('hidden'));
  const active = document.activeElement;
  return Boolean(visibleViewEl && active && visibleViewEl.contains(active) && isEditingElement(active));
}
const deferrableTabsChangedRefresh = createDeferrableRefresh(refreshVisibleTabViews, {
  isBusy: isVisibleViewBusy,
});
const scheduleTabsChangedRefresh = createDebounced(deferrableTabsChangedRefresh, 150);
document.addEventListener('dragstart', () => { tabDragActive = true; }, true);
document.addEventListener('dragend', () => {
  tabDragActive = false;
  deferrableTabsChangedRefresh.resume();
}, true);
// focusout fires before focus moves on; check once the new activeElement is set.
document.addEventListener('focusout', () => {
  setTimeout(() => deferrableTabsChangedRefresh.resume(), 0);
}, true);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'tabsChanged') {
    scheduleTabsChangedRefresh();
  }
  void routePanelFocusMessage(message, focusPanel, {
    loadFocusState: () => sendOrThrow({ action: 'getFocusState' }),
    updateFocusBtnState,
    showFocusView,
    blink() {
      document.body.classList.add('focus-blink');
      setTimeout(() => document.body.classList.remove('focus-blink'), 1500);
    },
  }).catch(() => {});
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
    const settings = await sendOrThrow({ action: 'getSettings' });
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
void refreshController(controllers.tabs, 'tabs');
void refreshGlobalStats();

// --- Set version from manifest ---
const manifest = chrome.runtime.getManifest();
document.querySelectorAll('.app-version').forEach(el => {
  el.textContent = `v${manifest.version}`;
});

// --- Toggle AI-dependent UI elements ---
let aiVisibilityGeneration = 0;

async function updateAIVisibility() {
  const visibilityGeneration = ++aiVisibilityGeneration;
  try {
    const aiSettings = await sendOrThrow({ action: 'getAISettings' });
    const result = await sendOrThrow({ action: 'isAIAvailable' });
    const available = result?.available || false;
    let providerName = '';

    if (available) {
      const providerNames = {
        openai: 'OpenAI',
        claude: 'Claude',
        gemini: 'Gemini',
        'chrome-ai': 'Chrome AI',
        custom: 'Custom',
      };
      providerName = providerNames[aiSettings?.providerId] || '';
    }
    if (visibilityGeneration !== aiVisibilityGeneration) return false;

    // Toggle body class so CSS can show/hide .ai-feature elements
    document.body.classList.toggle('ai-available', available);

    // Show/hide command bar
    const commandBarEl = document.getElementById('command-bar');
    if (commandBarEl) commandBarEl.hidden = !available;

    // Smart Group is always reachable. It uses the configured provider when
    // usable and otherwise tries Chrome's brokered on-device AI without setup.
    const smartGroupBtn = document.getElementById('btn-smart-group');
    if (smartGroupBtn) smartGroupBtn.hidden = false;
    const selectedConfig = aiSettings?.providerConfigs?.[aiSettings?.providerId];
    const usesConfiguredProvider = aiSettings?.enabled === true && (
      aiSettings.providerId === 'custom' ||
      (
        aiSettings.providerId !== 'chrome-ai' &&
        selectedConfig?.hasApiKey === true
      )
    );
    const zeroConfigNote = document.getElementById('smart-group-zero-config-note');
    if (zeroConfigNote) zeroConfigNote.hidden = usesConfiguredProvider;

    // Show/hide AI Suggest keep-awake button
    const suggestKeepAwakeBtn = document.getElementById('btn-suggest-keep-awake');
    if (suggestKeepAwakeBtn) suggestKeepAwakeBtn.hidden = !available;

    // Update AI provider label
    const providerLabel = document.getElementById('ai-provider-label');
    if (providerLabel) providerLabel.textContent = providerName;
    return available;
  } catch {
    if (visibilityGeneration !== aiVisibilityGeneration) return false;
    // AI not available — keep hidden
    document.body.classList.remove('ai-available');
    for (const id of ['command-bar', 'btn-suggest-keep-awake']) {
      const element = document.getElementById(id);
      if (element) element.hidden = true;
    }
    const smartGroupBtn = document.getElementById('btn-smart-group');
    if (smartGroupBtn) smartGroupBtn.hidden = false;
    const zeroConfigNote = document.getElementById('smart-group-zero-config-note');
    if (zeroConfigNote) zeroConfigNote.hidden = false;
    const providerLabel = document.getElementById('ai-provider-label');
    if (providerLabel) providerLabel.textContent = '';
    return false;
  }
}

updateAIVisibility();

// --- Status icons (Drive & AI) ---
const driveStatusBtn = document.getElementById('btn-drive-status');
const aiStatusBtn = document.getElementById('btn-ai-status');
let aiStatusGeneration = 0;

const AI_PROVIDER_NAMES = {
  openai: 'OpenAI',
  claude: 'Claude',
  gemini: 'Gemini',
  'chrome-ai': 'Chrome AI',
  custom: 'Custom',
};

// Drive and AI are opt-in: "not set up" is neutral grey, red only means a
// configured feature is failing.
async function updateDriveStatusIcon() {
  try {
    const result = await chrome.storage.local.get('driveSync');
    const drive = result?.driveSync || {};
    const configured = drive.connected === true;
    const failing = Boolean(drive.authError || drive.needsReauth || drive.lastError);
    applyStatusIcon(driveStatusBtn, 'drive', resolveStatusIconState({ configured, healthy: !failing }));
  } catch {
    applyStatusIcon(driveStatusBtn, 'drive', 'off');
  }
}

async function updateAIStatusIcon() {
  const statusGeneration = ++aiStatusGeneration;
  try {
    const [aiSettings, result] = await Promise.all([
      sendOrThrow({ action: 'getAISettings' }),
      sendOrThrow({ action: 'isAIAvailable' }),
    ]);
    if (statusGeneration !== aiStatusGeneration) return false;
    const available = result?.available || false;
    const providerId = aiSettings?.providerId;
    const providerConfig = aiSettings?.providerConfigs?.[providerId];
    const configured = aiSettings?.enabled === true && Boolean(providerId) && (
      providerId === 'chrome-ai' ||
      providerId === 'custom' ||
      providerConfig?.hasApiKey === true
    );
    const state = resolveStatusIconState({ configured: configured || available, healthy: available });
    applyStatusIcon(aiStatusBtn, 'ai', state, { provider: AI_PROVIDER_NAMES[providerId] || '' });
    return available;
  } catch {
    if (statusGeneration !== aiStatusGeneration) return false;
    applyStatusIcon(aiStatusBtn, 'ai', 'off');
    return false;
  }
}

function scrollToSettingsSection(sectionId) {
  // Switch to settings view
  settingsBtn.click();
  // Scroll the settings container (not the document) after layout settles
  setTimeout(() => {
    const section = document.getElementById(sectionId);
    if (section) {
      scrollIntoContainer(section, { align: 'start' });
      section.classList.add('highlight-section');
      setTimeout(() => section.classList.remove('highlight-section'), 2000);
    }
  }, 100);
}

driveStatusBtn.addEventListener('click', () => {
  scrollToSettingsSection('settings-drive-section');
});

aiStatusBtn.addEventListener('click', () => {
  scrollToSettingsSection('settings-ai-section');
});

updateDriveStatusIcon();
updateAIStatusIcon();

// Update status icons when storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.driveSync) updateDriveStatusIcon();
    if (changes.aiSettings) updateAIStatusIcon();
  }
});

// --- Help button ---
document.getElementById('btn-help').addEventListener('click', () => toggleHelp());

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  // A modal confirmation dialog owns the keyboard while it is open.
  if (isConfirmOpen()) return;
  // So does the help dialog (its focus trap handles Escape and '?').
  if (isModalOpen()) return;

  // Ctrl+K / Cmd+K: toggle search (works even when focused in inputs)
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'k') {
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

  // Single-key shortcuts never fire with Ctrl/Meta/Alt (e.g. Ctrl/Cmd+F
  // must stay the browser's find) or when another handler claimed the key.
  if (!isPlainShortcutAllowed(e, { dialogOpen: isConfirmOpen() })) return;

  // 1-4: switch main tabs in nav order (1 Tabs, 2 Windows, 3 Stash, 4 Sessions)
  const tabKeys = { ...VIEW_SHORTCUTS };
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

  // /: focus AI command bar, or open search when AI is not set up
  if (e.key === '/') {
    e.preventDefault();
    const aiInput = document.getElementById('ai-command-input');
    if (aiInput && !aiInput.closest('[hidden]')) {
      aiInput.focus();
    } else {
      globalSearch.open();
    }
    return;
  }

  // Escape: close Settings or Focus setup, back to Tabs
  if (e.key === 'Escape') {
    const current = visibleViewName();
    if (current === 'settings' || current === 'focus') {
      const tabsBtn = document.querySelector('.tab-nav [data-view="tabs"]');
      if (tabsBtn) tabsBtn.click();
    }
    return;
  }

  // ?: show help overlay
  if (e.key === '?') {
    e.preventDefault();
    toggleHelp();
    return;
  }
});

// --- Help dialog ---
// A modal dialog built on the confirm-dialog focus-trap pattern:
// role="dialog" + aria-modal, focus starts on Close, Tab is trapped,
// Escape / '?' / backdrop click close it, and focus returns to the opener.
const VIEW_LABELS = { tabs: 'Tabs', windows: 'Windows', stash: 'Stash', sessions: 'Sessions' };
let helpDialog = null; // { overlay, trap }

function closeHelp() {
  if (!helpDialog) return;
  const { overlay, trap } = helpDialog;
  helpDialog = null;
  overlay.remove();
  trap.release();
}

function toggleHelp() {
  if (helpDialog) {
    closeHelp();
    return;
  }
  const overlay = document.createElement('div');
  overlay.id = 'help-overlay';
  overlay.className = 'help-overlay';

  const panel = document.createElement('div');
  panel.className = 'help-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'help-dialog-title');

  const header = document.createElement('div');
  header.className = 'help-header';
  const title = document.createElement('h2');
  title.id = 'help-dialog-title';
  title.textContent = 'TabKebab Help';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'help-close';
  closeBtn.setAttribute('aria-label', 'Close help');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const shortcutRows = Object.entries(VIEW_SHORTCUTS)
    .map(([key, view]) => `<div class="help-row"><kbd>${key}</kbd><span>${VIEW_LABELS[view]} view</span></div>`)
    .join('');

  const body = document.createElement('div');
  body.className = 'help-body';
  body.innerHTML = `
        <div class="help-group">
          <h3>Views</h3>
          <div class="help-feature"><strong>Tabs</strong> &mdash; Group tabs by domain or AI, manage custom groups, find duplicates.</div>
          <div class="help-feature"><strong>Windows</strong> &mdash; See all open windows, tab counts, health indicators, and consolidate windows.</div>
          <div class="help-feature"><strong>Stash</strong> &mdash; Save and close tabs to free memory. Restore them later.</div>
          <div class="help-feature"><strong>Sessions</strong> &mdash; Snapshot all windows and restore entire sessions.</div>
        </div>
        <div class="help-group">
          <h3>Key Features</h3>
          <div class="help-feature"><strong>Kebab</strong> &mdash; Put inactive tabs to sleep to save memory. Keep-awake domains are protected.</div>
          <div class="help-feature"><strong>Smart Group</strong> &mdash; AI groups tabs by topic instead of domain. Chrome's built-in AI works without a key when available.</div>
          <div class="help-feature"><strong>Drive Sync</strong> &mdash; Back up sessions, stashes, and bookmarks to Google Drive.</div>
          <div class="help-feature"><strong>Bookmarks</strong> &mdash; Export tabs as Chrome bookmarks, local JSON, or Drive HTML.</div>
          <div class="help-feature"><strong>Focus Mode</strong> &mdash; Start a timed focus session. Distracting tabs are blocked, non-focus tabs can be kebab'd or stashed.</div>
        </div>
        <div class="help-group">
          <h3>Keyboard Shortcuts</h3>
          ${shortcutRows}
          <div class="help-row"><kbd>&larr; &rarr;</kbd><span>Move between views in the view bar</span></div>
          <div class="help-row"><kbd>F</kbd><span>Focus Mode</span></div>
          <div class="help-row"><kbd>Ctrl+K</kbd><span>Search everything</span></div>
          <div class="help-row"><kbd>/</kbd><span>AI command bar (or search)</span></div>
          <div class="help-row"><kbd>Esc</kbd><span>Close / back to Tabs</span></div>
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
  `;

  panel.append(header, body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  closeBtn.addEventListener('click', closeHelp);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeHelp();
  });
  const trap = createFocusTrap(panel, {
    onClose: closeHelp,
    initialFocus: closeBtn,
    closeKeys: ['?'],
  });
  helpDialog = { overlay, trap };
}
