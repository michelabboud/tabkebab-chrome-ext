# Task 9 Implementation Report

Date: 2026-07-19

Base: `fbea7ada92694f3de94a14540378a742eb255381`

Target version: `1.2.11`

Commit: `906416d4c18a87bcb8b5743608bcf1273ba381d4`

## 1. What was built

Task 9 establishes the pure foundation for complete, secret-free portable backups without yet wiring the user-facing export/import paths assigned to Task 10:

- `core/export-schema.js` defines the fixed version-2 full/partial envelopes, exact settings allowlist, version-1 and current Drive-backup normalization, section validation, deterministic creation/parsing, and local-wins merge interfaces.
- One own-property traversal rejects accessors, cycles, symbols, sparse arrays, non-JSON values, dangerous keys, secrets/caches, excessive strings/depth, and cumulative cost above 25 MiB before merge or storage access. Property/array bounds apply before expensive per-entry work or sorting.
- Section validation enforces 10,000 records/tombstones, 10,000 tabs/URLs per record, and 100,000 total tabs/URLs. `validateStashSection()` is exported, requires the IndexedDB `createdAt` index key, is called exactly by the document parser without a second clone/scan, and revalidates every ordinary public call without a persistent trust brand.
- AI export is constructed from enabled/provider/model/custom-base-URL fields only. Merge overlays those safe fields while preserving existing encrypted API-key and passphrase metadata literal bytes; that secret exception is scoped only to existing `aiSettings`.
- Explicit import merge revives an otherwise absent imported session/manual group above a retained local tombstone without mutating or returning the tombstone map.
- New bookmark snapshots receive `crypto.randomUUID()` before either the production local-storage write or Drive multipart upload.
- Current Focus history uses `runId`; published pre-`runId` records use a distinct legacy `id` namespace. Legacy Drive `savedAt` settings and unversioned numeric-timestamp session/stash backups normalize to v2.
- Export creation omits structured-clone `undefined` object properties once, matching legacy JSON serialization, while imported JSON remains strict.
- Architecture, changelog, progress, plan status, `VERSION`, and `manifest.json` are updated for `1.2.11`.

## 2. Verification evidence

### Regression-first chronology

The first focused run preceded production implementation:

```text
bun test tests/core/export-schema.test.js tests/integration/bookmark-snapshot.test.js
schema: Cannot find module ../../core/export-schema.js
bookmark: expected id bookmark-local-uuid, received undefined
0 pass
2 fail
1 error
2 assertions
```

A self-review then added a hostile oversized sparse-array case that exposed iteration by declared length before rejection:

```text
bun test tests/core/export-schema.test.js tests/integration/bookmark-snapshot.test.js --test-name-pattern 'hostile oversized sparse array'
expected array/100000 limit, received sparse/non-JSON only after walking the declared length
0 pass
1 fail
1 assertion
```

The generic array/object traversal guard now rejects above 100,000 slots/properties before constructing per-entry state.

Independent review and controller audit then produced genuine targeted failures before each repair for:

- production Focus history keyed by `runId`, plus published legacy history keyed only by `id`;
- sorting an oversized object before enforcing its property cap;
- colliding NUL-delimited legacy bookmark tuples;
- 10,001 external tombstones and a section-wide secret exception;
- literal AI credential/passphrase serialization order;
- production structured-clone `undefined` fields in sessions/stashes;
- mutated parsed stashes bypassing public transaction-boundary revalidation;
- missing stash `createdAt` records that IndexedDB would store but omit from its ordered index;
- Drive `savedAt` settings and unversioned dated session/stash backups;
- a second canonical clone of the full export source.

Every case was rerun GREEN before the final combined gates. The final review reports no remaining Critical, Important, or Minor findings.

### Current automated evidence

```text
bun test tests/core/export-schema.test.js tests/integration/bookmark-snapshot.test.js
33 pass
0 fail
186 assertions

bun test
440 pass
0 fail
2289 assertions

bun test --coverage
440 pass
0 fail
2289 assertions
all files: 49.18% functions, 50.09% lines

bun test tests/syntax.test.js
2 pass
0 fail
93 assertions

git diff --check
exit 0

VERSION == manifest.json == 1.2.11
Bun 1.3.11
dependency audit: not applicable; no package or lockfile changed
```

The controller and independent reviewer each ran the full suite at `440/0/2289`. Coverage has no repository-wide threshold; it is recorded rather than overstated. The final tracked tree is `81d436b5da498383ca00cc27aa0211edbac41750`.

### Agent/model ledger

- Controller, regression completion, production implementation, and documentation: root GPT-5 Codex.
- Initial delegated implementer: `task9_implementer`; returned a design outline without editing files or running tests, so the controller implemented the slice.
- Independent spec/security review: `task7_integration_audit` reassigned to the bounded Task 9 live-diff review; final verdict is merge-ready with no remaining finding.

## 3. Assumptions made

- `mergePortableSections()` returns only merged sections. The supplied tombstone map remains external, retained, and unchanged; Task 10 writes only its eight affected local keys and leaves tombstones intact.
- Safe forward-compatible record fields remain allowed, while dangerous, secret/cache, accessor, symbol, cyclic, sparse, non-JSON, and over-budget structures reject.
- Export construction sanitizes AI settings by construction. Imported version-2 AI settings are strict and reject `apiKey` rather than stripping it.
- Array slots incur the specified 16-byte cost; numeric array indices do not separately incur own-key UTF-8/property cost.
- Legacy bookmark identity requires all of `createdAt`, `date`, and `time` when no stable ID is present.
- The parser invokes the exact exported stash validator through one transient synchronous context carrying its already-bounded canonical section and tab count. The context is restored immediately; no mutable returned value retains trusted status, so Task 10's public pre-put call always canonicalizes and validates again.

## 4. Concerns and adjacent observations

- Task 9 does not yet replace any panel/core export/import workflow. Task 10 owns pre-parse file-size rejection, worker serialization, one-snapshot storage reconciliation, IndexedDB replacement, rollback, UI feedback, docs, and real-Chrome import/export evidence.
- Existing AI credentials and passphrase metadata remain local and preserve literal serialized bytes through merge; portable output excludes them by construction. Existing secrets outside `aiSettings` and every imported secret/cache field reject.
- Tombstones are external merge authority rather than a portable section, remain unchanged/not returned, and repeat Drive v2's 10,000-per-kind validation defensively.
- No package or lockfile changed, and no production dependency/build step was introduced.

## 5. Close-out confirmation

- Implementation, regression-first evidence, docs, and version metadata are present.
- Final independent review and deterministic gates are complete with no remaining finding.
- Commit `906416d4c18a87bcb8b5743608bcf1273ba381d4`, annotated tag `v1.2.11`, atomic main+tag push, and remote ref verification are complete. Remote `main` and the tag peel to the exact commit; annotated tag object is `1113bc09d67b72e8bb962b3b4bc56254d69b9358`.
- Exact-commit GitHub Actions run `29676895966` completed successfully. Parent and task worktrees are clean.
- Task 9 is a fine-grained tag checkpoint; no GitHub release is scheduled until the Phase 2 boundary at Task 11.
