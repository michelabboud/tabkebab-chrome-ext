# Task 13 Implementation Brief

## Objective

Implement the approved Task 13 slice from `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`: replace timeout-only `Promise.race()` behavior with one abort controller per provider attempt, wait for the aborted attempt to settle before retry, restrict automatic retries to typed transient failures, and thread the exact signal through every provider operation.

- Base commit: `TASK12_FINAL_COMMIT` (controller will replace before dispatch)
- Expected version/tag after controller closeout: `1.2.15`
- Finding: 13
- Phase checkpoint: Task 14 consumes the typed errors, signal contract, and `runAbortableAttempt()` without changing them
- Worktree: `/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening`
- Implementation report: `/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-13-report.md`

Start only from the controller-confirmed clean Task 12 commit. `TASK12_FINAL_COMMIT` is an intentional controller placeholder: the controller replaces it with the independently reviewed Task 12 commit, and the implementer verifies `git rev-parse HEAD` equals that hash before creating tests or production changes.

Read the approved design, ADRs 0001-0003, every later committed ADR, and the committed Task 12 report/interfaces before coding. Preserve Task 12's private/public settings split, atomic save/unlock behavior, encrypted-blob format, and checked runtime/UI responses. If the committed AI client differs from this brief, report the exact conflict rather than creating a parallel queue, error hierarchy, or provider registry.

Do not tag, push, publish a release, mutate `main`, or touch the parent checkout. The root controller owns those steps after independent review. Do not implement Task 14's named port, protocol validators, broker client, panel executor, reconnect policy, or Focus foreground fallback.

## Required files

Create:

- `core/ai/request-lifecycle.js`
- `tests/helpers/deferred.js`
- `tests/helpers/provider-double.js`
- `tests/fixtures/hanging-ai-server.js`
- `tests/ai/request-lifecycle.test.js`
- `tests/ai/queue.test.js`
- `tests/ai/provider-signals.test.js`

Modify only as needed within Task 13 scope:

- `docs/reports/2026-07-14-reliability-smoke.md`
- `core/ai/ai-client.js`
- `core/ai/queue.js`
- `core/ai/provider.js`
- `core/ai/provider-openai.js`
- `core/ai/provider-claude.js`
- `core/ai/provider-gemini.js`
- `core/ai/provider-custom.js`
- `core/ai/provider-chrome.js`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- the Task 13 checklist in the approved plan
- an existing dependency-free test helper only after a genuine missing boundary is demonstrated RED

Do not modify side-panel files, `service-worker.js` messaging contracts, Task 12 crypto/settings UI, `core/focus-ai.js`, or Chrome-AI broker files. The committed hanging server is manual smoke infrastructure only; it is never imported or started by the default test suite.

## Fixed lifecycle and error interfaces

Keep the approved names/signatures exactly:

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
export class AIMalformedResultError extends Error { code = 'AI_MALFORMED_RESULT'; }

// Existing classes gain stable codes without changing instanceof identity:
// AIDisabledError: AI_DISABLED
// AIAuthError: AI_AUTH
// AIRateLimitError: AI_RATE_LIMIT
// AINetworkError: AI_NETWORK
```

Every class sets a stable `name` and `code` on the instance. Preserve `AIRateLimitError.retryAfterMs`. Do not send stacks/raw provider bodies as typed error metadata. Task 13 defines `AIForegroundRequiredError` and `AIMalformedResultError` for stable retry classification and Task 14 consumption; it does not build the broker or broadly change completion parsing.

## `runAbortableAttempt()` state machine and exact order

Reject a non-function operation or a timeout that is not a positive finite integer before creating provider work. `externalSignal` is absent or an AbortSignal-like object supporting `aborted` and event subscription.

Each call owns a new `AbortController` and follows this order:

1. Validate arguments and create the controller.
2. If the external signal is already aborted, abort the new controller and throw `AIAbortError` without invoking `operation`.
3. Register one external-abort listener and one timeout. The first lifecycle cause to fire wins and cannot be overwritten.
4. Invoke `operation(controller.signal)` exactly once. The exact same signal object reaches the provider.
5. On timeout, record timeout ownership and abort that controller. On external cancellation, record external ownership and abort it.
6. Await the operation promise to settle after abort. Do not race ahead to a retry. If the operation swallows abort and resolves, the recorded timeout/external cause still wins and the late value is discarded.
7. After settlement, translate controller-owned timeout to `AITimeoutError` and external cancellation to `AIAbortError`. With no lifecycle cause, return the provider result or propagate its typed error; a raw `AbortError` becomes `AIAbortError`.
8. In `finally`, clear the timer and remove the external listener exactly once.

There is deliberately no secondary grace timeout that permits retry while the prior provider promise is still active. A provider that ignores abort leaves its queue item pending rather than starting a potentially billable overlapping attempt. Record that fail-safe behavior; do not hide it with another `Promise.race()`.

Success must clear the timer without aborting its signal. Synchronous throws, promise rejections, timeout, and external abort all run cleanup. Comparing captured signals proves every explicit attempt gets a distinct controller.

## Fixed queue contract and retry policy

Extend the existing constructor without changing `enqueue(fn)` callers:

```js
new AIQueue({
  maxConcurrent,
  minIntervalMs,
  maxRetries = 2,
  backoff = defaultBackoff,
  clock = Date.now,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
});
```

- `maxRetries` is a non-negative integer and counts retries after the first call. The default `2` means at most three total attempts.
- Only `AINetworkError` and `AIRateLimitError` retry automatically. Auth, disabled, unavailable, foreground-required, timeout, abort, malformed-result, and unknown errors reject after one attempt.
- `backoff(error, retryNumber)` receives retry number 1 then 2 and returns a finite non-negative millisecond delay. Reject an invalid backoff result rather than spinning.
- Preserve the existing default delays: rate-limit delay is `retryAfterMs * 2 ** (retryNumber - 1)` using the existing finite positive default; network delay is `2000 * retryNumber`.
- `clock()` controls minimum-interval calculation and `delay(ms)` owns both rate spacing and retry waits, allowing deterministic tests without wall-clock sleeps.
- A retry for one item is scheduled only after its prior `runAbortableAttempt()` has settled. The acceptance trace is `attempt1-aborted -> attempt1-settled -> retry-delay -> attempt2-started` with `maxActiveCount === 1`.
- Retry counters are per queue item. One item's failure cannot consume another item's budget.
- Cache writes occur only after a completed successful provider response. Timeout/abort/failed/late values never enter `AICache`.

Do not reduce global concurrency merely to make the non-overlap test pass. The guarantee is no overlapping attempts for the same queued request; independent queue items retain the configured concurrency.

## AIClient orchestration

- Keep the shipped request timeout at exactly `120_000` milliseconds.
- For a cache miss, enqueue a fresh closure. Each closure calls `runAbortableAttempt(signal => provider.complete(request, config, signal), 120_000)`, so every retry constructs a new controller only after the previous attempt settled.
- Never create the provider promise before entering the queue/attempt closure.
- Cache only the final successful response and preserve current `fromCache` behavior.
- `testConnection()` and `listModels()` each run their provider operation through their own `runAbortableAttempt()` controller and timeout. They are not queued/retried automatically.
- Preserve their current user-facing `false`/`[]` fallback only after any timeout/abort cleanup has settled. Do not catch a still-running provider and return early.
- Unknown provider/model availability is `AIUnavailableError`, not `AINetworkError`. Disabled configuration remains `AIDisabledError`.
- Preserve Task 12 key retrieval/settings behavior and do not place keys in error/log/cache evidence.

## Provider signal and error rules

For OpenAI, Claude, Gemini, and Custom:

- Every `fetch` for `complete`, `testConnection`, and `listModels` receives the exact supplied signal. This includes response-body consumption: an abort while reading `text()`/`json()` must still become `AIAbortError`.
- Detect `signal.aborted` or a native error named `AbortError` before any generic network wrapping/fallback.
- Abort is always `AIAbortError` and therefore non-retryable. Never convert it to `AINetworkError`, `false`, `[]`, or a hardcoded model fallback.
- Preserve existing auth and rate-limit mapping. Other transport/HTTP failures remain `AINetworkError` unless the operation's established public fallback intentionally converts the fully settled typed failure at the AIClient boundary.
- Do not expose authorization headers, keys, full response bodies, or raw exception stacks in messages/logs.

For Chrome AI in Task 13:

- Keep `core/ai/provider-chrome.js` as the current direct Prompt API executor. Task 14 moves orchestration to the side-panel document.
- Pass the same signal to Prompt API creation and prompting using the platform's signal option. An aborted create/prompt becomes `AIAbortError`.
- Destroy every created session exactly once in `finally` after success, abort, timeout, parse failure, or provider failure. A destroy failure must not replace the primary typed result/error.
- Missing API, unavailable model, download-required state, and unknown availability status become non-retryable `AIUnavailableError`. Do not “try anyway” after an unknown/failed availability result.
- Keep current completion result shape. Do not add Task 14 serialization/protocol constraints here.

## Test-only helper contracts

`tests/helpers/deferred.js` exports one dependency-free deferred primitive:

```js
export function deferred();
// { promise, resolve, reject }
```

`tests/helpers/provider-double.js` exports a provider double factory that records method calls/signals, active and maximum-active counts, and a deterministic event trace while delegating each method to supplied test operations. It must not install globals or hide controller creation:

```js
export function createProviderDouble({
  complete,
  testConnection,
  listModels,
} = {});
// { provider, calls, events, get activeCount(), get maxActiveCount() }
```

Helpers clone only safe request/config metadata needed by assertions. Never copy API keys into assertion failure output.

## Mandatory strict TDD sequence

Do not edit production AI lifecycle, queue, client, or providers until steps 1-8 exist and step 9 has produced genuine RED evidence.

1. Create `tests/helpers/deferred.js` and `tests/helpers/provider-double.js` with their own direct assertions exercised through the Task 13 tests.
2. Create `tests/ai/request-lifecycle.test.js`. Cover unique signals, success cleanup without abort, synchronous throw, provider rejection, timeout signal flip plus settlement ordering, external abort before start, external abort in flight, swallowed-abort late resolution, raw `AbortError` translation, first-cause ownership, and listener/timer cleanup.
3. Add the non-cooperative provider case: after timeout its signal is aborted but the returned promise remains pending; prove `runAbortableAttempt()` and its queue item remain pending and no later attempt starts. Resolve/reject it during test cleanup so the suite cannot hang.
4. Create `tests/ai/queue.test.js`. Cover success, exactly three attempts for network/rate limit, zero/one/custom retry limits, every non-retryable typed class plus unknown errors, per-item counters, invalid `maxRetries`/backoff, injected interval/retry timing, and independent-item concurrency.
5. Add the finding's decisive trace with deferred attempts: first timeout aborts, provider cleanup settles, then retry delay and attempt two begin; assert event order and `maxActiveCount === 1`.
6. Create `tests/ai/provider-signals.test.js`. For OpenAI, Claude, Gemini, and Custom, cover `complete`, `testConnection`, and `listModels` with exact fetch signal identity, abort during fetch, abort during body parsing, typed auth/rate/network preservation, and restoration of `fetch` in `finally`.
7. Add Chrome provider cases for signal identity at create/prompt, abort at each boundary, unavailable/download/unknown status, success result, and exactly-once destroy in every created-session exit path.
8. Add AIClient orchestration cases proving the provider promise is created inside each attempt, retry signals differ, attempt two starts after attempt one settles, timeout/abort never cache, success caches once, and `testConnection`/`listModels` wait for cleanup before returning fallback.
9. Run the focused suite against pre-change Task 12 code and preserve genuine RED output in `task-13-report.md`:

    ```bash
    bun test tests/ai/request-lifecycle.test.js tests/ai/queue.test.js tests/ai/provider-signals.test.js
    ```

    Expected RED causes are `Promise.race()` leaving provider work alive, retrying unknown/timeout errors, missing typed codes/signals, swallowed aborts in provider catches, and Chrome session cleanup/availability gaps.
10. Implement the minimum Task 13 production slice and make the focused suite GREEN. Do not create a Chrome-AI port/broker or change side-panel behavior.
11. Create `tests/fixtures/hanging-ai-server.js` only after the automated lifecycle contract is GREEN. It is committed manual smoke infrastructure, not production code.
12. Re-run the focused command and record exact pass/fail/expect counts.
13. Run every final gate freshly and record its output:

    ```bash
    bun --version
    bun test tests/ai/request-lifecycle.test.js tests/ai/queue.test.js tests/ai/provider-signals.test.js
    bun test
    bun test --coverage
    bun test tests/syntax.test.js
    git diff --check
    test "$(cat VERSION)" = "$(bun -e 'console.log((await Bun.file("manifest.json").json()).version)')"
    test -z "$(find . -maxdepth 1 -type f \( -name 'package.json' -o -name 'package-lock.json' -o -name 'bun.lock' -o -name 'bun.lockb' -o -name 'yarn.lock' -o -name 'pnpm-lock.yaml' \) -print)"
    git status --short
    ```

    Bun remains `1.3.11`; focused/full/coverage/syntax runs pass; `git diff --check` is clean; both versions equal `1.2.15`; no root package/lockfile exists. Record coverage honestly without inventing a repository-wide threshold.

Use injected clocks/delays and deferred promises rather than real backoff or 120-second waits in automated tests. Restore `fetch`, timers, clocks, Prompt API globals, queue/provider methods, and module stubs in `finally`. No test may leave an unresolved promise, listener, server, or timer.

## Hanging provider fixture

`tests/fixtures/hanging-ai-server.js` is a standalone Bun script with no package dependency:

- Bind `127.0.0.1` on port `0` so the OS selects a free port; print only the resulting loopback origin and never request headers/body.
- Answer CORS preflight and attach explicit CORS headers suitable for the disposable extension origin.
- Hold `POST /v1/chat/completions` until the client connection/request signal aborts. Count each start, connection abort, completion, current active request, and maximum simultaneous active requests exactly once.
- Expose `GET /metrics` returning only:

  ```json
  {
    "started": 0,
    "aborted": 0,
    "completed": 0,
    "active": 0,
    "maxActive": 0
  }
  ```

- Do not echo prompts, authorization, URLs beyond the fixed route, remote addresses, or bodies. Metrics contain counts only.
- Handle SIGINT/SIGTERM by stopping the server and settling held handlers without producing an unhandled rejection.
- The default `bun test` discovery must not execute or bind this fixture.

The implementation report records the exact start command, dynamically selected origin, process ID, and teardown command without logging any synthetic key/header.

## Real-Chrome timeout/non-overlap gate

Use the installed official Chrome for Testing, a disposable profile, the committed loopback fixture, and a synthetic Custom-provider configuration. No external provider or real credential is used.

1. Start the fixture, capture its dynamically selected loopback origin, and verify its PID/listener. Do not reuse an unverified fixed port.
2. Configure the unpacked extension's Custom provider to `<origin>/v1` through production settings, using no key or a non-secret synthetic value that is never printed.
3. Trigger one provider request and leave the shipped `120_000` ms timeout unchanged. Do not shorten production timeout for smoke convenience.
4. After the checked `AI_TIMEOUT` result, query redacted metrics and require exactly `started: 1`, `aborted: 1`, `active: 0`, and `maxActive: 1` before any retry/user action.
5. Confirm timeout made exactly one automatic attempt: `AITimeoutError` is non-retryable. Then perform one explicit user retry and observe `started: 2` while `maxActive` remains 1; let it settle/abort before cleanup.
6. Confirm no late first-attempt result enters cache, produces a success toast, or changes UI state. Capture only typed code, counts, ordering, and boolean cache/status checks.
7. Stop the fixture and every Chrome/Xvfb/CDP process. Remove the disposable profile and confirm zero matching listeners/processes/files remain.
8. Append exact Chrome/Bun builds, binary hash, redacted commands/results, event order, metrics, and cleanup to the smoke report.

If loopback CORS/extension access or the browser boundary is unavailable, record the exact blocker and do not substitute the provider double for this gate. Automated tests remain the authority for injected retry classes; real Chrome is the authority for actual fetch cancellation.

## Documentation, version, report, and commit

- Update `ARCHITECTURE.md` with the one-controller state machine, settle-before-retry invariant, typed retry taxonomy, provider signal propagation, and Task 14 consumption boundary.
- Update `CHANGELOG.md` and `PROGRESS.md` with only landed Task 13 behavior/evidence. Do not claim Chrome AI executes in the side panel or works without Task 14.
- Append the timeout/non-overlap browser evidence and full fixture cleanup to `docs/reports/2026-07-14-reliability-smoke.md`.
- Set `VERSION` and `manifest.json` to `1.2.15`.
- Close a Task 13 plan checkbox only after its named RED/GREEN, provider, documentation, or browser evidence exists.
- Write `task-13-report.md` in the established five sections: what was built; verification evidence with RED/GREEN/full-gate counts plus lifecycle traces/browser metrics; assumptions; concerns/adjacent observations; close-out confirmation. Include the retry matrix, signal identity/destroy table, fixture process/cleanup state, model/agent ledger, exact version comparison, full commit hash, and final clean-worktree result.
- Commit with author email `29182417+michelabboud@users.noreply.github.com` and trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- Leave the worktree clean and report the full commit hash. No tag, push, release, `main` mutation, parent-checkout mutation, production timeout change, real credential, or lingering fixture/browser process.

After independent review, the controller will tag/push `v1.2.15`, wait for exact-commit CI, and verify the remote tag target. Task 13 is not the Phase 3 GitHub release checkpoint.

## Approved checklist (complete Task 13 intent)

- The implementer starts from the controller-supplied reviewed Task 12 hash and preserves Task 12 credential/settings contracts.
- Every explicit provider attempt owns a new controller; timeout/external abort wins even if the provider resolves late, and lifecycle cleanup always runs.
- An aborted provider promise settles before a retry starts; a non-cooperative provider blocks retry instead of overlapping billable work.
- Only typed network/rate-limit failures retry, with default two retries/three attempts and deterministic injected policy tests.
- AIClient creates provider work inside each attempt, caches success only, and gives test/model calls their own abort lifecycle.
- Every provider operation receives the exact signal; abort during fetch/body/prompt is typed non-retryable abort.
- Chrome provider maps unavailable/download/unknown states correctly and destroys every created session, without implementing Task 14's broker.
- The committed loopback fixture is CORS-enabled, count-only, default-suite inert, dynamically ported, and fully stopped.
- Strict pre-change RED, focused GREEN, full Bun/coverage/syntax/whitespace/version/dependency gates, and honest coverage evidence are recorded.
- Real Chrome proves the unchanged 120-second timeout aborts one request, leaves zero active/overlap, never auto-retries timeout, and permits one later explicit request.
- No Task 14 protocol/port/panel executor, production dependency, build step, timeout shortcut, tag, push, or release is included.
- Architecture/changelog/progress, smoke evidence, version `1.2.15`, five-section report, model ledger, commit trailer, full hash, and clean worktree are complete before controller review.
