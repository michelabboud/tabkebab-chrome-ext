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
