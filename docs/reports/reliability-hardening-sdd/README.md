# Reliability-hardening SDD evidence archive

This directory preserves the complete gitdir-local SDD evidence set produced
while implementing the fifteen-task reliability-hardening initiative. It is an
audit archive: the canonical current summaries remain
[`../2026-07-14-reliability-smoke.md`](../2026-07-14-reliability-smoke.md) and
the
[`../../guides/real-chrome-smoke-matrix.md`](../../guides/real-chrome-smoke-matrix.md)
operator guide.

## Provenance

- Source: `.git/worktrees/reliability-hardening/sdd/`
- Source worktree branch: `codex/reliability-hardening`
- Snapshot commit: `e41da49bc7dcd914e06e4462e4d426c827d91d66`
- Archived: 2026-07-20
- Copied source files: 47
- Copied source bytes: 1,212,720
- Aggregate source-tree SHA-256:
  `1d2d222539aa705fd291119ce7272808288f81a78e1bafb9537b8e2d04239e91`

The aggregate digest hashes the sorted output of `sha256sum` for every source
file, using paths relative to the SDD directory. Before this README was added,
`diff -qr` and the aggregate digest confirmed that every archived source file
was byte-for-byte identical to its gitdir-local original. A scoped
`.gitattributes` rule prevents Git whitespace checks from rewriting or rejecting
historical patch syntax; this README remains under the normal whitespace gate.

## Contents and use

The archive includes task briefs and closeout reports, browser-smoke harnesses,
review diffs, progress state, and the historical `v1.2.8` release notes. These
files intentionally retain historical intermediate states and hashes. Do not
treat an individual archived report or diff as proof of the current release;
use the canonical consolidated report and exact-package matrix linked above.

The browser-smoke scripts are preserved for reproducibility. They are not part
of the packaged extension and are not invoked by production code or CI.
