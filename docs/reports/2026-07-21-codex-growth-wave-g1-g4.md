# Codex growth wave G1–G4 close-out

**Date:** 2026-07-21  
**Target branch:** `feat/growth-wave-g2-g4`  
**Base:** `main` at `5a6b40b`  
**Resumed lane:** G1 follow-ups are committed at `4676fe8`  
**Status:** BLOCKED before branch switch; G2–G4 were not started

## What changed

The prior lane completed the G1 follow-ups, and that work is now committed on
`feat/growth-wave-g2-g4` at `4676fe8`:

- Session healing has one shared canonicalization policy used by deletion,
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
- Shared capture limits ensure capture and healing use identical bounds without
  duplicating policy.

This resumed lane made no product or test changes. G2 (first-run experience),
G3 (zero-config Chrome AI), G4 (store trust docs), the lockstep version bump,
and the final close-out commit remain pending because the sandbox could not
switch to the target branch or create commits.

## Verification evidence

The prior lane's fresh full-suite gate before the G1 commit was:

```text
876 pass
0 fail
4884 expect() calls
Ran 876 tests across 43 files. [10.26s]
```

`git diff --check` also exited 0 in that lane. The resumed lane did not claim a
new test result: the required `git switch feat/growth-wave-g2-g4` failed before
the requested baseline `bun test` could run against commit `4676fe8`.

Read-only checks after the failure confirmed the checkout was unchanged:

```text
## main...origin/main
main
```

## Blocker

The resumed lane was instructed to use the repository checkout directly rather
than a linked worktree. The branch switch still requires writing the repository
index, but this managed sandbox exposes `.git` as read-only:

```text
$ git switch feat/growth-wave-g2-g4
fatal: Unable to create '/home/michel/projects/tabkebab-chrome-ext/.git/index.lock': Read-only file system
```

The environment's approval policy does not permit requesting elevated write
access. Without a writable `.git`, the lane cannot switch branches, stage, or
create the required per-logical-change commits. Continuing on `main` or copying
Git metadata elsewhere would violate the direct-checkout and branch requirements,
so execution stopped cleanly before implementation.

## Assumptions made

- The committed G1 state at `4676fe8` is the restart point specified by Michel;
  it was inspected read-only but could not be checked out in this lane.
- The requested 876-test baseline must run on the target branch, so running the
  older `main` suite would not satisfy the gate and was intentionally skipped.
- The report is written into the current working tree as the only permitted
  durable blocker record. Because the checkout remains on `main` and `.git` is
  read-only, this file is untracked here and is not a commit on the target branch.
- No drawer, telemetry, dependency, remote-code, push, merge, tag, or release
  action was introduced.

## Concerns and observations

- Writable source files are insufficient for this wave: the workflow explicitly
  requires branch switching and multiple commits, both of which need writable
  repository metadata.
- The blocker is now the main checkout's `.git/index.lock`, not the prior linked
  worktree metadata path. Removing linked worktrees therefore did not resolve the
  sandbox permission boundary.

## G2 close-out

### What was built

- Added a four-step, inline first-run walkthrough for the core
  group → stash → restore loop. It lives in the normal side-panel document
  flow, is dismissible on every step, writes the
  `firstRunWalkthroughSeen` flag to `chrome.storage.local`, and can be replayed
  from General settings.
- Added explicit failure handling for both first-run flag reads and writes.
  A read failure leaves the panel usable without opening the guide; a write
  failure keeps the guide usable and reports that it may appear again.
- Replaced inert empty copy with real CTA buttons for saved sessions,
  auto-saved sessions, stashes, and the focus-profile picker. The buttons focus
  the session-name field, open the Automation settings section, open Tabs where
  stash actions live, or retry profile loading.
- Kept all new UI as real sections inside the existing panel layout. No
  drawer, slide-over, modal, telemetry, dependency, or remote-code path was
  added.

### Files touched

- `sidepanel/components/actionable-empty-state.js`
- `sidepanel/components/first-run-walkthrough.js`
- `sidepanel/components/focus-panel.js`
- `sidepanel/components/session-manager.js`
- `sidepanel/components/stash-list.js`
- `sidepanel/panel.css`
- `sidepanel/panel.html`
- `sidepanel/panel.js`
- `tests/sidepanel/component-messaging.test.js`
- `tests/sidepanel/first-run-walkthrough.test.js`
- `docs/reports/2026-07-21-codex-growth-wave-g1-g4.md`

### Verification

Focused side-panel and navigation integration gate:

```text
116 pass
0 fail
532 expect() calls
Ran 116 tests across 11 files. [493.00ms]
```

Fresh full-suite `bun test` tail:

```text
886 pass
0 fail
4931 expect() calls
Ran 886 tests across 44 files. [8.40s]
```

### Assumptions

- “Runs once” means the seen flag is persisted when the automatic guide opens,
  not only after the final step, so an abandoned guide does not become a dark
  pattern that reappears on every panel launch.
- The brief's named emptiable lists define the G2 scope: stashes, both session
  lists, and focus profiles. Search results, duplicate scan results, and
  transient filter results keep their task-specific states.
- Focus profiles are built in today, so an empty profile list represents a
  recoverable load failure; its CTA retries the real worker request.
- Per this lane's constraints, `VERSION`, `manifest.json`, and `CHANGELOG.md`
  were not touched, and no git command was run directly.

## Close-out confirmation

- Resumed-lane blocker recorded: yes (untracked on `main` because `.git` is read-only)
- Current checked-out branch: `main`
- `VERSION` bumped: no
- New logical commits created: no
- Pushed: no
- Merged: no
- Long-running processes left behind: none
