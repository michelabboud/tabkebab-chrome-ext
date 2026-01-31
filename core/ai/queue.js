// core/ai/queue.js — Rate-limited async request queue with backoff

import { AIAuthError, AIRateLimitError } from './provider.js';

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 2000;

export class AIQueue {
  constructor({ maxConcurrent, minIntervalMs } = {}) {
    this.maxConcurrent = maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.minIntervalMs = minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.running = 0;
    this.queue = [];
    this.lastRequestTime = 0;
  }

  /**
   * Enqueue an async function for rate-limited execution.
   * @param {function(): Promise<*>} fn - The async function to execute
   * @returns {Promise<*>} Resolves with fn's return value
   */
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, retries: 0 });
      this._drain();
    });
  }

  get pending() {
    return this.queue.length;
  }

  get active() {
    return this.running;
  }

  async _drain() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;

    const item = this.queue.shift();
    this.running++;

    try {
      // Enforce minimum interval between requests
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < this.minIntervalMs) {
        await this._delay(this.minIntervalMs - elapsed);
      }

      this.lastRequestTime = Date.now();
      const result = await item.fn();
      item.resolve(result);
    } catch (err) {
      if (err instanceof AIAuthError) {
        // Auth errors are not retryable
        item.reject(err);
      } else if (err instanceof AIRateLimitError && item.retries < MAX_RETRIES) {
        // Rate limit: exponential backoff and re-queue
        item.retries++;
        const delay = BACKOFF_BASE_MS * Math.pow(2, item.retries - 1);
        await this._delay(delay);
        this.queue.unshift(item); // Re-queue at front
      } else if (item.retries < MAX_RETRIES && !(err instanceof AIAuthError)) {
        // Network/other errors: retry
        item.retries++;
        const delay = BACKOFF_BASE_MS * item.retries;
        await this._delay(delay);
        this.queue.unshift(item);
      } else {
        item.reject(err);
      }
    } finally {
      this.running--;
      // Continue draining
      if (this.queue.length > 0) {
        this._drain();
      }
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
