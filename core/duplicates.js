// core/duplicates.js — Duplicate tab detection

import { getAllTabs } from './tabs-api.js';

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    if (u.origin === 'null') return u.href;
    return u.origin + u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

function isChromeNewTabUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'chrome:' &&
      (parsed.hostname === 'newtab' || parsed.hostname === 'new-tab-page');
  } catch {
    return false;
  }
}

export function collectUndoUrls(duplicateGroups, closingTabIds) {
  if (!Array.isArray(duplicateGroups) || !Array.isArray(closingTabIds)) return [];

  const selectedIds = new Set(closingTabIds);
  const urls = [];
  for (const group of duplicateGroups) {
    if (!Array.isArray(group?.tabs)) continue;
    for (const tab of group.tabs) {
      if (selectedIds.has(tab?.id) && typeof tab?.url === 'string') {
        urls.push(tab.url);
      }
    }
  }
  return urls;
}

export async function findDuplicates() {
  const tabs = await getAllTabs({ allWindows: true });
  const urlMap = new Map();

  for (const tab of tabs) {
    const originalUrl = tab.url || '';
    if (isChromeNewTabUrl(originalUrl)) continue;
    const normalized = normalizeUrl(originalUrl);
    if (!normalized) continue;
    if (!urlMap.has(normalized)) urlMap.set(normalized, []);
    urlMap.get(normalized).push(tab);
  }

  const duplicates = [];
  for (const [url, tabGroup] of urlMap) {
    if (tabGroup.length > 1) {
      duplicates.push({
        url,
        tabs: tabGroup.map(t => ({
          id: t.id,
          title: t.title,
          favIconUrl: t.favIconUrl,
          active: t.active,
          windowId: t.windowId,
          url: t.url,
        }))
      });
    }
  }

  return duplicates;
}

/**
 * Find empty/blank pages that can be closed.
 * Matches blank/empty pages while preserving Chrome's own new-tab pages.
 */
export async function findEmptyPages() {
  const tabs = await getAllTabs({ allWindows: true });
  const emptyPages = [];

  for (const tab of tabs) {
    const url = tab.url || '';
    const isEmpty =
      !url ||
      url === '' ||
      url === 'about:blank' ||
      url === 'edge://newtab/';

    if (isEmpty && !tab.active) {
      emptyPages.push({
        id: tab.id,
        title: tab.title || 'Empty Page',
        url,
        windowId: tab.windowId,
      });
    }
  }

  return emptyPages;
}
