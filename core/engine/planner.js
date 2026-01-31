// core/engine/planner.js — Phase 3: Diff current vs desired → minimal move plan

import { OpType, createMovePlan } from './types.js';

/**
 * Takes Snapshot + DesiredState, produces a MovePlan with the minimum
 * number of operations to reach the desired state.
 *
 * Strategy:
 * 1. For each WindowSlot, find the existing window with the highest
 *    tab overlap (greedy matching) → reuse it. Unmatched slots need
 *    new windows.
 * 2. For each matched pair, diff: which tabs need to move in/out.
 * 3. For groups: which native groups already match, which need creating.
 * 4. Output ordered operations: CREATE_WINDOW → MOVE_TABS → CREATE_GROUP.
 */
export function plan(snapshot, desiredState) {
  const operations = [];
  const stats = { windowsToCreate: 0, tabsToMove: 0, groupsToCreate: 0, groupsToRemove: 0 };

  // ── Build a set of all tab IDs in each existing window ──
  const existingWindowTabs = new Map(); // windowId → Set<tabId>
  for (const [windowId, tabs] of snapshot.tabsByWindow) {
    existingWindowTabs.set(windowId, new Set(tabs.map(t => t.id)));
  }

  // ── Build index of existing native groups ──
  // Map: windowId → Map<title, { groupId, tabIds: Set }>
  const existingGroups = buildExistingGroupIndex(snapshot);

  // ── Greedy window matching ──
  const usedWindows = new Set();
  const slotAssignments = []; // parallel to desiredState.windowSlots

  for (const slot of desiredState.windowSlots) {
    const slotTabIds = new Set();
    for (const ds of slot.domains) {
      for (const id of ds.tabIds) slotTabIds.add(id);
    }

    // Find best existing window by overlap score
    let bestWindowId = null;
    let bestOverlap = 0;

    for (const [windowId, windowTabSet] of existingWindowTabs) {
      if (usedWindows.has(windowId)) continue;

      let overlap = 0;
      for (const id of slotTabIds) {
        if (windowTabSet.has(id)) overlap++;
      }

      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestWindowId = windowId;
      }
    }

    // Only reuse if overlap is meaningful (at least 1 tab already there)
    if (bestWindowId !== null && bestOverlap > 0) {
      usedWindows.add(bestWindowId);
      slotAssignments.push({ slot, windowId: bestWindowId, needsCreation: false, slotTabIds });
    } else {
      slotAssignments.push({ slot, windowId: null, needsCreation: true, slotTabIds });
      stats.windowsToCreate++;
    }
  }

  // ── Emit operations ──

  // Pass 1: Create new windows (using a seed tab from each slot)
  for (let i = 0; i < slotAssignments.length; i++) {
    const assignment = slotAssignments[i];
    if (!assignment.needsCreation) continue;

    // Pick the first tab from the first domain as seed
    const seedTabId = assignment.slot.domains[0].tabIds[0];
    operations.push({
      type: OpType.CREATE_WINDOW,
      slotIndex: i,
      seedTabId,
    });
  }

  // Pass 2: Move tabs that aren't in their target window
  for (let i = 0; i < slotAssignments.length; i++) {
    const assignment = slotAssignments[i];
    // windowId will be resolved at execution time for new windows
    const targetWindowId = assignment.windowId; // null if new

    const tabsToMove = [];
    for (const tabId of assignment.slotTabIds) {
      const tab = snapshot.tabsById.get(tabId);
      if (!tab) continue;
      // If the window needs creation, the seed tab is already moved by CREATE_WINDOW.
      // All other tabs need moving.
      if (assignment.needsCreation) {
        const seedTabId = assignment.slot.domains[0].tabIds[0];
        if (tabId === seedTabId) continue; // seed is already in the new window
        tabsToMove.push(tabId);
      } else {
        // Existing window — only move tabs not already there
        if (tab.windowId !== targetWindowId) {
          tabsToMove.push(tabId);
        }
      }
    }

    if (tabsToMove.length > 0) {
      operations.push({
        type: OpType.MOVE_TABS,
        tabIds: tabsToMove,
        slotIndex: i,
        targetWindowId, // null for new windows → resolved at execution
      });
      stats.tabsToMove += tabsToMove.length;
    }
  }

  // Pass 3: Create/update native tab groups
  for (let i = 0; i < slotAssignments.length; i++) {
    const assignment = slotAssignments[i];

    for (const domainSlot of assignment.slot.domains) {
      if (domainSlot.tabIds.length < 2) continue; // Can't group a single tab

      // Check if a matching group already exists in the target window
      const targetWinId = assignment.windowId;
      const existingGroup = findMatchingGroup(
        existingGroups, targetWinId, domainSlot.label, domainSlot.tabIds
      );

      if (existingGroup && existingGroup.exactMatch) {
        // Group already exists with the same tabs — skip
        continue;
      }

      // Need to create or update
      operations.push({
        type: OpType.CREATE_GROUP,
        tabIds: domainSlot.tabIds,
        title: domainSlot.label,
        color: domainSlot.color,
        slotIndex: i,
        targetWindowId: assignment.windowId, // null if new window (resolved at execution)
      });
      stats.groupsToCreate++;
    }
  }

  return createMovePlan({ operations, stats });
}

/**
 * Build index of existing native tab groups.
 * Returns Map<windowId, Map<title, { groupId, tabIds: Set, color }>>
 */
function buildExistingGroupIndex(snapshot) {
  const index = new Map();

  // Map groupId → list of tab IDs
  const groupTabIds = new Map();
  for (const tab of snapshot.tabs) {
    if (tab.groupId && tab.groupId !== -1) {
      if (!groupTabIds.has(tab.groupId)) groupTabIds.set(tab.groupId, []);
      groupTabIds.get(tab.groupId).push(tab.id);
    }
  }

  for (const group of snapshot.tabGroups) {
    const tabIds = groupTabIds.get(group.id) || [];
    if (tabIds.length === 0) continue;

    // Determine which window this group is in (from first tab)
    const firstTab = snapshot.tabsById.get(tabIds[0]);
    if (!firstTab) continue;
    const windowId = firstTab.windowId;

    if (!index.has(windowId)) index.set(windowId, new Map());
    const windowGroups = index.get(windowId);

    windowGroups.set(group.title, {
      groupId: group.id,
      tabIds: new Set(tabIds),
      color: group.color,
    });
  }

  return index;
}

/**
 * Check if a matching native group already exists.
 * Returns { exactMatch: boolean } or null.
 */
function findMatchingGroup(existingGroups, windowId, title, desiredTabIds) {
  if (!windowId) return null; // new window, no existing groups

  const windowGroups = existingGroups.get(windowId);
  if (!windowGroups) return null;

  const existing = windowGroups.get(title);
  if (!existing) return null;

  // Check exact match: same set of tab IDs
  const desiredSet = new Set(desiredTabIds);
  const exactMatch = desiredSet.size === existing.tabIds.size &&
    [...desiredSet].every(id => existing.tabIds.has(id));

  return { exactMatch, groupId: existing.groupId };
}
