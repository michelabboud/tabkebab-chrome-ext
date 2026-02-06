// core/grouping.js — Domain grouping orchestrator + manual grouping CRUD

import { getAllTabs, extractDomain, createNativeGroup } from './tabs-api.js';
import { Storage } from './storage.js';
import { Phase, WINDOW_CAP } from './engine/types.js';
import { takeSnapshot } from './engine/snapshot.js';
import { solve } from './engine/solver.js';
import { solveWithAI } from './engine/solver-ai.js';
import { plan } from './engine/planner.js';
import { execute, moveTabsInBatches } from './engine/executor.js';

const MAX_VERIFY_PASSES = 3;
const MIN_WINDOW_TABS = 3;

// ── Domain-grouped tab list (for the side panel display) ──

export async function getAllTabsGroupedByDomain(allWindows = true) {
  const tabs = await getAllTabs({ allWindows });
  const groups = {};

  for (const tab of tabs) {
    const domain = extractDomain(tab.url || tab.pendingUrl || '');
    if (!groups[domain]) groups[domain] = [];
    groups[domain].push(tab);
  }

  return Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([domain, tabs]) => ({ domain, tabs }));
}

// ── 4-Phase Pipeline: Snapshot → Solver → Planner → Executor ──

export async function applyDomainGroupsToChrome(onProgress) {
  const report = (phase, detail) => {
    if (onProgress) onProgress({ phase, detail });
  };

  // Phase 1: Snapshot — read current browser state
  report(Phase.SNAPSHOT, 'Reading all tabs and windows...');
  const snapshot = await takeSnapshot();

  // Phase 2: Solver — compute ideal end-state
  report(Phase.SOLVER, `Computing layout for ${snapshot.tabs.length} tabs across ${snapshot.tabsByDomain.size} domains...`);
  const desiredState = solve(snapshot);

  // Phase 3: Planner — diff current vs desired → minimal move plan
  report(Phase.PLANNER, 'Planning minimal moves...');
  const movePlan = plan(snapshot, desiredState);

  const { stats } = movePlan;
  const nothingToDo = stats.windowsToCreate === 0 &&
                      stats.tabsToMove === 0 &&
                      stats.groupsToCreate === 0;

  if (nothingToDo) {
    report(Phase.EXECUTOR, 'Already organized — no moves needed.');
    return {
      tabsMoved: 0,
      windowsCreated: 0,
      groupsCreated: 0,
      errors: 0,
      alreadyOrganized: true,
    };
  }

  // Phase 4: Executor — rate-limited execution
  report(Phase.EXECUTOR, `Executing: ${stats.tabsToMove} tab moves, ${stats.windowsToCreate} new windows, ${stats.groupsToCreate} groups...`);

  const result = await execute(movePlan, (progress) => {
    report(Phase.EXECUTOR, progress.detail);
  });

  // ── Convergence loop: re-check and fix until stable ──
  for (let pass = 0; pass < MAX_VERIFY_PASSES; pass++) {
    report(Phase.SNAPSHOT, `Verifying (pass ${pass + 1}/${MAX_VERIFY_PASSES})...`);
    const freshSnapshot = await takeSnapshot();

    report(Phase.PLANNER, 'Checking for remaining moves...');
    const verifyPlan = plan(freshSnapshot, desiredState);

    if (verifyPlan.operations.length === 0) {
      break; // Converged — actual state matches desired state
    }

    report(Phase.EXECUTOR, `Fixing: ${verifyPlan.stats.tabsToMove} tab moves, ${verifyPlan.stats.groupsToCreate} groups...`);
    const passResult = await execute(verifyPlan, (progress) => {
      report(Phase.EXECUTOR, progress.detail);
    });

    // Accumulate stats
    result.tabsMoved += passResult.tabsMoved;
    result.windowsCreated += passResult.windowsCreated;
    result.groupsCreated += passResult.groupsCreated;
    result.errors += passResult.errors;
  }

  // ── Straggler window cleanup: consolidate near-empty orphan windows ──
  const cleanedUp = await cleanupStragglerWindows(desiredState, report);
  result.tabsMoved += cleanedUp;

  return { ...result, alreadyOrganized: false };
}

// ── AI-Powered Smart Grouping Pipeline ──

export async function applySmartGroupsToChrome(onProgress) {
  const report = (phase, detail) => {
    if (onProgress) onProgress({ phase, detail });
  };

  // Phase 1: Snapshot
  report(Phase.SNAPSHOT, 'Reading all tabs and windows...');
  const snapshot = await takeSnapshot();

  // Phase 2: AI Solver (with deterministic fallback)
  report(Phase.SOLVER, 'Analyzing tabs with AI...');
  let desiredState;
  try {
    desiredState = await solveWithAI(snapshot, (detail) => {
      report(Phase.SOLVER, detail);
    });
  } catch (err) {
    report(Phase.SOLVER, 'AI unavailable, falling back to domain grouping...');
  }

  if (!desiredState) {
    report(Phase.SOLVER, `Falling back: computing layout for ${snapshot.tabs.length} tabs...`);
    desiredState = solve(snapshot);
  }

  // Phase 3: Planner
  report(Phase.PLANNER, 'Planning minimal moves...');
  const movePlan = plan(snapshot, desiredState);

  const { stats } = movePlan;
  const nothingToDo = stats.windowsToCreate === 0 &&
                      stats.tabsToMove === 0 &&
                      stats.groupsToCreate === 0;

  if (nothingToDo) {
    report(Phase.EXECUTOR, 'Already organized — no moves needed.');
    return {
      tabsMoved: 0,
      windowsCreated: 0,
      groupsCreated: 0,
      errors: 0,
      alreadyOrganized: true,
    };
  }

  // Phase 4: Executor
  report(Phase.EXECUTOR, `Executing: ${stats.tabsToMove} tab moves, ${stats.windowsToCreate} new windows, ${stats.groupsToCreate} groups...`);

  const result = await execute(movePlan, (progress) => {
    report(Phase.EXECUTOR, progress.detail);
  });

  // Convergence loop
  for (let pass = 0; pass < MAX_VERIFY_PASSES; pass++) {
    report(Phase.SNAPSHOT, `Verifying (pass ${pass + 1}/${MAX_VERIFY_PASSES})...`);
    const freshSnapshot = await takeSnapshot();

    report(Phase.PLANNER, 'Checking for remaining moves...');
    const verifyPlan = plan(freshSnapshot, desiredState);

    if (verifyPlan.operations.length === 0) break;

    report(Phase.EXECUTOR, `Fixing: ${verifyPlan.stats.tabsToMove} tab moves, ${verifyPlan.stats.groupsToCreate} groups...`);
    const passResult = await execute(verifyPlan, (progress) => {
      report(Phase.EXECUTOR, progress.detail);
    });

    result.tabsMoved += passResult.tabsMoved;
    result.windowsCreated += passResult.windowsCreated;
    result.groupsCreated += passResult.groupsCreated;
    result.errors += passResult.errors;
  }

  // Straggler cleanup
  const cleanedUp = await cleanupStragglerWindows(desiredState, report);
  result.tabsMoved += cleanedUp;

  return { ...result, alreadyOrganized: false };
}

/**
 * After convergence, find windows that only contain orphan tabs (not in any
 * solver WindowSlot) and have very few tabs. Move those tabs to the largest
 * window so Chrome auto-closes the empty windows.
 */
async function cleanupStragglerWindows(desiredState, report) {
  const snapshot = await takeSnapshot();

  // Build set of all tab IDs the solver placed into WindowSlots
  const desiredTabIds = new Set();
  for (const slot of desiredState.windowSlots) {
    for (const ds of slot.domains) {
      for (const id of ds.tabIds) desiredTabIds.add(id);
    }
  }

  // Find the largest window as consolidation target
  let targetWindowId = null;
  let targetSize = 0;
  for (const [wid, tabs] of snapshot.tabsByWindow) {
    if (tabs.length > targetSize) {
      targetSize = tabs.length;
      targetWindowId = wid;
    }
  }

  if (!targetWindowId) return 0;

  let totalMoved = 0;

  for (const [windowId, tabs] of snapshot.tabsByWindow) {
    if (windowId === targetWindowId) continue;
    if (tabs.length > MIN_WINDOW_TABS) continue;

    // Only consolidate if EVERY tab in this window is an orphan
    // (not assigned to any solver slot)
    const allOrphans = tabs.every(t => !desiredTabIds.has(t.id));
    if (!allOrphans) continue;

    report(Phase.EXECUTOR, `Consolidating ${tabs.length} orphan tab(s) from near-empty window...`);
    const moved = await moveTabsInBatches(tabs.map(t => t.id), targetWindowId);
    totalMoved += moved;
  }

  return totalMoved;
}

// ── Window stats + consolidation ──

const CONSOLIDATION_THRESHOLD = 30;

/**
 * Returns structured data about all Chrome windows for the Windows view.
 */
export async function getWindowStats() {
  const snapshot = await takeSnapshot();
  const windowObjMap = new Map(snapshot.windows.map(w => [w.id, w]));
  const windowList = [];

  for (const [windowId, tabs] of snapshot.tabsByWindow) {
    const windowObj = windowObjMap.get(windowId);
    const tabCount = tabs.length;

    // Bucket tabs by native group
    const groupsMap = new Map();
    const ungroupedTabs = [];

    for (const tab of tabs) {
      if (tab.groupId && tab.groupId !== -1) {
        if (!groupsMap.has(tab.groupId)) {
          const info = snapshot.groupsById.get(tab.groupId);
          groupsMap.set(tab.groupId, {
            groupId: tab.groupId,
            title: info?.title || 'Untitled',
            color: info?.color || 'grey',
            tabCount: 0,
            tabs: [],
          });
        }
        const g = groupsMap.get(tab.groupId);
        g.tabCount++;
        g.tabs.push({ id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl });
      } else {
        ungroupedTabs.push({ id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl });
      }
    }

    windowList.push({
      windowId,
      windowNumber: 0,
      focused: windowObj?.focused ?? false,
      tabCount,
      groups: [...groupsMap.values()],
      ungroupedCount: ungroupedTabs.length,
      ungroupedTabs,
    });
  }

  // Sort: focused first, then by tabCount descending
  windowList.sort((a, b) => {
    if (a.focused !== b.focused) return b.focused - a.focused;
    return b.tabCount - a.tabCount;
  });
  windowList.forEach((w, i) => { w.windowNumber = i + 1; });

  const totalTabs = windowList.reduce((sum, w) => sum + w.tabCount, 0);

  // Count discarded (kebab'd) tabs across all windows
  let discardedTabs = 0;
  for (const tabs of snapshot.tabsByWindow.values()) {
    for (const tab of tabs) {
      if (tab.discarded || tab.status === 'discarded') discardedTabs++;
    }
  }
  const activeTabs = totalTabs - discardedTabs;

  return {
    totalWindows: windowList.length,
    totalTabs,
    activeTabs,
    discardedTabs,
    avgTabsPerWindow: windowList.length > 0
      ? Math.round((totalTabs / windowList.length) * 10) / 10
      : 0,
    windows: windowList,
  };
}

const IDEAL_WINDOW_SIZE = 50;   // Target tabs per window
const MAX_GROUPS_PER_WINDOW = 8; // Max Chrome tab groups per window

/**
 * Consolidate windows for optimal organization:
 * 1. Move excess tabs from huge windows (> WINDOW_CAP) to smaller windows
 * 2. Merge under-utilized windows (< 30 tabs) into others
 * 3. Balance groups across windows (max MAX_GROUPS_PER_WINDOW per window)
 * Then re-run the grouping pipeline.
 */
export async function consolidateWindows(onProgress) {
  const report = (phase, detail) => {
    if (onProgress) onProgress({ phase, detail });
  };

  report(Phase.SNAPSHOT, 'Scanning windows...');
  let snapshot = await takeSnapshot();

  let totalTabsMoved = 0;
  let windowsConsolidated = 0;
  let tabsRedistributed = 0;

  // ── Phase 1: Redistribute from huge windows to smaller ones ──
  const windowStats = [];
  for (const [windowId, tabs] of snapshot.tabsByWindow) {
    // Count groups in this window
    const groupIds = new Set(tabs.map(t => t.groupId).filter(g => g !== -1));
    windowStats.push({
      windowId,
      tabs,
      count: tabs.length,
      groupCount: groupIds.size,
    });
  }

  // Find huge windows (over cap) and small windows (under ideal with room)
  const hugeWindows = windowStats.filter(w => w.count > WINDOW_CAP);
  const smallWindows = windowStats
    .filter(w => w.count < IDEAL_WINDOW_SIZE && w.count >= CONSOLIDATION_THRESHOLD)
    .sort((a, b) => a.count - b.count);

  if (hugeWindows.length > 0 && smallWindows.length > 0) {
    report(Phase.EXECUTOR, `Redistributing tabs from ${hugeWindows.length} oversized window(s)...`);

    for (const huge of hugeWindows) {
      const excess = huge.count - IDEAL_WINDOW_SIZE;
      if (excess <= 0) continue;

      // Get tabs to move (from the end, non-active, non-pinned)
      const movableTabs = huge.tabs
        .filter(t => !t.active && !t.pinned)
        .slice(-excess);

      let moved = 0;
      for (const target of smallWindows) {
        if (moved >= excess) break;
        const room = IDEAL_WINDOW_SIZE - target.count;
        if (room <= 0) continue;

        const batch = movableTabs.slice(moved, moved + room);
        if (batch.length === 0) continue;

        report(Phase.EXECUTOR, `Moving ${batch.length} tab(s) from window with ${huge.count} to window with ${target.count}...`);
        const batchMoved = await moveTabsInBatches(batch.map(t => t.id), target.windowId);
        moved += batchMoved;
        target.count += batchMoved;
        tabsRedistributed += batchMoved;
      }

      // If still have excess and no small windows with room, create new window
      if (moved < excess) {
        const remaining = movableTabs.slice(moved);
        if (remaining.length > 0) {
          report(Phase.EXECUTOR, `Creating new window for ${remaining.length} excess tab(s)...`);
          try {
            const firstTab = remaining[0];
            const newWindow = await chrome.windows.create({ tabId: firstTab.id });
            if (remaining.length > 1) {
              await moveTabsInBatches(remaining.slice(1).map(t => t.id), newWindow.id);
            }
            tabsRedistributed += remaining.length;
          } catch (e) {
            console.warn('[TabKebab] Failed to create overflow window:', e);
          }
        }
      }
    }

    // Re-snapshot after redistribution
    snapshot = await takeSnapshot();
  }

  // ── Phase 2: Consolidate small windows ──
  const sources = [];
  const targets = [];

  for (const [windowId, tabs] of snapshot.tabsByWindow) {
    const count = tabs.length;
    if (count < CONSOLIDATION_THRESHOLD) {
      sources.push({ windowId, tabs, count });
    } else if (count <= WINDOW_CAP) {
      targets.push({ windowId, count, room: WINDOW_CAP - count });
    }
  }

  sources.sort((a, b) => a.count - b.count);
  targets.sort((a, b) => b.room - a.room);

  if (sources.length > 0) {
    report(Phase.EXECUTOR, `Consolidating ${sources.length} under-utilized window(s)...`);

    for (const source of sources) {
      const target = targets.find(t => t.room >= source.count);
      if (!target) continue;

      report(Phase.EXECUTOR, `Moving ${source.count} tab(s) into window with ${target.count} tabs...`);
      const moved = await moveTabsInBatches(source.tabs.map(t => t.id), target.windowId);
      totalTabsMoved += moved;

      target.count += moved;
      target.room -= moved;
      windowsConsolidated++;
    }
  } else if (hugeWindows.length === 0) {
    report(Phase.EXECUTOR, 'No windows need consolidation.');
    return { tabsMoved: 0, windowsClosed: 0, windowsConsolidated: 0, tabsRedistributed: 0, pipelineResult: null };
  }

  // Re-run the full grouping pipeline to fix groups
  report(Phase.SNAPSHOT, 'Re-grouping after consolidation...');
  const pipelineResult = await applyDomainGroupsToChrome(onProgress);

  // Count how many source windows were closed
  const postSnapshot = await takeSnapshot();
  const survivingIds = new Set(postSnapshot.tabsByWindow.keys());
  const windowsClosed = sources.filter(s => !survivingIds.has(s.windowId)).length;

  return { tabsMoved: totalTabsMoved, windowsClosed, windowsConsolidated, tabsRedistributed, pipelineResult };
}

// ── Manual groups ──
// Stored in chrome.storage.local under key 'manualGroups'
// Format: { [groupId]: { name, color, tabUrls[], createdAt, modifiedAt } }

export async function getManualGroups() {
  return (await Storage.get('manualGroups')) || {};
}

export async function saveManualGroup(groupId, groupData) {
  const groups = await getManualGroups();
  groups[groupId] = { ...groupData, modifiedAt: Date.now() };
  return Storage.set('manualGroups', groups);
}

export async function deleteManualGroup(groupId) {
  const groups = await getManualGroups();
  delete groups[groupId];
  return Storage.set('manualGroups', groups);
}

export async function addTabToManualGroup(groupId, tabUrl) {
  const groups = await getManualGroups();
  const group = groups[groupId];
  if (!group) return;
  if (!group.tabUrls.includes(tabUrl)) {
    group.tabUrls.push(tabUrl);
    group.modifiedAt = Date.now();
  }
  return Storage.set('manualGroups', groups);
}

export async function removeTabFromManualGroup(groupId, tabUrl) {
  const groups = await getManualGroups();
  const group = groups[groupId];
  if (!group) return;
  group.tabUrls = group.tabUrls.filter(u => u !== tabUrl);
  group.modifiedAt = Date.now();
  return Storage.set('manualGroups', groups);
}

export async function removeTabFromAllGroups(tabUrl) {
  const groups = await getManualGroups();
  for (const group of Object.values(groups)) {
    const before = group.tabUrls.length;
    group.tabUrls = group.tabUrls.filter(u => u !== tabUrl);
    if (group.tabUrls.length !== before) {
      group.modifiedAt = Date.now();
    }
  }
  return Storage.set('manualGroups', groups);
}

export async function applyManualGroupToChrome(groupId) {
  const groups = await getManualGroups();
  const group = groups[groupId];
  if (!group) return;

  const allTabs = await getAllTabs({ allWindows: true });
  const tabIds = allTabs
    .filter(t => group.tabUrls.includes(t.url))
    .map(t => t.id);

  if (tabIds.length === 0) return;
  return createNativeGroup(tabIds, group.name, group.color);
}
