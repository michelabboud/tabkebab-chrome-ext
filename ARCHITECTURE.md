# TabKebab Architecture

TabKebab is a dependency-free Manifest V3 Chrome extension. Chrome loads the repository directly; there is no production build or bundling step.

`VERSION` is the repository version source of truth. `manifest.json` mirrors it for Chrome packaging. The manifest also carries the Chrome Web Store public key so unpacked and CI-packaged builds deterministically use production extension ID `cgfnjdcioainbclbbihglaopbhikhdob`; this public identity material is not an OAuth credential or secret.

## Runtime contexts

### Service worker

`service-worker.js` is the background event and command hub. It owns Chrome event listeners, alarm scheduling, tab/window mutations, Focus Mode interception, Drive orchestration, and access to cloud AI providers.

The service worker must not assume browser-document APIs are present. In particular, Chrome's Prompt API is unavailable in workers.

### Side panel

`sidepanel/panel.html` loads `sidepanel/panel.js` and the components under `sidepanel/components/`. The side panel owns user interaction, rendering, confirmations, and document-only capabilities such as Chrome Built-in AI.

Side-panel request/response commands cross `sidepanel/message-client.js`'s one checked `sendOrThrow()` boundary. A background `{ error }` response becomes a rejected operation with that message, while native transport rejection and valid success values (including `null`) pass through unchanged. Every controller prototype delegates to that exact helper; only Global Search retains its fixed injected sender. The audited panel/component inventory owns every runtime, Storage-wrapper, and direct promise-returning Chrome call by awaiting, returning, or explicitly catching it. Success feedback and optimistic projections occur only after checked resolution, committed operations remain distinguishable from later projection failures, and destructive confirmations carry generation ownership so stale settlements cannot overwrite newer UI. Runtime broadcasts, service-worker progress broadcasts, and Chrome-AI long-lived ports remain separate event boundaries.

Global search asks the worker for its ordered array of `{ domain, tabs }` groups and flattens it without re-sorting, then combines those tabs with current stash/session records whose own `windows[].tabs` arrays are validated before cache commit. A valid set of empty arrays is a successful empty result. Rejection, an obsolete wrapper, or malformed grouped/saved data clears all three caches and renders one accessible `Search unavailable — try again.` alert instead of presenting failure as an ordinary empty search. Per-open and per-fetch generations prevent an older load or tab-activation settlement from changing a closed or reopened overlay.

### Core modules

`core/` contains tab, session, stash, Focus Mode, Drive, export, settings, and command logic. `core/engine/` implements the snapshot, solver, planner, and executor grouping pipeline. `core/ai/` contains provider adapters, key handling, caching, and request scheduling.

`core/tab-restore.js` is the single session/stash restore coordinator. It clones saved inputs, preserves `{ savedTab, createdTab }` associations across settled batches, returns the fixed outcome from `core/restore-outcome.js`, and owns mute/discard/unmute cleanup. IndexedDB deletion remains in the service-worker boundary and is allowed only for a complete outcome.

`core/drive-retention.js` is the pure source of truth for destructive Drive cleanup. It recognizes only the repository's exact dated recoverable-copy families in five authoritative scopes, bounds them to 11 fixed categories, protects canonical names before parsing, and computes all newest ties from valid `modifiedTime` values before selecting an old non-newest file. Scheduled and manual cleanup call one coordinator that completes inventory and selection before the first delete and returns only serializable counts and plain per-file errors.

`core/drive-sync.js` is the pure schema, migration, canonicalization, merge, and local-reconciliation boundary for sessions plus manual groups. Missing-version and explicit version-1 documents migrate in memory to version 2 with empty session/group tombstone maps; successful reconciliation emits version 2. Version 2 requires closed own sections and bounded JSON values: at most 25 MiB, 10,000 entities and 10,000 tombstones per kind, 10,000 tabs/URLs per entity, 100,000 tabs/URLs total, 16,384 characters per string/key, and nesting through depth 12. Unsupported versions, sparse/accessor/non-JSON values, dangerous keys, invalid remote timestamps, and limit excesses fail before merge or local mutation.

Drive merge chooses the newer valid entity timestamp, takes the greatest tombstone for each ID, removes an entity when its timestamp is equal to or older than that tombstone, and retains tombstones even when a newer entity survives. Equal-timestamp content conflicts use recursively key-sorted lexical serialization, sessions emit by descending `createdAt` then lexical ID, and every map emits with JavaScript-lexical keys. Equivalent operands therefore produce byte-identical canonical JSON independent of merge direction. Session/manual-group deletion and session Undo now update entity state plus retained tombstones transactionally under the worker mutation lock.

`core/export-schema.js` is the pure portable-backup boundary. Version 2 full documents require sessions, stashes, manual groups, keep-awake domains, bookmarks, allowlisted general settings, Focus profile preferences/history, and sanitized AI settings; partial session, stash, and settings documents contain only their named section. Current version-1 full/partial shapes, legacy Drive `savedAt` settings, and unversioned dated Drive session/stash backups normalize to version 2 in memory. Current Focus history uses `runId` identity while published pre-`runId` history uses a separate legacy `id` namespace. The parser reads only enumerable own data properties, emits null-prototype records with deterministic key order, and rejects unsupported envelopes, accessors, cycles, symbols, sparse arrays, non-JSON values, dangerous keys, secrets/caches, malformed section records, and resource-limit excesses before returning any normalized data.

Portable validation shares fixed Drive-scale record/tab/tombstone ceilings and adds one cumulative in-memory traversal budget: UTF-8 bytes of each own key/string plus 16 bytes per scalar, property, array slot, and container, capped at 25 MiB. It also caps every section and tombstone kind at 10,000 records, every session/stash at 10,000 tabs, all tabs/URLs at 100,000, each key/string at 16,384 characters, and nesting at depth 12. Worker validation never relies on an unbounded stringify size check. Export creation traverses its source once and omits structured-clone `undefined` object properties as legacy JSON did; public import parsing remains strict. `validateStashSection()` is exported so the later IndexedDB replacement transaction can independently revalidate the exact section, including its required `createdAt` index key. The parser calls that exact function through a transient synchronous context that carries the already-bounded tab count without a second clone/scan or a persistent trust brand.

Portable merges are deterministic and local-wins for stable-ID session, stash, bookmark, and Focus-history collisions and for manual-group/Focus-preference key collisions. Keep-awake domains form a set union; imported values overlay only the frozen general-settings allowlist. New bookmark snapshots receive a UUID before local or Drive persistence, while only legacy imported records fall back to a length-delimited created-at/date/time identity. Portable AI output is constructed from enabled/provider/model/custom-base-URL fields and never clones credentials; merge preserves existing encrypted API-key and passphrase metadata byte-for-byte while changing only those safe imported choices. That local secret exception is scoped only to `aiSettings`; a secret/cache field in any other local or imported section rejects the merge.

Explicit import is a direct user recovery action, so an imported session or manual group hidden by a retained local deletion tombstone is revived with `modifiedAt` strictly greater than that tombstone while the tombstone itself remains. Passive Drive sync does not receive this exception. Task 9 establishes this pure schema and merge contract; Task 10 wires every user-facing export/import path to pre-parse file limits, the worker mutation lock, storage transactions, rollback, and Chrome-boundary verification.

Downloaded sync, canonical/cross-profile settings, and portable-export JSON pass through one bounded byte reader instead of `Response.json()`. Settings envelopes accept only legacy missing/version 1, an optional bounded timestamp, and own allowlisted values satisfying the exported boolean/enum/integer and recommended/max-tabs constraints. Local reconciliation reads sessions, groups, and tombstones in one storage snapshot and commits those three keys through one `chrome.storage.local.set()` call.

The service worker owns Task 7's ordinary session/manual-group mutations and canonical Drive reconciliation. Manual and scheduled sync enter one coordinator protected by `core/state-mutation-lock.js`, a worker-local FIFO promise tail. The outer coordinator acquires the lock once and holds it across read/migrate/merge, remote write, the one local commit, subfolder exports, settings upload, and `lastSyncedAt`; internal helpers must not reacquire it. Remote absence is an empty version-1 document, remote failure changes no local portable state, and remote-success/local-failure is safe to retry with the same canonical bytes. This lock is not distributed across Chrome profiles and `Storage.setMany()` is not a Drive/local transaction. Task 10 expanded the same lock around portable import validation, merge, storage transactions, and rollback.

`core/focus-policy.js` is the pure source of truth for Focus allowlist construction, runtime Chrome-group rebinding, and deterministic blocking. Startup classification in `core/focus.js` and navigation interception in `service-worker.js` both delegate to its `isAllowed()` predicate. Domain entries match exact hosts or true subdomains, URL entries compare canonical exact URLs, and group preferences contain exact titles only.

`core/focus-ai.js` owns the provider-agnostic delayed-classification boundary. It captures immutable run, tab, classified-URL, cache-key, category, and request context; fresh and cached decisions share one predicate requiring `distraction === true` and finite numeric confidence strictly greater than `0.7`. Cache expiry uses a per-key generation token plus entry identity so an old timer cannot delete a replacement entry.

Focus startup queries live Chrome groups once before it reads or mutates tabs. The active runtime state receives fresh `groupIds` for every live exact-title match; profile preferences never receive numeric IDs. Active and paused runs rebind during service-worker initialization and immediately before resume. If initialization cannot query groups, persisted runtime IDs are stripped before navigation can use the run, while title preferences and the rest of the run remain recoverable.

Worker startup exposes one shared Focus-readiness promise. Chrome listeners register synchronously so events are not missed, but new-tab/navigation handlers, Focus ticks, and every state-changing Focus message wait for that promise before evaluating or mutating state. Read-only state messages remain available during initialization but expose only a sanitized title-based state. Runtime `groupIds` become authoritative only after both live lookup and its matching storage write succeed; pending or failed lookup/persistence keeps cache reads, storage changes, alarms, messages, and navigation fail-closed with empty runtime IDs. Startup policy uses a tab's `pendingUrl` when present, including for stash serialization, while `tabs.onUpdated` deliberately overrides any stale pending value with its authoritative `changeInfo.url`.

Every Focus run owns a UUID allocated before its first asynchronous lifecycle read and moves through `active`, `paused`, then durable `ending`. A bounded collision check prevents reuse of the previous ID. Start and end intents share one lifecycle queue, while state mutations share a serialized read/transform/write boundary, so teardown cannot settle before an overlapping start has either established and ended its authority or failed. Navigation classification captures the current lifecycle generation with its run/tab/URL context; before `goBack()` and again before destructive removal fallback, `validateDistractionTarget()` first reads durable state, rejects a captured-generation mismatch, reads the live tab as its final await, rejects any intervening state generation (including active→paused→active), requires an exact current-or-non-empty-pending URL match, then applies the decision predicate immediately before the Chrome side effect. Counters, notifications, panel events, ticks, resume/rebind writes, lifecycle-command return values, and badge work re-check the same run after relevant awaits.

Ending is persisted before stash restore, ungroup, alarm, badge, history, or state removal. A complete stash restore (or an already-absent stash) is checkpointed in the ending state; an incomplete outcome records a structured failure and retains the non-blocking ending journal so recovery can retry it. Recovery skips only completed work, while the tab-restore coordinator's normalized open-URL deduplication makes a retry in the narrow crash-before-checkpoint window resume only missing tabs. Focus-created Chrome groups carry a token in durable state and a matching `{ runId, token, groupId }` proof in `chrome.storage.session`; teardown checkpoints ungroup success and fails closed if browser restart cleared the proof or Chrome reused the numeric ID. Startup establishes provisional proof before grouping, live-inspects affected tabs if group metadata fails, and rolls back any partial group if metadata, final ownership, or local Focus-authority persistence fails. Rollback and proof cleanup settle independently, proof cleanup is retried, the primary and cleanup errors are preserved together, and a failed authority write clears the worker cache to fail closed. History is deduplicated by run ID and rewritten with the union of teardown, state-removal, and recovery failures. Conditional state removal is last, except while a structured restore remains incomplete. A service-worker restart resumes an ending run without making blocking active again.

All Focus badge writes pass through one serialized generation-aware reconciler. A storage generation change during either Chrome action await causes a repaint from latest durable state before the queue releases. Distraction reset timers use identity ownership inside that same queue: a later distraction atomically re-arms the timer, a successful authoritative repaint cancels an obsolete reset, and an expired callback rechecks ownership immediately before repainting. Reset failures are owned and logged generically rather than escaping from a timer callback. Runtime distraction/end messages carry a run ID; both the Focus component and global side-panel view/button/blink route use the shared status-aware predicate, with the global route loading durable authority before applying effects. Pause, resume, extend, and end commands also carry the run ID displayed by the panel; the worker rejects a missing, empty, or stale ID before entering the core lifecycle operation.

Pure policy and merge decisions belong in core modules that can run without Chrome. Chrome API calls remain at explicit adapters and orchestration boundaries.

### AI credential boundary

`core/ai/ai-client.js` owns the private AI configuration. Encrypted provider blobs and passphrase metadata never cross the ordinary runtime boundary: `getPublicSettings()` projects only allowlisted provider/model/endpoint choices plus `hasApiKey`, `usesPassphrase`, and the aggregate `device`, `passphrase`, or `mixed` protection mode. Provider execution reconstructs its private configuration inside the worker. Runtime handlers accept exact closed request shapes and return exact secret-free result envelopes.

`saveConfiguration()` is the only user-facing credential write. It validates public fields and the complete replacement set before crypto or storage, encrypts every replacement in memory, performs one local `aiSettings` write under the worker FIFO mutation lock, then performs one best-effort session-storage batch. A local-write failure leaves both stores unchanged. A later session-write failure reports saved-but-locked while retaining the valid encrypted commit. Protection changes and legacy mixed-mode normalization require replacement plaintext for every stored key whose protection would change.

Session entries contain only a version, the encrypted-blob fingerprint, and the decrypted key. A cache hit is usable only when its fingerprint matches current ciphertext, which prevents stale session plaintext from surviving a key or protection change. Passphrase unlock derives truth from the selected provider blob, decrypts without mutating local settings, and maps failure to a typed generic authentication error. Device-protected keys can be reconstructed from the local install ID; passphrase-protected keys remain unavailable until unlocked. `chrome.storage.session` survives service-worker suspension but is cleared by browser restart, extension reload/update, or disable.

Custom endpoints accept remote HTTPS or HTTP loopback only and reject userinfo, query, and fragment components. A stored Custom key cannot move to another origin without replacement plaintext, and portable merge preserves the local endpoint rather than redirecting a preserved key across origins. Same-origin path changes remain allowed. Gemini authenticates through `x-goog-api-key`, never a URL query parameter. Provider exceptions cross the core boundary only as safe typed errors; successful and cached results are scanned for exact submitted-secret reflection before return.

`core/ai/cache.js` stores responses under a SHA-256 identity covering provider, model, system/user prompts, a credential fingerprint, the full canonical Custom base URL, and response-affecting request options. It never stores the plaintext credential or unhashed request material. Update/install migration clears the legacy response cache so older weakly scoped entries cannot be reused.

The AI Settings controller owns Save, Unlock, Test Connection, Load Models, provider-status refresh, and full refresh through one exclusive-operation boundary. Provider and request generations make overlapping settlements last-call-wins. A provider change synchronously hides and clears the old unlock input before awaiting status, unsaved provider selection cannot trigger runtime use, and hidden or disabled unlock controls are revalidated at the send boundary. Panel-level availability refreshes use the same generation rule so stale status cannot repaint the shell.

### AI request lifecycle

`core/ai/request-lifecycle.js` owns one fresh `AbortController` per explicit provider attempt. It accepts only a positive bounded integer timeout, rejects an already-cancelled caller before starting work, links later caller cancellation to the exact provider signal, and records the first abort cause. Timeout or cancellation aborts that signal but does not settle the lifecycle early: the provider promise must finish its own cleanup before `AITimeoutError` or `AIAbortError` is exposed. Timers and external listeners are always removed, including after synchronous provider failure, and a late provider success after abort remains a failure.

Every HTTP provider threads that exact signal through `fetch()` and lazy response-body reads. Abort classification checks both the thrown value and `signal.aborted`, so browsers that reject with a custom `AbortSignal.reason` cannot turn cancellation into a retryable network failure. Chrome Prompt API create/prompt receive the same signal and every created session is destroyed in `finally` before the attempt settles. Missing, download-required, or unknown Chrome model availability is a typed non-retryable unavailable-provider result.

`core/ai/queue.js` retries only typed network and rate-limit failures. Its default `maxRetries: 2` means three total attempts, and each retry begins only after the preceding provider promise has settled; timeout, cancellation, authentication, disabled, unavailable, foreground-required, malformed, and unknown failures perform one attempt. AIClient creates the lifecycle inside the queued closure so every retry receives a new controller, and it caches only a completed successful response. Connection testing and model listing use independent controllers and return their existing `false`/`[]` fallback only after abort cleanup settles.

The manual Chrome boundary uses `tests/fixtures/hanging-ai-server.js`, a loopback-only CORS endpoint that holds completion requests until disconnect and exposes only redacted lifecycle counters. The tree-hash-guarded browser harness uses the unchanged 120-second production timeout, requires maximum active one, proves no automatic retry, then starts one explicit later retry and verifies complete process, display, fixture, and profile cleanup.

### Chrome AI document broker

Chrome's Prompt API is unavailable in Web Workers, so `provider-chrome.js` is
constructed only by the side-panel document. `AIClient` instead uses the one
exported `chromeAIBrokerClient` singleton. The service worker attaches that
same instance only to the named `tabkebab:chrome-ai` runtime port; unrelated
ports are ignored and no worker import graph evaluates `LanguageModel`.

Both sides accept only canonical JSON-only envelopes through
`chrome-ai-protocol.js`. Request IDs are lowercase RFC 4122 version-4 UUIDs.
Completion requests bound prompts, tokens, temperature, and response format;
completion results are fresh own-property values with JSON depth at most 12
and canonical UTF-8 size at most 2 MiB. Repeated references, cycles, accessors,
sparse arrays, non-JSON values, dangerous or unknown keys, raw errors, signals,
configuration, and Chrome objects are rejected before provider work or promise
resolution. Only the fixed safe typed error code/message pair crosses the port.

The worker client correlates concurrent requests by ID, live port record, and
port generation. It retains every connected named panel, makes the newest one
the owner, and keeps older panels as ordered standbys. Replacing an owner with
pending work first cancels that work and holds the candidate inactive until
matching terminal cleanup; calls during the handoff fail foreground-required.
If the owner transport disappears, its pending promises reject and the newest
still-live standby becomes owner. Stale results and disconnects cannot affect a
newer generation. A Task 13 signal abort sends exactly one cancel message and
keeps the pending entry as a cleanup barrier until matching terminal traffic
from the panel proves the provider settled; Task 13 then exposes its own first
timeout or cancellation cause before any retry can begin.

The panel owns one fresh provider, controller, and Prompt API session for each
accepted request. Provider construction through settlement holds one
extension-origin exclusive Web Lock, so two side-panel documents cannot overlap
Prompt sessions; queued cancellation starts no provider, and missing Web Locks
fails closed before construction. Cancel or a duplicate active request ID
aborts the controller and sends its single typed terminal result only after
provider cleanup. Port loss aborts all work and suppresses late results. A
promoted standby may accept work immediately, but its provider remains queued
behind the old document's lock until cleanup releases it. Unexpected Manifest
V3 worker disconnects reconnect after 100 ms, 500 ms, then 1000 ms capped, with
one timer at a time and reset after success. Terminal panel teardown cancels
that timer, aborts local work, and permanently disconnects; document termination
releases its Web Lock. With no panel, uncached background Focus classification receives
`AI_FOREGROUND_REQUIRED` and safely skips without tab, counter, state, cache, or
UI mutation; a cached decision still passes the existing live Focus guard.

## Persistence

- `chrome.storage.local`: sessions, settings, manual groups, Focus Mode preferences/history, Drive state, AI configuration, and sync metadata.
- `chrome.storage.session`: decrypted API-key cache and ephemeral Focus-group ownership proof; Chrome clears it on browser restart, extension reload, update, or disable.
- IndexedDB: stashes and their window/tab metadata.
- Google Drive `drive.file`: profile-scoped canonical sync/settings files plus dated exports.

Drive inventory is fail-closed and fully paginated. The adapter re-reads and validates the persisted profile name, resolves an unambiguous root/profile folder, rejects malformed pages, page-token cycles, unsafe IDs, and partial subfolder listings, then overwrites any remote `scope` field with the authoritative folder scope. Canonical sync/settings files, malformed/undated or unrelated files, young files, cutoff equality, and every newest category tie are outside the deletion set. Archive creation is a precondition for overwriting existing JSON or HTML content.

Credentials, encrypted or decrypted API keys, passphrase metadata, OAuth tokens, install identifiers, Drive connection state, caches, and active Focus Mode state are never included in portable exports.

## External boundaries

- Chrome tabs, windows, groups, storage, alarms, identity, side panel, and bookmarks APIs.
- Google Drive REST API.
- OpenAI, Anthropic, Gemini, and user-configured OpenAI-compatible HTTP endpoints.
- Chrome Prompt API in the side-panel document only.

## Verification architecture

Bun `1.3.11` is the pinned test runtime. `bun:test` covers pure policies, data merges, response contracts, retry behavior, and mocked Chrome API orchestration without adding packages. `bunfig.toml` preloads a fresh repository-owned Chrome double before every test and resets it afterward.

The mock keeps `storage.local` and `storage.session` separate, emits Chrome-shaped storage changes, models mutable tabs/windows/groups, supplies resettable Chrome events and peer-only runtime ports, records API calls, and supports one-shot failure injection. This is a deterministic orchestration seam, not evidence that browser integration works. No DOM or IndexedDB shim is installed; DOM rendering, IndexedDB CRUD, extension lifecycle, OAuth, and Prompt API behavior stay in the unpacked-extension Chrome smoke matrix.

The required local and CI gate is:

```bash
bun test
bun test --coverage
bun test tests/syntax.test.js
```

The final command parses every tracked or unignored JavaScript file and verifies that `manifest.json` remains Manifest V3 and mirrors `VERSION`. GitHub Actions runs this sequence for pull requests, manual dispatches, and pushes to `main`, excluding tag pushes. A dependent Windows job invokes the native batch packager only after the Bun gate passes. The packager verifies version parity, stages the positive allowlist (`manifest.json`, `service-worker.js`, `core/`, `sidepanel/`, and `icons/`) outside the repository, and uploads exactly one versioned zip. The final browser matrix expands that exact CI artifact and rejects any other top-level entry; it never substitutes the repository checkout for package evidence. Chrome still loads source files directly, so testing and packaging add no production dependency, package manifest, bundler, or generated runtime code.

See:

- [Reliability hardening design](docs/superpowers/specs/2026-07-14-tabkebab-reliability-hardening-design.md)
- [Reliability hardening implementation plan](docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md)
- [Architecture decision records](docs/adr/README.md)
- [Current progress](PROGRESS.md)
- [Exact-artifact real-Chrome matrix](docs/guides/real-chrome-smoke-matrix.md)
