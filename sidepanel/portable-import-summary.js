const COUNT_KEYS = Object.freeze([
  'sessions',
  'stashes',
  'manualGroups',
  'bookmarks',
  'focusHistory',
]);

function sumCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid import summary');
  }
  let total = 0;
  for (const key of COUNT_KEYS) {
    const count = value[key];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('Invalid import summary');
    }
    total += count;
  }
  return total;
}

export function formatPortableImportSummary(result, label = 'Import') {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('Invalid import summary');
  }
  const imported = sumCounts(result.imported);
  const skipped = sumCounts(result.skipped);
  const recordLabel = imported === 1 ? 'record' : 'records';
  const duplicateLabel = skipped === 1 ? 'duplicate' : 'duplicates';
  const summary = `${label} complete — ${imported} new ${recordLabel}, ${skipped} ${duplicateLabel} skipped`;
  if (!Object.hasOwn(result, 'warning')) return summary;
  if (result.committed !== true || typeof result.warning !== 'string' || result.warning.length === 0) {
    throw new TypeError('Invalid import warning');
  }
  return `${summary}. Warning: ${result.warning}`;
}

export function portableImportToastType(result) {
  return result?.warning ? 'error' : 'success';
}
