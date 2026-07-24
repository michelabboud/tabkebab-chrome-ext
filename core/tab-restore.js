import { MAX_DRIVE_STRING_LENGTH } from './drive-sync.js';
import {
  MAX_CAPTURED_GROUP_TITLE_LENGTH,
  MAX_CAPTURED_TEXT_LENGTH,
} from './capture-limits.js';
import { normalizeUrl } from './duplicates.js';
import { createRestoreOutcome, finalizeRestoreOutcome } from './restore-outcome.js';
import { getAllTabs } from './tabs-api.js';

const RESTORE_BATCH = 6;
const LOAD_TIMEOUT_MS = 15000;
const VALID_MODES = new Set(['windows', 'here', 'single-window']);
const FORBIDDEN_PROTOCOLS = new Set([
  'about:',
  'blob:',
  'brave:',
  'chrome:',
  'chrome-extension:',
  'data:',
  'devtools:',
  'edge:',
  'javascript:',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneSavedTab(tab) {
  if (!tab || typeof tab !== 'object' || Array.isArray(tab)) {
    return { url: '' };
  }
  return structuredClone(tab);
}

function sanitizeTab(tab) {
  if (typeof tab.url === 'string') tab.url = tab.url.trim();

  if (typeof tab.title === 'string' && tab.title.length > MAX_CAPTURED_TEXT_LENGTH) {
    tab.title = tab.title.slice(0, MAX_CAPTURED_TEXT_LENGTH);
  }

  if (typeof tab.favIconUrl === 'string' && tab.favIconUrl) {
    let scheme = '';
    try {
      scheme = new URL(tab.favIconUrl).protocol.replace(/:$/, '');
    } catch {
      scheme = tab.favIconUrl.split(':', 1)[0].toLowerCase();
    }
    if (!['http', 'https', 'chrome', 'data'].includes(scheme)) {
      tab.favIconUrl = '';
    }
  }

  tab.pinned = Boolean(tab.pinned);
  return tab;
}

/**
 * Bound one captured Chrome group title to the same 200-character limit the
 * runtime group handlers enforce; non-string titles become an empty title.
 */
export function sanitizeCapturedGroupTitle(title) {
  return typeof title === 'string' ? title.slice(0, MAX_CAPTURED_GROUP_TITLE_LENGTH) : '';
}

/**
 * Sanitize one tab at capture time so stored sessions and stashes always
 * satisfy the canonical Drive/export string bound. Chrome does not bound
 * page-controlled title/favicon values, but canonicalization rejects any
 * string over MAX_DRIVE_STRING_LENGTH, so an unsanitized capture can block
 * every later delete, sync, and export. Returns null when the tab cannot be
 * represented at all: a missing URL, or a URL beyond the canonical limit,
 * cannot round-trip through sync or export.
 */
export function sanitizeCapturedTab(tab) {
  if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return null;
  const url = typeof tab.url === 'string' ? tab.url.trim() : '';
  if (url.length === 0 || url.length > MAX_DRIVE_STRING_LENGTH) return null;
  const captured = sanitizeTab({ ...tab, url });
  // Capture emits a complete bounded shape: no field is ever undefined, so
  // stored records never depend on the storage layer dropping undefined.
  if (typeof captured.title !== 'string') captured.title = '';
  if (
    typeof captured.favIconUrl !== 'string' ||
    captured.favIconUrl.length > MAX_DRIVE_STRING_LENGTH
  ) {
    captured.favIconUrl = '';
  }
  return captured;
}

function isRestorableUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return !FORBIDDEN_PROTOCOLS.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

function errorMessage(error) {
  return error?.message || String(error);
}

function addError(outcome, scope, savedTab, error) {
  outcome.errors.push({
    scope,
    url: typeof savedTab?.url === 'string' ? savedTab.url : '',
    message: errorMessage(error),
  });
}

async function waitForTabsLoaded(tabIds) {
  await Promise.all(tabIds.map(async (id) => {
    const start = Date.now();
    while (Date.now() - start < LOAD_TIMEOUT_MS) {
      try {
        const tab = await chrome.tabs.get(id);
        if (tab.status === 'complete') return;
      } catch {
        return;
      }
      await sleep(250);
    }
  }));
}

/**
 * Restore saved tab windows through one settlement-preserving coordinator.
 * Saved inputs are cloned before validation and sanitization.
 */
export async function restoreTabWindows(savedWindows, {
  mode = 'windows',
  discarded = true,
  onProgress = null,
} = {}) {
  if (!Array.isArray(savedWindows)) {
    throw new TypeError('Saved windows must be an array');
  }
  if (!VALID_MODES.has(mode)) {
    throw new TypeError(`Unsupported restore mode: ${mode}`);
  }

  const requestedCount = savedWindows.reduce(
    (count, window) => count + (Array.isArray(window?.tabs) ? window.tabs.length : 0),
    0,
  );
  const outcome = Object.assign(createRestoreOutcome(requestedCount), {
    windowsCreated: 0,
    groupsRestored: 0,
  });

  const openTabs = await getAllTabs({ allWindows: true });
  const openUrls = new Set(
    openTabs
      .filter((tab) => typeof tab.url === 'string' && tab.url)
      .map((tab) => normalizeUrl(tab.url)),
  );

  const preparedWindows = savedWindows.map((savedWindow, sourceIndex) => {
    const tabs = [];
    for (const rawTab of Array.isArray(savedWindow?.tabs) ? savedWindow.tabs : []) {
      const savedTab = sanitizeTab(cloneSavedTab(rawTab));
      if (!isRestorableUrl(savedTab.url)) {
        outcome.skippedInvalid++;
        continue;
      }

      const normalized = normalizeUrl(savedTab.url);
      if (openUrls.has(normalized)) {
        outcome.skippedDuplicate++;
        continue;
      }

      openUrls.add(normalized);
      tabs.push(savedTab);
    }

    return {
      sourceIndex,
      tabs,
      groups: Array.isArray(savedWindow?.groups) ? structuredClone(savedWindow.groups) : [],
    };
  });

  const total = preparedWindows.reduce((count, window) => count + window.tabs.length, 0);
  let hereWindowId;
  if (mode === 'here' && total > 0) {
    try {
      const currentWindow = await chrome.windows.getCurrent();
      if (!Number.isInteger(currentWindow?.id) || currentWindow.id < 0) {
        throw new Error('Current window did not contain a valid ID');
      }
      hereWindowId = currentWindow.id;
    } catch (error) {
      for (const preparedWindow of preparedWindows) {
        for (const savedTab of preparedWindow.tabs) {
          addError(outcome, 'create', savedTab, error);
        }
      }
      return finalizeRestoreOutcome(outcome);
    }
  }

  const progress = { created: 0, loaded: 0, total };
  const pendingMuted = new Map();

  async function reportProgress() {
    if (typeof onProgress !== 'function') return;
    try {
      await onProgress({ ...progress });
    } catch (error) {
      console.warn('[TabKebab] restore progress callback failed:', error);
    }
  }

  async function recordCreated(savedTab, createdTab, sourceIndex) {
    outcome.restoredCount++;
    progress.created++;
    await reportProgress();
    return { savedTab, createdTab, sourceIndex };
  }

  async function createTabBatch(savedTabs, sourceIndex, windowId) {
    const settled = await Promise.allSettled(savedTabs.map((savedTab) => {
      const createProperties = { url: savedTab.url, active: false };
      if (windowId !== undefined) createProperties.windowId = windowId;
      return chrome.tabs.create(createProperties);
    }));

    const pairs = [];
    for (let index = 0; index < settled.length; index++) {
      const savedTab = savedTabs[index];
      const settlement = settled[index];
      if (settlement.status === 'fulfilled') {
        pairs.push(await recordCreated(savedTab, settlement.value, sourceIndex));
      } else {
        addError(outcome, 'create', savedTab, settlement.reason);
      }
    }
    return pairs;
  }

  async function updatePinned(pair) {
    if (!pair.savedTab.pinned) return;
    try {
      await chrome.tabs.update(pair.createdTab.id, { pinned: true });
    } catch (error) {
      addError(outcome, 'pin', pair.savedTab, error);
    }
  }

  async function processPairs(pairs, shouldDiscard) {
    for (const pair of pairs) await updatePinned(pair);

    if (!shouldDiscard) {
      progress.loaded += pairs.length;
      await reportProgress();
      return;
    }

    for (const pair of pairs) {
      try {
        await chrome.tabs.update(pair.createdTab.id, { muted: true });
        pendingMuted.set(pair.createdTab.id, pair.savedTab);
      } catch (error) {
        addError(outcome, 'update', pair.savedTab, error);
      }
    }

    await waitForTabsLoaded(pairs.map((pair) => pair.createdTab.id));

    for (const pair of pairs) {
      try {
        await chrome.tabs.discard(pair.createdTab.id);
      } catch (error) {
        addError(outcome, 'discard', pair.savedTab, error);
      } finally {
        if (pendingMuted.has(pair.createdTab.id)) {
          try {
            await chrome.tabs.update(pair.createdTab.id, { muted: false });
            pendingMuted.delete(pair.createdTab.id);
          } catch (error) {
            addError(outcome, 'unmute', pair.savedTab, error);
          }
        }
      }
      progress.loaded++;
      await reportProgress();
    }
  }

  async function restoreGroups(preparedWindow, pairs, windowId) {
    const pairsByGroup = new Map();
    for (const pair of pairs) {
      const groupId = pair.savedTab.groupId;
      if (groupId === undefined || groupId === -1) continue;
      if (!pairsByGroup.has(groupId)) pairsByGroup.set(groupId, []);
      pairsByGroup.get(groupId).push(pair);
    }

    const groupMetadata = new Map(preparedWindow.groups.map((group) => [group.id, group]));
    for (const [savedGroupId, groupPairs] of pairsByGroup) {
      const representative = groupPairs[0].savedTab;
      let restoredGroupId;
      try {
        restoredGroupId = await chrome.tabs.group({
          createProperties: { windowId },
          tabIds: groupPairs.map((pair) => pair.createdTab.id),
        });
      } catch (error) {
        addError(outcome, 'group', representative, error);
        continue;
      }

      outcome.groupsRestored++;
      const metadata = groupMetadata.get(savedGroupId);
      if (!metadata) continue;

      const updateProperties = {};
      if (metadata.title) updateProperties.title = metadata.title;
      if (metadata.color) updateProperties.color = metadata.color;
      if (metadata.collapsed) updateProperties.collapsed = metadata.collapsed;
      if (Object.keys(updateProperties).length === 0) continue;

      try {
        await chrome.tabGroups.update(restoredGroupId, updateProperties);
      } catch (error) {
        addError(outcome, 'update', representative, error);
      }
    }
  }

  async function makePairVisible(pair) {
    try {
      pair.createdTab = await chrome.tabs.update(pair.createdTab.id, {
        active: true,
        muted: false,
      });
    } catch (error) {
      addError(outcome, 'update', pair.savedTab, error);
    }
  }

  async function createVisibleWindowTab(savedTab, sourceIndex) {
    let window;
    try {
      window = await chrome.windows.create({ url: savedTab.url });
    } catch (error) {
      addError(outcome, 'create', savedTab, error);
      return null;
    }

    outcome.windowsCreated++;
    let createdTab = window.tabs?.[0];
    if (!createdTab) {
      try {
        const windowTabs = await chrome.tabs.query({ windowId: window.id });
        createdTab = windowTabs[0];
      } catch (error) {
        addError(outcome, 'create', savedTab, error);
        return { pair: null, windowId: window.id };
      }
    }
    if (!createdTab) {
      addError(outcome, 'create', savedTab, new Error('Created window did not contain a tab'));
      return { pair: null, windowId: window.id };
    }

    const pair = await recordCreated(savedTab, createdTab, sourceIndex);
    await makePairVisible(pair);
    return { pair, windowId: window.id };
  }

  async function createWindowFromCandidates(entries) {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const visible = await createVisibleWindowTab(entry.savedTab, entry.sourceIndex);
      // Retry only a true windows.create rejection. Once a window exists, reuse it
      // even if its seed tab could not be discovered, avoiding an orphan extra window.
      if (visible) return { ...visible, nextIndex: index + 1 };
    }
    return null;
  }

  async function processBatchWithVisibleFallback(pairs, visiblePair) {
    if (visiblePair || pairs.length === 0) {
      await processPairs(pairs, discarded);
      return visiblePair;
    }

    const [promotedPair, ...backgroundPairs] = pairs;
    await makePairVisible(promotedPair);
    await processPairs([promotedPair], false);
    await processPairs(backgroundPairs, discarded);
    return promotedPair;
  }

  async function restoreIntoExistingWindow(preparedWindow, windowId) {
    const pairs = [];
    for (let index = 0; index < preparedWindow.tabs.length; index += RESTORE_BATCH) {
      const batchPairs = await createTabBatch(
        preparedWindow.tabs.slice(index, index + RESTORE_BATCH),
        preparedWindow.sourceIndex,
        windowId,
      );
      pairs.push(...batchPairs);
      await processPairs(batchPairs, discarded);
    }

    if (pairs.length > 0) {
      await restoreGroups(preparedWindow, pairs, windowId);
    }
  }

  async function restoreIntoNewWindow(preparedWindow) {
    if (preparedWindow.tabs.length === 0) return;
    const entries = preparedWindow.tabs.map((savedTab) => ({
      savedTab,
      sourceIndex: preparedWindow.sourceIndex,
    }));
    const visible = await createWindowFromCandidates(entries);
    if (!visible) return;

    const pairs = visible.pair ? [visible.pair] : [];
    let visiblePair = visible.pair;
    if (visiblePair) await processPairs([visiblePair], false);

    for (let index = visible.nextIndex; index < preparedWindow.tabs.length; index += RESTORE_BATCH) {
      const batchPairs = await createTabBatch(
        preparedWindow.tabs.slice(index, index + RESTORE_BATCH),
        preparedWindow.sourceIndex,
        visible.windowId,
      );
      pairs.push(...batchPairs);
      visiblePair = await processBatchWithVisibleFallback(batchPairs, visiblePair);
    }

    await restoreGroups(preparedWindow, pairs, visible.windowId);
  }

  try {
    if (mode === 'windows') {
      for (const preparedWindow of preparedWindows) {
        await restoreIntoNewWindow(preparedWindow);
      }
    } else if (mode === 'here') {
      for (const preparedWindow of preparedWindows) {
        await restoreIntoExistingWindow(preparedWindow, hereWindowId);
      }
    } else {
      const allTabs = preparedWindows.flatMap((preparedWindow) =>
        preparedWindow.tabs.map((savedTab) => ({
          savedTab,
          sourceIndex: preparedWindow.sourceIndex,
        })),
      );

      if (allTabs.length > 0) {
        const visible = await createWindowFromCandidates(allTabs);
        if (visible) {
          const pairsBySource = new Map();
          let visiblePair = visible.pair;
          if (visiblePair) {
            pairsBySource.set(visiblePair.sourceIndex, [visiblePair]);
            await processPairs([visiblePair], false);
          }

          for (let index = visible.nextIndex; index < allTabs.length; index += RESTORE_BATCH) {
            const batch = allTabs.slice(index, index + RESTORE_BATCH);
            const settled = await Promise.allSettled(batch.map(({ savedTab }) =>
              chrome.tabs.create({
                windowId: visible.windowId,
                url: savedTab.url,
                active: false,
              }),
            ));
            const batchPairs = [];
            for (let offset = 0; offset < settled.length; offset++) {
              const entry = batch[offset];
              const settlement = settled[offset];
              if (settlement.status === 'fulfilled') {
                const pair = await recordCreated(
                  entry.savedTab,
                  settlement.value,
                  entry.sourceIndex,
                );
                batchPairs.push(pair);
                if (!pairsBySource.has(entry.sourceIndex)) pairsBySource.set(entry.sourceIndex, []);
                pairsBySource.get(entry.sourceIndex).push(pair);
              } else {
                addError(outcome, 'create', entry.savedTab, settlement.reason);
              }
            }
            visiblePair = await processBatchWithVisibleFallback(batchPairs, visiblePair);
          }

          for (const preparedWindow of preparedWindows) {
            await restoreGroups(
              preparedWindow,
              pairsBySource.get(preparedWindow.sourceIndex) || [],
              visible.windowId,
            );
          }
        }
      }
    }
  } finally {
    for (const [tabId, savedTab] of pendingMuted) {
      try {
        await chrome.tabs.update(tabId, { muted: false });
        pendingMuted.delete(tabId);
      } catch (error) {
        addError(outcome, 'unmute', savedTab, error);
      }
    }
  }

  return finalizeRestoreOutcome(outcome);
}
