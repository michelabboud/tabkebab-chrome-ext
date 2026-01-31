// core/tabs-api.js — Wrapper around chrome.tabs and chrome.tabGroups

export function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'other';
  }
}

export async function getAllTabs({ windowId, allWindows = false } = {}) {
  if (windowId) return chrome.tabs.query({ windowId });
  if (allWindows) return chrome.tabs.query({});
  return chrome.tabs.query({ currentWindow: true });
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

export async function closeTabs(tabIds) {
  return chrome.tabs.remove(tabIds);
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
