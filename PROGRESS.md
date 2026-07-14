# TabKebab Progress

## Current state

- Repository version: `1.2.4`
- Active initiative: reliability and data-safety hardening
- Design status: architecture and written specification approved on 2026-07-14
- Plan status: approved 15-task TDD implementation plan in progress
- Implementation status: Tasks 1–2 complete; restore outcomes, recoverable stash retention, and audio-safe discard cleanup established

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

Task 3 applies one complete Focus Mode allowlist policy at startup and navigation time.
