# Task 5 Implementation Brief

## Objective

Implement the approved Task 5 slice from `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`: make natural-language host filters exact and make duplicate cleanup/Undo preserve every original URL, including hash routes.

- Base commit: `7a4075d840d04a084df6de3a33db5f32750e857d`
- Expected version/tag after controller closeout: `1.2.7`
- Findings: 5 and 6
- Worktree: `/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening`
- Implementation report: `/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-5-report.md`

Do not tag, push, publish a release, mutate `main`, or touch the parent checkout. The root controller owns those steps after independent review.

## Required files

Create:

- `core/url-match.js`
- `tests/core/nl-executor.test.js`
- `tests/core/duplicates.test.js`
- `tests/integration/hash-route-restore.test.js`

Modify as needed within scope:

- `docs/reports/2026-07-14-reliability-smoke.md`
- `core/nl-executor.js`
- `core/duplicates.js`
- `sidepanel/components/duplicate-finder.js`
- `README.md`
- `GUIDE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- the Task 5 checklist in the approved plan
- existing dependency-free test helpers only if a real boundary is missing

## Fixed URL interfaces

```js
// core/url-match.js
export function canonicalHostname(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const input = value.trim();
    const candidate = input.includes('://') ? input : `https://${input}`;
    return new URL(candidate).hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

export function hostnameMatches(url, expectedHost) {
  const hostname = canonicalHostname(url);
  const expected = canonicalHostname(expectedHost);
  if (!hostname || !expected) return false;
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

// core/duplicates.js
export function collectUndoUrls(duplicateGroups, closingTabIds);
```

## Host-filter semantics

- Replace `hostname.includes()` with `hostnameMatches()` for domain filters.
- Exact host and true subdomains match. Suffix/sibling lookalikes such as `notgithub.com` and `github.com.evil.test` never match.
- Host comparison is case-insensitive and accepts a single trailing dot on either the filter or parsed tab host.
- Preserve existing `pendingUrl` fallback when a tab has no committed URL.
- Preserve the existing AND semantics when domain, title, and URL text filters are combined.
- Distinguish an absent domain property from an invalid present value. Only a genuinely absent property skips host filtering. Present empty, whitespace, null, or non-string values fail closed and match no tabs.
- Malformed tab URLs fail closed. Catch caller `TypeError` defensively and never fall back to substring matching.

## Duplicate and Undo semantics

- `normalizeUrl()` keeps fragments. `https://app.test/#/one`, `#/two`, and ordinary differing fragments are distinct keys.
- Preserve current query and trailing-slash normalization behavior except where an existing test proves it unsafe.
- `findDuplicates()` returns each tab record with its exact original `url`; the normalized key remains grouping metadata only.
- `collectUndoUrls()` returns a fresh snapshot in duplicate-group order and then tab order. Include one URL per selected tab, including repeated identical URLs. Ignore unselected IDs and absent/non-string URLs. Do not deduplicate and do not reconstruct from a normalized group key.
- `DuplicateFinder.closeAllDuplicates()` captures the immutable URL snapshot before the first close request, rescan, or other await that could replace `this.duplicates`.
- Undo recreates exactly that captured array. Later rescans or group mutations cannot change it.
- Preserve hash routes in session and stash duplicate detection so a saved different route is restored rather than skipped.

Adjacent confirmed defect in the same normalization boundary: `normalizeUrl('chrome://newtab/')` currently becomes `null/`, so the existing new-tab exclusion is ineffective. Add a failing regression and make new-tab/empty-page detection exclude Chrome new-tab pages without changing ordinary web URL normalization.

## Adversarial supplement

- Treat natural-language close preview and confirmation as a destructive TOCTOU boundary. Re-query tabs after the AI result before constructing a preview. At confirmation, validate the command shape, re-query again, reapply the original filter, intersect with the IDs approved by the preview (never expand), and execute only the sanitized live IDs. A tab that navigates out of scope during either await must not close; for this destructive boundary, a non-empty live `pendingUrl` is the authoritative destination even though the pure filter keeps its committed-URL-first fallback contract.
- `executeNLAction()` derives executable IDs only from its supplied live tab array. Caller- or AI-provided `parsed.tabIds` is approval metadata, never mutation authority, for close, group, move, or focus.
- At the destructive boundary, a tab with a non-empty `pendingUrl` has no authoritative destination title yet. If the original filter contains `titleContains`, exclude that in-flight tab rather than matching the stale committed-page title.
- Reject non-plain filters, filters with no recognized predicate, and every own present-invalid predicate value. Untrusted values such as `{ bogus: 1 }`, strings, arrays, or `{ domain: undefined }` must never degrade into match-all behavior.
- Preserve opaque-origin scheme/host identity during normalization, or exclude internal URLs before duplicate grouping. `chrome://settings/` and `chrome://extensions/` must not collapse together through `origin === 'null'`; add a regression alongside the Chrome new-tab exclusion.

## Mandatory TDD sequence

1. Create `tests/core/nl-executor.test.js` first. Cover exact host, subdomain, uppercase filter/tab host, trailing dot on each side, both lookalikes, malformed tab URL, missing domain property, present invalid domain values, pending URL fallback, and combined-filter AND behavior.
2. Create `tests/core/duplicates.test.js` first. Cover hash routes and ordinary fragments remaining distinct, identical hash-route copies grouping, current query/trailing-slash behavior, exact original URL inclusion, and Chrome new-tab exclusion.
3. Add pure `collectUndoUrls()` cases proving order, fresh-array independence, repeated URLs, selected-ID filtering, and absent/non-string URL rejection.
4. Create `tests/integration/hash-route-restore.test.js`. For both `restoreSession()` and `restoreStashTabs()`, seed route one as open and route two as saved; assert route two is created exactly and `skippedDuplicate === 0`.
5. Add duplicate UI wiring coverage only through pure boundaries. Do not install a DOM implementation merely to import `duplicate-finder.js`; real Chrome supplies the UI boundary.
6. Run `bun test tests/core/nl-executor.test.js tests/core/duplicates.test.js tests/integration/hash-route-restore.test.js` against the current code and preserve RED evidence for substring matching, hash stripping, omitted original URLs, Undo reconstruction, false restore skips, and new-tab normalization.
7. Implement the narrow production slice and make the focused suite GREEN.
8. Run the focused command, `bun test`, `bun test --coverage`, `bun test tests/syntax.test.js`, and `git diff --check`. Keep the repository dependency-free and add no DOM/IndexedDB emulator or production-only hook.

The existing Chrome mock supports tab query/create/remove and window state. The stash restore entrypoint accepts an in-memory record, so no IndexedDB shim is required.

## Real-Chrome gate

Use the already-installed Chrome for Testing/Xvfb/CDP harness and a disposable profile. Do not download a browser or use a real credential.

1. Open `github.com`, `docs.github.com`, `notgithub.com`, and `github.com.evil.test` fixtures (or deterministic equivalents). Use the production NL preview boundary with a transparently synthetic/cached parsed close command. Confirm only the exact and true-subdomain host IDs enter the confirmation and neither lookalike does.
2. Open two copies each of an ordinary URL, `https://app.test/#/one`, and `https://app.test/#/two` (or equivalent local deterministic URLs that preserve the exact fragments).
3. Scan through the real duplicate UI, close selected copies, invoke Undo before expiry, and confirm exact per-URL counts return to two. Both distinct routes must survive and reopen exactly.
4. Confirm Chrome new-tab pages are not offered as duplicate/empty cleanup targets.
5. Record exact browser build/hash, redacted commands/results, and disposable profile/process cleanup. State clearly when the NL parse response is synthetic; this smoke validates the real worker/UI/tab boundary, not provider quality.

## Documentation, version, and commit

- Update `GUIDE.md`, `CHANGELOG.md`, and `PROGRESS.md` for exact host filtering and lossless hash-aware Undo.
- Set both `VERSION` and `manifest.json` to `1.2.7`.
- Close all Task 5 checkboxes only after their evidence exists.
- Write the report with RED/GREEN evidence, exact final commands/counts, real-browser evidence, assumptions, concerns, adjacent new-tab fix, and the model/agent ledger.
- Commit with author email `29182417+michelabboud@users.noreply.github.com` and trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- Leave the worktree clean and report the full commit hash. No tag/push/release.

## Approved checklist (verbatim intent)

- Natural-language domain filters use exact/true-subdomain host identity and fail closed for malformed/present-invalid values.
- Hash routes remain distinct through duplicate scan and both restore coordinators.
- Duplicate records carry original URLs; Undo snapshots those URLs before close/rescan and recreates them losslessly.
- Chrome new-tab pages remain excluded from duplicate/empty cleanup.
- Focused and full gates pass.
- Real Chrome proves lookalike rejection and lossless duplicate close/Undo with two hash routes.
- User/release documentation is current.
