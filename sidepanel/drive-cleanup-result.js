// Pure formatting and validation for Drive cleanup worker responses.

function validCount(value) {
  return Number.isInteger(value) && value >= 0;
}

export function formatDriveCleanupResult(result) {
  if (
    !result ||
    typeof result !== 'object' ||
    !validCount(result.deleted) ||
    !validCount(result.keptCanonical) ||
    !validCount(result.keptNewest) ||
    !validCount(result.ignoredUndated) ||
    !Array.isArray(result.errors)
  ) {
    throw new Error('Invalid Drive cleanup result');
  }

  const protectedText = `Protected ${result.keptCanonical} canonical, ${result.keptNewest} newest, and ${result.ignoredUndated} undated files.`;
  if (result.errors.length > 0) {
    const failedText = `${result.errors.length} ${result.errors.length === 1 ? 'file' : 'files'} failed`;
    return {
      type: 'error',
      message: `Cleanup incomplete: Deleted ${result.deleted} Drive files; ${failedText}. ${protectedText}`,
    };
  }

  return {
    type: 'success',
    message: `Deleted ${result.deleted} Drive files. ${protectedText}`,
  };
}
