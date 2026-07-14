// core/focus.js — Focus engine: state machine, timer, badge, distraction detection, history

import { Storage } from './storage.js';
import { getAllTabs, closeTabs, extractDomain, createNativeGroup, ungroupTabs } from './tabs-api.js';
import { saveStash, restoreStashTabs, getStash } from './stash-db.js';
import { getProfileById, getAllProfiles } from './focus-profiles.js';
import {
  evaluateFocusPolicy,
  isAllowed,
  isInternalUrl,
  rebindFocusAllowlist,
  resolveGroupAllowlist,
} from './focus-policy.js';
import { isConfidentDistraction } from './focus-ai.js';

const FOCUS_STATE_KEY = 'focusState';
const FOCUS_HISTORY_KEY = 'focusHistory';
const FOCUS_GROUP_OWNERSHIP_KEY = 'focusGroupOwnership';
const MAX_HISTORY = 50;

export const FocusStatus = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
  ENDING: 'ending',
});

// Module-level cache for fast sync access
let _cachedState = null;
let _runtimeGroupBindingsVerified = false;
let _runtimeGroupBindingWritesPending = 0;
let _lifecycleQueue = Promise.resolve();
const _endFlights = new Map();
let _focusStateMutationQueue = Promise.resolve();
let _badgeWriteQueue = Promise.resolve();
let _focusStateGeneration = 0;

function isRuntimeFocusState(state) {
  return state?.status === FocusStatus.ACTIVE || state?.status === FocusStatus.PAUSED;
}

function hasRunId(state) {
  return typeof state?.runId === 'string' && state.runId.length > 0;
}

function failureMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createDistinctRunId(excludedRunIds = []) {
  const excluded = new Set(excludedRunIds.filter(
    (runId) => typeof runId === 'string' && runId.length > 0,
  ));
  for (let attempt = 0; attempt < 8; attempt++) {
    const runId = crypto.randomUUID();
    if (typeof runId === 'string' && runId.length > 0 && !excluded.has(runId)) {
      return runId;
    }
  }
  throw new Error('Unable to create a distinct Focus run ID.');
}

async function getMatchingFocusState(runId, statuses = null) {
  if (typeof runId !== 'string' || runId.length === 0) return null;
  const state = await getFocusState();
  if (!state || state.runId !== runId) return null;
  if (statuses && !statuses.includes(state.status)) return null;
  return state;
}

function cacheFocusState(state) {
  const canExposeRuntimeGroups =
    _runtimeGroupBindingsVerified && _runtimeGroupBindingWritesPending === 0;
  _cachedState = isRuntimeFocusState(state) && !canExposeRuntimeGroups
    ? rebindFocusAllowlist(state, [])
    : state;
  return _cachedState;
}

// Initialize cache from storage
const cacheReady = (async () => {
  const storedState = await Storage.get(FOCUS_STATE_KEY);
  cacheFocusState(storedState);
})();

// Keep cache in sync with storage changes
Storage.onChange((changes) => {
  if (changes[FOCUS_STATE_KEY]) {
    _focusStateGeneration++;
    cacheFocusState(changes[FOCUS_STATE_KEY].newValue ?? null);
  }
});

export function getCachedFocusState() {
  return _cachedState;
}

export function getCachedFocusAuthority() {
  return { state: _cachedState, generation: _focusStateGeneration };
}

export async function getFocusState() {
  await cacheReady;
  const state = await Storage.get(FOCUS_STATE_KEY);
  return cacheFocusState(state);
}

function withFocusStateMutation(operation) {
  const pending = _focusStateMutationQueue.then(operation, operation);
  _focusStateMutationQueue = pending.catch(() => {});
  return pending;
}

function withLifecycleOperation(operation) {
  const pending = _lifecycleQueue.then(operation, operation);
  _lifecycleQueue = pending.catch(() => {});
  return pending;
}

async function writeFocusStateUnlocked(state, {
  groupBindingsVerified = _runtimeGroupBindingsVerified,
} = {}) {
  const verifiesRuntimeGroups = Boolean(groupBindingsVerified) && isRuntimeFocusState(state);
  const stateToPersist = isRuntimeFocusState(state) && !verifiesRuntimeGroups
    ? rebindFocusAllowlist(state, [])
    : state;

  // A live lookup is not durable authority until the matching storage write
  // succeeds. Keep every concurrent read fail-closed while persistence is in flight.
  _runtimeGroupBindingWritesPending++;
  cacheFocusState(stateToPersist);
  try {
    if (stateToPersist) {
      await Storage.set(FOCUS_STATE_KEY, stateToPersist);
    } else {
      await Storage.remove(FOCUS_STATE_KEY);
    }
    // storage.onChanged is the cross-context signal, but Chrome does not
    // guarantee that its listener has run before the storage Promise settles.
    // Advance locally as well so every completed durable mutation invalidates
    // validators synchronously; a later onChanged increment is harmless.
    _focusStateGeneration++;
  } catch (error) {
    _runtimeGroupBindingsVerified = false;
    _runtimeGroupBindingWritesPending--;
    cacheFocusState(stateToPersist);
    throw error;
  }

  _runtimeGroupBindingsVerified = verifiesRuntimeGroups;
  _runtimeGroupBindingWritesPending--;
  cacheFocusState(stateToPersist);
  return stateToPersist;
}

async function saveFocusState(state, options = {}) {
  await cacheReady;
  return withFocusStateMutation(() => writeFocusStateUnlocked(state, options));
}

async function mutateFocusState({
  runId,
  statuses,
  groupBindingsVerified = _runtimeGroupBindingsVerified,
}, transform) {
  await cacheReady;
  return withFocusStateMutation(async () => {
    const current = cacheFocusState(await Storage.get(FOCUS_STATE_KEY));
    if (!current || current.runId !== runId || !statuses.includes(current.status)) {
      return null;
    }
    const next = transform(current);
    if (!next) return null;
    await writeFocusStateUnlocked(next, { groupBindingsVerified });
    return next;
  });
}

async function removeFocusStateIfEnding(runId) {
  await cacheReady;
  return withFocusStateMutation(async () => {
    const current = cacheFocusState(await Storage.get(FOCUS_STATE_KEY));
    if (current?.runId !== runId || current.status !== FocusStatus.ENDING) return false;
    await writeFocusStateUnlocked(null);
    return true;
  });
}

async function markTeardownStepCompleted(runId, step) {
  await cacheReady;
  return withFocusStateMutation(async () => {
    const current = cacheFocusState(await Storage.get(FOCUS_STATE_KEY));
    if (current?.runId !== runId || current.status !== FocusStatus.ENDING) return null;
    if (current.teardownCompleted?.[step]) return current;

    const checkpointed = {
      ...current,
      teardownCompleted: {
        ...(current.teardownCompleted || {}),
        [step]: true,
      },
    };
    await writeFocusStateUnlocked(checkpointed);
    return checkpointed;
  });
}

function mergeTeardownFailures(...failureLists) {
  const merged = [];
  const seen = new Set();
  for (const failure of failureLists.flat()) {
    if (!failure || typeof failure.step !== 'string' || typeof failure.message !== 'string') {
      continue;
    }
    const key = `${failure.step}\u0000${failure.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ step: failure.step, message: failure.message });
  }
  return merged;
}

async function persistFocusHistoryRecord(record) {
  const history = (await Storage.get(FOCUS_HISTORY_KEY)) || [];
  const index = history.findIndex((entry) => entry?.runId === record.runId);
  if (index >= 0) {
    const existing = history[index];
    const merged = {
      ...existing,
      ...record,
      id: existing.id || record.id,
      teardownFailures: mergeTeardownFailures(
        existing.teardownFailures || [],
        record.teardownFailures || [],
      ),
    };
    history[index] = merged;
    Object.assign(record, merged);
  } else {
    record.teardownFailures = mergeTeardownFailures(record.teardownFailures || []);
    history.unshift({ ...record });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  }
  await Storage.set(FOCUS_HISTORY_KEY, history);
  return record;
}

async function getFocusGroupOwnership() {
  const stored = await chrome.storage.session.get(FOCUS_GROUP_OWNERSHIP_KEY);
  return stored[FOCUS_GROUP_OWNERSHIP_KEY] ?? null;
}

function createFocusGroupOwnershipToken(runId) {
  return `focus-group:${runId}`;
}

async function setFocusGroupOwnership(runId, token, groupId = null) {
  await chrome.storage.session.set({
    [FOCUS_GROUP_OWNERSHIP_KEY]: { runId, token, groupId },
  });
}

async function clearFocusGroupOwnership(runId, token) {
  const ownership = await getFocusGroupOwnership();
  if (ownership?.runId === runId && ownership.token === token) {
    await chrome.storage.session.remove(FOCUS_GROUP_OWNERSHIP_KEY);
  }
}

function flattenErrors(error) {
  return error instanceof AggregateError ? [...error.errors] : [error];
}

async function clearFocusGroupOwnershipWithRetry(runId, token) {
  const failures = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await clearFocusGroupOwnership(runId, token);
      return failures;
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function rejectAfterFocusGroupRollback(primaryError, {
  runId,
  token,
  tabIds,
}) {
  const errors = flattenErrors(primaryError);
  try {
    await ungroupTabs(tabIds);
  } catch (error) {
    errors.push(error);
  } finally {
    const cleanupFailures = await clearFocusGroupOwnershipWithRetry(runId, token);
    errors.push(...cleanupFailures);
  }

  if (errors.length === 1 && errors[0] === primaryError) throw primaryError;
  throw new AggregateError(errors, 'Focus group startup and rollback failed.');
}

async function findFocusGroupMutationTabIds(focusTabs) {
  const originalGroupIds = new Map(focusTabs.map((tab) => [tab.id, tab.groupId]));
  const settled = await Promise.allSettled(
    focusTabs.map((tab) => chrome.tabs.get(tab.id)),
  );
  const failures = settled
    .filter(({ status }) => status === 'rejected')
    .map(({ reason }) => reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Could not inspect a partially created Focus group.');
  }
  return settled
    .map(({ value }) => value)
    .filter((tab) => tab.groupId !== originalGroupIds.get(tab.id))
    .map((tab) => tab.id);
}

function clearFailedFocusStartCache() {
  _runtimeGroupBindingsVerified = false;
  _focusStateGeneration++;
  cacheFocusState(null);
}

// ── Timer helpers ──

export function getRemainingMs(state) {
  if (!state || state.status !== FocusStatus.ACTIVE) return 0;
  if (state.duration === 0) return Infinity; // open-ended
  const totalMs = state.duration * 60 * 1000;
  const elapsed = Date.now() - state.startedAt - state.pausedElapsed;
  return Math.max(0, totalMs - elapsed);
}

export function getElapsedMs(state) {
  if (!state) return 0;
  if (state.status === FocusStatus.ENDING && Number.isFinite(state.actualDurationMs)) {
    return state.actualDurationMs;
  }
  if (state.status === FocusStatus.PAUSED) {
    return state.pausedAt - state.startedAt - state.pausedElapsed;
  }
  if (state.status === FocusStatus.ENDING && Number.isFinite(state.pausedAt)) {
    return state.pausedAt - state.startedAt - state.pausedElapsed;
  }
  const stoppedAt = state.status === FocusStatus.ENDING && Number.isFinite(state.endedAt)
    ? state.endedAt
    : Date.now();
  return stoppedAt - state.startedAt - state.pausedElapsed;
}

export function formatTimeRemaining(ms) {
  if (ms === Infinity) return '--:--';
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBadgeTime(ms) {
  if (ms === Infinity) return '';
  const totalMin = Math.max(0, Math.ceil(ms / 60000));
  if (totalMin >= 60) return `${Math.floor(totalMin / 60)}h`;
  return `${totalMin}m`;
}

// ── Allowlist matching ──

/**
 * Check if a tab/URL should be blocked based on current focus state.
 * Blocking modes (in order of priority):
 * 1. Allowed entries always pass (domains, URLs, groups)
 * 2. Explicit blocked domains always block
 * 3. Strict mode: block everything not in allowed list
 * 4. Curated categories: block if in enabled category
 * 5. AI mode: ask AI to categorize (async, handled separately)
 *
 * @param {string|Object} tabOrUrl - URL string or tab object
 * @param {Object} state - Focus state object
 * @returns {{ blocked: boolean, reason: string|null, category: string|null }}
 */
export function isBlockedDomain(tabOrUrl, state) {
  return evaluateFocusPolicy(tabOrUrl, state);
}

/**
 * Legacy compatibility wrapper - returns boolean
 */
export function isBlockedDomainSimple(url, state) {
  return isBlockedDomain(url, state).blocked;
}

export function isFocusTab(tab, state) {
  if (isInternalUrl(tab)) return true;
  if (!state?.strictMode && (!state?.allowedDomains || state.allowedDomains.length === 0)) {
    return true;
  }
  return isAllowed(tab, state?.allowedDomains);
}

// ── Badge ──

function withBadgeWrite(operation) {
  const pending = _badgeWriteQueue.then(operation, operation);
  _badgeWriteQueue = pending.catch(() => {});
  return pending;
}

function getBadgePresentation(state, { distractionRunId = null } = {}) {
  if (state?.status === FocusStatus.ACTIVE &&
      distractionRunId && state.runId === distractionRunId) {
    return { text: '!', color: '#ef4444', runId: state.runId, distraction: true };
  }
  if (state?.status === FocusStatus.PAUSED) {
    return { text: '||', color: '#f59e0b', runId: state.runId, distraction: false };
  }
  if (state?.status === FocusStatus.ACTIVE) {
    return {
      text: formatBadgeTime(getRemainingMs(state)),
      color: '#2563eb',
      runId: state.runId,
      distraction: false,
    };
  }
  return { text: '', color: null, runId: null, distraction: false };
}

async function reconcileBadgeUnlocked({ expectedRunId = null, distraction = false } = {}) {
  await cacheReady;

  // Chrome action writes are separate awaits. If Focus authority changes during
  // either one, repaint from the latest durable state before releasing the queue.
  while (true) {
    const state = cacheFocusState(await Storage.get(FOCUS_STATE_KEY));
    const generation = _focusStateGeneration;
    const presentation = getBadgePresentation(state, {
      distractionRunId: distraction ? expectedRunId : null,
    });

    await chrome.action.setBadgeText({ text: presentation.text });
    if (generation !== _focusStateGeneration) continue;

    if (presentation.color) {
      await chrome.action.setBadgeBackgroundColor({ color: presentation.color });
      if (generation !== _focusStateGeneration) continue;
    }

    return {
      ...presentation,
      expectedRunIsCurrent: !expectedRunId || presentation.runId === expectedRunId,
    };
  }
}

export async function updateBadge(state, expectedRunId = state?.runId ?? null) {
  const result = await withBadgeWrite(() => reconcileBadgeUnlocked({ expectedRunId }));
  return result.expectedRunIsCurrent;
}

export async function flashBadgeDistraction(runId) {
  const result = await withBadgeWrite(() => reconcileBadgeUnlocked({
    expectedRunId: runId,
    distraction: true,
  }));
  if (!result.expectedRunIsCurrent || !result.distraction) return false;
  setTimeout(async () => {
    await updateBadge(null, runId);
  }, 2000);
  return true;
}

// ── Start focus ──

export function startFocus(options, adapters = {}) {
  return withLifecycleOperation(() => performStartFocus(options, adapters));
}

async function performStartFocus({
  profileId,
  duration,
  tabAction,
  allowedDomains,
  blockedDomains,
  strictMode,
  blockedCategories,
  aiBlocking,
}, {
  saveStash: persistStash = saveStash,
} = {}) {
  let runId = createDistinctRunId();
  const existingState = await Storage.get(FOCUS_STATE_KEY);
  if (runId === existingState?.runId) {
    runId = createDistinctRunId([existingState.runId]);
  }
  if (existingState) {
    if (hasRunId(existingState)) {
      await performEndFocus(existingState.runId);
    } else {
      const cleanupRunId = createDistinctRunId([runId]);
      await performEndFocus(null, {}, cleanupRunId);
    }

    const remainingState = await Storage.get(FOCUS_STATE_KEY);
    if (remainingState) {
      throw new Error('The previous Focus run could not be fully closed.');
    }
  }

  const profile = getProfileById(profileId);
  const profileName = profile?.name || profileId;
  const profileColor = profile?.color || 'blue';

  const state = {
    status: FocusStatus.ACTIVE,
    runId,
    startedAt: Date.now(),
    duration: duration || 0,
    pausedAt: null,
    pausedElapsed: 0,
    profileId,
    profileName,
    profileColor,
    tabAction: tabAction || 'none',
    allowedDomains: allowedDomains || [],
    blockedDomains: blockedDomains || [],
    // New blocking modes
    strictMode: strictMode || false,
    blockedCategories: blockedCategories || [],
    aiBlocking: aiBlocking || false,
    stashId: null,
    focusGroupId: null,
    focusGroupOwnershipToken: null,
    distractionsBlocked: 0,
    focusTabCount: 0,
  };

  // Resolve group titles before reading or mutating tabs. A failed query must
  // leave both browser tabs and persisted Focus state untouched.
  const liveGroups = await chrome.tabGroups.query({});
  state.allowedDomains = resolveGroupAllowlist(state.allowedDomains, liveGroups);

  const allTabs = await getAllTabs({ allWindows: true });
  const eligibleTabs = allTabs.filter((tab) => !isInternalUrl(tab));
  const focusTabs = eligibleTabs.filter((tab) => isFocusTab(tab, state));
  const nonFocusTabs = eligibleTabs.filter((tab) => !isFocusTab(tab, state) && !tab.active);
  state.focusTabCount = focusTabs.length;

  // Apply tab action
  let createdFocusGroup = null;
  if (tabAction === 'kebab' && nonFocusTabs.length > 0) {
    for (const tab of nonFocusTabs) {
      if (tab.discarded) continue;
      try { await chrome.tabs.discard(tab.id); } catch { /* tab may be active */ }
    }
  } else if (tabAction === 'stash' && nonFocusTabs.length > 0) {
    const stashTabs = nonFocusTabs.map(t => ({
      url: t.pendingUrl || t.url,
      title: t.title,
      favIconUrl: t.favIconUrl,
      pinned: t.pinned || false,
    }));
    const stashId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const stash = {
      id: stashId,
      name: `[Focus] ${profileName} session`,
      source: 'domain',
      sourceDetail: 'focus-mode',
      createdAt: Date.now(),
      tabCount: stashTabs.length,
      windows: [{ tabCount: stashTabs.length, tabs: stashTabs }],
    };
    await persistStash(stash);
    state.stashId = stashId;
    const closableIds = nonFocusTabs.map(t => t.id);
    if (closableIds.length > 0) await closeTabs(closableIds);
  } else if (tabAction === 'group' && focusTabs.length > 0) {
    const focusTabIds = focusTabs.map(t => t.id);
    const profileColor = profile?.color || 'blue';
    const chromeColor = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'].includes(profileColor)
      ? profileColor : 'blue';
    const ownershipToken = createFocusGroupOwnershipToken(runId);
    // Prove this browser session owns the prospective group before asking
    // Chrome to mutate tabs. Browser restart clears this provisional marker.
    await setFocusGroupOwnership(runId, ownershipToken);

    let groupId = null;
    try {
      groupId = await createNativeGroup(focusTabIds, profileName, chromeColor);
    } catch (groupError) {
      let mutationTabIds;
      try {
        mutationTabIds = await findFocusGroupMutationTabIds(focusTabs);
      } catch (inspectionError) {
        await rejectAfterFocusGroupRollback(
          new AggregateError(
            [...flattenErrors(groupError), ...flattenErrors(inspectionError)],
            'Focus group creation and mutation inspection failed.',
          ),
          { runId, token: ownershipToken, tabIds: focusTabIds },
        );
      }

      if (mutationTabIds.length > 0) {
        await rejectAfterFocusGroupRollback(groupError, {
          runId,
          token: ownershipToken,
          tabIds: mutationTabIds,
        });
      }

      const cleanupFailures = await clearFocusGroupOwnershipWithRetry(runId, ownershipToken);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [groupError, ...cleanupFailures],
          'Focus group creation and ownership cleanup failed.',
        );
      }
      // A pre-group Chrome failure made no tab mutation; startup can continue.
    }

    if (Number.isInteger(groupId) && groupId >= 0) {
      try {
        await setFocusGroupOwnership(runId, ownershipToken, groupId);
      } catch (ownershipError) {
        // The provisional proof is not enough to authorize future teardown.
        // Roll back the just-created group before allowing startup to fail.
        await rejectAfterFocusGroupRollback(ownershipError, {
          runId,
          token: ownershipToken,
          tabIds: focusTabIds,
        });
      }
      state.focusGroupId = groupId;
      state.focusGroupOwnershipToken = ownershipToken;
      createdFocusGroup = { tabIds: focusTabIds, token: ownershipToken };
    }
  }

  // Persist authority before any run-owned alarm or badge work.
  try {
    await saveFocusState(state, { groupBindingsVerified: true });
  } catch (authorityError) {
    clearFailedFocusStartCache();
    if (createdFocusGroup) {
      await rejectAfterFocusGroupRollback(authorityError, {
        runId,
        token: createdFocusGroup.token,
        tabIds: createdFocusGroup.tabIds,
      });
    }
    throw authorityError;
  }

  await chrome.alarms.create('focusTick', { periodInMinutes: 1 });
  await updateBadge(state, runId);

  const authoritative = await getMatchingFocusState(runId, [FocusStatus.ACTIVE]);
  if (!authoritative) {
    throw new Error('Focus run lost authority during startup.');
  }
  return authoritative;
}

// ── End focus ──

export function endFocus(options = {}) {
  const expectedRunId = typeof options === 'string'
    ? options
    : options?.expectedRunId ?? null;
  const adapters = typeof options === 'object' && options?.adapters
    ? options.adapters
    : {};
  const legacyCleanupRunId = typeof options === 'object'
    ? options?.legacyCleanupRunId ?? null
    : null;

  const flightKey = expectedRunId
    ? `run:${expectedRunId}`
    : legacyCleanupRunId
      ? `legacy:${legacyCleanupRunId}`
      : 'current';
  const existingFlight = _endFlights.get(flightKey);
  if (existingFlight) return existingFlight;

  const promise = withLifecycleOperation(() =>
    performEndFocus(expectedRunId, adapters, legacyCleanupRunId));
  _endFlights.set(flightKey, promise);
  promise.finally(() => {
    if (_endFlights.get(flightKey) === promise) _endFlights.delete(flightKey);
  }).catch(() => {});
  return promise;
}

async function performEndFocus(expectedRunId, {
  getStash: loadStash = getStash,
  restoreStashTabs: restoreTabs = restoreStashTabs,
  ungroupTabs: ungroup = ungroupTabs,
} = {}, legacyCleanupRunId = null) {
  await cacheReady;
  const state = await withFocusStateMutation(async () => {
    const current = cacheFocusState(await Storage.get(FOCUS_STATE_KEY));
    if (!current) return null;
    if (expectedRunId && current.runId !== expectedRunId) return null;
    if (![FocusStatus.ACTIVE, FocusStatus.PAUSED, FocusStatus.ENDING].includes(current.status)) {
      return null;
    }

    let runId = current.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      runId = legacyCleanupRunId || crypto.randomUUID();
      if (typeof runId !== 'string' || runId.length === 0) {
        throw new Error('Unable to create a legacy Focus cleanup ID.');
      }
    }

    if (current.status === FocusStatus.ENDING && Number.isFinite(current.endedAt) &&
        current.runId === runId) {
      return current;
    }

    const endedAt = Number.isFinite(current.endedAt) ? current.endedAt : Date.now();
    const ending = {
      ...current,
      status: FocusStatus.ENDING,
      runId,
      endedAt,
      // Compute this while paused status still carries the pause boundary.
      actualDurationMs: getElapsedMs(current),
    };
    // This write is the terminal transition. Do not begin teardown if it fails.
    await writeFocusStateUnlocked(ending);
    return ending;
  });
  if (!state) return null;
  const runId = state.runId;

  let teardownFailures = [];
  const captureFailure = (step, error) => {
    teardownFailures.push({ step, message: failureMessage(error) });
  };

  let restoreRetryPending = false;
  if (state.stashId && !state.teardownCompleted?.restore) {
    let restoreCanCheckpoint = false;
    try {
      const stash = await loadStash(state.stashId);
      if (stash) {
        const outcome = await restoreTabs(stash, { mode: 'here' });
        if (outcome && outcome.complete === false) {
          restoreRetryPending = true;
          captureFailure('restore', new Error(
            `Focus stash restore was incomplete (${outcome.restoredCount ?? 0}/${outcome.requestedCount ?? 0}).`,
          ));
        } else {
          restoreCanCheckpoint = true;
        }
      } else {
        restoreCanCheckpoint = true;
      }
    } catch (error) {
      captureFailure('restore', error);
    }

    if (restoreCanCheckpoint) {
      try {
        await markTeardownStepCompleted(runId, 'restore');
      } catch (error) {
        captureFailure('restore-checkpoint', error);
      }
    }
  }

  if (Number.isInteger(state.focusGroupId) && state.focusGroupId >= 0 &&
      !state.teardownCompleted?.ungroup) {
    try {
      const ownership = await getFocusGroupOwnership();
      if (typeof state.focusGroupOwnershipToken !== 'string' ||
          state.focusGroupOwnershipToken.length === 0 ||
          ownership?.runId !== runId ||
          ownership.token !== state.focusGroupOwnershipToken ||
          ownership.groupId !== state.focusGroupId) {
        captureFailure('ungroup-ownership', new Error(
          'Focus group ownership could not be verified.',
        ));
      } else {
        const groupTabs = await chrome.tabs.query({ groupId: state.focusGroupId });
        if (groupTabs.length > 0) {
          await ungroup(groupTabs.map((tab) => tab.id));
        }
        await markTeardownStepCompleted(runId, 'ungroup');
        await clearFocusGroupOwnership(runId, state.focusGroupOwnershipToken);
      }
    } catch (error) {
      captureFailure('ungroup', error);
    }
  }

  try {
    await chrome.alarms.clear('focusTick');
  } catch (error) {
    captureFailure('alarm', error);
  }
  try {
    await updateBadge(state, runId);
  } catch (error) {
    captureFailure('badge', error);
  }

  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    runId,
    profileId: state.profileId,
    profileName: state.profileName,
    profileColor: state.profileColor,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    plannedDuration: state.duration,
    actualDurationMs: Number.isFinite(state.actualDurationMs)
      ? state.actualDurationMs
      : getElapsedMs(state),
    distractionsBlocked: state.distractionsBlocked,
    focusTabCount: state.focusTabCount,
    tabAction: state.tabAction,
    teardownFailures: mergeTeardownFailures(teardownFailures),
  };

  let persistedFailureSignature = null;
  try {
    await persistFocusHistoryRecord(record);
    teardownFailures = record.teardownFailures;
    persistedFailureSignature = JSON.stringify(teardownFailures);
  } catch (error) {
    captureFailure('history', error);
  }

  // State removal is deliberately last and conditional: a stale teardown must
  // never remove a replacement run. Incomplete restore keeps the non-blocking
  // ending journal so a later call or worker restart can retry missing tabs.
  if (!restoreRetryPending) {
    try {
      await removeFocusStateIfEnding(runId);
    } catch (error) {
      captureFailure('state', error);
    }
  }

  record.teardownFailures = mergeTeardownFailures(record.teardownFailures, teardownFailures);
  if (JSON.stringify(record.teardownFailures) !== persistedFailureSignature) {
    try {
      await persistFocusHistoryRecord(record);
      teardownFailures = record.teardownFailures;
    } catch (error) {
      captureFailure('history', error);
      record.teardownFailures = mergeTeardownFailures(record.teardownFailures, teardownFailures);
    }
  }

  record.teardownFailures = mergeTeardownFailures(record.teardownFailures, teardownFailures);
  if (teardownFailures.length > 0) {
    console.warn('[TabKebab] Focus teardown completed with failures:', teardownFailures);
  }
  return record;
}

// ── Pause / Resume ──

export async function pauseFocus(expectedRunId = null) {
  const state = await getFocusState();
  if (!state || state.status !== FocusStatus.ACTIVE || !hasRunId(state)) return null;
  if (expectedRunId && state.runId !== expectedRunId) return null;
  const runId = state.runId;
  const paused = await mutateFocusState({
    runId,
    statuses: [FocusStatus.ACTIVE],
  }, (current) => ({
    ...current,
    status: FocusStatus.PAUSED,
    pausedAt: Date.now(),
  }));
  if (!paused) return null;
  // Paused authority is durable before any badge await.
  if (!await getMatchingFocusState(runId, [FocusStatus.PAUSED])) return null;
  if (!await updateBadge(paused, runId)) return null;
  return getMatchingFocusState(runId, [FocusStatus.PAUSED]);
}

export async function rebindStoredFocusState() {
  await cacheReady;
  _runtimeGroupBindingsVerified = false;
  const state = cacheFocusState(await Storage.get(FOCUS_STATE_KEY));
  if (!isRuntimeFocusState(state)) {
    return state;
  }
  const runId = state.runId;

  // Never expose persisted runtime IDs while the current Chrome group query is pending.
  let liveGroups;
  try {
    liveGroups = await chrome.tabGroups.query({});
  } catch (error) {
    // Preserve the title preference and run metadata, but remove numeric authority
    // that cannot be validated in this browser session.
    await mutateFocusState({
      runId,
      statuses: [state.status],
      groupBindingsVerified: false,
    }, (current) => current);
    throw error;
  }
  return mutateFocusState({
    runId,
    statuses: [state.status],
    groupBindingsVerified: true,
  }, (current) => rebindFocusAllowlist(current, liveGroups));
}

export async function resumeFocus(expectedRunId = null) {
  const state = await getFocusState();
  if (!state || state.status !== FocusStatus.PAUSED || !hasRunId(state)) return null;
  if (expectedRunId && state.runId !== expectedRunId) return null;
  const runId = state.runId;
  const liveGroups = await chrome.tabGroups.query({});
  const rebound = await mutateFocusState({
    runId,
    statuses: [FocusStatus.PAUSED],
    groupBindingsVerified: true,
  }, (current) => {
    const next = rebindFocusAllowlist(current, liveGroups);
    const pauseDuration = Date.now() - next.pausedAt;
    return {
      ...next,
      pausedElapsed: next.pausedElapsed + pauseDuration,
      pausedAt: null,
      status: FocusStatus.ACTIVE,
    };
  });
  if (!rebound) return null;
  if (!await getMatchingFocusState(runId, [FocusStatus.ACTIVE])) return null;
  if (!await updateBadge(rebound, runId)) return null;
  return getMatchingFocusState(runId, [FocusStatus.ACTIVE]);
}

// ── Extend ──

export async function extendFocus(minutes, expectedRunId = null) {
  const state = await getFocusState();
  if (!isRuntimeFocusState(state) || !hasRunId(state)) return null;
  if (expectedRunId && state.runId !== expectedRunId) return null;
  const extended = await mutateFocusState({
    runId: state.runId,
    statuses: [state.status],
  }, (current) => ({ ...current, duration: current.duration + minutes }));
  if (!extended) return null;
  if (!await getMatchingFocusState(state.runId, [state.status])) return null;
  if (!await updateBadge(extended, state.runId)) return null;
  return getMatchingFocusState(state.runId, [state.status]);
}

// ── Distraction handling ──

export async function validateDistractionTarget({
  runId,
  expectedGeneration = null,
  tabId,
  classifiedUrl,
  decision,
}) {
  // This order is intentional: stored authority, live tab, exact URL identity,
  // then the untrusted decision predicate.
  const generationBeforeRead = _focusStateGeneration;
  const state = await Storage.get(FOCUS_STATE_KEY);
  const authorityGeneration = _focusStateGeneration;
  if (authorityGeneration !== generationBeforeRead) return null;
  if (state?.status !== FocusStatus.ACTIVE || !hasRunId(state) || state.runId !== runId) {
    return null;
  }
  if (Number.isInteger(expectedGeneration) && expectedGeneration !== authorityGeneration) {
    return null;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return null;
  }

  // tabs.get() is the final await. A durable Focus transition while it was
  // pending invalidates even an active->paused->active ABA cycle.
  if (_focusStateGeneration !== authorityGeneration) return null;

  const currentMatches = tab.url === classifiedUrl;
  const pendingMatches = typeof tab.pendingUrl === 'string' &&
    tab.pendingUrl.length > 0 && tab.pendingUrl === classifiedUrl;
  if (!currentMatches && !pendingMatches) return null;
  if (!isConfidentDistraction(decision)) return null;
  return { state, tab };
}

export async function handleDistraction({
  runId,
  expectedGeneration = null,
  tabId,
  classifiedUrl,
  decision,
  category,
}) {
  const target = await validateDistractionTarget({
    runId,
    expectedGeneration,
    tabId,
    classifiedUrl,
    decision,
  });
  if (!target) return null;

  const windowId = target.tab.windowId;
  let navigationApplied = false;
  try {
    // validateDistractionTarget was the immediately preceding await.
    await chrome.tabs.goBack(tabId);
    navigationApplied = true;
  } catch {
    const fallbackTarget = await validateDistractionTarget({
      runId,
      expectedGeneration,
      tabId,
      classifiedUrl,
      decision,
    });
    if (!fallbackTarget) return null;
    try {
      // The second live validation is immediately before destructive fallback.
      await chrome.tabs.remove(tabId);
      navigationApplied = true;
    } catch {
      return null;
    }
  }
  if (!navigationApplied) return null;

  if (windowId && await getMatchingFocusState(runId, [FocusStatus.ACTIVE])) {
    try {
      await chrome.sidePanel.open({ windowId });
    } catch {
      // Side-panel availability must not undo an already-applied navigation block.
    }
  }

  let state = await mutateFocusState({
    runId,
    statuses: [FocusStatus.ACTIVE],
  }, (current) => ({
    ...current,
    distractionsBlocked: (Number(current.distractionsBlocked) || 0) + 1,
  }));
  if (!state) return null;

  state = await getMatchingFocusState(runId, [FocusStatus.ACTIVE]);
  if (!state) return null;
  await flashBadgeDistraction(runId);

  state = await getMatchingFocusState(runId, [FocusStatus.ACTIVE]);
  if (!state) return null;
  const domain = extractDomain(classifiedUrl);
  await chrome.runtime.sendMessage({
    type: 'focusDistraction',
    runId,
    domain,
    category,
    count: state.distractionsBlocked,
    openFocusView: true,
    blink: true,
  }).catch(() => {});
  return state;
}

// ── Tick (called by alarm) ──

export async function handleFocusTick(expectedRunId = null) {
  const state = await getFocusState();
  if (!state || state.status !== FocusStatus.ACTIVE || !hasRunId(state)) return null;
  const runId = state.runId;
  if (expectedRunId && expectedRunId !== runId) return null;

  // Check if timer expired
  if (state.duration > 0) {
    const remaining = getRemainingMs(state);
    if (remaining <= 0) {
      // Timer expired — end session
      if (!await getMatchingFocusState(runId, [FocusStatus.ACTIVE])) return null;
      const record = await endFocus({ expectedRunId: runId });
      if (!record) return null;
      const replacement = await Storage.get(FOCUS_STATE_KEY);
      if (replacement && replacement.runId !== runId) return record;
      await chrome.runtime.sendMessage({
        type: 'focusEnded',
        runId,
        record,
      }).catch(() => {});
      return record;
    }
  }

  const latest = await getMatchingFocusState(runId, [FocusStatus.ACTIVE]);
  if (!latest) return null;
  await updateBadge(latest, runId);
  return latest;
}

// ── History ──

export async function getFocusHistory() {
  return (await Storage.get(FOCUS_HISTORY_KEY)) || [];
}

// ── Profiles (re-export for service worker convenience) ──

export { getAllProfiles, getProfileById };
