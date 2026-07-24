# Codex growth wave G1–G4 close-out

**Date:** 2026-07-21  
**Target branch:** `feat/growth-wave-g2-g4`  
**Base:** `main` at `5a6b40b`  
**Resumed lane:** G1 follow-ups are committed at `4676fe8`  
**Status:** COMPLETE — G1 follow-ups `4676fe8`, G2 `c2d0dd8`, G3 `6d50ab9`, G4 `9e77bb7`
(the historical blocker narrative below is preserved; per-task close-outs follow it)

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

## G3 close-out

### What was built

- Smart Group is now always available. When no enabled, usable BYO provider is
  configured, it transparently uses Chrome's built-in AI through the existing
  side-panel broker without changing or saving the user's AI settings.
- The point-of-use copy states that the zero-config path needs no key or
  account and that no data leaves the machine. Configured BYO providers still
  take precedence when enabled and usable.
- Smart Group now returns a fixed outcome describing whether AI was applied,
  which route ran, and whether an unavailable, timed-out/aborted, or other
  sanitized failure occurred. Raw provider and browser error text is never
  rendered in the fallback UI.
- AI failure no longer ends in the raw error toast or silently mutates tabs
  with an implicit fallback. A friendly inline explanation offers two working
  paths: one-click **Use domain grouping instead**, which invokes the existing
  deterministic grouping action, and **Set up an API key**, which navigates to
  the existing AI settings section.
- The transient Chrome-AI route shares the existing AI queue, cache scoping,
  120-second timeout, per-attempt `AbortController`, broker cancellation, and
  sanitized error boundary. No new dependency, drawer, telemetry, or remote
  code was introduced.

### Files touched

- `core/ai/ai-client.js`
- `core/ai/smart-group-route.js`
- `core/engine/solver-ai.js`
- `core/grouping.js`
- `sidepanel/components/smart-group-fallback.js`
- `sidepanel/components/tab-list.js`
- `sidepanel/panel.css`
- `sidepanel/panel.html`
- `sidepanel/panel.js`
- `tests/core/smart-group-coordinator.test.js`
- `tests/core/smart-group-route.test.js`
- `tests/sidepanel/component-messaging.test.js`
- `tests/sidepanel/smart-group-fallback.test.js`
- `docs/reports/2026-07-21-codex-growth-wave-g1-g4.md`

### Verification

The fallback-ladder tests were written first and observed failing because the
route module, inline component, point-of-use copy, and outcome handling did not
yet exist. Focused green gate:

```text
14 pass
0 fail
39 expect() calls
Ran 14 tests across 3 files. [44.00ms]
```

Focused component-boundary and G3 gate after enrolling the new component in
the repository's side-panel request audit:

```text
33 pass
0 fail
175 expect() calls
Ran 33 tests across 4 files. [101.00ms]
```

Fresh full-suite `bun test` tail:

```text
900 pass
0 fail
4975 expect() calls
Ran 900 tests across 47 files. [7.80s]
```

### Assumptions

- “No BYO key is configured” means there is no enabled usable keyed provider.
  A saved key for a disabled/unselected configuration does not prevent the
  zero-config Chrome-AI route. An enabled custom endpoint remains an explicit
  configured route even when it intentionally uses no API key.
- An explicitly selected Chrome built-in provider and the automatic
  zero-config path receive the same local-only point-of-use promise.
- “Falls back to a stated working non-AI action” means the extension presents
  the deterministic domain action inline and runs it with one click. It does
  not automatically rearrange tabs after an AI failure without the user's
  fallback click.
- A malformed or empty AI grouping result uses the same generic inline ladder
  as other sanitized AI failures. Built-in unavailability and timeout/abort
  retain their more specific friendly explanations.
- Per this lane's constraints, `VERSION`, `manifest.json`, and `CHANGELOG.md`
  were not touched, and no git command was run.

## G4 + wave close-out

### What changed

- Added the two missing privacy disclosures in `PRIVACY.md`, written against
  the current code rather than the earlier assumption:
  - Opening a stash list renders at most five stored favicon values per stash.
    The render gate accepts only bounded `http`, `https`, `chrome`, and `data`
    URLs; accepted HTTP(S) values are loaded from the hosts named by the stored
    URLs, and rejected or failed values use a local placeholder.
  - Optional bookmark HTML exports embed
    `https://www.google.com/s2/favicons` image URLs derived from tab hostnames.
    The request occurs when the exported HTML is opened.
- Updated the privacy policy's general local-only wording so those favicon
  disclosures are not contradicted elsewhere in the document.
- Added `docs/store-listing.md` with a 116-character short description, a
  plain-language long description that explains the `tabs` warning, current
  product features, privacy boundaries, and a permission-by-permission
  justification matching the manifest.
- The listing distinguishes TabKebab's no-account/no-backend default from
  optional Google Drive and hosted AI. Chrome built-in AI is described as
  on-device and keyless; OpenAI, Anthropic, and Gemini require user-supplied
  keys; user-configured Custom endpoints are correctly documented as
  optionally keyed because the current provider permits that.
- Bumped `VERSION` and `manifest.json` together from `1.2.19` to `1.2.20` and
  added the whole-wave `CHANGELOG.md` entry covering the G1 follow-ups, G2,
  G3, and G4.

### Permission audit

All entries in `manifest.json` were verified against current runtime call
sites:

- `tabs` reads open-tab metadata and performs requested activate, move, group,
  ungroup, discard, close, create, and restore actions.
- `tabGroups` queries and manages native Chrome tab groups.
- `storage` persists local product state and encrypted settings and holds
  session-scoped key/Focus state.
- `sidePanel` registers and opens the extension's interface.
- `identity` obtains and clears OAuth tokens for optional Drive operations.
- `alarms` drives session auto-save, auto-kebab, auto-stash, Drive sync and
  retention, bookmark snapshots, and Focus ticks.
- `bookmarks` reads the bookmark tree to locate the destination and creates
  TabKebab snapshot folders and entries.
- The three host permissions are used only for the corresponding optional
  OpenAI, Anthropic, and Gemini provider calls.
- The separately declared `drive.file` OAuth scope limits optional Drive
  access to files TabKebab created or the user explicitly opened with it.

### Verification

Fresh full-suite gate after the `1.2.20` lockstep bump:

```text
bun test v1.3.11 (af24e281)

900 pass
0 fail
4975 expect() calls
Ran 900 tests across 47 files. [9.48s]
```

The suite includes the syntax/version-parity test. The growth wave moved the
full-suite count from the G1-follow-up baseline of 876 to 900, adding 24
regressions across G2 and G3.

### Assumptions and follow-ups

- “No account” means no TabKebab account is required. Optional Drive uses a
  Google account, and optional hosted AI credentials come from the selected
  provider.
- “No server” means TabKebab operates no application backend. Direct,
  user-selected provider and Drive calls, plus the disclosed favicon image
  requests, remain explicitly documented.
- Domain grouping is a one-click fallback offered after Smart Group failure;
  it is not run automatically without the user's click.
- No G4 claim required a product-code change.
- `store/listing.txt`, `store/permissions.txt`, and
  `store/privacy-policy.txt` remain older submission-working copies.
  Synchronizing those files from the reviewed `docs/store-listing.md` draft is
  a separate store-publication follow-up.

### Close-out confirmation

- G4 privacy and store-listing documentation: complete
- Wave version lockstep: `1.2.20`
- Whole-wave changelog entry: complete
- Full suite: 900 pass, 0 fail
- Code changes in this lane: none
- New dependencies: none
- Git commands run in this lane: none
- Long-running processes left behind: none
