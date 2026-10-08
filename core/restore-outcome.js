export function createRestoreOutcome(requestedCount) {
  return {
    requestedCount,
    restoredCount: 0,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    errors: [],
    complete: false,
  };
}

export function finalizeRestoreOutcome(outcome) {
  outcome.complete =
    outcome.skippedInvalid === 0 &&
    outcome.errors.length === 0 &&
    outcome.restoredCount + outcome.skippedDuplicate === outcome.requestedCount;
  return outcome;
}

/**
 * True when a restore settled every tab and its only shortfall is entries
 * restore can never reopen (skippedInvalid, no errors). `complete` stays false
 * so a stash keeps those entries, but retrying cannot improve the outcome, so
 * callers must not treat it as a failure.
 */
export function isSettledExceptInvalid(outcome) {
  if (!outcome || !Array.isArray(outcome.errors) || outcome.errors.length > 0) return false;
  const restored = Number(outcome.restoredCount) || 0;
  const duplicate = Number(outcome.skippedDuplicate) || 0;
  const invalid = Number(outcome.skippedInvalid) || 0;
  return invalid > 0 && restored + duplicate + invalid === outcome.requestedCount;
}

export function shouldDeleteRestoredSource(outcome, removeAfterRestore) {
  return Boolean(removeAfterRestore && outcome.complete);
}
