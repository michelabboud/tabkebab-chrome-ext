// record-format.js — Shared display formatting for stash and session records.

// Older builds stored stash names with a trailing tab count, e.g.
// "www.amazon.com (2 tabs)". The card's metadata line already shows the
// count, so it is dropped from display.
const LEGACY_COUNT_SUFFIX = /\s*\(\d+ tabs?\)\s*$/;

/** Stash name for display, without the legacy "(N tabs)" suffix. */
export function displayStashName(name) {
  const text = typeof name === 'string' ? name : '';
  const stripped = text.replace(LEGACY_COUNT_SUFFIX, '');
  return stripped || text || 'Untitled stash';
}

/**
 * Compact record timestamp: "Oct 8, 14:05" this year, "Oct 8, 2025, 14:05"
 * otherwise. Uses the browser locale unless one is given (tests).
 */
export function formatRecordDate(value, { now = new Date(), locale } = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const options = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return date.toLocaleString(locale, options);
}

/** Default name for a session saved with an empty name field. */
export function defaultSessionName(date = new Date(), { locale } = {}) {
  const day = date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return `Session — ${day}, ${time}`;
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
