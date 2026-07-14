const FOCUS_EVENT_TYPES = new Set(['focusDistraction', 'focusEnded']);

export function createFocusRunCommand(action, state, details = {}) {
  const expectedRunId = typeof state?.runId === 'string' && state.runId.length > 0
    ? state.runId
    : null;
  return { action, ...details, expectedRunId };
}

export function focusMessageMatchesState(message, state) {
  const runMatches = typeof message?.runId === 'string' &&
    message.runId.length > 0 &&
    typeof state?.runId === 'string' &&
    state.runId.length > 0 &&
    message.runId === state.runId;
  if (!runMatches) return false;

  if (message.type === 'focusDistraction') return state.status === 'active';
  if (message.type === 'focusEnded') {
    return state.status === 'active' || state.status === 'paused' || state.status === 'ending';
  }
  return false;
}

export function handleFocusPanelMessage(message, focusPanel) {
  if (!focusMessageMatchesState(message, focusPanel?.state)) return false;

  if (message.type === 'focusDistraction') {
    focusPanel._flashDistraction(message.domain, message.count);
    return true;
  }
  if (message.type === 'focusEnded') {
    focusPanel.state = null;
    focusPanel._showReport(message.record);
    return true;
  }
  return false;
}

export async function routePanelFocusMessage(message, focusPanel, {
  loadFocusState,
  updateFocusBtnState,
  showFocusView,
  blink,
} = {}) {
  if (!FOCUS_EVENT_TYPES.has(message?.type)) {
    return false;
  }

  const localState = focusPanel?.state;
  if (loadFocusState) {
    const durableState = await loadFocusState();

    if (message.type === 'focusDistraction') {
      focusPanel.state = durableState;
      if (!focusMessageMatchesState(message, durableState)) return false;
    } else if (durableState) {
      focusPanel.state = durableState;
      if (durableState.runId !== message.runId || durableState.status !== 'ending') {
        return false;
      }
    } else {
      // focusEnded is emitted after successful state removal. Keep the displayed
      // runtime run long enough for the component to show its matching report.
      focusPanel.state = localState;
    }
  }
  if (!focusMessageMatchesState(message, focusPanel?.state)) return false;

  // Capture and validate authority before the component handles focusEnded and
  // clears its local state. Every global side effect belongs to that same run.
  focusPanel.handleFocusMessage(message);
  updateFocusBtnState?.();

  if (message.type === 'focusDistraction') {
    if (message.openFocusView) showFocusView?.();
    if (message.blink) blink?.();
  }
  return true;
}
