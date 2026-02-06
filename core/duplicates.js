// core/duplicates.js — Duplicate tab detection

import { getAllTabs } from './tabs-api.js';

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.origin + u.pathname + u.search;
  } catch {
    return url;
  }
}

export async function findDuplicates() {
  const tabs = await getAllTabs({ allWindows: true });
  const urlMap = new Map();

  for (const tab of tabs) {
    const normalized = normalizeUrl(tab.url || '');
    if (!normalized || normalized === 'chrome://newtab/') continue;
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
          windowId: t.windowId
        }))
      });
    }
  }

  return duplicates;
}

/**
 * Find empty/blank pages that can be closed.
 * Matches: about:blank, chrome://newtab, empty URLs, new tab pages
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
      url === 'chrome://newtab/' ||
      url === 'chrome://new-tab-page/' ||
      url === 'edge://newtab/' ||
      url.startsWith('chrome://newtab') ||
      url.startsWith('chrome://new-tab-page');

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
