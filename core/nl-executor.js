// core/nl-executor.js — Natural language command filter + execution logic

import { closeTabs, focusTab, createNativeGroup } from './tabs-api.js';
import { canonicalHostname, hostnameMatches } from './url-match.js';

const FILTER_KEYS = Object.freeze(['domain', 'titleContains', 'urlContains']);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function isValidTabFilter(filter) {
  if (!isPlainRecord(filter)) return false;

  let recognized = 0;
  for (const key of FILTER_KEYS) {
    if (!hasOwn(filter, key)) continue;
    recognized++;

    const value = filter[key];
    if (key === 'domain') {
      if (!canonicalHostname(value)) return false;
    } else if (typeof value !== 'string' || value.trim().length === 0) {
      return false;
    }
  }

  return recognized > 0;
}

/**
 * Filter tabs based on an AI-parsed filter object.
 * @param {Array} tabs - All tabs
 * @param {Object} filter - { domain?, titleContains?, urlContains? }
 * @returns {Array} Matching tabs
 */
export function filterTabs(tabs, filter) {
  if (!Array.isArray(tabs) || !isValidTabFilter(filter)) return [];

  const hasDomain = hasOwn(filter, 'domain');
  const hasTitle = hasOwn(filter, 'titleContains');
  const hasUrl = hasOwn(filter, 'urlContains');
  const titleNeedle = hasTitle ? filter.titleContains.toLowerCase() : '';
  const urlNeedle = hasUrl ? filter.urlContains.toLowerCase() : '';

  return tabs.filter(t => {
    try {
      const rawUrl = t?.url || t?.pendingUrl || '';
      const url = typeof rawUrl === 'string' ? rawUrl.toLowerCase() : '';
      const title = typeof t?.title === 'string' ? t.title.toLowerCase() : '';

      if (hasDomain && !hostnameMatches(rawUrl, filter.domain)) return false;
      if (hasTitle && !title.includes(titleNeedle)) return false;
      if (hasUrl && !url.includes(urlNeedle)) return false;
      return true;
    } catch (error) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  });
}

/**
 * Execute a parsed NL command on matching tabs.
 * @param {Object} parsed - { action, filter, groupName?, color?, tabIds? }
 * @param {Array} tabs - The matching tabs
 * @returns {Promise<Object>} Result with { executed, message } or { error }
 */
export async function executeNLAction(parsed, tabs) {
  const tabIds = Array.isArray(tabs)
    ? tabs.map((tab) => tab?.id).filter((tabId) => Number.isInteger(tabId))
    : [];

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
