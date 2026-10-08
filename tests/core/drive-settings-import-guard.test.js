import { describe, expect, test } from 'bun:test';
import { preserveDriveRetentionGuards, SETTINGS_DEFAULTS } from '../../core/settings.js';

describe('preserveDriveRetentionGuards', () => {
  test('keeps neverDeleteFromDrive on when it is on locally', () => {
    const next = preserveDriveRetentionGuards(
      { neverDeleteFromDrive: true, driveRetentionDays: 30 },
      { neverDeleteFromDrive: false, driveRetentionDays: 30 },
    );
    expect(next.neverDeleteFromDrive).toBe(true);
  });

  test('never shortens driveRetentionDays', () => {
    const next = preserveDriveRetentionGuards(
      { driveRetentionDays: 60 },
      { driveRetentionDays: 1 },
    );
    expect(next.driveRetentionDays).toBe(60);
  });

  test('allows imports that make retention safer', () => {
    const next = preserveDriveRetentionGuards(
      { neverDeleteFromDrive: false, driveRetentionDays: 30 },
      { neverDeleteFromDrive: true, driveRetentionDays: 90, theme: 'dark' },
    );
    expect(next).toEqual({ neverDeleteFromDrive: true, driveRetentionDays: 90, theme: 'dark' });
  });

  test('falls back to the default floor when local value is missing', () => {
    const next = preserveDriveRetentionGuards({}, { driveRetentionDays: 2 });
    expect(next.driveRetentionDays).toBe(SETTINGS_DEFAULTS.driveRetentionDays);
  });
});
