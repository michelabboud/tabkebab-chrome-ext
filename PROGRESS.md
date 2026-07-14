# TabKebab Progress

## Current state

- Repository version: `1.2.1`
- Active initiative: reliability and data-safety hardening
- Design status: architecture approved on 2026-07-14; written specification awaiting review
- Implementation status: not started

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

Michel reviews `docs/superpowers/specs/2026-07-14-tabkebab-reliability-hardening-design.md`. After approval, the detailed TDD implementation plan is written under `docs/superpowers/plans/`.
