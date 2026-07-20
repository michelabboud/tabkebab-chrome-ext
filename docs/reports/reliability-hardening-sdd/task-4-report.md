# Task 4 Close-out Report

## 1. What was built

- Added a unique `crypto.randomUUID()` run ID to every Focus session before its first asynchronous lifecycle read and explicit `active`, `paused`, and durable `ending` states. A bounded collision retry prevents reuse of the discovered previous ID; a legacy run receives a separate cleanup UUID that is never reused as the new run.
- Serialized start and end through one lifecycle queue and every Focus state read/transform/write mutation through one state queue. An End arriving during pre-persist, alarm, or badge startup waits, ends the run that Start established, and leaves no active authority or orphan alarm. Pause becomes durable before badge work; resume, group rebinding, duration extension, distraction counters, ticks, and final removal all condition their writes on the originating run and allowed status.
- Added `validateDistractionTarget()` with the approved order: durable state and exact active run, live tab existence, exact current URL or exact non-empty pending URL, then the strict decision predicate. Navigation classification captures a lifecycle-generation token before deterministic or AI work begins; validation still reads durable state first, then rejects a captured-generation mismatch. It treats `tabs.get()` as its final await, rejects any intervening mutation including pause→resume ABA, and proceeds directly from URL/decision checks to `goBack()`. The same validation is repeated immediately before removal fallback.
- Added `core/focus-ai.js`. Fresh and cached decisions use one predicate requiring `distraction === true` and finite numeric confidence strictly greater than `0.7`; the checker snapshots immutable run/generation/tab/URL/request context and delegates all mutation authority to `handleDistraction()`.
- Made cache expiry generation-safe, including replacement entries that reuse the same decision object.
- Persisted `ending` before teardown. Restore, group, alarm, badge, history, and state cleanup continue independently and preserve structured failures; history is deduplicated by run ID and rewritten with the union of teardown, state-removal, and recovery failures; worker startup resumes ending state without reactivating blocking.
- Added a durable post-success stash-restore checkpoint. A retry after later failure skips a complete restore or an already-absent stash; a structured incomplete outcome is recorded without checkpointing and retains the non-blocking ending journal until a later recovery completes it. In the unavoidable crash-before-checkpoint window, the production restore coordinator normalizes current open URLs and restores only missing tabs.
- Added browser-session ownership proof and a durable success checkpoint for Focus-created Chrome groups. Startup persists a provisional `{ runId, token, groupId: null }` marker before grouping, finalizes it with the created ID, and mirrors the token in durable state. A first ownership-write failure prevents the Chrome side effect. After grouping begins, metadata, final-ownership, or local Focus-authority failure live-inspects affected tabs, rolls back the group, retries proof cleanup, clears non-durable cached authority, and preserves the primary plus rollback/cleanup errors. Teardown ungrouping requires exact run/token/ID proof and therefore leaves a reused numeric ID untouched after browser restart.
- Routed every Focus action-badge write through one serialized generation-aware reconciler. If durable state changes during either Chrome action await, it repaints the latest run before releasing the queue. Pause, Resume, and Extend return only a final matching durable state, so the panel cannot consume stale success after a replacement arrives during badge work.
- Added run IDs to distraction/end runtime events. One shared status-aware predicate protects the Focus component and the global panel button/view/blink route. The global route loads durable state for every Focus event: distraction requires the same active durable run; an end report accepts the displayed run only after durable removal (or while the same run remains `ending`) and rejects a replacement. Pause, Resume, Extend, and End commands carry the panel's displayed run ID end-to-end; the worker rejects missing, empty, or stale command authority.
- Added lifecycle, AI-cache, delayed-navigation, fallback-removal, badge-race, recovery-checkpoint, and side-panel event tests. No DOM/IndexedDB shim, package manifest, dependency, build step, or production-only failure hook was added.
- Updated the user, architecture, release, progress, implementation-plan, version, and real-Chrome evidence documents for `1.2.6`.

## 2. Verification evidence

Mandatory TDD evidence preserved during implementation:

- Initial lifecycle RED: `bun test tests/core/focus-lifecycle.test.js` produced `1 pass`, `24 fail`. The combined required command produced `2 pass`, `46 fail` across 48 tests. Failures covered missing run IDs/statuses/validator/AI boundary, unsafe delayed lifecycle operations, non-terminal teardown, and stale fallback behavior.
- The paused-duration regression was observed RED with approximately `115004ms` received instead of the expected `40000ms` pause-bound duration.
- Deferred pause and distraction-counter writes were observed resurrecting an ended active/paused state. Serializing conditional state mutations made both no-ops after end.
- The cache generation test was observed RED when an older timer deleted a newer entry that reused the same decision object.
- Final review-boundary badge RED: a state swap during `setBadgeText()` left stale `25m` instead of the replacement `||`; delayed flash reset left stale `!`. The reconciler made both repaint the paused replacement (`||`, amber).
- Final review-boundary panel RED: the shared router did not exist; then a cold valid panel event returned false, a locally matching stale event returned true despite durable replacement, and same-run paused/ending distraction events passed the ID-only predicate. Durable loading plus status semantics made every case GREEN.
- Ending-recovery RED: after a successful observable stash restore and synthetic final state-removal failure, ending state had no restore checkpoint and recovery would call the restore again. The persisted `{ teardownCompleted: { restore: true } }` checkpoint made the retry read and restore exactly once.
- Final lifecycle audit RED: the focused lifecycle selection produced `0 pass`, `11 fail` for previous-ID collision, pause/end/replacement during each of the first and fallback live-tab reads, incomplete-restore checkpointing, and End crossing pre-persist/alarm/badge startup. A panel command test also failed on the missing `createFocusRunCommand` export, and a stale `pauseFocus` worker message mutated a replacement run.
- Validator mirror-race review replaced the extra post-tab durable await with a synchronous generation token. Coverage now proves first/fallback state transitions fail closed, pause→resume ABA invalidates the snapshot, and `goBack()` occurs before any later Focus-state read.
- Literal run-identity ordering RED: while the first stored-state read was held, the new test received `0` UUID calls instead of `1`. Initial UUID allocation now precedes that await, while the existing collision test proves bounded regeneration.
- Final immutable-context RED: mutating the caller's nested request object after classification began changed the object observed by the delayed AI client. The checker now takes a structured snapshot before invoking the client.
- The first independent formal review of commit `7c6079b0b9d2e1d8322ed0a45ca42a247b4542c8` requested changes for five important gaps: AI pause→resume before completion, unretained incomplete restore state, uncheckpointed/unproven ungroup, stale lifecycle-command return values, and history that omitted late teardown/recovery failures. No critical finding was reported.
- Review-repair RED was preserved before production changes: the deferred AI pause→resume integration case performed one backward navigation plus notification/panel/counter/badge effects; the selected lifecycle repair set produced `0 pass`, `8 fail`; durable-read ordering returned before any storage read; first and final session-ownership writes did not abort/roll back grouping; and an injected rollback failure leaked provisional ownership while losing the original write error.
- The corresponding GREEN evidence covers captured classification generation, retained incomplete restore recovery, exact browser-session group proof plus ungroup checkpoint, final matching Pause/Resume/Extend returns, durable failure union, state-first validation order, and both ownership-write/rollback failure paths. The final focused seven-file gate includes these repaired cases.
- The same reviewer then rereviewed repair commit `9dc947050c6b5dca1aac612db22560c65e5eba4b` and requested changes for one Important startup-transaction gap (zero Critical/Minor): a `tabGroups.update` failure left the newly grouped tab unmanaged, while a later local `focusState` write failure left both group and finalized proof orphaned. One-off diagnostics reproduced both with `ungroupCalls=0`.
- Second repair RED selected four new cases and produced `0 pass`, `4 fail`: metadata failure resolved instead of rejecting; metadata plus rollback/proof-cleanup returned only the cleanup error; local authority failure made zero ungroup calls; and authority plus rollback/proof-cleanup returned only the primary error. GREEN live-inspects the affected tabs to detect mutation even though `createNativeGroup()` did not return an ID, independently settles ungroup and retried proof cleanup, preserves ordered aggregate errors, clears the worker cache after non-durable authority, and leaves no local state or session proof.
- Final independent rereview of `7a4075d840d04a084df6de3a33db5f32750e857d` reported zero Critical, Important, or Minor findings. It independently verified the two orphan paths, pre-group no-mutation continuation, ordered aggregate errors, retried proof cleanup, original five repairs, all automated gates, clean worktree/version/dependency state, and commit identity. Spec Compliance: **PASS**. Task Quality: **PASS**. Verdict: **APPROVE**.

Fresh final automated gates on the documented `1.2.6` tree:

```text
bun --version
1.3.11

bun test tests/core/focus-policy.test.js tests/core/focus-start.test.js \
  tests/core/focus-lifecycle.test.js tests/core/focus-ai.test.js \
  tests/integration/focus-navigation.test.js tests/sidepanel/focus-events.test.js \
  tests/integration/focus-worker.test.js
142 pass, 0 fail, 501 expect() calls, 7 files

bun test
204 pass, 0 fail, 753 expect() calls, 15 files

bun test --coverage
204 pass, 0 fail, 753 expect() calls, 15 files
core/focus-ai.js: 100.00% functions, 80.88% lines
sidepanel/focus-events.js: 100.00% functions, 93.44% lines
core/focus-policy.js: 100.00% functions, 98.69% lines

bun test tests/syntax.test.js
2 pass, 0 fail, 76 expect() calls

git diff --check
clean

VERSION and manifest.json
both 1.2.6

root package/lock-file count
0
```

No repository-wide coverage threshold is configured. Bun reports query-string-isolated `core/focus.js` test instances poorly in its aggregate path table, so this report does not claim that displayed percentage as representative. Completion is grounded in the named success/failure/race tests, integration worker tests, full suite, and real-browser boundary rather than a misleading percentage.

Real-browser success-path evidence used the installed official Chrome for Testing `148.0.7778.96` at `/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`, SHA-256 `adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f`. A disposable loopback-TCP Xvfb display loaded repair commit `9dc947050c6b5dca1aac612db22560c65e5eba4b` as an unpacked extension with the side-panel page. CDP Fetch interception held the production custom-provider `/v1/chat/completions` request until each transition was durable, then fulfilled a synthetic JSON decision with confidence `0.99`. Every Pause/End command, including replacement Pause and final cleanup, carried the exact run ID returned by the live Start/Get response:

```text
pause: request held, run paused, tab/classified URL preserved,
  distractions=0, badge=||, stale events=0
end + replacement: old run recorded, replacement paused and preserved,
  tab/classified URL preserved, replacement distractions=0, badge=||, stale events=0
pause + resume: request held, same run active again, tab/classified URL preserved,
  distractions=0, badge=25m, stale events=0
navigate away: request held, same run active, tab/new allowlisted URL preserved,
  distractions=0, badge=25m, stale events=0
cleanup: profile entries before removal=287, profile removed=1,
  Chrome exited=1, Xvfb exited=1, residual profiles/processes/listeners=0
```

Each tab had an earlier synthetic HTTPS history entry and each classified host was unique, so stale backward movement or removal would have been observable without cache reuse. The end case established a replacement before releasing the old response. The pause→resume case reactivated the same run before release and proves the captured lifecycle generation still invalidates the old classification. This evidence validates the production worker, AI client/custom-provider request path, storage/events, badge, tab history, and navigation boundary. It deliberately does not claim an external provider, credential, authentication, latency, or classification-quality result. The later repair changes only injected startup-failure rollback branches; per controller direction, Chrome was not relaunched, while those branches are covered by deterministic Chrome-mock mutation and failure tests. Full redacted commands, the one pre-boundary failed X-socket attempt, results, and cleanup are in `docs/reports/2026-07-14-reliability-smoke.md`.

Model/agent ledger: one Codex GPT-5 implementation agent built and verified Task 4 in the isolated worktree; the root Codex controller coordinated scope and performed repeated live race audits; one independent Codex reviewer reviewed the original commit and both repairs, requesting the two repair rounds recorded above and approving the final tree with no findings. No large fan-out was launched for this slice. The root controller owns the integration decision.

## 3. Assumptions made

- Used the approved exact current-URL **or** exact non-empty pending-URL rule; it was not changed to an AND rule.
- Treated confidence as untrusted provider data. Only a finite JavaScript number strictly greater than `0.7` is accepted; strings and exactly `0.7` are rejected.
- Treated CDP-synthetic provider fulfillment as the narrow approved browser boundary because no real credential or provider-quality claim was authorized.
- Used an exact-URL allowlist for the navigation-away destination so the third smoke case generated only the intentionally held classified-host request.
- Checkpointed stash restoration only when the stash was already absent or the outcome was complete. A structured incomplete outcome remains a teardown failure and retryable recovery step.
- Treated a Chrome numeric group ID as insufficient teardown authority. Ungroup requires a durable per-run token plus matching browser-session run/token/ID proof; missing proof fails closed and records the ownership failure.
- Did not add a new ADR because UUID ownership, ending recovery, confidence policy, and test/runtime boundaries were already fixed by the approved design, plan, and Task 4 brief.

## 4. Concerns and observations

- Exactly-once external tab creation cannot be made atomic with a `chrome.storage` checkpoint. The durable success checkpoint closes the common crash-after-restore/later-cleanup-failure path. If the worker dies after tab creation but before checkpoint persistence, `restoreTabWindows()` re-reads all live tabs, normalizes URLs, skips restored duplicates, and creates only missing tabs. Closing a just-restored tab before recovery can intentionally make it missing and therefore restorable again.
- A full browser restart clears `chrome.storage.session`, so teardown intentionally does not ungroup a Focus-created group whose ephemeral ownership proof disappeared. This can leave that group for the user to manage, but it is safer than mutating an unrelated group after Chrome reuses the numeric ID.
- Startup rollback cannot force Chrome to ungroup when `chrome.tabs.ungroup()` itself rejects. That failure path clears durable and session authority, retries proof cleanup, and rejects with the original cause plus every rollback/cleanup failure; the visible group may remain because Chrome refused the rollback, but it cannot be mistaken for an owned recoverable run.
- Start and End now share one lifecycle queue, while same-run concurrent End calls retain keyed single-flight teardown. This intentionally gives lifecycle calls invocation order within one worker; persisted `ending` state remains the cross-worker recovery boundary.
- The side-panel global router performs a fresh durable read before every Focus event, but no UI read and subsequent DOM operation can be transactionally atomic with a future storage write. The service worker validates before send, the panel validates again before effect, and replacement IDs/status rules fail closed at both boundaries.
- The first smoke harness attempt was non-evidence: the host's shared `/tmp/.X11-unix` mode prevented a Unix X socket. It launched no Chrome/application boundary and was fully removed. The successful run used isolated loopback TCP with access limited to the disposable local test environment, then verified the listener was gone.
- No tag, push, release, `main` mutation, parent-checkout mutation, dependency change, or build artifact was created.

## 5. Close-out confirmation

- Every Task 4 plan checkbox is complete and backed by named automated or browser evidence.
- `GUIDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `PROGRESS.md`, the smoke report, and the approved implementation plan are current.
- `VERSION` and `manifest.json` are both `1.2.6`.
- The Task 4 commit uses Michel's canonical author email and the required `Co-Authored-By: Codex <noreply@openai.com>` trailer.
- Task 4 commits: `7c6079b0b9d2e1d8322ed0a45ca42a247b4542c8` (`fix: bind focus actions to run lifecycle`), first independent-review repair `9dc947050c6b5dca1aac612db22560c65e5eba4b` (`fix: close focus recovery race gaps`), and second rereview repair `7a4075d840d04a084df6de3a33db5f32750e857d` (`fix: roll back failed focus group startup`). All use Michel's canonical author identity and the required Codex co-author trailer; `git status --short` was empty after the latest repair commit.
- Per the Task 4 boundary, no tag, push, release, or final campaign handoff is performed by this worker.
