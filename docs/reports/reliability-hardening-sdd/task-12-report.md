# Task 12 Implementation Report

Date: 2026-07-19

Base: `2970c99f7284f080a7a0b3a0df401771c5944d99`

Target version: `1.2.14`

Commit: `7b0d41a9225f87a0e475363ae53ca11e7cb8b2ab`

## 1. What was built

- Added a strict public/private AI-settings boundary. Runtime settings expose
  key-presence and protection booleans but never encrypted blobs, decrypted
  keys, passphrases, or caller-supplied private provider configuration.
- Added provider-specific passphrase unlock with encrypted-blob fingerprints
  on decrypted session entries. Wrong passphrases and stale ciphertext fail
  without local or session mutation; browser restart/reload/update/disable
  requires unlock, while service-worker idle does not erase session storage.
- Replaced split settings/key writes with one validated, lock-owned operation:
  all replacements encrypt in memory, local settings commit once, and session
  entries batch once. A local failure changes neither store; a session failure
  returns saved-but-locked with valid encrypted data retained.
- Added strict worker request shapes, exact response envelopes, Custom endpoint
  TLS/origin binding, portable-import origin preservation, Gemini header
  authentication, provider/result secret-reflection rejection, legacy-cache
  update cleanup, and SHA-256 response-cache identities scoped to account,
  endpoint, prompts, model, and response options.
- Added one exclusive, generation-owned side-panel lifecycle for provider
  status, Save, Unlock, Test Connection, Load Models, and full refresh. Provider
  changes synchronously clear old passphrase input and stale settlements cannot
  submit or repaint against a newer selection.

## 2. Verification evidence

### Untouched baseline

Before adding Task 12 tests, the existing AI-adjacent and portable-worker suites
passed against the clean Task 11 commit under Bun `1.3.11`:

```text
bun test tests/core/portable-worker.test.js tests/core/focus-ai.test.js

33 pass
0 fail
178 expect() calls
```

### Mandatory pre-production RED

After adding the complete Task 12 tests, and before any production behavior was
changed, the combined focused command ran against the same clean Task 11 source:

```text
bun test tests/ai/ai-client-passphrase.test.js \
  tests/core/portable-worker.test.js

17 pass
51 fail
159 expect() calls
68 tests across 2 files
exit 1
```

The failures are the intended missing Task 12 behavior:

- provider-blob passphrase truth and fingerprint-bound session entries;
- restart unlock, exact typed wrong-passphrase handling, and stale-cache rejection;
- a fresh secret-free public settings projection;
- validated atomic protection transitions and committed-but-locked session failure;
- lock-aware availability and private provider-config reconstruction;
- exact AI runtime request/response shapes and worker FIFO ownership;
- removal of the split `setAIApiKey` action and caller-supplied provider config;
- save-first/locked-first UI behavior and the restart-unlock controls.

No production, documentation, version, manifest, or release file had changed at
this checkpoint. Synthetic keys and passphrases were generated at runtime and
were not printed or persisted in this report.

### Focused GREEN

```text
bun test tests/ai/ai-client-passphrase.test.js \
  tests/core/export-schema.test.js \
  tests/core/export-import.test.js \
  tests/core/portable-worker.test.js \
  tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js

188 pass
0 fail
1376 expect() calls
```

Two independent final reviewers returned a clean/non-blocking verdict on
functional tree `a32a08e93aecc03d7b7072294db159a39a35c9ab`. Independent
immutable reruns reported `165 pass / 0 fail / 1180 assertions` and `165 pass /
0 fail / 1227 assertions`; both prior UI ownership/stale-rejection probes pass.

### Full deterministic gates

After documentation and version freeze under Bun `1.3.11`:

```text
bun test: 640 pass / 0 fail / 3711 assertions
bun test --coverage: 640 pass / 0 fail / 3711 assertions
coverage: 61.29% functions / 57.40% lines
bun test tests/syntax.test.js: 2 pass / 0 fail / 101 assertions
git diff --check: pass
VERSION/manifest parity: 1.2.14 / 1.2.14
changed-file vendor credential signature scan: no matches
package/lockfile delta: none; repository still has neither
```

### Real-Chrome credential gate

The terminal tree-hash-guarded run used Chrome for Testing `148.0.7778.96`
(`adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f`)
and exact tracked tree `7c29fbde2adf2e68abbd391ea876a52639c34e3b`.

```text
full Chrome exit before relaunch: true
encrypted blob unchanged: true
local plaintext absent: true
install ID absent for passphrase-only save: true
restart session empty and provider locked: true
wrong passphrase rejected: true
correct passphrase unlocked: true
visible safe unlock success: true
provider runtime fields exact: true
intercepted provider requests: 1
authorization header matched: true
credential absent from URL/body/logs: true
other external requests: 0
runtime errors: 0
profile entries before cleanup: 336
cleanup assertion: profile removed and no matching Chrome process remains
```

The fixture generated credential material at runtime, never printed it,
intercepted the only provider request before network, and cleared extension
storage before removing the disposable browser profile and display.

## 3. Assumptions

- `chrome.storage.session` follows the documented Manifest V3 browser-session
  lifecycle: it survives worker suspension and clears on browser restart,
  extension reload/update, or disable. The real-Chrome exit/relaunch proves the
  full-restart boundary used by the user-facing Unlock flow.
- Task 12 preserves the existing provider call architecture. Abort lifecycle
  and Chrome Prompt API document brokering remain the explicitly separate Task
  13 and Task 14 slices.

## 4. Concerns and adjacent observations

- Arbitrary Custom endpoints remain constrained by the extension manifest's
  host permissions. Task 12 validates the stored endpoint and credential
  boundary; it does not widen host permissions.

## 5. Close-out confirmation

Implementation, regressions, two independent functional/security reviews,
tracked documentation/version, deterministic gates, and exact-tree terminal
Chrome proof are complete. Commit `7b0d41a9225f87a0e475363ae53ca11e7cb8b2ab`
has tree `7c29fbde2adf2e68abbd391ea876a52639c34e3b`, exactly matching the
terminal browser fixture. Annotated tag `v1.2.14` and `main` were atomically
pushed. GitHub Actions run `29686848868` completed successfully for that exact
commit; its test, coverage, syntax, and manifest jobs all passed.
