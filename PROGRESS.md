# TabKebab Progress

## Current state

- Repository version: `1.2.12`
- Active initiative: reliability and data-safety hardening
- Design status: architecture and written specification approved on 2026-07-14
- Plan status: approved 15-task TDD implementation plan in progress
- Implementation status: Tasks 1–10 implemented; every portable export/import UI path now uses the bounded version-2 schema through one worker-owned FIFO lock, with transactional local/IndexedDB apply, exact rollback, effective defaults, and secret-free files
- Phase 1 release status: `v1.2.8` was explicitly authorized by the repository owner on 2026-07-19 with the real Chrome/Drive fixture waived as a release prerequisite; the fixture remains unpassed and is not represented by mock evidence
- Phase 2 status: `v1.2.11` is tagged with exact-commit CI green; Task 10 implementation, independent review, real-Chrome proof, documentation, and local deterministic gates are complete at `1.2.12`, while this task's commit/tag/push and exact-commit CI checkpoint remain

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

### Task 7 — Deterministic Drive sync and worker serialization (`1.2.9`)

- Added a closed, resource-bounded Drive sync v2 schema with missing/version-1 migration, retained tombstones, exact timestamp ceilings, deterministic recursive tie resolution, stable session/map ordering, and byte-identical merge output in both operand orders.
- Added bounded UTF-8 JSON reads for sync, settings, and export downloads plus exact allowlisted settings-envelope/patch validation. Remote malformed data fails before merge or save; local timestamp/tombstone recovery remains defensive.
- Added one-snapshot/one-call local reconciliation and remote-first retry semantics: remote failure performs zero local writes, successful upload precedes one three-key local commit, and a failed local commit is safe to retry to identical bytes.
- Added a strict FIFO worker-local mutation lock. Manual/scheduled sync share one outer coordinator, ordinary session/manual-group writers queue behind it, and panel group operations use checked worker messages rather than direct storage. Portable import remains the explicit Task 10 expansion.
- Added checked UI outcomes that keep worker rejection distinct from post-commit refresh failure, including Drive Sync, settings Undo, group create/delete/add, and drag/drop. Malformed group URLs fail before storage.
- Added focused schema/settings/lock tests and full-suite coverage. A credential-free real Chrome 148 run loaded the actual panel/worker, held the synthetic canonical v2 upload at CDP, proved the group mutation and `lastSyncedAt` remained pending, then proved sync-first completion and queued-group survival after release. Google requests never reached a network; the run is not live-Drive evidence.
- Live Drive remains blocked and unpassed: the disposable unpacked ID `igggfmpiljhefkagnphadfadollcimlh` has no matching registered OAuth client and the clean profile had no operator-authenticated Google test-user session. No OAuth token or Drive artifact was created.

### Task 8 — Transactional deletion convergence (`1.2.10`)

- Added fresh, bounded deletion-tombstone helpers and one-snapshot transactions for session batches, session Undo, and manual-group deletion. Each successful mutation commits only its entity collection and `driveSyncTombstones` together in one storage call; preflight or storage failure leaves both unchanged.
- Read all three portable-state keys before validating a mutation. This adjacent clarification preserves the one-snapshot/two-affected-key-write contract while enforcing Drive v2's aggregate 25 MiB and 100,000-tab/URL limits across untouched sections.
- Routed explicit, rolling auto-save, and alarm-retention deletions plus Undo and group deletion through the existing FIFO worker lock. Checked worker summaries and panel handling distinguish a committed mutation from a missing entity, rejection, or post-commit refresh failure.
- Session Undo retains the tombstone and writes exactly one canonical same-ID record with `modifiedAt` strictly greater than it. Two-profile tests prove stale/equal entities remain deleted, newer and Undo records survive, tombstones remain, and both merge operand orders produce identical bytes.
- Final evidence reports `36 pass / 0 fail / 340 assertions` focused, `407 pass / 0 fail / 2100 assertions` in both full and coverage runs, `27 pass / 0 fail / 149 assertions` for the mutation lock, and `2 pass / 0 fail / 90 assertions` for syntax. Whitespace, version parity, and the no-dependency-change audit pass under Bun `1.3.11`; coverage is recorded without a repository-wide threshold (`45.75%` functions, `47.33%` lines).
- Chrome 148 exercised completed functional tree `7e1ab1c081a1bc3f4128903b1e924e803c5427a8` and proved one checked session Delete, exactly one newer Undo with the tombstone unchanged, and one checked manual-group Delete through the production panel/worker/storage boundary. It made zero HTTP(S) requests and cleaned every disposable resource. The controller reruns after this evidence-only prose delta without further tracked edits. Live Drive remains blocked and unpassed for the registered-client/authenticated-profile reasons above.

### Task 9 — Portable export v2 schema and secret-free merge (`1.2.11`)

- Added one pure schema boundary for complete version-2 documents and named session, stash, or settings documents. Full exports require sessions, stashes, manual groups, keep-awake domains, bookmarks, general settings, Focus profile preferences/history, and sanitized AI settings; version-1 full/partial files, legacy Drive `savedAt` settings, and unversioned dated Drive session/stash backups normalize in memory before use.
- Canonicalization reads only enumerable own data properties, produces null-prototype records with stable key order, and rejects accessors, cycles, symbols, sparse arrays, non-JSON values, prototype-pollution keys, secret/cache fields, invalid records, and unsupported envelopes before merge or storage access. Export creation omits structured-clone `undefined` object fields once, matching legacy JSON behavior, while imported documents remain strict.
- Enforced one cumulative 25 MiB traversal budget plus fixed 10,000-record, 10,000-tab-per-record, 100,000-total-tab/URL, 16,384-character, and depth-12 limits without an unbounded stringify size check. The exported stash validator is the same function used by document parsing.
- Added deterministic local-wins merge rules, imported allowlisted-settings overlay, legacy bookmark tuple compatibility, and direct-user-import recovery that writes revived session/group timestamps strictly above retained tombstones without deleting those tombstones.
- Constructed portable AI settings from safe fields only, while merge preserves existing encrypted API-key and passphrase metadata byte-for-byte and overlays only enabled/provider/model/custom-base-URL choices. The exception applies only to existing `aiSettings`; secrets elsewhere reject. New bookmark snapshots receive a UUID before their local or Drive write.
- Current Focus history merges by `runId`; published pre-`runId` history remains compatible through a separate legacy `id` namespace. Stash transaction validation requires the IndexedDB `createdAt` index key and always revalidates mutable caller data rather than trusting a persistent brand.
- Initial RED evidence was `0 pass / 2 fail / 1 error / 2 assertions`; subsequent controller/reviewer RED/GREEN cycles closed every production-shape, compatibility, resource, and revalidation gap. Final evidence is `33 pass / 0 fail / 186 assertions` focused, `440 pass / 0 fail / 2289 assertions` full and coverage, and `2 pass / 0 fail / 93 assertions` syntax. Coverage is `49.18%` functions and `50.09%` lines; whitespace/version/no-dependency gates pass under Bun `1.3.11`. Independent review reports no remaining findings.

### Task 10 — Transactional portable export/import ownership (`1.2.12`)

- Routed full, sessions, stashes, and settings exports through exact worker actions under the shared FIFO mutation lock. Full export reads exactly eight local keys plus IndexedDB, materializes effective keep-awake/settings defaults, sanitizes AI configuration, and cannot mix reads around a queued writer.
- Routed every JSON input through a 25 MiB pre-text file gate, accepted-kind check, panel parse, and mandatory worker reparse before repository access. Schema validation now also protects the actual Sessions, Stash, Groups, and Focus UI field assumptions.
- Implemented kind-scoped in-memory merge, one local `setMany()` commit, one clear-plus-put IndexedDB transaction, deterministic imported/skipped counts, exact present/absent-key rollback, and structured rollback-failure reporting. Unaffected repositories are never read, written, or restored.
- Expanded the worker lock to every affected writer, including settings, alarms, keep-awake, bookmarks, AI, Focus preferences/history/lifecycle, sessions/groups, and stash mutations. Lifecycle alarm reconciliation uses the same lock; all managed clears/creates are awaited and aggregated.
- Settings/full imports refresh automation schedules after commit. An alarm failure returns an explicit committed warning instead of falsely claiming rollback or ordinary success; the panel renders that warning as an error and recommends restart.
- Focused verification is `79 pass / 0 fail / 576 assertions`; full and coverage runs are `478 pass / 0 fail / 2663 assertions`; syntax, whitespace, version, and dependency gates pass under Bun `1.3.11`. Coverage is `53.40%` functions and `53.94%` lines without a repository-wide threshold. Independent adversarial and worker/lock reviews report no remaining production findings.
- Chrome 148 exercised the production panel download and physical-file import against synthetic data, restored all eight local sections plus IndexedDB, found zero forbidden export keys, preserved unrelated state, reached no external network, and removed all disposable resources. The exact terminal tracked tree is recorded in the gitdir-local Task 10 report after tracked documentation/version files are frozen.

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

Commit Task 10, annotate `v1.2.12`, atomically push `main` plus the task tag, and verify the exact-commit GitHub Actions run before Task 11 starts. Task 10 is a task tag only: the Phase 2 GitHub release remains scheduled for Task 11. The credential-safe real-Drive fixture remains an explicit validation item and may run only in an approved registered identity/client environment with an operator-authenticated disposable Google test-user session, never by transmitting a token.
