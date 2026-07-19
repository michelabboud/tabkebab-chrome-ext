# ADR 0004: Serialize portable-state mutations in the service worker

## Context

Sessions, manual groups, and canonical Drive sync were previously mutated from several independent side-panel, runtime-message, and alarm paths. The panel's local-first sync could overwrite a newer mutation, and separate `chrome.storage.local` reads and writes had no ordering relationship. A multi-key Chrome storage call can commit one local snapshot, but it cannot order an overlapping read/modify/write sequence or provide a transaction with Google Drive.

Manifest V3 supplies one active service-worker instance per extension profile, but it does not provide a distributed lock across Chrome profiles. The sync merge therefore also needs deterministic, order-independent output so later retries and cross-profile reconciliation converge.

## Decision

The service worker is the sole writer for Task 7 session/manual-group mutations and canonical Drive reconciliation. Side-panel components may read rendered state, but mutations cross checked runtime-message actions. Manual and scheduled sync use the same worker coordinator.

One worker-local FIFO promise tail serializes these mutations. Each caller receives its operation's original value or rejection; only the internal tail recovers from rejection so the next queued operation can start. The outer public coordinator acquires the lock exactly once; internal helpers are explicitly unlocked and must never acquire it recursively. Canonical sync holds the lock across remote/local reads, migration and merge, the remote canonical write, one three-key local storage commit, subfolder/settings work, and the final `lastSyncedAt` update.

Drive sync reads missing-version and version-1 documents as version 1 with empty tombstone maps and writes version 2. Merge selection and emitted object/key order are deterministic. Reconciliation writes the merged document to Drive before calling one `Storage.setMany({ sessions, manualGroups, driveSyncTombstones })`. A remote failure performs no local commit. If the remote write succeeds and the local commit fails, a retry recomputes and writes the same canonical bytes before retrying the local snapshot.

This is not a distributed lock and does not make Google Drive plus Chrome storage one transaction. Concurrent workers in different Chrome profiles can still overlap; deterministic merge and retry are the convergence mechanism. Tombstones are retained by the schema, but Task 8 remains responsible for recording deletion and Undo timestamps transactionally on every delete path.

## Alternatives rejected

- **Keep panel-owned writes and add local retries:** independent read/modify/write loops still race and can overwrite later state.
- **Lock individual storage calls:** ordering calls separately does not protect the complete read/merge/remote/local operation.
- **Acquire the lock inside every helper:** nested acquisition on a non-reentrant FIFO tail can deadlock and obscures coordinator ownership.
- **Write local state before Drive:** an upload failure would leave local state claiming a reconciliation that never reached the canonical remote file.
- **Add a distributed Drive lease:** substantially increases protocol and failure-recovery complexity; deterministic merge plus idempotent retry is sufficient for this slice.

## Consequences

- Later session and manual-group mutations wait for an in-flight sync and cannot be overwritten by its stale snapshot.
- A long Drive operation delays other portable-state mutations in the same extension profile.
- `lastSyncedAt` advances only after every required sync phase succeeds.
- New worker-owned portable-state writers must use an existing outer coordinator or acquire the FIFO lock once, never both.
- `Storage.setMany()` provides one Chrome local-storage call, not a cross-system transaction.
- Cross-profile simultaneous writes may require another sync/retry before all profiles observe the same deterministic document.

## Status

Accepted on 2026-07-19.
