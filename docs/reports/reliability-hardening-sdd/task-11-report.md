# Task 11 Implementation Report

Date: 2026-07-19

Base: `dc16829ae51efd0225a6d70669bcb93820780769`

Target version: `1.2.13`

Commit: controller-owned closeout (not created by implementer)

## 1. What was built

- Kept the existing `sidepanel/message-client.js` contract as the one raw
  runtime request boundary and routed every side-panel request/response command
  through `sendOrThrow()` or a component adapter that delegates to it.
- Made `toast.js` resolve its document container only when displaying a toast,
  so every request/response component imports without a DOM.
- Added the tested prototype `send(msg) { return sendOrThrow(msg); }` adapter to
  AI Settings, Command Bar, Drive Sync, Duplicate Finder, Focus, Group Editor,
  Sessions, Settings, Stashes, Tabs, and Windows. Existing constructor injection
  remains available where it was already part of a test/runtime seam. Drive Sync
  retains its Task 10-compatible `sendMessage` instance seam while its default
  and prototype boundary both delegate to the same helper.
- Converted the panel shell and all component commands to checked promises.
  Every promise is awaited, returned, or explicitly caught; success feedback,
  committed projections, and refreshes that imply success now follow checked
  resolution. Post-commit projection failures and intentional best-effort
  refreshes are handled explicitly.
- Restored Ctrl+K open-tab results with exported `flattenGroupedTabs()` over the
  worker's ordered `{ domain, tabs }[]` response. The validator accepts `[]`,
  preserves group/tab order, and rejects null, primitives, error-shaped data,
  obsolete wrappers, malformed groups, inherited `tabs`, and non-array tabs with
  `Grouped tabs are unavailable`.
- Added one accessible unavailable renderer with the exact copy
  `Search unavailable — try again.`. Rejected or malformed loading clears tab,
  stash, and session caches and renders that alert once; valid empty/no-match
  data remains an ordinary `No results found` result.
- Added/expanded the three focused regression files, architecture/progress/
  changelog/smoke evidence, Task 11 plan state, and version parity at `1.2.13`.
- Did not modify `service-worker.js`, `sidepanel/message-client.js`, a package or
  lockfile, release history, tags, remotes, or credentials.

## 2. Verification evidence

### Mandatory pre-production RED

Before any Task 11 production edit, the required focused command ran against
the clean Task 10 tree:

```text
bun test tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/sidepanel/global-search.test.js

4 pass
5 fail
1 error
15 expect() calls
exit 1
```

The failures were the intended missing Task 11 behavior:

- `global-search.js` did not export `SEARCH_UNAVAILABLE_MESSAGE` or
  `flattenGroupedTabs()`, so its test module failed to load.
- `toast.js` read `document` at module evaluation time, so component imports
  failed with `ReferenceError: document is not defined`.
- seven component files, `global-search.js`, and `panel.js` still contained raw
  `chrome.runtime.sendMessage` calls in addition to the one helper.
- checked focus-tab promises were not awaited or caught.
- component prototype adapters still returned unchecked raw runtime responses.

An initial run was also RED at 3 pass, 6 fail, 1 error, and 6 expectations.
It exposed a test-harness issue: the Chrome mock structured-clones successful
objects, so object identity could not prove that `sendOrThrow()` returns the
actual runtime value. The test was corrected before production work to stub the
runtime method directly; the corrected run above proves value identity without
weakening the contract.

### Controller final-review repair RED (supersedes the earlier closeout state)

After the controller's independent final review and before any repair production
edit, the required affected command ran against the uncommitted Task 11 tree:

```text
bun test tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/sidepanel/global-search.test.js \
  tests/core/state-mutation-lock.test.js \
  tests/integration/drive-cleanup.test.js

78 pass
13 fail
480 expect() calls
exit 1
```

The 13 failures reproduced every reviewed boundary rather than a fixture typo:

- current-schema stashes with only `windows[].tabs` did not match nested title
  or URL data, and stash/session metadata still read legacy `date`/flat fields;
- search had no unavailable/ready load state, so typing could overwrite the
  unavailable result and later success could not be represented explicitly;
- rejected `tabs.update()` and `windows.update()` promises escaped unhandled,
  while search closed instead of rendering a safe accessible activation error;
- Settings Manager owned an instance `send`, Drive Sync owned `sendMessage`, and
  Drive Sync methods therefore bypassed the exact prototype adapter;
- incomplete stash outcome text was replaced by generic restoration copy when
  its committed result could not refresh;
- Group Editor had no committed-state methods for discard, stash, ungroup,
  close, or bulk collapse/expand, so its mutation and projection errors shared
  one catch;
- the systematic request-site/source audit rejected the missing Group Editor
  committed-state structure.

The two Chrome activation failures also surfaced the exact previously-unhandled
synthetic rejections (`private tab failure` and `private window failure`), which
is the intended RED proof for that bug. Repair GREEN, controller review, tracked
documentation refresh, and a new terminal-tree Chrome run remain pending.

After the requested production repairs, the first focused repair run was:

```text
bun test tests/sidepanel/global-search.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/core/state-mutation-lock.test.js \
  tests/integration/drive-cleanup.test.js

84 pass
3 fail
512 expect() calls
exit 1
```

All three remaining failures were test-harness/assertion defects, not observed
production regressions:

- the current-schema Global Search test replaced `_renderResults()` with a
  capture stub and then accidentally called that stub when trying to inspect
  rendered metadata, so no stash DOM item could exist;
- the component source audit still expected the deliberately removed Drive Sync
  `send = sendOrThrow` constructor seam even though the repair requires the
  exact prototype adapter and no instance shadow;
- the Group Editor committed-mutation test rejected every success notice whose
  text began with `Kebab` or `Stash`, instead of rejecting only mutation-failure
  notices, so it classified the expected committed messages as failures.

These test defects are retained here before their correction so the repair
sequence remains auditable. A corrected focused/affected/full GREEN is pending.

### Controller-review repair GREEN (current frozen tree)

After correcting only those three test defects, the repaired production and
test tree was frozen at the exact Git tree object:

```text
d76f71f9766ace619f0f9a59c2c361f925bae372
```

The tree object was computed with an isolated temporary index populated by
`git add -A -- .`, so it includes the two new untracked-in-the-real-index test
files without modifying the controller-owned index.

All deterministic gates passed under Bun `1.3.11`:

```text
bun test tests/sidepanel/global-search.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/core/state-mutation-lock.test.js \
  tests/integration/drive-cleanup.test.js
87 pass
0 fail
523 expect() calls

bun test tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/sidepanel/global-search.test.js
38 pass
0 fail
157 expect() calls

bun test tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/sidepanel/global-search.test.js \
  tests/core/state-mutation-lock.test.js \
  tests/integration/drive-cleanup.test.js
91 pass
0 fail
536 expect() calls

bun test
513 pass
0 fail
2831 expect() calls

bun test --coverage
513 pass
0 fail
2831 expect() calls
50.52% functions
49.72% lines

bun test tests/syntax.test.js
2 pass
0 fail
100 expect() calls
```

`git diff --check` passed. The raw runtime request audit still returns exactly:

```text
sidepanel/message-client.js:2:  const response = await chrome.runtime.sendMessage(message);
```

No service-worker/core production, package, lockfile, commit, tag, remote,
release, credential, or Chrome mutation was performed during this repair. The
previous Chrome result below is historical for the pre-repair tree and must not
be treated as proof for `d76f71f9766ace619f0f9a59c2c361f925bae372`.

The earlier GREEN evidence below describes the pre-review tree and is retained
as historical evidence; it is not the current closeout claim.

### Final deterministic GREEN (pre-review tree; historical)

All commands ran against the frozen tracked Task 11 tree under Bun `1.3.11`:

```text
bun test tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/sidepanel/global-search.test.js
29 pass
0 fail
123 expect() calls

bun test tests/core/state-mutation-lock.test.js
27 pass
0 fail
149 expect() calls

bun test
503 pass
0 fail
2783 expect() calls

bun test --coverage
503 pass
0 fail
2783 expect() calls
48.09% functions
47.75% lines

bun test tests/syntax.test.js
2 pass
0 fail
100 expect() calls
```

There is no repository-wide coverage threshold. `git diff --check` passed.
`VERSION` and `manifest.json` both contain `1.2.13`. The root dependency/lockfile
audit returned zero files, and both `service-worker.js` and
`sidepanel/message-client.js` have zero Task 11 diff.

The exact raw-runtime audit is:

```text
$ rg -n "chrome\\.runtime\\.sendMessage" sidepanel --glob '*.js'
sidepanel/message-client.js:2:  const response = await chrome.runtime.sendMessage(message);
```

The helper-only exact-path assertion passed; there are no request/response raw
calls to classify as exceptions. Runtime `onMessage` listeners, service-worker
progress broadcasts, and long-lived Chrome-AI ports remain outside this search
and outside the checked command helper by design.

### Real Chrome terminal-tree GREEN

The reproducible gitdir-local harness is:

```text
/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-11-browser-smoke.js
```

After every tracked production, test, documentation, plan, and version change
was frozen, it passed against this exact uncommitted tree:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
extension ID: igggfmpiljhefkagnphadfadollcimlh
tested tree: b295e3bf46ff8bc1a500d83262cf55e4bda79b4b

checked cleanup failure:
  safe error toast count: 1
  safe error text: Cleanup failed: Drive cleanup failed
  success toast count: 0
  optimistic mutation count: 0
  unhandled rejection count: 0
  panel page error count: 0
  controls restored: true

grouped global search:
  synthetic-alpha: 2
  synthetic-beta: 1
  Open Tabs: 5
  Stashes: 1
  Sessions: 1
  grouped order preserved: true
  synthetic stash present: true
  synthetic session present: true
  valid no-match text: No results found
  unavailable alert visible for valid data: false

HTTP(S) requests intercepted before network: 0
external requests reaching network: 0
profile entries before cleanup: 315
CLEANUP_PROFILE_REMOVED=1
CLEANUP_CHROME_PROCESS_COUNT=0
CLEANUP_XVFB_PROCESS_EXITED=1
```

The cleanup fixture is natural rather than a production test hook:
`driveSync.connected=true`, `neverDeleteFromDrive=false`, and no
`driveProfileName` reach production profile validation, fail before OAuth or
network, and make the worker return its generic safe error-shaped response. The
harness exposes no token, private URL, storage value, browsing payload, or
credential.

The successful functional-tree run before tracked prose/version updates also
passed at tree `11afd6d6609f8c3b8b046ed2d5f43faef7ff6098`; it is superseded by
the terminal run above. The only prior Chrome attempt timed out at Ctrl+K because
Chrome consumes the physical accelerator as an omnibox command when panel.html
is hosted in a test tab; it had already passed the cleanup-failure assertions and
removed its profile/processes/display. The terminal harness dispatches the same
document `KeyboardEvent` the real side panel receives and documents that
boundary explicitly.

## 3. Assumptions made

- The controller's explicit no-commit instruction overrides the generated
  brief's implementer commit paragraph.
- A service-worker cleanup error is safe to display only through its existing
  generic `Drive cleanup failed` response. The Chrome fixture deliberately
  exercises that scrubbed response and never exposes the internal profile error.
- A test-tab-hosted panel cannot be made a genuinely tab-free Chrome profile,
  because its own page participates in `chrome.tabs.query({})`. Real Chrome
  therefore proves a valid loaded profile plus unmatched query uses
  `No results found`; deterministic tests separately prove genuinely empty valid
  arrays are successful and malformed/rejected arrays use the unavailable alert.

## 4. Concerns and adjacent observations

- No Task 11 production blocker remains.
- The Task 11 tracked plan file list does not yet name the now-affected
  `tests/core/state-mutation-lock.test.js`; add that scope entry during the
  controller-authorized tracked documentation refresh.
- The real-Chrome fixture is a local worker/UI proof, not a live Drive/OAuth
  proof. It intentionally fails before authentication and creates no Drive
  artifact. The separately tracked registered-identity/operator-authenticated
  two-profile Drive fixture remains unpassed.
- Coverage percentages decreased relative to Task 10 because the DOM-free
  component-import test brings all side-panel modules into coverage accounting;
  the final pass count and checked boundary assertions are green, and the repo
  defines no aggregate threshold.
- The terminal Ctrl+K proof validates the production document handler and UI,
  not Chrome's browser-level accelerator routing in an actual side-panel host.

## 5. Close-out confirmation

Implementation and deterministic regression evidence are complete on frozen
tree `d76f71f9766ace619f0f9a59c2c361f925bae372`. The worktree remains
intentionally uncommitted at base
`dc16829ae51efd0225a6d70669bcb93820780769`; 23 tracked files are modified and
two approved test files are untracked. The only current scope-list delta is the
review-requested `tests/core/state-mutation-lock.test.js` change documented
above. There is no service-worker/core production, dependency, lockfile, tag,
remote, release, credential, or repair-tree Chrome mutation.

Controller-owned remaining work:

1. inspect the full uncommitted diff and this report;
2. perform independent final review, update tracked plan/docs/evidence, and run
   a new terminal-tree Chrome proof after that tracked tree is frozen;
3. commit with the required author/trailer, annotate `v1.2.13`, and atomically
   push the commit plus tag;
4. verify exact-commit GitHub Actions;
5. create and verify the Phase 2 GitHub release with Drive v2, deletion
   convergence, portable data, checked messaging, and grouped-search notes.

## 6. Second reviewer-repair RED

Against frozen repair tree `d76f71f9766ace619f0f9a59c2c361f925bae372`, and before
any second-pass production edit, the expanded affected command ran:

```text
bun test tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/sidepanel/global-search.test.js \
  tests/core/state-mutation-lock.test.js \
  tests/integration/drive-cleanup.test.js

91 pass
20 fail
555 expect() calls
exit 1
```

The twenty failures were the intended second-review regressions:

- nine malformed `listStashes`/`listSessions` variants (null, false, wrong
  top-level shape, records without own `windows`, invalid windows, and windows
  without own array `tabs`) were committed as ready caches;
- a slower same-lifecycle fetch replaced a newer fetch, and a rejected fetch
  from a closed lifecycle cleared the reopened search;
- stale tab-activation success closed the reopened overlay, while stale
  activation failure rendered its alert into the reopened overlay;
- Window List exposed no owned Bring-to-Front behavior and its direct
  `chrome.windows.update()` remained unawaited;
- Duplicate Finder omitted Undo from the committed-close/failed-scan error;
- AI Settings used one or two toggles instead of one idempotent checked
  `setKeepAwake` request, including on rejection;
- Command Bar left the confirmed action on `Executing...` after rejection;
- Drive settings Undo let a previous-settings storage rejection escape;
- the corrected Bun `1.3.11` inventory audited exactly the panel plus fourteen
  component modules and identified the unsafe direct Chrome request at
  `sidepanel/components/window-list.js:398`.

The static audit also accepted the existing concise returned
`loadFocusState: () => sendOrThrow(...)` arrow and all awaited direct Chrome
calls, so its one reported request site is the reviewed defect rather than a
scanner false positive. Second-pass production GREEN is pending.

## 7. Second reviewer-repair GREEN

The bounded second-pass implementation and regressions are frozen at exact
tracked tree object:

```text
56f987dbd7157ed11a9a272202bd877646ee7f43
```

As before, the object was computed with an isolated temporary index populated
by `git add -A -- .`; the controller-owned real index was not changed and the
tree includes both new side-panel test files.

All requested deterministic gates passed under Bun `1.3.11`:

```text
bun test tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/sidepanel/global-search.test.js
58 pass
0 fail
253 expect() calls

bun test tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/sidepanel/global-search.test.js \
  tests/core/state-mutation-lock.test.js \
  tests/integration/drive-cleanup.test.js
111 pass
0 fail
632 expect() calls

bun test
533 pass
0 fail
2927 expect() calls

bun test --coverage
533 pass
0 fail
2927 expect() calls
52.37% functions
51.00% lines

bun test tests/syntax.test.js
2 pass
0 fail
100 expect() calls
```

`git diff --check` passed. The raw runtime boundary remains exactly:

```text
sidepanel/message-client.js:2:  const response = await chrome.runtime.sendMessage(message);
```

The direct promise-returning Chrome audit found six calls, all explicitly
awaited:

```text
sidepanel/components/window-list.js:295:          await chrome.windows.remove(win.windowId);
sidepanel/components/window-list.js:409:      await chrome.windows.update(windowId, { focused: true });
sidepanel/components/tab-list.js:164:    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
sidepanel/components/focus-panel.js:172:      const groups = await chrome.tabGroups.query({});
sidepanel/components/global-search.js:412:        await chrome.tabs.update(tabId, { active: true });
sidepanel/components/global-search.js:414:        await chrome.windows.update(windowId, { focused: true });
```

Second-pass production files are `ai-settings.js`, `command-bar.js`,
`drive-sync.js`, `duplicate-finder.js`, `global-search.js`, and
`window-list.js`. The only second-pass tracked-test edits are
`tests/sidepanel/component-messaging.test.js` and
`tests/sidepanel/global-search.test.js`. No service-worker/core production,
tracked documentation/plan/version, dependency, lockfile, Chrome, commit, tag,
remote, release, or credential mutation was performed.

## 8. Final bounded Command Bar and audit RED

Against frozen tree `56f987dbd7157ed11a9a272202bd877646ee7f43`, before the
final bounded production edit, the affected command ran:

```text
bun test tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/sidepanel/global-search.test.js \
  tests/core/state-mutation-lock.test.js \
  tests/integration/drive-cleanup.test.js

113 pass
2 fail
644 expect() calls
exit 1
```

Both failures were the intended deferred Command Bar ownership cases: while an
old confirmed command was pending, `pending` remained false and the input
remained enabled; its eventual success or failure therefore still owned the UI
after a newer confirmation was rendered. The same tests continue through both
settlement paths and assert the newer confirmation, input value, and toast area
must remain untouched.

The tightened scanner regressions were already GREEN in this RED run: the exact
15-file inventory rejects concise event-listener arrows for direct Chrome,
`Storage`, and raw `chrome.storage` promises, while explicitly accepting only
the known returned `loadFocusState: () => sendOrThrow(...)` callback. Drive
confirm rejection coverage also passed with false return, safe notification,
and zero runtime mutation. Final production GREEN is pending.

## 9. Final bounded Command Bar and audit GREEN

The final bounded implementation and regressions are frozen at exact tracked
tree object:

```text
c925bf65dfdabbb0358ab5a0d5570192a8eeafcc
```

The object was computed with an isolated temporary index populated by
`git add -A -- .`; the controller-owned real index was not changed and the tree
includes both new side-panel test files.

The same affected command that produced the two-test RED is now GREEN:

```text
bun test tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/sidepanel/global-search.test.js \
  tests/core/state-mutation-lock.test.js \
  tests/integration/drive-cleanup.test.js
115 pass
0 fail
656 expect() calls

bun test tests/sidepanel/message-client.test.js \
  tests/sidepanel/component-messaging.test.js \
  tests/sidepanel/global-search.test.js
62 pass
0 fail
277 expect() calls

bun test
537 pass
0 fail
2951 expect() calls

bun test --coverage
537 pass
0 fail
2951 expect() calls
52.53% functions
51.06% lines

bun test tests/syntax.test.js
2 pass
0 fail
100 expect() calls
```

`git diff --check` passed. The raw runtime boundary remains exactly:

```text
sidepanel/message-client.js:2:  const response = await chrome.runtime.sendMessage(message);
```

The direct promise-returning Chrome audit still found the same six calls, all
explicitly awaited. The expanded storage audit found eleven `Storage` or raw
`chrome.storage` calls, also all explicitly awaited. The exact 15-file request
scanner passed and its unit regression proves a concise `addEventListener`
arrow is rejected while only the semantically precise returned
`loadFocusState: () => sendOrThrow(...)` callback is exempted.

While a confirmed command owns the current confirmation generation, it now
sets `pending`, disables the input, and renders its busy state. A newer
programmatic result render invalidates that generation and reverses the busy
state; stale success and failure settlements cannot toast, clear, restore, or
otherwise overwrite the newer UI. An immediate owned rejection restores the
same retry/cancel controls and re-enables the input. Drive confirmation
rejection remains production-owned and is now covered for false return, safe
notification, and zero runtime mutation.

Relative to the preceding frozen tree, this final bounded delta changes only
`sidepanel/components/command-bar.js` and
`tests/sidepanel/component-messaging.test.js`; this gitdir report is the only
non-tree evidence update. No other production, tracked documentation/plan,
version, dependency, lockfile, Chrome, service-worker/core production, commit,
tag, remote, release, or credential mutation was performed in this final
repair.

## 10. Terminal real-Chrome evidence

After the tracked documentation and plan evidence were frozen, the controller
ran the tree-hash-guarded real-Chrome harness against exact tracked tree:

```text
6d2c6df5fa57762349de972fc5d7daf48433596e
```

The official browser boundary and redacted result were:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
extension ID: igggfmpiljhefkagnphadfadollcimlh

checked cleanup failure toasts: 1
safe failure text: Cleanup failed: Drive cleanup failed
checked cleanup success toasts: 0
optimistic mutations: 0
unhandled rejections: 0
panel page errors: 0
controls restored: true

synthetic-alpha grouped tabs: 2
synthetic-beta grouped tabs: 1
Ctrl+K sections: Open Tabs 5, Stashes 1, Sessions 1
grouped order preserved: true
current nested stash match: true
current nested session match: true
valid no-match text: No results found
unavailable alert for valid data: false

requests intercepted before network: 0
external requests reaching network: 0
disposable profile entries before cleanup: 315
profile removed: true
matching Chrome processes after cleanup: 0
Xvfb exited: true
```

The harness used the production service worker and side-panel UI with only
synthetic local records. It deliberately failed the Drive cleanup before OAuth,
proved the checked error response did not create optimistic state, exercised
the current nested stash/session schemas through Ctrl+K search, and verified
complete process/profile cleanup. This is not a live Drive/OAuth fixture and
does not create a Drive artifact. No tracked file was changed after this run.

## 11. Terminal gate timer repair

The first full-suite rerun after Section 10 exposed one timing-dependent error
that the earlier green runs had missed:

```text
529 pass
0 fail
1 error
2916 expect() calls

ReferenceError: chrome is not defined
Storage.get -> reconcileBadgeUnlocked
```

The cached high-confidence Focus navigation fixture scheduled the production
two-second distraction-badge reset, completed, and removed its Chrome mock.
The unowned async timer later attempted storage access and rejected between
tests. Deterministic regressions were RED at `52 pass / 2 fail / 151 assertions`:
an authoritative repaint did not cancel the pending timer, and a missing Chrome
context received the timer's rejected Promise instead of one owned warning.

The first bounded repair tracked timer identity, caught reset failure with one
generic warning, and went GREEN at `54 pass / 0 fail / 155 assertions`. An
independent concurrency review then found a narrower race: a fired old timer
could validate ownership before waiting behind a newer distraction repaint.
The overlapping-flash regression was RED at `0 pass / 1 fail / 2 assertions`.

The final repair makes badge reconciliation and timer state one serialized
operation. Timer callbacks recheck identity after queue entry, authoritative
repaints cancel only after successful current-state reconciliation, and a new
distraction re-arms its timer before releasing the queue. The final lifecycle
suite is `56 pass / 0 fail / 164 assertions`; independent semantic review
reports zero Critical, Important, or Minor findings.

One later full run reported a failure in an unchanged live-group-query startup
test. The exact assertion was truncated. The file passed `22/22`, its exact test
passed alone, an independent full run passed, and four consecutive controller
full runs passed at `541/541`; no production or test edit was made for the
non-reproducing result. The final coverage run is also `541 pass / 0 fail /
2966 assertions`, with `52.52%` functions and `51.06%` lines.

The final bounded production expansion is only `core/focus.js`, with its
regressions in `tests/core/focus-lifecycle.test.js`. `service-worker.js`, every
other core production module, dependency state, and credential state remain
unchanged relative to the Task 10 checkpoint.

## 12. Superseding terminal real-Chrome evidence

After the timer repair, final review, tracked documentation update, and repeated
full-suite gates, the controller reran the tree-hash-guarded real-Chrome harness.
This result supersedes Section 10 and covers exact tracked tree:

```text
2915dab0c3c3c545059688118e00076cbbdb47bc
```

The official browser boundary and redacted result were unchanged:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
extension ID: igggfmpiljhefkagnphadfadollcimlh

checked cleanup failure toasts: 1
safe failure text: Cleanup failed: Drive cleanup failed
checked cleanup success toasts: 0
optimistic mutations: 0
unhandled rejections: 0
panel page errors: 0
controls restored: true

synthetic-alpha grouped tabs: 2
synthetic-beta grouped tabs: 1
Ctrl+K sections: Open Tabs 5, Stashes 1, Sessions 1
grouped order preserved: true
current nested stash match: true
current nested session match: true
valid no-match text: No results found
unavailable alert for valid data: false

requests intercepted before network: 0
external requests reaching network: 0
disposable profile entries before cleanup: 315
profile removed: true
matching Chrome processes after cleanup: 0
Xvfb exited: true
```

This is still a synthetic local worker/UI proof, not the separately tracked live
Drive/OAuth fixture. It created no Drive request or artifact and exposed no
token, private URL, storage payload, or credential. No tracked file was changed
after this terminal run.

## 13. Commit, tag, CI, and Phase 2 release

The staged tree exactly matched the terminal Chrome-tested tree before commit:

```text
commit: 2970c99f7284f080a7a0b3a0df401771c5944d99
tree:   2915dab0c3c3c545059688118e00076cbbdb47bc
tag:    v1.2.13
tag object: 77a32b38134aa17dd2f3da4d72a9ccb7d3268073
```

The commit uses Michel's required Git author email and the Codex co-author
trailer. Parent `main` fast-forwarded from `dc16829` to `2970c99`; `main` and
the annotated tag were pushed atomically. Remote verification returned:

```text
refs/heads/main:       2970c99f7284f080a7a0b3a0df401771c5944d99
refs/tags/v1.2.13:     77a32b38134aa17dd2f3da4d72a9ccb7d3268073
refs/tags/v1.2.13^{}:  2970c99f7284f080a7a0b3a0df401771c5944d99
```

Exact-commit GitHub Actions CI run `29683257356` completed successfully. The
verified non-draft, non-prerelease Phase 2 release is:

```text
TabKebab v1.2.13 - Phase 2 Reliability Hardening
https://github.com/michelabboud/tabkebab-chrome-ext/releases/tag/v1.2.13
published: 2026-07-19T10:24:27Z
```

The release notes explicitly record that dependency audit is not applicable
because the repository has no package manifest or lockfile, no credential
artifact is included, and the live two-profile Drive/OAuth fixture remains
unpassed and requires the registered identity plus an operator-authenticated
disposable Google test-user session.
