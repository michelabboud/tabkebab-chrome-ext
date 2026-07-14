# TabKebab Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Detailed plan complete and ready for Michel's implementation approval on 2026-07-14; production changes have not started.

**Goal:** Fix all thirteen confirmed review findings with regression-first tests, preserve existing local and Drive data, and release verified source checkpoints without introducing a production dependency or build step.

**Architecture:** Deliver narrow vertical hardening slices around pure policy modules and explicit Chrome adapters. Bun tests policy and mocked orchestration; IndexedDB, DOM, extension lifecycle, OAuth, and Prompt API behavior remain mandatory real-Chrome gates. Phase 1 closes data-loss and wrong-tab risks, Phase 2 closes backup and UI-contract risks, and Phase 3 closes credential and AI-request risks.

**Tech Stack:** Manifest V3, vanilla JavaScript ESM, Chrome extension APIs, IndexedDB, Google Drive REST v3, Bun `1.3.11`, `bun:test`, GitHub Actions.

## Global Constraints

- Keep Chrome's runtime dependency-free, telemetry-free, and directly loadable from this repository; do not add `package.json`, npm packages, a bundler, or generated runtime code.
- Read the approved [design specification](../specs/2026-07-14-tabkebab-reliability-hardening-design.md) and ADRs 0001-0003 before implementation; Tasks 8-15 also read the ADR 0004 produced by Task 7. If code and plan disagree, stop that task and resolve the design conflict explicitly.
- Treat tabs, runtime messages, AI output, imported JSON, Drive JSON, and Chrome port messages as untrusted data.
- Fail closed for destructive actions. A partial restore or import must retain or restore its recoverable source.
- Preserve compatibility with local records, Drive sync v1, and portable export v1. Emit Drive sync v2 and portable export v2 after successful migration.
- Never place an API key, decrypted key, OAuth token, Drive connection state, install identifier, cache, or active Focus state in exports, Drive documents, logs, or runtime responses. A newly entered plaintext key may exist only in the checked one-shot panel-to-worker save request needed for immediate encryption; do not persist, echo, or log that request.
- Keep `VERSION` as the version source of truth and mirror it in `manifest.json` at each task closeout. The expected task tags below assume planning closes at `v1.2.2`; advance them monotonically if an intervening task consumes a version.
- At every task closeout, run the commands named in that task, update `CHANGELOG.md` and `PROGRESS.md` plus affected user/architecture docs, bump `VERSION` and `manifest.json`, commit with Michel's configured author email and `Co-Authored-By: Codex <noreply@openai.com>`, tag `v$(cat VERSION)`, and push `main` plus the tag.
- At the final task of each phase, create and verify the GitHub release for that task's tag. GitHub source releases are in scope; Chrome Web Store upload is not.
- Do not close a finding from code inspection, syntax checks, mocks alone, or a swallowed exception. Preserve failing-test output, passing-test output, and real-Chrome evidence where required.
- Keep unrelated worktree changes intact. Do not amend published commits, move tags, force-push, or rewrite `main`.

## Finding-to-Task Traceability

| Finding | Remediation task | Primary regression evidence |
|---|---:|---|
| 1. Incomplete stash restore deletes source | 2 | restore outcome and retained-stash tests |
| 2. Drive retention deletes canonical files | 6 | retention selection tests |
| 3. Stale Focus action affects current tab | 4 | run/status/URL revalidation tests |
| 4. Focus startup ignores full allowlist | 3 | URL/group/strict-empty tests |
| 5. NL domain matches unrelated hosts | 5 | exact/subdomain/lookalike tests |
| 6. Duplicate hash/Undo loss | 5 | hash separation and original-URL tests |
| 7. Passphrase key cannot unlock | 12 | unlock/no-disclosure tests |
| 8. Chrome AI runs in worker | 14 | port and real-Chrome Prompt API tests |
| 9. UI renders background error as success | 11 | checked-message and component-path tests |
| 10. Drive deletion resurrection/incomplete export | 7-10 | convergence, sanitization, rollback tests |
| 11. Global search omits open tabs | 11 | grouped-array flattening test |
| 12. Restored tabs remain muted | 2 | mute/discard/unmute ordering tests |
| 13. AI timeout overlaps billable requests | 13 | abort and max-active-attempt tests |

---

## Phase 1 — Destructive-Operation Safety

### Task 1: Establish the Bun regression and CI boundary

**Release checkpoint:** expected `v1.2.3`

**Files:**

- Create: `bunfig.toml`
- Create: `tests/setup.js`
- Create: `tests/helpers/chrome-mock.js`
- Create: `tests/harness.test.js`
- Create: `tests/syntax.test.js`
- Create: `sidepanel/message-client.js`
- Create: `tests/sidepanel/message-client.test.js`
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed test interfaces:**

```js
// tests/helpers/chrome-mock.js
export function createChromeEvent();
export function createRuntimePortPair(name = 'test-port');
// returns { clientPort, workerPort }
export function installChromeMock(overrides = {});
export function resetChromeMock();
export function readStorageArea(areaName);
```

`installChromeMock()` accepts `{ local, session, tabs, windows, groups, failures, runtimeHandler }`, installs the global `chrome`, and returns `{ calls, setRuntimeHandler, snapshot, connect }`. It must provide resettable `storage.local`, `storage.session`, `storage.onChanged`, `runtime.sendMessage`, `runtime.connect`, `runtime.onMessage`, `runtime.onConnect`, `runtime.onStartup`, `runtime.onInstalled`, tabs/windows/tabGroups events, alarms, action, sidePanel, bookmarks, identity, and call-recording stubs. Storage setters must emit Chrome-shaped change records and support one-shot injected failures. `runtime.connect()` returns the client port from `createRuntimePortPair()`, dispatches its worker peer through `runtime.onConnect`, posts only to the peer, and disconnects both ends exactly once.

- [x] Create `tests/harness.test.js` first. Assert test-to-test storage/listener isolation, local/session separation, Chrome-shaped change events, seeded tab/window/group mutations, listener removal, peer-only port delivery, one-shot disconnect, and one-shot failure injection.
- [x] Run `bun test tests/harness.test.js` and preserve the expected failures before the helper and preload are implemented.
- [x] Create `tests/syntax.test.js`. Use `Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.js'])` to enumerate tracked plus not-yet-added JavaScript while excluding ignored output, `new Bun.Transpiler({ loader: 'js' }).transformSync(source)` to parse each file, and `JSON.parse` plus assertions to verify `manifest_version === 3` and `manifest.version === VERSION`.

```js
test('every repository JavaScript file parses', async () => {
  const listed = Bun.spawnSync([
    'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.js',
  ]);
  expect(listed.exitCode).toBe(0);
  const files = new TextDecoder()
    .decode(listed.stdout)
    .split('\0')
    .filter(Boolean);
  expect(files.length).toBeGreaterThan(0);
  const transpiler = new Bun.Transpiler({ loader: 'js' });
  for (const file of files) {
    const source = await Bun.file(file).text();
    expect(() => transpiler.transformSync(source)).not.toThrow();
  }
});
```

- [x] Implement `tests/helpers/chrome-mock.js`. Each event returned by `createChromeEvent()` must expose `addListener`, `removeListener`, `hasListener`, and an async `dispatch(...args)` that awaits listeners.
- [x] Implement `tests/setup.js` with `beforeEach(() => installChromeMock())` and `afterEach(() => resetChromeMock())`. Do not install DOM or IndexedDB shims.
- [x] Write `tests/sidepanel/message-client.test.js` red first, then create the approved `sendOrThrow()` implementation in `sidepanel/message-client.js`. Cover unchanged success, `{ error }` rejection, native rejection, and valid null; later tasks consume this boundary rather than reimplementing error checks.
- [x] Add `bunfig.toml`:

```toml
[test]
preload = ["./tests/setup.js"]
coverageSkipTestFiles = true
```

- [x] Add `.github/workflows/ci.yml` with a `test` job on `pull_request`, `workflow_dispatch`, and pushes to `main` only (not tag pushes). Use `actions/checkout@v4` and `oven-sh/setup-bun@v2` with `bun-version-file: .bun-version`. Its required commands, in order, are `bun test`, `bun test --coverage`, and `bun test tests/syntax.test.js`.
- [x] Add `coverage/` to `.gitignore`. Do not ignore test evidence reports.
- [x] Run `bun test tests/harness.test.js`, then all three global commands, and confirm zero failures. Confirm `git status --short` contains no coverage output.
- [x] Document the pinned Bun prerequisite, local commands, mock-versus-Chrome boundary, and CI gate in `README.md`, `CONTRIBUTING.md`, and `ARCHITECTURE.md`.
- [x] Close the task using the global version/docs/commit/tag/push chain.

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

### Task 3: Apply one complete Focus allowlist policy at startup and navigation time

**Finding:** 4

**Release checkpoint:** expected `v1.2.5`

**Files:**

- Create: `core/focus-policy.js`
- Create: `tests/core/focus-policy.test.js`
- Create: `tests/core/focus-start.test.js`
- Modify: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `core/focus.js`
- Modify: `service-worker.js`
- Modify: `sidepanel/components/focus-panel.js`
- Modify: `GUIDE.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed policy interfaces:**

```js
// core/focus-policy.js
export function isInternalUrl(url);
export function domainMatches(url, allowList);
export function urlMatches(url, allowList);
export function groupMatches(tab, allowList);
export function isAllowed(tabOrUrl, allowList);
export function createAllowlistEntry(type, value, liveGroups);
export function resolveGroupAllowlist(allowList, liveGroups);
export function rebindFocusAllowlist(state, liveGroups);
export function evaluateFocusPolicy(tabOrUrl, state);
```

`resolveGroupAllowlist()` must return new entries. A group entry retains `{ type: 'group', value: title }`, drops any persisted scalar `groupId`, and adds `groupIds` containing every live group whose title exactly equals `value`. `groupMatches()` consults only `groupIds`.

- [ ] Write `tests/core/focus-policy.test.js` first. Cover legacy domain strings, typed domains, exact/subdomain acceptance, lookalike rejection, exact URL acceptance, URL-prefix rejection, group title rebound to two live IDs, stale persisted ID rejection, internal URL allowance, and strict mode with an empty allowlist blocking every non-internal URL.
- [ ] Write `tests/core/focus-start.test.js` proving startup's `isFocusTab()` uses the same `isAllowed()` domain/exact-URL/rebound-group predicate that navigation evaluates before blocklists. Assert `kebab` and `stash` affect only non-focus tabs, while `group` groups only focus tabs. Non-strict empty allowlist treats all tabs as focus; strict empty allowlist treats every non-internal tab as non-focus.
- [ ] Run `bun test tests/core/focus-policy.test.js tests/core/focus-start.test.js` and preserve failures caused by domain-only `isFocusTab()`, prefix URL matching, stale group IDs, and strict-empty fall-through.
- [ ] Move allowlist parsing and block decisions from `core/focus.js` into `core/focus-policy.js`. `evaluateFocusPolicy()` must return `{ blocked, reason, category }` and preserve existing blocklist category behavior.
- [ ] At `startFocus()`, call `chrome.tabGroups.query({})` once, pass the result through `resolveGroupAllowlist()`, and persist the resolved entries only in the active run state. Keep profile preferences title-based so they survive browser restarts.
- [ ] Keep `rebindFocusAllowlist(state, liveGroups)` pure. In `core/focus.js`, query current Chrome groups and call it for an active/paused stored run during service-worker initialization and before resume. This replaces runtime `groupIds` from current exact-title matches after browser restart without changing profile preferences.
- [ ] Implement `isFocusTab()` as: internal URLs are focus; non-strict empty allowlist treats all tabs as focus; otherwise return `isAllowed(tab, state.allowedDomains)`. Strict empty therefore makes every non-internal tab non-focus and blockable.
- [ ] Use `isFocusTab()` for startup tab-action selection and `evaluateFocusPolicy()` for navigation. Both must delegate their allowlist step to the same `isAllowed()` function; do not duplicate allowlist logic in `service-worker.js`.
- [ ] Add `URL` to `#focus-add-type` in the Focus panel's generated markup. Make the panel delegate entry construction to pure `createAllowlistEntry()`: domains are lowercased/canonicalized; URLs use `new URL()` and store `{ type: 'url', value: parsed.href }` without whole-string lowercasing; groups store `{ type: 'group', value: exactTitle }` without numeric ID. Invalid input returns null and produces a visible error. Cover all three shapes in `focus-policy.test.js` without rendering DOM.
- [ ] Update Focus UI copy to state that URL entries are exact and Chrome groups are rebound by exact title at each run.
- [ ] Run `bun test tests/core/focus-policy.test.js tests/core/focus-start.test.js`, then the full three-command gate.
- [ ] In real Chrome, verify strict-empty, one exact URL, and two same-title Chrome groups. Reload the extension before the group check to prove stale numeric IDs are not trusted; append evidence to the smoke report.
- [ ] Update `GUIDE.md` and `ARCHITECTURE.md`, then close the task using the global chain.

### Task 4: Bind every asynchronous Focus action to its originating run and URL

**Finding:** 3

**Release checkpoint:** expected `v1.2.6`

**Files:**

- Create: `core/focus-ai.js`
- Create: `tests/core/focus-lifecycle.test.js`
- Create: `tests/core/focus-ai.test.js`
- Create: `tests/integration/focus-navigation.test.js`
- Modify: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `core/focus.js`
- Modify: `service-worker.js`
- Modify: `GUIDE.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed lifecycle interfaces:**

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
export function createFocusAiChecker({ aiClient, onDistraction, cache, scheduleExpiry, ttlMs });
```

`decision` is always `{ distraction: boolean, confidence: number }`. Deterministic strict/category decisions pass `{ distraction: true, confidence: 1 }`; AI decisions pass the parsed or cached values.

- [ ] Write lifecycle tests first. Stub `crypto.randomUUID()` and assert each `startFocus()` stores a distinct `runId`. A legacy stored state without `runId` must be ended before the new run becomes active.
- [ ] Add failing `validateDistractionTarget()` cases for missing state, paused state, ending state, mismatched run, removed tab, neither `tab.url` nor a non-empty `tab.pendingUrl` matching `classifiedUrl`, `distraction: false`, confidence `0.7`, and malformed confidence. Add passing cases for confidence `0.700001` when either the current URL or the pending URL matches, proving the approved current-or-pending rule is not accidentally implemented as current-and-pending.
- [ ] Add integration tests with a deferred AI promise. While it is pending, exercise pause, end, start-new-run, and navigate-again. After resolution, assert no `tabs.goBack` or `tabs.remove` call occurs.
- [ ] Add cached-result tests proving cached `confidence <= 0.7` never reaches `handleDistraction()` and cached high-confidence results still undergo point-of-side-effect revalidation.
- [ ] Add `focus-ai` tests proving cached and fresh decisions use the identical finite-number/strictly-greater-than-`0.7` predicate, malformed/string confidence is rejected, cache expiry is run, and the checker forwards the captured run ID plus full decision without owning mutation authority.
- [ ] Add an `endFocus()` test proving `{ status: 'ending', runId }` is persisted before stash restore or ungroup begins, and state is cleared only in final teardown after history/badge/alarm work. Add worker-recovery coverage proving an `ending` run resumes idempotent teardown and cannot duplicate history for the same `runId`.
- [ ] Run `bun test tests/core/focus-lifecycle.test.js tests/core/focus-ai.test.js tests/integration/focus-navigation.test.js` and preserve current failures.
- [ ] Generate `runId` with `crypto.randomUUID()` at the start of each run. If an existing state is present, end it safely first; legacy state without a run ID must never be reused.
- [ ] Rework service-worker navigation handling to capture `{ runId, classifiedUrl }` when classification starts and pass the full decision to `handleDistraction()`.
- [ ] Extract the cache/classification boundary into `createFocusAiChecker()`. Both cached and fresh decisions must pass `isConfidentDistraction()` and then delegate to `handleDistraction()` for live validation.
- [ ] Implement `validateDistractionTarget()` so its final read order is storage state → tab existence → current/pending URL → decision threshold. Call it immediately before `goBack` or `remove`; return without side effects when it returns `null`.
- [ ] Persist `ending` before recreating stashed tabs or ungrouping. Navigation listeners and Focus ticks must act only on `active` state. Keep notification/counter updates bound to the same validated run.
- [ ] Make teardown resumable and idempotent. Deduplicate history by `runId`, allow service-worker initialization to finish an `ending` run, and ensure alarm/badge/state cleanup reaches a terminal state even if restore or ungroup reports errors; preserve/report those errors without reactivating blocking.
- [ ] Run `bun test tests/core/focus-lifecycle.test.js tests/core/focus-ai.test.js tests/integration/focus-navigation.test.js`, then the full three-command gate.
- [ ] In real Chrome, delay AI classification, then separately pause, end, and navigate to a new URL before it resolves. Confirm the current tab is never moved backward or removed; append evidence.
- [ ] Update lifecycle documentation, then close the task using the global chain.

### Task 5: Make host matching exact and duplicate Undo lossless

**Findings:** 5 and 6

**Release checkpoint:** expected `v1.2.7`

**Files:**

- Create: `core/url-match.js`
- Create: `tests/core/nl-executor.test.js`
- Create: `tests/core/duplicates.test.js`
- Create: `tests/integration/hash-route-restore.test.js`
- Modify: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `core/nl-executor.js`
- Modify: `core/duplicates.js`
- Modify: `sidepanel/components/duplicate-finder.js`
- Modify: `GUIDE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed URL interfaces:**

```js
// core/url-match.js
export function canonicalHostname(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const input = value.trim();
    const candidate = input.includes('://') ? input : `https://${input}`;
    return new URL(candidate).hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

export function hostnameMatches(url, expectedHost) {
  const hostname = canonicalHostname(url);
  const expected = canonicalHostname(expectedHost);
  if (!hostname || !expected) return false;
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

// core/duplicates.js
export function collectUndoUrls(duplicateGroups, closingTabIds);
```

- [ ] Write NL filter tests first for exact host, subdomain, uppercase input, trailing-dot input, `notgithub.com` rejection, `github.com.evil.test` rejection, malformed URL rejection, and missing domain filter behavior.
- [ ] Write duplicate tests first. Assert `https://app.test/#/one` and `https://app.test/#/two` normalize to different keys, ordinary fragments also remain distinct, existing query/trailing-slash normalization stays stable, and every duplicate tab record includes its original `url`.
- [ ] In `tests/integration/hash-route-restore.test.js`, add one session and one stash case with hash route one already open and hash route two saved. Assert route two is restored rather than counted as a duplicate in both coordinators.
- [ ] Add a pure test for `core/duplicates.js::collectUndoUrls(duplicateGroups, closingTabIds)`, asserting it returns each selected tab's original URL in group/tab order and excludes absent/non-string values.
- [ ] Run `bun test tests/core/nl-executor.test.js tests/core/duplicates.test.js tests/integration/hash-route-restore.test.js` and preserve failures from `hostname.includes()`, hash stripping, omitted duplicate URLs, and false duplicate restore skips.
- [ ] Implement `core/url-match.js`. Catch `TypeError` in the caller and treat malformed values as non-matches; do not fall back to substring matching.
- [ ] Update `filterTabs()` to use `hostnameMatches()` only when a domain filter is present.
- [ ] Stop deleting URL fragments in `normalizeUrl()`. Keep every tab's original URL in the objects returned by `findDuplicates()`; the normalized URL remains only the grouping key.
- [ ] Export and use `collectUndoUrls()` from `core/duplicates.js`. Capture the original URLs before sending the close request or triggering a rescan, then store that immutable array for Undo. Do not reconstruct URLs from the normalized group key.
- [ ] Run `bun test tests/core/nl-executor.test.js tests/core/duplicates.test.js tests/integration/hash-route-restore.test.js`, then the full three-command gate.
- [ ] In real Chrome, preview an NL close for `github.com` with `notgithub.com` open, then run duplicate cleanup and Undo with two hash routes. Confirm the lookalike and both routes survive/reopen correctly; append evidence.
- [ ] Update `GUIDE.md`, then close the task using the global chain.

### Task 6: Restrict Drive retention to dated recoverable copies

**Finding:** 2

**Phase 1 release checkpoint:** expected `v1.2.8`

**Files:**

- Create: `core/drive-retention.js`
- Create: `tests/core/drive-retention.test.js`
- Create: `tests/integration/drive-cleanup.test.js`
- Modify: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `core/drive-client.js`
- Modify: `service-worker.js`
- Modify: `sidepanel/components/settings-manager.js`
- Modify: `GUIDE.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed retention interfaces:**

```js
export const CANONICAL_DRIVE_FILES = new Set([
  'tabkebab-sync.json',
  'tabkebab-settings.json',
]);

export function classifyDatedDriveFile(file);
// null or { category, timestamp }; category is one of the explicit families below

export function selectDriveRetentionDeletions(files, cutoffMs);
// { deleteFiles, keptCanonical, keptNewest, ignoredUndated }
```

The selector returns arrays of listed Drive files. The service-worker action converts them to the serializable UI result `{ deleted, keptCanonical, keptNewest, ignoredUndated, errors }`, where the first four fields are counts and `errors` is `[{ fileId, name, message }]`; no `Error` object crosses runtime messaging.

`listAllDriveFiles()` must add `scope: 'profile'|'sessions'|'stashes'|'bookmarks'|'archive'` to every result. Eligible names are the repository's dated forms: `sessions-YYYY-MM-DD.json`, `stashes-YYYY-MM-DD.json`, `stash-<name>-<13-digit-ms>.json`, `bookmarks-YYYY-MM-DD[-<13-digit-ms>].json`, `bookmarks-YYYY-MM-DD.html`, profile-root `tabkebab-export-<13-digit-ms>.json`, and archive copies ending in `-YYYY-MM-DDTHH-MM-SS.<ext>`. Undated or malformed names are ignored.

The only categories are `sessions`, `stashes`, `bookmarks-json`, `bookmarks-html`, `portable-export`, `archive-sync`, `archive-settings`, `archive-sessions`, `archive-stashes`, `archive-bookmarks-json`, and `archive-bookmarks-html`. Dynamic stash names do not create unbounded categories.

- [ ] Write selection tests first with canonical files older than cutoff, eligible old/new dated files in every scope, an undated user JSON file, malformed timestamps, and multiple old files in one category. Assert canonical/undated files are never returned and every file tied for newest `modifiedTime` in each category is preserved even when older than cutoff.
- [ ] Add integration tests proving scheduled cleanup and `cleanDriveFiles` call the same selector and delete exactly its `deleteFiles`. Assert the manual response reports `{ deleted, keptCanonical, keptNewest, ignoredUndated, errors }`.
- [ ] Run `bun test tests/core/drive-retention.test.js tests/integration/drive-cleanup.test.js` and preserve the current failure where every old JSON/HTML file is selected.
- [ ] Update `listAllDriveFiles()` to annotate scope without changing Drive API permissions or folder creation behavior.
- [ ] Implement strict filename parsing in `core/drive-retention.js`. Derive category from scope and file family, validate the embedded date/timestamp, reject invalid `modifiedTime`, preserve every entry tied at the category's greatest `modifiedTime`, and select only remaining entries whose `modifiedTime` is before `cutoffMs`.
- [ ] Replace both retention loops in `runRetentionCleanup()` and `cleanDriveFiles` with `selectDriveRetentionDeletions()`. Continue after an individual Drive delete error and return structured errors for manual cleanup.
- [ ] Update `settings-manager.js` to call the Task 1 `sendOrThrow()` boundary and state how many files were deleted and how many canonical/newest/undated files were protected. Any returned/transport error displays failure and never a success toast.
- [ ] Run `bun test tests/core/drive-retention.test.js tests/integration/drive-cleanup.test.js`, then the full three-command gate.
- [ ] In real Chrome/Drive, place old canonical, archive, and dated export files in a throwaway profile folder; run manual cleanup and confirm canonical plus newest-per-category preservation. Append file names and post-cleanup listing to the smoke report.
- [ ] Update `GUIDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, and `PROGRESS.md`; record Phase 1 complete, then close/tag/push the task.
- [ ] Create a browsable GitHub release for `v$(cat VERSION)` summarizing Findings 1-6/12, attach no credential-bearing artifacts, and verify with `gh release view v$(cat VERSION) --json tagName,targetCommitish,url` plus `git ls-remote origin refs/tags/v$(cat VERSION)`.

---

## Phase 2 — Backup Integrity and Checked UI Contracts

### Task 7: Introduce deterministic Drive sync v2 migration and merge

**Finding:** 10, Drive resurrection foundation

**Release checkpoint:** expected `v1.2.9`

**Files:**

- Create: `core/drive-sync.js`
- Create: `core/state-mutation-lock.js`
- Create: `tests/core/drive-sync.test.js`
- Create: `tests/core/drive-settings.test.js`
- Create: `tests/core/state-mutation-lock.test.js`
- Create: `docs/adr/0004-serialize-portable-state-mutations-in-the-worker.md`
- Modify: `core/storage.js`
- Modify: `core/settings.js`
- Modify: `core/drive-client.js`
- Modify: `core/grouping.js`
- Modify: `service-worker.js`
- Modify: `sidepanel/components/drive-sync.js`
- Modify: `sidepanel/components/group-editor.js`
- Modify: `docs/adr/README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Canonical constants and document:**

```js
export const DRIVE_SYNC_VERSION = 2;
export const DRIVE_TOMBSTONES_KEY = 'driveSyncTombstones';
export const MAX_DRIVE_JSON_BYTES = 25 * 1024 * 1024;
export const MAX_DRIVE_ENTITIES_PER_KIND = 10_000;
export const MAX_DRIVE_TOMBSTONES_PER_KIND = 10_000;
export const MAX_DRIVE_TABS_PER_ENTITY = 10_000;
export const MAX_DRIVE_TOTAL_TABS = 100_000;
export const MAX_DRIVE_STRING_LENGTH = 16_384;
export const MAX_DRIVE_NESTING_DEPTH = 12;
export const MAX_DRIVE_TIMESTAMP = Number.MAX_SAFE_INTEGER;
export const MAX_DRIVE_TOMBSTONE = MAX_DRIVE_TIMESTAMP - 1;

{
  version: 2,
  sessions: [],
  manualGroups: {},
  tombstones: {
    sessions: { 'session-id': 1784050000000 },
    manualGroups: { 'group-id': 1784050000000 },
  },
}
```

**Fixed interfaces:**

```js
// core/storage.js additions
Storage.getMany(keys);
Storage.setMany(values);
Storage.removeMany(keys);

// core/drive-sync.js
export function emptyDriveTombstones();
export function getDriveEntityTimestamp(entity);
export function normalizeDriveTombstone(value);
export function migrateDriveSyncDocument(input);
export function mergeDriveSyncDocuments(left, right);
export async function readLocalDriveSyncDocument();
export async function writeLocalDriveSyncDocument(document);
export async function reconcileDriveSync(remoteDocument, writeRemote);

// core/state-mutation-lock.js
export async function withStateMutationLock(operation);

// core/settings.js
export const SETTINGS_CONSTRAINTS = Object.freeze({
  removeStashAfterRestore: { type: 'boolean' },
  defaultView: { enum: ['tabs', 'windows', 'stash', 'sessions'] },
  theme: { enum: ['system', 'light', 'dark'] },
  maxTabsPerWindow: { type: 'integer', min: 1, max: 500 },
  recommendedTabsPerWindow: { type: 'integer', min: 1, max: 500 },
  autoSaveIntervalHours: { type: 'integer', min: 1, max: 168 },
  autoSaveRetentionDays: { type: 'integer', min: 1, max: 365 },
  autoKebabAfterHours: { type: 'integer', min: 0, max: 720 },
  autoStashAfterDays: { type: 'integer', min: 0, max: 365 },
  bookmarkByWindows: { type: 'boolean' },
  bookmarkByGroups: { type: 'boolean' },
  bookmarkByDomains: { type: 'boolean' },
  bookmarkDestination: { enum: ['chrome', 'indexeddb', 'drive', 'all'] },
  autoBookmarkOnStash: { type: 'boolean' },
  compressedExport: { type: 'boolean' },
  exportHtmlBookmarkToDrive: { type: 'boolean' },
  focusDefaultProfile: { enum: ['coding', 'writing', 'research', 'meeting'] },
  focusDefaultDuration: { type: 'integer', min: 1, max: 480 },
  focusTabAction: { enum: ['kebab', 'stash', 'group', 'none'] },
  focusStrictBlocking: { type: 'boolean' },
  autoExportSessionsToDrive: { type: 'boolean' },
  autoExportStashesToDrive: { type: 'boolean' },
  autoSyncToDriveIntervalHours: { type: 'integer', min: 0, max: 168 },
  driveRetentionDays: { type: 'integer', min: 1, max: 365 },
  neverDeleteFromDrive: { type: 'boolean' },
});
export function validateSettingsPatch(input, currentSettings);
export function parseDriveSettingsDocument(input);
```

- [ ] Write `tests/core/drive-sync.test.js` first. Cover absent version and explicit v1 migration to empty tombstones; normalized v2 copying; unsupported version rejection; malformed sessions/groups/tombstones rejection; and prototype-pollution key rejection.
- [ ] Add merge tests for newer session/group wins, greatest tombstone wins, entity timestamp equal to tombstone is deleted, entity timestamp greater than tombstone survives, and tombstones remain present even when a newer entity survives.
- [ ] Add equal-timestamp conflict tests in both operand orders. Resolve ties by stable recursively key-sorted serialization; sort output sessions by descending `createdAt` then lexical `id`, and construct manual-group/tombstone keys lexically. `merge(a, b)` and `merge(b, a)` must return byte-identical JSON.
- [ ] Add reconciliation tests proving a failed remote write leaves local sessions/groups/tombstones byte-for-byte unchanged, while success writes a v2 document remotely before one atomic `Storage.setMany()` persists all three local sections.
- [ ] Write `state-mutation-lock` tests with a deferred first operation and a concurrent second operation. Assert strict start/settle order, lock release after rejection, and a sync-then-delete simulation in which the later local/tombstone mutation is not overwritten.
- [ ] Add bounded Drive-read tests: reject `Content-Length` above 25 MiB before body consumption, reject streamed/text content that exceeds the limit, and reject excessive entity counts, tombstone counts, per-entity/total tab counts, string lengths, or nesting depth in `migrateDriveSyncDocument()`.
- [ ] Write `tests/core/drive-settings.test.js` for bounded canonical/cross-profile settings reads. Accept legacy missing-version and version-1 envelopes only; require a non-negative safe-integer `savedAt <= MAX_DRIVE_TIMESTAMP` when present; require an own `settings` object; allow only own keys from `SETTINGS_DEFAULTS`; and reject prototype keys, unknown keys, oversized strings, excessive nesting, or over-25-MiB responses before `saveSettings()` can run.
- [ ] Exercise every `SETTINGS_CONSTRAINTS` boundary: booleans are exact booleans; `defaultView` is `tabs|windows|stash|sessions`; `theme` is `system|light|dark`; `bookmarkDestination` is `chrome|indexeddb|drive|all`; `focusDefaultProfile` is `coding|writing|research|meeting`; `focusTabAction` is `kebab|stash|group|none`; integer ranges are `maxTabsPerWindow/recommendedTabsPerWindow 1..500`, `autoSaveIntervalHours 1..168`, `autoSaveRetentionDays 1..365`, `autoKebabAfterHours 0..720`, `autoStashAfterDays 0..365`, `focusDefaultDuration 1..480`, `autoSyncToDriveIntervalHours 0..168`, and `driveRetentionDays 1..365`. Reject fractional values and a merged result where `recommendedTabsPerWindow > maxTabsPerWindow`.
- [ ] Run `bun test tests/core/drive-sync.test.js tests/core/drive-settings.test.js tests/core/state-mutation-lock.test.js` and preserve failures against the current unversioned union merge, unbounded settings reads, and missing serialization.
- [ ] Add `Storage.getMany`, `setMany`, and `removeMany` as thin Chrome calls. `setMany()` must call `chrome.storage.local.set(values)` once; it must not loop by key.
- [ ] Implement `migrateDriveSyncDocument()`. Null/missing-version/v1 documents read as v1 with empty tombstones; v2 sections are copied into null-prototype objects. Reject unsupported/malformed documents, more than 10,000 entities or tombstones per kind, more than 10,000 tabs/URLs in one entity, more than 100,000 total tabs/URLs, strings longer than 16,384 characters, or nesting deeper than 12 before merge. Tombstones are never age-pruned; the count and byte limits remain their resource bounds.
- [ ] Implement `getDriveEntityTimestamp()` with non-negative safe integers no greater than `MAX_DRIVE_TIMESTAMP`, and `normalizeDriveTombstone()` with the stricter `MAX_DRIVE_TOMBSTONE` ceiling so Undo can always write an exact `T + 1`. Entity timestamp prefers valid `modifiedAt`, then valid `createdAt`, else `0`, while a missing/malformed local tombstone normalizes to `0`. Remote schema validation still rejects malformed timestamps. Implement `mergeDriveSyncDocuments()` with those helpers: for every ID, select the newer/deterministic entity, take the maximum deletion timestamp, and keep the entity only when its timestamp is strictly greater than the tombstone.
- [ ] Implement `writeLocalDriveSyncDocument()` as the single `Storage.setMany({ sessions, manualGroups, driveSyncTombstones })` boundary and call it from reconciliation; do not bypass this declared interface.
- [ ] Add a bounded JSON reader in `drive-client.js` and make `readSyncFile()` use it. Check `Content-Length` when present, cap accumulated UTF-8 bytes at `MAX_DRIVE_JSON_BYTES`, then parse JSON; no unbounded `response.json()` remains for downloaded Drive JSON files.
- [ ] Use that bounded reader for `readSettingsFile()`, `readSettingsFromProfile()`, and `readDriveExport()` as well. Canonical and cross-profile settings reads must call `parseDriveSettingsDocument()` before returning. `readDriveExport()` returns only bounded parsed JSON here; Task 9's portable schema remains the authority before any later import mutation.
- [ ] Implement `parseDriveSettingsDocument()` in `core/settings.js` and make `saveSettings()` validate the same allowlisted settings patch before merging defaults. Export the enum constraints beside `SETTINGS_DEFAULTS`; do not spread unknown Drive or runtime-message keys into local storage.
- [ ] Implement the FIFO worker-local `withStateMutationLock()`. Document in ADR 0004 that all session/manual-group mutations and Drive reconciliation are serialized in the service worker; the panel may read but no longer writes these collections.
- [ ] Move the full canonical sync orchestration to a `syncDriveState` service-worker action. Under one mutation lock: read/migrate remote and local → compute pure merge → await `writeSyncFile(merged)` → `writeLocalDriveSyncDocument(merged)` → run subfolder export → update `lastSyncedAt`. Remote absence is an empty v1 document; remote-success/local-failure remains idempotently retryable.
- [ ] Route every existing session mutation and every manual-group create/edit/move/delete operation through locked service-worker actions. Remove direct `manualGroups` writes from `group-editor.js`; Task 8 adds tombstone semantics to the already centralized delete action.
- [ ] Make `DriveSync.syncNow()` call `sendOrThrow({ action: 'syncDriveState' })` and render only its returned summary. Remove panel imports/calls for canonical sync read/write. A worker `{ error }` must never advance UI sync state.
- [ ] Run `bun test tests/core/drive-sync.test.js tests/core/drive-settings.test.js tests/core/state-mutation-lock.test.js`, then the full three-command gate.
- [ ] Update ADR index and `ARCHITECTURE.md` with worker ownership, serialization, v1 read/v2 write, resource limits, stable ordering, and remote-first reconciliation semantics, then close the task using the global chain.

### Task 8: Record every session and manual-group deletion transactionally

**Finding:** 10, deletion convergence

**Release checkpoint:** expected `v1.2.10`

**Files:**

- Create: `tests/core/deletion-tombstones.test.js`
- Modify: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `core/drive-sync.js`
- Modify: `core/sessions.js`
- Modify: `core/grouping.js`
- Modify: `service-worker.js`
- Modify: `sidepanel/components/group-editor.js`
- Modify: `sidepanel/components/session-manager.js`
- Modify: `GUIDE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed deletion interfaces:**

```js
export async function deleteSessions(sessionIds, deletedAt = Date.now());
// { deletedIds, tombstones: { [sessionId]: timestamp } }

export async function deleteSession(sessionId, deletedAt = Date.now());
// { deleted, tombstoneAt }

export async function restoreDeletedSession(session, restoredAt = Date.now());
// restored session with modifiedAt newer than its retained tombstone

export async function deleteManualGroup(groupId, deletedAt = Date.now());
// { deleted, tombstoneAt }
```

- [ ] Write tests first proving session/group removal and the matching tombstone are supplied in the same `Storage.setMany()` call. Inject a storage rejection and assert neither the entity collection nor tombstones change in the mock.
- [ ] Cover maximum-timestamp behavior per ID using Task 7's timestamp helpers. Reject a supplied `deletedAt` unless it is a non-negative safe integer no greater than `MAX_DRIVE_TOMBSTONE`. Compute `Math.max(deletedAt, getDriveEntityTimestamp(entity), normalizeDriveTombstone(previousTombstone))`; if the entity timestamp exceeds `MAX_DRIVE_TOMBSTONE`, fail closed because no representable tombstone could dominate it. Add `NaN`, `Infinity`, negative, numeric-string, ceiling, and future-timestamp cases so malformed values cannot poison the tombstone map and a clock-skewed/future entity cannot immediately resurrect.
- [ ] Cover batch auto-save/retention deletion so every removed session ID receives the same or later timestamp. Assert no retention path writes the filtered `sessions` array directly.
- [ ] Cover Undo with the same finite timestamp policy. Reject `restoredAt` unless it is a non-negative safe integer no greater than `MAX_DRIVE_TIMESTAMP`; given tombstone `T`, `restoreDeletedSession()` retains `T` and sets `modifiedAt` to `Math.max(restoredAt, getDriveEntityTimestamp(session), T + 1)`. `MAX_DRIVE_TOMBSTONE` guarantees `T + 1` remains exact and schema-valid. Add malformed prior session timestamps plus invalid `restoredAt` cases and prove Undo survives the next merge.
- [ ] Add a two-profile test: delete on profile A, update older on profile B, merge both ways, and assert deletion converges; repeat with a genuinely newer update and assert the entity survives while its tombstone remains.
- [ ] Run `bun test tests/core/deletion-tombstones.test.js` and preserve failures from direct storage deletion paths.
- [ ] Add pure tombstone-update helpers to `core/drive-sync.js`; never mutate the object returned by storage.
- [ ] Implement `deleteSessions()` and make `deleteSession()` delegate to it. Return the exact per-ID tombstone map because batch members may have different prior/entity timestamps. Route explicit session deletion, rolling auto-save cleanup, and alarm retention through the same locked worker function.
- [ ] Route `undoDeleteSession` through `restoreDeletedSession()` rather than pushing the old record directly.
- [ ] Make `core/grouping.js::deleteManualGroup()` write `manualGroups` and `driveSyncTombstones` together under the Task 7 lock. The existing centralized `deleteManualGroup` action uses it; all other group mutations remain worker-owned as established in Task 7.
- [ ] Run `bun test tests/core/deletion-tombstones.test.js`, then the full three-command gate.
- [ ] In real Chrome, delete and Undo one session and delete one manual group. Inspect local storage by key name only to confirm tombstone timestamps exist and Undo has a newer `modifiedAt`; append evidence without copying private tab URLs.
- [ ] Update user docs, then close the task using the global chain.

### Task 9: Define portable export v2 and secret-free section merges

**Finding:** 10, complete export foundation

**Release checkpoint:** expected `v1.2.11`

**Files:**

- Create: `core/export-schema.js`
- Create: `tests/core/export-schema.test.js`
- Create: `tests/integration/bookmark-snapshot.test.js`
- Modify: `core/settings.js`
- Modify: `service-worker.js`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Canonical portable shape:**

```js
export const PORTABLE_EXPORT_VERSION = 2;
export const MAX_PORTABLE_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_PORTABLE_SECTION_RECORDS = 10_000;
export const MAX_PORTABLE_TABS_PER_RECORD = 10_000;
export const MAX_PORTABLE_TOTAL_TABS = 100_000;
export const MAX_PORTABLE_STRING_LENGTH = 16_384;
export const MAX_PORTABLE_NESTING_DEPTH = 12;

// core/settings.js
export const PORTABLE_SETTINGS_KEYS = Object.freeze(Object.keys(SETTINGS_DEFAULTS));

{
  version: 2,
  kind: 'full' | 'sessions' | 'stashes' | 'settings',
  exportedAt: '2026-07-14T12:00:00.000Z',
  sessions: [],
  stashes: [],
  manualGroups: {},
  keepAwakeDomains: [],
  bookmarks: [],
  settings: {},
  focusProfilePrefs: {},
  focusHistory: [],
  aiSettings: {
    enabled: false,
    providerId: null,
    providerConfigs: {
      openai: { model: 'gpt-4.1-nano' },
      custom: { model: 'default', baseUrl: 'http://localhost:11434/v1' },
    },
  },
}
```

Full documents require every section. Partial kinds require only their named section plus the envelope. `aiSettings` contains only `enabled`, `providerId`, provider `model`, and Custom `baseUrl`; it never contains `apiKey`, ciphertext, passphrase metadata, or unknown provider fields.

**Fixed schema interfaces:**

```js
export function sanitizeAISettings(aiSettings);
export function validateStashSection(value);
export function createPortableExportDocument(kind, sections, exportedAt);
export function parsePortableExportDocument(value);
export function mergePortableSections(existing, incoming, { tombstones, now });
```

- [ ] Write schema tests first for a complete v2 full payload, each partial kind, and deterministic serialization. Recursively scan serialized output and assert no key named `apiKey`, `token`, `credential`, `installId`, `focusState`, `driveSync`, or cache field exists.
- [ ] Add v1 compatibility fixtures for current full/session/stash/settings files and assert they normalize to the matching v2 sections in memory.
- [ ] Add preflight rejection tests for unsupported versions, missing required sections, malformed IDs/types/timestamps, arrays where records are required, non-JSON values, and `__proto__`/`constructor`/`prototype` keys. An `apiKey` anywhere inside imported `aiSettings` must reject the document rather than be silently persisted. Exercise exported `validateStashSection()` directly with valid and malformed stash arrays so the transactional IndexedDB boundary can revalidate independently.
- [ ] Add resource-bound tests for more than 10,000 records in any section, more than 10,000 tabs in one session/stash, more than 100,000 tabs across the document, strings above 16,384 characters, nesting deeper than 12, and cumulative in-memory payload cost above `MAX_PORTABLE_IMPORT_BYTES` even when every individual record/string is under its own cap. Reject before merge or storage access; Task 10 also covers the panel's pre-parse file-size boundary.
- [ ] Define merge tests: local record wins stable-ID collision for sessions/stashes/history; local object value wins manual-group/focus-preference key collision; keep-awake is set union; bookmarks use their stable `id`, with deterministic `createdAt/date/time` identity only for legacy records; imported allowlisted general settings overlay local values.
- [ ] Add `tests/integration/bookmark-snapshot.test.js`, stub `crypto.randomUUID()`, invoke the worker `{ action: 'createBookmarks' }` path with local and Drive destinations, and prove every newly persisted bookmark snapshot contains that stable ID before any destination write; the legacy tuple is never used for new data.
- [ ] Prove AI merge overlays only provider/model/base URL while preserving every existing encrypted `apiKey` and existing `usePassphrase` metadata byte-for-byte.
- [ ] Prove explicit import of a session/group hidden by a local tombstone revives it with `modifiedAt > tombstone` while retaining the tombstone; this is allowed because import is a direct user recovery action, unlike passive Drive sync.
- [ ] Run `bun test tests/core/export-schema.test.js tests/integration/bookmark-snapshot.test.js` and preserve failures from missing schema/sections, unsanitized settings, and bookmark records without stable IDs.
- [ ] Implement schema validation as pure code using own-property checks and null-prototype output records. Its single traversal maintains a cumulative budget: UTF-8 bytes of every own key/string plus 16 bytes for every scalar, property, array slot, and container; reject immediately when the total exceeds `MAX_PORTABLE_IMPORT_BYTES`, reject cycles/non-JSON values, and never use an unbounded stringify as the worker's size check. Export `validateStashSection()` and have `parsePortableExportDocument()` call that exact function for its stash section; validate every present section before returning any normalized data.
- [ ] Export `PORTABLE_SETTINGS_KEYS` from `core/settings.js`, derived exactly from `SETTINGS_DEFAULTS`, and consume it in export validation/merge. Never spread arbitrary storage keys into a portable document.
- [ ] Add `id: crypto.randomUUID()` to new bookmark snapshots in `service-worker.js`; preserve existing IDs and derive the tuple identity only while importing legacy bookmarks.
- [ ] Implement AI sanitization by constructing allowed fields, not by cloning and deleting known secrets.
- [ ] Implement the exact merge rules above without Chrome, DOM, or IndexedDB access.
- [ ] Run `bun test tests/core/export-schema.test.js tests/integration/bookmark-snapshot.test.js`, then the full three-command gate.
- [ ] Update `ARCHITECTURE.md` with the portable boundary and explicit import-recovery semantics, then close the task using the global chain.

### Task 10: Make all export/import paths v2, prevalidated, and rollback-safe

**Finding:** 10, complete export and transactional import

**Release checkpoint:** expected `v1.2.12`

**Files:**

- Create: `tests/core/export-import.test.js`
- Modify: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `core/export-import.js`
- Modify: `core/stash-db.js`
- Modify: `core/focus.js`
- Modify: `service-worker.js`
- Modify: `sidepanel/components/stash-list.js`
- Modify: `sidepanel/components/settings-manager.js`
- Modify: `sidepanel/components/session-manager.js`
- Modify: `sidepanel/components/focus-panel.js`
- Modify: `GUIDE.md`
- Modify: `README.md`
- Modify: `PRIVACY.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed orchestration interfaces:**

```js
export async function replaceAllStashes(stashes);
// validates again, then one IndexedDB readwrite transaction: clear + put

export const PORTABLE_KIND_SECTIONS = Object.freeze({
  full: ['sessions', 'stashes', 'manualGroups', 'keepAwakeDomains', 'bookmarks', 'settings', 'focusProfilePrefs', 'focusHistory', 'aiSettings'],
  sessions: ['sessions'],
  stashes: ['stashes'],
  settings: ['settings'],
});

export class ImportRollbackError extends Error {
  constructor(originalCause, rollbackFailures) {
    super('Import failed and rollback was incomplete', { cause: originalCause });
    this.name = 'ImportRollbackError';
    this.rollbackFailures = rollbackFailures;
  }
}

export async function buildFullExportPayload({
  storage = Storage,
  stashRepository = { list: getAllStashes },
  now = () => new Date(),
} = {});

export async function buildPortableExportPayload(kind, {
  storage = Storage,
  stashRepository = { list: getAllStashes },
  now = () => new Date(),
} = {});

export async function applyPortableImport(parsedDocument, {
  storage = Storage,
  stashRepository = { list: getAllStashes, replace: replaceAllStashes },
  now = Date.now,
} = {});

export async function readPortableImportFile(file, acceptedKinds);
export function downloadJson(payload, filename);

// successful apply result
{
  imported: { sessions, stashes, manualGroups, bookmarks, focusHistory },
  skipped: { sessions, stashes, manualGroups, bookmarks, focusHistory },
}
```

- [ ] Write tests first for `buildFullExportPayload()`. Seed exactly `sessions`, `manualGroups`, `keepAwakeDomains`, `tabkebabBookmarks`, `tabkebabSettings`, `focusProfilePrefs`, `focusHistory`, and `aiSettings`, plus injected stash records. Assert the v2 full document contains all allowlisted data and none of `driveSync`, `driveProfileName`, `focusState`, `tabkebabSettingsPrevious`, AI cache, install IDs, OAuth state, or session-storage keys.
- [ ] Add export tests for `sessions`, `stashes`, and `settings`. Each kind reads only the repository named by `PORTABLE_KIND_SECTIONS`, emits the exact v2 envelope, and never reads an unrelated local key or IndexedDB store. `buildFullExportPayload()` delegates to `buildPortableExportPayload('full', dependencies)` so the full and partial paths cannot drift.
- [ ] Add import preflight tests where the final section is invalid. Assert zero storage and stash writes, proving every section is parsed and validated before mutation.
- [ ] Call the service-worker `importPortableData` action directly with a raw error-shaped, secret-bearing, wrong-kind, cumulatively over-25-MiB/deep, and prototype-key payload that bypasses the panel helper. Assert the worker re-runs `parsePortableExportDocument()` and performs zero storage or IndexedDB reads/writes on every rejection; panel-side validation is an early UX check, never a trust boundary.
- [ ] Add partial-kind tests. `sessions` snapshots/writes only `sessions`; `stashes` touches only IndexedDB; `settings` touches only `tabkebabSettings`; `full` touches the eight local keys plus stashes. Unaffected repositories must not be read, written, or rolled back. Each UI input rejects kinds outside its accepted set before messaging the worker.
- [ ] Add successful full import tests with deterministic imported/skipped counts and preservation of encrypted AI keys. Assert the eight affected local keys are written in one `Storage.setMany()` call and stashes are replaced once.
- [ ] Add rollback tests per kind. Snapshot only affected keys/stores; inject failure on the local write and on full/stash replacement separately. Assert exact affected-state restoration, including removal of keys that were absent before import, while unrelated seeded state remains byte-for-byte unchanged.
- [ ] Add deferred concurrency tests around the service-worker import and export actions. A simultaneous affected-state mutation waits on `withStateMutationLock()` until import commits or rolls back, then applies afterward; no rollback may erase the queued mutation. A full export holds the same lock across all local-storage and IndexedDB reads, so the returned document is one coherent snapshot rather than a mixture around a queued mutation.
- [ ] Inject rollback failure and require `ImportRollbackError` with the original cause plus rollback failures. The UI must show this as failure and must not claim data was imported.
- [ ] Run `bun test tests/core/export-import.test.js` and preserve failures against the current incremental writes and ad-hoc v1 importers.
- [ ] Implement `replaceAllStashes()` with one IndexedDB transaction and call the schema layer's exported `validateStashSection()` again before opening it; do not depend on an unverifiable brand or caller promise.
- [ ] Implement `readPortableImportFile()` to reject `file.size > MAX_PORTABLE_IMPORT_BYTES` before `file.text()`, parse/validate once, and enforce `acceptedKinds` before returning a normalized document.
- [ ] Implement import by looking up exact affected sections from `PORTABLE_KIND_SECTIONS`: snapshot only those keys/stores → compute merges in memory → one local `setMany()` if local keys exist → one stash replacement if stashes are affected. On failure, restore only affected present keys, remove only affected originally absent keys, restore stashes only when affected, and rethrow; rollback failure becomes `ImportRollbackError(originalCause, rollbackFailures)`.
- [ ] Move import mutation into a locked `importPortableData` service-worker action. Inside the lock, call `parsePortableExportDocument(msg.document)` again before snapshotting or mutating anything, then pass only that worker-normalized result to `applyPortableImport()`. Expand the Task 7 worker mutation lock to all import-affected writers: settings, keep-awake, bookmarks, Focus preferences/history, AI settings, sessions/groups, and stash save/delete/import. Route Focus preference saving through a worker action. This lock is held across validation, apply, and rollback so concurrent changes queue rather than being overwritten.
- [ ] Implement `buildPortableExportPayload(kind, dependencies)` from `PORTABLE_KIND_SECTIONS`; it reads only the required repositories and calls `createPortableExportDocument()`. `buildFullExportPayload()` is its fixed full-kind wrapper.
- [ ] Add a locked `buildPortableExport` service-worker action accepting only `{ action: 'buildPortableExport', kind }` and returning the sanitized document. Hold `withStateMutationLock()` across every required local-storage and IndexedDB read. Full/session/stash/settings UI exporters call `sendOrThrow()` for this action and pass the response to `downloadJson()`; no UI path constructs an export snapshot or emits v1.
- [ ] Each UI importer calls `readPortableImportFile(file, acceptedKinds)` and then `sendOrThrow({ action: 'importPortableData', document })`; no UI path may mutate imported state or trust ad-hoc JSON.
- [ ] Update UI success text from the returned summary only after the import promise resolves. Reset file inputs in `finally`.
- [ ] Run `bun test tests/core/export-import.test.js`, then the full three-command gate.
- [ ] In real Chrome, export a populated profile, recursively inspect key names for secrets, import it into a clean profile, and confirm local storage plus IndexedDB stashes are restored. Automated injected-failure tests remain the rollback authority because Bun has no IndexedDB and production code must not gain a failure hook; append redacted evidence.
- [ ] Update `GUIDE.md`, `README.md`, `PRIVACY.md`, and architecture-facing progress/changelog notes, then close the task using the global chain.

### Task 11: Reject background error responses and restore global tab search

**Findings:** 9 and 11

**Phase 2 release checkpoint:** expected `v1.2.13`

**Files:**

- Modify: `sidepanel/message-client.js`
- Modify: `tests/sidepanel/message-client.test.js`
- Create: `tests/sidepanel/global-search.test.js`
- Create: `tests/sidepanel/component-messaging.test.js`
- Modify: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `sidepanel/panel.js`
- Modify: `sidepanel/components/ai-settings.js`
- Modify: `sidepanel/components/command-bar.js`
- Modify: `sidepanel/components/drive-sync.js`
- Modify: `sidepanel/components/duplicate-finder.js`
- Modify: `sidepanel/components/focus-panel.js`
- Modify: `sidepanel/components/global-search.js`
- Modify: `sidepanel/components/group-editor.js`
- Modify: `sidepanel/components/session-manager.js`
- Modify: `sidepanel/components/settings-manager.js`
- Modify: `sidepanel/components/stash-list.js`
- Modify: `sidepanel/components/tab-list.js`
- Modify: `sidepanel/components/window-list.js`
- Modify: `sidepanel/components/toast.js`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed request contract:**

```js
// sidepanel/message-client.js
export async function sendOrThrow(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

// sidepanel/components/global-search.js
export function flattenGroupedTabs(groupedTabs);
export const SEARCH_UNAVAILABLE_MESSAGE = 'Search unavailable — try again.';

// constructor injection remains optional in production
new GlobalSearch({ send = sendOrThrow } = {});
```

`flattenGroupedTabs()` accepts the current service-worker response directly: an array of `{ domain, tabs }`. It throws `Grouped tabs are unavailable` for null, error-shaped data, the obsolete `{ groups: [...] }` wrapper, a non-array item, or an item whose `tabs` is not an array. A valid empty array returns `[]`.

- [ ] Write `message-client` tests first for unchanged success, `{ error: 'Close failed' }` rejection with that exact message, native `sendMessage()` rejection propagation, and valid `null` response.
- [ ] Move `toast.js`'s `document.getElementById('toast-container')` lookup inside `showToast()` so every request/response component module listed in this task can be imported with `globalThis.document` absent. Keep/add a prototype `send(msg) { return sendOrThrow(msg); }` adapter on each component class except `GlobalSearch`, whose constructor injection is fixed above. In `tests/sidepanel/component-messaging.test.js`, dynamically import every listed class without constructing it, call each adapter through `Class.prototype.send.call({}, message)`, and prove an error-shaped response rejects. This gives every component the same tested boundary without requiring a DOM shim.
- [ ] Write global-search tests for two groups flattening in order, valid empty array, and every malformed shape named above. Add a contract assertion that mocked `getAllTabsGroupedByDomain()` returns an array, not an object wrapper. Inject a rejecting/malformed sender into `GlobalSearch`, override only its DOM render seam, and assert `_fetchAll()` calls `renderUnavailable(SEARCH_UNAVAILABLE_MESSAGE)` rather than rendering an empty result.
- [ ] Run `bun test tests/sidepanel/message-client.test.js tests/sidepanel/component-messaging.test.js tests/sidepanel/global-search.test.js` and preserve failures from raw runtime responses and `.groups` lookup.
- [ ] Replace every side-panel request/response `chrome.runtime.sendMessage()` call with `sendOrThrow()` or a component adapter delegating to it. This includes direct calls in `panel.js`, `drive-sync.js`, and `global-search.js`.
- [ ] Do not route `chrome.runtime.onMessage` broadcasts, fire-and-forget progress events from the service worker, or Chrome-AI long-lived ports through this helper.
- [ ] Move every success toast, optimistic state update, and refresh that implies success after the checked promise resolves. Existing catches must display the thrown background message when safe for users.
- [ ] Audit every `this.send(` and `sendOrThrow(` call. Each promise must be `await`ed, returned, or end in an explicit `.catch()` for intentional best-effort behavior; convert event handlers to async as needed so checked failures cannot become unhandled rejections.
- [ ] Update global search to flatten the array response. Add `renderUnavailable(message)` that replaces results with one `.search-empty[role="alert"]` carrying the exact copy `Search unavailable — try again.`; malformed/rejected loading calls it and never populate empty successful caches.
- [ ] Run `rg -n "chrome\\.runtime\\.sendMessage" sidepanel --glob '*.js'` and manually classify every remaining line as a documented broadcast/port exception; request/response calls must be zero.
- [ ] Run `bun test tests/sidepanel/message-client.test.js tests/sidepanel/component-messaging.test.js tests/sidepanel/global-search.test.js`, then the full three-command gate.
- [ ] In real Chrome, force one representative background action to return `{ error }` and verify an error toast, no success toast, and no optimistic state mutation. Open tabs in multiple domain groups and confirm Ctrl+K returns them alongside stashes and sessions; append evidence.
- [ ] Update `ARCHITECTURE.md`, `CHANGELOG.md`, and `PROGRESS.md`; record Phase 2 complete, then close/tag/push the task.
- [ ] Create and verify the GitHub release for `v$(cat VERSION)` with notes covering Drive v2, deletion convergence, portable export/import, checked messaging, and global search. Record dependency audit as not applicable because no package or lockfile exists.

---

## Phase 3 — Credential and AI Request Safety

### Task 12: Add passphrase-only restart unlock and atomic protection changes

**Finding:** 7

**Release checkpoint:** expected `v1.2.14`

**Files:**

- Create: `tests/ai/ai-client-passphrase.test.js`
- Modify: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `core/ai/ai-client.js`
- Modify: `core/ai/provider.js`
- Modify: `service-worker.js`
- Modify: `sidepanel/components/ai-settings.js`
- Modify: `sidepanel/panel.html`
- Modify: `GUIDE.md`
- Modify: `PRIVACY.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed client and message interfaces:**

```js
AIClient.needsPassphrase(providerId); // Promise<boolean>
AIClient.unlockApiKey(providerId, passphrase); // Promise<void>
AIClient.saveConfiguration(publicSettings, keyUpdates, passphrase);
AIClient.getPublicSettings();
// returns hasApiKey/usesPassphrase per provider and
// protectionMode: 'device'|'passphrase'|'mixed'; never ciphertext

{ action: 'needsAIPassphrase', providerId }
// -> { needsPassphrase: boolean }

{ action: 'unlockAIApiKey', providerId, passphrase }
// -> exactly { unlocked: true }

{
  action: 'saveAISettings',
  settings,
  keyUpdates: [{ providerId, plainKey }],
  passphrase: string | null,
}
// -> { saved: true, unlocked: boolean }
```

- [ ] Write tests first for correct unlock after clearing `chrome.storage.session`, wrong-passphrase rejection with no session mutation, already-unlocked, no-key, device-key/no-passphrase, and legacy global/blob metadata mismatch.
- [ ] Add untrusted-message cases for unknown provider IDs, missing/non-string passphrases, malformed key-update arrays, and duplicate provider updates. Reject before crypto or storage calls.
- [ ] Assert the unlock handler response is exactly `{ unlocked: true }`. Prove every AI settings/unlock/save runtime response excludes plaintext, ciphertext, and passphrase. The one-shot save request necessarily contains newly entered plaintext/passphrase and the storage adapter necessarily receives ciphertext; tests must instead prove neither is logged, echoed, or copied into any response.
- [ ] Add atomic transition tests. Enabling or disabling protection with stored keys requires replacement plaintext for every stored provider whose blob protection differs; otherwise reject before any write and preserve local settings byte-for-byte.
- [ ] Cover legacy mixed-provider blobs explicitly. Public settings report `protectionMode: 'mixed'` and the UI checkbox is indeterminate; model/endpoint edits may preserve mixed mode, but changing to device/passphrase or replacing keys requires replacements for every stored provider and normalizes all blobs in one write.
- [ ] Inject the local settings write failure and prove session cache remains unchanged. Inject session-cache failure after a successful local write and require committed-but-locked semantics: return `{ saved: true, unlocked: false }`, keep valid encrypted settings, and let a later unlock/decrypt repopulate session. Cover successful all-provider replacement in both protection directions.
- [ ] Run `bun test tests/ai/ai-client-passphrase.test.js` and preserve failures from the missing runtime unlock path and split settings/key writes.
- [ ] Make `needsPassphrase()` derive truth from the selected provider's encrypted blob `usesPassphrase`, not the potentially stale global flag.
- [ ] Implement `getPublicSettings()` and make the `getAISettings` handler return it. Replace each stored `apiKey` blob with `hasApiKey` and `usesPassphrase` booleans before crossing the runtime boundary. Derive `protectionMode` from all stored blobs; do not collapse mixed mode into a false boolean. Update UI placeholder/toggle logic to consume these public fields.
- [ ] Implement `unlockApiKey()` using the existing decryptor. Wrong passphrase throws `AIAuthError('Incorrect passphrase')`; success stores only `aiDecryptedKey_<providerId>` in session storage and returns no key.
- [ ] Implement `saveConfiguration()` as: read private current settings → validate/allowlist public model/provider/endpoint edits → preserve private blobs not replaced → validate protection transition → encrypt all replacements in memory → one local `aiSettings` write → one best-effort session-cache write. Persist `usePassphrase: true|false|null` where null means legacy mixed; normalized saves contain only true or false. Session-cache failure returns `unlocked: false` rather than rolling back valid encrypted persistence or rejecting ambiguously.
- [ ] Replace separate save/key runtime calls with the single atomic handler above. Keep legacy internal methods only if another caller still requires them and tests cover the behavior.
- [ ] Add `#ai-unlock-section`, `#ai-unlock-passphrase`, `#btn-unlock-ai`, and `#ai-unlock-result`. Refresh and provider selection query `needsAIPassphrase`; correct unlock clears input and refreshes availability, wrong unlock shows failure only.
- [ ] Run `bun test tests/ai/ai-client-passphrase.test.js`, then the full three-command gate.
- [ ] Fully restart Chrome, verify the Unlock UI appears for a protected key, reject a wrong passphrase, accept the right one, and make one provider call. Confirm no key appears in service-worker/panel logs; append evidence.
- [ ] Update key-handling docs, then close the task using the global chain.

### Task 13: Abort timed-out provider attempts before bounded retry

**Finding:** 13

**Release checkpoint:** expected `v1.2.15`

**Files:**

- Create: `core/ai/request-lifecycle.js`
- Create: `tests/helpers/deferred.js`
- Create: `tests/helpers/provider-double.js`
- Create: `tests/fixtures/hanging-ai-server.js`
- Create: `tests/ai/request-lifecycle.test.js`
- Create: `tests/ai/queue.test.js`
- Create: `tests/ai/provider-signals.test.js`
- Modify: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `core/ai/ai-client.js`
- Modify: `core/ai/queue.js`
- Modify: `core/ai/provider.js`
- Modify: `core/ai/provider-openai.js`
- Modify: `core/ai/provider-claude.js`
- Modify: `core/ai/provider-gemini.js`
- Modify: `core/ai/provider-custom.js`
- Modify: `core/ai/provider-chrome.js`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed lifecycle interfaces:**

```js
export async function runAbortableAttempt(operation, timeoutMs, externalSignal);
// operation: signal => Promise<result>

provider.complete(request, config, signal);
provider.testConnection(config, signal);
provider.listModels(config, signal);

export class AIAbortError extends Error { code = 'AI_ABORTED'; }
export class AITimeoutError extends Error { code = 'AI_TIMEOUT'; }
export class AIForegroundRequiredError extends Error { code = 'AI_FOREGROUND_REQUIRED'; }
export class AIUnavailableError extends Error { code = 'AI_UNAVAILABLE'; }
// Existing classes gain stable codes:
// AIDisabledError=AI_DISABLED, AIAuthError=AI_AUTH,
// AIRateLimitError=AI_RATE_LIMIT, AINetworkError=AI_NETWORK.
export class AIMalformedResultError extends Error { code = 'AI_MALFORMED_RESULT'; }
```

- [ ] Write request-lifecycle tests first. Success clears its timer without abort; timeout flips the exact provider signal to `aborted`, waits for the provider promise to reject/settle, then throws `AI_TIMEOUT`; external cancellation throws `AI_ABORTED`; every explicit call receives a new controller.
- [ ] Write queue tests proving only `AINetworkError` and `AIRateLimitError` retry automatically, with at most three total attempts. Auth, disabled, unavailable-provider, foreground-required, timeout, abort, malformed-result, and unknown errors perform one attempt.
- [ ] Use deferred attempts to record `attempt1-settled` before `attempt2-started` and assert `maxActiveCount === 1`. This is the finding's non-overlap acceptance test.
- [ ] Write provider tests proving OpenAI, Claude, Gemini, and Custom pass the identical signal to every `fetch`; an `AbortError` becomes `AIAbortError`, never retryable `AINetworkError`. Prove Chrome provider passes the signal to Prompt API create/prompt and destroys the session; Task 14 will move that executor into the panel without changing this contract.
- [ ] Run `bun test tests/ai/request-lifecycle.test.js tests/ai/queue.test.js tests/ai/provider-signals.test.js` and preserve failures from `Promise.race()` timeout and catch blocks that wrap abort as network errors.
- [ ] Implement `runAbortableAttempt()` with one controller. Link an optional external signal, start the timer, abort on timeout, await operation settlement, translate only the controller's timeout into `AITimeoutError`, and always clear timer/remove listeners in `finally`.
- [ ] Change AIClient to enqueue a fresh attempt closure that calls `provider.complete(request, config, signal)` through `runAbortableAttempt()`. Cache only a completed successful response.
- [ ] Restrict queue retry classification to typed network/rate-limit errors. Keep the default at `maxRetries: 2`, meaning exactly three total attempts including the first, and make `maxRetries`, backoff, clock, and delay injectable for fast deterministic tests; reject negative/non-integer retry configuration.
- [ ] Thread signals through all provider methods. In each catch, detect abort before network wrapping. Keep bounded retry delays after the prior call has fully settled.
- [ ] Run `testConnection()` and `listModels()` through the same abortable lifecycle with their own controllers and timeout; preserve their existing user-facing false/empty fallback only after typed timeout/abort cleanup has settled.
- [ ] Map a provider/model availability failure to `AIUnavailableError`, not `AINetworkError`; reserve network errors for transport/API failures. Chrome model absent/download-required and an unknown model availability response are non-retryable unavailable errors.
- [ ] Add `tests/fixtures/hanging-ai-server.js`: a CORS-enabled Bun HTTP server that holds `/v1/chat/completions`, records request start/connection abort/active/max-active counts, and exposes redacted `/metrics`. It is manual smoke infrastructure and is not started by the default test suite.
- [ ] Run `bun test tests/ai/request-lifecycle.test.js tests/ai/queue.test.js tests/ai/provider-signals.test.js`, then the full three-command gate.
- [ ] In real Chrome, run the committed hanging provider fixture and configure the Custom provider to its loopback URL. Use the shipped 120-second timeout unchanged; after timeout, query redacted metrics and require one aborted request, zero active requests, and `maxActive === 1`. Then click explicit retry and observe one distinct later request. Stop the fixture and append evidence.
- [ ] Update request-lifecycle docs, then close the task using the global chain.

### Task 14: Broker Chrome Built-in AI through the side-panel document

**Finding:** 8

**Release checkpoint:** expected `v1.2.16`

**Files:**

- Create: `core/ai/chrome-ai-protocol.js`
- Create: `core/ai/chrome-ai-broker-client.js`
- Create: `sidepanel/chrome-ai-broker.js`
- Create: `tests/ai/chrome-ai-protocol.test.js`
- Create: `tests/ai/chrome-ai-broker-client.test.js`
- Create: `tests/sidepanel/chrome-ai-broker.test.js`
- Create: `tests/integration/chrome-ai-focus.test.js`
- Modify: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `core/ai/ai-client.js`
- Modify: `core/ai/provider-chrome.js`
- Modify: `core/ai/provider.js`
- Modify: `service-worker.js`
- Modify: `sidepanel/panel.js`
- Modify: `GUIDE.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed broker interfaces:**

```js
export const CHROME_AI_PORT_NAME = 'tabkebab:chrome-ai';
export const MAX_CHROME_AI_USER_PROMPT_CHARS = 200_000;
export const MAX_CHROME_AI_SYSTEM_PROMPT_CHARS = 50_000;
export const MAX_CHROME_AI_RESULT_BYTES = 2 * 1024 * 1024;

export function parseChromeAIRequest(message);
export function parseChromeAIResult(message);
export function serializeChromeAIError(error);

export class ChromeAIBrokerClient {
  attachPort(port);
  testConnection(config, signal);
  complete(request, config, signal);
  disconnect();
}

export const chromeAIBrokerClient = new ChromeAIBrokerClient();

export function startChromeAIBroker({
  runtime = chrome.runtime,
  createProvider = () => new ChromeAIProvider(),
  scheduleReconnect = setTimeout,
} = {}); // { port, disconnect }
```

**JSON-only port protocol:**

```js
// worker -> panel
{ type: 'chrome-ai/request', requestId, method: 'availability' | 'complete', payload }
{ type: 'chrome-ai/cancel', requestId }

// panel -> worker
{ type: 'chrome-ai/result', requestId, ok: true, value }
{
  type: 'chrome-ai/result',
  requestId,
  ok: false,
  error: { code, message },
}
```

`requestId` is a UUID string up to 64 characters. Availability payload is exactly `{}`. Complete payload is exactly `{ request }`, where `request.userPrompt` is a non-empty string up to 200,000 characters, optional `systemPrompt` is at most 50,000 characters, `maxTokens` is an integer from 1 through 8192, `temperature` is finite from 0 through 2, and `responseFormat` is absent or `'json'`; unknown keys are rejected. Availability success is boolean. Completion success is exactly `{ text, parsed, tokensUsed }`, with UTF-8 serialized result at most 2 MiB, string `text`, JSON-only `parsed` no deeper than 12, and non-negative integer `tokensUsed`. Allowed error codes are `AI_ABORTED`, `AI_TIMEOUT`, `AI_UNAVAILABLE`, `AI_FOREGROUND_REQUIRED`, `AI_NETWORK`, and `AI_MALFORMED_RESULT` with a user-safe message up to 1,000 characters.

- [ ] Write client tests first for absent panel, correct named-port attachment, unrelated-port ignore, concurrent out-of-order response correlation, structured error preservation, unknown/duplicate response ignore, cancel on abort, and disconnect rejection of every pending request with `AI_FOREGROUND_REQUIRED`.
- [ ] In `tests/ai/chrome-ai-protocol.test.js`, cover every field/type/size/depth/unknown-key limit above. A malformed message without a valid request ID is ignored; a malformed request with a valid ID receives `AI_MALFORMED_RESULT`; a malformed result with a matching pending ID rejects that request and clears it.
- [ ] Add race tests: a replacement port rejects old pending work; a later disconnect from the old port cannot clear the replacement; every request ID comes from `crypto.randomUUID()`.
- [ ] Add panel-lifecycle tests proving an unexpected port disconnect schedules a bounded reconnect while the panel remains alive, a successful reconnect clears backoff, and explicit `disconnect()` cancels reconnect permanently. This is required for Manifest V3 worker restarts.
- [ ] Write panel-broker tests for availability and completion, one `createProvider()` call per accepted request, whitelisted serializable results, provider exception serialization, cancel-to-controller abort, disconnect cleanup, and suppression of late success after cancellation. Allowed typed codes are preserved; an unrecognized exception becomes `{ code: 'AI_UNAVAILABLE', message: 'Chrome AI request failed.' }` with no stack or raw exception fields.
- [ ] Add a broker-timeout integration using Task 13's `runAbortableAttempt()`: timeout emits exactly one cancel message, aborts the panel controller, rejects with `AI_TIMEOUT`, and leaves both worker/panel pending maps empty before any later attempt starts.
- [ ] Add an integration test proving an uncached background Focus classification with Chrome AI selected and no panel broker treats `AI_FOREGROUND_REQUIRED` as a safe skip and never calls `handleDistraction()`. Keep a separate case showing a valid cached classification can still proceed to the live Focus guard without a panel.
- [ ] Run `bun test tests/ai/chrome-ai-protocol.test.js tests/ai/chrome-ai-broker-client.test.js tests/sidepanel/chrome-ai-broker.test.js tests/integration/chrome-ai-focus.test.js` and preserve failures from direct worker `LanguageModel` access.
- [ ] Keep `core/ai/provider-chrome.js` as the document-context Prompt API executor. It receives the Task 13 signal, destroys every created session in `finally`, and returns only `{ text, parsed, tokensUsed }` or typed errors.
- [ ] Export one `chromeAIBrokerClient` singleton from `core/ai/chrome-ai-broker-client.js`. AIClient uses that exact instance for the Chrome provider and `service-worker.js::onConnect` calls `attachPort()` on the same instance; tests reset it with `disconnect()` between cases. Chrome AI remains configured when selected; `complete()` may return a cached result before contacting a broker, while uncached work without a panel throws the typed foreground-required error.
- [ ] Register `chrome.runtime.onConnect` in the worker for exactly `CHROME_AI_PORT_NAME`. Attach the newest valid port and ignore every other name.
- [ ] Start one broker from `sidepanel/panel.js`. The panel owns one controller/session per request; an explicit cancel or disconnect aborts and destroys it. AbortSignal objects never cross the port.
- [ ] Reconnect the panel port after unexpected worker disconnect with delays of 100 ms, 500 ms, then 1000 ms capped at 1000 ms. Explicit panel teardown stops reconnect. The worker tracks port generation so an old port's later disconnect/result cannot clear or resolve work owned by the current port.
- [ ] Implement the three protocol validators/serializer in `chrome-ai-protocol.js` and use them on both sides before Prompt API or promise resolution. Do not pass raw exceptions, arbitrary parsed objects, signals, functions, or unknown fields over the port.
- [ ] Run `bun test tests/ai/chrome-ai-protocol.test.js tests/ai/chrome-ai-broker-client.test.js tests/sidepanel/chrome-ai-broker.test.js tests/integration/chrome-ai-focus.test.js`, then the full three-command gate.
- [ ] In supported real Chrome, confirm availability and one completion while the panel is open; close the panel during another request and confirm foreground-required/cancel behavior. Trigger background Focus with the panel closed and confirm no tab mutation; append evidence.
- [ ] Update Chrome AI foreground-only docs, then close the task using the global chain.

### Task 15: Complete the real-Chrome matrix and publish the verified phase

**All findings verification**

**Phase 3/final release checkpoint:** expected `v1.2.17`

**Files:**

- Create: `docs/guides/real-chrome-smoke-matrix.md`
- Complete: `docs/reports/2026-07-14-reliability-smoke.md`
- Modify: `package.cmd`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `GUIDE.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRIVACY.md`
- Modify: `CONTRIBUTING.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

`docs/reports/2026-07-14-reliability-smoke.md` consolidates the per-slice evidence already committed by Tasks 2-14, including each tested task commit. Never include browsing history, API keys, OAuth tokens, or private Drive payload contents. After Task 15 is pushed, rerun the complete matrix against the exact CI-produced package; preserve that final exact-commit table in the GitHub release notes and five-section closeout report because the repository report is already part of the tested commit.

- [ ] Before modifying Task 15 files, assert Task 14 is clean. Write `docs/guides/real-chrome-smoke-matrix.md` as a reproducible operator guide with setup, action, assertion, evidence, and cleanup commands for every row. Use two disposable profiles where required: `profile_a="$(mktemp -d /tmp/tabkebab-smoke-a.XXXXXX)"` and `profile_b="$(mktemp -d /tmp/tabkebab-smoke-b.XXXXXX)"`. The guide sources the release-state file defined below and appends every spawned fixture/Chrome PID to `matrix_pid_file`, one numeric PID per line, so later steps work in fresh shells.
- [ ] Rewrite `package.cmd` around `setlocal EnableExtensions EnableDelayedExpansion`. Read the exact version from `VERSION`, parse `manifest.json` with PowerShell, fail unless both match, and produce only `dist\tabkebab-!VERSION!.zip`. Copy exactly `manifest.json`, `service-worker.js`, `core/`, `sidepanel/`, and `icons/` into a temporary staging tree so relative directories survive compression; remove staging on success or failure. Reject any missing allowlisted entry. This positive allowlist excludes `.github/`, tests, coverage, docs, store assets, Git metadata, Bun configuration, the packager, and repository-only Markdown by construction.
- [ ] Extend `.github/workflows/ci.yml` with a Windows `package` job that depends on the test job. A PowerShell step with `id: version` reads `VERSION` into both `$version` and `$env:GITHUB_OUTPUT`, runs `cmd /c package.cmd`, expands `dist/tabkebab-$version.zip` into a fresh staging directory, asserts its top-level entry set is exactly `manifest.json`, `service-worker.js`, `core`, `sidepanel`, and `icons`, and asserts the packaged manifest version equals `VERSION`. Upload exactly `dist/tabkebab-${{ steps.version.outputs.value }}.zip` through `actions/upload-artifact@v4` with `name: tabkebab-extension-${{ steps.version.outputs.value }}` and `if-no-files-found: error`.
- [ ] Consolidate the already collected per-task report rows and ensure the guide makes these deterministic: two-profile Drive uses the same Google account with distinct profile names, syncs both before deletion, then syncs A-delete → B → A and requires absence on both; background-error UI uses a clean profile with `driveSync.connected=true` but no `driveProfileName`, then clicks manual cleanup and requires the checked error toast; timeout uses the committed CORS hanging-provider fixture and the production 120-second timeout.
- [ ] The exact-commit matrix to run after CI contains:

  1. Complete and forced-partial stash restore, including retained recovery data.
  2. Session/stash audio state before and after discard.
  3. Focus pause/end during delayed classification, strict-empty, exact URL, and group title rebinding after restart.
  4. Duplicate cleanup/Undo with ordinary and distinct hash-route URLs.
  5. NL close preview with exact/subdomain and lookalike hosts.
  6. Drive v1 migration, two-profile deletion convergence, canonical retention, newest archive, and full export/import. Injected automated tests provide rollback-failure evidence.
  7. Passphrase unlock after full browser restart.
  8. Chrome AI with panel open, panel disconnect, and background closed-panel skip.
  9. HTTP provider timeout cancellation with maximum one active attempt.
  10. Forced background errors display failure and never success.
  11. Ctrl+K returns tabs, stashes, and sessions.

- [ ] Run the final local gate before closeout:

```bash
bun --version
bun test
bun test --coverage
bun test tests/syntax.test.js
git diff --check
test "$(cat VERSION)" = "$(bun -e 'console.log((await Bun.file("manifest.json").json()).version)')"
git status --short
```

- [ ] Review coverage output by changed module. Every success/failure path listed in the approved specification must have a named automated test; do not substitute a repository-wide percentage target.
- [ ] Update docs to match shipped behavior: Bun contributor workflow, recoverable partial restores, exact Focus/URL semantics, Drive v2 and retention protection, portable export v2 boundaries, passphrase unlock, checked UI errors, Chrome AI foreground requirement, and abort-before-retry.
- [ ] Mark all thirteen findings complete with links to named tests and smoke rows in `PROGRESS.md`. Add final release notes to `CHANGELOG.md` and confirm `README.md`, `GUIDE.md`, `ARCHITECTURE.md`, and `PRIVACY.md` contain no stale claims.
- [ ] Perform the global closeout chain for the final version: bump both version files, rerun the full gate after the bump, commit, tag, push `main`, and push the tag. Do not create the GitHub release yet.
- [ ] Wait for exact-commit GitHub Actions and require success:

```bash
commit="$(git rev-parse HEAD)"
deadline=$((SECONDS + 600))
run_json='[]'
while (( SECONDS < deadline )); do
  run_json="$(gh run list --workflow .github/workflows/ci.yml --commit "$commit" --limit 1 --json databaseId,headSha,status,conclusion,url)"
  test "$(jq 'length' <<<"$run_json")" -gt 0 && break
  sleep 10
done
test "$(jq 'length' <<<"$run_json")" -eq 1
test "$(jq -r '.[0].headSha' <<<"$run_json")" = "$commit"
run_id="$(jq -r '.[0].databaseId' <<<"$run_json")"
test -n "$run_id"
gh run watch "$run_id" --exit-status
release_version="$(cat VERSION)"
[[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
release_state="/tmp/tabkebab-release-state-$release_version.env"
rm -f -- "$release_state"
umask 077
{
  printf 'release_version=%q\n' "$release_version"
  printf 'release_commit=%q\n' "$commit"
  printf 'run_id=%q\n' "$run_id"
} > "$release_state"
test -O "$release_state"
test "$(stat -c '%a' "$release_state")" = 600
```
- [ ] Download and expand the exact run's artifact, assert the downloaded zip is unique, and launch Chrome from `unpacked_dir`, not the repository:

```bash
current_version="$(cat VERSION)"
release_state="/tmp/tabkebab-release-state-$current_version.env"
test -O "$release_state"
# shellcheck disable=SC1090 -- generated above with printf %q and mode 0600
source "$release_state"
test "$release_version" = "$current_version"
test "$release_commit" = "$(git rev-parse HEAD)"
artifact_dir="$(mktemp -d "/tmp/tabkebab-release-$release_version.XXXXXX")"
unpacked_dir="$(mktemp -d "/tmp/tabkebab-unpacked-$release_version.XXXXXX")"
notes_file="/tmp/tabkebab-release-notes-$release_version.md"
matrix_pid_file="/tmp/tabkebab-matrix-pids-$release_version.txt"
rm -f -- "$notes_file"
: > "$notes_file"
rm -f -- "$matrix_pid_file"
: > "$matrix_pid_file"
chmod 600 "$notes_file" "$matrix_pid_file"
gh run download "$run_id" --name "tabkebab-extension-$release_version" --dir "$artifact_dir"
mapfile -t downloaded_zips < <(find "$artifact_dir" -type f -name '*.zip' -print)
test "${#downloaded_zips[@]}" -eq 1
zip_path="${downloaded_zips[0]}"
unzip -q "$zip_path" -d "$unpacked_dir"
test -s "$unpacked_dir/manifest.json"
{
  printf 'artifact_dir=%q\n' "$artifact_dir"
  printf 'unpacked_dir=%q\n' "$unpacked_dir"
  printf 'notes_file=%q\n' "$notes_file"
  printf 'matrix_pid_file=%q\n' "$matrix_pid_file"
  printf 'zip_path=%q\n' "$zip_path"
} >> "$release_state"
```
- [ ] Run all eleven matrix rows against this exact final package. Record Chrome version, OS, commit, package SHA-256, disposable profile paths, expected/actual, pass/fail, redacted evidence, and cleanup in a local release-notes file. If any row fails, do not release: fix the owning task, consume the next patch version, push, and restart exact-commit CI/package/matrix verification.
- [ ] Stop the hanging provider and all Chrome processes started for the matrix. Remove disposable Chrome profiles, `unpacked_dir`, disposable credentials, and throwaway Drive artifacts; record exact teardown commands in the release notes. Retain `artifact_dir`, `zip_path`, and `notes_file` until the verified zip has been attached and the remote release checks pass.
- [ ] Create the final GitHub release with the exact local files below. The notes link the design, ADRs, named tests, repository smoke report, package SHA-256, and final exact-commit matrix. Attach the verified zip to GitHub, but do not upload or publish it to the Chrome Web Store in this initiative.

```bash
current_version="$(cat VERSION)"
release_state="/tmp/tabkebab-release-state-$current_version.env"
test -O "$release_state"
source "$release_state"
test "$release_version" = "$current_version"
test "$release_commit" = "$(git rev-parse HEAD)"
test -s "$notes_file"
test -s "$zip_path"
gh release create "v$release_version" --target "$release_commit" --notes-file "$notes_file" "$zip_path"
```
- [ ] Verify remote/runtime release state:

```bash
current_version="$(cat VERSION)"
release_state="/tmp/tabkebab-release-state-$current_version.env"
test -O "$release_state"
source "$release_state"
test "$release_version" = "$current_version"
test "$release_commit" = "$(git rev-parse HEAD)"
git fetch origin main --tags
remote_main="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
remote_tag="$(git ls-remote origin "refs/tags/v$release_version^{}" | awk '{print $1}')"
if test -z "$remote_tag"; then remote_tag="$(git ls-remote origin "refs/tags/v$release_version" | awk '{print $1}')"; fi
test "$remote_main" = "$release_commit"
test "$remote_tag" = "$release_commit"
release_json="$(gh release view "v$release_version" --json tagName,targetCommitish,url,isDraft,isPrerelease)"
test "$(jq -r .tagName <<<"$release_json")" = "v$release_version"
test "$(jq -r .targetCommitish <<<"$release_json")" = "$release_commit"
test "$(jq -r .isDraft <<<"$release_json")" = false
test "$(jq -r .isPrerelease <<<"$release_json")" = false
git status --short --branch
```

- [ ] After remote release verification, perform the guarded final cleanup below. It refuses any non-`/tmp/tabkebab-*` directory, removes the retained artifact/unpacked directories and local release-notes file, and fails if a recorded matrix process is still alive. Never add the repository or a non-disposable browser profile to these variables.

```bash
current_version="$(cat VERSION)"
release_state="/tmp/tabkebab-release-state-$current_version.env"
test -O "$release_state"
source "$release_state"
for disposable_dir in "$artifact_dir" "$unpacked_dir"; do
  case "$disposable_dir" in
    /tmp/tabkebab-*) ;;
    *) echo "Refusing unsafe cleanup path: $disposable_dir" >&2; exit 1 ;;
  esac
done
rm -rf -- "$artifact_dir" "$unpacked_dir"
rm -f -- "$notes_file"
while IFS= read -r pid; do
  [[ "$pid" =~ ^[0-9]+$ ]] || { echo "Invalid PID ledger entry" >&2; exit 1; }
  if kill -0 "$pid" 2>/dev/null; then
    echo "Matrix process still alive: $pid" >&2
    exit 1
  fi
done < "$matrix_pid_file"
rm -f -- "$matrix_pid_file" "$release_state"
```
- [ ] Record the dependency audit as not applicable: the repository still has no package/lockfile or production dependency. Finish the five-section closeout report with the model ledger and no unreported long-running process.

---

## Execution Review Checkpoints

- After Task 1, review the mock boundary before relying on it for destructive-operation tests.
- After Task 6, require Phase 1 release verification before beginning Drive schema migration.
- After Task 8, review the two-profile convergence truth table before export/import work consumes tombstones.
- After Task 11, require Phase 2 release verification before changing credential or provider lifecycles.
- After Task 13, review abort/non-overlap evidence before connecting Chrome AI to the same request lifecycle.
- After Task 15, no finding is complete until both its named automated test and applicable real-Chrome row pass.

## Plan Self-Review Checklist

- [x] Trace every one of the thirteen findings to at least one implementation task and named failing regression.
- [x] Confirm every approved design requirement appears in a task: restore counts/completion, audio cleanup, Focus run/status/URL/confidence/group/strict rules, host/hash safety, Drive retention/tombstones, export sanitization/rollback, checked messaging/search, passphrase unlock, AbortSignal retry lifecycle, and side-panel Prompt API.
- [x] Search this plan for unresolved placeholders or vague delegation markers; every file, interface, test, command, migration, and release gate is explicit.
- [x] Check interface consistency across tasks: `driveSyncTombstones`, `sendOrThrow`, provider signal as the third argument, Chrome AI port name/protocol, portable export kind/sections, and Focus decision shape do not change silently.
- [x] Confirm accepted ADRs 0001-0003 are referenced but not edited, Task 7 alone creates ADR 0004, and Chrome Web Store publication remains outside scope.
