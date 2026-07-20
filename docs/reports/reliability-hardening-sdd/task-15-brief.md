# Task 15 Implementation and Final-Release Brief

## Objective

Implement the approved Task 15 slice from `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`: make packaging a fail-closed positive allowlist, add exact Windows artifact verification to CI, consolidate reproducible real-Chrome instructions and prior evidence, then have the root controller publish only after every one of the eleven rows passes against the exact CI-produced package and all remote/cleanup checks succeed.

- Base commit: `13cc0d5442789abb5269558a28ee3b727a251b2e` (`v1.2.16`)
- Expected initial final version/tag: `1.2.17`
- Scope: final verification of all thirteen findings
- Phase checkpoint: Phase 3 and initiative-final GitHub release
- Worktree: `/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening`
- Controller scratch report: `/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-15-report.md`

Start only from the controller-confirmed clean Task 14 commit. The controller
verified `git rev-parse HEAD` equals the independently reviewed base hash above
before dispatching Task 15 work.

Read the approved design, all committed ADRs, every Task 2-14 report/smoke row, the Phase 1 and Phase 2 release verification, and the committed Task 14 interfaces before work. Confirm Task 13's non-overlap checkpoint and Task 14's foreground broker checkpoint are accepted. If any earlier task remains unreviewed, dirty, version-mismatched, or has an unresolved required browser/Drive/Prompt API blocker, Task 15 does not paper over it: return the owning slice for repair before final publication.

No Chrome Web Store upload, submission, listing edit, OAuth-client mutation, framework, dependency, or product feature is part of Task 15.

## Ownership split

Task 15 has an implementation stage and a controller-only release stage.

### Implementation worker owns

- the exact Task 15 repository files below;
- pre-change packaging RED evidence and post-change local package verification;
- the reproducible matrix guide and consolidation of already committed per-slice evidence;
- local Bun/coverage/syntax/whitespace/version/dependency gates;
- version `1.2.17`, one Task 15 commit, the initial five-section scratch report, and a clean worktree.

The implementation worker does not tag, push, merge `main`, call GitHub, download artifacts, launch Chrome, run the final matrix, create a release, or perform network/Drive actions. It hands the full commit hash to the root controller for independent review.

### Root controller owns

After independent code/spec review, the root controller owns branch integration, the final exact-commit local rerun, tag/push, GitHub Actions wait, artifact download/inspection, the eleven-row exact-package matrix, failure routing/version advancement, release creation, remote verification, final scratch-report completion, and guarded cleanup.

If integration creates a merge commit rather than a fast-forward, that merge commit becomes the release commit only after all local gates are rerun on it. Never tag a different commit from the one pushed to `main` and submitted to CI.

## Required files and hard scope boundary

Create:

- `docs/guides/real-chrome-smoke-matrix.md`

Complete:

- `docs/reports/2026-07-14-reliability-smoke.md`

Modify only:

- `package.cmd`
- `.github/workflows/ci.yml`
- `README.md`
- `GUIDE.md`
- `ARCHITECTURE.md`
- `PRIVACY.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- the Task 15 checklist in the approved plan

Do not modify runtime JavaScript, tests from earlier tasks, manifest permissions/OAuth IDs, icons, store assets, accepted ADRs, provider behavior, schemas, UI behavior, or any finding implementation merely to make the matrix convenient. A matrix failure goes back to its owning task and consumes a new patch version. Do not add package metadata, a lockfile, dependency, bundler, generated runtime file, production failure hook, test credential, or hidden matrix bypass.

The repository smoke report consolidates already collected Task 2-14 evidence and the commit each row tested. The post-push exact-artifact matrix cannot be appended to a tracked file without changing the tested commit. Preserve final artifact results in the controller scratch report and local release-notes file; if a tracked correction is required, make a new commit/version and restart the complete CI/artifact/matrix chain.

## Strict packaging RED-GREEN sequence

Packaging and CI are executable release logic. Do not edit `package.cmd` or the workflow until the current packager has produced genuine RED evidence in a disposable copy.

1. Verify the Task 14 worktree is clean and record the exact base hash/version.
2. Create a guarded disposable copy under `/tmp/tabkebab-package-red.*` from `git archive HEAD`; never test mismatch/destructive cases in the repository.
3. In Windows interop, run the current `package.cmd` in that copy. Preserve two decisive RED cases:
   - change only the disposable `VERSION` so it differs from `manifest.json` and prove the current script still succeeds or otherwise fails to enforce parity;
   - inspect the produced zip and prove the current recursive negative-exclusion packager includes top-level entries outside the five-item release allowlist.
4. Remove the disposable RED copy only after guarding that its resolved path begins `/tmp/tabkebab-package-red.`. Record command, exit code, archive entry set, and cleanup; do not retain the zip as a release artifact.
5. If Windows interop/PowerShell cannot execute, report that concrete blocker before changing the packager. Static inspection alone is not the required RED.
6. Implement the minimum package/workflow slice, then rerun both disposable mismatch/missing-entry cases and the valid repository case. Mismatch and missing allowlisted input must now fail nonzero; valid input must produce exactly one conforming zip.

No Bun test is invented to simulate `cmd.exe` or PowerShell. Windows execution is the authority for the batch packager; Bun remains the authority for extension logic.

## Fixed `package.cmd` contract

Rewrite the batch file around:

```bat
@echo off
setlocal EnableExtensions EnableDelayedExpansion
```

The script must:

1. Run from the repository root and require `VERSION`, `manifest.json`, `service-worker.js`, `core\`, `sidepanel\`, and `icons\`.
2. Read `VERSION` as the trimmed source of truth. Parse `manifest.json` with PowerShell and fail nonzero unless its version equals `VERSION` exactly. There is no hardcoded version or fallback if PowerShell is unavailable.
3. Accept only a plain semantic version suitable for `tabkebab-<version>.zip`; reject empty/newline/path-separator/metacharacter values before constructing paths.
4. Create a unique staging directory beneath the Windows temporary directory, not inside the repository.
5. Copy exactly these top-level entries while preserving relative layout:
   - `manifest.json`
   - `service-worker.js`
   - `core\`
   - `sidepanel\`
   - `icons\`
6. Use a positive allowlist. Do not recursively enumerate the repository and subtract exclusions.
7. Create only `dist\tabkebab-!VERSION!.zip` from the staging directory's contents, so the archive root contains those five entries rather than a staging-folder wrapper. Remove stale `dist\tabkebab-*.zip` outputs without deleting unrelated files.
8. Reject a missing/empty allowlisted entry and propagate copy/compression/PowerShell failures.
9. Remove staging on every success/failure path, preserve the primary nonzero exit code, and leave no temporary tree.
10. Print only version, allowlisted file count, output path, and size. Remove Chrome Web Store upload instructions from executable output and never print file contents.

After a valid local package run, inspect its archive entry set and packaged manifest version, record the result, then remove the generated local `dist` zip before the implementation handoff. A local package is test evidence, not the release artifact.

## Fixed GitHub Actions package job

Preserve the existing Linux `test` job, its triggers, pinned Bun setup, and command order. Add one `package` job with:

- `runs-on: windows-latest`;
- `needs: test` so no artifact is built/uploaded after a failed test gate;
- `actions/checkout@v4`;
- a PowerShell step with `id: version` that trims `VERSION` into `$version` and writes `value=$version` to `$env:GITHUB_OUTPUT`;
- `cmd /c package.cmd`;
- a fresh temporary expansion directory;
- exact assertion that the unique zip is `dist/tabkebab-$version.zip`;
- exact sorted top-level set equality with `manifest.json`, `service-worker.js`, `core`, `sidepanel`, and `icons`;
- assertion that the packaged manifest version equals `VERSION`;
- `actions/upload-artifact@v4` with:

```yaml
name: tabkebab-extension-${{ steps.version.outputs.value }}
path: dist/tabkebab-${{ steps.version.outputs.value }}.zip
if-no-files-found: error
```

Do not upload the staging tree, repository, multiple zips, source docs, tests, or coverage. The package job produces one artifact from the same commit whose Linux job passed.

## Reproducible matrix guide

`docs/guides/real-chrome-smoke-matrix.md` is an operator runbook, not a success claim. Every row contains:

- prerequisites and exact source/artifact identity checks;
- disposable setup commands;
- production action;
- expected assertion and observable failure;
- redacted evidence fields;
- exact teardown and post-cleanup assertions.

The guide sources the secure release-state file created by the controller and appends every fixture/Chrome/Xvfb process PID to `matrix_pid_file` as one numeric PID per line. Steps may run in fresh shells; no required identity/path/PID exists only in shell history.

Use these exact disposable profile constructors where two profiles are required:

```bash
profile_a="$(mktemp -d /tmp/tabkebab-smoke-a.XXXXXX)"
profile_b="$(mktemp -d /tmp/tabkebab-smoke-b.XXXXXX)"
```

For Drive deletion convergence, A and B are distinct user-data directories/operator labels but must authenticate the same Google account and intentionally use the same uniquely named throwaway `driveProfileName`/Drive folder. The earlier plan phrase “distinct profile names” means distinct browser profile labels, not distinct Drive folder names; distinct Drive folders never exchange the canonical document and would be false convergence evidence. Baseline-sync both before deletion, then run A delete -> A sync -> B sync -> A sync and require absence on both with the retained tombstone.

The exact CI artifact is loaded from `unpacked_dir`. Never load the repository/worktree and call that artifact evidence. If the random unpacked path produces an extension ID that the registered development OAuth client cannot authorize, record the exact OAuth/extension-ID blocker and do not substitute the repository path or claim the Drive row passed. Any remedy requiring manifest key/OAuth configuration is a direction change for Michel/controller, not an improvised Task 15 edit.

## Eleven-row exact-package matrix

All rows must pass against one release commit, one package SHA-256, and the expanded unique CI zip:

1. Complete and forced-partial stash restoration, including retained recoverable source and exact counts.
2. Session/stash audio safety before and after discard, including visible-tab unmuted state.
3. Focus pause/end during delayed classification, strict-empty behavior, exact URL matching, and exact-title group rebinding after restart.
4. Duplicate cleanup/Undo with ordinary URLs and distinct hash-route URLs.
5. Natural-language close preview with exact/subdomain acceptance and lookalike rejection.
6. Drive v1 migration, shared-scope two-profile deletion convergence, canonical/newest retention, and full portable export/import. Automated injected tests remain rollback-failure authority.
7. Passphrase unlock after a complete Chrome process restart, wrong/right passphrase behavior, and zero secret disclosure.
8. Chrome AI with the panel open, panel disconnect/cancel, reconnect, and background closed-panel safe skip in a supported browser/model.
9. HTTP Custom-provider timeout using the committed CORS hanging fixture and unchanged 120-second production timeout; require one aborted request, zero active, and `maxActive === 1` before explicit retry.
10. Forced background error using a clean profile with `driveSync.connected = true` but no `driveProfileName`, then manual cleanup; require checked failure, no success toast, and no optimistic mutation.
11. Ctrl+K returning open tabs, stashes, and sessions, while valid empty and unavailable states remain distinct.

Each row records Chrome version/binary hash, OS, release commit, package SHA-256, disposable profile paths, setup/action, expected/actual, pass/fail, redacted evidence, and cleanup. Never record browsing history, API keys/passphrases, OAuth/access tokens, authorization headers, prompts containing private data, private Drive bodies, or raw portable payloads.

Prompt API availability, registered OAuth compatibility, and the unchanged 120-second timeout are real release gates. An unsupported browser/model, OAuth rejection, fixture/CORS failure, or timed-out matrix infrastructure is a blocker, not permission to replace the row with mocks or shorten production behavior.

## Implementation-stage local gates and commit

Before version/doc edits, run the full current suite as a baseline. After package/CI/docs changes, set both version files to `1.2.17` and run all gates again:

```bash
bun --version
bun test
bun test --coverage
bun test tests/syntax.test.js
git diff --check
test "$(cat VERSION)" = "$(bun -e 'console.log((await Bun.file("manifest.json").json()).version)')"
test -z "$(find . -maxdepth 1 -type f \( -name 'package.json' -o -name 'package-lock.json' -o -name 'bun.lock' -o -name 'bun.lockb' -o -name 'yarn.lock' -o -name 'pnpm-lock.yaml' \) -print)"
git status --short
```

Bun remains `1.3.11`; full/coverage/syntax gates pass; whitespace is clean; versions both equal `1.2.17`; no root package/lockfile exists. Review coverage by changed/owning module and link every specification success/failure path to a named test; do not substitute a repository-wide percentage.

Update docs before the commit:

- `README.md` and `CONTRIBUTING.md`: pinned Bun workflow, CI test/package jobs, and artifact boundary.
- `GUIDE.md`: recoverable restores, exact Focus/URL/group semantics, Drive v2/retention, portable v2, passphrase unlock, checked errors/search, Chrome AI foreground requirement, and abort-before-retry.
- `ARCHITECTURE.md`: final contracts and exact-package verification.
- `PRIVACY.md`: no telemetry/secrets in exports/evidence and local/cloud provider boundaries.
- `CHANGELOG.md`: final release notes for the shipped behavior, not unverified performance claims.
- `PROGRESS.md`: all thirteen findings linked to named automated tests and committed per-slice smoke rows; state that final artifact publication remains gated on the controller matrix until it actually passes.
- `docs/reports/2026-07-14-reliability-smoke.md`: consolidate Task 2-14 rows/commits, blockers, and cleanup without claiming the not-yet-run artifact matrix passed.

Write the initial five-section `task-15-report.md` with packaging RED/GREEN, local gates, docs/evidence inventory, assumptions/risks, model ledger, exact version, and implementation commit. Commit only approved Task 15 files with author email `29182417+michelabboud@users.noreply.github.com` and trailer `Co-Authored-By: Codex <noreply@openai.com>`. The implementation worker leaves the worktree clean and reports the full hash.

## Controller integration, tag, and exact-CI gate

After independent review, the root controller integrates the Task 15 commit into `main`, reruns the local gates above on the resulting exact commit, and verifies clean status. Then:

1. Set `commit="$(git rev-parse HEAD)"` and require it is the reviewed, locally verified `main` commit.
2. Create the immutable `v1.2.17` tag from `VERSION`, push `main` and that tag, and never move it.
3. Wait for the exact commit's workflow, require both `test` and dependent Windows `package` jobs to succeed, and generate a mode-0600 release-state file:

```bash
commit="$(git rev-parse HEAD)"
deadline=$((SECONDS + 600))
run_json='[]'
while (( SECONDS < deadline )); do
  run_json="$(gh run list --workflow .github/workflows/ci.yml --commit "$commit" --limit 1 --json databaseId,headSha,status,conclusion,url)"
  test "$(jq 'length' <<<"$run_json")" -gt 0 && break
  sleep 10
done
test "$(jq 'length' <<<"$run_json")" -eq 1
test "$(jq -r '.[0].headSha' <<<"$run_json")" = "$commit"
run_id="$(jq -r '.[0].databaseId' <<<"$run_json")"
test -n "$run_id"
gh run watch "$run_id" --exit-status
release_version="$(cat VERSION)"
[[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
release_state="/tmp/tabkebab-release-state-$release_version.env"
rm -f -- "$release_state"
umask 077
{
  printf 'release_version=%q\n' "$release_version"
  printf 'release_commit=%q\n' "$commit"
  printf 'run_id=%q\n' "$run_id"
} > "$release_state"
test -O "$release_state"
test "$(stat -c '%a' "$release_state")" = 600
```

No GitHub release exists yet. A tag is a checkpoint; matrix failure leaves it immutable and consumes the next patch version.

## Exact artifact download and inspection

Download only the exact run's named artifact, require one zip, expand it to a fresh path, and carry every path through the secure state file:

```bash
current_version="$(cat VERSION)"
release_state="/tmp/tabkebab-release-state-$current_version.env"
test -O "$release_state"
test "$(stat -c '%a' "$release_state")" = 600
# shellcheck disable=SC1090 -- generated above with printf %q and mode 0600
source "$release_state"
test "$release_version" = "$current_version"
test "$release_commit" = "$(git rev-parse HEAD)"
artifact_dir="$(mktemp -d "/tmp/tabkebab-release-$release_version.XXXXXX")"
unpacked_dir="$(mktemp -d "/tmp/tabkebab-unpacked-$release_version.XXXXXX")"
notes_file="/tmp/tabkebab-release-notes-$release_version.md"
matrix_pid_file="/tmp/tabkebab-matrix-pids-$release_version.txt"
rm -f -- "$notes_file" "$matrix_pid_file"
: > "$notes_file"
: > "$matrix_pid_file"
chmod 600 "$notes_file" "$matrix_pid_file"
gh run download "$run_id" --name "tabkebab-extension-$release_version" --dir "$artifact_dir"
mapfile -t downloaded_zips < <(find "$artifact_dir" -type f -name '*.zip' -print)
test "${#downloaded_zips[@]}" -eq 1
zip_path="${downloaded_zips[0]}"
unzip -q "$zip_path" -d "$unpacked_dir"
test -s "$unpacked_dir/manifest.json"
package_sha256="$(sha256sum "$zip_path" | awk '{print $1}')"
test -n "$package_sha256"
{
  printf 'artifact_dir=%q\n' "$artifact_dir"
  printf 'unpacked_dir=%q\n' "$unpacked_dir"
  printf 'notes_file=%q\n' "$notes_file"
  printf 'matrix_pid_file=%q\n' "$matrix_pid_file"
  printf 'zip_path=%q\n' "$zip_path"
  printf 'package_sha256=%q\n' "$package_sha256"
} >> "$release_state"
```

Before launching Chrome, independently require the expanded top-level entry set is exactly the five allowlisted entries, its manifest version equals `release_version`, no symlink/path traversal escaped `unpacked_dir`, and the zip contains no repository-only file. Record the package hash, not archive contents that expose user data.

## Matrix execution and failure policy

Run all eleven rows from the guide against `unpacked_dir`. Append every spawned PID before proceeding, use only disposable profile/data paths, and update `notes_file` plus `task-15-report.md` after each row. Poll long-running operations often enough to report status; no fixture/browser runs silently.

If any row fails:

1. Do not create a GitHub release or mark the initiative published.
2. Stop/clean every owned process/profile/fixture/Drive artifact using the guide.
3. Preserve redacted failure evidence and route the defect to its owning task.
4. Implement/review a real fix, advance both versions to the next patch, commit/tag/push without moving the prior tag, and restart exact-commit CI, artifact download, and all eleven rows from the beginning.

No row is carried forward from a different artifact/commit after a fix.

## Release creation and remote verification

Only after all rows pass and cleanup of runtime profiles/fixtures is recorded:

1. Keep `artifact_dir`, `zip_path`, `notes_file`, `matrix_pid_file`, and `release_state` until the release and remote checks pass. `unpacked_dir` may be removed after Chrome closes, but its path remains guarded.
2. Complete `notes_file` with design/ADR links, named tests, repository smoke report, exact commit/run/package hash, eleven-row table, dependency-audit status, and teardown evidence.
3. Create one non-draft, non-prerelease GitHub release targeted to the exact SHA and attach the verified zip:

```bash
current_version="$(cat VERSION)"
release_state="/tmp/tabkebab-release-state-$current_version.env"
test -O "$release_state"
test "$(stat -c '%a' "$release_state")" = 600
source "$release_state"
test "$release_version" = "$current_version"
test "$release_commit" = "$(git rev-parse HEAD)"
test -s "$notes_file"
test -s "$zip_path"
gh release create "v$release_version" --target "$release_commit" --notes-file "$notes_file" "$zip_path"
```

4. Verify remote `main`, dereferenced/fallback tag, release flags/target/URL, and attached asset name:

```bash
current_version="$(cat VERSION)"
release_state="/tmp/tabkebab-release-state-$current_version.env"
test -O "$release_state"
test "$(stat -c '%a' "$release_state")" = 600
source "$release_state"
test "$release_version" = "$current_version"
test "$release_commit" = "$(git rev-parse HEAD)"
git fetch origin main --tags
remote_main="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
remote_tag="$(git ls-remote origin "refs/tags/v$release_version^{}" | awk '{print $1}')"
if test -z "$remote_tag"; then
  remote_tag="$(git ls-remote origin "refs/tags/v$release_version" | awk '{print $1}')"
fi
test "$remote_main" = "$release_commit"
test "$remote_tag" = "$release_commit"
release_json="$(gh release view "v$release_version" --json tagName,targetCommitish,url,isDraft,isPrerelease,assets)"
test "$(jq -r .tagName <<<"$release_json")" = "v$release_version"
test "$(jq -r .targetCommitish <<<"$release_json")" = "$release_commit"
test "$(jq -r .isDraft <<<"$release_json")" = false
test "$(jq -r .isPrerelease <<<"$release_json")" = false
asset_name="$(basename "$zip_path")"
test "$(jq --arg name "$asset_name" '[.assets[] | select(.name == $name)] | length' <<<"$release_json")" -eq 1
git status --short --branch
```

Do not upload or publish to the Chrome Web Store.

## Guarded final cleanup

Stop all owned processes before file cleanup. The PID ledger contains numeric owned PIDs only; the final check fails rather than killing an unrecognized still-live process.

```bash
current_version="$(cat VERSION)"
release_state="/tmp/tabkebab-release-state-$current_version.env"
test -O "$release_state"
test "$(stat -c '%a' "$release_state")" = 600
source "$release_state"
for disposable_dir in "$artifact_dir" "$unpacked_dir"; do
  case "$disposable_dir" in
    /tmp/tabkebab-*) ;;
    *) echo "Refusing unsafe cleanup path: $disposable_dir" >&2; exit 1 ;;
  esac
done
while IFS= read -r pid; do
  [[ "$pid" =~ ^[0-9]+$ ]] || { echo "Invalid PID ledger entry" >&2; exit 1; }
  if kill -0 "$pid" 2>/dev/null; then
    echo "Matrix process still alive: $pid" >&2
    exit 1
  fi
done < "$matrix_pid_file"
rm -rf -- "$artifact_dir" "$unpacked_dir"
rm -f -- "$notes_file" "$matrix_pid_file" "$release_state"
```

Every disposable Chrome profile, fixture file, credential, Drive artifact/folder, Xvfb listener, and CDP endpoint has its own guarded cleanup in the matrix guide before this final release-state cleanup. Never add the repository, parent checkout, a non-disposable browser profile, or an unowned process to cleanup variables.

## Documentation, final report, and dependency status

The root controller completes `task-15-report.md` in five sections only after remote verification and cleanup:

1. What was built and published.
2. Fresh local/CI/package/matrix/release evidence with exact counts, run/release URLs, SHA, package hash, and model ledger.
3. Assumptions and environment interpretations, including shared Drive scope.
4. Concerns/blockers/adjacent observations without smoothing over unsupported boundaries.
5. Close-out confirmation: docs/version/commit/tag/main/release/asset verified, dependency audit status, all processes/data cleaned, and no Chrome Web Store action.

Dependency audit is exactly “not applicable” only after the root package/lockfile check remains empty and no production dependency was added. GitHub Actions used for checkout/Bun/artifact upload do not create a runtime package manifest.

## Approved checklist (complete Task 15 intent)

- The implementer starts from the controller-supplied reviewed Task 14 hash; earlier phase releases and Task 13/14 checkpoints are confirmed.
- Current packaging first produces genuine disposable Windows RED for version mismatch/extra entries; the new packager fails closed and cleans staging.
- The zip contains exactly `manifest.json`, `service-worker.js`, `core`, `sidepanel`, and `icons` at root, with exact version parity and no repository-only files.
- Windows CI packaging depends on the passing Linux test job, validates the unique zip, and uploads the exact versioned artifact through `actions/upload-artifact@v4`.
- The operator guide makes all eleven rows reproducible across fresh shells, tracks every PID, uses guarded disposable paths, and defines assertion/evidence/cleanup.
- Two-profile Drive uses distinct browser profiles but one account/shared throwaway Drive scope; no false convergence across separate folders is claimed.
- Tracked smoke/docs consolidate Task 2-14 evidence without claiming a not-yet-run artifact matrix.
- Local Bun/coverage/syntax/whitespace/version/dependency gates pass at `1.2.17` before the implementation commit and again on the integrated release commit.
- Root controller alone tags/pushes, requires exact-commit CI, downloads one exact artifact, verifies hash/contents/version, and loads Chrome only from `unpacked_dir`.
- All eleven rows pass on the same commit/package or no release is created; any failure consumes a new patch version and restarts the whole chain.
- Release notes contain redacted exact-package evidence and teardown; GitHub release, remote main/tag/target/asset/flags, and clean status are verified.
- All fixtures, Chrome/Xvfb/CDP processes, profiles, credentials, Drive artifacts, artifact directories, notes, PID/state files, and listeners are safely removed.
- No runtime feature drift, dependency, build/bundler, OAuth/manifest-key workaround, history rewrite, tag move, Chrome Web Store action, or false completion claim is included.
