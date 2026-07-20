# Task 1 Report — Establish the Bun regression and CI boundary

## Status

Completed and committed on `codex/reliability-hardening`.

- Base: `d7b6cfb`
- Commit: `ff44e768a5bd2aa4888c394775f9a129b4b472b4`
- Version: `1.2.3` in both `VERSION` and `manifest.json`
- Author: `Michel Abboud <29182417+michelabboud@users.noreply.github.com>`
- Trailer: `Co-Authored-By: Codex <noreply@openai.com>`

## Implementation summary

- Added Bun `1.3.11` test configuration and a per-test preload without a package manifest, dependency, bundler, generated runtime code, DOM shim, or IndexedDB shim.
- Added a resettable Chrome test boundary with separate local/session storage, Chrome-shaped storage changes, asynchronous events, mutable tab/window/group state, call recording, one-shot failures, runtime messages, peer-only ports, and the required alarms/action/sidePanel/bookmarks/identity surfaces.
- Added repository-wide JavaScript parsing plus Manifest V3 and `VERSION` consistency checks.
- Added the approved side-panel `sendOrThrow()` boundary and contract tests.
- Added the exact GitHub Actions gate for pull requests, manual dispatch, and pushes to `main`, excluding tag pushes.
- Updated contributor, architecture, progress, changelog, version, ignore, and approved-plan documentation. The plan's invalid inline `await` example was corrected to await the source before passing it to the synchronous parser.

## Files

Created:

- `.github/workflows/ci.yml`
- `bunfig.toml`
- `sidepanel/message-client.js`
- `tests/setup.js`
- `tests/helpers/chrome-mock.js`
- `tests/harness.test.js`
- `tests/syntax.test.js`
- `tests/sidepanel/message-client.test.js`

Modified:

- `.gitignore`
- `README.md`
- `CONTRIBUTING.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`

## TDD RED evidence

### Initial Chrome harness boundary

Command:

```text
bun test tests/harness.test.js
```

Expected RED result before the helper and preload existed:

```text
error: Cannot find module './helpers/chrome-mock.js' from '.../tests/harness.test.js'
0 pass
1 fail
1 error
Ran 1 test across 1 file. [21.00ms]
```

Expected failure reason: the required Chrome mock module had not been implemented.

### Checked side-panel message boundary

Command:

```text
bun test tests/sidepanel/message-client.test.js
```

Expected RED result before production implementation:

```text
error: Cannot find module '../../sidepanel/message-client.js' from '.../tests/sidepanel/message-client.test.js'
0 pass
1 fail
1 error
Ran 1 test across 1 file. [18.00ms]
```

Expected failure reason: `sendOrThrow()` did not yet exist.

### Review-driven mock regressions

Each defect was reproduced with a focused failing test before its fix:

- Async `sendResponse`: expected `{ ok: true }`, received `undefined`; `0 pass`, `1 fail`.
- Port reset isolation: expected `{ client: 1, worker: 1 }`, received `{ client: 0, worker: 0 }`; full harness `11 pass`, `1 fail`.
- Default window focus: expected `created.focused === true`, received `false`; `0 pass`, `1 fail`.
- `getBytesInUse()` call recording: expected no `storage.get` call, received `[["theme"]]`; `0 pass`, `1 fail`.

Root causes were respectively: not awaiting a kept-open runtime channel, tracked port pairs never being disconnected by reset, `normalizeWindow()` retaining its false default, and `getBytesInUse()` calling the public mocked `get()` method internally.

## GREEN evidence

Initial message boundary GREEN:

```text
bun test tests/sidepanel/message-client.test.js
4 pass
0 fail
5 expect() calls
```

Final required commands, run after review fixes and documentation/plan updates:

```text
bun test tests/harness.test.js
15 pass
0 fail
41 expect() calls
Ran 15 tests across 1 file. [34.00ms]
```

```text
bun test
21 pass
0 fail
104 expect() calls
Ran 21 tests across 3 files. [78.00ms]
```

```text
bun test --coverage
21 pass
0 fail
104 expect() calls
All files: 84.79% functions, 85.96% lines
sidepanel/message-client.js: 100.00% functions, 100.00% lines
Ran 21 tests across 3 files. [76.00ms]
```

```text
bun test tests/syntax.test.js
2 pass
0 fail
58 expect() calls
Ran 2 tests across 1 file. [50.00ms]
```

Closeout audit:

```text
git diff --check
# no output

git status --short --branch
## codex/reliability-hardening
```

No `coverage/` output appeared in `git status`; no `package.json` exists.

## Self-review

- Confirmed all five fixed helper exports and the exact install overrides/return controls are present.
- Confirmed storage state and listeners reset across tests, local/session areas stay separate, setters emit Chrome-shaped records, and injected setter failures are consumed once.
- Confirmed runtime ports deliver only to their peer, disconnect both endpoints once, and become unusable after test reset.
- Confirmed `runtime.sendMessage()` supports the production service worker's `return true` plus asynchronous `sendResponse()` pattern.
- Confirmed seeded and created tabs/windows/groups mutate deterministically, including Chrome-compatible default and explicit-background window focus.
- Confirmed the workflow uses only `actions/checkout@v4` and `oven-sh/setup-bun@v2`, reads `.bun-version`, has the required triggers, and runs the three commands in the required order.
- Confirmed docs describe Bun pinning, local commands, CI behavior, and the mock-versus-real-Chrome boundary.
- Confirmed every Task 1 checkbox is complete and backed by evidence.
- Independent reviewer ledger: one standard review agent; it reported no Critical issues, three Important mock-fidelity issues, and one Minor recording issue. All four were fixed with regressions before commit.

## Concerns and assumptions

- No real-Chrome smoke was run because Task 1 deliberately establishes the mocked orchestration boundary; DOM, IndexedDB, lifecycle, OAuth, and Prompt API behavior remain explicit later real-Chrome gates.
- The Chrome mock intentionally exposes a broad API surface for the approved later tasks. Its own coverage is lower than the checked production message client, but every behavior required by Task 1 has a direct regression and the plan defines no percentage threshold.
- The controller explicitly overrode the global tag/push closeout for this implementation slice. No tag, push, release, merge, or parent-checkout mutation was performed; the controller owns external closeout.

## Post-commit review repairs

The controller's mandatory Task 1 review identified four Important Chrome-mock fidelity issues after commit `ff44e768a5bd2aa4888c394775f9a129b4b472b4`. Each repair followed a separate witnessed RED/GREEN cycle.

Repair commit: `31df517` (`fix: harden Chrome mock isolation`).

### Changed files

- `tests/harness.test.js` — added four focused regressions.
- `tests/helpers/chrome-mock.js` — made replacement teardown synchronous, bound controls to their owner, cloned handler traffic, and preserved original move indexes.
- `CHANGELOG.md` — recorded the Task 1 review repairs under `1.2.3`.

### Review-repair RED evidence

#### 1. Replacement teardown ordering

```text
bun test tests/harness.test.js --test-name-pattern 'install cannot expose'

Expected: {}
Received: { "leakedFromPriorHarness": true }
0 pass
15 filtered out
1 fail
Ran 1 test across 1 file. [31.00ms]
```

Expected failure reason: `installChromeMock()` called asynchronous `resetChromeMock()` without awaiting it, so a prior port's delayed disconnect listener resumed against the replacement global mock.

#### 2. Instance-bound controls

```text
bun test tests/harness.test.js --test-name-pattern 'stale harness controls'

Expected: { "owner": "current" }
Received: { "owner": "stale" }
0 pass
16 filtered out
1 fail
Ran 1 test across 1 file. [23.00ms]
```

Expected failure reason: the stale controller's `setRuntimeHandler()` dereferenced module-global `activeHarness` instead of its owning harness.

#### 3. Runtime-handler serialization

```text
bun test tests/harness.test.js --test-name-pattern 'runtime handlers receive'

Expected caller message owner: "caller"
Received caller message owner: "mutated by handler"
0 pass
17 filtered out
1 fail
Ran 1 test across 1 file. [23.00ms]
```

Expected failure reason: `runtimeHandler` received the caller's message and returned its response by shared reference rather than across a cloned Chrome-message boundary.

#### 4. Original tab move index

```text
bun test tests/harness.test.js --test-name-pattern 'tabs.move reports'

Expected: { "windowId": 1, "fromIndex": 0, "toIndex": 2 }
Received: { "windowId": 1, "fromIndex": 2, "toIndex": 2 }
0 pass
18 filtered out
1 fail
Ran 1 test across 1 file. [23.00ms]
```

Expected failure reason: `tabs.move()` overwrote the tab index before constructing its `onMoved` record.

### Review-repair focused GREEN evidence

```text
bun test tests/harness.test.js --test-name-pattern 'install cannot expose'
1 pass, 0 fail, 15 filtered out, 1 expect() call
```

```text
bun test tests/harness.test.js --test-name-pattern 'stale harness controls'
1 pass, 0 fail, 16 filtered out, 1 expect() call
```

```text
bun test tests/harness.test.js --test-name-pattern 'runtime handlers receive'
1 pass, 0 fail, 17 filtered out, 2 expect() calls
```

```text
bun test tests/harness.test.js --test-name-pattern 'tabs.move reports'
1 pass, 0 fail, 18 filtered out, 1 expect() call
```

### Final GREEN gate after all repairs and documentation

```text
bun test tests/harness.test.js
19 pass
0 fail
46 expect() calls
Ran 19 tests across 1 file. [43.00ms]
```

```text
bun test
25 pass
0 fail
109 expect() calls
Ran 25 tests across 3 files. [81.00ms]
```

```text
bun test --coverage
25 pass
0 fail
109 expect() calls
All files: 86.83% functions, 87.68% lines
sidepanel/message-client.js: 100.00% functions, 100.00% lines
Ran 25 tests across 3 files. [154.00ms]
```

```text
bun test tests/syntax.test.js
2 pass
0 fail
58 expect() calls
Ran 2 tests across 1 file. [53.00ms]
```

The final output contained no warnings or errors. `git diff --check` was clean, no coverage directory appeared, and the runtime remains free of package, DOM, and IndexedDB shims.
