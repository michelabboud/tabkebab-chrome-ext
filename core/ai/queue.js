// core/ai/queue.js — Rate-limited async request queue with bounded retry

import { AINetworkError, AIRateLimitError } from './provider.js';

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 2000;

function defaultBackoff(error, retryNumber) {
  if (error instanceof AIRateLimitError) {
    const retryAfterMs = Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0
      ? error.retryAfterMs
      : BACKOFF_BASE_MS;
    return retryAfterMs * Math.pow(2, retryNumber - 1);
  }
  return BACKOFF_BASE_MS * retryNumber;
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error) {
  return error instanceof AINetworkError || error instanceof AIRateLimitError;
}

export class AIQueue {
  /**
   * @param {{
   *   maxConcurrent?: number,
   *   minIntervalMs?: number,
   *   maxRetries?: number,
   *   backoff?: (error: Error, retryNumber: number) => number,
   *   clock?: () => number,
   *   delay?: (ms: number) => Promise<void>,
   * }} [options]
   */
  constructor({
    maxConcurrent,
    minIntervalMs,
    maxRetries = DEFAULT_MAX_RETRIES,
    backoff = defaultBackoff,
    clock = Date.now,
    delay = defaultDelay,
  } = {}) {
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError('maxRetries must be a non-negative integer');
    }
    if (typeof backoff !== 'function') {
      throw new TypeError('backoff must be a function');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function');
    }
    if (typeof delay !== 'function') {
      throw new TypeError('delay must be a function');
    }
    this.maxConcurrent = maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.minIntervalMs = minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxRetries = maxRetries;
    this.backoff = backoff;
    this.clock = clock;
    this.delay = delay;
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
      const now = this.clock();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < this.minIntervalMs) {
        await this._delay(this.minIntervalMs - elapsed);
      }

      this.lastRequestTime = this.clock();
      const result = await item.fn();
      item.resolve(result);
    } catch (err) {
      if (!isRetryable(err) || item.retries >= this.maxRetries) {
        item.reject(err);
      } else {
        item.retries++;
        try {
          const waitMs = this.backoff(err, item.retries);
          if (!Number.isFinite(waitMs) || waitMs < 0) {
            throw new RangeError('backoff must return a non-negative finite delay');
          }
          await this._delay(waitMs);
          this.queue.unshift(item);
        } catch (retryError) {
          item.reject(retryError);
        }
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
    return this.delay(ms);
  }
}
