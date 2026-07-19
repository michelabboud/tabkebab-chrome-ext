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

---

Slice: Task 11, checked side-panel messaging and grouped global search

Extension version: `1.2.13`

## Task 11 deterministic and independent-review evidence

Regression-first implementation preserved the original corrected RED state
(`4 pass / 5 fail / 1 error / 15 assertions`) and three reviewer-driven RED
runs (`78 pass / 13 fail / 480 assertions`, `91 pass / 20 fail / 555
assertions`, and `113 pass / 2 fail / 644 assertions`). The frozen side-panel
tree `c925bf65dfdabbb0358ab5a0d5570192a8eeafcc` passed those focused gates, but
the later terminal full-suite run exposed an unowned two-second Focus badge
reset (`529 pass / 0 fail / 1 error / 2916 assertions`). Focused timer
regressions were RED at `52 pass / 2 fail / 151 assertions`; the narrower
overlapping-reset race was RED at `0 pass / 1 fail / 2 assertions`. The final
tracked tree passes:

```text
focused side-panel suites: 62 pass / 0 fail / 277 assertions
affected five-file command: 115 pass / 0 fail / 656 assertions
Focus lifecycle: 56 pass / 0 fail / 164 assertions
full suite: 541 pass / 0 fail / 2966 assertions
coverage suite: 541 pass / 0 fail / 2966 assertions
coverage: 52.52% functions / 51.06% lines
syntax: 2 pass / 0 fail / 100 assertions
```

The exact 15-file request inventory, raw-runtime boundary, direct Chrome and
Storage promise audit, whitespace, version parity, bounded `core/focus.js`
scope check, and zero package/lockfile delta all pass under Bun `1.3.11`. Two
independent side-panel reviews report zero Critical, Important, or Minor
findings, while independent timer analysis and a follow-up concurrency review
drove the final queue-owned repair and regressions.

## Task 11 preliminary real-Chrome side-panel boundary (superseded)

The fail-closed harness uses the installed official Chrome for Testing build and
the actual unpacked extension:

```text
Google Chrome for Testing 148.0.7778.96
binary SHA-256: adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
extension ID: igggfmpiljhefkagnphadfadollcimlh
historical functional tree: 11afd6d6609f8c3b8b046ed2d5f43faef7ff6098
```

This run predates reviewer repairs and the tracked evidence refresh. It is
retained as historical functional evidence only and must not be used as proof
of the terminal Task 11 tree.

In one clean disposable profile, the harness loads the production panel and
service worker, seeds only synthetic local/IndexedDB records, and opens three
synthetic tabs across two domains. It sets `driveSync.connected` to the exact
affirmative state while deliberately omitting `driveProfileName`, then clicks
the real manual-cleanup button and confirmation. Production profile validation
therefore fails before OAuth or a Drive request, the worker returns its generic
error-shaped response, and the panel must consume that response through the
checked message boundary.

The harness then opens production global search through the document's Ctrl+K
keyboard-handler event. Chrome consumes a physical Ctrl+K as an omnibox
accelerator when the panel document is hosted in a test tab, so the harness
dispatches the same bubbling/cancelable `KeyboardEvent` with `key: 'k'` and
`ctrlKey: true` that the side-panel document receives. This proves the extension
handler and resulting UI, not Chrome's browser-level accelerator routing.

All context HTTP(S) requests are aborted before network and the browser also maps
non-local hosts to `NOTFOUND`. The redacted result reports only synthetic labels,
counts, booleans, safe UI copy, browser/tree identity, and cleanup counters. It
does not print storage payloads, browsing data, a token, a private URL, or a
credential.

## Task 11 preliminary redacted results (superseded)

```text
checked Drive-cleanup failure:
  safe failure toasts: 1
  safe text: Cleanup failed: Drive cleanup failed
  success toasts: 0
  optimistic panel/storage mutations: 0
  unhandled rejections: 0
  panel page errors: 0
  controls restored: true

worker grouped tabs:
  synthetic-alpha: 2
  synthetic-beta: 1
  grouped order preserved in Ctrl+K results: true

Ctrl+K sections:
  Open Tabs: 5
  Stashes: 1
  Sessions: 1
  synthetic stash present: true
  synthetic session present: true
  valid no-match text: No results found
  unavailable alert shown for valid data: false

external requests reaching network: 0
```

The real-Chrome no-match check uses a loaded valid profile and an unmatched
query. The deterministic DOM-free regression separately supplies genuinely
empty valid arrays for tabs, stashes, and sessions and proves that they render
ordinary empty results, while rejection or every malformed grouped-tab shape
renders exactly one `Search unavailable — try again.` alert. This split avoids
claiming that the test-tab-hosted panel can make Chrome's own panel tab disappear
from `chrome.tabs.query({})`.

The terminal harness seeds stashes and sessions only through their current own
`windows[].tabs` schema, searches a nested saved-tab title, and retains the same
checked cleanup/no-network boundary. After the tracked evidence files froze,
the controller reran the tree-hash-guarded harness and observed the same checked
cleanup outcome plus both nested saved-record matches. The exact terminal tree,
repeated redacted result, browser hash, network counter, and cleanup proof are
recorded in the gitdir-local Task 11 closeout report so writing the hash cannot
recursively change the tracked tree.

## Task 11 terminal real-Chrome result

```text
Chrome for Testing: 148.0.7778.96
checked cleanup failure toasts: 1
checked cleanup success toasts: 0
optimistic mutations: 0
unhandled rejections: 0
panel page errors: 0
controls restored: true
synthetic-alpha grouped tabs: 2
synthetic-beta grouped tabs: 1
grouped order preserved: true
current nested stash match: true
current nested session match: true
valid no-match text: No results found
unavailable alert for valid data: false
external requests reaching network: 0
profile removed: true
matching Chrome processes after cleanup: 0
Xvfb exited: true
```

This result contains only synthetic labels, safe UI text, counts, booleans, and
public build identity. It contains no token, browsing payload, private URL,
storage value, or credential.

## Task 11 cleanup and scope

The historical functional-tree run observed 315 disposable profile entries
before teardown, then reported the profile removed, zero matching Chrome
processes, and Xvfb exited. The harness itself remains under the gitdir-local
`sdd/` evidence area and is not extension runtime content.

This fixture is a checked local worker/UI proof, not a live Google Drive/OAuth
proof. It deliberately fails before authentication and makes no Drive call or
artifact. Even after the terminal rerun, it does not replace the separately
tracked registered-identity and operator-authenticated two-profile Drive
fixture.

---

Slice: Task 12, atomic AI credential lifecycle

Extension version: `1.2.14`

## Task 12 deterministic and independent-review evidence

The untouched Task 11 AI-adjacent baseline passed at `33 pass / 0 fail / 178
assertions`. The mandatory pre-production Task 12 boundary was then RED at `17
pass / 51 fail / 159 assertions`, covering the absent restart-unlock path,
private/public settings split, atomic protection transition, strict worker
messages, and checked UI lifecycle.

After implementation and reviewer-driven race/security regressions, the final
tracked source passes:

```text
affected credential/UI/export suites: 188 pass / 0 fail / 1376 assertions
full suite: 640 pass / 0 fail / 3711 assertions
coverage suite: 640 pass / 0 fail / 3711 assertions
coverage: 61.29% functions / 57.40% lines
syntax: 2 pass / 0 fail / 101 assertions
```

Whitespace, version parity, secret scanning, and the no-package/no-lockfile
audit pass under Bun `1.3.11`. Two independent final audits report no blocker
at functional tree `a32a08e93aecc03d7b7072294db159a39a35c9ab` after focused
immutable reruns with zero failures. Their reviews include the exact public and
private configuration boundary, Custom origin binding, response/cache
credential rejection, and provider-change/status/unlock race ownership.

## Task 12 preliminary real-Chrome credential result (superseded)

Chrome for Testing `148.0.7778.96` loaded the actual unpacked extension at
functional tree `6523bb885c8936646e12256c22baaf08cc7ca078` in one disposable
profile. The fixture used generated synthetic credential material that was
never printed. It saved a passphrase-only OpenAI key, recorded the encrypted
blob, cleared active UI state by fully exiting Chrome, and relaunched the same
profile.

The encrypted blob remained byte-for-byte unchanged and local storage contained
no plaintext key or install ID for this passphrase-only path. The relaunched
session was locked, the Unlock controls were visible, the wrong passphrase was
rejected, and the correct passphrase unlocked the provider. One subsequent
production provider request carried the generated credential only in its
authorization header. It was intercepted before network; the URL, request body,
runtime responses, and panel/service-worker logs contained no credential. No
other external request or page error occurred, and the disposable Chrome,
display, and profile resources were removed.

This run predates the final reviewer repairs and tracked documentation/version
freeze, so it is retained only as preliminary functional evidence. The
controller reruns the same tree-hash-guarded harness after all tracked Task 12
content is frozen. Its exact non-recursive tree, redacted counters, and cleanup
proof live in the gitdir-local Task 12 report so recording the tree cannot
recursively alter the source under test.

## Task 12 terminal credential result

Chrome for Testing `148.0.7778.96` passed the documentation-frozen tree
`7c29fbde2adf2e68abbd391ea876a52639c34e3b`. The encrypted blob survived a
full Chrome exit/relaunch, the restarted profile was locked, one wrong
passphrase failed without mutation, the correct passphrase unlocked the
provider, and one intercepted request carried the expected runtime fields.
Credential matches in URL, body, local plaintext, runtime responses, and logs
were zero; external requests reaching the network were zero; and the profile,
Chrome, display, and fixture resources were removed. Commit
`7b0d41a9225f87a0e475363ae53ca11e7cb8b2ab` was tagged `v1.2.14`, pushed, and
passed exact-commit GitHub Actions run `29686848868`.

This is a local credential-boundary proof, not a live provider-account or Google
Drive/OAuth proof. The provider response is intercepted and synthetic, and no
secret or private browsing payload is preserved in repository evidence.

---

Slice: Task 13, abort-before-retry AI lifecycle

Extension version: `1.2.15`

## Task 13 deterministic and independent-review evidence

Regression-first work began with the missing lifecycle module and retry/signal
contract failures. Reviewer-driven RED cases then exposed pre-cancelled calls
starting provider work, zero timeout acceptance, raw and custom-reason aborts
escaping their typed category, connection-test timeout rethrow, missing
first-cause and non-cooperative-provider proof, and a late-result cache gap.

After repair, the tracked source passes:

```text
lifecycle/queue/provider/client focused: 129 pass / 0 fail / 458 assertions
Task 12 credential/export compatibility: 146 pass / 0 fail / 1044 assertions
full suite: 769 pass / 0 fail / 4177 assertions
coverage suite: 769 pass / 0 fail / 4177 assertions
coverage: 69.93% functions / 66.11% lines
syntax: 2 pass / 0 fail / 109 assertions
```

Two independent immutable reviews report no remaining functional blocker at
tree `e95cb671ffb6c60a18f34a354e04b97012bf287a`. Their reruns passed `219/0`
and `129/0`, covering positive-only timeout validation, no-work pre-abort,
first-cause ownership, synchronous and non-cooperative cleanup, exact signal
threading, custom abort reasons, retry classification, attempt isolation,
fallback-after-cleanup, and no-cache late results. Whitespace, version parity,
credential-signature scanning, and the no-package/no-lockfile audit are part of
the release closeout under Bun `1.3.11`.

## Task 13 preliminary real-Chrome timeout result

Chrome for Testing `148.0.7778.96` loaded the production extension at exact
functional tree `c073b4e2f4fd542f39a26a0302fbb19e7cfa821b`. The committed Bun
fixture listened only on loopback, allowed CORS for the extension, held
`/v1/chat/completions` until the client disconnected, and exposed only redacted
lifecycle counters. The harness blocked every other HTTP(S) request.

Using the unchanged 120-second production boundary, the real Test Connection
UI action settled after `120.078s`; the fixture observed its request active for
`119.913s`. The runtime returned the exact existing `{ success: false }`
fallback only after the connection abort settled. Metrics then showed one
start, one abort, zero completions, zero active requests, and maximum active
one, with no automatic retry. One explicit later click produced the second and
only second request. Closing Chrome yielded the exact final counters:

```text
request starts: 2
connection aborts: 2
completed requests: 0
active requests: 0
maximum active requests: 1
other external requests: 0
runtime errors: 0
```

The disposable profile contained 347 entries before teardown and was removed;
matching Chrome processes were zero, and Xvfb plus the fixture exited. The
terminal release gate repeats this tree-hash-guarded harness after tracked
documentation and version freeze. Its exact tree, counters, and cleanup proof
live in the gitdir-local Task 13 report so recording them cannot recursively
change the source under test.

This is a real extension/panel/worker/HTTP cancellation proof against a local
synthetic provider. It does not validate an external provider account,
authentication, model quality, or availability, and it preserves no private
browsing payload or credential.
