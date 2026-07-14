// core/focus-ai.js — Provider-agnostic Focus classification and cache boundary

export const FOCUS_AI_CONFIDENCE_THRESHOLD = 0.7;

export function isConfidentDistraction(decision) {
  return decision?.distraction === true &&
    Number.isFinite(decision.confidence) &&
    decision.confidence > FOCUS_AI_CONFIDENCE_THRESHOLD;
}

function captureRequest(request) {
  if (!request || typeof request !== 'object') return request;
  return structuredClone(request);
}

/**
 * Build a Focus AI checker that owns classification caching, but never owns
 * browser mutation authority. The captured run, tab, and URL are forwarded to
 * onDistraction, whose live guard decides whether a side effect is still valid.
 */
export function createFocusAiChecker({
  aiClient,
  onDistraction,
  cache,
  scheduleExpiry,
  ttlMs,
}) {
  if (!aiClient || typeof aiClient.complete !== 'function') {
    throw new TypeError('Focus AI checker requires an aiClient.complete function');
  }
  if (typeof onDistraction !== 'function') {
    throw new TypeError('Focus AI checker requires an onDistraction function');
  }
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') {
    throw new TypeError('Focus AI checker requires a Map-like cache');
  }
  if (typeof scheduleExpiry !== 'function') {
    throw new TypeError('Focus AI checker requires an expiry scheduler');
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError('Focus AI checker requires a non-negative finite ttlMs');
  }
  const expiryGenerations = new Map();

  return async function checkFocusWithAi(input = {}) {
    const captured = Object.freeze({
      runId: input.runId,
      tabId: input.tabId,
      classifiedUrl: input.classifiedUrl,
      cacheKey: input.cacheKey ?? input.classifiedUrl,
      category: input.category ?? null,
      request: captureRequest(input.request),
    });

    let decision = cache.get(captured.cacheKey);
    if (decision === undefined) {
      const response = await aiClient.complete(captured.request);
      decision = response?.parsed ?? null;
      cache.set(captured.cacheKey, decision);
      const scheduledEntry = decision;
      const generation = {};
      expiryGenerations.set(captured.cacheKey, generation);
      scheduleExpiry(() => {
        if (expiryGenerations.get(captured.cacheKey) === generation &&
            cache.get(captured.cacheKey) === scheduledEntry) {
          cache.delete(captured.cacheKey);
          expiryGenerations.delete(captured.cacheKey);
        }
      }, ttlMs);
    }

    if (isConfidentDistraction(decision)) {
      await onDistraction({
        runId: captured.runId,
        tabId: captured.tabId,
        classifiedUrl: captured.classifiedUrl,
        decision,
        category: decision.category || captured.category,
      });
    }

    return decision;
  };
}
