# Task 15 Implementation and Release Report

Date: 2026-07-19

Base: `13cc0d5442789abb5269558a28ee3b727a251b2e` (`v1.2.16`)

Target version: `1.2.17`

Implementation commit: pending

## 1. Implementation

In progress: Windows positive-allowlist packaging, dependent CI artifact,
exact-artifact operator matrix, consolidated evidence, and final documentation.

No runtime JavaScript, manifest permission, accepted ADR, package metadata,
dependency, Chrome Web Store state, or production behavior is inside Task 15's
implementation scope. Michel explicitly overrode the original manifest-key
exclusion on 2026-07-19 and approved pinning the recovered public production
identity; no OAuth token, client secret, password, or private signing key is in
scope or stored.

## 2. Verification evidence

### Accepted Task 14 baseline

- Clean base commit/tag/remote: `13cc0d5442789abb5269558a28ee3b727a251b2e`
  / `v1.2.16`.
- Exact-commit GitHub Actions run `29692667393`: success.
- Focused Task 14: `85 pass / 0 fail / 620 assertions`.
- Full and coverage: `854 pass / 0 fail / 4804 assertions`.
- Syntax: `2 pass / 0 fail / 116 assertions`.
- Coverage: `71.07%` functions / `67.55%` lines under Bun `1.3.11`.
- Documentation-updated terminal tree:
  `bf9e60cc9e6c941c5fb63a6996ab610864b66823`.

### Packaging RED/GREEN

- Authoritative execution used real Windows `cmd.exe` and PowerShell interop.
- RED mismatch: the old packager accepted disposable `VERSION=9.9.9` while the
  manifest remained `1.2.16`, exited zero, and produced a flattened archive of
  147 repository files outside the five-entry release boundary.
- GREEN mismatch: exit 1, no zip.
- GREEN missing `icons`: exit 1, no zip.
- GREEN valid disposable tree: exit 0, 75 files, with exact archive roots
  `core`, `icons`, `manifest.json`, `service-worker.js`, and `sidepanel`.
- GREEN real worktree: produced `tabkebab-1.2.17.zip` with packaged manifest
  `1.2.17`, public-key SHA-256
  `1aa8af09b39a7558a8f95f7d7fe1c39e7cf41aa58c09da13021e40d46847be51`,
  and local zip SHA-256
  `fd3e107a78d16970ab5cd85bc31b8214973042cb3a62ed5f1cf2cad03dd80f76`;
  the local evidence artifact was then removed.
- Remaining matching Windows temporary staging directories: zero.
- The dependent Windows CI job parses the version, invokes the batch file,
  requires one exact zip, expands it to a fresh temporary directory, compares
  the sorted root set, checks packaged manifest parity, and uploads only the
  versioned zip.
- Independent review found and repaired two initial release blockers: Windows
  PowerShell 5.1's default archive API emitted 73 backslash entry names that
  Linux `unzip` rejected, and failed invocations retained owned stale/partial
  zips. The final packager writes explicit forward-slash names and removes all
  owned `tabkebab-*.zip` outputs on failure while preserving unrelated files.
- The reviewer then found case-insensitive CI set comparison could accept a
  case-variant root. Raw and expanded root checks are now case-sensitive.
- Terminal independent rerun is clean: Windows PowerShell 5.1 produced 75
  entries at the exact five roots, unsafe/backslash entries were zero, Linux
  `unzip` exited zero, mismatch/missing/metacharacter cases failed closed,
  staging was empty, and unrelated `dist` files survived.

### Task 15 local gates

```text
Bun: 1.3.11
full suite: 854 pass / 0 fail / 4804 assertions
coverage suite: 854 pass / 0 fail / 4804 assertions
coverage: 71.07% functions / 67.55% lines
syntax: 2 pass / 0 fail / 116 assertions
git diff --check: pass
VERSION / manifest.json: 1.2.17 / 1.2.17
root package or lockfiles: none
```

The first combined metadata shell invocation had a controller quoting error in
its inline Bun expression after the syntax tests passed. The corrected exact
version/whitespace/dependency command passed; this was harness-only and no
product gate failed.

## 3. Documentation and evidence inventory

- `docs/reports/2026-07-14-reliability-smoke.md` retains Task 2-14 evidence and
  explicit browser/OAuth/model boundaries.
- `docs/guides/real-chrome-smoke-matrix.md` defines exact artifact/state
  preflight, process helpers, eleven setup/action/assert/evidence/cleanup rows,
  completion criteria, and guarded cleanup. Its 51 Bash blocks pass `bash -n`,
  30 JavaScript blocks parse under Bun, all 11 PASS-row calls have eight arguments
  in exact `01`–`11` order, every post-helper Bash block installs the cleanup
  trap, and Markdown fences are balanced. Review-driven repairs add private
  Xauthority, self-cleaning startup, guarded CDP download directories, exact
  Drive-name sanitization, in-flight Focus counters, executable per-row
  constructors, operator-safe Row 09 timing, and exact unique PASS accounting.
  Terminal hardening additionally pins every Chrome descendant by PID plus
  `/proc` starttime and verified PPID ancestry before TERM/KILL, preserves an
  active-row failure finalizer, branches Row 06 cleanup before versus after
  successful OAuth, and proves Row 08 cancellation/reconnect/background behavior
  with production per-domain summarization, Web Locks, worker pending counts,
  cache transitions, and canonical state fingerprints.
- Final exact-artifact results will be written only to the mode-0600 local
  release notes and this gitdir-local report after the tracked commit is fixed.

## 4. Assumptions, risks, and release blockers

- All eleven rows must pass against one expanded CI artifact before a GitHub
  release can be created.
- The installed WSL Chrome 148 Prompt API currently reports `unavailable`; no
  model download is authorized or represented as proof.
- Live Drive now has the exact registered production identity/client
  precondition: the owner-approved 392-character public manifest key derives
  `cgfnjdcioainbclbbihglaopbhikhdob` and matches both installed Store-manifest
  copies. It still requires an operator-authenticated disposable Google session.
  Tokens and private Drive payloads are prohibited from evidence and the bridge.
- The old store zip contains the public development client. No client secret,
  private key, credential environment value, or GitHub secret was found.
- Windows Chrome `150.0.7871.128` is running without a remote-debug endpoint.
  Its default/Profile 1 store installation and Google-account records are not
  exact-artifact evidence and were not attached or copied.
- Windows has a complete approximately 4.27 GB on-device model component. A
  disposable Windows profile may therefore satisfy the Prompt row, but runtime
  availability remains unconfirmed; Linux Chrome 148 reports `unavailable`.
- The unchanged production timeout row requires approximately four minutes for
  the initial and explicit-retry attempts plus teardown.

## 5. Agent/model ledger and closeout

| Agent | Role | Result |
|---|---|---|
| Root Codex (model identifier not exposed) | Integration, docs, gates, commit/tag/push/release | In progress |
| Packaging agent (model identifier not exposed) | Windows RED/GREEN and CI artifact | Complete |
| Independent packaging reviewer (model identifier not exposed) | Batch/workflow contract review | Clean after three repaired findings |
| Matrix-guide agent (model identifier not exposed) | Eleven-row operator runbook | Complete; static validation clean |
| Fixture-audit agent (model identifier not exposed) | Read-only Drive/Prompt/Windows feasibility | Complete; OAuth identity/scope blocker found |
| Independent matrix reviewer (model identifier not exposed) | Runbook/source/safety review | Clean; terminal review found no implementation blocker |

Implementation commit: `e41da49bc7dcd914e06e4462e4d426c827d91d66`.
Annotated tag `v1.2.17` and `origin/main` both resolve to that commit. Exact
GitHub Actions run `29696574220` completed successfully with both `test` and
Windows `package` jobs green. Its single artifact contains
`tabkebab-1.2.17.zip`, SHA-256
`1057276738112afd3bdbacd7f014eb238dfbdd353be5ec5dd0363586c136ed67`.
The zip has 75 canonical entries under only `core`, `icons`, `manifest.json`,
`service-worker.js`, and `sidepanel`; packaged version, public-key hash, and
derived extension ID all match the source release.

The exact artifact also loaded in the pinned Chrome for Testing
`148.0.7778.96` as `cgfnjdcioainbclbbihglaopbhikhdob`, version `1.2.17`.
The Prompt API was present but reported `downloading`. The eleven-row matrix
therefore remains unpassed; Row 06 additionally needs operator authentication
in two disposable profiles using the existing Google account. No GitHub
release object exists for `v1.2.17`, correctly preserving the fail-closed gate.
The verified artifact is retained at
`/tmp/tabkebab-ci-29696574220.2gaimz/tabkebab-1.2.17.zip` for resume.
