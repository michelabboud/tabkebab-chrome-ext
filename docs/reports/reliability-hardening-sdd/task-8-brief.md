# Task 8 Implementation Brief

## Objective

Implement the approved Task 8 slice from `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`: make every session and manual-group deletion one worker-serialized local transaction with its Drive v2 tombstone, make Undo create a strictly newer session without discarding that tombstone, and prove deletion convergence before portable export/import consumes the schema.

- Base commit: `4a48a08dc3e613e2fd0cdf22cffc84b4357859e1`
- Expected version/tag after controller closeout: `1.2.10`
- Finding: 10, deletion convergence
- Phase checkpoint: review the two-profile convergence truth table before Task 9 starts
- Worktree: `/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening`
- Implementation report: `/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-8-report.md`

Start only from the controller-confirmed clean Task 7 commit. Read the approved design specification, ADR 0003, and the Task 7 ADR `docs/adr/0004-serialize-portable-state-mutations-in-the-worker.md` before coding. Confirm that Task 7's Drive v2 constants, canonical tombstone shape, atomic `Storage` methods, deterministic merge, worker-local FIFO lock, and centralized session/manual-group actions exist and pass their focused tests. If the committed Task 7 interface differs from this brief, report the exact conflict to the controller rather than creating a second lock, tombstone schema, or sync coordinator.

The implementer must verify `git rev-parse HEAD` equals the independently reviewed Task 7 commit above before creating tests or production changes.

Preserve Task 6's Drive retention guarantees and every Task 7 migration, bounded-read, deterministic-ordering, remote-first reconciliation, settings-validation, and no-nested-lock guarantee. Do not pre-implement Task 9 portable export v2 or Task 10 import/rollback behavior.

Do not tag, push, publish a release, mutate `main`, or touch the parent checkout. The root controller owns those steps after independent review.

## Required files

Create:

- `tests/core/deletion-tombstones.test.js`

Modify as needed within scope:

- `docs/reports/2026-07-14-reliability-smoke.md`
- `core/drive-sync.js`
- `core/sessions.js`
- `core/grouping.js`
- `service-worker.js`
- `sidepanel/components/group-editor.js`
- `sidepanel/components/session-manager.js`
- `GUIDE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- the Task 8 checklist in the approved plan
- existing dependency-free test helpers only when a real missing Chrome boundary is demonstrated RED

Task 8 does not create a new ADR or edit accepted ADRs 0003/0004. Those ADRs already fix the deletion-convergence and worker-ownership decisions. Record real-browser/Drive evidence in the existing smoke report and the scratch implementation report; do not expand the approved documentation set merely to duplicate that evidence.

## Task 7 prerequisites and fixed interfaces

Task 8 consumes, rather than redefines, these Task 7 contracts:

```js
export const DRIVE_TOMBSTONES_KEY = 'driveSyncTombstones';
export const MAX_DRIVE_ENTITIES_PER_KIND = 10_000;
export const MAX_DRIVE_TOMBSTONES_PER_KIND = 10_000;
export const MAX_DRIVE_STRING_LENGTH = 16_384;
export const MAX_DRIVE_TIMESTAMP = Number.MAX_SAFE_INTEGER;
export const MAX_DRIVE_TOMBSTONE = MAX_DRIVE_TIMESTAMP - 1;

export function emptyDriveTombstones();
export function getDriveEntityTimestamp(entity);
export function normalizeDriveTombstone(value);
export function mergeDriveSyncDocuments(left, right);

Storage.getMany(keys);
Storage.setMany(values);

export async function withStateMutationLock(operation);
```

The stored local tombstone value remains:

```js
{
  sessions: { 'session-id': 1784050000000 },
  manualGroups: { 'group-id': 1784050000000 },
}
```

All maps produced in this task are fresh own-property maps with lexical keys. Never mutate a session, group, entity collection, tombstone map, runtime payload, or object returned by storage. Retain tombstones indefinitely within Task 7's resource bounds; Undo and a newer entity do not clear them.

ADR 0004 remains authoritative for locking: service-worker message/alarm entry points acquire the one FIFO lock, while core transaction helpers called inside that critical section do not reacquire it. No Task 8 core function imports or wraps `withStateMutationLock()` if its caller already owns the lock.

## Fixed deletion and Undo interfaces

Keep the approved public interfaces exactly:

```js
// core/sessions.js
export async function deleteSessions(sessionIds, deletedAt = Date.now());
// { deletedIds, tombstones: { [sessionId]: timestamp } }

export async function deleteSession(sessionId, deletedAt = Date.now());
// { deleted, tombstoneAt }

export async function restoreDeletedSession(session, restoredAt = Date.now());
// returns the restored session with modifiedAt newer than its retained tombstone

// core/grouping.js
export async function deleteManualGroup(groupId, deletedAt = Date.now());
// { deleted, tombstoneAt }
```

Add small pure helpers to `core/drive-sync.js` so timestamp math and map copying are directly testable. Use these names unless the committed Task 7 API already provides equivalent helpers:

```js
export function computeDeletionTombstone(entity, previousTombstone, deletedAt);

export function recordDeletionTombstones(
  currentTombstones,
  kind,       // exactly 'sessions' or 'manualGroups'
  entries,    // [{ id, entity }], with unique IDs
  deletedAt,
);
// { nextTombstones, recordedTombstones }
```

`nextTombstones` is the complete fresh two-kind tombstone object. `recordedTombstones` contains only this transaction's IDs and timestamps. Both use null-prototype maps and lexical key construction. The helper preflights every entry before returning; one invalid or unrepresentable entry rejects the whole batch.

## Timestamp, identity, and capacity rules

- A supplied `deletedAt` is valid only when `Number.isSafeInteger(deletedAt)`, `deletedAt >= 0`, and `deletedAt <= MAX_DRIVE_TOMBSTONE`. Reject `NaN`, infinities, negatives, fractional values, numeric strings, and `MAX_DRIVE_TOMBSTONE + 1`. A valid future timestamp is accepted.
- For each deleted entity compute exactly `Math.max(deletedAt, getDriveEntityTimestamp(entity), normalizeDriveTombstone(previousTombstone))`.
- If `getDriveEntityTimestamp(entity) > MAX_DRIVE_TOMBSTONE`, reject before storage because no schema-valid tombstone can equal or dominate that entity. `MAX_DRIVE_TOMBSTONE` itself is valid and deletion by equality remains effective.
- A supplied `restoredAt` is valid only when it is a non-negative safe integer no greater than `MAX_DRIVE_TIMESTAMP`. Reject the same malformed categories, but accept the exact ceiling and valid future timestamps.
- Given the retained tombstone `T`, Undo sets `modifiedAt` to exactly `Math.max(restoredAt, getDriveEntityTimestamp(session), T + 1)`. `MAX_DRIVE_TOMBSTONE` guarantees `T + 1` is exact and no greater than `MAX_DRIVE_TIMESTAMP`.
- Session/group IDs are non-empty own strings within Task 7's string bound. Reject dangerous map keys (`__proto__`, `constructor`, and `prototype`) and malformed runtime values before reading or writing storage.
- Stable-deduplicate valid batch IDs. `deletedIds` follows first-request order; the returned per-ID tombstone map and stored maps use lexical keys. Unknown but well-formed IDs are no-ops and do not create attacker-controlled tombstones.
- A batch that would add more than `MAX_DRIVE_TOMBSTONES_PER_KIND` tombstones rejects before deleting anything. Updating an existing tombstone at the ceiling remains allowed. Apply Task 7's key/string/canonical-state validation before the one storage write so a deletion cannot create state that the next sync cannot represent.
- Evaluate the default clock once per public operation. A batch shares that one `deletedAt`; individual results may be later because an entity or prior tombstone already carries a later valid timestamp.

## Transactional storage semantics

`deleteSessions()` performs one transaction inside its caller-owned worker lock:

1. Validate and stable-deduplicate `sessionIds` and validate `deletedAt` before any mutation.
2. Read `sessions`, `manualGroups`, and `driveSyncTombstones` as one
   `Storage.getMany()` snapshot. This is an adjacent controller clarification:
   the original two-key wording could not prove Task 7's full-document 25 MiB
   and 100,000-tab/URL limits. A minimal deleted entity can be replaced by a
   larger timestamp tombstone, and Undo can cross the total-tab limit through
   otherwise untouched manual groups.
3. Select only existing requested sessions, preflight every resulting tombstone and all resource limits, then build a fresh filtered session array and fresh tombstone object.
4. If no requested session exists, return `{ deletedIds: [], tombstones: {} }` without a storage write.
5. Otherwise call exactly one `Storage.setMany({ sessions, driveSyncTombstones })` and return only after it resolves.

`deleteSession()` delegates to `deleteSessions([sessionId], deletedAt)`; it does not repeat the transaction logic. It returns `{ deleted: false, tombstoneAt: null }` for a well-formed missing ID and the exact recorded timestamp when deletion succeeds.

`deleteManualGroup()` follows the same pattern with one complete portable-state
snapshot and exactly one `Storage.setMany({ manualGroups,
driveSyncTombstones })`. A missing well-formed group returns `{ deleted: false,
tombstoneAt: null }` without a write. Do not spread or delete from the object
returned by `getManualGroups()`.

Chrome storage rejection must reject the public operation. Because both keys are supplied in one call and the mock injects failure before applying it, neither the entity collection nor tombstone state changes. Never catch that rejection and return success.

`restoreDeletedSession()` validates and copies the worker-received session,
reads the complete portable-state snapshot together, computes the exact
`modifiedAt` rule above, retains the existing tombstone value/key, replaces any
existing session with the same ID rather than appending a duplicate, restores
Task 7's canonical session ordering, validates the full v2 document, and
performs one `Storage.setMany({ sessions, driveSyncTombstones })`. A storage
rejection leaves both unchanged. It returns the fresh restored session only
after success.

Malformed legacy `modifiedAt`/`createdAt` values use Task 7's defensive timestamp fallback for the calculation; the newly written `modifiedAt` is always schema-valid. Do not trust an arbitrary runtime object merely because its ID matches: require an own JSON session shape within Task 7's string, nesting, and tab limits, copy it, and reject dangerous/inherited keys before storage.

## Worker routing and UI behavior

- Task 7 already made the worker the only session/manual-group writer. Keep core transaction functions lock-free and invoke them only from existing locked worker operations.
- The `deleteSession` runtime action validates `sessionId`, chooses its own `Date.now()`, calls `deleteSession()`, and returns its plain `{ deleted, tombstoneAt }` result. Do not accept `msg.deletedAt` as timestamp authority.
- The `undoDeleteSession` action validates the session payload, chooses its own `Date.now()`, calls `restoreDeletedSession()`, and returns a URL-free summary such as `{ restored: true, modifiedAt }`. Do not accept `msg.restoredAt` as timestamp authority.
- The existing `deleteManualGroup` action validates `groupId`, chooses its own clock, and returns the core `{ deleted, tombstoneAt }` result. `group-editor.js` continues to perform no direct `manualGroups` write.
- Explicit session deletion, rolling cleanup after auto-save, and alarm retention all call `deleteSessions()` under their existing Task 7 worker lock. No retention path writes a filtered `sessions` array directly, and batch retention performs one transaction rather than one write per session.
- Capture one worker `now` for each retention run and use it both for cutoff selection and as the batch deletion timestamp. Preserve the existing “keep two newest auto-saves” policy.
- The session panel shows deletion success and offers Undo only after `sendOrThrow()` resolves with `deleted === true`. A rejection or `{ deleted: false }` is not success. Undo refreshes and toasts only after the checked worker response resolves.
- Group deletion follows the same checked response rule. A rejection or missing group never produces a success toast.
- Deletion updates local state only. The next manual or scheduled `syncDriveState` propagates the retained tombstone through Task 7's remote-first deterministic merge; do not add a second deletion-specific Drive writer.

## Convergence truth table

The tests and report must cover these outcomes in both merge operand orders:

| Profile/entity state | Greatest tombstone | Expected merged result |
|---|---:|---|
| older entity timestamp `< T` | `T` | entity absent; tombstone retained |
| entity timestamp `=== T` | `T` | entity absent; tombstone retained |
| genuinely newer entity timestamp `> T` | `T` | entity present; tombstone retained |
| Undo entity timestamp `>= T + 1` | `T` | restored entity present; tombstone retained |

The profile-A deletion/profile-B stale-copy case must converge to absence and byte-identical canonical results in both operand orders. Repeat with a genuinely newer profile-B update and with Undo; the entity survives only in the newer cases while the deletion tombstone remains.

## Mandatory TDD sequence

Do not edit a production file until steps 1-9 exist and the focused pre-change command in step 10 has produced genuine RED evidence. A syntax failure caused only by a deliberately missing new export is acceptable RED; a test that already passes must be strengthened before implementation.

1. Create `tests/core/deletion-tombstones.test.js` before production edits. Import the committed Task 7 constants/helpers and cover `computeDeletionTombstone()` plus `recordDeletionTombstones()` without Chrome state: exact maximum math, prior-tombstone maximum, future entity timestamps, malformed values, unrepresentable `MAX_DRIVE_TIMESTAMP` entities, immutability, null prototypes, lexical keys, dangerous IDs, duplicate entries, and tombstone-cap existing-key/new-key behavior.
2. Add session transaction tests. Prove one `Storage.getMany()` snapshot and one `Storage.setMany({ sessions, driveSyncTombstones })` call remove all requested existing IDs, record exact per-ID timestamps, preserve unrelated sessions/tombstones, stable-deduplicate IDs, and leave input/storage snapshots unmutated.
3. Inject `storage.local.set` rejection and assert sessions and tombstones are byte-for-byte unchanged. Cover invalid timestamps/IDs and a batch containing one unrepresentable entity; every case performs zero writes. Cover empty/missing-ID no-op behavior separately.
4. Add `deleteSession()` delegation coverage, including exact `{ deleted, tombstoneAt }` success and missing-ID results. The test should fail if single deletion retains a separate direct `Storage.set('sessions', ...)` path.
5. Add rolling auto-save and alarm-retention integration cases in the same approved test file. Seed multiple expired auto-saves with different entity/prior timestamps, dispatch the production paths, and assert each removed ID receives the shared-or-later timestamp in one batch. Assert both paths preserve the two newest auto-saves and make no direct filtered-session write.
6. Add Undo tests for valid/malformed prior session timestamps; absent, zero, ordinary, ceiling, and malformed prior tombstones; every invalid `restoredAt`; exact `MAX_DRIVE_TIMESTAMP`; input immutability; duplicate-ID replacement; canonical session order; retained tombstone; and one-call storage rejection. Merge the restored state with a stale profile in both operand orders and prove the restored session survives.
7. Add manual-group transaction tests for exact one-call removal+tombstone persistence, prior/future timestamps, ceiling/capacity behavior, missing groups, invalid IDs/timestamps, input immutability, and injected storage rejection.
8. Add worker routing regressions in the same file using the existing Chrome mock: explicit delete, Undo, rolling cleanup, alarm cleanup, and group delete queue behind a deferred Task 7 sync; no action reacquires the lock internally; the worker ignores/rejects caller-supplied clock fields; plain checked summaries cross messaging; and session/group panels retain no direct deletion writes.
9. Add the approved two-profile pure merge test: profile A deletes, profile B has an older copy, and both operand orders converge to deletion with the tombstone retained. Repeat with a genuinely newer profile-B entity and assert it survives while the tombstone remains. Assert byte-identical canonical JSON.
10. Run the focused command against the pre-change Task 7 code and preserve the RED output in `task-8-report.md`:

    ```bash
    bun test tests/core/deletion-tombstones.test.js
    ```

    Expected RED causes include session/group removal without the same-call tombstone, direct rolling/alarm filtered-session writes, Undo pushing an old record without a newer `modifiedAt`, and missing deletion timestamp helpers.
11. Implement the minimum production slice required to make the focused test GREEN. Do not add a package, build step, fake Drive service, second lock, distributed lock, tombstone pruning, production failure switch, or Task 9/10 export/import code.
12. Re-run the focused command and record exact pass/fail/expect counts, then run all final gates freshly:

    ```bash
    bun --version
    bun test
    bun test --coverage
    bun test tests/syntax.test.js
    git diff --check
    test "$(cat VERSION)" = "$(bun -e 'console.log((await Bun.file("manifest.json").json()).version)')"
    git status --short
    ```

    Bun must remain `1.3.11`; every test and syntax check passes; `git diff --check` is clean; both versions equal `1.2.10`. Record coverage honestly without inventing a repository-wide threshold.

Use the Task 7 Chrome mock's atomic storage recording/failure injection, runtime messaging, alarms, and deferred lock seams. Restore every stubbed clock, storage method, or worker import hook in `finally`. Do not add a DOM, IndexedDB, or Drive emulator to prove storage semantics the existing mock already exposes.

## Proportional real-Chrome/Drive gate

Reuse Task 7's installed official Chrome for Testing/Xvfb/CDP harness and explicitly throwaway Drive scope. Never print, save in evidence, or transmit an OAuth token, authorization header, private tab URL, session payload, or full Drive response body.

The two Chrome user-data directories must be distinct, but deletion convergence requires both installations to use the same Google account and the same uniquely named throwaway `driveProfileName` folder. Label the disposable browser profiles A and B separately in the report; do not give them different Drive folder names and then claim a cross-profile merge was exercised. Record this distinction as an adjacent plan clarification for Task 15.

1. In real profile A, create a synthetic session and manual group through production worker actions and complete a baseline `syncDriveState`. Start profile B against the same throwaway Drive scope and sync it before any deletion so both local profiles and remote canonical v2 state contain the same IDs.
2. In A, delete the session through the real panel action. Inspect `chrome.storage.local` by key/ID/count/timestamp only: the session is absent, its tombstone is a safe integer, and no private URLs are copied into evidence.
3. Use the Undo control in A. Confirm the session returns exactly once, its `modifiedAt` is strictly greater than the retained unchanged tombstone, then run sync and confirm the restored entity survives the next canonical merge.
4. Delete the manual group through the real panel. Confirm the group is absent and its matching tombstone exists in the same local state snapshot; run sync and confirm the canonical remote v2 document carries the tombstone without logging the document body.
5. Recreate a deletion-convergence session if needed, baseline-sync both profiles, delete it in A, then run the deterministic sequence A sync -> B sync -> A sync. Confirm the entity is absent locally in both profiles and remotely, while the greatest tombstone remains. Record only redacted fixture IDs/hashes, counts, timestamp comparisons, action order, and canonical content hash/equality.
6. Record the exact Chrome build/hash and prove cleanup of every throwaway Drive file/folder, both disposable browser profiles, Chrome/Xvfb processes, CDP listeners, and temporary files.

If the registered development OAuth boundary cannot authenticate the disposable extension ID, record the exact blocker and do not claim the real-Drive convergence row passed. Still complete the non-network real-Chrome local transaction/Undo/group checks, using synthetic private-free records, and clean every process/profile. A mock is not a substitute for the blocked Drive claim.

## Documentation, version, report, and commit

- Append the Task 8 browser/Drive row to `docs/reports/2026-07-14-reliability-smoke.md`, including exact tested commit/tree state, redacted results, any OAuth limitation, and cleanup. Do not expose browsing history or remote payloads.
- Update `GUIDE.md` to state that session/manual-group deletions propagate at the next sync and that session Undo restores a newer record while preserving convergence metadata. Do not promise manual-group Undo; it is not part of Task 8.
- Update `CHANGELOG.md` and `PROGRESS.md` with only landed behavior and evidence. Mark deletion convergence complete only when focused/full gates and applicable real Drive evidence exist; otherwise record the precise remaining browser/OAuth gate.
- Do not edit ADRs 0003/0004. If implementation would contradict their schema or worker ownership, stop and report the conflict instead of silently changing architecture.
- Set both `VERSION` and `manifest.json` to `1.2.10`.
- Close every Task 8 plan checkbox only after its named RED/GREEN, full-gate, documentation, and applicable real-browser/Drive evidence exists.
- Write `task-8-report.md` in the established five sections: what was built; verification evidence with preserved RED and fresh GREEN counts plus real-browser/Drive evidence; assumptions; concerns/adjacent observations; close-out confirmation. Include the two-profile truth table, storage call order/payload evidence, OAuth/cleanup status, model/agent ledger, exact version comparison, full commit hash, and final clean-worktree result.
- Commit the worktree changes with author email `29182417+michelabboud@users.noreply.github.com` and trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- Leave the worktree clean and report the full commit hash. No tag, push, release, `main` mutation, or parent-checkout mutation.

## Approved checklist (complete Task 8 intent)

- Session/group removal and its matching tombstone are supplied in the same one-call `Storage.setMany()` transaction; injected rejection changes neither collection.
- `deletedAt` is a bounded non-negative safe integer, each tombstone is the maximum of deletion/entity/prior timestamps, and an unrepresentable entity fails closed before any deletion.
- Batch auto-save and alarm retention give every removed session the shared-or-later tombstone and contain no direct filtered-session write path.
- Undo validates `restoredAt`, retains tombstone `T`, writes `modifiedAt = Math.max(restoredAt, entityTimestamp, T + 1)`, handles malformed prior timestamps safely, and survives the next merge.
- Two-profile merge in both operand orders deletes stale/equal entities, permits genuinely newer entities, retains tombstones, and produces byte-identical canonical JSON.
- The focused pre-change run preserves genuine RED evidence from the direct deletion/Undo paths.
- Pure Drive tombstone-update helpers return fresh deterministic maps and never mutate storage values or inputs.
- `deleteSessions()` owns the batch transaction, `deleteSession()` delegates, and explicit/rolling/alarm deletion all use the locked worker path.
- `undoDeleteSession` routes through `restoreDeletedSession()` and never pushes the old record directly.
- `deleteManualGroup()` atomically writes `manualGroups` plus `driveSyncTombstones` through the existing centralized locked action; other group mutations remain worker-owned.
- Focused and full Bun/coverage/syntax/whitespace/version gates pass with no dependency, build, second-lock, pruning, or failure-hook additions.
- Real Chrome proves local deletion, Undo's newer timestamp, retained tombstone, and manual-group deletion without exposing private URLs; real Drive proves two-profile convergence or records an honest OAuth blocker without claiming passage.
- User docs, smoke evidence, changelog/progress, version `1.2.10`, five-section report, model ledger, commit trailer, full hash, and clean worktree are complete before controller review.
