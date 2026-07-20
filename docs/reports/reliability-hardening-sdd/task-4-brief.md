# Task 4 Implementation Brief

## Objective

Implement the approved Task 4 slice from `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`: bind every asynchronous Focus decision and side effect to the Focus run and URL that originated it, and make ending/recovery terminal and idempotent.

- Base commit: `b3193cba6bc155a6fd7050d6b5ba1827e3e1e934`
- Expected version/tag after controller closeout: `1.2.6`
- Finding: 3
- Worktree: `/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening`
- Implementation report: `/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-4-report.md`

Do not tag, push, publish a release, mutate `main`, or touch the parent checkout. The root controller owns those steps after independent review.

## Required files

Create:

- `core/focus-ai.js`
- `tests/core/focus-lifecycle.test.js`
- `tests/core/focus-ai.test.js`
- `tests/integration/focus-navigation.test.js`

Modify as needed within scope:

- `docs/reports/2026-07-14-reliability-smoke.md`
- `core/focus.js`
- `service-worker.js`
- `GUIDE.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- the Task 4 checklist in the approved plan
- existing dependency-free test helpers only when a real missing Chrome boundary requires it

Do not pre-implement the later foreground Chrome-AI broker. `core/focus-ai.js` must stay provider-agnostic and consume the existing AI client boundary.

## Fixed interfaces and predicates

```js
export const FocusStatus = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
  ENDING: 'ending',
});

export async function validateDistractionTarget({
  runId,
  tabId,
  classifiedUrl,
  decision,
}); // returns { state, tab } or null

export async function handleDistraction({
  runId,
  tabId,
  classifiedUrl,
  decision,
  category,
});

// core/focus-ai.js
export const FOCUS_AI_CONFIDENCE_THRESHOLD = 0.7;
export function isConfidentDistraction(decision);
export function createFocusAiChecker({
  aiClient,
  onDistraction,
  cache,
  scheduleExpiry,
  ttlMs,
});
```

`decision` is always `{ distraction: boolean, confidence: number }`. Deterministic strict/category decisions pass `{ distraction: true, confidence: 1 }`. AI decisions pass their parsed or cached full decision after validation.

`isConfidentDistraction()` must return true only when:

- `decision.distraction === true`;
- `Number.isFinite(decision.confidence)`; and
- `decision.confidence > 0.7` (strictly greater, never greater-than-or-equal).

## Run and URL authority

- Generate a new non-empty `runId` with `crypto.randomUUID()` at the start of every new Focus run. Never reuse a legacy or previous ID.
- Before activating a new run, safely finish any stored active, paused, or ending run. A legacy stored state without `runId` needs a one-time cleanup ID and must be terminal before the new run is saved.
- Worker navigation handling captures immutable `{ runId, classifiedUrl }` at classification start. It must not retain a mutable state object as authority across an AI await.
- `tabs.onUpdated` continues to treat `changeInfo.url` as the classified URL, preserving Task 3's pending-URL fix. Startup/new-tab classification may use its authoritative pending destination.
- `validateDistractionTarget()` performs its final reads in this exact order:

  1. read stored Focus state and require `status === 'active'`, a non-empty `runId`, and an exact run match;
  2. read the current tab and return null if it no longer exists;
  3. require exact URL identity where `(tab.url === classifiedUrl) || (nonEmptyPendingUrl === classifiedUrl)`;
  4. require `isConfidentDistraction(decision)`.

- The URL predicate is current **or** pending. Do not use `tab.url || tab.pendingUrl`, and do not require both fields to match.
- Call validation immediately before `tabs.goBack()`. If `goBack()` fails and removal is the fallback, validate again immediately before `tabs.remove()`.
- No notification, counter, delayed badge reset, removal, or backward navigation may be applied to a different run. Re-read/match the run after every relevant await before writing state or updating run-owned UI.

## AI cache and asynchronous classification

- Extract cached/fresh classification into `createFocusAiChecker()` without granting it mutation authority. The checker only validates decisions and delegates captured context to `onDistraction`.
- Cached and fresh responses use the identical `isConfidentDistraction()` predicate. Cached low-confidence, malformed, or non-distraction results must never delegate.
- A high-confidence cached result still goes through `handleDistraction()` and its live point-of-side-effect validation.
- Forward the captured `runId`, `tabId`, `classifiedUrl`, full decision, and category. Do not forward a stale state object as authority.
- Cache expiry must remove only the exact cache entry instance whose timer was scheduled; an older timer must not delete a newer replacement for the same key.
- Pause, end, a replacement run, a removed tab, or navigation away while classification is pending must turn the eventual completion into a no-op.
- Preserve Task 3's worker `focusReadiness` barrier and allowlist/internal-page AI gate.

## Lifecycle and ending recovery

- Persist `{ ...state, status: 'ending', runId, endedAt, ... }` before restoring a Focus stash, ungrouping tabs, clearing alarms/badges, or writing history.
- Navigation listeners and Focus ticks act only on `active` state. An `ending` state must never reactivate blocking.
- Make `endFocus()` single-flight within one worker. Persisted `ending` state supplies cross-worker crash recovery.
- Service-worker initialization must resume idempotent teardown for `ending`; it must restore active alarms only for `active`.
- History records include `runId`. Before prepending, deduplicate by exact `runId` so a crash after history write cannot create a second record on restart.
- Clear the stored Focus state only in final teardown after restore/ungroup/history/alarm/badge work has been attempted.
- Continue terminal cleanup after individual restore, ungroup, history, alarm, or badge failures. Preserve/report structured failure details without leaving the run active or duplicating history.
- Treat Chrome group ID `0` as valid (`focusGroupId !== null` / integer check, never truthiness).
- Tick-driven expiration must pass an expected `runId`; an old tick cannot end a replacement run.
- Pause must persist paused state before badge work. Resume/rebind/counter paths must re-read and match `runId` before any post-await save, so a stale captured object cannot overwrite an ended or replacement run.

## Mandatory TDD sequence

1. Create `tests/core/focus-lifecycle.test.js` first. Stub `crypto.randomUUID()` with deterministic sequential values and restore it in `finally`.
2. Prove two starts store distinct IDs. Prove a legacy state is fully ended before the new active state is persisted, and its cleanup ID is not reused.
3. Add the complete `validateDistractionTarget()` table: missing state; paused; ending; mismatched or empty run ID; removed tab; neither URL matching; `distraction: false`; confidence `0.7`; string, `NaN`, infinity, or missing confidence. Passing cases require `0.700001` and separately match current URL or non-empty pending URL.
4. Prove `endFocus()` writes `ending` before restore/ungroup; state removal is last; group ID `0` is ungrouped; partial teardown failures still reach terminal cleanup and are reported.
5. Prove history is deduplicated by `runId`, including simulated failure of final state removal followed by worker re-import/recovery.
6. Prove an old tick, stale resume, stale rebind, delayed counter/badge callback, and concurrent end call cannot mutate or close a replacement run.
7. Create `tests/core/focus-ai.test.js`. Cover the exact threshold/predicate matrix, identical cached/fresh behavior, low cached decision not delegating, high cached decision delegating captured immutable context, scheduled expiry execution, and old-timer/new-entry identity safety.
8. Create `tests/integration/focus-navigation.test.js`. Use a deferred `AIClient.complete()` boundary. In separate cases, pause, end, start a replacement run, remove the tab, and navigate again while classification is pending. Resolve high-confidence afterward and assert zero stale `goBack`/`remove`/counter/notification/badge effects.
9. Add fallback coverage where `goBack()` rejects and state/tab/URL changes before removal; the second validation must prevent `remove()`.
10. Use `chrome.tabs.update()` when testing later `tabs.get()` URL validation; manually dispatching `onUpdated` does not itself mutate the Chrome mock's tab.
11. Run `bun test tests/core/focus-lifecycle.test.js tests/core/focus-ai.test.js tests/integration/focus-navigation.test.js` against the current code and preserve the RED failures in the report.
12. Implement the narrow production slice and make the focused suite GREEN.
13. Run the focused command, `bun test`, `bun test --coverage`, `bun test tests/syntax.test.js`, and `git diff --check`. Keep the repository dependency-free: no package manifest/lockfile, DOM/IndexedDB emulator, or production-only failure hook.

The existing Chrome mock already supports pending URLs, storage events/failures, tab get/update/remove/goBack, alarms, call ordering, and worker event dispatch. Add a helper only if a genuinely missing boundary is proved RED.

## Real-Chrome gate

Use the already-installed official Chrome for Testing build and the existing disposable Xvfb/CDP approach. Do not download a browser or use a real credential.

Transparently intercept the production provider request at the CDP network boundary and hold a synthetic high-confidence response long enough to exercise separately:

1. pause before completion;
2. end before completion;
3. navigate to a different URL before completion.

Use unique hosts to avoid cross-case cache reuse and give each tab observable history. After releasing each held response, confirm the real tab still exists and remains on the classified URL for pause/end, or remains on the newly navigated URL for navigation-away. Confirm no stale counter/badge/notification mutation is attributed to a later run.

Record that the provider response was CDP-synthetic. This evidence validates the real service worker, storage, event, and tab side-effect boundaries; it does not claim external provider integration. Record exact browser build/hash, redacted commands/results, and removal of the disposable profile/processes.

## Documentation, version, and commit

- Update `GUIDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, and `PROGRESS.md` for run-bound decisions and recoverable ending semantics.
- Set both `VERSION` and `manifest.json` to `1.2.6`.
- Close all Task 4 checkboxes only after their evidence exists.
- Write the report with RED/GREEN evidence, exact final commands/counts, real-browser evidence, assumptions, concerns, and the model/agent ledger.
- Commit with author email `29182417+michelabboud@users.noreply.github.com` and trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- Leave the worktree clean and report the full commit hash. No tag/push/release.

## Approved checklist (verbatim intent)

- Every Focus run owns a unique ID; legacy/current runs are safely ended before replacement.
- Every delayed deterministic or AI decision is revalidated against the same active run, existing tab, exact current-or-pending URL, and strict confidence predicate immediately before side effects.
- Cached and fresh AI results share one provider-agnostic predicate and mutation boundary.
- `ending` is persisted before teardown, recovered on worker startup, history-deduplicated by `runId`, and terminal despite partial cleanup errors.
- Focus ticks, resume/rebind writes, counters, notifications, and delayed badge work cannot affect a replacement run.
- Focused and full gates pass.
- Real Chrome proves delayed classification cannot act after pause, end, or navigation-away.
- Lifecycle and architecture documentation are current.
