// core/engine/snapshot.js — Phase 1: Read the current browser state

import { extractDomain } from '../tabs-api.js';
import { createSnapshot } from './types.js';

/**
 * Reads all windows, tabs, and tab groups in parallel.
 * Returns a frozen Snapshot with indexed maps for fast lookups.
 *
 * Only tabs that live in *normal* windows are included — popup, app and
 * devtools windows are never planned. Regular and incognito windows are
 * never mixed: when any regular window exists the snapshot covers regular
 * windows only, otherwise it covers the incognito ones. Chrome cannot move
 * tabs across that boundary, so planning such moves would always fail.
 *
 * Pinned tabs are excluded by default so the engine never moves or groups
 * them (grouping a pinned tab unpins it). Read-only callers that want a
 * complete picture can pass `includePinned` / `includeAllProfiles`.
 *
 * @param {Object} [options]
 * @param {boolean} [options.includePinned=false]
 * @param {boolean} [options.includeAllProfiles=false] keep both regular and
 *   incognito windows (display-only callers; never use for planning)
 */
export async function takeSnapshot({ includePinned = false, includeAllProfiles = false } = {}) {
  const [allWindows, allTabs, allTabGroups] = await Promise.all([
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
  ]);

  const normalWindows = allWindows.filter(w => !w.type || w.type === 'normal');
  let windows = normalWindows;
  if (!includeAllProfiles) {
    const regular = normalWindows.filter(w => !w.incognito);
    windows = regular.length > 0 ? regular : normalWindows.filter(w => w.incognito);
  }
  const windowIds = new Set(windows.map(w => w.id));

  const tabs = allTabs.filter(t =>
    windowIds.has(t.windowId) && (includePinned || !t.pinned)
  );
  const tabGroups = allTabGroups.filter(g =>
    g.windowId === undefined || windowIds.has(g.windowId)
  );

  // Pre-classify each tab with its domain
  for (const tab of tabs) {
    tab._domain = extractDomain(tab.url || tab.pendingUrl || '');
  }

  return createSnapshot({ windows, tabs, tabGroups });
}
