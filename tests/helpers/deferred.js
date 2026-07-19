/**
 * Create a promise whose settlement is controlled by the caller.
 *
 * The `settled` accessor is useful in lifecycle tests that must prove an
 * aborted operation finished cleaning up before another attempt can start.
 *
 * @returns {{
 *   promise: Promise<unknown>,
 *   resolve: (value?: unknown) => void,
 *   reject: (reason?: unknown) => void,
 *   readonly settled: boolean,
 * }}
 */
export function deferred() {
  let resolvePromise;
  let rejectPromise;
  let settled = false;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value) {
      settled = true;
      resolvePromise(value);
    },
    reject(reason) {
      settled = true;
      rejectPromise(reason);
    },
    get settled() {
      return settled;
    },
  };
}

// Preserve the descriptive alias used by the first Task 13 tests while also
// exposing the fixed helper name used by the lifecycle contract.
export const createDeferred = deferred;
