# Changelog

All notable changes to TabKebab are documented in this file.

---

## [1.2.18] — 2026-07-20

### Added

- Archived the complete reliability-hardening SDD evidence set under
  `docs/reports/reliability-hardening-sdd/`: all Task 1–15 briefs and reports,
  browser-smoke harnesses, review diffs, progress state, and historical release
  notes.
- Added archive provenance, snapshot identity, byte count, aggregate digest,
  and guidance distinguishing historical task evidence from the canonical
  consolidated report and exact-package matrix.

### Verification note

- All 47 source files (1,212,720 bytes) were copied from the merged
  `codex/reliability-hardening` worktree's private SDD directory and verified
  byte-for-byte with `diff -qr` plus aggregate SHA-256
  `1d2d222539aa705fd291119ce7272808288f81a78e1bafb9537b8e2d04239e91`.
- A high-confidence secret scan found zero private-key, OpenAI, AWS, GitHub,
  JWT, or Google API-key signatures in the archived files. The original
  worktree-local evidence remains intact pending separate cleanup approval.
- Full and coverage runs pass `854 tests / 0 failures / 4813 assertions`;
  syntax passes `2 / 0 / 125`; coverage remains `71.07%` functions and
  `67.55%` lines. The archive source comparison, canonical Markdown links,
  workflow YAML, matrix fences/scripts, version parity, dependency-metadata,
  whitespace, and secret gates pass.

## [1.2.17] — 2026-07-19

### Added

- A fail-closed Windows release packager that reads and validates `VERSION`,
  requires manifest parity, stages only the five runtime entries, and produces
  one versioned zip with no repository-only material.
- A dependent `windows-latest` CI job that packages only after the Bun test job
  passes, expands and verifies the zip's exact root/version, and uploads one
  versioned extension artifact.
- A reproducible eleven-row real-Chrome operator matrix for the exact CI
  artifact, including secure release-state continuity, disposable profiles,
  redacted evidence, PID ownership, and guarded cleanup.

### Changed

- The owner-approved public Chrome Web Store manifest key now pins unpacked and
  CI-packaged builds to production extension ID
  `cgfnjdcioainbclbbihglaopbhikhdob`. This is public identity material, not an
  OAuth secret, password, access token, or client secret.
- Contributor, architecture, privacy, user, progress, and smoke documentation
  now describe the exact-artifact boundary and consolidate the accepted
  Task 2–14 evidence without treating mocks as browser, OAuth, or model proof.
- The final GitHub release is fail-closed: every matrix row must pass against
  one exact commit/package, including registered live Drive OAuth, an available
  Chrome Prompt model, and the unchanged 120-second provider timeout.

### Verification note

- Real Windows RED proved the old batch file accepted `VERSION=9.9.9` against a
  `1.2.16` manifest and flattened 147 repository files. Its first replacement
  also exposed 73 backslash ZIP names that Linux `unzip` rejected and retained
  owned zips after failure. The repaired packager rejects mismatch, missing,
  and metacharacter inputs; removes stale/partial owned output on failure while
  preserving unrelated files; and emits 75 files at exactly the five allowed
  roots with canonical `/` names. Windows expansion and Linux `unzip` both pass.
- Independent packaging review additionally made raw and expanded CI root
  comparisons case-sensitive. Its terminal PowerShell 5.1/Linux rerun is clean,
  with zero unsafe entry names and no remaining staging/output resource.
- Local Bun and coverage runs pass `854 tests / 0 failures / 4804 assertions`;
  syntax passes `2 / 0 / 116`; coverage is `71.07%` functions and `67.55%`
  lines under Bun `1.3.11`. Whitespace, version parity at `1.2.17`, the
  no-package/no-lockfile audit, matrix Bash/JavaScript parsing, row arity, and
  balanced fences pass. Exact CI, artifact inspection, and the eleven browser
  rows remain post-push release gates and are never inferred from the checkout.

## [1.2.16] — 2026-07-19

### Added

- A single named side-panel broker for Chrome Built-in AI, with one worker-side singleton, per-request panel providers/controllers, generation-safe reconnects, ordered live-panel standby failover, and foreground-required behavior when every panel is absent.
- A strict JSON-only Chrome AI protocol with canonical UUID correlation, exact request fields, bounded prompts/options, typed safe errors, depth-12 parsed JSON, and a 2 MiB canonical UTF-8 result ceiling.
- An extension-origin exclusive Web Lock around provider construction through settlement, preventing Prompt-session overlap across side-panel documents and failing closed before construction if coordination is unavailable.
- ADR 0005 records the multi-panel owner/standby and Web Locks concurrency decision, its fail-closed boundary, trade-offs, and rejected alternatives.
- Protocol, client, panel, timeout-composition, import-graph, service-worker routing, and background Focus regressions.

### Changed

- Chrome Prompt API execution now occurs only in the side-panel document. The Manifest V3 worker never imports or evaluates the Prompt API executor and communicates only through `tabkebab:chrome-ai`.
- The panel reconnects after worker suspension/restart at 100 ms, 500 ms, then 1000 ms capped. Terminal panel teardown cancels the reconnect timer and all active model work.
- Chrome AI requires an open side panel for uncached work and an already available on-device model; TabKebab does not silently start a model download.

### Fixed

- Worker timeout/cancellation now sends one panel cancel and waits for provider/session cleanup before Task 13 exposes its first abort cause, preventing cross-context retries from overlapping old Prompt API work.
- Port replacement now cancels and settles old work before activating the candidate generation. Port-loss failover promotes the newest still-live standby without discarding older open panels, while the origin lock holds new provider work behind old-document cleanup. Stale events, cancel/result races, and malformed terminal traffic cannot settle a newer generation, overlap providers, or strand a pending request.
- Duplicate valid or malformed traffic carrying an active request ID now marks that correlation malformed, aborts once, waits for cleanup, and emits exactly one `AI_MALFORMED_RESULT`; an earlier cancellation remains the first terminal cause.
- Uncached background Focus classification safely skips when the panel is closed, without tab, counter, state, cache, or UI mutation; valid cached decisions still pass the live Focus guard.

### Verification note

- Regression-first failures covered the missing broker modules, lifecycle behavior, canonical UUID/error boundaries, oversized/repeated JSON structures, cancel/result races, reconnect-timer teardown, duplicate correlation, stranded standbys, and combined disconnect/replacement overlap. Current focused verification is `85 pass / 0 fail / 620 assertions`; full and coverage runs are `854 pass / 0 fail / 4804 assertions`; syntax is `2 pass / 0 fail / 116 assertions`; coverage is `71.07%` functions and `67.55%` lines under Bun `1.3.11`.
- Independent protocol and broker reviews were followed by final cross-boundary and Web Locks reviews that reproduced duplicate-correlation, provider-overlap, stranded-panel, and test-lock-ordering gaps. Every finding now has RED/GREEN coverage, and both terminal runtime reviews are clean at `85/0/620`. The protocol review additionally accepted 2,000 randomized conforming JSON values and rejected the former shared-DAG resource case at bounded memory.
- Chrome for Testing `148.0.7778.96` passed the exact-tree gate at `df1a7569b67a14c1e3bffc22ecbdb12c767fcf3e`: real Web Locks were available and idle; the named broker reconnected after synthetic port loss; the newest of two panels owned work; the older panel resumed after it closed; closed-panel execution returned foreground-required; background Focus preserved its tab, run, counter, and cache; reopen worked; zero external requests/runtime errors occurred; and all disposable resources were removed. The real Prompt API existed but reported `unavailable`, so completion and close-during-active-completion remain explicitly unpassed rather than simulated.

## [1.2.15] — 2026-07-19

### Added

- One abortable lifecycle for every AI provider attempt, with a fresh controller, a positive bounded timeout, optional caller cancellation, stable `AI_ABORTED` and `AI_TIMEOUT` categories, and settlement-before-return semantics.
- Stable error codes for disabled, authentication, rate-limit, network, abort, timeout, foreground-required, unavailable-provider, and malformed-result failures.
- Deterministic lifecycle, queue, client, provider-signal, custom-abort-reason, and late-result cache regressions, plus a loopback-only CORS hanging-provider fixture with redacted start, abort, completion, active, and maximum-active metrics.

### Changed

- OpenAI, Claude, Gemini, Custom, and Chrome Prompt API adapters now receive one exact `AbortSignal` throughout fetch/create/prompt and body-read work. Chrome sessions are destroyed before their result or failure settles.
- Automatic retry is restricted to typed network and rate-limit failures, with two retries and three total attempts by default. Timeout, cancellation, authentication, disabled, unavailable, foreground-required, malformed, and unknown local failures perform one attempt.
- Connection tests and model lists use the same lifecycle and preserve their existing `false`/empty-list fallback only after provider cleanup has settled. Explicit user retry starts a distinct later request.

### Fixed

- Timed-out requests can no longer remain active while a later attempt starts, cache a late success, or be relabeled as a retryable network failure.
- Already-cancelled calls start no provider work; raw `AbortError` values and custom `AbortSignal.reason` rejections normalize to non-retryable cancellation.
- Chrome Prompt API absence, download-required states, and unknown availability states are non-retryable unavailable-provider failures rather than transport failures.

### Verification note

- Reviewer-driven RED cases covered pre-cancelled work, raw/custom abort reasons, first-cause ownership, synchronous cleanup, non-cooperative late settlement, timeout fallback ordering, and late-result cache rejection. Final focused verification is `129 pass / 0 fail / 458 assertions`; the full and coverage suites are `769 pass / 0 fail / 4177 assertions`; coverage is `69.93%` functions and `66.11%` lines; syntax is `2 pass / 0 fail / 109 assertions` under Bun `1.3.11`.
- Two independent immutable reviews found no remaining functional blocker at tree `e95cb671ffb6c60a18f34a354e04b97012bf287a`; their focused reruns passed `219/0` and `129/0`. Whitespace, version parity, credential-signature scanning, and the zero package/lockfile audit remain release gates.
- Chrome for Testing `148.0.7778.96` passed the preliminary tree-hash-guarded production Custom-provider fixture at tree `c073b4e2f4fd542f39a26a0302fbb19e7cfa821b`: the UI action settled at `120.078s`, the request was observed active for `119.913s`, timeout returned the exact safe false fallback, explicit retry created only one distinct later request, final metrics were two starts, two connection aborts, zero completions, zero active, and maximum active one, and no external request or runtime error occurred. Every disposable resource was removed. Release closeout repeats this gate on the documentation/version-frozen tree and records its exact non-recursive result in the gitdir-local Task 13 report.

## [1.2.14] — 2026-07-19

### Added

- Passphrase-only restart unlock for each encrypted AI provider key, with exact secret-free public settings, typed lock state, and a visible Unlock flow that rejects wrong passphrases without mutating stored ciphertext.
- One atomic AI-settings operation that validates the complete provider/protection transition, encrypts every replacement in memory, commits local settings once, and updates fingerprint-bound decrypted session entries once.
- Regression coverage for credential lifecycle, strict worker messages, mixed-protection normalization, storage failures, Custom endpoint origin binding, secret reflection, scoped caching, and stale side-panel operations.

### Changed

- Decrypted provider keys now remain usable across service-worker idle cycles in `chrome.storage.session`, but are rejected when their encrypted-blob fingerprint no longer matches. A full browser restart, extension reload/update, or disable still clears the session and requires passphrase unlock.
- AI Settings now exposes only `hasApiKey`, `usesPassphrase`, and aggregate protection mode. Save, Unlock, Test Connection, Load Models, provider-status refresh, and full refresh share one exclusive UI owner with last-call-wins generations.
- AI response-cache identities are SHA-256 hashes scoped to provider, model, prompts, credential, complete Custom endpoint, and response-affecting options. Legacy cache data is cleared on update.
- Google Gemini authenticates with the `x-goog-api-key` header instead of a URL parameter. Custom endpoints require remote HTTPS or loopback HTTP and cannot contain credentials, queries, or fragments.

### Fixed

- Prevented ciphertext, passphrase metadata, plaintext keys, and caller-supplied private provider configuration from crossing ordinary runtime responses or AI execution messages.
- Prevented split settings/key writes, partial protection transitions, stale decrypted-key reuse, cross-origin Custom-key redirects through settings/import, provider error or response credential reflection, and cache reuse across endpoints or accounts.
- Prevented rapid provider changes, stale same-provider failures, overlapping status/save/test/model requests, and failed refreshes from exposing, moving, or submitting an old unlock passphrase.

### Verification note

- The mandatory pre-production RED was `17 pass / 51 fail / 159 assertions`. Final focused verification is `188 pass / 0 fail / 1376 assertions`; the full and coverage suites are `640 pass / 0 fail / 3711 assertions`; coverage is `61.29%` functions and `57.40%` lines; syntax is `2 pass / 0 fail / 101 assertions`. Whitespace, version parity, secret scanning, and the zero package/lockfile audit pass under Bun `1.3.11`.
- Two independent code/security audits found no remaining blocker at exact functional tree `a32a08e93aecc03d7b7072294db159a39a35c9ab`; their immutable focused reruns passed with zero failures.
- Chrome for Testing `148.0.7778.96` passes the tree-hash-guarded production panel/worker credential fixture: a passphrase-only encrypted key survives unchanged across full Chrome exit/relaunch, wrong unlock fails, correct unlock enables one intercepted provider request with header authentication, and no key appears in URL, body, logs, local plaintext, or runtime responses. The fixture reaches no external network and removes every disposable resource. Exact terminal tree/counters live in the gitdir-local Task 12 report so recording them cannot recursively change the tracked tree.

## [1.2.13] — 2026-07-19

### Added

- One import-safe checked messaging seam for every side-panel request/response component, with the same exact prototype adapter on every controller and the fixed injected sender retained only by Global Search.
- Strict grouped-tab and current saved-record validation for global search, an order-preserving flattener for the worker's `{ domain, tabs }[]` contract, lifecycle ownership for overlapping loads/activations, and a distinct accessible unavailable state.
- Regression coverage for helper success/error/null/transport behavior, DOM-free imports, a non-vacuous 15-file promise audit, direct Chrome and Storage calls, checked effect ordering, committed-state recovery, destructive-command generations, current nested stash/session data, accessible failure rendering, and queue-owned Focus badge-reset timers.

### Changed

- Side-panel request/response calls now delegate to `sendOrThrow()`. Checked promises are awaited, returned, or explicitly caught; runtime broadcasts, worker progress events, and long-lived Chrome-AI ports remain outside this command boundary.
- Success toasts, local committed-state projections, and refreshes that imply success now occur only after the worker response resolves. Post-commit refresh failures retain recovery actions and are reported separately from rejected mutations, while intentional background projections carry explicit best-effort handling.
- Ctrl+K search now flattens ordered domain groups and validates current `windows[].tabs` stash/session records before cache commit. A valid empty result remains `No results found`; unavailable data clears all caches and renders exactly one alert, and stale async work cannot mutate a reopened overlay.

### Fixed

- Prevented background `{ error }` responses and rejected direct Chrome/Storage operations from becoming false success, optimistic cache/UI mutation, stale destructive-command UI, lost Undo recovery, or unhandled rejection across settings, Drive, Focus, grouping, tabs, windows, sessions, stashes, duplicates, and command actions.
- Restored open tabs to global-search results after the worker changed from the obsolete object wrapper to a grouped array, while rejecting malformed data instead of misreporting it as an empty profile.
- Deferred toast-container lookup until display time so every request/response component can be imported in the non-DOM test runtime.
- Made the delayed Focus distraction-badge reset a single queue-owned operation. Authoritative repaint cancels it only after current-state reconciliation, repeated distractions re-arm it atomically, an already-fired stale callback cannot overtake the newer owner, and missing-context/API rejection produces one generic warning instead of an unhandled rejection.

### Verification note

- Regression-first work preserved the original corrected RED (`4 pass / 5 fail / 1 error / 15 assertions`) plus reviewer-repair RED runs at `78 pass / 13 fail / 480 assertions`, `91 pass / 20 fail / 555 assertions`, and `113 pass / 2 fail / 644 assertions`. The release gate then exposed the timer leak at `529 pass / 0 fail / 1 error / 2916 assertions`; its focused regressions were RED at `52 pass / 2 fail / 151 assertions`, and the overlapping-reset race was RED at `0 pass / 1 fail / 2 assertions`. Final verification reports `62 pass / 0 fail / 277 assertions` for the side-panel focus, `115 pass / 0 fail / 656 assertions` for the affected command, `56 pass / 0 fail / 164 assertions` for Focus lifecycle, `541 pass / 0 fail / 2966 assertions` for both full and coverage runs, and `2 pass / 0 fail / 100 assertions` for syntax. Coverage is `52.52%` functions and `51.06%` lines without a repository-wide threshold.
- Two independent terminal reviews reported zero Critical, Important, or Minor findings at exact pre-documentation side-panel tree `c925bf65dfdabbb0358ab5a0d5570192a8eeafcc`. Independent timer analysis reproduced the final-gate failure, and follow-up review found the narrower queue race before release; both now have deterministic regressions. The raw-runtime, 15-file request, direct-Chrome, Storage-wrapper, whitespace, version-parity, bounded `core/focus.js` scope, and zero package/lockfile gates pass under Bun `1.3.11`.
- Chrome for Testing `148.0.7778.96` passes the tree-hash-guarded production panel/worker fixture after tracked evidence freeze: one natural Drive-cleanup error yields one safe failure toast, no success/optimistic/unhandled effect, and restored controls; ordered synthetic domain groups and current nested stash/session tabs appear in Ctrl+K; valid no-match remains distinct from unavailable; zero request reaches the network; and every disposable profile/browser/display resource is removed. The exact terminal tree/browser hash and counters live in the gitdir-local Task 11 report so recording them cannot recursively change the tracked tree. This checkpoint adds no package manifest, lockfile, or runtime dependency.

## [1.2.12] — 2026-07-19

### Added

- One worker-owned portable-data pipeline for full, session, stash, and settings version-2 exports plus prevalidated imports. Full backups include sessions, IndexedDB stashes, manual groups, keep-awake domains, bookmarks, effective general settings, Focus preferences/history, and sanitized AI configuration.
- Transactional import orchestration with exact affected-repository snapshots, one local multi-key commit, one atomic IndexedDB stash replacement, deterministic imported/skipped counts, exact rollback, and structured `ImportRollbackError` reporting when rollback itself is incomplete.
- Regression coverage for exact repository reads/writes, kind-scoped UI inputs, 25 MiB file preflight, worker reparsing, rollback and queued-writer ordering, coherent full snapshots, alarm reconciliation, effective defaults, legacy IDs, and UI-consumed record shapes.

### Changed

- Every panel export now asks the service worker for a canonical snapshot under the shared FIFO state lock; every import uses the same bounded file helper and worker trust boundary. Legacy per-component JSON construction and mutation paths were removed.
- Settings exports now materialize the complete effective settings profile, and absent keep-awake storage exports the effective protected-domain defaults. Focus preference writes, all stash writers, bookmark creation, settings/AI/keep-awake writers, sessions/groups, and Focus lifecycle/history now serialize with import/export.
- Successful settings/full imports refresh all managed automation alarms before reporting ordinary success. If data committed but an alarm clear/create fails, the panel reports an explicit committed warning and tells the user to restart before relying on automation.

### Fixed

- Prevented partial local/IndexedDB imports, rollback from erasing a queued mutation, exports mixing state from opposite sides of a concurrent write, and settings imports leaving stale auto-save, kebab, stash, Drive-sync, retention, or bookmark schedules.
- Rejected worker-bypassing secret-bearing, over-budget, over-depth, polluted, malformed, or UI-breaking documents before repository access, including invalid session/stash names, manual-group records, and Focus preference fields.
- Kept API keys, passphrase metadata, Drive/OAuth state, install identifiers, active Focus state, and caches out of downloaded files while preserving existing encrypted local AI credentials during merge.

### Verification note

- Final focused verification reports `79 pass / 0 fail / 576 assertions`; full and coverage runs each report `478 pass / 0 fail / 2663 assertions`; coverage is `53.40%` functions and `53.94%` lines with no repository-wide threshold. Syntax, whitespace, version parity, and the no-dependency-change audit pass under Bun `1.3.11`.
- Independent adversarial review and a separate worker/lock audit found no remaining Critical, Important, or Minor production issue after every reported finding received a RED/GREEN regression and repair.
- Real Chrome for Testing `148.0.7778.96` exercises the production panel download, physical JSON file, file-input import, service worker, all eight local-storage sections, and IndexedDB with outbound HTTP(S) blocked. The terminal tracked tree and cleanup counters are recorded in the gitdir-local Task 10 closeout report after this tracked documentation is frozen; no OAuth token, private browsing payload, or Drive response is exposed.

## [1.2.11] — 2026-07-19

### Added

- A pure portable-export version 2 schema for complete backups and named session, stash, or settings exports, with deterministic null-prototype normalization and version-1 compatibility in memory.
- Fixed, cumulative resource ceilings for imported records, tabs/URLs, strings, nesting, and total in-memory traversal cost, plus direct stash-section revalidation for the later transactional IndexedDB boundary.
- Stable UUIDs on newly created bookmark snapshots before either local or Drive persistence, with the legacy date/time tuple retained only as an import identity fallback.
- Regression coverage for every v2 section, partial and legacy envelopes, hostile object shapes, resource exhaustion, deterministic local-wins merging, explicit tombstone recovery, secret-free AI export, and bookmark persistence ordering.

### Changed

- Portable general settings now derive from the exact frozen `SETTINGS_DEFAULTS` allowlist instead of accepting arbitrary storage keys.
- Explicit import merge semantics retain local records on stable-ID collisions, union keep-awake domains, overlay only allowlisted imported settings, and revive imported sessions or manual groups strictly above retained deletion tombstones.
- AI export is constructed from only the enabled/provider/model/custom-base-URL fields; import merge can update those safe fields while preserving existing encrypted keys and passphrase metadata.

### Fixed

- Rejected unsupported or malformed export envelopes, accessors, cycles, sparse arrays, non-JSON values, prototype-pollution keys, secrets, caches, and over-budget documents before merge or storage access.
- Prevented portable backup creation from copying API keys, tokens, credentials, install identifiers, Drive connection state, active Focus state, or cache fields.

### Verification note

- Regression-first work began with a genuine missing-module/bookmark-ID failure (`0 pass / 2 fail / 1 error / 2 assertions`). Controller and independent-review RED/GREEN cycles then covered production Focus-history identity, legacy Drive envelopes, IndexedDB stash ordering, structured-clone `undefined` fields, literal AI-metadata preservation, delimiter-safe bookmark identity, tombstone ceilings, narrowed secret exceptions, mutable-validator re-entry, and single-pass traversal. The final focused run reports `33 pass / 0 fail / 186 assertions`; full and coverage runs each report `440 pass / 0 fail / 2289 assertions`; syntax reports `2 pass / 0 fail / 93 assertions`; coverage is `49.18%` functions and `50.09%` lines with no repository-wide threshold. Whitespace, version `1.2.11`, and the no-dependency-change audit pass under Bun `1.3.11`.
- Independent final review found no remaining Critical, Important, or Minor findings after every reported boundary issue received a regression and repair.
- This checkpoint defines and tests the pure schema/merge foundation. Task 10 wires every user-facing export/import path, pre-parse file-size gate, worker lock, storage transaction, rollback, and real-Chrome import/export proof.

## [1.2.10] — 2026-07-19

### Added

- Retained Drive v2 deletion tombstones for explicit, rolling auto-save, and alarm-retention session deletion, plus manual-group deletion.
- Regression coverage for bounded timestamp/capacity policy, inherited-key rejection, full-document 25 MiB and 100,000-tab/URL limits, transactional storage failures, worker-lock ordering, checked panel outcomes, and two-profile merge convergence.

### Changed

- Session and manual-group deletion now read one complete three-key portable-state snapshot, validate it against the existing Drive v2 aggregate limits, and commit only the two affected keys together in one `Storage.setMany()` call.
- Session Undo replaces any same-ID copy with exactly one canonical record whose `modifiedAt` is strictly newer than the retained tombstone. The next ordinary sync propagates both deletion and Undo convergence state.
- Rolling auto-save and alarm retention share one captured operation clock and route every removed session through the same worker-serialized batch transaction as explicit deletion.
- Session and group controls show success only after an explicit checked worker confirmation; a missing entity, worker rejection, or post-commit refresh failure is reported without presenting an uncommitted operation as successful.

### Fixed

- Prevented stale session or manual-group copies on another profile from resurrecting after local deletion.
- Prevented Undo from restoring a timestamp that the retained deletion tombstone would immediately suppress at the next merge.
- Prevented a rejected storage write or an invalid/unrepresentable clock, ID, resource count, or canonical byte size from partially deleting local state.

### Verification note

- Regression-first work began with a genuine `2 pass / 17 fail / 30 assertions` run against the Task 7 production tree. Reviewer-driven RED/GREEN additions expanded the focused file to `36 pass / 0 fail / 340 assertions`. The final full and coverage runs each report `407 pass / 0 fail / 2100 assertions`; syntax reports `2 pass / 0 fail / 90 assertions`; whitespace, version `1.2.10`, and the no-dependency-change audit pass under Bun `1.3.11`.
- Real Chrome for Testing `148.0.7778.96` exercised the completed functional tree `7e1ab1c081a1bc3f4128903b1e924e803c5427a8` through the production panel and worker. Session Delete changed `sessions` and `driveSyncTombstones` once, Undo restored exactly one session with `modifiedAt` greater than the unchanged tombstone, and group Delete changed `manualGroups` and `driveSyncTombstones` once. The only later tracked delta records this evidence/status; the controller reruns the same harness after that prose-only delta and records the terminal tree in the local closeout report.
- The browser run made zero HTTP(S) requests and is not live-Drive evidence. Live Drive remains **unpassed** because the disposable unpacked identity has no matching registered OAuth client and the disposable profile was not operator-authenticated; no token or Drive artifact was created.

## [1.2.9] — 2026-07-19

### Added

- Drive sync schema version 2 with bounded version-1 migration, retained session/manual-group tombstone maps, deterministic entity/tombstone ordering, and order-independent equal-timestamp conflict resolution.
- A worker-local FIFO mutation lock plus thin multi-key storage helpers for one-snapshot reads and one-call local commits.
- Regression coverage for schema/resource limits, bounded downloaded JSON, settings constraints, deterministic merge/retry, strict FIFO/rejection release, worker ownership, checked panel feedback, and post-commit refresh failures.

### Changed

- Manual and scheduled Drive sync now share one worker-owned coordinator. It writes the merged canonical document remotely before one three-key local commit, completes exports/settings, and advances `lastSyncedAt` only after the full path succeeds.
- Ordinary session and manual-group mutations now enter checked worker actions and serialize behind sync; the side panel no longer writes `manualGroups` directly. Portable import remains scheduled for the broader Task 10 lock boundary.
- Canonical/cross-profile Drive settings are allowlisted and constraint-checked before storage, and sync/settings/export downloads use bounded UTF-8 JSON reads instead of unbounded `Response.json()` buffering.
- Drive Sync and manual-group controls distinguish worker rejection from a committed mutation whose subsequent view refresh failed, avoiding misleading success/failure or retry feedback.

### Fixed

- Prevented a local-first sync or later panel mutation from overwriting newer session/manual-group state in the same extension worker.
- Made remote rejection leave local portable-state bytes unchanged and kept remote-success/local-failure retryable to identical canonical output.
- Rejected malformed runtime group URLs and invalid settings/session/group payloads before any storage write.

### Verification note

- The focused Task 7 suite, full Bun suite, coverage run, syntax/version gate, and whitespace check pass under pinned Bun `1.3.11`; no package or runtime dependency was added.
- Real Chrome for Testing `148.0.7778.96` loaded the unpacked extension and exercised the production side-panel message, service-worker sync, Chrome storage, and FIFO lock. A CDP-held synthetic canonical upload proved the group mutation stayed queued and `lastSyncedAt` stayed unchanged until release, after which sync completed first and the queued group survived. All Google requests were fulfilled synthetically at CDP and never reached a network.
- Live Drive remains **unpassed**, not replaced by that browser proof. The disposable unpacked identity `igggfmpiljhefkagnphadfadollcimlh` is not the registered development or published identity, and the disposable profile had no operator-authenticated Google test-user session. No OAuth token was requested, printed, or persisted, and no Drive artifact was created.

## [1.2.8] — 2026-07-19

### Added

- A pure, bounded Drive-retention policy covering every dated session, stash, bookmark, portable-export, and archive family, with exact UTC calendar/time validation and stable newest-per-category selection.
- Regression coverage for all 11 retention categories, pagination and scope authority, cutoff equality and newest ties, corrupted inventory/guards/profile state, partial deletion, archive failure, checked UI feedback, and actual scheduled/manual worker entry points.

### Changed

- Scheduled and manual cleanup now use one fail-closed coordinator. Inventory and selection finish before deletion; individual deletion failures continue deterministically and return only plain counted results.
- Drive inventory follows every page, assigns authoritative profile/subfolder scope, rejects ambiguous folders and malformed pages, and re-reads a strictly validated profile name before each operation.
- Cleanup UI uses the checked runtime-message boundary, validates retention days as an integer from 1 through 365, reports protected canonical/newest/undated counts, and treats partial or malformed results as failure.

### Fixed

- Canonical sync/settings files, unrelated or malformed files, young recoverable copies, and every newest tie in each bounded category can no longer be selected by age-only Drive cleanup.
- Archive-copy failure now aborts both JSON and raw-HTML overwrite paths before canonical content can be patched.
- Empty or malformed OAuth tokens and invalid Drive IDs fail before a Drive request; profile changes cannot reuse a stale cached folder.

### Verification note

- Deterministic focused and full Bun gates pass. The mandatory live Drive fixture gate remains blocked: although the repository documents a development extension ID and OAuth client, the exact Task 6 manifest uses the production client without a pinning `key`, and a clean disposable load observed extension ID `fignfifoniblkonapihmkfakmlgkbkcf` rather than the documented development or published ID. That observed identity has no matching documented client, and the disposable profile had no authenticated Google test-user session. The preflight requested no token and made no Drive call; no mock is represented as live-Drive evidence.
- Release decision, 2026-07-19: the repository owner explicitly directed the controller to commit, tag, push, and publish `v1.2.8` with that live fixture still unpassed. This is a release-gate waiver, not live-Drive evidence; the independently reviewed deterministic suite remains the release basis.

## [1.2.7] — 2026-07-14

### Added

- Exact-host and true-subdomain URL helpers plus regression coverage for malformed/present-invalid filters, hostile lookalikes, trailing-dot hosts, and destructive-command tab authority.
- Hash-route restoration and lossless duplicate-Undo coverage for sessions, stashes, and Chrome-rendered production Duplicates panel DOM/events.

### Changed

- Natural-language close previews and confirmations now re-query live tabs, reapply the original filter, and intersect with preview-approved IDs before execution.
- Destructive title filters now fail closed while a tab has a pending destination because Chrome still exposes the committed page's stale title until navigation settles.
- Duplicate groups retain each tab's exact original URL, and bulk-close Undo snapshots those URLs before the first close or rescan.

### Fixed

- Prevented `github.com` filters from matching suffix or sibling lookalikes such as `notgithub.com` and `github.com.evil.test`.
- Preserved URL fragments during duplicate grouping and restore duplicate checks, so distinct hash routes no longer collapse together or reopen as a normalized surrogate.
- Kept opaque-origin Chrome pages distinct and excluded Chrome new-tab pages from duplicate and empty-page cleanup.

## [1.2.6] — 2026-07-14

### Added

- Unique UUID ownership and explicit `active`, `paused`, and recoverable `ending` states for every Focus run.
- One provider-agnostic Focus AI decision boundary with an exact finite confidence threshold, generation-safe cache expiry, and immutable captured run/tab/URL context.
- Browser-session ownership tokens and a durable ungroup checkpoint for Focus-created Chrome groups.
- Lifecycle, AI-cache, delayed-navigation, badge-race, ending-recovery, and side-panel event regression coverage plus redacted Chrome 148 delayed-provider smoke evidence.

### Changed

- Deterministic and AI decisions now carry the originating run ID, tab ID, classified URL, and full decision to one live validation boundary immediately before navigation side effects.
- Focus start and end now share one lifecycle queue; the run UUID is allocated before the first asynchronous read and collision-checked before replacement.
- Focus teardown persists terminal intent before restore, ungroup, alarm, badge, history, and state cleanup; successful stash restoration is durably checkpointed before later recovery work.
- Incomplete stash restoration retains a non-blocking ending journal for retry, while history is rewritten with the union of teardown, state-removal, and recovery failures.
- Focus badge writes are serialized and repaint from current durable authority when state changes during a Chrome action write.
- Focus side-panel events include their run ID and re-read durable state before report, view, blink, or button effects; lifecycle controls send the displayed run ID and the worker rejects missing or stale command authority.

### Fixed

- Prevented delayed fresh or cached AI decisions from moving backward, removing, counting, notifying, or flashing after pause, end, run replacement, tab removal, or navigation away.
- Prevented old ticks, deferred resume/rebind/counter writes, concurrent teardown calls, cache-expiry timers, and delayed badge resets from mutating a replacement run.
- Closed state-change races during both live-tab validation reads, including pause→resume ABA, without adding an await between the final URL check and navigation side effect.
- Invalidated delayed classifications when pause→resume occurs before the AI result returns, even when the same run is active again.
- Prevented reused Chrome group IDs from being ungrouped without matching browser-session proof; ownership, group-metadata, and local Focus-authority write failures now abort before grouping or live-detect and roll back the just-created group, retry proof cleanup, fail the cache closed, and preserve aggregate cleanup errors.
- Made ending recovery history-deduplicated and fail-closed despite partial cleanup failures, while avoiding repeated completed restore/ungroup work and retaining incomplete restores for retry.
- Prevented Pause, Resume, and Extend from returning stale state when a replacement run arrives during badge reconciliation.
- Rejected malformed, non-finite, string, and confidence-at-threshold AI decisions; only `distraction: true` with numeric confidence strictly greater than `0.7` can delegate.

## [1.2.5] — 2026-07-14

### Added

- One pure Focus policy module for legacy/typed domains, canonical exact URLs, Chrome-group title rebinding, internal-page safety, and deterministic block decisions.
- Focus policy, startup-action, resume, worker-initialization, navigation, AI-gate, and failed-group-query regression coverage.
- URL entry construction in the Focus panel with visible validation and exact-match guidance.

### Changed

- Focus startup now resolves all live groups with an exact saved title before reading or mutating tabs, then stores numeric IDs only in the active runtime state.
- Active and paused Focus runs rebind group titles during service-worker initialization and immediately before resume; profile preferences remain title-only.
- Kebab and stash actions now affect only background non-focus tabs, group action receives only eligible focus tabs, and Chrome/extension pages are excluded from all startup actions.
- Navigating tabs use their pending destination for startup classification and stash records; `tabs.onUpdated` still treats the event URL as authoritative.
- Legacy and typed Focus preferences are normalized and deduplicated by their stable type-and-value identity before display or save.

### Fixed

- Applied the same domain, exact-URL, and rebound-group predicate at startup and navigation time, eliminating URL-prefix and stale scalar-group-ID allowance.
- Made strict mode with an empty allowlist block every non-internal URL, including hostless and non-HTTP URLs.
- Removed stale numeric group authority when worker-startup rebinding fails, while preserving the run and title-based preferences for recovery.
- Kept synchronous Focus listeners from dropping strict navigations during asynchronous worker startup, and prevented alarm, message, and storage reads from restoring unverified numeric group IDs while rebinding is pending or failed.
- Made live group bindings authoritative only after their matching storage write succeeds; persistence failure now leaves cache, storage-change, alarm, message, and navigation paths fail-closed.
- Queued Focus ticks and every state-changing Focus command behind worker-startup rebinding, so a late initialization result cannot overwrite or sanitize a newer start, resume, pause, extend, or end action.
- Prevented AI fallback from classifying internal or explicitly allowed pages.

## [1.2.4] — 2026-07-14

### Added

- One dependency-free restore coordinator and fixed outcome contract for session and stash restoration, including requested, restored, duplicate, invalid, failed, and complete state.
- Regression coverage for partial batch settlement, saved-record immutability, pinned/group association, discard audio ordering, cleanup retries, error scopes, retained stashes, and counted UI warnings.
- Redacted real-Chrome smoke evidence for a non-discarding session restore and a retained partial stash.

### Changed

- Session and stash wrappers now share the same cloned, success-preserving restore pipeline.
- Restore notifications use the checked message boundary and show warning counts whenever an outcome is incomplete.

### Fixed

- Kept the original stash unchanged when any URL is invalid or any Chrome restore operation fails, even if delete-after-restore was requested.
- Preserved successful saved-tab metadata when a sibling creation rejects instead of shifting pinned/group data by array index.
- Muted only background tabs entering the discard pipeline, unmuted after every discard attempt, retried pending cleanup in an outer `finally`, and kept the first visible tab active and unmuted.

## [1.2.3] — 2026-07-14

### Added

- Dependency-free Bun regression harness with isolated Chrome storage, events, tab/window/group state, runtime ports, call recording, and one-shot failure injection.
- Repository-wide JavaScript parse and Manifest V3/version consistency checks.
- Checked side-panel `sendOrThrow()` message boundary covering successful, error-shaped, rejected, and null responses.
- GitHub Actions test gate for pull requests, manual runs, and pushes to `main` using pinned Bun `1.3.11`.

### Changed

- Documented the automated commands and the boundary between mocked orchestration and mandatory real-Chrome verification.
- Ignored generated Bun coverage output while retaining test evidence reports.

### Fixed

- Made Chrome-mock replacement teardown deterministic, bound controls to their owning harness, cloned runtime-handler messages in both directions, and preserved original tab indexes in move events.

## [1.2.2] — 2026-07-14

### Added

- Detailed 15-task, three-phase TDD implementation plan mapping all thirteen reliability findings to named regression tests, real-Chrome evidence, and release checkpoints.
- Explicit worker serialization, Drive/input resource bounds, rollback, secret-sanitization, checked-message, AI cancellation, packaging, and exact-commit release gates.

### Changed

- Marked the reliability-hardening written specification approved.
- Confirmed Bun `1.3.11` as the dependency-free test and CI runtime while keeping the shipped extension build-free.

## [1.2.1] — 2026-07-14

### Added

- Reliability-hardening design covering all thirteen confirmed code-review findings.
- Architecture decision records for Bun-based tests, document-context Chrome AI, and Drive deletion tombstones.
- Canonical architecture, progress, and version documents.

### Changed

- Marked the original root plan as historical and linked the active hardening specification.

---

## [1.2.0] — 2026-02-07

### Added

- **Focus Mode** — time-bounded productivity sessions with distraction blocking
  - 4 built-in profiles: Coding, Writing, Research, Meeting
  - Live countdown timer with profile-colored HUD (cyan/purple/green/blue) and glowing animation
  - Distraction interception: blocks navigation to distracting sites during focus
  - Three blocking modes: Strict Mode (whitelist only), Curated Categories (6 blocklists), AI Detection
  - Flexible allowlist supporting domains, URLs, and Chrome tab groups
  - Tab actions on focus start: Kebab, Stash, Group, or None
  - Session reports with stats (duration, distractions blocked, focus tabs)
  - Focus history (last 50 sessions)
  - Preferences saved per profile (categories, allowlist, duration, etc.)
  - Focus button in header with `F` keyboard shortcut
  - Badge countdown on extension icon during active sessions
- **Empty pages cleanup** — separate row in Duplicates tab to find and close blank/empty pages (about:blank, new tabs)
- **Header status icons** — Drive and AI connection status indicators with click-to-navigate to settings
- **Downward tooltips** — header icon tooltips now appear below buttons to prevent clipping at window edge

### Changed

- **Auto-kebab default** — now enabled by default at 3 hours (was 0/off)
- **Duplicate badge** — now includes empty pages count in the badge total
- **Consolidate windows improved** — now a 3-phase smart consolidation:
  - Phase 1: Redistributes excess tabs from huge windows (>100 tabs) to smaller ones
  - Phase 2: Merges tiny windows (<30 tabs) into larger ones
  - Phase 3: Balances groups across windows (max 8 groups per window)
  - Targets 50 tabs per window for optimal organization

### Fixed

- **Tooltip visibility** — header tooltips no longer clip behind the window border
- **Empty pages counter** — badge updates correctly after closing empty pages

---

## [1.1.0] — 2026-02-01

### Added

- **Global stats bar** — fixed bar between the nav and view area showing Windows count, Tabs count, and Active/Kebab percentage across all views
- **Stats hint** — subtle "Kebab = discarded tabs saving memory" explainer below the stats bar
- **Header version badge** — v1.1.0 label and GitHub/Privacy quick-links in the header
- **Session sub-tabs** — Sessions view now has **Saved** and **Auto** tabs; auto-saves display with the `[Auto]` prefix stripped and a count badge on the Auto tab
- **Duplicate badge** — red pill counter on the Duplicates sub-tab button showing the number of extra copies
- **Periodic duplicate check** — background scan every 60 seconds to keep the badge current
- **Custom Group tab search** — each custom group card has a smart input to search open tabs by title/URL or paste a URL directly, with + buttons to add
- **AI command bar upgrade** — input replaced with a multi-line textarea (Enter sends, Shift+Enter for newline) and a provider label showing the active AI provider name
- **Keyboard shortcuts** — `1`–`4` switch main views, `/` focuses the AI command bar, `?` toggles the help overlay, `Esc` closes overlays or blurs inputs
- **Help overlay** — accessible via `?` key or the help button; covers views, features, shortcuts, and tips with links to the full guide and issue tracker

### Changed

- **Custom Groups first** — Groups sub-view now shows Custom Groups above Chrome Tab Groups
- **Collapsible group cards** — custom group header click toggles body and add-tab area visibility
- **Stats moved global** — stats bar removed from the Windows view and placed in a fixed position visible on every view
- **Sub-nav scoping** — Tabs sub-nav handler scoped to `#view-tabs` to prevent interference with the new Sessions sub-nav

### Fixed

- **Double-escaped group names** — `escapeHtml()` was applied to `.textContent` causing entities like `&amp;` to render literally
- **Undefined CSS variable** — `.find-results-list` used `var(--bg)` which doesn't exist; corrected to `var(--bg-card)`
- **Stats null crash** — `refreshGlobalStats()` now guards against null responses from the service worker
- **Collapse/Expand crash** — `collapseAll()` and `expandAll()` in WindowList now return early if `lastWindows` is empty or null
- **Dark theme kebab mismatch** — `[data-theme="dark"]` kebab colors (yellow) now match `prefers-color-scheme: dark` (orange)
- **modifiedAt over-update** — `moveTabToGroup()` and `removeTabFromAllGroups()` no longer touch `modifiedAt` on groups that didn't contain the removed tab
- **Favicon fallback inconsistency** — command-bar.js now uses the same grey-rectangle SVG fallback and `{ once: true }` error handler as all other components
- **Untitled group fallback** — Chrome groups with empty titles now display "Untitled Group" in chips, section headers, and the group editor
- **Badge not resetting** — duplicate badge now updates correctly after closing all duplicates (scan awaited before dispatching)
- **Red dot with no duplicates** — added `.dupe-badge[hidden] { display: none }` to prevent CSS specificity override of the `[hidden]` attribute
- **Dead status field** — removed hardcoded `status` computation from `getWindowStats()` (client uses settings-based thresholds)

### Improved

- **URL matching performance** — `renderGroups()` and `applyToChrome()` use `Set` instead of `Array.includes()` for O(1) lookups

---

## [1.0.0] — 2026-01-28

Initial release.

- 4-phase grouping engine (Snapshot → Solver → Planner → Executor)
- Domain and AI-powered smart grouping
- Sessions with auto-save, restore modes, and pipeline restore
- Stash with IndexedDB storage and lazy restore
- Bookmarks in three formats with multiple destinations
- Tab sleep (Kebab) with keep-awake domain list
- Natural language AI command bar
- Google Drive sync with profile scoping and retention
- Five AI providers: OpenAI, Claude, Gemini, Chrome Built-in, Custom
- AES-GCM 256-bit API key encryption
- Full data export/import
- Configurable settings for limits, automation, and sync
