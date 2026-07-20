# Task 3 Implementation Brief

## Objective

Implement the approved Task 3 slice from `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`: one complete Focus allowlist policy shared by startup classification and navigation evaluation.

- Base commit: `3906670200e01a75a712204cb8c876becd903ceb`
- Expected version/tag after controller closeout: `1.2.5`
- Finding: 4
- Worktree: `/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening`
- Implementation report: `/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-3-report.md`

Do not tag, push, publish a release, mutate `main`, or touch the parent checkout. The root controller owns those steps after independent review.

## Required files

Create:

- `core/focus-policy.js`
- `tests/core/focus-policy.test.js`
- `tests/core/focus-start.test.js`

Modify as needed within scope:

- `docs/reports/2026-07-14-reliability-smoke.md`
- `core/focus.js`
- `service-worker.js`
- `sidepanel/components/focus-panel.js`
- `GUIDE.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- the Task 3 checklist in the approved plan
- existing dependency-free test helpers only when a real missing Chrome boundary requires it

## Fixed pure interfaces

```js
// core/focus-policy.js
export function isInternalUrl(url);
export function domainMatches(url, allowList);
export function urlMatches(url, allowList);
export function groupMatches(tab, allowList);
export function isAllowed(tabOrUrl, allowList);
export function createAllowlistEntry(type, value, liveGroups);
export function resolveGroupAllowlist(allowList, liveGroups);
export function rebindFocusAllowlist(state, liveGroups);
export function evaluateFocusPolicy(tabOrUrl, state);
```

`resolveGroupAllowlist()` returns new entries. Every group entry retains exactly `{ type: 'group', value: exactTitle }`, removes any persisted scalar `groupId`, and adds `groupIds` containing all currently live group IDs whose title exactly equals `value`. `groupMatches()` consults only `groupIds`; it must not trust scalar `groupId`, including stale persisted values. Chrome group ID `0` is valid.

## Policy semantics that are binding

- Preserve legacy plain-string domain entries and typed domain entries.
- Domain matching accepts the exact host and true subdomains only; reject lookalikes.
- URL entries are exact after URL canonicalization; never prefix-match.
- Internal Chrome/extension pages are always allowed and excluded from destructive/group startup actions.
- Policy evaluation order: internal URL, allowlist, explicit blocked domain, strict mode, curated category, otherwise unblocked. Preserve existing blocklist reason/category behavior.
- Strict + empty allowlist blocks every non-internal URL, including hostless/non-HTTP URLs. Non-strict + empty allowlist treats all eligible tabs as focus tabs.
- Startup `isFocusTab()` and navigation both delegate their allowlist decision to the same exported `isAllowed()` implementation. Do not recreate matching logic in `service-worker.js`.
- AI fallback must not classify internal or explicitly allowed pages; gate it with the same `isInternalUrl()` / `isAllowed()` policy functions while leaving Task 4 lifecycle work untouched.
- `kebab` and `stash` apply only to background non-focus tabs. Preserve the active-tab safety rule. `group` groups only eligible focus tabs.
- At `startFocus()`, query `chrome.tabGroups.query({})` exactly once before classifying or mutating tabs. Resolve only the active runtime state's allowlist; do not persist runtime IDs into profile preferences. A failed group query must abort before destructive startup actions.
- Rebinding is pure: replace, never union, old scalar/runtime group IDs from current exact-title matches. Rebind active and paused stored runs during service-worker initialization and immediately before resume, then persist the rebound runtime state. Profile preferences remain title-based across restarts.
- Keep built-in legacy domain-string profiles compatible.

## UI binding

- Add a `URL` option to `#focus-add-type`.
- Delegate all three shapes to `createAllowlistEntry()`:
  - domain: lowercase/canonical domain entry;
  - URL: `new URL()` canonical href, with case-sensitive path/query/fragment preserved;
  - group: exact live Chrome title only, never a numeric ID in preferences.
- Invalid input returns `null` and the panel shows a visible error.
- Keep a group's raw exact title separate from display fallback text. Do not persist a synthetic `Group <id>` title that cannot rebind; reject an untitled group visibly if necessary.
- Deduplicate by stable preference identity (`type + value`), so two live same-title groups create one title preference that resolves to all matching IDs.
- Update copy to say URL entries are exact and Chrome groups rebind by exact title at each run.
- Do not add a DOM implementation/shim merely to test panel markup. Exercise entry construction through the pure module.

## Mandatory TDD sequence

1. Write `tests/core/focus-policy.test.js` first. Cover legacy strings, typed domains, exact/subdomain allow, lookalike reject, exact URL allow, prefix reject, URL case preservation, same-title rebinding to two IDs, stale scalar/runtime ID replacement, group ID 0, cloning/immutability, internal allow, strict empty blocking, and all three valid/invalid entry shapes.
2. Write `tests/core/focus-start.test.js` before production changes. Dynamically import `core/focus.js` only after installing the Chrome mock because the module has import-time storage listeners/cache work.
3. Startup tests must prove domain/exact-URL/rebound-group parity; `kebab` and `stash` affect only background non-focus tabs; `group` affects only eligible focus tabs; non-strict empty means all eligible tabs focus; strict empty means every non-internal tab non-focus; group query occurs once before mutations and query failure is fail-closed.
4. Run `bun test tests/core/focus-policy.test.js tests/core/focus-start.test.js` against the current code and preserve the RED failures in the report.
5. Implement the narrow production slice, then make the focused suite GREEN.
6. Add/update integration-style worker coverage if required to prove initialization rebinding and navigation uses `evaluateFocusPolicy()` without duplicate matching. Do not broaden into Task 4 run-ID/async-classification lifecycle work.
7. Run the focused command, `bun test`, `bun test --coverage`, `bun test tests/syntax.test.js`, and `git diff --check`. Keep the repository dependency-free: no package manifest/lockfile, DOM/IndexedDB emulator, or production-only test hooks.

If startup stash behavior needs a test seam because Bun has no IndexedDB, use the smallest injected persistence adapter with the real implementation as the production default. Do not add an IndexedDB emulator.

## Real-Chrome gate

Append redacted evidence to `docs/reports/2026-07-14-reliability-smoke.md` using the already-installed official Chrome for Testing build and the existing disposable Xvfb/CDP approach. Do not download a browser.

Verify with AI disabled:

1. strict-empty rejects a non-internal URL;
2. one exact URL is allowed while a prefix-extension URL is not;
3. two live Chrome groups with the same exact title both resolve into runtime `groupIds`;
4. reload the extension before the group assertion and seed a stale scalar `groupId`, proving it is removed/not trusted;
5. profile preferences remain title-only;
6. disposable profile is removed and no matching Chrome/Xvfb process remains.

Do not claim unsupported behavior. Record exact browser build/hash, redacted commands/results, and cleanup.

## Documentation, version, and commit

- Update `GUIDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, and `PROGRESS.md` for the shipped behavior.
- Set both `VERSION` and `manifest.json` to `1.2.5`.
- Close all Task 3 checkboxes only after their evidence exists.
- Write the report with RED/GREEN evidence, exact final commands/counts, real-browser evidence, assumptions, concerns, and the model/agent ledger.
- Commit with author email `29182417+michelabboud@users.noreply.github.com` and trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- Leave the worktree clean and report the full commit hash. No tag/push/release.

## Approved checklist (verbatim intent)

- Policy unit tests cover all required domain, exact-URL, group rebinding, internal, and strict-empty cases.
- Startup tests prove one shared predicate and correct action selection.
- Startup resolves live groups once; active/paused state rebinds at initialization and resume without changing preferences.
- The panel supports domain, URL, and title-only group entry construction with visible invalid-input handling.
- Focused and full gates pass.
- Real Chrome proves strict-empty, exact URL, and same-title rebinding after reload.
- User and architecture documentation are current.
