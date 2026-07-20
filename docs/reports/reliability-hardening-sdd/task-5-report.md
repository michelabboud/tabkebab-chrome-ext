# Task 5 Close-out Report

## 1. What was built

- Added `core/url-match.js` with the approved `canonicalHostname()` and `hostnameMatches()` interfaces. Natural-language domain filters now compare canonical exact hosts or true subdomains, case-insensitively and with one trailing dot normalized, instead of using substring matching.
- Added strict filter-shape validation. A filter must be a plain record with at least one recognized predicate; every present domain/title/URL predicate must be valid. Malformed URLs and absent/non-string/empty/whitespace values fail closed while a genuinely absent domain property still allows title/URL filtering.
- Preserved committed-URL-first `pendingUrl` fallback for the pure filter contract. At the destructive close boundary only, a non-empty live pending destination is authoritative; if a title predicate is present, that tab fails closed until navigation settles because Chrome still exposes the committed page's stale title.
- Closed the natural-language close TOCTOU boundary: query once for the provider prompt, query again after parsing for the preview, validate the confirmation, then query/re-filter again and intersect with only preview-approved IDs. A navigated-away tab is not closed and a newly matching tab never expands an existing preview.
- Made `executeNLAction()` derive close/group/move/focus IDs only from the supplied live tab records. AI- or caller-provided `parsed.tabIds` remains approval metadata and cannot directly authorize mutation.
- Preserved fragments in duplicate identity while keeping existing path/trailing-slash/query normalization. Opaque-origin Chrome pages retain their full scheme/host identity rather than collapsing through `origin === "null"`.
- Added each duplicate tab's exact original `url`, plus `collectUndoUrls()` for a fresh ordered, non-deduplicating snapshot of the selected original URLs. The side panel freezes that snapshot before its first close/rescan await and Undo reopens exactly it.
- Preserved distinct hash routes through both session and stash duplicate detection so one saved route is restored when another route is already open.
- Fixed the adjacent Chrome new-tab defect: `chrome://newtab/` and `chrome://new-tab-page/` are excluded from both duplicate and inactive empty-page cleanup, while distinct internal pages such as Settings and Extensions no longer collapse together.
- Added 30 focused unit/integration regressions, updated README/user/release/progress/smoke documentation, and set `VERSION` and `manifest.json` to `1.2.7`. No DOM or IndexedDB shim, package, dependency, build step, or production-only test hook was added.

## 2. Verification evidence

Strict pre-production RED was captured on base commit `7a4075d840d04a084df6de3a33db5f32750e857d` before any Task 5 production file changed:

```text
bun test tests/core/nl-executor.test.js tests/core/duplicates.test.js tests/integration/hash-route-restore.test.js
4 pass, 15 fail, 18 expect() calls, 3 files, exit 1
```

The failures were the intended Task 5 regressions:

- `hostname.includes()` admitted both `notgithub.com` and `github.com.evil.test`, rejected a trailing-dot filter, threw `TypeError` for a numeric domain, and treated empty/null present domains as absent.
- The fixed `core/url-match.js` module did not exist.
- `normalizeUrl()` removed hash routes and ordinary fragments, merging `#/one` with `#/two`.
- Duplicate tab records omitted their exact original `url`; `collectUndoUrls()` did not exist.
- Two `chrome://newtab/` pages grouped under the broken key `null/`.
- Both session and stash restore counted route two as a duplicate when route one was open (`restoredCount: 0`, `skippedDuplicate: 1`).

Before production repair, the adversarial supplements expanded the focused result to `4 pass`, `22 fail`, `30 expect() calls`. Separate RED selections also proved that a pending navigation out of scope still allowed a close (`0 pass`, `1 fail`, `2 expect()` calls), injected `parsed.tabIds` overrode the supplied live tab, and whitespace-only text predicates validated as usable. The repaired tests cover post-AI and confirmation re-querying, preview-ID intersection without expansion, live pending-navigation authority, invalid command/filter rejection, and live-tab-only action IDs.

The independent pre-commit audit then found that destructive filtering projected a pending destination URL but retained the committed page's old title. Its worker confirmation regression was captured RED with `0 pass`, `1 fail`, `2 expect()` calls: expected a no-match error but received `Closed 1 tab(s)`. Pending destinations with `titleContains` now fail closed until Chrome supplies an authoritative settled title; the isolated test passed with four assertions before the complete matrix reran.

Fresh final automated gates on the documented `1.2.7` tree:

```text
bun --version
1.3.11

bun test tests/core/nl-executor.test.js tests/core/duplicates.test.js \
  tests/integration/hash-route-restore.test.js
30 pass, 0 fail, 85 expect() calls, 3 files

bun test
234 pass, 0 fail, 842 expect() calls, 18 files

bun test --coverage
234 pass, 0 fail, 842 expect() calls, 18 files
core/url-match.js: 100.00% functions, 100.00% lines
core/duplicates.js: 100.00% functions, 96.15% lines
core/nl-executor.js: 90.00% functions, 77.01% lines

bun test tests/syntax.test.js
2 pass, 0 fail, 80 expect() calls

git diff --check
clean

VERSION and manifest.json
both 1.2.7

root package/lock-file count
0

node_modules present
0
```

No repository-wide coverage threshold is configured. Completion is grounded in the named identity, restoration, TOCTOU, action-authority, and Undo regressions; the full suite; and the real-browser boundary.

The exact repaired/versioned tree then passed a fresh real-browser run with installed Chrome for Testing `148.0.7778.96` at `/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`, SHA-256 `adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f`. The unpacked extension, production worker, production custom-provider request, Chrome tab APIs, and production Duplicates panel DOM/events ran under a disposable loopback-TCP Xvfb display. The harness opened `sidepanel/panel.html` as an extension tab through CDP rather than invoking Chrome's side-panel host container. A loopback-only HTTPS server supplied deterministic page fixtures and an explicitly synthetic parsed close command; there was no public-network request, API key, or external model:

```text
NL preview:
  exact github.com accepted=1
  true docs.github.com subdomain accepted=1
  notgithub.com suffix lookalike rejected=1
  github.com.evil.test sibling lookalike rejected=1

production panel-document Duplicates UI:
  groups=3 (ordinary, #/one, #/two)
  selected duplicate copies=3
  counts after Close All=1,1,1
  counts after Undo=2,2,2

inactive Chrome new-tab pages:
  excluded from duplicates=1
  excluded from empty cleanup=1
  survived close/Undo=1

cleanup:
  profile entries before removal=247
  profile removed=1
  disposable TLS removed=1
  Chrome exited=1
  Xvfb exited=1
  residual profiles/processes/listeners=0
```

This browser result validates the real extension boundary, not provider availability, authentication, latency, or parsing quality. Full redacted commands, results, and cleanup are in `docs/reports/2026-07-14-reliability-smoke.md`.

Model/agent ledger: one Codex GPT-5 implementation subagent executed Task 5 in the isolated worktree; the root Codex controller coordinated scope and reviewed live progress. An independent Codex pre-commit reviewer audited the implementation and launched a focused documentation sub-audit; that review found the stale committed-title authority gap recorded above and held the commit until repair evidence existed. The root controller owns final review and integration decisions.

After repair and refreshed exact-tree evidence, the independent pre-commit reviewer reported the audit formally **CLEAN**. Its own fresh verification observed the focused suite at `30/30`, full suite at `234/234`, and `git diff --check` clean; the final documentation provenance wording was corrected before commit.

## 3. Assumptions made

- Followed the approved URL identity exactly: a fragment is part of duplicate/restore identity, while existing trailing-path-slash and query behavior remains unchanged.
- Treated a single trailing dot as canonical host syntax on either the filter or tab URL; no looser suffix or substring equivalence was added.
- Preserved the pure filter's committed-URL-first fallback contract. Only destructive preview/confirmation projects a non-empty pending destination over the committed URL because closing is irreversible; destructive title predicates exclude that navigating tab because the destination title is not yet known.
- Treated the preview's approved IDs as an upper bound. If live state changes, confirmation may narrow to zero or fewer tabs but never add a newly matching tab.
- Used an explicitly synthetic provider response because the approved browser gate forbids a real credential and does not ask for provider-quality evidence.
- Did not add an ADR: the approved design, plan, Task 5 brief, and fixed interfaces already settle these local URL/Undo semantics without introducing a new architectural decision.

## 4. Concerns and observations

- Fragment-aware identity intentionally treats different on-page anchors as different pages as well as protecting client-side routes. Users may retain two URLs that differ only by an ordinary fragment; this is the approved lossless behavior and avoids destroying route state.
- A confirmed close intentionally never expands beyond its preview. If another matching tab opens after preview, the user must issue or preview a new command; this is safer than silently widening destructive authority.
- A title-based close intentionally narrows while navigation is pending, even if the committed page title matched. The user can confirm again after navigation settles and Chrome exposes the destination title.
- Undo reopens exact URLs but cannot recreate every mutable browser-tab property or in-page history stack. Task 5's contract is exact selected URL multiplicity and route preservation, which the tests and browser proof cover.
- Chrome's own new-tab pages are preserved. The pre-existing exact `edge://newtab/` inactive cleanup behavior remains unchanged for Edge compatibility.
- The provider response in the browser smoke was synthetic and loopback-only. The result makes no claim about an external model's command parsing.
- No tag, push, release, `main` mutation, parent-checkout mutation, dependency change, or build artifact was created.

## 5. Close-out confirmation

- Every Task 5 plan checkbox is complete and backed by named automated or browser evidence.
- `README.md`, `GUIDE.md`, `CHANGELOG.md`, `PROGRESS.md`, the campaign smoke report, and the approved implementation plan are current.
- `VERSION` and `manifest.json` are both `1.2.7`.
- Canonical Task 5 commit: `533a86e10c03d2e3230e043ae09a2bd5458c1d30` (`fix: preserve exact tab URL identity`). It uses Michel's canonical author/committer email and carries `Co-Authored-By: Codex <noreply@openai.com>`.
- Per the Task 5 boundary, this worker does not tag, push, release, mutate `main`, or modify the parent checkout.
