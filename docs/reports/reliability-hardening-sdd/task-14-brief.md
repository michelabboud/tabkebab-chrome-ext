# Task 14 Implementation Brief

## Objective

Implement the approved Task 14 slice from `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`: remove direct Chrome Prompt API execution from the Manifest V3 worker, broker Chrome Built-in AI through one named side-panel port with a strictly validated JSON-only protocol, preserve Task 13's abort-before-retry lifecycle, and make background Focus fail safely when no foreground broker exists.

- Base commit: `TASK13_FINAL_COMMIT` (controller will replace before dispatch)
- Expected version/tag after controller closeout: `1.2.16`
- Finding: 8
- Phase checkpoint: Task 15 consumes this foreground-only broker in the final exact-package matrix
- Worktree: `/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening`
- Implementation report: `/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-14-report.md`

Start only from the controller-confirmed clean Task 13 commit. `TASK13_FINAL_COMMIT` is an intentional controller placeholder: the controller replaces it with the independently reviewed Task 13 commit, and the implementer verifies `git rev-parse HEAD` equals that hash before creating tests or production changes.

Read the approved design, ADR 0002, every committed ADR through Task 13, and the committed Task 12/13 reports and interfaces before coding. The controller must have accepted Task 13's abort/non-overlap review checkpoint: a timed-out attempt aborts and settles before another starts, only typed network/rate-limit errors retry, and every provider method accepts the signal as its third argument. If the committed Task 13 behavior differs, report the exact conflict rather than adding a second timeout, retry queue, provider signature, or error hierarchy.

Preserve Task 4's run/URL/live-side-effect Focus guards, Task 11's checked request boundary, Task 12's public/private settings boundary, and Task 13's typed errors and request lifecycle. Do not tag, push, publish a release, mutate `main`, or touch the parent checkout. The root controller owns those steps after independent review. Task 14 is not the Phase 3 release checkpoint.

## Required files and hard scope boundary

Create:

- `core/ai/chrome-ai-protocol.js`
- `core/ai/chrome-ai-broker-client.js`
- `sidepanel/chrome-ai-broker.js`
- `tests/ai/chrome-ai-protocol.test.js`
- `tests/ai/chrome-ai-broker-client.test.js`
- `tests/sidepanel/chrome-ai-broker.test.js`
- `tests/integration/chrome-ai-focus.test.js`

Modify only as needed within Task 14 scope:

- `docs/reports/2026-07-14-reliability-smoke.md`
- `core/ai/ai-client.js`
- `core/ai/provider-chrome.js`
- `core/ai/provider.js`
- `service-worker.js`
- `sidepanel/panel.js`
- `GUIDE.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- the Task 14 checklist in the approved plan
- existing dependency-free port/provider helpers only after a genuine missing boundary is demonstrated RED

Do not modify cloud-provider transports, queue retry policy, request timeout duration, Focus policy/lifecycle rules, settings encryption, portable export/import, Drive behavior, CI, `package.cmd`, or release machinery. Task 15 owns packaging, final matrix, and publication. Do not add an offscreen document, hidden page, package/lockfile, dependency, DOM shim, build step, production failure hook, second runtime port protocol, new permission, or new ADR. ADR 0002 already fixes the supported document-context decision.

## Consumed Task 13 contracts

Consume rather than redefine the committed equivalents:

```js
export async function runAbortableAttempt(operation, timeoutMs, externalSignal);

provider.complete(request, config, signal);
provider.testConnection(config, signal);
provider.listModels(config, signal);

export class AIAbortError extends Error { code = 'AI_ABORTED'; }
export class AITimeoutError extends Error { code = 'AI_TIMEOUT'; }
export class AIForegroundRequiredError extends Error { code = 'AI_FOREGROUND_REQUIRED'; }
export class AIUnavailableError extends Error { code = 'AI_UNAVAILABLE'; }
export class AINetworkError extends Error { code = 'AI_NETWORK'; }
export class AIMalformedResultError extends Error { code = 'AI_MALFORMED_RESULT'; }
```

Task 14 does not wrap broker requests in another timer. `AIClient` continues to invoke the selected provider through Task 13's one `runAbortableAttempt()` per attempt. On timeout, that controller aborts the broker operation; the broker sends one cancel, waits for panel-side settlement, and lets Task 13 translate its own timeout to `AI_TIMEOUT` before the queue can start later work.

## Fixed broker interfaces and constants

Keep every approved name and value exactly:

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
} = {}); // returns { port, disconnect }
```

`core/ai/provider-chrome.js` remains the document-context Prompt API executor and exports a constructible `ChromeAIProvider` compatible with `new ChromeAIProvider()`. It keeps Task 13's `testConnection(config, signal)`, `complete(request, config, signal)`, and, if present, `listModels(config, signal)` signatures. No worker import graph may evaluate or call `LanguageModel`.

## Exact JSON-only protocol

Only these messages cross the named port:

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

Every envelope and nested record is a fresh own-property plain/null-prototype JSON value. Reject arrays where objects are required, sparse arrays, accessors, inherited/dangerous keys (`__proto__`, `constructor`, `prototype`), unexpected prototypes, cycles, functions, symbols, bigint, undefined, non-finite numbers, and unknown fields. Never pass an `AbortSignal`, provider config, API key, function, native error, stack, arbitrary parsed object, or Chrome object over the port.

### Request identity and payloads

- `requestId` is a canonical non-empty UUID string produced by `crypto.randomUUID()` and no longer than 64 characters. The worker creates it; callers never supply it.
- Availability request payload is exactly `{}`.
- Complete payload is exactly `{ request }`.
- `request` requires non-empty string `userPrompt` up to 200,000 characters, integer `maxTokens` from 1 through 8192, and finite numeric `temperature` from 0 through 2.
- Optional `systemPrompt` is a string up to 50,000 characters. Optional `responseFormat`, when present, is exactly `'json'`.
- Unknown or missing request fields reject. Adapt internal Chrome-AI call sites to supply the complete committed request shape; do not weaken the wire schema or invent caller-controlled protocol fields.

A malformed message without a valid request ID is ignored because there is no safe correlation target. A malformed request with a valid request ID receives one failed `chrome-ai/result` with `AI_MALFORMED_RESULT` and is not passed to a provider. Duplicate/late request IDs already active on the panel are malformed and do not replace existing work.

### Results and errors

- Availability success value is exactly a boolean.
- Completion success value is exactly `{ text, parsed, tokensUsed }`: `text` is a string, `parsed` is JSON-only and no deeper than 12, and `tokensUsed` is a non-negative safe integer.
- Measure the canonical completion value with `TextEncoder` and reject when its UTF-8 JSON serialization exceeds 2 MiB. Validate bounded own-property structure before serialization so a cycle/accessor/host object cannot reach an unbounded stringify.
- The only error codes are `AI_ABORTED`, `AI_TIMEOUT`, `AI_UNAVAILABLE`, `AI_FOREGROUND_REQUIRED`, `AI_NETWORK`, and `AI_MALFORMED_RESULT`. `message` is a user-safe string of at most 1,000 characters.
- `serializeChromeAIError()` preserves only an allowed typed code plus a safe bounded message. An unrecognized exception becomes exactly `{ code: 'AI_UNAVAILABLE', message: 'Chrome AI request failed.' }`. It never returns a cause, stack, name, raw exception field, prompt, or provider output.

`parseChromeAIRequest()` and `parseChromeAIResult()` are the only protocol validators. Both sides call them before provider work, promise resolution, or state mutation. They return canonical copies and never mutate inputs. A malformed result with a valid matching pending ID rejects that request as `AIMalformedResultError` and clears it; malformed/unknown/duplicate results without a matching pending ID are ignored.

## Worker-side broker-client state machine

`ChromeAIBrokerClient` owns one current port generation and a pending map keyed by UUID:

1. With no attached valid port, `testConnection()` and uncached `complete()` reject with `AIForegroundRequiredError` before creating a pending entry.
2. `attachPort(port)` accepts only the worker peer for `CHROME_AI_PORT_NAME`. Attaching a newer valid port rejects every old-generation pending request with `AI_FOREGROUND_REQUIRED`, detaches old listeners, advances generation, and installs exactly one message/disconnect listener set.
3. Every request gets a fresh `crypto.randomUUID()`, installs its pending entry and abort listener before `postMessage()`, then sends one validated request.
4. Matching valid results settle and remove exactly one entry. Unknown IDs, duplicates, old-generation results, and late results after cancellation are ignored.
5. Signal abort sends exactly one validated cancel for that request, removes/settles the worker pending entry, and surfaces Task 13's typed abort path. An already-aborted signal never posts a request.
6. Current-port disconnect rejects and clears every current pending request with `AIForegroundRequiredError`. A later disconnect from a replaced old port cannot clear the replacement or its pending work.
7. Explicit `disconnect()` removes listeners, rejects/clears pending work, disconnects the current port once, invalidates its generation, and is idempotent.

Structured error results reconstruct the matching Task 13 typed error so queue retry classification is preserved. In particular, foreground-required, timeout, abort, unavailable, and malformed errors remain non-retryable; only a genuine `AI_NETWORK` result can retain network classification.

Export exactly one `chromeAIBrokerClient` singleton. `AIClient` uses that exact instance as the Chrome provider, and `service-worker.js` calls `attachPort()` on that same imported instance. Do not create one instance in AIClient and another in the worker.

`AIClient.complete()` keeps its existing cache lookup before provider invocation. A valid cached Chrome classification may therefore reach Task 4's live Focus guard without a panel. An uncached request requires the broker. Selecting/configuring Chrome AI remains valid when the panel is absent; absence is an execution-context error, not a settings mutation.

## Panel broker and reconnect lifecycle

`startChromeAIBroker()` is dependency-injected, DOM-free orchestration:

1. Call `runtime.connect({ name: CHROME_AI_PORT_NAME })` once and bind only that port generation.
2. For each validated accepted request, create exactly one fresh `ChromeAIProvider` and one `AbortController`. Availability invokes its checked connection boundary; completion invokes `provider.complete(request, {}, signal)`. Provider configuration or secrets never cross from the worker.
3. Keep a panel pending map until provider settlement. A matching cancel aborts that controller exactly once; disconnect aborts every controller. Provider `finally` destroys any Prompt API session.
4. Before posting a result, confirm the request still belongs to the current live generation. Suppress late success/error after cancellation, disconnect, or replacement.
5. Validate/serialize every outbound result through the shared protocol functions. One accepted request produces at most one result message.

An unexpected disconnect while the panel controller remains live schedules reconnect delays of exactly 100 ms, 500 ms, then 1000 ms, with every later retry capped at 1000 ms. Keep at most one reconnect timer. A successful reconnect resets the backoff. A disconnect callback from an old generation cannot schedule over or clear the current connection.

The returned explicit `disconnect()` marks the panel broker closed, cancels a pending reconnect timer, aborts/cleans all work, disconnects the current port once, and permanently prevents reconnect. `sidepanel/panel.js` starts exactly one broker instance for the panel lifetime and invokes explicit teardown on the panel's terminal lifecycle event. It does not start one broker per AI action or view refresh.

## Service-worker and Focus behavior

- Register one `chrome.runtime.onConnect` listener. It calls `chromeAIBrokerClient.attachPort(port)` only for exact `CHROME_AI_PORT_NAME` and ignores every other port without disconnecting unrelated extensions/features.
- Do not send broker traffic through Task 11's `sendOrThrow()`; this is a long-lived port protocol.
- The service worker performs no direct `LanguageModel`, `self.ai.languageModel`, Prompt API create/prompt, or panel-opening action.
- Uncached background Focus classification with Chrome AI selected and no broker treats `AIForegroundRequiredError` as a safe skip: it does not call `handleDistraction()`, mutate a tab/counter/cache, open UI, or reclassify the error as retryable network failure.
- A valid existing cache entry still passes Task 4's confidence predicate and point-of-side-effect run/status/tab/URL guard without contacting the broker.
- Other provider failures retain Task 13 behavior. Do not broadly swallow typed errors or weaken foreground panel actions.

## Mandatory strict TDD sequence

Do not edit production behavior until steps 1-8 exist and step 9 has produced genuine RED evidence. A missing module/export syntax failure is acceptable RED; a passing Task 13 signal test is prerequisite evidence, not Task 14 regression evidence.

1. Create `tests/ai/chrome-ai-protocol.test.js`. Cover every exact envelope/method/key/type/UUID/prompt/range/depth/UTF-8-byte/error-code/message limit at the boundary and max-plus-one. Cover dangerous/inherited/accessor/cyclic/non-JSON values, canonical copies, and input immutability.
2. Create `tests/ai/chrome-ai-broker-client.test.js`. Cover absent panel, exact named-port attachment, unrelated-port ignore, availability/completion, fresh UUIDs, concurrent out-of-order correlation, structured typed errors, malformed matching results, unknown/duplicate/late result ignore, already-aborted and later-aborted signals, and exact one cancel.
3. Add worker generation races: replacement rejects old pending work, new requests use the replacement, old results/disconnect cannot affect it, current disconnect rejects every pending request with foreground-required, and explicit disconnect is idempotent.
4. Create `tests/sidepanel/chrome-ai-broker.test.js`. Cover availability/completion, one provider/controller per accepted request, exact whitelisted results, known/unknown exception serialization, malformed request response/ignore rules, cancel-to-controller abort, disconnect cleanup, late-result suppression, and one-result maximum.
5. Add panel reconnect cases with injected scheduler: unexpected disconnect uses 100/500/1000/1000 delays, never has two timers, success resets backoff, stale disconnect is harmless, and explicit teardown cancels/permanently stops reconnect.
6. Add Task 13 timeout integration across both broker maps. Assert timeout aborts the exact worker signal, emits one cancel, aborts/destroys panel work, waits for settlement, rejects as `AI_TIMEOUT`, leaves both maps empty, and records settlement before any later attempt starts.
7. Create `tests/integration/chrome-ai-focus.test.js`. Prove uncached background Focus plus no broker is a foreground-required safe skip with zero `handleDistraction()`/tab mutation/cache write. Separately seed a valid cached high-confidence decision and prove it still reaches the live Focus guard without a broker.
8. Add singleton/import-graph and worker routing tests: AIClient and `onConnect` use the same instance, only the named port attaches, provider-chrome is constructed only in the panel broker, no signal/config/raw error crosses messages, and test cleanup calls singleton `disconnect()`.
9. Run the focused suite against the pre-change Task 13 tree and preserve genuine RED output in `task-14-report.md`:

    ```bash
    bun test tests/ai/chrome-ai-protocol.test.js tests/ai/chrome-ai-broker-client.test.js tests/sidepanel/chrome-ai-broker.test.js tests/integration/chrome-ai-focus.test.js
    ```

    Expected RED causes include missing protocol/client/broker modules, direct worker `LanguageModel` execution, absent foreground-required correlation, and no cancel/reconnect lifecycle.
10. Implement the minimum Task 14 production slice needed to make the focused suite GREEN. Do not change Task 13 timeouts/retry classes or implement Task 15 packaging/release work.
11. Re-run the focused command and record exact pass/fail/expect counts.
12. Run every final gate freshly and record its output:

    ```bash
    bun --version
    bun test tests/ai/chrome-ai-protocol.test.js tests/ai/chrome-ai-broker-client.test.js tests/sidepanel/chrome-ai-broker.test.js tests/integration/chrome-ai-focus.test.js
    bun test
    bun test --coverage
    bun test tests/syntax.test.js
    git diff --check
    test "$(cat VERSION)" = "$(bun -e 'console.log((await Bun.file("manifest.json").json()).version)')"
    test -z "$(find . -maxdepth 1 -type f \( -name 'package.json' -o -name 'package-lock.json' -o -name 'bun.lock' -o -name 'bun.lockb' -o -name 'yarn.lock' -o -name 'pnpm-lock.yaml' \) -print)"
    git status --short
    ```

    Bun remains `1.3.11`; focused/full/coverage/syntax runs pass; `git diff --check` is clean; both versions equal `1.2.16`; no root package/lockfile exists. Before commit, status contains only approved Task 14 files; after commit it is empty. Record changed-module coverage honestly without inventing a repository-wide threshold.

Use Task 1's peer-only runtime port mock and Task 13's deferred/provider doubles. Add only narrowly missing call/generation observability. Restore singleton state, UUID, schedulers, controllers, provider factories, ports, globals, and module stubs in `finally`. No DOM emulator, real Prompt API, network, lingering timer, or test-order dependence belongs in Bun tests.

## Proportional real-Chrome Prompt API gate

Use an installed supported official Chrome build, one disposable profile, the real side-panel document, and synthetic non-sensitive prompts. Do not use a cloud provider, API key, private tab URL, or production failure hook.

1. Open the side panel and prove one named broker port is connected. Query real Prompt API availability through the broker and record the exact supported/unsupported status without logging prompt contents.
2. If the model is already available, perform one completion through the production AIClient/broker/provider path and verify the bounded `{ text, parsed, tokensUsed }` shape plus session destruction. Do not silently download a model or claim completion when status is only downloadable/unavailable.
3. Start another request, then close the panel. Require panel controller/session cleanup, one checked foreground-required/cancel outcome, zero late result, and no active pending entry.
4. With the panel closed, trigger an uncached background Focus classification and prove no tab, distraction counter, or Focus state mutation occurs. Reopen the panel and confirm reconnect restores foreground execution without restarting Chrome.
5. Record Chrome build/hash, Prompt API status, exact tested commit/tree, correlation/cancel/pending counts, redacted results, and cleanup in `docs/reports/2026-07-14-reliability-smoke.md`.
6. Remove the disposable profile and prove Chrome/Xvfb/CDP processes/listeners, broker timers, and temporary files are gone.

If the installed browser/model does not support a real completion, record the exact availability blocker and do not claim that subcase passed. Automated protocol/port/Focus tests remain valid evidence, but they are not a substitute for a supported Prompt API completion required by the final matrix.

## Documentation, version, report, and commit

- Update `GUIDE.md` with Chrome AI's foreground-only requirement, panel-close behavior, reconnect expectation, and safe background Focus skip.
- Update `ARCHITECTURE.md` with ADR 0002's document executor, singleton worker client, named JSON-only protocol, validation/resource bounds, port generations, cancel/reconnect lifecycle, and Task 13 timeout composition.
- Update `CHANGELOG.md` and `PROGRESS.md` with only landed behavior and actual automated/browser evidence. Do not mark the final matrix or initiative complete; Task 15 owns final verification and publication.
- Append redacted Task 14 browser evidence and complete cleanup to `docs/reports/2026-07-14-reliability-smoke.md`.
- Set `VERSION` and `manifest.json` to `1.2.16`.
- Close a Task 14 plan checkbox only after its named RED/GREEN, protocol, race, timeout, Focus, documentation, or real-browser evidence exists.
- Write `task-14-report.md` in five sections: what was built; verification evidence with RED/GREEN/full-gate counts and Prompt API/browser evidence; assumptions; concerns/adjacent observations; close-out confirmation. Include protocol boundary tables, generation/cancel/reconnect timelines, typed-error mapping, singleton proof, pending-map cleanup, browser support status, model/agent ledger, exact version comparison, full commit hash, and final clean-worktree result.
- Commit with author email `29182417+michelabboud@users.noreply.github.com` and trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- Leave the worktree clean and report the full commit hash. No tag, push, release, `main` mutation, parent-checkout mutation, real credential, cloud-provider call, model download, dependency, or build artifact.

After independent review, the controller will tag/push `v1.2.16`, wait for exact-commit CI, and verify the remote tag target. Task 14 is not a GitHub release checkpoint.

## Approved checklist (complete Task 14 intent)

- The implementer starts from the controller-supplied reviewed Task 13 hash and consumes its signal/error/non-overlap contracts unchanged.
- Fixed constants/interfaces, JSON-only envelopes, request/result/error limits, canonical validation, and secret/raw-object exclusions are exact.
- One singleton client correlates out-of-order work, isolates port generations, cancels on abort, rejects on disconnect, and ignores stale/duplicate results.
- The panel creates one provider/controller per accepted request, destroys sessions, suppresses late results, and reconnects at 100/500/1000 ms until explicit teardown.
- Prompt API code executes only in the side-panel document; the worker attaches only the named port and never opens UI or touches `LanguageModel`.
- Task 13 timeout emits one cancel, waits for both sides to settle, leaves no pending work, and never overlaps a later attempt.
- Uncached background Focus without a broker safely skips; a valid cached decision may still reach Task 4's live guard.
- Strict pre-change RED, focused GREEN, full Bun/coverage/syntax/whitespace/version/dependency gates, and honest coverage evidence are recorded.
- Supported real Chrome proves foreground availability/completion, panel-close cancellation, reconnect, background skip, and cleanup; unsupported status is reported honestly without a false completion claim.
- Guide/architecture/changelog/progress, smoke evidence, version `1.2.16`, five-section report, model ledger, commit trailer, full hash, and clean worktree are complete before controller review.
- No offscreen document, second protocol/timer, Task 15 packaging/release work, dependency, build step, tag, push, release, Chrome Web Store action, or scope drift is included.
