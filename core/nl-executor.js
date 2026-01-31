// core/nl-executor.js — Natural language command filter + execution logic

import { closeTabs, focusTab, createNativeGroup } from './tabs-api.js';

/**
 * Filter tabs based on an AI-parsed filter object.
 * @param {Array} tabs - All tabs
 * @param {Object} filter - { domain?, titleContains?, urlContains? }
 * @returns {Array} Matching tabs
 */
export function filterTabs(tabs, filter) {
  if (!filter || Object.keys(filter).length === 0) return [];

  return tabs.filter(t => {
    const url = (t.url || t.pendingUrl || '').toLowerCase();
    const title = (t.title || '').toLowerCase();
    let domain = '';
    try {
      domain = new URL(url).hostname.toLowerCase();
    } catch { /* ignore */ }

    if (filter.domain) {
      const fd = filter.domain.toLowerCase();
      if (!domain.includes(fd)) return false;
    }

    if (filter.titleContains) {
      if (!title.includes(filter.titleContains.toLowerCase())) return false;
    }

    if (filter.urlContains) {
      if (!url.includes(filter.urlContains.toLowerCase())) return false;
    }

    return true;
  });
}

/**
 * Execute a parsed NL command on matching tabs.
 * @param {Object} parsed - { action, filter, groupName?, color?, tabIds? }
 * @param {Array} tabs - The matching tabs
 * @returns {Promise<Object>} Result with { executed, message } or { error }
 */
export async function executeNLAction(parsed, tabs) {
  const tabIds = parsed.tabIds || tabs.map(t => t.id);

  switch (parsed.action) {
    case 'close':
      await closeTabs(tabIds);
      return { executed: true, message: `Closed ${tabIds.length} tab(s)` };

    case 'group': {
      const title = parsed.groupName || 'AI Group';
      const color = parsed.color || 'blue';
      if (tabIds.length < 1) return { error: 'No tabs to group' };
      await createNativeGroup(tabIds, title, color);
      return { executed: true, message: `Grouped ${tabIds.length} tab(s) as "${title}"` };
    }

    case 'focus':
      if (tabIds.length > 0) {
        await focusTab(tabIds[0]);
        return { executed: true, message: 'Focused on tab' };
      }
      return { error: 'No matching tab found' };

    case 'move': {
      if (tabIds.length === 0) return { error: 'No tabs to move' };
      const newWindow = await chrome.windows.create({ tabId: tabIds[0] });
      if (tabIds.length > 1) {
        await chrome.tabs.move(tabIds.slice(1), { windowId: newWindow.id, index: -1 });
      }
      return { executed: true, message: `Moved ${tabIds.length} tab(s) to new window` };
    }

    case 'find':
      return {
        executed: true,
        action: 'find',
        message: `Found ${tabIds.length} matching tab(s)`,
        matchedTabs: tabs.map(t => ({
          id: t.id,
          title: t.title,
          url: t.url,
          favIconUrl: t.favIconUrl,
        })),
      };

    default:
      return { error: `Unknown action: ${parsed.action}` };
  }
}
