// core/engine/snapshot.js — Phase 1: Read the current browser state

import { extractDomain } from '../tabs-api.js';
import { createSnapshot } from './types.js';

/**
 * Reads all windows, tabs, and tab groups in parallel.
 * Returns a frozen Snapshot with indexed maps for fast lookups.
 */
export async function takeSnapshot() {
  const [windows, tabs, tabGroups] = await Promise.all([
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
  ]);

  // Pre-classify each tab with its domain
  for (const tab of tabs) {
    tab._domain = extractDomain(tab.url || tab.pendingUrl || '');
  }

  return createSnapshot({ windows, tabs, tabGroups });
}
