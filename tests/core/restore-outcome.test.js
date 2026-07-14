import { describe, expect, test } from 'bun:test';

import {
  createRestoreOutcome,
  finalizeRestoreOutcome,
  shouldDeleteRestoredSource,
} from '../../core/restore-outcome.js';

describe('restore outcomes', () => {
  test('zero requested tabs is a complete restore', () => {
    const outcome = finalizeRestoreOutcome(createRestoreOutcome(0));

    expect(outcome).toEqual({
      requestedCount: 0,
      restoredCount: 0,
      skippedDuplicate: 0,
      skippedInvalid: 0,
      errors: [],
      complete: true,
    });
  });

  test('all requested tabs restored is complete', () => {
    const outcome = createRestoreOutcome(2);
    outcome.restoredCount = 2;

    expect(finalizeRestoreOutcome(outcome).complete).toBe(true);
  });

  test('restored tabs plus known duplicates is complete', () => {
    const outcome = createRestoreOutcome(3);
    outcome.restoredCount = 2;
    outcome.skippedDuplicate = 1;

    expect(finalizeRestoreOutcome(outcome).complete).toBe(true);
  });

  test('an invalid saved URL makes the restore incomplete', () => {
    const outcome = createRestoreOutcome(1);
    outcome.skippedInvalid = 1;

    expect(finalizeRestoreOutcome(outcome).complete).toBe(false);
  });

  test('a creation error makes the restore incomplete', () => {
    const outcome = createRestoreOutcome(1);
    outcome.errors.push({
      scope: 'create',
      url: 'https://failed.test/',
      message: 'creation failed',
    });

    expect(finalizeRestoreOutcome(outcome).complete).toBe(false);
  });

  test('source deletion requires both opt-in and a complete outcome', () => {
    expect(shouldDeleteRestoredSource({ complete: true }, true)).toBe(true);
    expect(shouldDeleteRestoredSource({ complete: true }, false)).toBe(false);
    expect(shouldDeleteRestoredSource({ complete: false }, true)).toBe(false);
    expect(shouldDeleteRestoredSource({ complete: false }, false)).toBe(false);
  });
});
