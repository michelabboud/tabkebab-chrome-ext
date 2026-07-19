# TabKebab Progress

## Current state

- Repository version: `1.2.8`
- Active initiative: reliability and data-safety hardening
- Design status: architecture and written specification approved on 2026-07-14
- Plan status: approved 15-task TDD implementation plan in progress
- Implementation status: Tasks 1–6 implemented; restoration, Focus lifecycle, exact-host/duplicate Undo, and fail-closed Drive retention established
- Phase 1 release status: `v1.2.8` was explicitly authorized by the repository owner on 2026-07-19 with the real Chrome/Drive fixture waived as a release prerequisite; the fixture remains unpassed and is not represented by mock evidence

## Completed implementation slices

### Task 1 — Bun regression and CI boundary (`1.2.3`)

- Added the pinned Bun preload, isolated Chrome API mock, syntax/version checks, and checked side-panel message client.
- Added the three-command GitHub Actions gate for pull requests, manual dispatches, and `main` pushes while excluding tag pushes.
- Kept the runtime dependency-free and directly loadable by Chrome; browser-only DOM, IndexedDB, lifecycle, OAuth, and Prompt API behavior remain real-Chrome gates.

### Task 2 — Complete-or-recoverable restoration (`1.2.4`)

- Replaced divergent session/stash pipelines with one coordinator that clones saved records, settles each creation independently, and preserves saved-tab/created-tab associations for pinned state and groups.
- Added the fixed restore outcome and fail-closed stash deletion policy: incomplete outcomes retain the original IndexedDB record unchanged.
- Limited muting to background discard candidates, unmuted in `finally` after success or failure, retried pending cleanup, and kept the first visible/non-discarding tabs unmuted.
- Added focused orchestration, handler, audio-order, error-scope, and warning-feedback tests plus redacted Chrome 148 smoke evidence.

### Task 3 — Complete Focus allowlist policy (`1.2.5`)

- Added one pure policy for exact/subdomain host matching, canonical exact URLs, internal-page safety, strict-empty blocking, and exact-title Chrome-group rebinding.
- Made startup and navigation share `isAllowed()`, limited destructive startup actions to background non-focus tabs, and excluded internal pages from every startup action.
- Rebound active/paused runtime state at worker initialization and resume, removed stale IDs on lookup failure, and kept profile preferences title-only.
- Added a shared worker-startup readiness barrier for navigation listeners, while every cache/storage read sanitizes group IDs until live binding succeeds.
- Bound Focus ticks and all state-changing panel commands to the same readiness barrier, and made numeric group verification durable only after storage persistence succeeds.
- Made pending destinations authoritative for startup classification and stashing, kept `tabs.onUpdated` authoritative to its event URL, and deduplicated legacy preferences by type and value.
- Added named pure/startup/worker regression coverage, including group ID `0`, two same-title groups, deferred startup reads, query failure, pending/internal/hostless URLs, URL-prefix rejection, and the AI allowlist gate.

### Task 4 — Run-bound asynchronous Focus lifecycle (`1.2.6`)

- Added a unique UUID to every run before its first asynchronous lifecycle read and explicit active, paused, and recoverable ending states; collision retries and distinct one-time legacy cleanup IDs prevent reuse during replacement.
- Captured run, tab, exact classified-URL identity, and lifecycle generation across deterministic and AI classification, then revalidated durable state, live tab existence, current-or-pending URL, and strict confidence immediately before every navigation side effect, including pause→resume before AI completion or during the tab read.
- Unified fresh and cached AI decisions behind one finite-number predicate (`distraction: true`, confidence strictly greater than `0.7`) and generation-safe cache expiry.
- Serialized Focus lifecycle intents, state mutations, and badge reconciliation so overlapping start/end, old ticks, deferred pause/resume/rebind/counter work, notifications, panel effects, and delayed badge resets cannot affect a replacement run.
- Bound panel Pause/Resume/Extend/End commands to the displayed run and made the worker reject missing, empty, or stale run IDs.
- Persisted ending before teardown, retained incomplete stash restoration for retry, checkpointed completed ungroup work, and proved group ownership with a browser-session token before touching a numeric Chrome group ID. Partial group creation and post-group authority-write failures now live-detect and roll back mutated tabs, retry proof cleanup, preserve aggregate failures, and clear non-durable cached authority.
- Deduplicated history by run ID and durably merged teardown, state-removal, and recovery failures; Pause, Resume, and Extend now return only a final matching durable state after badge work.
- Added lifecycle, AI, delayed-navigation, ownership-failure, side-panel event, and real Chrome 148 CDP-synthetic delayed-provider evidence for pause, pause→resume, end plus replacement, and navigation-away.

### Task 5 — Exact host identity and lossless duplicate Undo (`1.2.7`)

- Replaced substring domain matching with canonical exact-host/true-subdomain identity, including case and trailing-dot normalization, while malformed and present-invalid filter values fail closed.
- Re-query and re-filter destructive natural-language close actions after AI parsing and again at confirmation; execution derives IDs only from the sanitized live tab array and never expands beyond the preview.
- Preserved fragments in duplicate keys and restore duplicate checks, retained each duplicate tab's original URL, and captured an immutable ordered Undo snapshot before close/rescan.
- Kept opaque-origin Chrome pages distinct and excluded inactive Chrome new-tab pages from both duplicate and empty-page cleanup.
- Added 30 focused regression tests and real Chrome 148 evidence proving exact/subdomain preview identity, both hostile-lookalike rejections, three distinct duplicate groups, exact close/Undo counts for two hash routes, and new-tab survival.

### Task 6 — Fail-closed Drive retention (`1.2.8`)

- Added exact classification for the 11 bounded dated recoverable-copy categories and stable selection that protects canonical sync/settings files, every newest tie, cutoff-equal/young files, malformed or unrelated files, and invalid metadata.
- Made profile-root and subfolder inventory fully paginated and authoritatively scope-annotated; malformed pages, repeated tokens, unsafe IDs, ambiguous folders, corrupted profile names, and incomplete subfolder listings abort before deletion.
- Routed scheduled and manual retention through one injectable coordinator that completes selection before destructive work, deduplicates file IDs, continues individual failures, and returns only serializable counts and plain errors.
- Made archive-before-overwrite fail closed for JSON and raw HTML, removed stale profile-name caching, and required a non-empty OAuth token before the first Drive request.
- Switched Settings cleanup to `sendOrThrow()`, strict `1..365` day validation, checked result-shape formatting, protected-file counts, and failure-only feedback for partial/returned/transport errors.
- Added focused coverage across all 11 categories plus actual worker and SettingsManager entry points. The live Drive fixture remains honestly blocked: the repository documents development ID `hkhlbjmokednepfjmnlglapgppfdpmck` and development OAuth client `873809052111-tpog62t7mm16qlmc85j63ke91l50c2s7.apps.googleusercontent.com`, but the exact Task 6 manifest uses the production client without a pinning `key`; a clean disposable load instead observed ID `fignfifoniblkonapihmkfakmlgkbkcf`, which matches neither the documented development nor published ID and has no matching documented client. The disposable profile also lacked an authenticated Google test-user session. No token or Drive call was attempted, and no synthetic response is claimed as the live proof.

## Confirmed remediation scope

The hardening initiative covers all thirteen findings from the 2026-07-14 code review:

1. Preserve stashes after incomplete restores.
2. Preserve canonical Google Drive sync and settings files during retention cleanup.
3. Cancel stale Focus Mode actions and make teardown non-blocking.
4. Apply URL, domain, and Chrome-group allowlists consistently, including strict-empty behavior.
5. Match natural-language domain filters by exact host or subdomain.
6. Preserve hash-routed pages during duplicate cleanup and make Undo complete.
7. Add a passphrase-only API-key unlock flow.
8. Run Chrome Built-in AI in a document context rather than the service worker.
9. Convert background `{ error }` responses into rejected UI operations.
10. Add Drive deletion tombstones and a complete, versioned non-secret export.
11. Restore open-tab results to global search.
12. Restore tabs without leaving them permanently muted.
13. Abort timed-out AI requests before any retry.

## Approved technical direction

- Deliver narrow, independently testable hardening slices instead of a large rewrite.
- Use Bun `1.3.11` and `bun:test` for zero-package unit and integration tests.
- Use explicit Chrome API test doubles for non-browser tests.
- Keep IndexedDB, DOM, extension-context messaging, and Prompt API verification in the real-Chrome smoke matrix.
- Preserve backward compatibility for existing local data, Drive sync version 1, and export version 1.

## Next gate

Publish and verify the operator-authorized `v1.2.8` refs, exact-commit CI run, and browsable GitHub release, then begin Task 7. The credential-safe real-Drive fixture remains an explicit post-release validation item: run it only in an approved registered identity/client environment with an operator-authenticated disposable Google test-user session, never by transmitting a token.
