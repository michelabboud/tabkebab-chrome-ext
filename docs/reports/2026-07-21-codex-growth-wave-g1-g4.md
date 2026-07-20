# Codex growth wave G1–G4 close-out

**Date:** 2026-07-21  
**Branch:** `feat/growth-wave-g2-g4`  
**Base:** `main` at `5a6b40b`  
**Status:** BLOCKED at the first commit gate; G2–G4 were not started

## What changed

The G1 follow-ups were implemented in the isolated worktree but could not be
committed:

- Session healing now has one shared canonicalization policy used by deletion,
  Drive sync reads, and portable session/full exports. Sync/export-only reads
  persist the healed shape.
- Healing drops unrepresentable tab URLs, bounds legacy captured strings, and
  recomputes each affected window's `tabCount`.
- `saveSession()` returns the same `{ error: ... }` response shape as stash
  capture when every live tab is unrepresentable, without writing an empty
  session.
- All four service-worker stash sites share one save-before-close boundary.
  Empty captures do not save or close anything, rejected saves do not close
  anything, and only successfully captured non-internal tabs are closed.
- The stash favicon render gate is exported for direct tests and rejects
  executable/oversized values while accepting valid HTTP(S) and data favicons.
- Shared capture limits were extracted so capture and healing use identical
  bounds without duplicating policy.

G2 (first-run experience), G3 (zero-config Chrome AI), G4 (store trust docs),
the version bump, release documentation, and final close-out commit were not
started because the lane could not satisfy the required per-logical-change
commit sequence.

## Verification evidence

Baseline before changes:

```text
867 pass
0 fail
4853 expect() calls
Ran 867 tests across 41 files. [8.56s]
```

The new G1 tests were run red before implementation. They failed on the missing
read-path heal/write-back, stale `tabCount`, empty-session rejection, shared
stash commit boundary, and unexported favicon gate.

Focused green run after implementation:

```text
82 pass
0 fail
437 expect() calls
Ran 82 tests across 5 files. [1162.00ms]
```

The first full run exposed one stale coordinator fixture that omitted
`tabCount`; the new required heal correctly added a local write. The fixture was
made canonical (`tabCount: 0`) and the coordinator ordering test then passed:

```text
1 pass
27 filtered out
0 fail
3 expect() calls
```

Fresh full-suite gate immediately before the attempted commit:

```text
876 pass
0 fail
4884 expect() calls
Ran 876 tests across 43 files. [10.26s]
```

`git diff --check` also exited 0.

## Blocker

The required first logical commit could not stage or commit because the managed
filesystem exposes the linked-worktree Git metadata as read-only:

```text
fatal: Unable to create '/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/growth-wave-g2-g4/index.lock': Read-only file system
fatal: Unable to create '/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/growth-wave-g2-g4/index.lock': Read-only file system
```

The environment's approval policy does not permit requesting elevated write
access. Continuing into G2 would violate the brief's requirement to commit each
logical change only after a green full suite, so execution stopped at this gate.

## Assumptions and forks

- “Headless execution lane” was treated as authorization to create an isolated
  linked worktree under the repository's already-ignored `.worktrees/`
  directory.
- The brief's “same error shape the stash paths use” was implemented as
  `{ error: 'No stashable tabs in session' }`, matching the worker's checked
  message response convention rather than throwing from `saveSession()`.
- Clean stored sessions are compared canonically before write-back, so sync and
  export do not add storage writes when no healing or migration is needed.
- No drawer, telemetry, dependency, remote-code, push, merge, tag, or release
  action was introduced.

## Follow-ups / restart point

1. Restore write access to
   `.git/worktrees/growth-wave-g2-g4/` (or resume in a lane whose Git metadata is
   writable).
2. Review the uncommitted G1 diff, rerun `bun test`, and create the first
   logical commit with the required Codex co-author trailer.
3. Resume the brief at G2, followed by G3, G4, the lockstep version/changelog
   update, and the final close-out report revision.

## Close-out confirmation

- Close-out report written: yes (uncommitted because of the blocker)
- `VERSION` bumped: no
- Logical commits created: no
- Pushed: no
- Merged: no
- Long-running processes left behind: none
