# Task 14 Implementation Report

Date: 2026-07-19

Base: `14d19008872984306235805efe85f4dd8a66ad1b` (`v1.2.15`)

Target version: `1.2.16`

Commit: `13cc0d5442789abb5269558a28ee3b727a251b2e`

Tag: `v1.2.16`

Exact-commit CI: GitHub Actions run `29692667393` — success

## 1. What was built

- Moved Chrome Prompt API execution out of the Manifest V3 worker. `AIClient`
  and `service-worker.js` share the exact exported `chromeAIBrokerClient`
  singleton, while `sidepanel/panel.js` starts one document broker.
- Added the fixed `tabkebab:chrome-ai` long-lived port protocol. The worker
  accepts only that port name; the panel constructs one fresh
  `ChromeAIProvider` and `AbortController` for each accepted request.
- Added strict canonical request/result/error validation, generation-aware
  correlation, cancellation cleanup barriers, physical reconnect-timer
  teardown, stale-event isolation, safe typed error rehydration, ordered
  owner/standby failover, and a settle-before-activate handoff for ordinary
  port replacement.
- Added one extension-origin exclusive Web Lock around panel provider
  construction through settlement. Multiple side-panel documents therefore
  cannot overlap Prompt sessions; an active-port-loss promotion queues behind
  old-document cleanup, and missing Web Locks fails closed before construction.
- Made duplicate valid or malformed active IDs abort the original correlation,
  retain its provider-cleanup barrier, and emit exactly one typed malformed
  terminal result. A cancellation that arrived first remains authoritative.
- Preserved Task 13 as the only timeout/retry owner. A timeout sends exactly one
  broker cancel, waits for panel provider/session settlement, and only then
  exposes `AI_TIMEOUT`, so a later attempt cannot overlap the old session.
- Made an absent panel an execution-context failure rather than a settings
  mutation. Uncached background Focus safely skips; a valid cache entry may
  still reach the existing live run/tab/URL guard.

### Protocol boundary

| Boundary | Accepted shape or bound |
|---|---|
| Port | exactly `tabkebab:chrome-ai` |
| Request ID | canonical lowercase RFC 4122 version-4 UUID |
| Request envelopes | `chrome-ai/request` or `chrome-ai/cancel`, exact own fields |
| Complete request | non-empty user prompt up to 200,000 chars; system prompt up to 50,000; tokens 1–8192; temperature 0–2; optional `json` format |
| Success | availability boolean or exact `{ text, parsed, tokensUsed }` |
| Parsed result | JSON-only, depth at most 12, no repeated identity |
| Completion size | canonical UTF-8 JSON at most 2 MiB |
| Error | allowlisted code plus safe message at most 1,000 chars |

Accessors, inherited/unknown/dangerous keys, sparse or extended arrays,
unexpected prototypes, symbols, functions, bigint, undefined, non-finite
numbers, cycles, repeated object identities, raw errors, stacks, causes,
signals, provider configuration, and Chrome objects never cross the port.

### Typed-error mapping

| Wire code | Worker error |
|---|---|
| `AI_ABORTED` | `AIAbortError` |
| `AI_TIMEOUT` | `AITimeoutError` |
| `AI_UNAVAILABLE` | `AIUnavailableError` |
| `AI_FOREGROUND_REQUIRED` | `AIForegroundRequiredError` |
| `AI_NETWORK` | `AINetworkError` |
| `AI_MALFORMED_RESULT` | `AIMalformedResultError` |

Unknown, spoofed, hostile, or oversized panel exceptions serialize exactly to
`AI_UNAVAILABLE` with `Chrome AI request failed.`.

### Generation, cancel, and reconnect timeline

1. The panel connects once; the worker assigns a new generation.
2. A validated request installs its worker pending entry before posting and its
   panel pending entry before provider work.
3. Task 13 abort marks the worker entry cancelling and posts one cancel.
4. The panel aborts its exact controller and waits for provider `finally` to
   destroy the Prompt API session.
5. Any matching terminal result, including a malformed terminal envelope,
   clears the worker cleanup barrier while cancellation retains first cause.
6. Port replacement cancels the old generation, keeps the candidate inactive,
   and switches only after old terminal cleanup. Calls during handoff fail
   foreground-required. Every connected older panel remains a standby.
7. Active-port loss rejects that generation and promotes the newest live
   standby. Its provider waits on the origin lock until old-document cleanup;
   no severed transport acknowledgement is assumed.
8. Duplicate active IDs record one malformed first cause, abort once, and post
   one terminal failure only after cleanup. A prior cancellation still wins.
9. An unexpected worker loss aborts local work, then reconnects after 100, 500,
   then 1,000 ms capped only after cleanup; success resets backoff. Terminal
   panel teardown clears the actual timer, aborts work, disconnects once, and
   permanently stops reconnect.

## 2. Verification evidence

### Regression-first evidence

- Root worker/singleton integration began RED at `0 pass / 2 fail`.
- Protocol began with a missing-module RED (`0 / 1 / 1`) and later exposed UUID,
  empty-message, repeated-reference, high-node, and fail-fast allocation gaps.
  The final protocol slice is `31 pass / 0 fail / 370 assertions`.
- Panel orchestration began with a missing dependency and then failed provider,
  availability-union, duplicate-ID, timer-cancellation, and malformed-duplicate
  cases before repair.
- Independent broker review reproduced a cancel/result crossing hang and a
  matching malformed-result cancellation hang. The two lifecycle regressions
  were RED together at `38 pass / 2 fail / 147 assertions`; both now settle,
  clear the pending map, and preserve cancellation as first cause.
- An intermediate malformed-active-ID repair followed the literal same-ID
  error rule, but final end-to-end review proved that response terminated the
  original correlation early. Duplicate valid/malformed active IDs and both
  port-loss/replacement provider-overlap cases were reproduced RED together at
  `18 pass / 4 fail / 99 assertions`; the replacement-only reproduction also
  observed the old signal un-aborted with two active providers.
- Final adversarial review then found the combined replacement-plus-disconnect
  branch and a stranded still-open panel. Their preserved repair RED was `47
  pass / 5 fail / 211 assertions` across client, panel, and integration tests;
  the isolated combined race was `0 / 1 / 3` and settled the new request while
  old cleanup remained blocked. The repaired cases keep the candidate, promote
  an older standby, queue both behind the shared lock, and hold maximum active
  provider count at one.

### Current deterministic gates

```text
Bun: 1.3.11
Task 14 focused: 85 pass / 0 fail / 620 assertions
full suite: 854 pass / 0 fail / 4804 assertions
coverage suite: 854 pass / 0 fail / 4804 assertions
coverage: 71.07% functions / 67.55% lines
syntax: 2 pass / 0 fail / 116 assertions
git diff --check: pass
VERSION / manifest.json: 1.2.16 / 1.2.16
root package or lockfiles: none
```

The singleton/import-graph integration proves `service-worker.js` and
`ai-client.js` do not import `provider-chrome.js` or reference `LanguageModel`;
the document executor is imported only by `sidepanel/chrome-ai-broker.js`.
Timeout integration leaves the worker pending map empty, reuses the same panel
request ID only after cleanup, records first settlement before the next start,
and observes maximum active provider count one.

### Independent review

- Protocol reviewer: clean; `31/0/370`, protocol plus client `57/0/458`, 2,000
  randomized conforming JSON values accepted, and the former 12-level shared
  DAG rejected in `0.01s` at approximately 39 MiB RSS.
- Broker reviewer: clean at the earlier slice; exact focused rerun `77/0/556`, including cancel and
  malformed terminal races, reconnect timer cancellation, generations,
  duplicate IDs, singleton routing, and Focus behavior.
- Final cross-boundary reviewer: initially requested changes after reproducing
  same-ID early termination, max-active-two combined port loss/replacement, and
  a stranded still-open panel. The repairs add direct client-panel regressions
  for every branch; terminal rereview is clean at `85/0/620`.
- Web Locks reviewer: origin-wide coordination, queued abort, held-lock cleanup,
  missing-lock fail-closed behavior, and document failover are clean at
  `85/0/620`. Its test-fidelity note corrected mock release ordering before
  result settlement; its documentation finding produced append-only ADR 0005.

### Real-Chrome gate

Chrome for Testing `148.0.7778.96` (SHA-256
`adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f`)
passed the exact functional tree
`df1a7569b67a14c1e3bffc22ecbdb12c767fcf3e` for real Web Locks, named-port
connect/reconnect, newest-owner routing, older-panel standby promotion,
closed-panel foreground-required handling, background Focus no-mutation,
panel reopen, zero external requests/runtime errors, and complete disposable
cleanup. The real Prompt API existed but returned exact status `unavailable`.
No model download was started, so real completion and close-during-active-
completion were not attempted and remain unpassed for Task 15.

After the tracked documentation evidence was frozen, the identical browser
gate passed again against the terminal staged tree
`bf9e60cc9e6c941c5fb63a6996ab610864b66823`. Its redacted counters were two
loopback requests, zero other external requests, zero runtime errors, zero
pending broker requests, zero remaining profile processes, and successful
profile/Xvfb/loopback cleanup. Recording this hash here does not recursively
change the tracked tree.

The first harness attempt failed before product assertions because dynamic
`import()` is prohibited in `ServiceWorkerGlobalScope`; all disposable state
was still removed. The harness was corrected gitdir-locally to observe the real
port through a CDP page probe and existing production runtime actions, with no
tracked test hook. A second attempt found that a panel-initiated raw
`Port.disconnect()` does not deliver the local event needed to emulate worker
loss; the final harness dispatches that synthetic browser event through its
wrapped port while physically disconnecting the raw peer. That final run passed
and is described accurately as CDP-synthetic port loss, not a real worker
termination.

## 3. Assumptions

- Task 13's `runAbortableAttempt()` remains the only timeout owner.
- A terminal message produced by the panel broker is emitted only after its
  provider promise and session cleanup settle; when cancellation already owns
  the attempt, its typed cause wins even if the terminal envelope is malformed.
- Duplicate traffic carrying an active correlation ID marks the existing
  correlation malformed and aborts it; the one matching result is emitted only
  after cleanup, so it cannot be misidentified as an early acknowledgement.
- Supported Chrome exposes Web Locks to extension documents. The implementation
  deliberately fails closed before provider construction when that coordination
  API is absent; it never falls back to a realm-local mutex.
- The installed Chrome may legitimately lack an already available on-device
  model. In that case availability, port lifecycle, foreground-required Focus
  safety, and cleanup remain testable, while real completion stays explicitly
  unpassed for Task 15's supported-browser matrix.

## 4. Concerns and adjacent observations

- Prompt API support depends on the official Chrome build, operating system,
  hardware/storage policy, feature availability, and an installed model.
  TabKebab intentionally refuses to trigger a silent model download.
- The real Google Drive fixture remains separate and unpassed. No OAuth token,
  AI key, private URL, prompt text, or provider output is recorded here.
- Task 15 still owns final packaging, the complete operator smoke matrix,
  Windows package parity, and the Phase 3 GitHub release.
- The Task 14 brief said not to add an ADR because ADR 0002 fixed the foreground
  document choice. Final review correctly identified the later owner/standby
  Web Locks design as a separate concurrency decision. Michel's canonical
  global ADR rule takes precedence, so ADR 0005 records it without rewriting
  ADR 0002.

### Agent ledger

| Agent | Role | Result |
|---|---|---|
| Root Codex (model identifier not exposed) | Integration, TDD repairs, docs, gates, release | Complete |
| Protocol implementation agent | Protocol and adversarial resource bounds | Complete, no commit |
| Worker-client agent | Correlation, cancellation, generation state | Complete, no commit |
| Panel-broker agent | Provider/controller and reconnect state | Complete, no commit |
| Independent protocol reviewer | Read-only boundary/resource review | Clean |
| Independent broker reviewer | Read-only lifecycle/integration review | Clean on initial slice |
| Final cross-boundary reviewer | Read-only replacement/disconnect/duplicate review | Clean at `85/0/620` |
| Web Locks reviewer | Read-only cross-document serialization review | Clean; mock ordering repaired; ADR finding closed |
| Browser-harness agent | Gitdir-only real-Chrome harness | Complete |

All agent changes were visible in the shared worktree; only the root controller
owns commits, tags, pushes, CI, and release closeout.

## 5. Close-out confirmation

The documentation-updated terminal tree rerun passed. Commit
`13cc0d5442789abb5269558a28ee3b727a251b2e`, annotated tag `v1.2.16`, and
remote `main` all resolve to the exact tested tree. GitHub Actions run
`29692667393` succeeded for that exact commit. The unsupported real Prompt
completion subcases remain explicit Task 15 blockers.
