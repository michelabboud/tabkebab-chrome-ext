// core/ai/cache.js — LRU response cache in chrome.storage.local

const CACHE_KEY = 'aiCache';
const MAX_ENTRIES = 200;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// FNV-1a 32-bit hash for fast cache key generation
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export const AICache = {
  /**
   * Generate a cache key from request parameters.
   */
  makeCacheKey(providerId, model, systemPrompt, userPrompt) {
    return fnv1a(`${providerId}|${model}|${systemPrompt}|${userPrompt}`);
  },

  /**
   * Get a cached response if it exists and hasn't expired.
   * @param {string} cacheKey
   * @returns {Promise<Object|null>} The cached AIResponse or null
   */
  async get(cacheKey) {
    const cache = await this._load();
    const entry = cache[cacheKey];
    if (!entry) return null;

    if (Date.now() - entry.timestamp > TTL_MS) {
      delete cache[cacheKey];
      await this._save(cache);
      return null;
    }

    // Update access time for LRU
    entry.accessedAt = Date.now();
    await this._save(cache);
    return entry.response;
  },

  /**
   * Store a response in the cache.
   * @param {string} cacheKey
   * @param {Object} response - The AIResponse to cache
   */
  async set(cacheKey, response) {
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
  },

  /**
   * Clear the entire cache.
   */
  async clear() {
    await chrome.storage.local.remove(CACHE_KEY);
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
