// core/state-mutation-lock.js — worker-local FIFO serialization for portable state

let mutationTail = Promise.resolve();

/**
 * Run one portable-state mutation after every previously queued mutation.
 * The returned promise preserves the operation's value or rejection while the
 * internal tail absorbs rejection solely so later work can continue.
 */
export function withStateMutationLock(operation) {
  if (typeof operation !== 'function') {
    return Promise.reject(new TypeError('State mutation operation must be a function'));
  }

  const result = mutationTail.then(operation);
  mutationTail = result.catch(() => undefined);
  return result;
}
