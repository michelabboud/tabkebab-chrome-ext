# Task 2 Close-out Report

## 1. What was built

- Added the fixed `RestoreOutcome` contract and a single dependency-free `restoreTabWindows()` coordinator shared by session and stash wrappers.
- Counted every saved tab, rejected malformed and forbidden URLs, preserved successful siblings through `Promise.allSettled()`, cloned saved data before sanitizing, and retained explicit saved-tab/created-tab associations for pinned state and groups.
- After independent review exposed a seed-window gap, added URL-associated seed fallback for both `windows` and `single-window`: a true `windows.create()` rejection tries the next valid sibling, every rejected candidate is counted, and a window that already exists is reused after tab-discovery failure instead of opening an orphan extra window. The eventual first successful pair is promoted active and unmuted without shifting pinned/group metadata.
- After a second independent review exposed focus drift in `here` mode, captured the target current window exactly once and passed its stable ID to every creation batch and group operation. Lookup failure now creates no tabs, records one URL-associated error per otherwise-restorable tab, returns an incomplete outcome, and therefore keeps the source recoverable.
- Made the discard path audio-safe: only discard candidates are muted, every discard attempt reaches unmute cleanup, pending unmute work is retried in an outer `finally`, the first visible tab remains active and unmuted, and non-discarding restores never mute.
- Made stash removal fail closed. Only a complete opted-in restore deletes the IndexedDB source; an incomplete restore leaves the original stash untouched.
- Added counted warning feedback to both restore UIs through a small pure formatter and a warning toast style. The formatter/test seam was added beyond the brief's explicit file list so the no-DOM-shim Bun suite can verify the exact user-facing recovery claims without duplicating formatting logic.
- Updated `GUIDE.md`, `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `PROGRESS.md`, the Task 2 checklist, the real-browser smoke report, `VERSION`, and `manifest.json` for `1.2.4`.

## 2. Verification evidence

TDD evidence preserved during implementation:

- First outcome test run: `bun test tests/core/restore-outcome.test.js` failed because `core/restore-outcome.js` did not exist (`0 pass`, `1 fail`, `1 error`); implementing the fixed interface made all six cases pass.
- First required orchestration run: `bun test tests/core/restore-outcome.test.js tests/core/session-restore.test.js tests/core/stash-restore.test.js tests/integration/stash-restore-handler.test.js` produced `6 pass`, `14 fail`, `21 expect()` calls against the old raw outcomes, batch rejection, unconditional deletion disposition, and mute behavior.
- The warning-feedback test initially failed on a missing `sidepanel/restore-feedback.js` module. The targeted pending-unmute regression also failed when the outer cleanup retry was temporarily removed, then passed after it was restored.

Independent-review repair TDD:

- Direct reproduction on `1c87d7a` in both `windows` and `single-window` returned `requested=3`, `restored=0`, one seed error, one `windows.create()` call, and zero `tabs.create()` calls.
- First focused RED: `bun test tests/core/session-restore.test.js -t 'seed'` produced `1 pass`, `3 fail`, `12 filtered`, and `9 expect()` calls. The failing cases proved both restore modes abandoned valid siblings and an all-rejected input recorded only its first candidate.
- Orphan-window boundary RED: `bun test tests/core/session-restore.test.js -t 'reuses a created seed window'` produced `0 pass`, `1 fail`, `16 filtered`, and `1 expect()` call because a post-create tab-discovery failure still abandoned the later sibling.
- Focused GREEN: `bun test tests/core/session-restore.test.js -t 'seed'` produced `5 pass`, `0 fail`, `12 filtered`, and `27 expect()` calls, covering both mode fallbacks, all-candidate accounting, post-create update behavior, and existing-window reuse.

Second independent-review repair TDD:

- Direct reproduction on `4204782` restored seven tabs with `complete: true` but placed tabs 1–6 in window A and tab 7 in window B after focus changed. All seven `tabs.create()` calls omitted `windowId`; grouping still targeted A.
- Focused RED: `bun test tests/core/session-restore.test.js -t 'here-mode'` produced `0 pass`, `2 fail`, `17 filtered`, and `3 expect()` calls. The placement case observed windows `{1, 2}`, and the lookup-failure case incorrectly returned `restored=2`, no errors, and `complete=true`.
- Focused GREEN: the same command produced `2 pass`, `0 fail`, `17 filtered`, and `10 expect()` calls. It proves one target lookup, stable IDs on every batch and group, all restored tabs in A after focus changes, URL-associated fail-closed errors, zero creation on lookup failure, and unchanged session storage.

Fresh final gate on second repair commit `3906670200e01a75a712204cb8c876becd903ceb`:

```text
bun test tests/core/restore-outcome.test.js tests/core/session-restore.test.js tests/core/stash-restore.test.js tests/integration/stash-restore-handler.test.js
33 pass, 0 fail, 120 expect() calls, 4 files

bun test
62 pass, 0 fail, 242 expect() calls, 8 files

bun test --coverage
62 pass, 0 fail, 242 expect() calls, 8 files
core/restore-outcome.js: 100.00% functions, 100.00% lines
core/tab-restore.js: 97.96% functions, 95.83% lines
sidepanel/restore-feedback.js: 100.00% functions, 100.00% lines

bun test tests/syntax.test.js
2 pass, 0 fail, 66 expect() calls

git diff --check
clean

VERSION and manifest.json
both remain 1.2.4
```

Real-browser smoke used official Chrome for Testing `148.0.7778.96` after installed Google Chrome `148.0.7778.178` suppressed the unpacked extension. A disposable headed Xvfb profile loaded the actual extension and side-panel context with no DOM/IndexedDB shim or production failure hook:

```text
session: requested=2 restored=2 duplicate=0 invalid=0 errors=0 complete=true windows=1
session tab state: active present=true, active muted=false, all restored unmuted=true, all restored not discarded=true
stash: requested=2 restored=1 duplicate=0 invalid=1 errors=0 complete=false retained=true unchanged=true
cleanup: profile removed=1, matching Chrome processes=0, matching Xvfb processes=0
```

Full redacted commands, browser hashes, results, and cleanup evidence are in `docs/reports/2026-07-14-reliability-smoke.md`.

Model ledger: one Codex implementation agent handled Task 2 and both focused repairs; the root Codex agent coordinated scope, incorporated two independent reviews, and reviewed the browser evidence.

## 3. Assumptions made

- Interpreted the real-browser "audible" requirement as Chrome's authoritative unmuted state (`mutedInfo.muted === false`) because the synthetic smoke pages intentionally emitted no sound; the report makes no unsupported claim that audio was actively playing.
- Used the already-installed official Chrome for Testing build at the same major version when branded Chrome started but did not register the unpacked extension.
- Treated a zero-tab or duplicate-only outcome as complete, exactly as defined by the fixed interface. A complete duplicate-only stash therefore follows the configured deletion policy.
- Kept saved sessions available on partial restoration and kept incomplete stashes byte-for-byte unchanged; complete non-deleting stash restores retain the existing restored-marker behavior.
- Considered the pure feedback formatter, its focused test, the warning CSS, and the required README/architecture updates part of the production UI and documentation slice even though they were not individually named in the brief's file list.
- Treated only a rejected `windows.create()` promise as permission to try another seed window. Once Chrome returns a window, seed discovery/update failures are reported against that URL and later valid siblings continue in the same window to avoid orphan/extra-window behavior.
- Resolved the `here` destination only when at least one valid, non-duplicate tab remains to create. Duplicate-only or empty outcomes therefore do not require a current-window lookup; any lookup failure with restorable tabs is accounted once per tab and remains incomplete.

## 4. Concerns and observations

- Independent reviews correctly found two important coordinator defects: abandoned siblings after seed-window rejection and drifting `here` batches after focus changes. Both repairs now have focused failure and boundary coverage; no known Task 2 defect or blocker remains after the second repair review and fresh gate.
- Installed branded Chrome did not load the unpacked extension under automation. This is documented as a failed boundary attempt, not treated as evidence; the official same-major Chrome for Testing run supplied the verified browser result.
- The repo is a directly loaded MV3 extension with no separate build or lint command. The repository syntax/manifest test is the applicable parse and packaging gate.
- No browser, X server, disposable profile, watcher, or other long-running process was left behind.
- The browser smoke was not repeated for the two narrow coordinator-control-flow repairs: deterministic Chrome API failure/focus injection belongs to the Bun Chrome-boundary harness, while the existing real-browser smoke still verifies the unchanged successful active/unmuted and stash-retention paths.

## 5. Close-out confirmation

- Task 2 plan checkboxes are complete.
- Documentation and smoke evidence are current.
- `VERSION` and `manifest.json` are both `1.2.4`.
- Implementation commit: `1c87d7a7a966a290f5ecc108f97535dee7069dc9` (`fix: make tab restoration recoverable`).
- Independent-review repair commit: `4204782a204ddf2cc072b7fb7d6f8e52b484480c` (`fix: preserve restore siblings after seed failure`).
- Second independent-review repair commit: `3906670200e01a75a712204cb8c876becd903ceb` (`fix: stabilize restore-here window`).
- Commit author email and Codex co-author trailer match the required identities.
- Worktree branch `codex/reliability-hardening` is clean.
- Per the Task 2 orchestration boundary, no tag, push, release, `main` mutation, parent-checkout mutation, or final handoff was performed.
