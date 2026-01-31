// core/engine/executor.js — Phase 4: Rate-limited execution of the move plan

import { OpType, MOVE_BATCH_SIZE, BATCH_DELAY_MS, DOMAIN_DELAY_MS } from './types.js';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const MAX_RETRIES = 3;

/**
 * Executes a MovePlan with rate-limited batching and retry logic.
 *
 * @param {MovePlan} movePlan — the plan to execute
 * @param {Function} onProgress — callback({ phase, current, total, detail })
 * @returns {Object} execution stats
 */
export async function execute(movePlan, onProgress) {
  const { operations } = movePlan;
  const total = operations.length;

  // Slot index → resolved windowId (for new windows created during execution)
  const resolvedWindows = new Map();
  // Slot index → existing windowId (from planner assignment)
  const assignedWindows = new Map();

  let tabsMoved = 0;
  let windowsCreated = 0;
  let groupsCreated = 0;
  let errors = 0;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];

    if (onProgress) {
      onProgress({
        phase: 'executor',
        current: i + 1,
        total,
        detail: describeOp(op),
      });
    }

    try {
      switch (op.type) {
        case OpType.CREATE_WINDOW: {
          const newWindow = await chrome.windows.create({ tabId: op.seedTabId });
          resolvedWindows.set(op.slotIndex, newWindow.id);
          windowsCreated++;
          // Longer delay after window creation — Chrome needs time to stabilize
          await delay(DOMAIN_DELAY_MS);
          break;
        }

        case OpType.MOVE_TABS: {
          // Resolve the target window ID
          let targetWindowId = op.targetWindowId;
          if (targetWindowId === null) {
            targetWindowId = resolvedWindows.get(op.slotIndex);
          }
          // Also record this for CREATE_GROUP reconciliation
          if (targetWindowId) {
            assignedWindows.set(op.slotIndex, targetWindowId);
          }

          if (!targetWindowId) {
            errors++;
            break;
          }

          // Move in batches with retry
          const moved = await moveTabsInBatches(op.tabIds, targetWindowId);
          tabsMoved += moved;
          await delay(BATCH_DELAY_MS);
          break;
        }

        case OpType.CREATE_GROUP: {
          // Determine the target window for this slot.
          // Prefer the explicit targetWindowId from the planner, then resolve
          // from runtime maps, and finally fall back to the first tab's window.
          const targetWindowId = op.targetWindowId
            || resolvedWindows.get(op.slotIndex)
            || assignedWindows.get(op.slotIndex)
            || await getTabWindowId(op.tabIds[0]);

          if (!targetWindowId) {
            errors++;
            break;
          }

          // Reconcile: ensure ALL tabs are in the target window before grouping.
          await reconcileTabsToWindow(op.tabIds, targetWindowId);
          await delay(BATCH_DELAY_MS);

          // Filter to only tabs actually present in the target window.
          // This prevents chrome.tabs.group from pulling tabs across windows
          // if some moves silently failed.
          let validTabIds = await getTabIdsInWindow(op.tabIds, targetWindowId);

          if (validTabIds.length < 2) {
            if (validTabIds.length === 0) errors++;
            break;
          }

          try {
            // CRITICAL: always specify createProperties.windowId so Chrome
            // never guesses the target window and moves tabs to the wrong one.
            const groupId = await chrome.tabs.group({
              createProperties: { windowId: targetWindowId },
              tabIds: validTabIds,
            });
            await chrome.tabGroups.update(groupId, { title: op.title, color: op.color });
            groupsCreated++;
          } catch {
            // Retry: re-reconcile and try once more
            await delay(DOMAIN_DELAY_MS);
            await reconcileTabsToWindow(op.tabIds, targetWindowId);
            await delay(BATCH_DELAY_MS);
            validTabIds = await getTabIdsInWindow(op.tabIds, targetWindowId);

            if (validTabIds.length < 2) {
              errors++;
              break;
            }

            try {
              const groupId = await chrome.tabs.group({
                createProperties: { windowId: targetWindowId },
                tabIds: validTabIds,
              });
              await chrome.tabGroups.update(groupId, { title: op.title, color: op.color });
              groupsCreated++;
            } catch {
              errors++;
            }
          }
          await delay(BATCH_DELAY_MS);
          break;
        }

        case OpType.UPDATE_GROUP: {
          await chrome.tabGroups.update(op.groupId, { title: op.title, color: op.color });
          break;
        }

        case OpType.REMOVE_GROUP: {
          try {
            await chrome.tabs.ungroup(op.tabIds);
          } catch {
            errors++;
          }
          break;
        }
      }
    } catch (err) {
      // Some tabs (chrome://, devtools, etc.) can't be grouped/moved — skip
      errors++;
    }

    // Pause between operations
    if (i < operations.length - 1) {
      await delay(BATCH_DELAY_MS);
    }
  }

  // Clean up any leftover blank new-tab pages in newly created windows
  await cleanupBlankTabs(resolvedWindows);

  return { tabsMoved, windowsCreated, groupsCreated, errors };
}

/**
 * Move tabs in small batches with pauses and retry logic.
 * Returns the number of tabs actually moved.
 */
export async function moveTabsInBatches(tabIds, windowId) {
  let moved = 0;

  for (let i = 0; i < tabIds.length; i += MOVE_BATCH_SIZE) {
    const batch = tabIds.slice(i, i + MOVE_BATCH_SIZE);
    let success = false;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await chrome.tabs.move(batch, { windowId, index: -1 });
        moved += batch.length;
        success = true;
        break;
      } catch (e) {
        console.warn('[TabKebab] batch tab move failed, retrying:', e);
        await delay(BATCH_DELAY_MS * (attempt + 1));
      }
    }

    if (!success) {
      // Try tabs individually as last resort
      for (const tabId of batch) {
        try {
          await chrome.tabs.move(tabId, { windowId, index: -1 });
          moved++;
        } catch {
          // Tab may have been closed or is unmovable — skip
        }
      }
    }

    if (i + MOVE_BATCH_SIZE < tabIds.length) {
      await delay(BATCH_DELAY_MS);
    }
  }

  return moved;
}

/**
 * Ensure all given tabs are in the target window.
 * Queries each tab's actual window and moves any that are misplaced.
 */
async function reconcileTabsToWindow(tabIds, targetWindowId) {
  const misplaced = [];

  // Batch query: get all tabs in the target window
  let targetTabIds;
  try {
    const targetTabs = await chrome.tabs.query({ windowId: targetWindowId });
    targetTabIds = new Set(targetTabs.map(t => t.id));
  } catch {
    return; // Window doesn't exist
  }

  for (const tabId of tabIds) {
    if (!targetTabIds.has(tabId)) {
      misplaced.push(tabId);
    }
  }

  if (misplaced.length === 0) return;

  // Move misplaced tabs in batches
  await moveTabsInBatches(misplaced, targetWindowId);
}

/**
 * Return the subset of desiredTabIds that are actually present in the given window.
 * Prevents chrome.tabs.group from pulling tabs across windows.
 */
async function getTabIdsInWindow(desiredTabIds, windowId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const present = new Set(tabs.map(t => t.id));
    return desiredTabIds.filter(id => present.has(id));
  } catch {
    return [];
  }
}

/**
 * Get the window ID for a given tab.
 */
async function getTabWindowId(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.windowId;
  } catch {
    return null;
  }
}

/**
 * Remove blank "New Tab" pages left over from chrome.windows.create().
 */
async function cleanupBlankTabs(resolvedWindows) {
  for (const windowId of resolvedWindows.values()) {
    try {
      const tabs = await chrome.tabs.query({ windowId });
      const blankTabs = tabs.filter(t =>
        t.url === 'chrome://newtab/' || t.url === 'about:blank'
      );
      // Only remove blanks if there are other tabs in the window
      if (blankTabs.length > 0 && tabs.length > blankTabs.length) {
        await chrome.tabs.remove(blankTabs.map(t => t.id));
      }
    } catch {
      // Window may have been closed
    }
  }
}

/**
 * Human-readable description of an operation (for progress UI).
 */
function describeOp(op) {
  switch (op.type) {
    case OpType.CREATE_WINDOW:
      return 'Creating new window...';
    case OpType.MOVE_TABS:
      return `Moving ${op.tabIds.length} tab(s)...`;
    case OpType.CREATE_GROUP:
      return `Grouping: ${op.title}`;
    case OpType.UPDATE_GROUP:
      return `Updating group: ${op.title}`;
    case OpType.REMOVE_GROUP:
      return `Ungrouping ${op.tabIds.length} tab(s)...`;
    default:
      return 'Processing...';
  }
}
