# TabKebab Architecture

TabKebab is a dependency-free Manifest V3 Chrome extension. Chrome loads the repository directly; there is no production build or bundling step.

`VERSION` is the repository version source of truth. `manifest.json` mirrors it for Chrome packaging.

## Runtime contexts

### Service worker

`service-worker.js` is the background event and command hub. It owns Chrome event listeners, alarm scheduling, tab/window mutations, Focus Mode interception, Drive orchestration, and access to cloud AI providers.

The service worker must not assume browser-document APIs are present. In particular, Chrome's Prompt API is unavailable in workers.

### Side panel

`sidepanel/panel.html` loads `sidepanel/panel.js` and the components under `sidepanel/components/`. The side panel owns user interaction, rendering, confirmations, and document-only capabilities such as Chrome Built-in AI.

Side-panel commands cross one checked runtime-message boundary. Background errors must become rejected operations before components display success.

### Core modules

`core/` contains tab, session, stash, Focus Mode, Drive, export, settings, and command logic. `core/engine/` implements the snapshot, solver, planner, and executor grouping pipeline. `core/ai/` contains provider adapters, key handling, caching, and request scheduling.

`core/tab-restore.js` is the single session/stash restore coordinator. It clones saved inputs, preserves `{ savedTab, createdTab }` associations across settled batches, returns the fixed outcome from `core/restore-outcome.js`, and owns mute/discard/unmute cleanup. IndexedDB deletion remains in the service-worker boundary and is allowed only for a complete outcome.

`core/focus-policy.js` is the pure source of truth for Focus allowlist construction, runtime Chrome-group rebinding, and deterministic blocking. Startup classification in `core/focus.js` and navigation interception in `service-worker.js` both delegate to its `isAllowed()` predicate. Domain entries match exact hosts or true subdomains, URL entries compare canonical exact URLs, and group preferences contain exact titles only.

`core/focus-ai.js` owns the provider-agnostic delayed-classification boundary. It captures immutable run, tab, classified-URL, cache-key, category, and request context; fresh and cached decisions share one predicate requiring `distraction === true` and finite numeric confidence strictly greater than `0.7`. Cache expiry uses a per-key generation token plus entry identity so an old timer cannot delete a replacement entry.

Focus startup queries live Chrome groups once before it reads or mutates tabs. The active runtime state receives fresh `groupIds` for every live exact-title match; profile preferences never receive numeric IDs. Active and paused runs rebind during service-worker initialization and immediately before resume. If initialization cannot query groups, persisted runtime IDs are stripped before navigation can use the run, while title preferences and the rest of the run remain recoverable.

Worker startup exposes one shared Focus-readiness promise. Chrome listeners register synchronously so events are not missed, but new-tab/navigation handlers, Focus ticks, and every state-changing Focus message wait for that promise before evaluating or mutating state. Read-only state messages remain available during initialization but expose only a sanitized title-based state. Runtime `groupIds` become authoritative only after both live lookup and its matching storage write succeed; pending or failed lookup/persistence keeps cache reads, storage changes, alarms, messages, and navigation fail-closed with empty runtime IDs. Startup policy uses a tab's `pendingUrl` when present, including for stash serialization, while `tabs.onUpdated` deliberately overrides any stale pending value with its authoritative `changeInfo.url`.

Every Focus run owns a UUID allocated before its first asynchronous lifecycle read and moves through `active`, `paused`, then durable `ending`. A bounded collision check prevents reuse of the previous ID. Start and end intents share one lifecycle queue, while state mutations share a serialized read/transform/write boundary, so teardown cannot settle before an overlapping start has either established and ended its authority or failed. Before `goBack()` and again before destructive removal fallback, `validateDistractionTarget()` reads durable state, captures its generation, reads the live tab as its final await, rejects any intervening state generation (including active→paused→active), requires an exact current-or-non-empty-pending URL match, then applies the decision predicate immediately before the Chrome side effect. Counters, notifications, panel events, ticks, resume/rebind writes, and badge work re-check the same run after relevant awaits.

Ending is persisted before stash restore, ungroup, alarm, badge, history, or state removal. A complete stash restore (or an already-absent stash) is checkpointed in the ending state; an incomplete outcome records a structured failure without checkpointing so recovery retries it. Recovery skips only completed work, while the tab-restore coordinator's normalized open-URL deduplication makes a retry in the narrow crash-before-checkpoint window resume only missing tabs. History is deduplicated by run ID, partial cleanup failures are structured, and conditional state removal is last. A service-worker restart resumes an ending run without making blocking active again.

All Focus badge writes pass through one serialized generation-aware reconciler. A storage generation change during either Chrome action await causes a repaint from latest durable state before the queue releases. Runtime distraction/end messages carry a run ID; both the Focus component and global side-panel view/button/blink route use the shared status-aware predicate, with the global route loading durable authority before applying effects. Pause, resume, extend, and end commands also carry the run ID displayed by the panel; the worker rejects a missing, empty, or stale ID before entering the core lifecycle operation.

Pure policy and merge decisions belong in core modules that can run without Chrome. Chrome API calls remain at explicit adapters and orchestration boundaries.

## Persistence

- `chrome.storage.local`: sessions, settings, manual groups, Focus Mode preferences/history, Drive state, AI configuration, and sync metadata.
- `chrome.storage.session`: decrypted API-key cache only; Chrome clears it on browser restart, extension reload, update, or disable.
- IndexedDB: stashes and their window/tab metadata.
- Google Drive `drive.file`: profile-scoped canonical sync/settings files plus dated exports.

Credentials, decrypted keys, OAuth tokens, caches, and active Focus Mode state are never included in portable exports.

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

The final command parses every tracked or unignored JavaScript file and verifies that `manifest.json` remains Manifest V3 and mirrors `VERSION`. GitHub Actions runs this sequence for pull requests, manual dispatches, and pushes to `main`, excluding tag pushes. Chrome still loads the source tree directly; testing adds no production dependency, package manifest, build, or generated runtime code.

See:

- [Reliability hardening design](docs/superpowers/specs/2026-07-14-tabkebab-reliability-hardening-design.md)
- [Reliability hardening implementation plan](docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md)
- [Architecture decision records](docs/adr/README.md)
- [Current progress](PROGRESS.md)
