// core/focus.js — Focus engine: state machine, timer, badge, distraction detection, history

import { Storage } from './storage.js';
import { getAllTabs, closeTabs, extractDomain, createNativeGroup, ungroupTabs } from './tabs-api.js';
import { saveStash, restoreStashTabs, getStash } from './stash-db.js';
import { getProfileById, getAllProfiles } from './focus-profiles.js';
import { checkAgainstBlocklists, BLOCKLIST_CATEGORIES } from './focus-blocklists.js';

const FOCUS_STATE_KEY = 'focusState';
const FOCUS_HISTORY_KEY = 'focusHistory';
const MAX_HISTORY = 50;

// Module-level cache for fast sync access
let _cachedState = null;

// Initialize cache from storage
(async () => {
  _cachedState = await Storage.get(FOCUS_STATE_KEY);
})();

// Keep cache in sync with storage changes
Storage.onChange((changes) => {
  if (changes[FOCUS_STATE_KEY]) {
    _cachedState = changes[FOCUS_STATE_KEY].newValue ?? null;
  }
});

export function getCachedFocusState() {
  return _cachedState;
}

export async function getFocusState() {
  const state = await Storage.get(FOCUS_STATE_KEY);
  _cachedState = state;
  return state;
}

async function saveFocusState(state) {
  _cachedState = state;
  if (state) {
    await Storage.set(FOCUS_STATE_KEY, state);
  } else {
    await Storage.remove(FOCUS_STATE_KEY);
  }
}

// ── Timer helpers ──

export function getRemainingMs(state) {
  if (!state || state.status !== 'active') return 0;
  if (state.duration === 0) return Infinity; // open-ended
  const totalMs = state.duration * 60 * 1000;
  const elapsed = Date.now() - state.startedAt - state.pausedElapsed;
  return Math.max(0, totalMs - elapsed);
}

export function getElapsedMs(state) {
  if (!state) return 0;
  if (state.status === 'paused') {
    return state.pausedAt - state.startedAt - state.pausedElapsed;
  }
  return Date.now() - state.startedAt - state.pausedElapsed;
}

export function formatTimeRemaining(ms) {
  if (ms === Infinity) return '--:--';
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBadgeTime(ms) {
  if (ms === Infinity) return '';
  const totalMin = Math.max(0, Math.ceil(ms / 60000));
  if (totalMin >= 60) return `${Math.floor(totalMin / 60)}h`;
  return `${totalMin}m`;
}

// ── Domain matching ──

function domainMatches(tabUrl, domainList) {
  if (!domainList || domainList.length === 0) return false;
  const hostname = extractDomain(tabUrl);
  if (!hostname || hostname === 'other') return false;
  return domainList.some(d => hostname === d || hostname.endsWith('.' + d));
}

/**
 * Check if a URL should be blocked based on current focus state.
 * Blocking modes (in order of priority):
 * 1. Allowed domains always pass (whitelist)
 * 2. Explicit blocked domains always block
 * 3. Strict mode: block everything not in allowed list
 * 4. Curated categories: block if in enabled category
 * 5. AI mode: ask AI to categorize (async, handled separately)
 *
 * @param {string} url - The URL to check
 * @param {Object} state - Focus state object
 * @returns {{ blocked: boolean, reason: string|null, category: string|null }}
 */
export function isBlockedDomain(url, state) {
  const hostname = extractDomain(url);
  if (!hostname || hostname === 'other') {
    return { blocked: false, reason: null, category: null };
  }

  // Chrome internal pages are never blocked
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    return { blocked: false, reason: null, category: null };
  }

  // 1. Allowed domains always pass
  if (domainMatches(url, state?.allowedDomains)) {
    return { blocked: false, reason: null, category: null };
  }

  // 2. Explicit blocked domains always block
  if (domainMatches(url, state?.blockedDomains)) {
    return { blocked: true, reason: 'blocklist', category: 'Blocked Domain' };
  }

  // 3. Strict mode: block everything not in allowed list
  if (state?.strictMode && state?.allowedDomains?.length > 0) {
    return { blocked: true, reason: 'strict', category: 'Not in allowed list' };
  }

  // 4. Curated categories
  if (state?.blockedCategories?.length > 0) {
    const result = checkAgainstBlocklists(hostname, state.blockedCategories);
    if (result.blocked) {
      return { blocked: true, reason: 'category', category: result.category };
    }
  }

  // 5. AI mode handled separately (async) - return not blocked here
  // The service worker will call checkWithAI if aiBlocking is enabled

  return { blocked: false, reason: null, category: null };
}

/**
 * Legacy compatibility wrapper - returns boolean
 */
export function isBlockedDomainSimple(url, state) {
  return isBlockedDomain(url, state).blocked;
}

function isFocusTab(tab, state) {
  // Allowed domains means "focus" tabs
  if (state.allowedDomains.length === 0) return true; // no filter = all are focus
  return domainMatches(tab.url, state.allowedDomains);
}

// ── Badge ──

export async function updateBadge(state) {
  if (!state || !state.status) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (state.status === 'paused') {
    await chrome.action.setBadgeText({ text: '||' });
    await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    return;
  }
  if (state.status === 'active') {
    const remaining = getRemainingMs(state);
    const text = formatBadgeTime(remaining);
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    return;
  }
}

export async function flashBadgeDistraction() {
  await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  await chrome.action.setBadgeText({ text: '!' });
  setTimeout(async () => {
    const state = getCachedFocusState();
    if (state) await updateBadge(state);
  }, 2000);
}

// ── Start focus ──

export async function startFocus({
  profileId,
  duration,
  tabAction,
  allowedDomains,
  blockedDomains,
  strictMode,
  blockedCategories,
  aiBlocking,
}) {
  const profile = getProfileById(profileId);
  const profileName = profile?.name || profileId;

  const state = {
    status: 'active',
    startedAt: Date.now(),
    duration: duration || 0,
    pausedAt: null,
    pausedElapsed: 0,
    profileId,
    profileName,
    tabAction: tabAction || 'none',
    allowedDomains: allowedDomains || [],
    blockedDomains: blockedDomains || [],
    // New blocking modes
    strictMode: strictMode || false,
    blockedCategories: blockedCategories || [],
    aiBlocking: aiBlocking || false,
    stashId: null,
    focusGroupId: null,
    distractionsBlocked: 0,
    focusTabCount: 0,
  };

  const allTabs = await getAllTabs({ allWindows: true });
  const focusTabs = allTabs.filter(t => isFocusTab(t, state) && !t.url.startsWith('chrome://'));
  const nonFocusTabs = allTabs.filter(t => !isFocusTab(t, state) && !t.active && !t.url.startsWith('chrome://'));
  state.focusTabCount = focusTabs.length;

  // Apply tab action
  if (tabAction === 'kebab' && nonFocusTabs.length > 0) {
    for (const tab of nonFocusTabs) {
      if (tab.discarded) continue;
      try { await chrome.tabs.discard(tab.id); } catch { /* tab may be active */ }
    }
  } else if (tabAction === 'stash' && nonFocusTabs.length > 0) {
    const stashTabs = nonFocusTabs.map(t => ({
      url: t.url, title: t.title, favIconUrl: t.favIconUrl, pinned: t.pinned || false,
    }));
    const stashId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const stash = {
      id: stashId,
      name: `[Focus] ${profileName} session`,
      source: 'domain',
      sourceDetail: 'focus-mode',
      createdAt: Date.now(),
      tabCount: stashTabs.length,
      windows: [{ tabCount: stashTabs.length, tabs: stashTabs }],
    };
    await saveStash(stash);
    state.stashId = stashId;
    const closableIds = nonFocusTabs.map(t => t.id);
    if (closableIds.length > 0) await closeTabs(closableIds);
  } else if (tabAction === 'group' && focusTabs.length > 0) {
    const focusTabIds = focusTabs.map(t => t.id);
    const profileColor = profile?.color || 'blue';
    const chromeColor = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'].includes(profileColor)
      ? profileColor : 'blue';
    try {
      const groupId = await createNativeGroup(focusTabIds, profileName, chromeColor);
      state.focusGroupId = groupId;
    } catch { /* some tabs may not be groupable */ }
  }

  // Create alarm
  await chrome.alarms.create('focusTick', { periodInMinutes: 1 });

  // Update badge
  await updateBadge(state);

  // Persist
  await saveFocusState(state);

  return state;
}

// ── End focus ──

export async function endFocus() {
  const state = await getFocusState();
  if (!state) return null;

  // Restore stashed tabs
  if (state.stashId) {
    try {
      const stash = await getStash(state.stashId);
      if (stash) {
        await restoreStashTabs(stash, { mode: 'here' });
      }
    } catch (e) { console.warn('[TabKebab] Focus restore failed:', e); }
  }

  // Ungroup focus tabs
  if (state.focusGroupId) {
    try {
      const groupTabs = await chrome.tabs.query({ groupId: state.focusGroupId });
      if (groupTabs.length > 0) {
        await ungroupTabs(groupTabs.map(t => t.id));
      }
    } catch { /* group may already be gone */ }
  }

  // Clear alarm & badge
  try { await chrome.alarms.clear('focusTick'); } catch {}
  await chrome.action.setBadgeText({ text: '' });

  // Save to history
  const elapsed = getElapsedMs(state);
  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    profileId: state.profileId,
    profileName: state.profileName,
    startedAt: state.startedAt,
    endedAt: Date.now(),
    plannedDuration: state.duration,
    actualDurationMs: elapsed,
    distractionsBlocked: state.distractionsBlocked,
    focusTabCount: state.focusTabCount,
    tabAction: state.tabAction,
  };

  const history = (await Storage.get(FOCUS_HISTORY_KEY)) || [];
  history.unshift(record);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  await Storage.set(FOCUS_HISTORY_KEY, history);

  // Clear state
  await saveFocusState(null);

  return record;
}

// ── Pause / Resume ──

export async function pauseFocus() {
  const state = await getFocusState();
  if (!state || state.status !== 'active') return null;
  state.status = 'paused';
  state.pausedAt = Date.now();
  await updateBadge(state);
  await saveFocusState(state);
  return state;
}

export async function resumeFocus() {
  const state = await getFocusState();
  if (!state || state.status !== 'paused') return null;
  const pauseDuration = Date.now() - state.pausedAt;
  state.pausedElapsed += pauseDuration;
  state.pausedAt = null;
  state.status = 'active';
  await updateBadge(state);
  await saveFocusState(state);
  return state;
}

// ── Extend ──

export async function extendFocus(minutes) {
  const state = await getFocusState();
  if (!state) return null;
  state.duration += minutes;
  await updateBadge(state);
  await saveFocusState(state);
  return state;
}

// ── Distraction handling ──

export async function handleDistraction(tabId, url, _cachedRef, category = null) {
  let windowId;
  try {
    const tab = await chrome.tabs.get(tabId);
    windowId = tab.windowId;
    // If this is a new tab with no history, close it
    // Otherwise, go back
    if (!tab.url || tab.url === url) {
      // Try goBack first
      try {
        await chrome.tabs.goBack(tabId);
      } catch {
        // No history — close the tab
        try { await chrome.tabs.remove(tabId); } catch {}
      }
    } else {
      await chrome.tabs.goBack(tabId);
    }
  } catch {
    // Tab may already be gone
    try { await chrome.tabs.remove(tabId); } catch {}
  }

  // Open side panel to show the distraction notification
  if (windowId) {
    try { await chrome.sidePanel.open({ windowId }); } catch {}
  }

  // Re-read state from storage to avoid stale data
  const state = await getFocusState();
  if (!state) return;

  // Increment distraction counter
  state.distractionsBlocked++;
  await saveFocusState(state);

  // Flash badge
  await flashBadgeDistraction();

  // Notify panel to switch to focus view and blink
  const domain = extractDomain(url);
  chrome.runtime.sendMessage({
    type: 'focusDistraction',
    domain,
    category,
    count: state.distractionsBlocked,
    openFocusView: true,
    blink: true,
  }).catch(() => {});
}

// ── Tick (called by alarm) ──

export async function handleFocusTick() {
  const state = await getFocusState();
  if (!state || state.status !== 'active') return;

  // Check if timer expired
  if (state.duration > 0) {
    const remaining = getRemainingMs(state);
    if (remaining <= 0) {
      // Timer expired — end session
      const record = await endFocus();
      chrome.runtime.sendMessage({
        type: 'focusEnded',
        record,
      }).catch(() => {});
      return;
    }
  }

  // Update badge
  await updateBadge(state);
}

// ── History ──

export async function getFocusHistory() {
  return (await Storage.get(FOCUS_HISTORY_KEY)) || [];
}

// ── Profiles (re-export for service worker convenience) ──

export { getAllProfiles, getProfileById };
