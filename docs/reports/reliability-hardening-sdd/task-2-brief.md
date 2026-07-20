### Task 2: Make session and stash restoration complete-or-recoverable

**Findings:** 1 and 12

**Release checkpoint:** expected `v1.2.4`

**Files:**

- Create: `core/restore-outcome.js`
- Create: `core/tab-restore.js`
- Create: `tests/core/restore-outcome.test.js`
- Create: `tests/core/session-restore.test.js`
- Create: `tests/core/stash-restore.test.js`
- Create: `tests/integration/stash-restore-handler.test.js`
- Create: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `core/sessions.js`
- Modify: `core/stash-db.js`
- Modify: `service-worker.js`
- Modify: `sidepanel/components/session-manager.js`
- Modify: `sidepanel/components/stash-list.js`
- Modify: `GUIDE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed outcome interface:**

```js
// core/restore-outcome.js
export function createRestoreOutcome(requestedCount) {
  return {
    requestedCount,
    restoredCount: 0,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    errors: [],
    complete: false,
  };
}

export function finalizeRestoreOutcome(outcome) {
  outcome.complete =
    outcome.skippedInvalid === 0 &&
    outcome.errors.length === 0 &&
    outcome.restoredCount + outcome.skippedDuplicate === outcome.requestedCount;
  return outcome;
}

export function shouldDeleteRestoredSource(outcome, removeAfterRestore) {
  return Boolean(removeAfterRestore && outcome.complete);
}

// core/tab-restore.js
export async function restoreTabWindows(savedWindows, {
  mode = 'windows',
  discarded = true,
  onProgress = null,
} = {});
// resolves to RestoreOutcome plus numeric windowsCreated and groupsRestored fields
```

- [ ] Write `tests/core/restore-outcome.test.js` first. Cover zero-tab completion, all-restored completion, restored-plus-duplicate completion, invalid URL incompletion, create error incompletion, and delete decision requiring both `removeAfterRestore` and `complete`.
- [ ] Write failing orchestration tests for `restoreSession()` and `restoreStashTabs()` using Chrome stubs. Assert exact `requestedCount`, `restoredCount`, `skippedDuplicate`, `skippedInvalid`, `errors`, and `complete` values for mixed inputs.
- [ ] Add a partial-batch test where the middle `tabs.create()` rejects. Assert successful sibling tabs retain their originating saved records so pinned/group metadata cannot shift onto the wrong created tab, and assert the saved session/stash object is not mutated by sanitization.
- [ ] Add `tests/integration/stash-restore-handler.test.js` proving `restoreStash` does not call `deleteStashDB` when one saved URL is invalid or one `tabs.create` call rejects, even when delete-after-restore is requested.
- [ ] Add failing audio-order tests for both restore implementations:

```js
expect(calls).toEqual([
  ['create', { active: false }],
  ['update', createdTabId, { muted: true }],
  ['discard', createdTabId],
  ['update', createdTabId, { muted: false }],
]);
```

Also assert that a non-discarding mode never calls `tabs.update(..., { muted: true })`, the first visible tab is unmuted, and a discard failure still reaches the unmute call through `finally`.
- [ ] Run `bun test tests/core/restore-outcome.test.js tests/core/session-restore.test.js tests/core/stash-restore.test.js tests/integration/stash-restore-handler.test.js` and preserve failures against current raw result objects, unconditional stash deletion, and permanent muting.
- [ ] Implement `core/restore-outcome.js` and the shared `restoreTabWindows()` coordinator. Make `restoreSession()` and `restoreStashTabs()` thin storage/lookup wrappers over it so their pipelines cannot diverge. Count every saved tab in `requestedCount`; count malformed or forbidden URLs in `skippedInvalid`; append `{ scope, url, message }` for create/update/group/pin/discard/unmute failures; finalize once after all windows/batches settle.
- [ ] Clone saved records before sanitizing. Replace failure-hiding batch `Promise.all()` behavior with success-preserving settlement and retain `{ savedTab, createdTab }` pairs for every successful creation.
- [ ] In both restore implementations, mute only tabs entering the discard pipeline. After each discard attempt, unmute in `finally`. Track every tab muted by this invocation and unmute any still pending in an outer `finally` before returning or throwing.
- [ ] Keep the first visible restored tab active and unmuted. In non-discard modes, do not mute any created tab.
- [ ] Change the `restoreStash` handler to delete the IndexedDB source only when `shouldDeleteRestoredSource(result, removeAfterRestore)` is true. On incomplete restore, retain the original stash unchanged and return the outcome so the panel can display restored, duplicate, invalid, and failed counts.
- [ ] Update both UI components so `complete: false` produces a warning with counts and never a success message claiming the source was removed.
- [ ] Run `bun test tests/core/restore-outcome.test.js tests/core/session-restore.test.js tests/core/stash-restore.test.js tests/integration/stash-restore-handler.test.js`, then the full three-command gate.
- [ ] In real Chrome, restore a small session in non-discard mode and confirm the active tab is audible; then force one invalid stash URL and confirm the stash remains. Record this early smoke evidence in `docs/reports/2026-07-14-reliability-smoke.md` for final consolidation.
- [ ] Update the restore behavior in `GUIDE.md`, then close the task using the global chain.

