// actionable-empty-state.js — Shared empty-list prompt with a real next action

export function renderActionableEmptyState(container, {
  message,
  actionLabel,
  onAction,
}) {
  const emptyState = document.createElement('div');
  emptyState.className = 'empty-state empty-state-actionable';

  const explanation = document.createElement('p');
  explanation.textContent = message;
  emptyState.appendChild(explanation);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'action-btn secondary empty-state-action';
  action.textContent = actionLabel;
  action.addEventListener('click', onAction);
  emptyState.appendChild(action);

  container.replaceChildren(emptyState);
  return action;
}
