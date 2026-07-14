# ADR 0003: Use versioned deletion tombstones for Drive sync

## Context

Drive sync currently unions remote and local sessions/groups. Removing an object locally leaves its remote copy intact, so the next sync recreates it. A deletion must be distinguishable from an older copy on another offline Chrome profile.

## Decision

Introduce Drive sync schema version 2 with deletion tombstones:

```json
{
  "version": 2,
  "sessions": [],
  "manualGroups": {},
  "tombstones": {
    "sessions": { "session-id": 1784050000000 },
    "manualGroups": { "group-id": 1784050000000 }
  }
}
```

Local deletion records the deletion timestamp. Merge takes the greatest tombstone timestamp per ID and removes an entity when its tombstone is not older than the entity's `modifiedAt` or `createdAt`. Version 1 files are read as having empty tombstone maps. Version 2 is written after the first successful merge.

Tombstones are retained rather than discarded after one sync because another profile may remain offline for an arbitrary period.

## Alternatives rejected

- **Authoritative local overwrite:** can delete valid changes from another profile.
- **Authoritative remote overwrite:** preserves the current resurrection defect.
- **Delete remote objects immediately without metadata:** cannot distinguish a deliberate deletion from a missing or stale client.
- **Short tombstone expiration:** allows sufficiently old offline profiles to resurrect deleted data.

## Consequences

- Deletions converge across profiles without turning sync into one-way overwrite.
- Sync payload size grows with deleted IDs; IDs and timestamps are small and can be compacted only by a future explicit migration.
- Session and manual-group delete paths must record tombstones transactionally with local removal.
- Merge rules and version 1 migration become pure, extensively tested functions.

## Status

Accepted on 2026-07-14.
