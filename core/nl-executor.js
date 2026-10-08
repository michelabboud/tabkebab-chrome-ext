// core/nl-executor.js — Natural language command filter + execution logic

import { closeTabs, focusTab, createNativeGroup } from './tabs-api.js';
import { canonicalHostname, hostnameMatches } from './url-match.js';

const FILTER_KEYS = Object.freeze(['domain', 'titleContains', 'urlContains']);

// Chrome's tabGroups.Color enum. Anything else makes tabGroups.update throw.
export const NL_GROUP_COLORS = Object.freeze([
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
]);
const NL_GROUP_COLOR_SET = new Set(NL_GROUP_COLORS);
const DEFAULT_GROUP_COLOR = 'blue';
const DEFAULT_GROUP_NAME = 'AI Group';
export const MAX_GROUP_NAME_LENGTH = 50;

// Actions that change tabs/windows. Non-destructive group/move still require an
// explicit confirmation when they reach across windows or touch many tabs.
export const NL_MUTATING_ACTIONS = Object.freeze(['close', 'group', 'move']);
export const NL_CONFIRM_TAB_THRESHOLD = 20;

// Substring needles that match nearly every URL and therefore express no intent.
const TRIVIAL_URL_NEEDLES = new Set([
  'http', 'https', 'http:', 'https:', 'http://', 'https://', '://', 'www', 'www.',
  '.com', 'com', '.org', 'org', '.net', 'net', '.io', 'html', '.html',
]);
const MIN_URL_NEEDLE_LENGTH = 3;
const MIN_TITLE_NEEDLE_LENGTH = 2;

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
 * Coerce an AI-provided group color to Chrome's tabGroups.Color enum.
 */
export function sanitizeGroupColor(color) {
  if (typeof color !== 'string') return DEFAULT_GROUP_COLOR;
  const normalized = color.trim().toLowerCase();
  if (normalized === 'gray') return 'grey';
  return NL_GROUP_COLOR_SET.has(normalized) ? normalized : DEFAULT_GROUP_COLOR;
}

/**
 * Coerce an AI-provided group name to a short single-line string.
 */
export function sanitizeGroupName(name) {
  if (typeof name !== 'string') return DEFAULT_GROUP_NAME;
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return DEFAULT_GROUP_NAME;
  const chars = [...cleaned];
  return chars.length > MAX_GROUP_NAME_LENGTH
    ? chars.slice(0, MAX_GROUP_NAME_LENGTH).join('').trimEnd()
    : cleaned;
}

/**
 * Detect filters too broad to express user intent for a mutating action.
 * @param {Object} filter - Validated filter
 * @param {number} matchCount - Number of tabs the filter matched
 * @param {number} totalCount - Number of open tabs considered
 * @returns {string|null} A user-facing reason, or null when the filter is specific enough
 */
export function overBroadFilterReason(filter, matchCount, totalCount) {
  const tooBroad = 'That command is too broad. Please be more specific about which tabs you mean.';
  if (!isValidTabFilter(filter)) return tooBroad;

  if (hasOwn(filter, 'domain')) {
    const host = canonicalHostname(filter.domain);
    // A bare TLD/label ("com", "localhost" excepted) matches whole swaths of the web.
    if (!host || (!host.includes('.') && host !== 'localhost')) return tooBroad;
  }
  if (hasOwn(filter, 'urlContains')) {
    const needle = filter.urlContains.trim().toLowerCase();
    if (
      needle.length < MIN_URL_NEEDLE_LENGTH ||
      !/[a-z0-9]/.test(needle) ||
      TRIVIAL_URL_NEEDLES.has(needle)
    ) {
      return tooBroad;
    }
  }
  if (hasOwn(filter, 'titleContains')) {
    const needle = filter.titleContains.trim();
    if ([...needle].length < MIN_TITLE_NEEDLE_LENGTH || !/[\p{L}\p{N}]/u.test(needle)) return tooBroad;
  }
  // Matching every open tab (beyond a trivially small browser) is never a
  // targeted request, whatever the filter text looks like.
  if (totalCount > 2 && matchCount >= totalCount) return tooBroad;
  return null;
}

function windowCount(tabs) {
  return new Set(tabs.map((tab) => tab?.windowId).filter((id) => id !== undefined)).size;
}

/**
 * Whether a mutating NL action must be confirmed by the user before running.
 */
export function nlActionRequiresConfirmation(action, tabs) {
  if (action === 'close') return true;
  if (action !== 'group' && action !== 'move') return false;
  const list = Array.isArray(tabs) ? tabs : [];
  return list.length > NL_CONFIRM_TAB_THRESHOLD || windowCount(list) > 1;
}

function quoteTitle(tab) {
  const raw = typeof tab?.title === 'string' && tab.title.trim() ? tab.title : (tab?.url || 'Untitled');
  const single = String(raw).replace(/\s+/g, ' ').trim();
  const chars = [...single];
  return `"${chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : single}"`;
}

/**
 * Build the confirmation text from the real match set. AI-authored text is never
 * shown, since the model reads tab titles and is therefore prompt-injectable.
 */
export function buildNLConfirmation(action, tabs, details = {}) {
  const list = Array.isArray(tabs) ? tabs : [];
  const count = list.length;
  const windows = windowCount(list);
  const pinned = list.filter((tab) => tab?.pinned === true).length;
  const tabWord = count === 1 ? 'tab' : 'tabs';

  let verb;
  if (action === 'close') verb = `Close ${count} ${tabWord}`;
  else if (action === 'group') verb = `Group ${count} ${tabWord} as "${sanitizeGroupName(details.groupName)}"`;
  else if (action === 'move') verb = `Move ${count} ${tabWord} to a new window`;
  else verb = `Apply "${action}" to ${count} ${tabWord}`;

  const scope = [];
  if (windows > 1) scope.push(`across ${windows} windows`);
  if (pinned > 0) scope.push(`including ${pinned} pinned`);
  if (action === 'group' && windows > 1) scope.push('one group per window');

  const sample = list.slice(0, 3).map(quoteTitle).join(', ');
  const more = count > 3 ? ` and ${count - 3} more` : '';
  return `${verb}${scope.length ? ` (${scope.join(', ')})` : ''}? ${sample}${more}`.trim();
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
      const title = sanitizeGroupName(parsed.groupName);
      const color = sanitizeGroupColor(parsed.color);
      if (tabIds.length < 1) return { error: 'No tabs to group' };
      // chrome.tabs.group pulls every tab into one window; group per window instead.
      const byWindow = new Map();
      for (const tab of tabs) {
        if (!Number.isInteger(tab?.id)) continue;
        const key = tab.windowId ?? null;
        if (!byWindow.has(key)) byWindow.set(key, []);
        byWindow.get(key).push(tab.id);
      }
      for (const ids of byWindow.values()) {
        await createNativeGroup(ids, title, color);
      }
      const suffix = byWindow.size > 1 ? ` in ${byWindow.size} windows` : '';
      return { executed: true, message: `Grouped ${tabIds.length} tab(s) as "${title}"${suffix}` };
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
