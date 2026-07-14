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

  if (!result?.complete) {
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

  if (restored === 0) {
    return {
      type: 'info',
      message: requested === 0
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

  return { type: 'success', message: parts.join(' \u2014 ') };
}
