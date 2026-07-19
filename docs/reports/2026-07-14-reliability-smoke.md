# Reliability Hardening Smoke Evidence

Date: 2026-07-14

Slice: Task 2, complete-or-recoverable session and stash restoration

Extension version: `1.2.4`

## Browser boundary

The first attempt used the requested installed browser:

```text
Google Chrome 148.0.7778.178
xvfb-run -a /usr/bin/google-chrome \
  --no-first-run --no-default-browser-check \
  --user-data-dir=/tmp/tabkebab-task2-xvfb.[redacted] \
  --disable-extensions-except=/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening \
  --load-extension=/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening \
  --remote-debugging-port=0 about:blank
```

Google Chrome started, but its DevTools targets and disposable profile did not register TabKebab. The only extension targets belonged to a bundled Google component; requesting the known development extension URL produced an error page. No application claim was inferred from that run.

The successful fallback used the already-installed official Chrome for Testing build at the same browser major:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
xvfb-run -a -f /tmp/tabkebab-task2-final.[redacted]/Xauthority \
  /home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  --no-first-run --no-default-browser-check \
  --user-data-dir=/tmp/tabkebab-task2-final.[redacted] \
  --disable-extensions-except=/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening \
  --load-extension=/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening \
  --remote-debugging-port=0 about:blank
```

The driver discovered the unpacked extension's generated ID from its service-worker target, opened the real side-panel document, and used the Chrome DevTools Protocol to run synthetic restore messages in that extension context. No production failure hook, DOM shim, IndexedDB shim, package, or build step was used.

## Redacted results

The session fixture contained two synthetic HTTPS tabs and used `mode: "single-window"` with `discarded: false`.

```json
{
  "requestedCount": 2,
  "restoredCount": 2,
  "skippedDuplicate": 0,
  "skippedInvalid": 0,
  "errorCount": 0,
  "complete": true,
  "windowsCreated": 1,
  "restoredTabCount": 2,
  "activeTabPresent": true,
  "activeTabMuted": false,
  "everyRestoredTabUnmuted": true,
  "everyRestoredTabNotDiscarded": true
}
```

The stash fixture contained one synthetic HTTPS tab and one forbidden Chrome URL. Delete-after-restore was explicitly requested.

```json
{
  "requestedCount": 2,
  "restoredCount": 1,
  "skippedDuplicate": 0,
  "skippedInvalid": 1,
  "errorCount": 0,
  "complete": false,
  "retained": true,
  "unchanged": true
}
```

The synthetic page was silent, so the audio-safety assertion is Chrome's authoritative tab mute state (`mutedInfo.muted === false`), not an unsupported claim that sound was actively playing.

## Cleanup

The successful run reported:

```text
DISPOSABLE_PROFILE_ENTRIES_BEFORE_CLEANUP=283
CLEANUP_PROFILE_REMOVED=1
CLEANUP_CHROME_PROCESSES=0
CLEANUP_XVFB_PROCESSES=0
```

An earlier failed driver attempt also had its uniquely named profile audited and removed separately; it left zero matching Chrome or Xvfb processes. No browser process, X server, or disposable profile was left running.

---

Slice: Task 3, unified Focus allowlist policy

Extension version: `1.2.5`

## Task 3 browser boundary

The Focus smoke used the same installed Chrome for Testing binary already accepted for the reliability campaign:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
Xvfb :[redacted] -screen 0 1280x900x24 -nolisten tcp
/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  --user-data-dir=/tmp/tabkebab-task3-focus.[redacted] \
  --disable-extensions-except=/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening \
  --load-extension=/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening \
  --remote-debugging-port=0 --no-first-run --no-default-browser-check about:blank
```

The driver opened the real side-panel document for the unpacked extension, sent the production runtime actions, and inspected Chrome's real tab, tab-group, and extension-storage APIs. It then cleanly stopped Chrome and launched the same binary, extension path, and disposable profile again. That browser restart forced a cold extension/service-worker reload before the group-rebinding check.

Earlier harness-development attempts that selected a bundled component worker, tried a dynamic import inside a service worker, depended on unflushed live Preferences, or called `chrome.runtime.reload()` on the command-line-loaded unpacked extension were treated as non-evidence. Each failed attempt used a uniquely named Task 3 profile and reported that its profile, matching Chrome processes, and Xvfb process were removed before the next attempt.

## Task 3 redacted results

Before the browser restart, strict mode with an empty allowlist reported zero focus tabs and removed a newly opened non-internal URL. With one canonical exact URL allowed, the exact URL remained open while a path-prefix extension was removed.

```json
{
  "strictEmpty": {
    "focusTabCount": 0,
    "navigationRejected": true
  },
  "exactUrl": {
    "exactTabRemained": true,
    "prefixNavigationRejected": true
  }
}
```

The pre-restart fixture stored a paused run with a deliberately stale numeric group ID and title-only profile preferences. After the restart, cold worker initialization removed the scalar ID and resolved the runtime ID list to empty instead of trusting the stale value. The driver then created two current Chrome groups with the same exact title and resumed the run. Resume rebound that title to both and only the current live IDs; the profile preference remained title-only.

```json
{
  "groupRebind": {
    "liveGroupCount": 2,
    "startupRuntimeIdCount": 0,
    "startupStaleScalarRemoved": true,
    "runtimeGroupIdCount": 2,
    "runtimeIdsMatchLiveIds": true,
    "staleScalarRemoved": true,
    "staleRuntimeIdTrusted": false,
    "profilePreferencesTitleOnly": true
  }
}
```

## Task 3 cleanup

The successful two-phase run reported:

```text
SEED_EXIT=0
VERIFY_EXIT=0
CLEANUP_PROFILE_REMOVED=1
CLEANUP_CHROME_PROCESSES=0
CLEANUP_XVFB_PROCESSES=0
```

The driver also removed the two current grouped fixture tabs before the browser profile was deleted. No Task 3 browser process, X server, or disposable profile was left running.

---

Slice: Task 4, run-bound asynchronous Focus lifecycle

Extension version: `1.2.6`

## Task 4 browser and provider boundary

The delayed-classification smoke used the installed official Chrome for Testing build and the actual unpacked extension:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
Xvfb :[redacted] -screen 0 1280x900x24 -nolisten unix -listen tcp -ac
DISPLAY=127.0.0.1:[redacted].0
/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  --user-data-dir=/tmp/tabkebab-task4-focus.[redacted] \
  --disable-extensions-except=/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening \
  --load-extension=/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening \
  --remote-debugging-port=0 --remote-allow-origins=* \
  --no-first-run --no-default-browser-check about:blank
```

The driver discovered and attached to the production Manifest V3 service worker, enabled CDP Fetch interception on its OpenAI-compatible custom-provider request, and held each `/v1/chat/completions` request until the tested state or URL transition was durably observable. It then fulfilled the request with a synthetic high-confidence JSON decision (`distraction: true`, confidence `0.99`). Pause, same-run Pause→Resume, End, replacement Pause, and final cleanup commands supplied the exact `expectedRunId` returned by the preceding live `startFocus`/`getFocusState` response. No API key or external provider response was used.

This is deliberately CDP-synthetic provider evidence. It validates the real service worker, AI client/provider request path, Chrome storage events, runtime messages, action badge, tab history, and tab side-effect boundary. It does not validate external provider availability, authentication, latency, or classification quality.

Each case used a unique classified host and a tab with an earlier synthetic HTTPS history entry. That made either stale `goBack()` or fallback removal observable. The end case established and paused a replacement run before releasing the old run's response. The navigation-away case moved to an exact allowlisted URL before release so it did not generate a second provider request.

## Task 4 redacted results

```json
{
  "pause": {
    "requestHeld": true,
    "runPreserved": true,
    "status": "paused",
    "tabExists": true,
    "classifiedUrlPreserved": true,
    "distractionsBlocked": 0,
    "badgeText": "||",
    "staleEventCount": 0
  },
  "endAndReplacement": {
    "requestHeld": true,
    "endedRunRecorded": true,
    "replacementPreserved": true,
    "replacementStatus": "paused",
    "tabExists": true,
    "classifiedUrlPreserved": true,
    "replacementDistractionsBlocked": 0,
    "badgeText": "||",
    "staleEventCount": 0
  },
  "pauseResume": {
    "requestHeld": true,
    "runPreserved": true,
    "status": "active",
    "tabExists": true,
    "classifiedUrlPreserved": true,
    "distractionsBlocked": 0,
    "badgeText": "25m",
    "staleEventCount": 0
  },
  "navigateAway": {
    "requestHeld": true,
    "runPreserved": true,
    "status": "active",
    "tabExists": true,
    "newUrlPreserved": true,
    "distractionsBlocked": 0,
    "badgeText": "25m",
    "staleEventCount": 0
  }
}
```

All four released high-confidence decisions were no-ops. The same-run Pause→Resume case specifically proves a delayed classification cannot regain authority merely because the run is active again. No tab moved backward or was removed, no distraction counter changed, no stale distraction/end runtime event reached the open side panel, and no old response repainted the replacement badge.

## Task 4 cleanup

The final exact-tree rerun after lifecycle-command, classification-generation, restore-recovery, and group-ownership hardening reported:

```text
DISPOSABLE_PROFILE_ENTRIES_BEFORE_CLEANUP=287
CLEANUP_PROFILE_REMOVED=1
CLEANUP_CHROME_PROCESS_EXITED=1
CLEANUP_XVFB_PROCESS_EXITED=1
POST_CLEANUP_MATCHING_PROFILE_PATHS=0
POST_CLEANUP_MATCHING_CHROME_OR_XVFB_PROCESSES=0
POST_CLEANUP_XVFB_TCP_LISTENERS=0
```

An earlier harness attempt could not bind a Unix X socket because the host's shared `/tmp/.X11-unix` directory mode was not `1777`; it reached no Chrome or application boundary and supplied no evidence. Its uniquely named empty profile and Xvfb process were removed before the successful loopback-TCP Xvfb run. No Task 4 Chrome process, X server, listener, or disposable profile was left running.

This rerun covered repair commit `9dc947050c6b5dca1aac612db22560c65e5eba4b`. The subsequent independent-review repair is limited to injected Chrome-group metadata, rollback, session-cleanup, and local-authority-write failure branches; it does not change the successful delayed-classification path above. Per controller direction, Chrome was not relaunched for those synthetic failure branches; deterministic Chrome-mock tests verify their tab mutation, cache, storage, and aggregate-error outcomes.

---

Slice: Task 5, exact host identity and lossless duplicate Undo

Extension version: `1.2.7`

## Task 5 browser and provider boundary

The Task 5 smoke used the installed official Chrome for Testing build and the actual unpacked extension:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
Xvfb :[redacted] -screen 0 1280x900x24 -nolisten unix -listen tcp -ac
DISPLAY=127.0.0.1:[redacted].0
/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  --user-data-dir=/tmp/tabkebab-task5.[redacted] \
  --disable-extensions-except=/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening \
  --load-extension=/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening \
  --remote-debugging-port=0 --remote-allow-origins=* \
  --no-proxy-server --ignore-certificate-errors --allow-insecure-localhost \
  --host-resolver-rules=[five exact synthetic hosts mapped to 127.0.0.1] \
  --no-first-run --no-default-browser-check about:blank
```

A disposable Bun HTTPS fixture listened only on `127.0.0.1` with a one-run self-signed certificate. Exact fixture host mappings sent `github.com`, `docs.github.com`, `notgithub.com`, `github.com.evil.test`, and `app.test` to that loopback server without using the public network. The production custom-provider request received an explicitly synthetic OpenAI-compatible parsed close command for `{ domain: "github.com" }`; no credential or external model was used.

The harness opened the production `sidepanel/panel.html` document as an extension tab through CDP; it did not invoke Chrome's side-panel host container. This validates the real Manifest V3 worker, AI client/custom-provider request, natural-language preview, Chrome tab APIs, production duplicate-panel DOM/events, close, toast callback, and reopen boundary. It does not validate side-panel host-container behavior, external-provider availability, authentication, latency, or command quality.

The final recorded run loaded the exact `1.2.7` bytes after the pre-commit repair that makes destructive title predicates fail closed while a destination URL is pending. The worker-level regression directly exercises that stale-title branch; this browser rerun confirms the repaired final tree still passes the bounded production preview/UI/tab boundary.

## Task 5 redacted results

The natural-language close preview contained only the exact host and true subdomain fixture IDs:

```json
{
  "exactAccepted": true,
  "subdomainAccepted": true,
  "suffixLookalikeRejected": true,
  "siblingLookalikeRejected": true,
  "previewCount": 2
}
```

The production Duplicates sub-tab in that panel document and an explicit **Scan for Duplicates** click produced three independent groups: one ordinary URL, `#/one`, and `#/two`. Each group began with exactly two tabs and one selected duplicate. Its production **Close All Duplicates** control reduced every exact URL count to one, and the eight-second **Undo** toast restored every count to two:

```json
{
  "groupCount": 3,
  "selectedDuplicateCount": 3,
  "countsAfterClose": {
    "ordinary": 1,
    "routeOne": 1,
    "routeTwo": 1
  },
  "countsAfterUndo": {
    "ordinary": 2,
    "routeOne": 2,
    "routeTwo": 2
  }
}
```

Two inactive `chrome://newtab/` tabs remained live throughout the scan, close, and Undo. Neither ID appeared in the direct duplicate groups, direct empty-page result, or selected UI IDs; the Empty Pages row remained hidden with count zero.

## Task 5 cleanup

The harness itself reported:

```text
DISPOSABLE_PROFILE_ENTRIES_BEFORE_CLEANUP=247
CLEANUP_PROFILE_REMOVED=1
CLEANUP_TLS_REMOVED=1
CLEANUP_CHROME_PROCESS_EXITED=1
CLEANUP_XVFB_PROCESS_EXITED=1
```

A separate post-run host audit checked the disposable `/tmp/tabkebab-task5.*` paths, matching Chrome/Xvfb process command lines, and the claimed Xvfb TCP port with `find`, `ps`, and `ss`. It reported:

```text
POST_CLEANUP_MATCHING_PROFILE_PATHS=0
POST_CLEANUP_MATCHING_CHROME_OR_XVFB_PROCESSES=0
POST_CLEANUP_XVFB_TCP_LISTENERS=0
```

The one-run TLS key/certificate directory, browser profile, Chrome process, Xvfb process, and transient loopback display listener were removed. No browser, display server, fixture server, credential, or disposable profile remained.

---

Slice: Task 6, fail-closed Drive retention

Extension version: `1.2.8`

## Task 6 deterministic evidence

The focused test-first run against the Task 5 tree failed as expected:

```text
bun test tests/core/drive-retention.test.js tests/integration/drive-cleanup.test.js
1 pass
20 fail
8 expect() calls
```

The failures exposed the missing retention/formatter modules, unscoped first-page-only inventory, repeated-token acceptance, stale profile cache, swallowed JSON and raw-HTML archive failures, duplicated broad cleanup loops, absent strict guards/day validation, and unchecked SettingsManager responses.

The final focused run reported:

```text
bun test tests/core/drive-retention.test.js tests/integration/drive-cleanup.test.js
40 pass
0 fail
324 expect() calls
```

Coverage includes all 11 bounded normal/archive categories, exact embedded calendars/times/milliseconds and wrong scopes, every newest tie, offset-equivalent timestamps, cutoff equality, stable ordering and duplicate IDs, canonical/undated/malformed protection, complete paginated inventory, ambiguous and corrupted Drive state, zero-delete failure paths, partial deletion, actual scheduled/manual entry points, checked SettingsManager feedback, stale-profile prevention, and archive-before-overwrite failure.

The final repository gates reported:

```text
bun test
274 pass, 0 fail, 1170 expect() calls

bun test --coverage
274 pass, 0 fail, 1170 expect() calls
all files: 42.52% functions, 47.01% lines
core/drive-retention.js: 100.00% functions, 98.17% lines

bun test tests/syntax.test.js
2 pass, 0 fail, 84 expect() calls

git diff --check
exit 0
```

## Task 6 real Chrome/Drive boundary

**BLOCKED — no live Drive claim was made.** The credential-safe preflight could not establish the prerequisite disposable OAuth boundary:

- the repository documents development extension ID `hkhlbjmokednepfjmnlglapgppfdpmck` and development OAuth client `873809052111-tpog62t7mm16qlmc85j63ke91l50c2s7.apps.googleusercontent.com`; neither is absent;
- the exact Task 6 `manifest.json` instead contains the production OAuth client and has no manifest `key` to pin an unpacked identity;
- a clean disposable Chrome/Xvfb load of this exact worktree observed the TabKebab service-worker ID as `fignfifoniblkonapihmkfakmlgkbkcf`, which matches neither the documented development ID nor published ID `cgfnjdcioainbclbbihglaopbhikhdob` and therefore has no matching documented OAuth client;
- the fresh disposable profile had no authenticated Google test-user session or credential-safe autonomous authorization procedure.

Because the observed unpacked identity did not match a registered identity/client pair and the profile was not authenticated, the run stopped before requesting or exposing a token, making a Drive call, creating a Drive profile, seeding files, changing `modifiedTime`, or invoking destructive cleanup. Synthetic `fetch` responses are retained only as deterministic adapter tests and are not represented as real-Drive evidence. The mandatory canonical/newest/undated live preservation fixture therefore remains pending.

Safe follow-up requires an approved registered environment and an operator-authenticated disposable test-user session, without transmitting credentials or tokens. A byte-exact gate can test a signed/published package built from the exact Task 6 bytes under the registered production identity/client. A development gate can instead use commit-exact production code with an explicit manifest-only overlay for the documented development identity/client, but its evidence must state that the resulting package is not byte-exact.

## Task 6 cleanup

The identity-only preflight launched a clean disposable Chrome/Xvfb profile, observed the service-worker ID, and then shut down. It requested no OAuth token and created no Drive folder or file. A post-run host process check found zero command lines matching the Task 6 disposable prefix. The profile contained no authenticated Google state, and no Drive artifact, fixture server, or display process remained to clean up.

## Task 6 release disposition

On 2026-07-19, the repository owner explicitly directed the controller to commit, tag, push, and publish `v1.2.8` without waiting for the blocked real Chrome/Drive fixture. The live gate remains unpassed and is not replaced by the deterministic adapter tests. The release proceeds on the independently reviewed focused, full, coverage, syntax, and diff evidence above; the credential-safe live fixture remains tracked as post-release validation.

---

Slice: Task 8, transactional session/manual-group deletion convergence

Extension version: `1.2.10`

## Task 8 preliminary real-Chrome local boundary

**PRELIMINARY AND SUPERSEDED — final-tree rerun pending.** This run exercised working tree `0ceb06691bf3968e738bd3e8b3eec3966e64ed59`. Reviewer-driven deterministic additions after that run expanded the resource-boundary and checked-panel coverage, so this evidence must not be represented as the exact final Task 8 tree.

The harness used the installed official Chrome for Testing build and the actual unpacked extension:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
extension ID: igggfmpiljhefkagnphadfadollcimlh
tested tree: 0ceb06691bf3968e738bd3e8b3eec3966e64ed59 (superseded)
final commit/tree: PENDING FINAL-TREE RERUN
```

The disposable profile opened the production side-panel document and exercised its checked controls, the real Manifest V3 worker, the FIFO mutation boundary, and `chrome.storage.local`. Fixture records contained only synthetic private-free values. Storage evidence recorded key names, change counts, and timestamp comparisons; it did not copy session payloads, private URLs, tombstone maps, or browsing history.

## Task 8 preliminary redacted results

```text
session Delete:
  sessions changes: 1
  driveSyncTombstones changes: 1
  deleted session copies after action: 0

session Undo:
  sessions changes: 1
  driveSyncTombstones changes: 0
  restored session copies after action: 1
  restored modifiedAt > retained tombstone: true
  retained tombstone unchanged: true

manual-group Delete:
  manualGroups changes: 1
  driveSyncTombstones changes: 1
  deleted group copies after action: 0

HTTP(S) requests observed: 0
liveDrivePassed: false
```

The local results prove that the preliminary tree supplied each deletion and its matching tombstone through the production panel/worker/storage boundary, while Undo restored exactly one strictly newer session and retained the existing convergence marker. Because no HTTP(S) request occurred, this run proves no remote synchronization or two-profile Drive convergence.

## Task 8 live Drive boundary

**BLOCKED — no live Drive claim was made.** The disposable unpacked extension ID `igggfmpiljhefkagnphadfadollcimlh` has no matching registered OAuth client, and the clean disposable profile had no operator-authenticated Google test-user session. The run therefore did not request or expose an OAuth token, issue a Drive request, create a throwaway Drive folder/file, or inspect a remote document. Deterministic two-profile merge tests establish the local merge truth table but are not substituted for the blocked live-Drive fixture.

Credential-safe follow-up still requires an approved registered identity/client environment and an operator-authenticated disposable Google test-user session. Both disposable browser profiles must use the same uniquely named throwaway Drive scope; distinct local profiles with distinct remote folders would not prove convergence.

## Task 8 preliminary cleanup

The harness shut down the disposable browser/display processes and removed its profile and temporary paths. Its cleanup counters and the post-run audit were all zero for remaining Task 8 resources:

```text
remaining disposable profile paths: 0
remaining matching Chrome processes: 0
remaining matching Xvfb processes: 0
remaining CDP listeners: 0
remaining temporary fixture paths: 0
remaining throwaway Drive artifacts: 0 (none were created)
```

No browser, display server, listener, fixture server, credential, temporary profile, or remote artifact was left running or stored.

## Task 8 completed functional-tree local evidence

After every production, test, user-documentation, and version change was present,
the controller reran the same fail-closed harness against exact tree
`7e1ab1c081a1bc3f4128903b1e924e803c5427a8`. The installed browser and unpacked
identity again matched the approved fixture:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
extension ID: igggfmpiljhefkagnphadfadollcimlh
tested tree: 7e1ab1c081a1bc3f4128903b1e924e803c5427a8
```

Every bounded assertion passed:

```text
session deletion absent after action: true
session tombstone safe integer: true
session collection+tombstone in one change event: true
session success rendered after commit: true
Undo restored exactly one session: true
Undo modifiedAt strictly newer than tombstone: true
Undo retained tombstone unchanged: true
Undo success rendered after commit: true
manual group absent after action: true
manual-group tombstone safe integer: true
manual-group collection+tombstone in one change event: true
manual-group success rendered after commit: true
extension HTTP(S) attempts intercepted before network: 0
external requests reaching network: 0
liveDrivePassed: false
```

The disposable profile contained 249 entries before removal. Harness cleanup
reported the profile removed and both Chrome and Xvfb exited. A separate host
audit then found zero matching profile/index paths, Chrome/Xvfb processes, or
TCP listeners on the disposable display port.

This result matches the earlier preliminary local evidence. An exact-tree review
then found that the session panel's existing `refresh()` catch swallowed a failed
post-commit projection, making the new deletion/Undo refresh-failure outcome
unreachable. The repair makes refresh return an explicit checked status and the
regression now exercises that production method instead of replacing it with a
rejecting stub. Because that is a runtime/test delta after tree `7e1ab1c...`, the
controller reruns the same bounded harness after the repair and records the exact
terminal tree and cleanup in the local Task 8 closeout report. Live Drive remains
blocked and unpassed; nothing in this row substitutes for two authenticated
profiles converging through one shared throwaway Drive scope.

---

Slice: Task 10, transactional portable export/import ownership

Extension version: `1.2.12`

## Task 10 real-Chrome portable-data boundary

The fail-closed harness uses the installed official Chrome for Testing build and
the actual unpacked extension:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
extension ID: igggfmpiljhefkagnphadfadollcimlh
```

In a disposable profile, it seeds synthetic records into the eight full-export
local-storage sections and the real `TabKebabStash` IndexedDB store. It clicks
the production Sessions **Export JSON** control, waits for Chrome's physical
download, parses that downloaded file outside the extension, recursively scans
every key, removes all affected destination data, and sets the file on the real
hidden import input through CDP. It then waits for the checked panel summary and
reads Chrome storage plus IndexedDB to verify restoration.

The harness blocks every extension HTTP(S) request at the CDP request stage and
also maps non-loopback hosts to `NOTFOUND`. Fixture values are synthetic. Its
report exposes only key counts, booleans, browser/build identity, the generated
extension ID, and tree identity; it never prints the downloaded document,
browsing payload, API-key material, OAuth data, or private URLs.

## Task 10 redacted results

```text
canonical full-v2 envelope: true
recursive forbidden export keys: 0
affected local sections exported: 8
IndexedDB stash records exported: 1
panel summary: Data import complete — 5 new records, 0 duplicates skipped
all eight affected local keys restored: true
session restored: true
manual group restored: true
keep-awake domains restored: true
bookmark snapshot restored: true
effective settings restored: true
Focus preferences restored: true
Focus history restored: true
safe AI provider/model configuration restored: true
AI key and passphrase metadata absent: true
IndexedDB stash restored: true
unrelated and excluded local state preserved: true
external requests reaching network: 0
```

An earlier successful functional-tree run produced these same assertions before
the final reviewer-requested semantic preflight additions and is therefore not
the terminal evidence. After all tracked code, tests, documentation, and version
content is frozen, the controller reruns this exact harness with a tree-hash
guard. The exact terminal tree, result, and cleanup counters are recorded in the
gitdir-local Task 10 closeout report so recording the hash cannot itself change
the tracked tree under test.

## Task 10 cleanup and scope

The harness terminates Chrome and Xvfb, removes both disposable profile and
download directories, and verifies those paths no longer exist. The terminal
run must report all four cleanup counters true before the tag is created.

This is a local portable-data proof, not a live Google Drive/OAuth proof. It
requests no token, creates no Drive artifact, and does not replace the separately
tracked authenticated Drive fixture.
