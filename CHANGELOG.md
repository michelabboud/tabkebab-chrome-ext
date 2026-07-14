# Changelog

All notable changes to TabKebab are documented in this file.

---

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
