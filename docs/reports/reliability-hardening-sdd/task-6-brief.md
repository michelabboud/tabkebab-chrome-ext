# Task 6 Implementation Brief

## Objective

Implement the approved Task 6 slice from `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`: restrict Drive retention to strictly classified dated recoverable copies, protect canonical/newest/undated files, and unify scheduled/manual cleanup with checked UI results.

- Base commit: `533a86e10c03d2e3230e043ae09a2bd5458c1d30`
- Expected version/tag after controller closeout: `1.2.8`
- Finding: 2
- Phase checkpoint: Phase 1 release
- Worktree: `/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening`
- Implementation report: `/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-6-report.md`

Do not tag, push, publish a release, mutate `main`, or touch the parent checkout. The root controller owns those steps after independent review, including the Phase 1 GitHub release.

## Required files

Create:

- `core/drive-retention.js`
- `tests/core/drive-retention.test.js`
- `tests/integration/drive-cleanup.test.js`

Modify as needed within scope:

- `docs/reports/2026-07-14-reliability-smoke.md`
- `core/drive-client.js`
- `service-worker.js`
- `sidepanel/components/settings-manager.js`
- `GUIDE.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- the Task 6 checklist in the approved plan
- existing dependency-free test helpers only when a real boundary is missing

## Fixed retention interfaces

```js
export const CANONICAL_DRIVE_FILES = new Set([
  'tabkebab-sync.json',
  'tabkebab-settings.json',
]);

export function classifyDatedDriveFile(file);
// null or { category, timestamp }

export function selectDriveRetentionDeletions(files, cutoffMs);
// { deleteFiles, keptCanonical, keptNewest, ignoredUndated }
```

The selector returns arrays containing the original listed file objects without mutating them. The service-worker/manual boundary returns only serializable data:

```js
{
  deleted,
  keptCanonical,
  keptNewest,
  ignoredUndated,
  errors: [{ fileId, name, message }],
}
```

No `Error`, stack, token, response body, or secret crosses runtime messaging.

## Inventory, classification, and selection semantics

- `listAllDriveFiles()` annotates every result with exactly one scope: `profile`, `sessions`, `stashes`, `bookmarks`, or `archive`.
- Follow every Drive `nextPageToken`; “all” must not silently mean the first page. Preserve current API permissions and folder creation behavior.
- Protect canonical names before parsing. `tabkebab-sync.json` and `tabkebab-settings.json` are never delete candidates, including if unexpectedly listed outside the profile root.
- Accept only the repository's exact filename families in their valid scopes:

  - sessions: `sessions-YYYY-MM-DD.json`;
  - stashes: `stashes-YYYY-MM-DD.json` and `stash-<name>-<13-digit-ms>.json`;
  - bookmarks: `bookmarks-YYYY-MM-DD.json`, `bookmarks-YYYY-MM-DD-<13-digit-ms>.json`, and `bookmarks-YYYY-MM-DD.html`;
  - profile: `tabkebab-export-<13-digit-ms>.json`;
  - archive: valid originals with a final `-YYYY-MM-DDTHH-MM-SS` suffix before the extension.

- Categories are bounded to: `sessions`, `stashes`, `bookmarks-json`, `bookmarks-html`, `portable-export`, `archive-sync`, `archive-settings`, `archive-sessions`, `archive-stashes`, `archive-bookmarks-json`, `archive-bookmarks-html`. Dynamic stash names share `stashes`/`archive-stashes`; user names never create categories.
- Validate embedded calendar dates by UTC round trip. Validate archive hours/minutes/seconds, exact 13-digit milliseconds, extension/case, and full-string shape. Reject normalized dates such as February 30, extra suffixes, wrong scope, and unknown archive families.
- `classifyDatedDriveFile()` uses embedded date/timestamp only for validating/classifying the filename. Retention age and newest selection use a valid finite `modifiedTime`.
- Invalid/missing `modifiedTime`, malformed/undated names, wrong-scope names, and unrelated user JSON/HTML are `ignoredUndated`, never delete candidates.
- Before selecting any deletion, compute the greatest `modifiedTime` for each bounded category. Preserve every file tied at that maximum, even if all are older than cutoff.
- Select only classified, noncanonical, non-newest files whose `modifiedTime < cutoffMs`. Equality with cutoff is retained. Young non-newest files are untouched.
- Selection is input-order stable, does not mutate input, and never returns the same file ID twice.
- Invalid files input or invalid/non-finite cutoff rejects/fails closed before any deletion.

## One cleanup coordinator

- Extract one injectable coordinator used by both `runRetentionCleanup()` and `cleanDriveFiles`.
- Complete listing, classification, and selection before the first delete. A listing/selection error performs zero deletes.
- Delete selected files best-effort in deterministic order. Continue after individual failures; increment `deleted` only on confirmed success and append a plain `{ fileId, name, message }` for each failure.
- Scheduled and manual cleanup must call the same selector/coordinator and select identical IDs for identical inputs.
- Validate manual `days` as an integer in `1..365`; missing behavior must be explicit. Present invalid values reject rather than coerce/default. Apply the same fail-closed validation to corrupted scheduled settings.
- Respect `neverDeleteFromDrive`, disconnected state, and disabled retention without listing/deleting.
- Remove or invalidate `_cachedProfileName` when `driveProfileName` changes so destructive cleanup cannot address the previous profile folder.
- Archive-before-overwrite must be real recoverability: if creating the archive fails, do not silently overwrite the canonical file. Propagate a checked error and leave canonical content untouched.

## Checked settings UI

- `settings-manager.js` must use Task 1's `sendOrThrow()` boundary.
- Success text reports files deleted plus canonical/newest/undated counts protected.
- Any transport/worker error displays failure and never success.
- A partial result with non-empty `errors` is incomplete/failure or warning, includes partial counts, and never claims full success.
- Avoid a DOM dependency merely to test toast rendering. Extract a small pure result formatter if needed and cover success, partial failure, and top-level error contracts.

## Mandatory TDD sequence

1. Create `tests/core/drive-retention.test.js` first with fixtures for every normal/archive family and category, canonical files, unrelated undated files, malformed dates/times/milliseconds, wrong scopes, and invalid metadata.
2. Cover cutoff equality, young files, multiple old files per category, every newest tie, dynamic stash category bounding, input-order stability, input immutability, duplicate IDs, and invalid files/cutoff fail-closed behavior.
3. Create `tests/integration/drive-cleanup.test.js`. Prove scope annotation and pagination across profile plus each subfolder, scheduled/manual coordinator identity, exact deletion IDs, partial delete continuation, plain error shapes, zero-delete listing/selection failure, disabled/disconnected guards, and days validation.
4. Add settings-result boundary coverage for complete success, partial failure, and returned/transport errors through `sendOrThrow()`.
5. Add `_cachedProfileName` invalidation and archive-failure regressions before production changes.
6. Run `bun test tests/core/drive-retention.test.js tests/integration/drive-cleanup.test.js` against the current code and preserve RED evidence for broad old-file deletion, duplicated loops, missing scope/pagination, unchecked UI success, stale profile cache, and swallowed archive failure.
7. Implement the narrow production slice and make the focused suite GREEN.
8. Run the focused command, `bun test`, `bun test --coverage`, `bun test tests/syntax.test.js`, and `git diff --check`. Keep the repository dependency-free and add no production failure flag or fake Drive server.

Prefer dependency injection around listing/deletion/coordinator functions over a global fake Drive service. Synthetic paginated `fetch` responses are acceptable in tests if `globalThis.fetch` is restored in `finally`.

## Real-Chrome/Drive gate

First verify that the disposable unpacked extension ID can authenticate against the registered development OAuth client. Never print, persist in evidence, or transmit an OAuth token. If the real OAuth boundary cannot be established, report the exact blocker; do not substitute a mock and claim the mandatory gate passed.

With working OAuth:

1. Create a uniquely named throwaway TabKebab profile folder through production Drive functions.
2. Seed old canonical sync/settings files, at least two archives in one category (including a newest/tied-newest case), a dated portable export, a malformed/undated user JSON, and a young eligible copy.
3. Set fixture `modifiedTime` through authenticated extension-context requests without exposing the token.
4. Run the actual manual cleanup and record redacted names/counts plus post-cleanup listing.
5. Confirm canonical, all newest ties, undated/malformed, and young files remain; only eligible old non-newest copies are removed; UI reports checked counts.
6. Delete every throwaway Drive artifact and disposable browser profile, and confirm no matching Chrome/Xvfb process remains.

## Documentation, version, phase release, and commit

- Update `GUIDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, and `PROGRESS.md`; record Phase 1 complete only when all evidence exists.
- Set both `VERSION` and `manifest.json` to `1.2.8`.
- Close all Task 6 checkboxes only after their evidence exists.
- Write the report with RED/GREEN evidence, exact commands/counts, real-Drive evidence, cleanup, assumptions, concerns, adjacent pagination/cache/archive fixes, and model/agent ledger.
- Commit with author email `29182417+michelabboud@users.noreply.github.com` and trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- Leave the worktree clean and report the full commit hash. No tag/push/release.

After independent review, the controller will fast-forward/tag/push `v1.2.8`, wait for exact-commit CI, create the browsable Phase 1 GitHub release summarizing Findings 1-6/12, and verify the release object plus remote tag target.

## Approved checklist (verbatim intent)

- Drive inventory is fully paginated and scope-annotated.
- Only strict dated recoverable families are eligible; canonical, newest ties, young, malformed, undated, and unrelated files are protected.
- Manual and scheduled cleanup share one selector/coordinator and report structured partial failures.
- Settings UI uses `sendOrThrow()` and never turns a returned/transport/partial error into success.
- Profile-name changes cannot target stale folders and canonical overwrite cannot proceed after archive failure.
- Focused and full gates pass.
- Real Drive proves canonical/newest/undated preservation with complete throwaway cleanup.
- Phase 1 documentation and release state are current.
