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

export function shouldDeleteRestoredSource(outcome, removeAfterRestore) {
  return Boolean(removeAfterRestore && outcome.complete);
}
