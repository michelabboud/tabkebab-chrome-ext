# Task 7 Implementation Brief

## Objective

Implement the approved Task 7 slice from `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`: migrate canonical Drive sync to deterministic version 2, validate and bound every downloaded Drive JSON document, serialize portable-state mutations in the service worker, and reject malformed settings before they reach storage.

- Base commit: `54ac85ac11bf99b2fc2882481ec27ef2cb29c2ff`
- Expected version/tag after controller closeout: `1.2.9`
- Finding: 10, Drive resurrection foundation
- Phase checkpoint: Phase 2 foundation; Task 8 consumes this task's tombstone and lock interfaces
- Worktree: `/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening`
- Implementation report: `/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-7-report.md`

Start only from the controller-confirmed clean Task 6 commit. Read the design specification and accepted ADRs 0001-0003 before coding. Preserve every Task 6 Drive-retention, pagination, profile-cache, and archive-before-overwrite guarantee.

Do not tag, push, publish a release, mutate `main`, or touch the parent checkout. The root controller owns those steps after independent review. Do not pre-implement Task 8 deletion transactions or Tasks 9-10 portable export/import.

## Required files

Create:

- `core/drive-sync.js`
- `core/state-mutation-lock.js`
- `tests/core/drive-sync.test.js`
- `tests/core/drive-settings.test.js`
- `tests/core/state-mutation-lock.test.js`
- `docs/adr/0004-serialize-portable-state-mutations-in-the-worker.md`

Modify as needed within scope:

- `core/storage.js`
- `core/settings.js`
- `core/drive-client.js`
- `core/grouping.js`
- `service-worker.js`
- `sidepanel/components/drive-sync.js`
- `sidepanel/components/group-editor.js`
- `docs/adr/README.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- the Task 7 checklist in the approved plan
- existing dependency-free test helpers only when a real missing Chrome boundary is demonstrated RED

Task 7 browser/Drive evidence belongs in `task-7-report.md`. Do not expand the approved documentation file set merely to duplicate that report.

## Fixed Drive schema and interfaces

```js
export const DRIVE_SYNC_VERSION = 2;
export const DRIVE_TOMBSTONES_KEY = 'driveSyncTombstones';
export const MAX_DRIVE_JSON_BYTES = 25 * 1024 * 1024;
export const MAX_DRIVE_ENTITIES_PER_KIND = 10_000;
export const MAX_DRIVE_TOMBSTONES_PER_KIND = 10_000;
export const MAX_DRIVE_TABS_PER_ENTITY = 10_000;
export const MAX_DRIVE_TOTAL_TABS = 100_000;
export const MAX_DRIVE_STRING_LENGTH = 16_384;
export const MAX_DRIVE_NESTING_DEPTH = 12;
export const MAX_DRIVE_TIMESTAMP = Number.MAX_SAFE_INTEGER;
export const MAX_DRIVE_TOMBSTONE = MAX_DRIVE_TIMESTAMP - 1;

// core/storage.js additions
Storage.getMany(keys);
Storage.setMany(values);
Storage.removeMany(keys);

// core/drive-sync.js
export function emptyDriveTombstones();
export function getDriveEntityTimestamp(entity);
export function normalizeDriveTombstone(value);
export function migrateDriveSyncDocument(input);
export function mergeDriveSyncDocuments(left, right);
export async function readLocalDriveSyncDocument();
export async function writeLocalDriveSyncDocument(document);
export async function reconcileDriveSync(remoteDocument, writeRemote);

// core/state-mutation-lock.js
export async function withStateMutationLock(operation);
```

The only canonical document written after a successful migration is:

```js
{
  version: 2,
  sessions: [],
  manualGroups: {},
  tombstones: {
    sessions: { 'session-id': 1784050000000 },
    manualGroups: { 'group-id': 1784050000000 },
  },
}
```

Every returned document is a fresh value. Construct `manualGroups` and both tombstone maps with null prototypes and lexical keys. Never mutate local, remote, entity, or tombstone inputs.

## Migration, validation, and resource rules

- `null`, a missing `version`, and explicit `version: 1` are legacy v1 inputs. They migrate in memory with empty session/group tombstone maps. A missing remote file is the same empty v1 input.
- Version 2 requires own `sessions`, `manualGroups`, and `tombstones` sections of the correct array/map shapes. Reject unsupported versions, inherited sections, malformed entities, duplicate session IDs, empty manual-group keys, and prototype-pollution keys at every depth.
- IDs are non-empty bounded strings. A present entity timestamp is a non-negative safe integer no greater than `MAX_DRIVE_TIMESTAMP`; a present remote tombstone is no greater than `MAX_DRIVE_TOMBSTONE`. Remote schema validation rejects malformed values even though local timestamp helpers normalize malformed/missing values defensively.
- Enforce at most 10,000 sessions, 10,000 manual groups, and 10,000 tombstones in each tombstone kind. Tombstones are never age-pruned.
- Count all session window tabs and manual-group `tabUrls`. Enforce at most 10,000 occurrences in one entity and at most 100,000 across the document. Splitting a session across windows must not bypass its per-entity cap.
- Reject own keys or string values longer than 16,384 characters and nesting deeper than 12. Treat the root document as depth 0, accept values through depth 12, and reject depth 13. Use own-property traversal; reject arrays where maps are required, sparse/non-JSON structures, non-finite numbers, and `__proto__`, `constructor`, or `prototype` keys.
- `getDriveEntityTimestamp()` prefers a valid `modifiedAt`, then a valid `createdAt`, else `0`. `normalizeDriveTombstone()` accepts only the stricter tombstone range and otherwise returns `0`.
- The bounded Drive reader checks a valid `Content-Length` before consuming the body, then counts actual streamed UTF-8 bytes and rejects immediately above 25 MiB even when the header is absent or dishonest. Cancel the reader when possible. If streaming is unavailable, bound the fallback bytes/text before `JSON.parse()`.
- Multibyte UTF-8 input is charged by bytes, not JavaScript code units. No downloaded sync, settings, cross-profile settings, or export path may retain an unbounded `response.json()` call.
- `readSyncFile()` returns bounded parsed JSON for `migrateDriveSyncDocument()` to validate. `readSettingsFile()` and `readSettingsFromProfile()` additionally call `parseDriveSettingsDocument()` before returning. `readDriveExport()` is bounded JSON only; Task 9's portable schema remains its later semantic authority.

## Deterministic merge and reconciliation

- For every entity ID, compare normalized entity timestamps. The strictly newer entity wins.
- On equal timestamps with different content, recursively key-sort both records and compare their serialized strings with JavaScript lexical comparison, not locale-sensitive ordering. Choose the lexically greater canonical serialization. This makes the choice depend only on content and makes both operand orders converge.
- Take the greatest tombstone per ID. Retain that tombstone even when a genuinely newer entity survives.
- Keep an entity only when its timestamp is strictly greater than its tombstone. Equality is deletion.
- Sort output sessions by descending valid `createdAt` (invalid/missing local fallback `0`), then lexical `id`. Construct manual-group and tombstone maps lexically. `JSON.stringify(merge(a, b))` must equal `JSON.stringify(merge(b, a))` for equal logical inputs.
- `readLocalDriveSyncDocument()` reads `sessions`, `manualGroups`, and `driveSyncTombstones` as one `Storage.getMany()` snapshot and normalizes them into the v2 shape.
- `writeLocalDriveSyncDocument()` is the only canonical local commit boundary and performs exactly one `Storage.setMany({ sessions, manualGroups, driveSyncTombstones })` call.
- `reconcileDriveSync()` follows: migrate remote and local, merge in memory, await `writeRemote(merged)`, then atomically write the three local sections. A failed remote write leaves local bytes unchanged. A failed local write occurs only after a complete v2 remote write and must be safely idempotent on retry.
- Do not advance `lastSyncedAt` until canonical remote write, atomic local commit, required subfolder exports, and settings write have all succeeded. Never swallow a settings/subfolder failure and report full sync success.

## Settings validation boundary

```js
export const SETTINGS_CONSTRAINTS = Object.freeze({
  removeStashAfterRestore: { type: 'boolean' },
  defaultView: { enum: ['tabs', 'windows', 'stash', 'sessions'] },
  theme: { enum: ['system', 'light', 'dark'] },
  maxTabsPerWindow: { type: 'integer', min: 1, max: 500 },
  recommendedTabsPerWindow: { type: 'integer', min: 1, max: 500 },
  autoSaveIntervalHours: { type: 'integer', min: 1, max: 168 },
  autoSaveRetentionDays: { type: 'integer', min: 1, max: 365 },
  autoKebabAfterHours: { type: 'integer', min: 0, max: 720 },
  autoStashAfterDays: { type: 'integer', min: 0, max: 365 },
  bookmarkByWindows: { type: 'boolean' },
  bookmarkByGroups: { type: 'boolean' },
  bookmarkByDomains: { type: 'boolean' },
  bookmarkDestination: { enum: ['chrome', 'indexeddb', 'drive', 'all'] },
  autoBookmarkOnStash: { type: 'boolean' },
  compressedExport: { type: 'boolean' },
  exportHtmlBookmarkToDrive: { type: 'boolean' },
  focusDefaultProfile: { enum: ['coding', 'writing', 'research', 'meeting'] },
  focusDefaultDuration: { type: 'integer', min: 1, max: 480 },
  focusTabAction: { enum: ['kebab', 'stash', 'group', 'none'] },
  focusStrictBlocking: { type: 'boolean' },
  autoExportSessionsToDrive: { type: 'boolean' },
  autoExportStashesToDrive: { type: 'boolean' },
  autoSyncToDriveIntervalHours: { type: 'integer', min: 0, max: 168 },
  driveRetentionDays: { type: 'integer', min: 1, max: 365 },
  neverDeleteFromDrive: { type: 'boolean' },
});

export function validateSettingsPatch(input, currentSettings);
export function parseDriveSettingsDocument(input);
```

- `validateSettingsPatch()` accepts a plain own-property patch, rejects every unknown or inherited key, validates exact boolean/enum/integer constraints, merges only allowlisted keys with defaults/current settings, checks `recommendedTabsPerWindow <= maxTabsPerWindow`, and returns the complete canonical settings object.
- Reject fractional integers, coercible strings, `NaN`, infinities, and unknown keys. `setSetting()` must delegate through the same validation/save boundary rather than bypass it.
- `getSettings()` and `saveSettings()` construct output from `SETTINGS_DEFAULTS` keys; neither may spread arbitrary stored, Drive, or runtime-message keys into local storage.
- `parseDriveSettingsDocument()` accepts only missing-version and version-1 envelopes. It requires an own plain `settings` object and, when present, a non-negative safe-integer `savedAt <= MAX_DRIVE_TIMESTAMP`. Reject unknown envelope/settings keys, prototype keys, oversized strings, excessive nesting, and out-of-bound documents before `saveSettings()` can run.
- Task 7 does not introduce a settings schema version 2. Canonical settings writes remain `{ settings, savedAt, version: 1 }`, and the reader must accept the legacy missing-version form.
- Preserve the existing undo snapshot behavior for user-confirmed settings import, but only validated canonical settings may become the snapshot or saved replacement.

## FIFO worker ownership

Use these message names so Task 8 can extend the already-centralized delete path without another UI rewrite:

```js
{ action: 'getManualGroups' };
{ action: 'createManualGroup', name, color };
// returns { groupId, group }
{ action: 'moveTabToManualGroup', tabUrl, targetGroupId };
// targetGroupId === 'ungrouped' removes the URL from every manual group
{ action: 'deleteManualGroup', groupId };
{ action: 'syncDriveState' };
```

- `withStateMutationLock()` is a worker-local FIFO promise queue. It returns the operation's value or rejection, starts the next operation only after the prior settles, and releases after rejection. The internal tail may swallow solely to keep the queue alive; the caller-facing promise must still reject.
- Never acquire the lock recursively. Worker message/alarm entry points own it; internal helpers called from an already locked operation are unlocked. In particular, canonical sync must not call a runtime action that tries to reacquire the same lock.
- Under one lock, `syncDriveState` performs: read/find bounded remote and local state, migrate, merge, write canonical remote, atomically write canonical local, run the existing subfolder export body, write validated settings, then update `driveSync.lastSyncedAt` and return a plain serializable summary.
- Both manual Sync Now and the auto-sync alarm delegate to the same worker-owned coordinator. Leaving the alarm on its current separate export-only path would preserve an unlocked Drive writer and is in scope to correct.
- Serialize every existing session mutation: explicit save/delete/Undo, automatic save, rolling retention, alarm retention, and Drive reconciliation. Task 8 will add deletion tombstones to the already-centralized delete paths; Task 7 must not invent early tombstones.
- Serialize every manual-group mutation: create, edit/save, drag/move, URL add/remove, delete, and Drive reconciliation. Moving a URL out of all groups and into its target is one read/transform/write operation, not several separately locked messages.
- Generate a new manual-group ID inside the locked worker create action and return it to the panel; do not treat a panel-generated ID as storage authority.
- `group-editor.js` may read for rendering but performs no `chrome.storage.local.set({ manualGroups: ... })`. It sends validated mutation messages to the worker and updates UI only after success.
- Preserve Task 1's checked boundary: `DriveSync.syncNow()` calls `sendOrThrow({ action: 'syncDriveState' })`, renders only that returned summary, and never imports/calls canonical sync read/write functions directly. A returned `{ error }` or native rejection must not update last-sync UI or show success.
- Keep runtime payload validation proportional: non-empty bounded group IDs/names/URLs, valid colors, and existing target IDs. Invalid messages must not partially rewrite collections.

ADR 0004 must document the worker as the single owner of portable-state mutations, FIFO and no-nested-lock semantics, one-call local atomicity, remote-first reconciliation, retry behavior after remote-success/local-failure, and the fact that this is not a cross-profile distributed lock; deterministic Drive merge supplies cross-profile convergence.

## Mandatory TDD sequence

1. Create `tests/core/drive-sync.test.js` first. Cover missing-version and explicit-v1 migration, empty remote migration, normalized v2 copying, fresh/null-prototype outputs, unsupported versions, malformed/duplicate sessions, malformed groups/tombstones, inherited/dangerous keys, and input immutability.
2. Add exact timestamp tests: valid modified-time preference, created-time fallback, malformed local normalization, remote malformed rejection, maximum entity/tombstone ceilings, and entity timestamp equal/newer than its tombstone.
3. Add merge truth tables for newer session/group wins, greatest tombstone wins, equal means deleted, newer survives with tombstone retained, and deterministic equal-timestamp content conflicts in both operand orders. Assert exact session/key ordering and byte-identical JSON.
4. Add every resource boundary at max and max-plus-one: entity/tombstone counts, per-entity tabs/URLs across split windows, total tabs/URLs, string/key length, nesting depth, and prototype pollution.
5. Add reconciliation/storage tests. Prove `getMany()` is one Chrome read, `setMany()` is one Chrome set, `removeMany()` is one Chrome remove, remote rejection causes zero local writes, successful remote write precedes one three-key local set, local rejection leaves no partial local keys, and retry converges to the same bytes.
6. Add bounded response tests through the production Drive read entry points: oversized `Content-Length` before body read, dishonest/missing length with oversized stream/text fallback, multibyte UTF-8 accounting, invalid JSON, reader cancellation, and successful under-limit sync/settings/export reads. Assert downloaded JSON paths do not call `response.json()`.
7. Create `tests/core/drive-settings.test.js`. Cover missing/version-1 envelopes, optional `savedAt` boundaries, own `settings` requirement, unknown/inherited/prototype keys, size/string/depth limits, and zero save calls on rejection.
8. Exercise every `SETTINGS_CONSTRAINTS` minimum/maximum and invalid neighbor, exact enums/booleans, fractional/coercible/non-finite values, unknown keys, partial patches against current values, canonical allowlisted output, and the cross-field recommended/max-tabs invariant.
9. Create `tests/core/state-mutation-lock.test.js`. Use deferred operations to prove strict FIFO start/settle order, value/rejection propagation, release after rejection, and a sync-then-mutation simulation where the later mutation cannot be overwritten.
10. Add worker orchestration regressions within the approved test files: manual and alarm sync share the coordinator; the lock covers remote/local/export/settings/last-sync ordering; nested lock acquisition is absent; session/group mutations queue behind a deferred sync; the panel has no direct manual-group writes; and `{ error }` cannot advance sync success state.
11. Run the focused command against the pre-change code and preserve the RED output in the report:

    ```bash
    bun test tests/core/drive-sync.test.js tests/core/drive-settings.test.js tests/core/state-mutation-lock.test.js
    ```

    Expected RED causes include missing schema/lock/storage interfaces, operand-order-dependent union merge, local-before-remote writes, unbounded Drive JSON, arbitrary settings spread, panel-owned group writes, and unchecked sync success.
12. Implement the minimum pure schema, bounded reader, settings validator, storage methods, FIFO lock, and worker routing needed to make the focused command GREEN. Do not add a package, JSON/DOM/IndexedDB emulator, fake Drive service, distributed lock, or production-only failure switch.
13. Re-run the focused command and record exact pass/fail/expect counts, then run all final gates freshly:

    ```bash
    bun --version
    bun test
    bun test --coverage
    bun test tests/syntax.test.js
    git diff --check
    ```

    Bun must remain `1.3.11`; all tests and syntax checks pass; `git diff --check` is clean. Record coverage honestly without inventing a repository-wide threshold.

The existing Chrome mock already provides atomic storage call recording/failure injection, runtime messaging, alarms, and mutable tabs/groups. Prefer deferred injected functions and synthetic bounded `Response` bodies. Restore `globalThis.fetch` and any stubbed methods in `finally`.

## Proportional real-Chrome/Drive gate

Use the installed official Chrome for Testing, disposable Xvfb/CDP profile, and an explicitly throwaway Drive profile/folder. Reuse Task 6's proven OAuth boundary if available. Never print, store in evidence, or transmit the OAuth token, request authorization header, private tab URLs, or full Drive response bodies.

1. Seed the throwaway canonical sync file with an actual v1 document containing one remote-only session/group and an equal-timestamp conflict; seed local storage with one local-only entity and the opposite conflict record.
2. Run the production `syncDriveState` path from the real side panel. Confirm the remote file is now version 2, both tombstone maps are present and empty, local/remote entity sets match, the approved deterministic tie winner was selected, sessions/keys have stable order, and no entity disappeared.
3. Run sync again without data changes and confirm canonical content is byte-identical and local state remains unchanged. Archive creation may change Drive inventory but not canonical JSON.
4. At the CDP network boundary, pause the throwaway canonical upload while the worker lock is held. Submit one real manual-group mutation. Confirm it does not persist before upload release, then release the request and confirm sync settles first and the queued mutation persists afterward rather than being overwritten.
5. Confirm `lastSyncedAt` changes only after the full successful path. Force one small malformed settings or sync document through the disposable fixture and confirm the worker reports failure with local portable state unchanged; automated tests remain the exact size/depth/count-limit authority.
6. Record exact Chrome build/hash, redacted fixture IDs/counts, action/order results, and complete removal of Drive artifacts, browser profile, Chrome/Xvfb processes, listeners, and temporary files.

If the registered development OAuth boundary cannot authenticate the disposable extension ID, record the exact blocker and complete the non-network real-Chrome worker/lock portion without claiming real Drive passed. Do not replace the mandatory Drive claim with a mock.

## Documentation, version, report, and commit

- Create ADR 0004 and add it to `docs/adr/README.md`. Update `ARCHITECTURE.md` with v1-read/v2-write migration, stable merge ordering, retained tombstones, bounded Drive JSON, worker ownership, FIFO/no-nested-lock rules, remote-first atomic reconciliation, and retry semantics.
- Update `CHANGELOG.md` and `PROGRESS.md` with only behavior and evidence that actually landed. Do not mark deletion convergence complete; Task 8 still has to write tombstones transactionally.
- Set both `VERSION` and `manifest.json` to `1.2.9`.
- Close every Task 7 plan checkbox only after its named RED/GREEN, full-gate, documentation, and applicable real-browser evidence exists.
- Write `task-7-report.md` in the established five sections: what was built; verification evidence with preserved RED and fresh GREEN counts plus real-browser/Drive evidence; assumptions; concerns/adjacent observations; close-out confirmation. Include a model/agent ledger, exact version comparison, full commit hash, and final clean-worktree result.
- Commit with author email `29182417+michelabboud@users.noreply.github.com` and trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- Leave the worktree clean and report the full commit hash. No tag, push, release, `main` mutation, or parent-checkout mutation.

## Approved checklist (complete Task 7 intent)

- Missing-version and explicit-v1 sync documents migrate to v2 in memory with empty tombstones; unsupported/malformed/prototype-bearing inputs reject.
- Merge chooses newer entities, greatest tombstones, deletes on equality, retains tombstones after newer updates, and resolves equal timestamps by stable recursively key-sorted content in both operand orders.
- Output sessions and all map keys have the approved deterministic order and byte-identical JSON for equivalent merges.
- Reconciliation writes the merged v2 document remotely before one atomic three-key local commit; failed remote writes leave local bytes unchanged and remote-success/local-failure is retryable.
- The worker-local mutation lock is strict FIFO, releases after rejection, and prevents a later session/group mutation from being overwritten by sync.
- Drive reads reject oversized headers and actual bodies, excessive entities/tombstones/tabs/URLs, long strings, deep nesting, invalid JSON, and malformed schema before merge or settings save.
- Canonical and cross-profile settings accept only legacy missing/version-1 envelopes, valid optional timestamps, own allowlisted settings, exact constraints, and a valid recommended/max-tabs relationship.
- `Storage.getMany`, `setMany`, and `removeMany` remain thin Chrome calls; `setMany()` performs one call, never a per-key loop.
- Local entity timestamps and tombstones use the exact safe-integer ceilings and fallback rules; remote malformed timestamps reject.
- Tombstones are retained indefinitely within count/byte limits and are not age-pruned.
- `readSyncFile`, both settings readers, and `readDriveExport` use bounded JSON; only settings readers apply settings schema here, while Task 9 remains portable-export authority.
- `saveSettings`, `setSetting`, and stored/settings output cannot spread arbitrary Drive or runtime-message keys.
- All session/manual-group mutations and Drive reconciliation are worker-owned and serialized; the panel no longer writes `manualGroups`.
- `syncDriveState` holds one lock across read/migrate/merge, remote write, atomic local write, subfolder/settings work, and `lastSyncedAt`; remote absence is empty v1.
- Manual and scheduled sync share that coordinator; no internal runtime call recursively acquires the lock.
- `DriveSync.syncNow()` uses `sendOrThrow()`, trusts only the worker summary, and never advances success UI from an error-shaped response.
- ADR 0004 and architecture/release/progress documentation accurately describe worker ownership, resource limits, deterministic ordering, and remote-first retry semantics.
- The focused suite, full Bun suite, coverage run, syntax gate, and whitespace check pass with no dependency/build/failure-hook additions.
- Proportional real Chrome/Drive evidence proves v1-to-v2 write, deterministic repeat sync, and queued mutation survival, or records an honest OAuth blocker without claiming the Drive gate passed.
- `VERSION` and `manifest.json` are `1.2.9`; the implementation report, model ledger, commit trailer, full hash, and clean worktree are complete before controller review.
