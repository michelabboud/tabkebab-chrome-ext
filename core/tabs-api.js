// core/tabs-api.js — Wrapper around chrome.tabs and chrome.tabGroups

export function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'other';
  }
}

async function queryTabs({ windowId, allWindows }) {
  if (windowId) return chrome.tabs.query({ windowId });
  if (allWindows) return chrome.tabs.query({});
  return chrome.tabs.query({ currentWindow: true });
}

/**
 * Query tabs. Persistence paths (sessions, stash, bookmarks, Drive export)
 * pass `excludeIncognito: true` so private-browsing tabs are never written to
 * disk or uploaded.
 */
export async function getAllTabs({ windowId, allWindows = false, excludeIncognito = false } = {}) {
  const tabs = await queryTabs({ windowId, allWindows });
  return excludeIncognito ? excludeIncognitoTabs(tabs) : tabs;
}

export function excludeIncognitoTabs(tabs) {
  return Array.isArray(tabs) ? tabs.filter((tab) => tab?.incognito !== true) : [];
}

export async function getAllWindows() {
  return chrome.windows.getAll({ windowTypes: ['normal'] });
}

export async function focusTab(tabId) {
  // First switch to the correct window, then activate the tab.
  // This prevents Chrome from briefly showing the wrong window.
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
}

function isMissingTabError(error) {
  return typeof error?.message === 'string' && error.message.includes('No tab with id');
}

function missingTabId(error) {
  const match = /No tab with id:?\s*(-?\d+)/.exec(error?.message || '');
  return match ? Number(match[1]) : null;
}

/**
 * Close tabs and return how many were actually closed.
 *
 * `chrome.tabs.remove(array)` closes ids in order and stops at the first
 * stale id, so a single stale id must not silently leave the rest open. On a
 * "No tab with id" failure, ids before the stale one are counted as closed and
 * every id after it is retried individually; only missing tabs are ignored.
 */
export async function closeTabs(tabIds) {
  const ids = (Array.isArray(tabIds) ? tabIds : [tabIds])
    .filter((id) => id !== undefined && id !== null);
  if (ids.length === 0) return 0;
  try {
    await chrome.tabs.remove(ids);
    return ids.length;
  } catch (e) {
    if (!isMissingTabError(e)) throw e;
    const staleIndex = ids.indexOf(missingTabId(e));
    let closed = staleIndex > 0 ? staleIndex : 0;
    const remaining = staleIndex >= 0 ? ids.slice(staleIndex + 1) : ids;
    for (const id of remaining) {
      try {
        await chrome.tabs.remove(id);
        closed++;
      } catch (err) {
        if (!isMissingTabError(err)) throw err;
      }
    }
    return closed;
  }
}

export async function createNativeGroup(tabIds, title, color = 'blue') {
  // Determine the target window from the first tab so Chrome doesn't guess
  const firstTab = await chrome.tabs.get(tabIds[0]);
  const groupId = await chrome.tabs.group({
    createProperties: { windowId: firstTab.windowId },
    tabIds,
  });
  await chrome.tabGroups.update(groupId, { title, color });
  return groupId;
}

export async function ungroupTabs(tabIds) {
  return chrome.tabs.ungroup(tabIds);
}
