// core/ai/cache.js — LRU response cache in chrome.storage.local

const CACHE_KEY = 'aiCache';
const MAX_ENTRIES = 200;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// LRU recency only needs coarse resolution. Persisting a touch at most this
// often keeps cache hits from rewriting the whole cache object every time.
const TOUCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Every read-modify-write of the cache object runs on this chain so that
// concurrent get/set/clear calls cannot overwrite each other's results.
let mutationChain = Promise.resolve();

function withCacheLock(operation) {
  const run = mutationChain.then(operation, operation);
  mutationChain = run.catch(() => {});
  return run;
}

const textEncoder = new TextEncoder();

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export const AICache = {
  /**
   * Generate a cache key from request parameters.
   */
  async makeCacheKey(providerId, model, systemPrompt, userPrompt, requestScope = null) {
    return sha256(JSON.stringify([
      'tabkebab-ai-response-v2',
      providerId,
      model,
      systemPrompt,
      userPrompt,
      requestScope,
    ]));
  },

  /**
   * Get a cached response if it exists and hasn't expired.
   * @param {string} cacheKey
   * @returns {Promise<Object|null>} The cached AIResponse or null
   */
  async get(cacheKey) {
    return withCacheLock(async () => {
      const cache = await this._load();
      const entry = cache[cacheKey];
      if (!entry) return null;

      const now = Date.now();
      if (now - entry.timestamp > TTL_MS) {
        delete cache[cacheKey];
        await this._save(cache);
        return null;
      }

      // Update access time for LRU, but only persist coarse-grained touches.
      if (now - (entry.accessedAt || entry.timestamp) >= TOUCH_INTERVAL_MS) {
        entry.accessedAt = now;
        await this._save(cache);
      }
      return entry.response;
    });
  },

  /**
   * Store a response in the cache.
   * @param {string} cacheKey
   * @param {Object} response - The AIResponse to cache
   */
  async set(cacheKey, response) {
    return withCacheLock(async () => {
      const cache = await this._load();

      cache[cacheKey] = {
        response,
        timestamp: Date.now(),
        accessedAt: Date.now(),
      };

      // Evict oldest entries if over limit
      const keys = Object.keys(cache);
      if (keys.length > MAX_ENTRIES) {
        const sorted = keys.sort((a, b) => {
          return (cache[a].accessedAt || cache[a].timestamp) -
                 (cache[b].accessedAt || cache[b].timestamp);
        });
        const toRemove = sorted.slice(0, keys.length - MAX_ENTRIES);
        for (const k of toRemove) {
          delete cache[k];
        }
      }

      await this._save(cache);
    });
  },

  /**
   * Clear the entire cache.
   */
  async clear() {
    return withCacheLock(() => chrome.storage.local.remove(CACHE_KEY));
  },

  /**
   * Get the number of cached entries.
   */
  async size() {
    const cache = await this._load();
    return Object.keys(cache).length;
  },

  async _load() {
    const result = await chrome.storage.local.get(CACHE_KEY);
    return result[CACHE_KEY] || {};
  },

  async _save(cache) {
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  },
};
