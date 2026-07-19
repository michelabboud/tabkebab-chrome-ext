/**
 * Build a deterministic provider double from per-attempt behaviors.
 *
 * Each behavior is awaited exactly like a real provider call. The counters and
 * event log expose queue-level attempt ordering without replacing queue logic.
 *
 * @param {Array<(context: { attemptNumber: number }) => Promise<unknown> | unknown>} behaviors
 * @param {{ events?: string[] }} [options]
 * @returns {{
 *   complete: () => Promise<unknown>,
 *   readonly attemptCount: number,
 *   readonly activeCount: number,
 *   readonly maxActiveCount: number,
 *   events: string[],
 * }}
 */
export function createProviderDouble(behaviors, { events = [] } = {}) {
  if (!Array.isArray(behaviors) || behaviors.length === 0 ||
      behaviors.some((behavior) => typeof behavior !== 'function')) {
    throw new TypeError('Provider behaviors must be a non-empty array of functions');
  }

  let attemptCount = 0;
  let activeCount = 0;
  let maxActiveCount = 0;

  return {
    async complete() {
      const attemptNumber = ++attemptCount;
      const behavior = behaviors[attemptNumber - 1];
      if (!behavior) {
        throw new Error(`Unexpected provider attempt ${attemptNumber}`);
      }

      activeCount++;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      events.push(`attempt${attemptNumber}-started`);
      try {
        return await behavior({ attemptNumber });
      } finally {
        activeCount--;
        events.push(`attempt${attemptNumber}-settled`);
      }
    },
    get attemptCount() {
      return attemptCount;
    },
    get activeCount() {
      return activeCount;
    },
    get maxActiveCount() {
      return maxActiveCount;
    },
    events,
  };
}
