# Task 10 Brief — Portable v2 orchestration and rollback

Base commit: `906416d4c18a87bcb8b5743608bcf1273ba381d4` (`v1.2.11`)

Target checkpoint: `v1.2.12` (task tag only; no GitHub Release)

## Required contract

- Use TDD and retain RED/GREEN evidence.
- Export only the sections named by the frozen `PORTABLE_KIND_SECTIONS` map.
- Full export reads exactly eight local keys plus IndexedDB stashes; partial export reads only its named repository.
- Reject files over 25 MiB before `file.text()` and enforce accepted kinds.
- The worker re-parses every import before any storage or IndexedDB read.
- Import snapshots, writes, and rolls back only affected repositories.
- A successful full import performs one `Storage.setMany()` call plus one stash replacement.
- Restore exact prior values, remove affected keys that were originally absent, and preserve unrelated state.
- Report incomplete rollback with `ImportRollbackError` containing the original cause and rollback failures.
- Hold the non-reentrant FIFO worker lock once around import validation/apply/rollback and around every export read.
- Serialize every import-affected writer: settings, keep-awake, bookmarks, Focus preferences/history, AI settings, sessions/groups, and stash writes.
- All full/session/stash/settings UI paths use the worker v2 export/import actions.
- Update success UI only after resolved imports and reset file inputs in `finally`.
- Verify focused tests, full suite, coverage, syntax, Chrome boundary smoke, docs, version parity, and whitespace.

## Work split

- `task10_core`: tests and implementation in `core/export-import.js` and `core/stash-db.js`; no commit.
- Root controller: worker locking/actions, UI migration, integration/concurrency tests, Chrome smoke, docs/version, review, release closeout.

## Closeout

Commit all Task 10 files with Michel's configured author email and Codex co-author trailer, create annotated `v1.2.12`, atomically push `main` plus tag, and verify the exact-commit GitHub Actions run is green.
