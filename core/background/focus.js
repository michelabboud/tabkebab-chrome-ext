// core/background/focus.js — Focus mode worker glue: the startup readiness
// barrier, alarm ticks, tab-navigation interception (policy + AI check), and
// Focus message actions.

import { FocusStatus, getCachedFocusAuthority, getCachedFocusState, getFocusState, handleDistraction, handleFocusTick, startFocus, endFocus, pauseFocus, resumeFocus, extendFocus, getFocusHistory, getAllProfiles, rebindStoredFocusState } from '../focus.js';
import { evaluateFocusPolicy, isAllowed } from '../focus-policy.js';
import { createFocusAiChecker } from '../focus-ai.js';
import { AIClient } from '../ai/ai-client.js';
import { extractDomain } from '../tabs-api.js';
import { Storage } from '../storage.js';
import { createPortableExportDocument } from '../export-schema.js';
import { withStateMutationLock } from '../state-mutation-lock.js';
import { requireExactRuntimeFields, requireRuntimeString } from './router.js';

/**
 * Rebind persisted group titles before any Focus listener can trust runtime
 * IDs. The worker calls this once at startup; listeners still register
 * synchronously, then await this shared startup barrier.
 */
export function startFocusReadiness() {
  return (async () => {
    let state = await rebindStoredFocusState();
    if (state?.status === FocusStatus.ENDING && state.runId) {
      await withStateMutationLock(() => endFocus({ expectedRunId: state.runId }));
      state = await getFocusState();
    }
    return state;
  })().catch((error) => {
    console.warn('[TabKebab] Focus group rebinding failed or ending recovery was incomplete during worker startup:', error);
    return getCachedFocusState();
  });
}

/** Run one Focus tick (alarm) behind the startup barrier and the state lock. */
export function scheduleFocusTick(focusReadiness) {
  const expectedRunId = getCachedFocusState()?.runId ?? null;
  void focusReadiness
    .then((startupState) => withStateMutationLock(() =>
      handleFocusTick(expectedRunId ?? startupState?.runId ?? null)))
    .catch((error) => console.warn('[TabKebab] Focus tick failed:', error));
}

/**
 * Per-worker Focus tab guard: intercepts new tabs and navigations to blocked
 * URLs while a Focus run is active. Holds its own AI classification cache.
 */
export function createFocusTabGuard({ focusReadiness }) {
  // AI-based domain categorization for focus mode
  const aiCheckCache = new Map(); // Cache AI results to avoid repeated calls
  const checkFocusWithAI = createFocusAiChecker({
    aiClient: AIClient,
    onDistraction: handleDistraction,
    cache: aiCheckCache,
    scheduleExpiry: setTimeout,
    ttlMs: 60 * 60 * 1000,
  });
  const checkWithAI = (request) => checkDomainWithAI(checkFocusWithAI, request);

  async function onTabCreated(tab) {
    // Focus mode: intercept new tabs opened to blocked URLs
    if (tab.pendingUrl || tab.url) {
      const url = tab.pendingUrl || tab.url;
      await focusReadiness;
      const { state, generation: focusGeneration } = getCachedFocusAuthority();
      if (state?.status === FocusStatus.ACTIVE && typeof state.runId === 'string' && state.runId) {
        // Pass full tab object to check group membership
        const tabWithUrl = { ...tab, url };
        const result = evaluateFocusPolicy(tabWithUrl, state);
        if (result.blocked) {
          await handleDistraction({
            runId: state.runId,
            expectedGeneration: focusGeneration,
            tabId: tab.id,
            classifiedUrl: url,
            decision: { distraction: true, confidence: 1 },
            category: result.category,
          });
        } else if (state.aiBlocking && !isAllowed(tabWithUrl, state.allowedDomains)) {
          // Try AI categorization for unknown domains
          await checkWithAI({
            runId: state.runId,
            focusGeneration,
            tabId: tab.id,
            classifiedUrl: url,
            profileName: state.profileName,
          });
        }
      }
    }
  }

  async function onTabUpdated(tabId, changeInfo, tab) {
    // Focus mode: intercept navigation to blocked domains
    if (changeInfo.url) {
      await focusReadiness;
      const { state, generation: focusGeneration } = getCachedFocusAuthority();
      if (state?.status === FocusStatus.ACTIVE && typeof state.runId === 'string' && state.runId) {
        // changeInfo.url is the navigation that triggered this event. Do not let
        // a stale tab.pendingUrl override that authoritative event URL.
        const tabWithUrl = { ...tab, pendingUrl: '', url: changeInfo.url };
        const result = evaluateFocusPolicy(tabWithUrl, state);
        if (result.blocked) {
          await handleDistraction({
            runId: state.runId,
            expectedGeneration: focusGeneration,
            tabId,
            classifiedUrl: changeInfo.url,
            decision: { distraction: true, confidence: 1 },
            category: result.category,
          });
        } else if (state.aiBlocking && !isAllowed(tabWithUrl, state.allowedDomains)) {
          // Try AI categorization for unknown domains
          await checkWithAI({
            runId: state.runId,
            focusGeneration,
            tabId,
            classifiedUrl: changeInfo.url,
            profileName: state.profileName,
          });
        }
      }
    }
  }

  return { onTabCreated, onTabUpdated };
}

async function checkDomainWithAI(checkFocusWithAI, { runId, focusGeneration, tabId, classifiedUrl, profileName }) {
  try {
    const available = await AIClient.isAvailable();
    if (!available) return;

    const hostname = extractDomain(classifiedUrl);
    if (!hostname || hostname === 'other') return;

    return await checkFocusWithAI({
      runId,
      focusGeneration,
      tabId,
      classifiedUrl,
      cacheKey: hostname,
      category: 'AI detected',
      request: {
        systemPrompt: `You are a productivity assistant. Categorize websites as either productive or distracting.
Distracting categories: social media, gaming, video streaming, entertainment, news, shopping.
Productive categories: work tools, documentation, education, development, communication (work).
Respond with JSON only: {"distraction": true/false, "category": "category name", "confidence": 0.0-1.0}`,
        userPrompt: `Is "${hostname}" a distracting website? The user is in focus mode for: ${profileName}`,
        maxTokens: 512,
        responseFormat: 'json',
        temperature: 0.1,
      },
    });
  } catch (err) {
    console.warn('[TabKebab] AI check failed:', err.message);
  }
}

// ── Focus profile preferences ──

export function normalizeFocusProfilePrefs(profilePrefs) {
  return createPortableExportDocument('full', {
    sessions: [],
    stashes: [],
    manualGroups: {},
    keepAwakeDomains: [],
    bookmarks: [],
    settings: {},
    focusProfilePrefs: profilePrefs,
    focusHistory: [],
    aiSettings: { enabled: false, providerId: 'chrome', providerConfigs: {} },
  }, '1970-01-01T00:00:00.000Z').focusProfilePrefs;
}

export async function saveFocusProfilePrefsUnlocked(profileId, preferences) {
  const current = (await Storage.get('focusProfilePrefs')) || {};
  const normalized = normalizeFocusProfilePrefs({
    ...current,
    [profileId]: preferences,
  });
  await Storage.set('focusProfilePrefs', normalized);
  return { saved: true };
}

// ── Message handlers ──

export const focusHandlers = {
  async getFocusState() {
    return getFocusState();
  },

  async startFocus(msg, ctx) {
    await ctx.focusReadiness;
    return withStateMutationLock(() => startFocus(msg));
  },

  async endFocus(msg, ctx) {
    await ctx.focusReadiness;
    if (typeof msg.expectedRunId !== 'string' || msg.expectedRunId.length === 0) return null;
    return withStateMutationLock(() => endFocus({ expectedRunId: msg.expectedRunId }));
  },

  async pauseFocus(msg, ctx) {
    await ctx.focusReadiness;
    if (typeof msg.expectedRunId !== 'string' || msg.expectedRunId.length === 0) return null;
    return withStateMutationLock(() => pauseFocus(msg.expectedRunId));
  },

  async resumeFocus(msg, ctx) {
    await ctx.focusReadiness;
    if (typeof msg.expectedRunId !== 'string' || msg.expectedRunId.length === 0) return null;
    return withStateMutationLock(() => resumeFocus(msg.expectedRunId));
  },

  async extendFocus(msg, ctx) {
    await ctx.focusReadiness;
    if (typeof msg.expectedRunId !== 'string' || msg.expectedRunId.length === 0) return null;
    return withStateMutationLock(() => extendFocus(msg.minutes || 5, msg.expectedRunId));
  },

  async getFocusHistory() {
    return getFocusHistory();
  },

  async getFocusProfiles() {
    return getAllProfiles();
  },

  async saveFocusProfilePrefs(msg, ctx) {
    const { saveFocusProfilePrefs: saveFocusProfilePrefsOperation = saveFocusProfilePrefsUnlocked } = ctx;
    requireExactRuntimeFields(
      msg,
      ['action', 'profileId', 'preferences'],
      'Focus preferences request',
    );
    const profileId = requireRuntimeString(msg.profileId, 'Focus profile ID');
    return withStateMutationLock(() => {
      const normalized = normalizeFocusProfilePrefs({ [profileId]: msg.preferences });
      return saveFocusProfilePrefsOperation(profileId, normalized[profileId]);
    });
  },
};
