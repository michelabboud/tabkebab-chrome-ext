# Task 3 Close-out Report

## 1. What was built

- Added `core/focus-policy.js` as the dependency-free source of truth for legacy and typed domain entries, canonical exact URLs, current Chrome-group IDs rebound by exact title, internal-page safety, and deterministic blocking decisions.
- Made Focus startup and navigation share the exported `isAllowed()` predicate. Strict mode with an empty allowlist now blocks every non-internal URL, while non-strict empty mode treats every eligible tab as focus.
- Made startup query live Chrome groups exactly once before reading or mutating tabs. Kebab and stash affect only background non-focus tabs, group affects only eligible focus tabs, and internal Chrome/extension pages are excluded from all startup actions.
- Rebound active and paused stored runs during service-worker initialization and immediately before resume. Rebinding replaces stale scalar/runtime IDs; a failed startup group query persists a sanitized title-based run with no numeric authority.
- Added a shared worker-startup readiness barrier: new-tab and navigation listeners register synchronously, wait for rebinding, and then enforce the event instead of dropping pre-ready strict navigations. Cache, storage, alarm, and message reads expose no numeric group authority until live lookup succeeds.
- Made numeric group authority durable only after its exact storage write succeeds. Pending or failed persistence keeps cache, storage-change, alarm, message, and navigation paths sanitized; Focus ticks and every state-changing Focus message wait for startup readiness before they can mutate a run.
- Made a tab's pending destination authoritative during startup classification and Focus-stash serialization, while keeping `tabs.onUpdated` authoritative to its triggering `changeInfo.url`.
- Gated AI fallback with the same internal/allowed policy without broadening into Task 4 run-ID or asynchronous lifecycle work.
- Added Focus-panel URL entries, pure construction for domain/URL/group preferences, normalized stable type-plus-value deduplication across built-in and saved legacy preferences, exact-URL/exact-title copy, visible invalid-input feedback, and rejection of untitled Chrome groups. Profile preferences remain title-only.
- Added pure policy, startup-action, resume, worker-initialization, lookup-failure, navigation, and AI-gate regression suites. The smallest optional stash-persistence adapter was used for Bun startup tests, with the real IndexedDB implementation remaining the production default.
- Updated the user, architecture, release, progress, approved-plan, version, and redacted real-Chrome evidence documents for `1.2.5`.

## 2. Verification evidence

TDD evidence preserved during implementation:

- Initial required RED: `bun test tests/core/focus-policy.test.js tests/core/focus-start.test.js` produced `0 pass`, `28 fail`, and `10 expect()` calls. Failures covered the missing pure module, domain-only startup classification, URL-prefix allowance, stale scalar group IDs, strict-empty fall-through, internal-page startup actions, and unavailable stash persistence in Bun.
- After the first production implementation, the required focused command became GREEN with `28 pass`, `0 fail`, and `101 expect()` calls.
- A worker-startup group-query failure test was then added RED. `bun test tests/integration/focus-worker.test.js` produced `2 pass`, `1 fail` because failed lookup left stale runtime authority. Persisting the sanitized title-only runtime state made the suite GREEN with `3 pass`, `0 fail`, and `15 expect()` calls.
- Mandatory review repair RED: `bun test tests/core/focus-policy.test.js tests/core/focus-start.test.js tests/integration/focus-worker.test.js` produced `31 pass`, `5 fail`, and `125 expect()` calls. The five failures proved the missing preference normalizer, committed-URL-first startup classification, raw group IDs restored by pending `getFocusState()`, raw IDs restored after failed lookup through a storage change, and a strict navigation dropped before worker readiness.
- The pending-URL stash regression was separately observed RED: expected `https://blocked.test/pending`, received the stale committed `https://allowed.test/committed`. After implementing the narrow fixes and adding internal, hostless, explicit-block, alarm/message, both-listener, and authoritative-`onUpdated` boundary cases, the focused suite became GREEN with `42 pass`, `0 fail`, and `145 expect()` calls.
- Post-repair mandatory review RED: `bun test tests/core/focus-start.test.js tests/integration/focus-worker.test.js` produced `20 pass`, `6 fail`, and `84 expect()` calls. The failures proved that a failed rebound write still exposed `[7]`, an expired tick mutated before readiness, alarm/message/navigation restored stale `[91]` after write failure, start/resume overtook both deferred-success and deferred-failure initialization, and end/pause/extend settled before readiness.
- After moving verification after successful persistence and binding all mutation entry points to the shared barrier, that focused pair became GREEN with `26 pass`, `0 fail`, and `124 expect()` calls. An additional queued-mutation regression confirmed the original asynchronous `{ error }` response contract remains intact.

Fresh final gate immediately before second review-repair commit `b3193cba6bc155a6fd7050d6b5ba1827e3e1e934`:

```text
bun --version
1.3.11

bun test tests/core/focus-policy.test.js tests/core/focus-start.test.js tests/integration/focus-worker.test.js
48 pass, 0 fail, 192 expect() calls, 3 files

bun test
110 pass, 0 fail, 438 expect() calls, 11 files

bun test --coverage
110 pass, 0 fail, 438 expect() calls, 11 files
core/focus-policy.js: 100.00% functions, 98.69% lines
core/focus.js: 68.75% functions, 80.72% lines

bun test tests/syntax.test.js
2 pass, 0 fail, 70 expect() calls

git diff --check
clean

VERSION and manifest.json
both 1.2.5
```

Coverage was reviewed by changed path rather than by repository-wide percentage. Named tests exercise policy success and failure cases, startup selection for every action, the fail-closed pre-mutation group query, pure/current-ID rebinding, initialization success/failure, resume success/failure, deferred storage/group boundaries, failed rebound persistence, expired alarms, all five Focus mutation messages, preserved queued errors, alarm/message reads, exact/prefix/pending navigation, authoritative update URLs, pending stash serialization, internal and allowed AI gates, preference deduplication, and preference immutability. The panel delegates its entry construction and normalization to fully exercised pure functions as required; the approved boundary explicitly excludes adding a DOM shim.

Real-browser evidence used the already-installed official Chrome for Testing `148.0.7778.96` at `/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`, SHA-256 `adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f`. The driver opened the real unpacked side panel and production service worker with AI disabled:

```text
strict empty: focusTabCount=0, non-internal navigation removed
exact URL: exact tab remained, prefix-extension tab removed
before restart: stale scalar/runtime ID and title-only preferences seeded
after clean browser/extension restart: runtime groupIds=0, stale scalar removed
after creating two current same-title groups and resuming: runtime groupIds=2,
  IDs exactly matched both live groups, stale ID trusted=false, preferences title-only=true
cleanup: seed exit=0, verify exit=0, profile removed=1,
  matching Chrome processes=0, matching Xvfb processes=0
```

The report deliberately does not claim the two Chrome groups persisted across the browser restart. Cold startup first proved stale numeric authority was removed; two newly current same-title groups were then created and resume proved exact-title rebinding to both live IDs. Full redacted commands, failed-attempt non-evidence, results, and cleanup are in `docs/reports/2026-07-14-reliability-smoke.md`.

Model ledger: one Codex implementation agent built and verified the initial Task 3 slice; the root Codex controller coordinated scope; one root read-only smoke debugger independently confirmed the successful browser path and cleanup qualification; mandatory independent Codex reviews reported two Important plus one Minor finding in the first pass and two additional Important races in the post-repair pass; one fresh Codex repair agent reproduced, fixed, documented, and verified both repair cycles. The root still owns the mandated final independent review.

## 3. Assumptions made

- Treated a clean browser-process restart on the same disposable profile as the supported unpacked-extension reload boundary after `chrome.runtime.reload()` removed Chrome extension APIs from a command-line-loaded unpacked target. The failed runtime-reload attempts are documented as non-evidence.
- Created the two current same-title groups after restart, then resumed the paused run. This proves stale startup IDs are rejected and title preferences rebind to every currently live match; it does not assert Chrome session/group persistence.
- Treated `chrome://` and `chrome-extension://` as the internal URL schemes in this Chrome-only extension, matching the existing product boundary and approved tests. Hostless/non-HTTP values such as `about:blank` remain non-internal and are blocked by strict-empty mode.
- Used a small optional stash-persistence parameter only because Bun intentionally has no IndexedDB shim. Production calls still use the imported real `saveStash` implementation by default.
- Preserved built-in legacy string allowlists while writing newly constructed panel preferences as typed entries.
- Treated `pendingUrl` as the authoritative startup destination because Chrome exposes it while navigation is in flight; `tabs.onUpdated` instead uses `changeInfo.url`, the URL belonging to that specific event.

## 4. Concerns and observations

- The initial mandatory review found two Important startup/pending-URL defects and one Minor preference-deduplication defect; its post-repair review then found two Important persistence/mutation races. Commits `ed03eca63e0530f3b4d31c4560b666343b51c70b` and `b3193cba6bc155a6fd7050d6b5ba1827e3e1e934` cover every finding with observed RED regressions and fresh focused/full/coverage/syntax/version/whitespace evidence. The controller's next independent review remains the final clean-review gate.
- `chrome.runtime.reload()` did not restore a command-line-loaded unpacked extension in the disposable Chrome for Testing session. The supported clean browser restart supplied the actual cold-start evidence; the report does not promote the failed harness path into a product claim.
- Panel markup was not DOM-tested because the approved brief explicitly forbids adding a DOM implementation/shim for this task. Entry construction and invalid shapes are pure-tested, while the real side-panel document supplied the runtime boundary.
- Pre-existing `/tmp/tabkebab-task2-*` directories were observed outside Task 3's namespace. They were not inspected or removed because Task 3 cleanup authorization covered only its own uniquely named profiles. All Task 3 profiles, logs, Chrome processes, and Xvfb processes were removed.
- Task 4's run-ID, delayed-classification, and teardown lifecycle concerns remain intentionally untouched and are the next planned slice.

## 5. Close-out confirmation

- All Task 3 plan checkboxes are complete and backed by named automated or browser evidence.
- `GUIDE.md`, `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `PROGRESS.md`, the smoke report, and the implementation plan are current.
- `VERSION` and `manifest.json` are both `1.2.5`.
- Implementation commit: `78e7628b5ce705bc96274f2fec64866229ae9f6e` (`fix: unify focus allowlist policy`).
- Mandatory review-repair commit: `ed03eca63e0530f3b4d31c4560b666343b51c70b` (`fix: close focus startup races`).
- Second mandatory review-repair commit: `b3193cba6bc155a6fd7050d6b5ba1827e3e1e934` (`fix: serialize focus startup mutations`).
- Commit author is `Michel Abboud <29182417+michelabboud@users.noreply.github.com>` and the commit contains `Co-Authored-By: Codex <noreply@openai.com>`.
- Worktree branch `codex/reliability-hardening` is clean at the second review-repair commit.
- Per the Task 3 orchestration boundary, no tag, push, release, `main` mutation, parent-checkout mutation, or final campaign handoff was performed.
