import { describe, expect, test } from 'bun:test';

let importNonce = 0;

async function loadFocusAi() {
  return import(`../../core/focus-ai.js?focus-ai=${++importNonce}`);
}

function context(overrides = {}) {
  return {
    runId: 'run-a',
    focusGeneration: 17,
    tabId: 9,
    classifiedUrl: 'https://classified.test/path',
    cacheKey: 'classified.test',
    category: null,
    request: { userPrompt: 'Classify classified.test' },
    ...overrides,
  };
}

describe('Focus AI confidence policy', () => {
  const cases = [
    [{ distraction: true, confidence: 0.700001 }, true],
    [{ distraction: true, confidence: 1 }, true],
    [{ distraction: true, confidence: 0.7 }, false],
    [{ distraction: true, confidence: 0 }, false],
    [{ distraction: false, confidence: 1 }, false],
    [{ distraction: true, confidence: '0.9' }, false],
    [{ distraction: true, confidence: Number.NaN }, false],
    [{ distraction: true, confidence: Infinity }, false],
    [{ distraction: true, confidence: -Infinity }, false],
    [{ distraction: true }, false],
    [null, false],
  ];

  for (const [decision, expected] of cases) {
    test(`${JSON.stringify(decision)} => ${expected}`, async () => {
      const { FOCUS_AI_CONFIDENCE_THRESHOLD, isConfidentDistraction } = await loadFocusAi();

      expect(FOCUS_AI_CONFIDENCE_THRESHOLD).toBe(0.7);
      expect(isConfidentDistraction(decision)).toBe(expected);
    });
  }
});

describe('createFocusAiChecker', () => {
  test('captures the request object before delayed classification begins', async () => {
    const { createFocusAiChecker } = await loadFocusAi();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const requests = [];
    const request = {
      userPrompt: 'original request',
      responseFormat: { type: 'json' },
    };
    const check = createFocusAiChecker({
      aiClient: {
        async complete(value) {
          requests.push(value);
          await gate;
          return { parsed: { distraction: false, confidence: 1 } };
        },
      },
      onDistraction: async () => {},
      cache: new Map(),
      scheduleExpiry: () => {},
      ttlMs: 5000,
    });

    const pending = check(context({ request }));
    request.userPrompt = 'mutated request';
    request.responseFormat.type = 'text';
    release();
    await pending;

    expect(requests).toEqual([{
      userPrompt: 'original request',
      responseFormat: { type: 'json' },
    }]);
  });

  test('a low-confidence cached decision never delegates or calls the AI client', async () => {
    const { createFocusAiChecker } = await loadFocusAi();
    const cache = new Map([['classified.test', { distraction: true, confidence: 0.7 }]]);
    const delegated = [];
    let completions = 0;
    const check = createFocusAiChecker({
      aiClient: { complete: async () => { completions++; } },
      onDistraction: async (value) => delegated.push(value),
      cache,
      scheduleExpiry: () => { throw new Error('cached reads must not reschedule expiry'); },
      ttlMs: 5000,
    });

    expect(await check(context())).toEqual({ distraction: true, confidence: 0.7 });
    expect(completions).toBe(0);
    expect(delegated).toEqual([]);
  });

  test('a high-confidence cached decision delegates immutable captured context and the full decision', async () => {
    const { createFocusAiChecker } = await loadFocusAi();
    const decision = {
      distraction: true,
      confidence: 0.91,
      category: 'social media',
      explanation: 'synthetic test decision',
    };
    const delegated = [];
    const check = createFocusAiChecker({
      aiClient: { complete: async () => { throw new Error('cache miss'); } },
      onDistraction: async (value) => delegated.push(value),
      cache: new Map([['classified.test', decision]]),
      scheduleExpiry: () => {},
      ttlMs: 5000,
    });
    const mutable = context();
    const pending = check(mutable);
    mutable.runId = 'replacement';
    mutable.classifiedUrl = 'https://changed.test/';

    expect(await pending).toEqual(decision);
    expect(delegated).toEqual([{
      runId: 'run-a',
      expectedGeneration: 17,
      tabId: 9,
      classifiedUrl: 'https://classified.test/path',
      decision,
      category: 'social media',
    }]);
  });

  test('fresh and cached malformed or low decisions use the same predicate', async () => {
    const { createFocusAiChecker } = await loadFocusAi();
    for (const decision of [
      { distraction: true, confidence: 0.7 },
      { distraction: true, confidence: '0.99' },
      { distraction: false, confidence: 1 },
    ]) {
      const freshDelegated = [];
      const freshCache = new Map();
      const fresh = createFocusAiChecker({
        aiClient: { complete: async () => ({ parsed: decision }) },
        onDistraction: async (value) => freshDelegated.push(value),
        cache: freshCache,
        scheduleExpiry: () => {},
        ttlMs: 5000,
      });
      const cachedDelegated = [];
      const cached = createFocusAiChecker({
        aiClient: { complete: async () => { throw new Error('cache miss'); } },
        onDistraction: async (value) => cachedDelegated.push(value),
        cache: new Map([['classified.test', decision]]),
        scheduleExpiry: () => {},
        ttlMs: 5000,
      });

      expect(await fresh(context())).toEqual(decision);
      expect(await cached(context())).toEqual(decision);
      expect(freshDelegated).toEqual([]);
      expect(cachedDelegated).toEqual([]);
    }
  });

  test('a fresh confident result is cached, scheduled, and delegated with captured authority', async () => {
    const { createFocusAiChecker } = await loadFocusAi();
    const cache = new Map();
    const timers = [];
    const delegated = [];
    const decision = { distraction: true, confidence: 0.88, category: 'shopping' };
    const request = { userPrompt: 'fresh request' };
    const aiClient = {
      requests: [],
      async complete(value) {
        this.requests.push(value);
        return { parsed: decision };
      },
    };
    const check = createFocusAiChecker({
      aiClient,
      onDistraction: async (value) => delegated.push(value),
      cache,
      scheduleExpiry: (callback, delay) => timers.push({ callback, delay }),
      ttlMs: 3210,
    });

    expect(await check(context({ request }))).toEqual(decision);
    expect(aiClient.requests).toEqual([request]);
    expect(cache.get('classified.test')).toEqual(decision);
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(3210);
    expect(delegated).toEqual([{
      runId: 'run-a',
      expectedGeneration: 17,
      tabId: 9,
      classifiedUrl: 'https://classified.test/path',
      decision,
      category: 'shopping',
    }]);

    timers[0].callback();
    expect(cache.has('classified.test')).toBe(false);
  });

  test('an old expiry timer cannot delete a newer cache entry for the same key', async () => {
    const { createFocusAiChecker } = await loadFocusAi();
    const decisions = [
      { distraction: false, confidence: 0.99, category: 'first' },
      { distraction: true, confidence: 0.99, category: 'second' },
    ];
    const cache = new Map();
    const timers = [];
    const check = createFocusAiChecker({
      aiClient: { complete: async () => ({ parsed: decisions.shift() }) },
      onDistraction: async () => {},
      cache,
      scheduleExpiry: (callback) => timers.push(callback),
      ttlMs: 5000,
    });

    const first = await check(context());
    cache.delete('classified.test');
    const second = await check(context());
    expect(timers).toHaveLength(2);
    expect(cache.get('classified.test')).toBe(second);

    timers[0]();
    expect(cache.get('classified.test')).toBe(second);
    expect(cache.get('classified.test')).not.toBe(first);

    timers[1]();
    expect(cache.has('classified.test')).toBe(false);
  });

  test('expiry identity is generation-safe even when a replacement reuses the same decision object', async () => {
    const { createFocusAiChecker } = await loadFocusAi();
    const decision = { distraction: false, confidence: 1, category: 'productive' };
    const cache = new Map();
    const timers = [];
    const check = createFocusAiChecker({
      aiClient: { complete: async () => ({ parsed: decision }) },
      onDistraction: async () => {},
      cache,
      scheduleExpiry: (callback) => timers.push(callback),
      ttlMs: 5000,
    });

    await check(context());
    cache.delete('classified.test');
    await check(context());
    expect(timers).toHaveLength(2);

    timers[0]();
    expect(cache.get('classified.test')).toBe(decision);

    timers[1]();
    expect(cache.has('classified.test')).toBe(false);
  });
});
