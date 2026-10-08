import { isSettledExceptInvalid } from '../core/restore-outcome.js';

function count(value) {
  return Number.isFinite(value) ? value : 0;
}

function plural(value, singular, pluralForm = `${singular}s`) {
  return value === 1 ? singular : pluralForm;
}

export function formatRestoreFeedback(result, { source = 'session' } = {}) {
  const requested = count(result?.requestedCount);
  const restored = count(result?.restoredCount);
  const duplicates = count(result?.skippedDuplicate);
  const invalid = count(result?.skippedInvalid);
  const failed = Array.isArray(result?.errors) ? result.errors.length : 0;

  // A saved session can hold tabs restore never reopens (internal pages saved
  // by older versions). Skipping only those is not a failure: retrying cannot
  // help. A stash keeps such entries, so it still reports them as kept.
  const settledExceptInvalid = source !== 'stash' && isSettledExceptInvalid(result);

  if (!result?.complete && !settledExceptInvalid) {
    const recovery = source === 'stash'
      ? 'Stash kept for recovery.'
      : 'Saved session remains available to retry.';
    return {
      type: 'warning',
      message: [
        `Restored ${restored} of ${requested} tabs`,
        `${duplicates} ${plural(duplicates, 'duplicate')} skipped`,
        `${invalid} invalid`,
        `${failed} failed`,
      ].join(' \u2014 ') + `. ${recovery}`,
    };
  }

  const invalidPart = `${invalid} unrestorable ${plural(invalid, 'tab')} skipped`;
  if (restored === 0) {
    return {
      type: 'info',
      message: invalid > 0
        ? `Nothing to restore \u2014 ${invalidPart}`
        : requested === 0
        ? 'No tabs to restore'
        : `All ${requested} ${plural(requested, 'tab')} already open \u2014 nothing to restore`,
    };
  }

  const parts = [`Restored ${restored} ${plural(restored, 'tab')}`];
  const windowsCreated = count(result?.windowsCreated);
  const groupsRestored = count(result?.groupsRestored);

  if (windowsCreated > 0) {
    parts[0] += ` in ${windowsCreated} ${plural(windowsCreated, 'window')}`;
  }
  if (groupsRestored > 0) {
    parts.push(`${groupsRestored} ${plural(groupsRestored, 'group')} restored`);
  }
  if (duplicates > 0) {
    parts.push(`${duplicates} ${plural(duplicates, 'duplicate')} skipped`);
  }
  if (invalid > 0) parts.push(invalidPart);

  return { type: 'success', message: parts.join(' \u2014 ') };
}

// Known platform / runtime failures mapped to wording a user can act on.
// Order matters: the first matching pattern wins.
const FRIENDLY_ERRORS = Object.freeze([
  [/could not establish connection|receiving end does not exist|message port closed|extension context invalidated/i,
    "TabKebab's background service was restarting. Try again."],
  [/user turned off browser sign-?in|not signed in|the user is not signed in/i,
    'Sign in to Chrome first (Chrome menu → Sign in), then try again.'],
  [/stash not found/i,
    'That stash no longer exists. It may already have been restored or deleted.'],
  [/session not found/i,
    'That session no longer exists. It may already have been deleted.'],
  [/no tab with id|tab not found/i,
    'That tab is already closed.'],
  [/no window with id|window not found/i,
    'That window is already closed.'],
  [/quota|QuotaExceededError/i,
    'Browser storage is full. Delete some stashes or sessions, then try again.'],
  [/failed to fetch|networkerror|network request failed/i,
    'Network unavailable. Check your connection, then try again.'],
  [/unexpected token|is not valid json|json\.parse|unexpected end of json/i,
    "That file isn't a valid TabKebab JSON export."],
]);

/**
 * Turn an Error (or message) into user-facing text. Raw Chrome / IndexedDB
 * errors that a user cannot act on are mapped to plain-language guidance;
 * messages TabKebab already authored pass through unchanged.
 */
export function friendlyErrorMessage(error, fallback = 'Something went wrong. Try again.') {
  const raw = typeof error === 'string' ? error : error?.message;
  const message = typeof raw === 'string' ? raw.trim() : '';
  if (!message) return fallback;
  for (const [pattern, friendly] of FRIENDLY_ERRORS) {
    if (pattern.test(message)) return friendly;
  }
  return message;
}
