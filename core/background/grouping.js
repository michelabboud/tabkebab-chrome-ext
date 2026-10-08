// core/background/grouping.js — Domain/smart grouping, manual groups, native
// Chrome tab groups, and window consolidation actions.

import { getAllTabsGroupedByDomain, applyDomainGroupsToChrome, applySmartGroupsToChrome, getWindowStats, consolidateWindows, getManualGroups, createManualGroup, moveTabToManualGroup, deleteManualGroup } from '../grouping.js';
import { createNativeGroup, ungroupTabs } from '../tabs-api.js';
import { withStateMutationLock } from '../state-mutation-lock.js';
import { requireRuntimeString, requireRuntimeUrl } from './router.js';

const MANUAL_GROUP_COLORS = new Set([
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
]);

function requireManualGroupColor(value) {
  if (!MANUAL_GROUP_COLORS.has(value)) throw new TypeError('Manual group color is invalid');
  return value;
}

// ── Message handlers ──

export const groupingHandlers = {
  async getGroupedTabs() {
    return getAllTabsGroupedByDomain();
  },

  async applyDomainGroups() {
    const result = await applyDomainGroupsToChrome((progress) => {
      // Send progress updates to the side panel
      chrome.runtime.sendMessage({
        type: 'groupingProgress',
        ...progress
      }).catch(() => {});
    });
    return { success: true, ...result };
  },

  // ── AI Smart Grouping ──

  async applySmartGroups() {
    const result = await applySmartGroupsToChrome((progress) => {
      chrome.runtime.sendMessage({
        type: 'groupingProgress',
        ...progress
      }).catch(() => {});
    });
    return { success: true, ...result };
  },

  async getManualGroups() {
    return getManualGroups();
  },

  async createManualGroup(msg, ctx) {
    const { createManualGroup: createManualGroupOperation = createManualGroup } = ctx;
    const name = requireRuntimeString(msg.name, 'Manual group name');
    const color = requireManualGroupColor(msg.color);
    return withStateMutationLock(() => createManualGroupOperation(name, color));
  },

  async moveTabToManualGroup(msg, ctx) {
    const { moveTabToManualGroup: moveTabToManualGroupOperation = moveTabToManualGroup } = ctx;
    const tabUrl = requireRuntimeUrl(msg.tabUrl, 'Manual group tab URL');
    const targetGroupId = msg.targetGroupId === 'ungrouped'
      ? 'ungrouped'
      : requireRuntimeString(msg.targetGroupId, 'Target manual group ID');
    return withStateMutationLock(() => moveTabToManualGroupOperation(tabUrl, targetGroupId));
  },

  async deleteManualGroup(msg, ctx) {
    const { deleteManualGroup: deleteManualGroupOperation = deleteManualGroup, now = Date.now } = ctx;
    const groupId = requireRuntimeString(msg.groupId, 'Manual group ID');
    return withStateMutationLock(() => deleteManualGroupOperation(groupId, now()));
  },

  async createTabGroup(msg) {
    if (!Array.isArray(msg.tabIds) || msg.tabIds.length === 0 || !msg.tabIds.every(id => Number.isInteger(id))) {
      throw new Error('Invalid tabIds: expected non-empty array of integers');
    }
    const validColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
    const groupColor = validColors.includes(msg.color) ? msg.color : 'blue';
    const groupTitle = typeof msg.title === 'string' ? msg.title.slice(0, 200) : '';
    return createNativeGroup(msg.tabIds, groupTitle, groupColor);
  },

  async ungroupTabs(msg) {
    await ungroupTabs(msg.tabIds);
    return { success: true };
  },

  async setGroupCollapsed(msg) {
    await chrome.tabGroups.update(msg.groupId, { collapsed: msg.collapsed });
    return { success: true };
  },

  async getChromeGroups() {
    const groups = await chrome.tabGroups.query({});
    const result = [];
    for (const g of groups) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      result.push({
        id: g.id,
        title: g.title || 'Untitled',
        color: g.color,
        collapsed: g.collapsed,
        windowId: g.windowId,
        tabs: tabs.map(t => ({
          id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl,
        })),
      });
    }
    return result;
  },

  async getWindowStats() {
    return getWindowStats();
  },

  async consolidateWindows() {
    const result = await consolidateWindows((progress) => {
      chrome.runtime.sendMessage({
        type: 'consolidationProgress',
        ...progress
      }).catch(() => {});
    });
    return { success: true, ...result };
  },
};
