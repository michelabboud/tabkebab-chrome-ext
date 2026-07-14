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
