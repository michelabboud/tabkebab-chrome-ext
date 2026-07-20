# Task 11 Implementation Brief

## Objective

Implement the approved Task 11 slice from `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`: make every side-panel request/response call reject background `{ error }` results through the one `sendOrThrow()` boundary, move success UI effects after checked resolution, and restore Ctrl+K open-tab results by consuming and validating the worker's grouped-array contract.

- Base commit: `dc16829ae51efd0225a6d70669bcb93820780769`
- Expected version/tag after controller closeout: `1.2.13`
- Findings: 9 and 11
- Phase checkpoint: final Task of Phase 2; controller publishes the Phase 2 GitHub release after review
- Worktree: `/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening`
- Implementation report: `/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-11-report.md`

Start only from the controller-confirmed clean Task 10 commit. The implementer
must verify `git rev-parse HEAD` equals the exact base hash above before creating
tests or production changes.

Read the approved design, ADRs 0001-0004, the committed Task 10 report, and the current Task 1 `message-client` tests before coding. Preserve Task 10's worker-owned import/export and Focus-preference paths, success summaries, rollback errors, and one mutation lock. If a committed Task 10 component API differs, report the exact conflict rather than bypassing `sendOrThrow()`, weakening import checks, or adding another messaging wrapper.

Do not tag, push, publish a release, mutate `main`, or touch the parent checkout. The root controller owns tag/push/exact-CI/GitHub-release steps after independent review.

## Required files and hard scope boundary

Modify:

- `sidepanel/message-client.js`
- `tests/sidepanel/message-client.test.js`
- `docs/reports/2026-07-14-reliability-smoke.md`
- `sidepanel/panel.js`
- `sidepanel/components/ai-settings.js`
- `sidepanel/components/command-bar.js`
- `sidepanel/components/drive-sync.js`
- `sidepanel/components/duplicate-finder.js`
- `sidepanel/components/focus-panel.js`
- `sidepanel/components/global-search.js`
- `sidepanel/components/group-editor.js`
- `sidepanel/components/session-manager.js`
- `sidepanel/components/settings-manager.js`
- `sidepanel/components/stash-list.js`
- `sidepanel/components/tab-list.js`
- `sidepanel/components/window-list.js`
- `sidepanel/components/toast.js`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- the Task 11 checklist in the approved plan

Create:

- `tests/sidepanel/global-search.test.js`
- `tests/sidepanel/component-messaging.test.js`

Do not modify `service-worker.js`: its committed `getGroupedTabs` action already returns the current array from `getAllTabsGroupedByDomain()`, and Task 11 adapts the broken panel consumer. Do not change portable schema/import/rollback semantics, storage locking, Drive sync schema/retention, AI credential protection, provider errors/retry/AbortSignal handling, Chrome-AI ports, CI, packaging, or release artifacts. Tasks 12-15 own those later slices. Do not add a dependency, package/lockfile, DOM shim, build step, production failure hook, second message helper, new runtime response envelope, or ADR.

## Fixed request and search contracts

Keep these interfaces and exact copy:

```js
// sidepanel/message-client.js
export async function sendOrThrow(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

// sidepanel/components/global-search.js
export function flattenGroupedTabs(groupedTabs);
export const SEARCH_UNAVAILABLE_MESSAGE = 'Search unavailable — try again.';

// constructor injection remains optional in production
new GlobalSearch({ send = sendOrThrow } = {});
```

`sendOrThrow()` preserves successful values exactly, including valid `null`, `false`, `0`, empty arrays, and empty objects. It throws `new Error(response.error)` only when optional chaining observes a truthy `error`; it propagates native `sendMessage()` rejection unchanged. Do not add success-envelope requirements, stringify responses, swallow errors, log message payloads, or reinterpret a valid null as failure.

`flattenGroupedTabs()` accepts the current worker response directly: an array of `{ domain, tabs }` records. It returns a new flat array preserving group order and tab order. A valid empty array returns `[]`. It throws exactly `Error('Grouped tabs are unavailable')` for:

- `null`, `undefined`, or any non-array top level;
- an error-shaped object/array;
- the obsolete `{ groups: [...] }` wrapper;
- an array item that is null, an array, or not an object;
- an item without an own `tabs` array.

Do not silently skip malformed groups and do not treat malformed data as an empty successful search.

## One component adapter contract

These existing exported classes retain a prototype adapter with the exact implementation:

```js
send(msg) {
  return sendOrThrow(msg);
}
```

- `AISettings`
- `CommandBar`
- `DriveSync`
- `DuplicateFinder`
- `FocusPanel`
- `GroupEditor`
- `SessionManager`
- `SettingsManager`
- `StashList`
- `TabList`
- `WindowList`

Import `sendOrThrow` from `../message-client.js` using each component's correct relative path. Do not duplicate the `{ error }` check in a class. `GlobalSearch` is the sole exception: its constructor stores the injected `send`, and `_fetchAll()` calls that function for all three requests. `panel.js` is not a component class; its direct request/response calls import and call `sendOrThrow()` directly.

Move `toast.js`'s `document.getElementById('toast-container')` lookup inside `showToast()`. Importing any listed component with `globalThis.document` absent must not touch DOM. Actual `showToast()` behavior remains unchanged when a document exists; missing DOM during a real call is an error, not a silently discarded toast.

## Request/response audit boundary

Replace every side-panel request/response `chrome.runtime.sendMessage()` call with `sendOrThrow()` or a class adapter. This includes direct calls in `panel.js`, `drive-sync.js`, and `global-search.js`, plus existing raw `send()` implementations in the listed components.

Do not route these through `sendOrThrow()`:

- `chrome.runtime.onMessage` broadcast listeners;
- service-worker fire-and-forget progress/event broadcasts;
- Task 14's future `chrome.runtime.connect()` long-lived Chrome-AI port;
- direct Chrome APIs such as `chrome.tabs.update()` or `chrome.windows.update()` that are not runtime request/response messages.

After conversion, audit every `this.send(` and `sendOrThrow(` promise. Each must be awaited, returned, or terminate in an explicit `.catch()` whose comment explains genuinely intentional best-effort behavior. Convert event listeners to async where needed. No checked rejection may become an unhandled promise rejection.

Move every success toast, optimistic cache/DOM/state mutation, refresh implying success, and success-label reset after the checked promise resolves. On rejection, keep the pre-action state, show failure, and include the background message when it is user-safe. Never show both error and success for one action. Preserve Task 10 file-input `finally` resets and do not turn an import failure into a success refresh.

The source audit command must leave `sidepanel/message-client.js` as the only side-panel file containing `chrome.runtime.sendMessage`:

```bash
rg -n "chrome\\.runtime\\.sendMessage" sidepanel --glob '*.js'
test "$(rg -l "chrome\\.runtime\\.sendMessage" sidepanel --glob '*.js' | sort)" = "sidepanel/message-client.js"
```

If a committed Task 10 side-panel line appears to require a raw exception, classify it against the broadcast/port list above; do not add a second helper or waive a request/response call.

## Global-search behavior

`GlobalSearch` stores `this.send` from constructor injection. `_fetchAll()` performs the `getGroupedTabs`, `listStashes`, and `listSessions` checked requests and does not populate caches until all three have resolved and the grouped result has passed `flattenGroupedTabs()`.

On a rejected request or malformed grouped response:

- clear tab/stash/session caches and `flatItems` so stale successful data cannot remain visible;
- do not call the normal empty/success renderer or `_search()`;
- call `renderUnavailable(SEARCH_UNAVAILABLE_MESSAGE)` exactly once.

`renderUnavailable(message)` replaces the results container with one element matching `.search-empty[role="alert"]` whose text is exactly `Search unavailable — try again.`. It must be a narrow DOM render seam that tests can override without a DOM shim. A valid grouped empty array plus valid empty stash/session arrays remains a successful empty search and must not render the unavailable message.

The worker contract remains an array. Do not reintroduce or accept `{ groups: [...] }`, do not modify the worker to wrap the response, and do not hide malformed data behind `[]`.

## Mandatory TDD sequence

Do not edit production behavior until steps 1-5 exist and the focused pre-change command in step 6 has produced genuine RED evidence. Task 1's existing `message-client` cases may already be GREEN; preserve them as a baseline and obtain RED from the new import/component/search behavior rather than weakening a passing test.

1. Strengthen `tests/sidepanel/message-client.test.js` first. Assert identity-preserving success values, exact `{ error: 'Close failed' }` rejection message, unchanged native rejection object, and valid null. Add no success-envelope behavior.
2. Create `tests/sidepanel/component-messaging.test.js`. With `globalThis.document` absent, dynamically import each of the eleven classes named above. Call `Class.prototype.send.call({}, message)` and prove a mocked error-shaped response rejects with the exact message. Prove successful/null responses are unchanged and no import touches DOM.
3. Create `tests/sidepanel/global-search.test.js`. Cover two groups flattened in group/tab order, valid empty array, and every malformed shape listed in the fixed contract. Add a worker-contract fixture asserting `getAllTabsGroupedByDomain()` returns an array rather than an object wrapper.
4. Inject rejecting and malformed senders into `new GlobalSearch({ send })`, override only `renderUnavailable()` and the normal search/render seam, and assert `_fetchAll()` uses three checked calls, renders the exact unavailable message/alert path, clears stale caches, and never renders an empty successful result. Add the valid-empty success case.
5. Add representative checked-effect tests/source assertions for each component family and `panel.js`: an error-shaped response produces no success toast, optimistic state change, or success refresh; each promise is handled; Task 10 import/export controls preserve checked ordering and file reset. Add a source audit assertion that raw side-panel request/response calls remain only in `message-client.js`.
6. Run the focused suite against the pre-change Task 10 tree and preserve genuine RED output in `task-11-report.md`:

    ```bash
    bun test tests/sidepanel/message-client.test.js tests/sidepanel/component-messaging.test.js tests/sidepanel/global-search.test.js
    ```

    Expected RED causes include top-level DOM access in `toast.js`, raw component adapters, missing constructor injection/flatten helper, and the obsolete `.groups` lookup that drops every open tab.
7. Implement the minimum Task 11 production slice required to make the focused suite GREEN. Do not change worker response shapes or implement Tasks 12-15.
8. Run the raw-message source audit and manually classify the sole expected helper line. Audit every checked promise for await/return/explicit catch.
9. Re-run the focused command and record exact pass/fail/expect counts. Then run every final gate freshly:

    ```bash
    bun --version
    bun test tests/sidepanel/message-client.test.js tests/sidepanel/component-messaging.test.js tests/sidepanel/global-search.test.js
    rg -n "chrome\\.runtime\\.sendMessage" sidepanel --glob '*.js'
    test "$(rg -l "chrome\\.runtime\\.sendMessage" sidepanel --glob '*.js' | sort)" = "sidepanel/message-client.js"
    bun test
    bun test --coverage
    bun test tests/syntax.test.js
    git diff --check
    test "$(cat VERSION)" = "$(bun -e 'console.log((await Bun.file("manifest.json").json()).version)')"
    test "$(find . -maxdepth 1 -type f \( -name 'package.json' -o -name 'bun.lock' -o -name 'bun.lockb' -o -name 'package-lock.json' -o -name 'npm-shrinkwrap.json' -o -name 'pnpm-lock.yaml' -o -name 'yarn.lock' \) -print | wc -l)" -eq 0
    git status --short
    ```

    Bun must remain `1.3.11`; focused/full/coverage/syntax and source-audit gates pass; `git diff --check` is clean; versions both equal `1.2.13`; root dependency/lockfile count remains zero. Before commit, `git status --short` must contain only approved Task 11 files; after commit it must be empty. Record changed-module coverage honestly without inventing a repository-wide threshold.

Use the repository Chrome mock and method/constructor injection. Do not add a DOM library. Tests may replace narrow render/toast seams and must restore globals, runtime handlers, module state, and timers in `finally`; no test-order dependence.

## Proportional real-Chrome gate

Use the installed official Chrome for Testing with a clean disposable profile and private-free synthetic tabs/stashes/sessions. Add no production failure hook and make no external AI/provider call.

1. Establish a representative checked background failure through an existing safe boundary. Use a clean disposable state with `driveSync.connected = true` but no `driveProfileName`, invoke manual Drive cleanup, and verify the worker returns an error-shaped response naturally. Do not authenticate or log OAuth state.
2. Confirm the panel shows one failure toast containing a safe message, no success toast, no optimistic success state, and no unhandled rejection. Reset the disposable state afterward.
3. Open synthetic tabs across multiple domain groups and create one synthetic stash and session. Open Ctrl+K and confirm open tabs appear alongside stash/session results, with grouped order preserved. Repeat with a valid empty profile and distinguish the normal empty result from unavailable.
4. Record Chrome version/hash, exact tested commit/tree, redacted counts/group labels, expected/actual result, and cleanup in `docs/reports/2026-07-14-reliability-smoke.md`. Do not record browsing history, private URLs, credentials, tokens, or full runtime payloads.
5. Remove the disposable profile/state and prove Chrome/Xvfb/CDP processes/listeners and temporary files are gone.

If the representative Drive cleanup path unexpectedly requires external authentication instead of failing at the missing-profile boundary, stop that subcase, record the exact blocker, and use another existing deterministic worker validation error without a production hook. Never claim a live network/Drive error path that was not exercised.

## Documentation, version, report, and commit

- Update `ARCHITECTURE.md` with the single checked request boundary, explicit broadcast/port exceptions, promise-handling rule, grouped-array search contract, and unavailable-versus-empty behavior.
- Update `CHANGELOG.md` and `PROGRESS.md` with Findings 9/11 evidence and record Phase 2 complete only after focused/full gates and applicable real-Chrome rows pass.
- Set both `VERSION` and `manifest.json` to `1.2.13`.
- Close a Task 11 plan checkbox only after its named RED/GREEN, source audit, UI ordering, browser, documentation, or release-preparation evidence exists.
- Write `task-11-report.md` in five sections: what was built; verification evidence with preserved RED and fresh GREEN/full-gate counts plus Chrome evidence; assumptions; concerns/adjacent observations; close-out confirmation. Include a component audit table, every remaining raw-message classification, checked-promise audit, malformed/empty/unavailable search truth table, toast/state ordering, cleanup, model/agent ledger, exact version comparison, root dependency/lockfile count, full commit hash, and final clean-worktree result.
- Commit with author email `29182417+michelabboud@users.noreply.github.com` and trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- Leave the worktree clean and report the full commit hash. No tag, push, GitHub release, `main` mutation, parent-checkout mutation, Chrome Web Store action, dependency, build artifact, or live network call by the implementer.

After independent review, the controller will tag/push `v1.2.13`, wait for exact-commit GitHub Actions, verify the remote tag target, and create/verify the Phase 2 GitHub release with notes covering Drive v2, deletion convergence, portable export/import, checked messaging, and global search. The controller records dependency audit as not applicable because the root package/lockfile count is zero. No credential-bearing artifact is attached and no Chrome Web Store publication occurs.

## Approved checklist (complete Task 11 intent)

- `sendOrThrow()` preserves valid success/null responses, rejects exact background error messages, and propagates native rejection unchanged.
- Every listed component delegates through the one helper; `panel.js` uses it directly; imports remain DOM-free after lazy toast lookup.
- Every request/response promise is awaited, returned, or intentionally caught; broadcasts and future long-lived ports remain outside the helper.
- Success toasts, refreshes, and optimistic mutations occur only after checked resolution; errors never render success.
- Raw side-panel `chrome.runtime.sendMessage` source remains only in `sidepanel/message-client.js` and the audit is recorded.
- `flattenGroupedTabs()` accepts only the current grouped array, preserves order, returns `[]` for valid empty, and throws the exact unavailable error for every malformed/obsolete shape.
- Global search uses injected checked sends, clears stale caches on failure, distinguishes unavailable from empty, and renders the exact accessible alert copy.
- Strict pre-change RED, focused GREEN, full Bun/coverage/syntax/source/whitespace/version/dependency gates, and honest coverage evidence are recorded.
- Real Chrome proves a background error cannot become success and Ctrl+K returns open tabs plus stashes/sessions without private evidence; cleanup is complete.
- No Task 12 credential work, Task 13 request lifecycle, Task 14 broker/port work, Task 15 CI/package work, dependency, build step, or worker response rewrite is included.
- Architecture/changelog/progress, version `1.2.13`, Phase 2 status, five-section report, model ledger, commit trailer, full hash, and clean worktree are complete before controller review/release.
