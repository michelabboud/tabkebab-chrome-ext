# Task 8 Implementation Report

Date: 2026-07-19

Base: `4a48a08dc3e613e2fd0cdf22cffc84b4357859e1`

Target version: `1.2.10`

Commit: `fbea7ada92694f3de94a14540378a742eb255381`

## 1. What was built

Task 8 makes local session and manual-group deletion converge through the Drive v2 schema rather than allowing an older copy on another profile to resurrect later:

- Pure timestamp/tombstone helpers validate bounded clocks, dangerous or inherited IDs, duplicate entries, count ceilings, canonical bytes, and immutable lexical null-prototype maps before a mutation.
- Session batch deletion, session Undo, and manual-group deletion each read one complete portable-state snapshot, validate the resulting full v2 document, and issue one two-key `Storage.setMany()` call containing the affected entity collection plus `driveSyncTombstones`.
- `deleteSession()` delegates to the batch transaction. Explicit deletion, rolling auto-save cleanup, alarm retention, Undo, and manual-group deletion run inside the existing worker-owned FIFO mutation lock.
- Undo retains the session tombstone, replaces any same-ID copy, and stores exactly one canonical session whose `modifiedAt` is strictly greater than that tombstone.
- The side-panel session/group controls require explicit checked worker confirmations. Missing entities, worker rejection, and post-commit refresh failure are not presented as uncommitted success.
- User/release docs and both version sources are updated for `1.2.10`; final verification and controller-owned git closeout are complete.

No production dependency, build step, second lock, tombstone-pruning policy, or Task 9/10 export/import behavior was added.

## 2. Verification evidence

### Regression-first chronology

The Task 8 regression file was created before any production edit and run against the exact clean Task 7 commit:

```text
bun test tests/core/deletion-tombstones.test.js
2 pass
17 fail
30 expect() calls
19 tests
exit 1
```

This was genuine preproduction RED. The failures exposed missing tombstone helpers and batch/Undo interfaces, entity-only session/group writes, direct rolling/alarm filtered-session writes, unchecked worker/panel outcomes, and absent same-call deletion+tombstone transactions. Task 7's existing deterministic merge row was one intentional pass. A misleading malformed-input pass caused by the missing export throwing was strengthened with an explicit function-presence assertion before production implementation.

The initial production slice then made the original cases green. Independent code review and test audit found additional boundary gaps, and each was added as a new failing regression before its repair. Those reviewer-driven RED/GREEN cycles expanded the file from 19 to 36 tests and cover:

- the `10,001`-session Undo entity ceiling;
- a 25 MiB tombstone-fragment overflow and a separately bounded session+tombstone combination whose canonical full document exceeds 25 MiB;
- the cross-kind `100,001` total tab/URL ceiling contributed by an otherwise untouched manual-group section;
- inherited IDs, inherited tombstone-kind maps, and inherited portable-state sections;
- checked UI behavior when the worker commit succeeds but the subsequent panel refresh fails.

The exact-tree reviewer then found that the existing panel `refresh()` catch
resolved after a failed `listSessions`, so the intended post-commit failure branch
was unreachable in production even though a rejecting test stub covered it. The
regression was changed to invoke the real `refresh()` method and produced a fresh
targeted RED (`0 pass / 1 fail / 3 assertions`); returning and checking an explicit
refresh status made the same case GREEN (`1 pass / 0 fail / 9 assertions`).

### Final automated evidence

The controller reran every gate against the final code/test bytes and then froze
terminal tracked tree `422055ab3788c153891b4bd3cb8c0745430c5d19`:

```text
bun test tests/core/deletion-tombstones.test.js
36 pass
0 fail
340 expect() calls

bun test tests/core/state-mutation-lock.test.js
27 pass
0 fail
149 expect() calls

bun test
407 pass
0 fail
2100 expect() calls

bun test --coverage
407 pass
0 fail
2100 expect() calls
all files: 45.75% functions, 47.33% lines

bun test tests/syntax.test.js
2 pass
0 fail
90 expect() calls

git diff --check
exit 0

VERSION == manifest.json == 1.2.10
Bun 1.3.11
dependency audit: not applicable; no package or lockfile changed
```

### Two-profile convergence truth table

The pure merge regressions exercise both operand orders and require byte-identical canonical JSON:

| Profile/entity state | Greatest tombstone | Expected merged result | Current deterministic result |
|---|---:|---|---|
| older entity timestamp `< T` | `T` | entity absent; tombstone retained | pass in both orders |
| entity timestamp `=== T` | `T` | entity absent; tombstone retained | pass in both orders |
| genuinely newer entity timestamp `> T` | `T` | entity present; tombstone retained | pass in both orders |
| Undo entity timestamp `>= T + 1` | `T` | exactly one restored entity present; tombstone retained | pass in both orders |

The Undo regression merges the actual persisted restore transaction state with a stale profile; it does not substitute a hand-constructed label for the restored record.

### Atomic storage evidence

The tests record calls through the Chrome storage adapter and prove:

1. Each session deletion, session Undo, and manual-group deletion performs one `Storage.getMany(['sessions', 'manualGroups', 'driveSyncTombstones'])` snapshot.
2. A successful session mutation performs exactly one `Storage.setMany({ sessions, driveSyncTombstones })`; a successful group deletion performs exactly one `Storage.setMany({ manualGroups, driveSyncTombstones })`.
3. Missing IDs and every invalid/preflight-overflow case perform zero writes.
4. Injected `storage.local.set` rejection leaves both affected stored sections byte-for-byte unchanged.
5. Frozen storage snapshots, runtime payloads, entity collections, and tombstone maps remain unmodified.
6. Explicit, rolling, alarm, Undo, and group operations queue behind an in-flight canonical sync in strict FIFO order and do not reacquire the lock from core helpers.

The three-key read is an adjacent correction to the original two-key wording. A two-key snapshot could not validate Drive v2's full-document 25 MiB and 100,000-tab/URL aggregate ceilings when an untouched section supplied the excess. The write contract remains one call containing only the two affected keys.

### Preliminary real Chrome local boundary

**Superseded preliminary evidence; exact-final-tree rerun pending.** The earlier browser run exercised tree `0ceb06691bf3968e738bd3e8b3eec3966e64ed59`:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
extension ID: igggfmpiljhefkagnphadfadollcimlh

session Delete: sessions changes=1, driveSyncTombstones changes=1
session Undo: sessions changes=1, driveSyncTombstones changes=0
restored copies=1, modifiedAt > unchanged retained tombstone=true
manual-group Delete: manualGroups changes=1, driveSyncTombstones changes=1
HTTP(S) requests=0
liveDrivePassed=false
```

The production panel, Manifest V3 worker, FIFO lock, and `chrome.storage.local` were exercised with synthetic private-free records. No session body, private URL, token, authorization header, tombstone map, or browsing history was copied into evidence.

All preliminary cleanup checks reported zero remaining disposable profile paths, matching Chrome/Xvfb processes, CDP listeners, temporary fixture paths, or Drive artifacts. No Drive artifact existed because the run made zero HTTP(S) requests.

Live Drive remains **blocked and unpassed**. The disposable unpacked ID has no matching registered OAuth client, and the clean disposable profile had no operator-authenticated Google test-user session. No OAuth token was requested, printed, or persisted. Deterministic merge tests and the local Chrome boundary are not represented as remote two-profile convergence.

### Terminal-tree real Chrome local boundary

The controller reran the same fail-closed harness after every tracked runtime,
test, evidence, and status edit. Exact terminal tree
`422055ab3788c153891b4bd3cb8c0745430c5d19` passed with the same Chrome build,
binary hash, and unpacked ID above. Every deletion, Undo, tombstone, checked UI,
and timestamp comparison returned `true`; HTTP(S) attempts and requests reaching
the network were both `0`; `liveDrivePassed` remained `false` with the same
registered-client/authenticated-profile blocker.

The terminal harness reported profile removal plus Chrome/Xvfb exit. A separate
host audit found zero Task 8 profile/index paths, matching Chrome/Xvfb processes,
or TCP listeners on port `6098`. No tracked content changed during the run.

### Agent/model ledger

- Controller and production implementation: root GPT-5 Codex.
- Task 8 implementer attempts: delegated Task 8 implementer agents; stalled attempts were stopped, and the controller completed the production slice.
- Browser boundary: delegated Task 8 browser agent adapted and ran the local Chrome harness.
- Independent review: `task8_code_review`.
- Boundary/test audit: `task8_test_audit`.
- Documentation/version closeout: `task8_docs`.

### Final controller state

```text
bun --version: 1.3.11
bun test tests/core/deletion-tombstones.test.js: 36/0/340
bun test: 407/0/2100
bun test --coverage: 407/0/2100; all files 45.75% functions / 47.33% lines
bun test tests/syntax.test.js: 2/0/90
git diff --check: exit 0
VERSION == manifest.json == 1.2.10: pass
exact-final-tree Chrome rerun: pass on tree 422055ab3788c153891b4bd3cb8c0745430c5d19
final commit: fbea7ada92694f3de94a14540378a742eb255381
final independent review: PASS; prior refresh-status finding resolved, no remaining blocker
clean worktree: PASS after commit
remote main/tag verification: PASS; both peel to fbea7ada92694f3de94a14540378a742eb255381
exact-commit GitHub Actions: PASS, CI run 29675018670
```

## 3. Assumptions made

- Task 7's Drive v2 schema, retained tombstones, deterministic merge, resource ceilings, remote-first reconciliation, and worker-local FIFO lock remain authoritative.
- A deletion updates local portable state only. The next manual or scheduled `syncDriveState` propagates the retained tombstone; Task 8 does not add a second Drive writer.
- A complete three-key read is required to validate the resulting canonical document, while the atomic write should still contain only the two affected keys.
- Missing well-formed IDs are checked no-ops, not attacker-controlled tombstone creation.
- Session Undo is part of Task 8; manual-group Undo is not and is not promised in user documentation.
- The preliminary browser result remains useful local-boundary evidence but cannot close the exact-final-tree row after reviewer-driven code/test changes.

## 4. Concerns and adjacent observations

- The real Drive/OAuth row still requires a registered extension identity/client pair and an operator-authenticated disposable Google test-user session. Both local profiles must share one uniquely named throwaway Drive folder; different remote scopes would not prove convergence.
- The preliminary browser tree remains labeled superseded for chronology. Terminal tree `422055ab3788c153891b4bd3cb8c0745430c5d19` reran the bounded local Delete/Undo/group scenario and passed with complete cleanup.
- The original two-key snapshot wording was insufficient for aggregate Drive v2 validation. This report and the approved plan now record the three-key-read/two-key-write clarification so later export/import work does not regress it.
- Task 8 is a fine-grained tag checkpoint only. Phase 2's browsable GitHub release remains scheduled for Task 11, so no `gh release` belongs to the `v1.2.10` closeout.
- No package or lockfile changed; dependency audit impact is therefore not applicable for this task checkpoint.

## 5. Close-out confirmation

- User guide, changelog, progress, smoke report, and Task 8 plan status are updated.
- `VERSION` and `manifest.json` are set to `1.2.10`; the exact parity command passed.
- Preserved initial RED, current GREEN counts, convergence truth table, atomic storage contract, preliminary browser/OAuth boundary, cleanup, and agent ledger are recorded.
- Commit `fbea7ada92694f3de94a14540378a742eb255381`, annotated `v1.2.10` tag, atomic push to `main`, remote verification, exact-commit CI run `29675018670`, and final clean-worktree confirmation are complete.
- GitHub release creation is intentionally deferred to the Phase 2 boundary at Task 11.
