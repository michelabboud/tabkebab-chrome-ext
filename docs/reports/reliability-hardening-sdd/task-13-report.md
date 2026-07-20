# Task 13 Implementation Report

Date: 2026-07-19

Base: `7b0d41a9225f87a0e475363ae53ca11e7cb8b2ab` (`v1.2.14`)

Target version: `1.2.15`

Commit: `14d19008872984306235805efe85f4dd8a66ad1b`

Tag: `v1.2.15`

Exact-commit CI: run `29689191599` (`success`)

## 1. What was built

- Added a one-controller `runAbortableAttempt()` lifecycle. Timeout and external
  cancellation abort the exact provider signal, wait for provider cleanup to
  settle, then return stable typed `AI_TIMEOUT` or `AI_ABORTED` failures.
- Restricted automatic retry to typed network/rate-limit failures, with two
  retries by default (three total attempts), injected timing dependencies, and
  deterministic same-attempt settlement/non-overlap proof.
- Threaded identical signals through OpenAI, Claude, Gemini, Custom, and Chrome
  Prompt API operations. Abort is never wrapped as retryable network failure;
  Chrome availability is typed unavailable and every created session is
  destroyed before settlement.
- Moved the abort lifecycle inside AIClient's queued attempt closure so every
  retry receives a fresh controller. Connection tests and model lists use the
  same lifecycle, successful completion alone is cached, and safe typed
  categories survive core sanitization.
- Added a committed loopback-only CORS hanging endpoint with redacted
  starts/aborts/active/max-active metrics for the terminal Chrome proof.

## 2. Regression-first evidence

### Request lifecycle

Initial RED: missing module (`0 pass / 1 fail / 1 error`). Final lifecycle GREEN:
`18 pass / 0 fail / 76 assertions`.

### Queue and non-overlap

Initial RED: `5 pass / 16 fail / 35 assertions`. Additional configuration
boundary REDs were `21 pass / 6 fail / 58 assertions` plus one unsafe-integer
failure. Final queue GREEN: `28 pass / 0 fail / 65 assertions`.

### Providers

Initial signal/abort RED: `0 pass / 37 fail / 68 assertions`. The lazy body-read
race regression was RED at `37 pass / 8 fail`; all eight HTTP JSON/error-text
reads had started after cancellation. A Chrome local-error classification
regression was RED at `45 pass / 1 fail`. All are repaired: body parsing is
lazy after the abort precheck, and unknown local Prompt API errors remain
non-retryable rather than becoming network transport failures.

### AIClient integration

Initial RED: `0 pass / 4 fail / 14 assertions`, proving missing provider signals
and retries of non-retryable/unknown failures. Final GREEN: `4 pass / 0 fail / 46
assertions`.

## 3. Current deterministic verification

```text
Task 13 focused: 129 pass / 0 fail / 458 assertions
Task 12 compatibility: 146 pass / 0 fail / 1044 assertions
full suite: 769 pass / 0 fail / 4177 assertions
coverage suite: 769 pass / 0 fail / 4177 assertions
coverage: 69.93% functions / 66.11% lines
syntax: 2 pass / 0 fail / 109 assertions
git diff --check: pass
```

The final tracked tree is
`be3cc89c6216a97b8b5ec975b6fe8e88487795bd`. `VERSION` and `manifest.json`
both declare `1.2.15`; Bun is `1.3.11`; no package manifest, lockfile,
dependency, credential, or secret artifact was added. The full and syntax
gates were rerun after the final documentation-only correction.

## 4. Preliminary real transport proof

The committed hanging fixture was started on an ephemeral `127.0.0.1` port and
called through the actual Custom provider plus `runAbortableAttempt()` with a
short controller-only diagnostic timeout. The typed result was `AI_TIMEOUT` and
the redacted metrics were exactly:

```json
{"requestStarts":1,"connectionAborts":1,"activeRequests":0,"maxActiveRequests":1}
```

This confirms Bun's real request disconnect signal and the fixture accounting;
it is not the mandatory browser proof. The terminal Chrome run keeps the
shipped 120-second timeout unchanged, then observes one later explicit retry.

## 5. Independent review and terminal browser gate

Two independent functional reviews passed without findings on repaired tree
`e95cb671ffb6c60a18f34a354e04b97012bf287a`: lifecycle/AIClient
(`219 pass / 0 fail / 1237 assertions`) and retry/provider
(`129 pass / 0 fail / 458 assertions`). A final metadata audit found one
premature documentation claim; the four-line wording correction produced the
final tree above, which passed the complete deterministic gates again.

The gitdir-local `task-13-browser-smoke.js` loads the real unpacked extension,
configures the committed loopback fixture through the production AI Settings
UI, waits for the unchanged 120-second timeout, verifies one aborted and zero
active requests with `maxActiveRequests === 1`, then starts one distinct
explicit retry. It blocks every non-fixture HTTP(S) request and validates
browser, server, Xvfb, process, and profile cleanup.

The terminal run passed against the exact final tree:

```json
{
  "testedTree": "be3cc89c6216a97b8b5ec975b6fe8e88487795bd",
  "chromeVersion": "Google Chrome for Testing 148.0.7778.96",
  "chromeSha256": "adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f",
  "productionConnectionActionElapsedMs": 120070.04266800001,
  "productionTimeoutElapsedMs": 119898.658744,
  "timeoutFallbackObserved": true,
  "firstRequestStarts": 1,
  "firstConnectionAborts": 1,
  "completedRequests": 0,
  "firstActiveRequests": 0,
  "maxActiveRequests": 1,
  "explicitRetryObserved": true,
  "explicitRetryDisconnected": true,
  "finalActiveRequests": 0,
  "fixtureRequestsObservedByChrome": 2,
  "otherExternalRequests": 0,
  "runtimeErrors": 0,
  "profileEntriesBeforeCleanup": 347,
  "profileRemoved": true,
  "remainingProcesses": 0,
  "xvfbExited": true,
  "fixtureExited": true
}
```

## 6. Close-out confirmation

Implementation, review, deterministic verification, metadata/secret audit, and
the exact-tree Chrome proof are complete. Commit `14d1900`, annotated tag
`v1.2.15`, and `main` were atomically pushed; remote branch and peeled tag both
resolve to the exact commit. Exact-commit CI run `29689191599` passed all test,
coverage, and syntax steps in 23 seconds.
