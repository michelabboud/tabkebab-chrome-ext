import { describe, expect, test } from 'bun:test';

import { formatRestoreFeedback } from '../../sidepanel/restore-feedback.js';

describe('restore feedback', () => {
  test('an incomplete stash restore warns with every outcome count and recovery status', () => {
    expect(formatRestoreFeedback({
      requestedCount: 5,
      restoredCount: 2,
      skippedDuplicate: 1,
      skippedInvalid: 1,
      errors: [{ scope: 'create', url: 'https://failed.test/', message: 'failed' }],
      complete: false,
      windowsCreated: 0,
      groupsRestored: 0,
    }, { source: 'stash' })).toEqual({
      type: 'warning',
      message: 'Restored 2 of 5 tabs — 1 duplicate skipped — 1 invalid — 1 failed. Stash kept for recovery.',
    });
  });

  test('an incomplete session restore warns that the saved session remains recoverable', () => {
    expect(formatRestoreFeedback({
      requestedCount: 3,
      restoredCount: 1,
      skippedDuplicate: 0,
      skippedInvalid: 2,
      errors: [],
      complete: false,
      windowsCreated: 0,
      groupsRestored: 0,
    }, { source: 'session' })).toEqual({
      type: 'warning',
      message: 'Restored 1 of 3 tabs — 0 duplicates skipped — 2 invalid — 0 failed. Saved session remains available to retry.',
    });
  });

  test('a complete restore retains the success details without a removal claim', () => {
    expect(formatRestoreFeedback({
      requestedCount: 3,
      restoredCount: 2,
      skippedDuplicate: 1,
      skippedInvalid: 0,
      errors: [],
      complete: true,
      windowsCreated: 1,
      groupsRestored: 1,
    }, { source: 'stash' })).toEqual({
      type: 'success',
      message: 'Restored 2 tabs in 1 window — 1 group restored — 1 duplicate skipped',
    });
  });

  test('complete duplicate-only and empty outcomes remain informational', () => {
    expect(formatRestoreFeedback({
      requestedCount: 2,
      restoredCount: 0,
      skippedDuplicate: 2,
      skippedInvalid: 0,
      errors: [],
      complete: true,
    })).toEqual({
      type: 'info',
      message: 'All 2 tabs already open — nothing to restore',
    });

    expect(formatRestoreFeedback({
      requestedCount: 0,
      restoredCount: 0,
      skippedDuplicate: 0,
      skippedInvalid: 0,
      errors: [],
      complete: true,
    })).toEqual({
      type: 'info',
      message: 'No tabs to restore',
    });
  });
});
