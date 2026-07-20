# TabKebab Progress

## Current state

- Repository version: `1.2.18`
- Active initiative: reliability and data-safety hardening
- Design status: architecture and written specification approved on 2026-07-14
- Plan status: approved 15-task TDD implementation plan in progress
- Implementation status: Tasks 1–14 implemented and independently code-reviewed; Chrome Built-in AI now executes only in the side-panel document through a bounded named-port protocol while preserving Task 13 cleanup-before-settlement
- Phase 1 release status: `v1.2.8` was explicitly authorized by the repository owner on 2026-07-19 with the real Chrome/Drive fixture waived as a release prerequisite; the fixture remains unpassed and is not represented by mock evidence
- Phase 2 release status: `v1.2.13` is committed, tagged, pushed, exact-commit CI-green, and published as a GitHub release
- Phase 3 status: Tasks 12–14 are released as exact-commit CI-green `v1.2.14`–`v1.2.16`. Task 15 is committed, tagged, pushed, and exact-commit CI-green at `v1.2.17`; GitHub release publication remains blocked until all eleven package-matrix rows pass, including live Drive OAuth and an available Prompt model. The complete gitdir-local SDD evidence set is now tracked on `main` at `1.2.18` so auxiliary-worktree cleanup cannot discard it.

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

### Task 11 — Checked side-panel messaging and grouped global search (`1.2.13`)

- Routed every side-panel request/response command through `sendOrThrow()`, which rejects background `{ error }` responses with their exact safe message, preserves native transport rejection, and accepts successful values including `null`. Runtime broadcasts, worker progress events, and long-lived Chrome-AI ports remain separate event boundaries.
- Added import-safe exact prototype adapters across all request/response component classes; only Global Search retains its fixed sender injection. Toast lookup is lazy, so all controller modules load without a document.
- Audited the exact 15-file side-panel inventory, including runtime, Storage-wrapper, and direct promise-returning Chrome calls. Success feedback and optimistic changes follow checked resolution; committed refresh failures preserve recovery actions; destructive commands and search loads/activations use generation ownership so stale settlements cannot replace newer UI.
- Restored open-tab search by validating and flattening the worker's ordered `{ domain, tabs }[]` response and validating current stash/session `windows[].tabs` records before cache commit. Rejected, obsolete, or malformed shapes clear all result caches and render one `role="alert"` unavailable row; valid empty/no-match data remains `No results found`.
- The terminal full-suite gate exposed a two-second Focus distraction-reset callback escaping its Chrome context. The reset is now identity-owned inside the badge queue: current authoritative repaint cancels it, rapid distractions atomically re-arm it, a fired stale callback revalidates after queue entry, and reset rejection is caught with generic logging. Focused RED was `52 pass / 2 fail / 151 assertions`; the queue-race regression was RED at `0 pass / 1 fail / 2 assertions`.
- Final evidence is `62 pass / 0 fail / 277 assertions` side-panel focused, `115 pass / 0 fail / 656 assertions` affected, `56 pass / 0 fail / 164 assertions` Focus lifecycle, `541 pass / 0 fail / 2966 assertions` in both full and coverage runs, and `2 pass / 0 fail / 100 assertions` for syntax. Coverage is `52.52%` functions and `51.06%` lines; raw-runtime, 15-file request, direct-Chrome, Storage, whitespace, version, bounded Focus-core scope, and zero-dependency gates pass under Bun `1.3.11`.
- Two independent side-panel reviews found no Critical, Important, or Minor issue at pre-documentation tree `c925bf65dfdabbb0358ab5a0d5570192a8eeafcc`; independent timer analysis and follow-up concurrency review drove the final bounded repair. Chrome 148 then passed the tree-hash-guarded production panel/worker fixture after tracked evidence freeze: one natural cleanup error produced one safe failure and no success/optimistic/unhandled effect; ordered grouped tabs and current nested stash/session matches rendered in Ctrl+K; valid no-match stayed distinct from unavailable; no request reached the network; and every disposable resource was removed. Exact terminal tree/hash counters live in the gitdir-local report.

### Task 12 — Atomic AI credential lifecycle (`1.2.14`)

- Added provider-specific passphrase unlock after browser restart without re-entering or replacing the encrypted key. Public settings contain only safe configuration plus key-presence/protection booleans; private blobs and session plaintext never cross ordinary runtime responses.
- Replaced split settings/key mutation with one validated operation under the worker FIFO lock. All replacement keys encrypt before one local commit; the one session batch is best-effort, so a session failure is reported as saved-but-locked while a local failure changes neither store.
- Bound session plaintext to the current encrypted blob fingerprint, derived lock state from each blob, preserved explicit legacy mixed mode, and required complete replacements for protection normalization. Device/no-key Chrome AI paths cannot consume legacy ciphertext.
- Restricted Custom endpoints to remote HTTPS or loopback HTTP, bound stored Custom credentials to origin across settings and portable import, moved Gemini authentication into a header, sanitized provider errors/results, and replaced weak response-cache identities with SHA-256 hashes scoped across credential, endpoint, prompts, model, and request options.
- Made provider changes, lock-status refresh, Save, Unlock, Test Connection, Load Models, and full refresh mutually exclusive and generation-owned. Old passphrases clear synchronously, unsaved selections cannot execute, and stale success/failure cannot repaint or submit against a newer selection.
- Mandatory RED evidence was `17 pass / 51 fail / 159 assertions`. Final focused verification is `188 pass / 0 fail / 1376 assertions`; full and coverage runs are `640 pass / 0 fail / 3711 assertions`; syntax is `2 pass / 0 fail / 101 assertions`; coverage is `61.29%` functions and `57.40%` lines. Two independent terminal audits report no blocker at functional tree `a32a08e93aecc03d7b7072294db159a39a35c9ab`.
- Chrome 148 verifies a passphrase-only blob survives a full process exit/relaunch unchanged, wrong unlock fails, correct unlock enables one intercepted OpenAI request, the credential appears only in the authorization header, no request reaches an external network, and disposable resources are removed. The exact documentation-updated terminal tree is recorded gitdir-locally after tracked evidence freeze.

### Task 13 — Abort-before-retry AI lifecycle (`1.2.15`)

- Added a one-controller lifecycle per explicit provider attempt. Positive bounded timeouts and optional caller cancellation abort the exact provider signal, preserve the first cause, wait for provider settlement, remove timer/listener state, and expose stable safe error codes. Already-cancelled calls start no work, raw/custom-reason aborts normalize to `AI_ABORTED`, and swallowed late success still returns `AI_TIMEOUT`.
- Threaded the same signal through every OpenAI, Claude, Gemini, Custom, and Chrome Prompt API path, including lazy body reads. Chrome sessions are destroyed before settlement; missing/download-required/unknown Chrome model states are non-retryable unavailable failures.
- Restricted automatic retry to `AINetworkError` and `AIRateLimitError`, with three total attempts by default and no overlap between attempts. AIClient creates a new lifecycle inside each queued closure and caches only settled success; test connection and model listing preserve `false`/`[]` only after cleanup.
- Reviewer-driven RED/GREEN coverage includes pre-abort no-work, raw and custom abort reasons, synchronous cleanup, first-cause races, non-cooperative providers, late-result cache rejection, typed retry boundaries, and maximum-active ordering. Focused verification is `129 pass / 0 fail / 458 assertions`; full and coverage runs are `769 pass / 0 fail / 4177 assertions`; syntax is `2 pass / 0 fail / 109 assertions`; coverage is `69.93%` functions and `66.11%` lines. Two independent immutable reviews are clean at functional tree `e95cb671ffb6c60a18f34a354e04b97012bf287a`.
- Chrome 148 passed the terminal hanging-provider fixture at exact tree `be3cc89c6216a97b8b5ec975b6fe8e88487795bd`: the unchanged production boundary settled at `120.070s`, the request remained active for `119.899s`, timeout returned the exact safe false fallback, explicit retry produced one distinct request, final metrics were two starts/two aborts/zero completions/zero active/maximum active one, no request reached an external network, and all disposable resources were removed. Commit `14d19008872984306235805efe85f4dd8a66ad1b` is tagged `v1.2.15`; exact-commit CI run `29689191599` passed.

### Task 14 — Side-panel Chrome AI broker (`1.2.16`)

- Moved Prompt API execution out of the Manifest V3 worker. `AIClient` and the worker share one broker-client singleton, the worker accepts only `tabkebab:chrome-ai`, and the panel starts one document executor for its lifetime.
- Added exact JSON-only request/result/error validators with canonical version-4 UUIDs, fixed prompt/option bounds, safe typed errors, fresh own-property copies, depth-12 parsed JSON, a 2 MiB canonical UTF-8 result ceiling, and fail-fast rejection of hostile/repeated structures.
- Correlated concurrent requests by exact live-port generation; cancellation sends one cancel and waits for panel provider/session settlement. Ordinary replacement holds the candidate inactive until old cleanup, active-port loss rejects that generation and promotes a live standby behind the origin lock, and stale/malformed terminal events cannot affect a newer generation.
- Added one provider/controller per accepted panel request and bounded 100/500/1000 ms reconnect. Panel teardown physically cancels its pending timer, aborts work, suppresses late results, and permanently stops reconnect.
- Retained every live named panel in an ordered owner/standby registry. Closing the newest owner promotes a still-open panel, while an extension-origin exclusive Web Lock keeps provider construction and settlement serialized across panel documents and fails closed when unavailable.
- Added ADR 0005 for the cross-document ownership/serialization decision and its rejected realm-local, forced-reconnect, terminal-message-only, and extra-protocol alternatives.
- Duplicate valid or malformed active IDs now abort the original correlation, preserve first-cause cancellation, wait for provider cleanup, and emit one typed malformed result instead of terminating early or silently ignoring malformed traffic.
- Uncached background Focus with no panel safely skips without tab, counter, state, cache, or UI mutation; a valid cached classification can still reach the existing live run/tab/URL guard.
- Current focused verification is `85 pass / 0 fail / 620 assertions`; full and coverage runs are `854 pass / 0 fail / 4804 assertions`; syntax is `2 pass / 0 fail / 116 assertions`; coverage is `71.07%` functions and `67.55%` lines. Independent protocol/broker reviews passed; final cross-boundary and Web Locks reviews exposed duplicate-correlation, stranded-standby, combined port-loss/cleanup, and test-lock-ordering gaps that now have direct RED/GREEN repairs. Both terminal runtime reviews are clean; the documentation-frozen real-Chrome result remains the release gate.
- Chrome for Testing `148.0.7778.96` passed the exact functional tree `df1a7569b67a14c1e3bffc22ecbdb12c767fcf3e` for real Web Locks, named-port reconnect, newest-owner routing, standby promotion, foreground-required closed-panel behavior, background Focus no-mutation, reopen, network isolation, and complete cleanup. Prompt API status was exactly `unavailable`; no model download occurred, and real completion plus close-during-active-completion remain unpassed for Task 15.

### Task 15 — Exact artifact and final release gate (`1.2.17`)

- Replaces recursive negative-exclusion packaging with a Windows-native,
  version-checked positive allowlist and adds a dependent Windows CI artifact
  job after the unchanged Bun gate.
- Adds an eleven-row operator runbook that always loads the unique exact-CI
  zip, persists secure release/PID state across shells, records only redacted
  evidence, and performs guarded disposable cleanup.
- Real Windows RED/GREEN and independent review are complete. The old packager
  accepted mismatched versions and flattened repository files; the terminal
  replacement produces 75 canonical entries under exactly five case-sensitive
  roots, extracts on Windows and Linux, rejects mismatch/missing/metacharacter
  cases, removes owned failed output, and preserves unrelated files.
- Current local verification is `854 pass / 0 fail / 4804 assertions` for full
  and coverage runs, `2 / 0 / 116` for syntax, `71.07%` function coverage, and
  `67.55%` line coverage under Bun `1.3.11`. Version, whitespace,
  no-package/no-lockfile, guide Bash/JavaScript parsing, row arity, and Markdown
  fence gates pass.
- Pins the owner-approved public production manifest key and verifies that it
  derives Store extension ID `cgfnjdcioainbclbbihglaopbhikhdob`. No OAuth
  token, client secret, password, or private key is stored in the repository.
- Consolidates the accepted Task 2–14 test and browser evidence. This is not a
  final-matrix success claim: exact CI, artifact inspection, live Drive,
  available-model Chrome AI, and every other row remain controller gates after
  the Task 15 commit is pushed.

### Evidence archive checkpoint (`1.2.18`)

- Tracks all 47 previously gitdir-local reliability-hardening SDD files under
  `docs/reports/reliability-hardening-sdd/`, including Task 1–15 briefs and
  reports, smoke harnesses, review diffs, progress state, and historical release
  notes.
- Preserves byte-identical source content with documented provenance, byte
  count, and aggregate SHA-256. The source worktree remains intact until its
  cleanup is separately approved.
- Keeps historical task artifacts explicitly subordinate to the consolidated
  reliability smoke report and exact-package matrix; archiving them does not
  convert any pending live-browser row into release evidence.
- Full and coverage verification passes `854 / 0 / 4813`; syntax passes
  `2 / 0 / 125`. Canonical Markdown links, workflow YAML, matrix static checks,
  version parity, whitespace, zero-dependency metadata, and secret scanning are
  clean.

## Confirmed remediation scope

The hardening initiative covers all thirteen findings from the 2026-07-14 code
review. Each implementation is complete and linked to named automated coverage
plus its committed browser/evidence row; the separate final exact-package
matrix still governs publication.

| # | Finding | Named automated authority | Committed smoke/evidence row |
|---|---|---|---|
| 1 | Preserve stashes after incomplete restores | [`stash-restore-handler.test.js`](tests/integration/stash-restore-handler.test.js), [`restore-outcome.test.js`](tests/core/restore-outcome.test.js) | [Task 2 browser boundary](docs/reports/2026-07-14-reliability-smoke.md#browser-boundary) |
| 2 | Preserve canonical Drive sync/settings files during retention | [`drive-retention.test.js`](tests/core/drive-retention.test.js), [`drive-cleanup.test.js`](tests/integration/drive-cleanup.test.js) | [Task 6 evidence](docs/reports/2026-07-14-reliability-smoke.md#task-6-deterministic-evidence) |
| 3 | Cancel stale Focus actions and make teardown non-blocking | [`focus-lifecycle.test.js`](tests/core/focus-lifecycle.test.js), [`focus-worker.test.js`](tests/integration/focus-worker.test.js) | [Task 4 browser boundary](docs/reports/2026-07-14-reliability-smoke.md#task-4-browser-and-provider-boundary) |
| 4 | Apply URL/domain/group allowlists consistently, including strict-empty | [`focus-policy.test.js`](tests/core/focus-policy.test.js), [`focus-navigation.test.js`](tests/integration/focus-navigation.test.js) | [Task 3 browser boundary](docs/reports/2026-07-14-reliability-smoke.md#task-3-browser-boundary) |
| 5 | Match NL domains by exact host or true subdomain | [`nl-executor.test.js`](tests/core/nl-executor.test.js) | [Task 5 browser boundary](docs/reports/2026-07-14-reliability-smoke.md#task-5-browser-and-provider-boundary) |
| 6 | Preserve hash routes and make duplicate Undo complete | [`duplicates.test.js`](tests/core/duplicates.test.js), [`hash-route-restore.test.js`](tests/integration/hash-route-restore.test.js) | [Task 5 redacted results](docs/reports/2026-07-14-reliability-smoke.md#task-5-redacted-results) |
| 7 | Unlock passphrase-only API keys after restart | [`ai-client-passphrase.test.js`](tests/ai/ai-client-passphrase.test.js) | [Task 12 terminal credential result](docs/reports/2026-07-14-reliability-smoke.md#task-12-terminal-credential-result) |
| 8 | Run Chrome Built-in AI in a foreground document | [`chrome-ai-focus.test.js`](tests/integration/chrome-ai-focus.test.js), [`chrome-ai-broker.test.js`](tests/sidepanel/chrome-ai-broker.test.js) | [Task 14 Prompt gate](docs/reports/2026-07-14-reliability-smoke.md#task-14-real-chrome-prompt-api-gate) |
| 9 | Reject background `{ error }` responses in the UI | [`message-client.test.js`](tests/sidepanel/message-client.test.js), [`component-messaging.test.js`](tests/sidepanel/component-messaging.test.js) | [Task 11 terminal result](docs/reports/2026-07-14-reliability-smoke.md#task-11-terminal-real-chrome-result) |
| 10 | Converge Drive deletions and export complete versioned non-secret data | [`deletion-tombstones.test.js`](tests/core/deletion-tombstones.test.js), [`export-schema.test.js`](tests/core/export-schema.test.js), [`export-import.test.js`](tests/core/export-import.test.js) | [Task 8 completed tree](docs/reports/2026-07-14-reliability-smoke.md#task-8-completed-functional-tree-local-evidence), [Task 10 boundary](docs/reports/2026-07-14-reliability-smoke.md#task-10-real-chrome-portable-data-boundary) |
| 11 | Return tabs, stashes, and sessions in Ctrl+K | [`global-search.test.js`](tests/sidepanel/global-search.test.js) | [Task 11 terminal result](docs/reports/2026-07-14-reliability-smoke.md#task-11-terminal-real-chrome-result) |
| 12 | Restore tabs without leaving them muted | [`stash-restore.test.js`](tests/core/stash-restore.test.js), [`session-restore.test.js`](tests/core/session-restore.test.js) | [Task 2 redacted results](docs/reports/2026-07-14-reliability-smoke.md#redacted-results) |
| 13 | Abort timed-out AI attempts before retry | [`request-lifecycle.test.js`](tests/ai/request-lifecycle.test.js), [`ai-client-lifecycle.test.js`](tests/ai/ai-client-lifecycle.test.js), [`queue.test.js`](tests/ai/queue.test.js) | [Task 13 timeout result](docs/reports/2026-07-14-reliability-smoke.md#task-13-terminal-real-chrome-timeout-result) |

## Approved technical direction

- Deliver narrow, independently testable hardening slices instead of a large rewrite.
- Use Bun `1.3.11` and `bun:test` for zero-package unit and integration tests.
- Use explicit Chrome API test doubles for non-browser tests.
- Keep IndexedDB, DOM, extension-context messaging, and Prompt API verification in the real-Chrome smoke matrix.
- Preserve backward compatibility for existing local data, Drive sync version 1, and export version 1.

## Next gate

Finish and independently review Task 15, publish immutable `v1.2.17` to exact-commit CI, download its unique Windows artifact, and run all eleven rows against that expansion. Create the GitHub release only if every row passes. The public production identity is now pinned and verified, but live OAuth/Drive still requires an operator-authenticated disposable Google session. The installed WSL Chrome Prompt model is currently unavailable. Neither live gate may be replaced by synthetic evidence or transmitted credentials.
