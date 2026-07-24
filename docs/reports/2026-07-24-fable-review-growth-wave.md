# Fable review — growth wave G1–G4 (`feat/growth-wave-g2-g4`, `5a6b40b..9e77bb7`)

## VERDICT: CLEAN-WITH-NOTES — no blocking items; merge approved on this review

- **Reviewer:** Fable (pinned review lane) · **Date:** 2026-07-24
- **Range:** `5a6b40b..9e77bb7` (4 commits: G1 follow-ups `4676fe8`, G2 `c2d0dd8`, G3 `6d50ab9`, G4 `9e77bb7`)
- **Severity counts:** 0 CRITICAL · 0 HIGH · 0 MEDIUM · 6 LOW (4 code-edge, 1 design note, 1 docs)
- **Full suite run by reviewer:** 900 pass / 0 fail / 4975 expect() across 47 files (output below)

---

## Commit 1 — G1 follow-ups (`4676fe8`)

### Verified correct

- **Heal reuse, not fork.** The heal (`healCapturedTab/TabList/GroupList/SessionStrings`,
  `sanitizeLegacySessionTimestamps`, `canonicalizeLocalSessions`) was **moved** from
  `core/sessions.js` into `core/drive-sync.js` and deleted at the origin; `core/sessions.js`
  now imports `canonicalizeLocalSessions` (core/sessions.js:14). There is exactly one copy.
  The one textual delta in the move — group-title heal uses a plain
  `slice(0, MAX_CAPTURED_GROUP_TITLE_LENGTH)` instead of `sanitizeCapturedGroupTitle()` — is
  behaviorally identical because the call is guarded by `typeof title === 'string'`
  (core/drive-sync.js:461-469 vs core/tab-restore.js:63-65). Shared bounds now live in the new
  `core/capture-limits.js`, imported by both capture and heal, so the policy cannot drift.
- **Read-path heal persists and is lock-covered.** `readLocalDriveSyncDocument()`
  (core/drive-sync.js:639) and `buildPortableExportPayload('sessions')`
  (core/export-import.js:183-189) both canonicalize and write back only when
  `localSessionsNeedWriteBack()` says the canonical form differs. The comparison
  (`canonicalValuesEqual`, core/drive-sync.js:139) is key-order-insensitive
  (`canonicalClone` sorts keys), so byte-identical-modulo-ordering legal data does **not**
  trigger spurious writes. Both call paths run under `withStateMutationLock`
  (service-worker.js:399 for sync, :1551 for export); no unlocked caller exists
  (grepped — only tests otherwise).
- **Export write-back cannot persist an export-transformed shape.** The `sessions` repository
  in `PORTABLE_SECTION_REPOSITORIES` has **no** `exportNormalize`/`exportEmpty`
  (core/export-import.js:86), so `sections.sessions` is the raw stored value; the write-back
  persists the canonical form of what is actually in storage.
- **tabCount recompute** is in the shared heal (core/drive-sync.js:478 —
  `healedWindow.tabCount = healedWindow.tabs.length`) and asserted both on the delete path
  (`tabCount).toBe(0)`) and on the sync/export read paths
  (tests/core/capture-sanitization.test.js:189, :199-204, :210-220).
- **`saveSession` empty rejection** returns `{ error: 'No stashable tabs in session' }`
  (core/sessions.js:165-167) — the same `{ error: string }` shape as the stash paths — and the
  test also asserts nothing was written (`storedSessions()).toBeUndefined()`,
  tests/core/capture-sanitization.test.js:99-109).
- **Invariant tests are real failure-path tests.** `persistCapturedStash`
  (service-worker.js:276-303) is the single save-before-close boundary at all four stash sites
  (window/group/domain/auto-stash — a source-level test asserts exactly 4 call sites), and
  tests/core/stash-capture-invariants.test.js asserts: rejected save → throw propagates and
  `closed == []`; zero-representable → `{error}` with zero saves and zero closes; success →
  order is `['save','close']` and `chrome://` tabs are excluded from close. The favicon render
  gate is exported (sidepanel/components/stash-list.js:19) and directly tested for
  `javascript:` rejection, oversize rejection, and http/data acceptance
  (tests/sidepanel/stash-favicon.test.js).

### Notes (LOW)

- **L5 (design note, by design):** heal-on-read can normalize *legal-but-legacy* data — e.g. a
  stored window without a `tabCount` field gains `tabCount: 0`, triggering a one-time
  write-back. No data is lost (only shape canonicalization; string truncation applies solely
  to values already over `MAX_DRIVE_STRING_LENGTH`, which capture-time sanitization prevents),
  and the updated fixture in tests/core/state-mutation-lock.test.js:39 shows this was a
  conscious choice. Answering the brief literally: it canonicalizes legal data's shape; it
  cannot damage it.

## Commit 2 — G2 first-run + empty states (`c2d0dd8`)

### Verified correct

- **Security:** zero `innerHTML`/`insertAdjacentHTML`/`outerHTML` added anywhere in the whole
  branch (grep over the full range diff: 0 hits). Both new components build DOM via
  `createElement` + `textContent` only. All walkthrough and empty-state copy is static
  (frozen `FIRST_RUN_STEPS`, literal CTA strings); tab titles never enter these components.
  Both files are enrolled in the repo's side-panel request audit
  (tests/sidepanel/component-messaging.test.js).
- **No drawers.** `.first-run-walkthrough` is a normal-flow `<section>` inside
  `.view-container` (sidepanel/panel.html:117) with static margin/padding CSS — no
  `position: fixed/absolute`, no slide transform (sidepanel/panel.css:1520-1534). The
  pre-existing `position: fixed` hits in panel.css are toasts/dialogs, untouched.
- **Storage flag logic:** read failure → toast, panel stays usable, guide does not open
  (`startIfNeeded` returns false); write failure → guide stays open, honest toast that it may
  reappear (sidepanel/components/first-run-walkthrough.js:71-96). The seen flag is written when
  the guide auto-opens (documented assumption — prevents a reappearing-tour dark pattern).
  Re-show: settings "Replay guide" button calls `launch()` directly, bypassing the flag —
  correct. Races: the flag is read once per panel document; two simultaneous panel documents
  could each show the tour once — cosmetic, not a correctness issue.
- **CTAs are real:** saved-sessions empty state focuses `#session-name`; auto-save empty state
  navigates to `#settings-automation-section` (id added in this commit); stash empty state
  navigates to Tabs where stash actions live; focus-profile empty state re-runs the real
  `refresh()` with an error toast on failure. All asserted in
  tests/sidepanel/first-run-walkthrough.test.js (12 tests incl. read-failure, write-failure,
  navigation, and dismiss-on-every-step paths).

## Commit 3 — G3 Smart Group zero-config route (`6d50ab9`)

### Verified correct

- **(a) Routing can never silently go remote.** `selectSmartGroupRoute`
  (core/ai/smart-group-route.js:14-32) returns `configured` **only** when
  `settings.enabled === true` AND (provider is CUSTOM, or provider is a keyed provider with
  `providerConfigs[id].hasApiKey === true`). Every other input — disabled, null provider,
  keyed-without-key, unknown provider — lands on `{ mode: 'zero-config', providerId: 'chrome-ai' }`.
  The zero-config branch calls `AIClient.completeWithChromeAI()` (core/grouping.js:146-148),
  which hard-codes `providerId = ProviderId.CHROME_AI` (core/ai/ai-client.js:947-952) —
  there is no input by which the zero-config path can dispatch a remote provider. The
  configured branch goes through the normal `AIClient.complete()` with all its existing
  enabled/unlocked checks. Route tests cover all four selection cases.
- **(b) The privacy copy is true.** The built-in route resolves to the pre-existing
  `chromeAIBrokerClient` (core/ai/ai-client.js:31), which relays over a
  `chrome.runtime` port to the side-panel broker, which calls the on-device Prompt API
  (`LanguageModel`, core/ai/provider-chrome.js:10-11). Grep across broker client, broker, and
  chrome provider: no `fetch`, `XMLHttpRequest`, or `WebSocket`. None of these three files is
  touched by this wave (last change `13cc0d5`). "No data leaves this machine" /
  "the grouping request stays on your machine" is accurate for this route.
- **(c) Fallback ladder lands inline, core loop never blocked.** All AI failures are collapsed
  by `classifySmartGroupFailure` into `unavailable | timeout | failed`;
  `applySmartGroupsToChrome` returns a fixed outcome object (`aiApplied:false`,
  `aiSource`, `aiFailure`, `fallbackAction:'domain'`) instead of throwing or silently
  auto-grouping (core/grouping.js:150-172). The panel renders
  `SmartGroupFallback` — an inline card (no overlay CSS), with a real
  "Use domain grouping instead" button wired to the existing `groupByDomain()` and a settings
  link navigating to `#settings-ai-section` (sidepanel/components/smart-group-fallback.js,
  tab-list.js:39-45). Raw provider/browser messages cannot reach the UI: copy is a frozen
  6-entry table keyed by sanitized enums, and `show()` re-sanitizes both inputs. The raw
  error toast is gone. Coordinator + fallback tests cover unavailable, configured-failure,
  timeout, worker-throw, and zero-config-success paths.
- **(d) Timeouts/aborts follow the established patterns.** `completeWithChromeAI` funnels into
  `completeWithResolvedProvider`, a verbatim extraction of the old `complete()` body (diff
  confirms move-not-fork): same queue, same `runAbortableAttempt` + 120 s timeout + per-attempt
  `AbortController`, same `sanitizeProviderFailure` boundary, same cache. The broker client's
  abort listeners are removed on settle (core/ai/chrome-ai-broker-client.js:35-38, :377) and
  the broker aborts per-port on disconnect — all pre-existing, unmodified machinery.
- **(e) No key material on the built-in route.** `completeWithChromeAI` builds
  `config = { model: 'default' }` from `PROVIDER_DEFAULTS` and uses `defaultPrivateSettings()`
  (`enabled:false, providerId:null, providerConfigs:{}` — core/ai/ai-client.js:57-63). No
  `apiKey` field exists on this path, and nothing new is logged.

### Notes (LOW)

- **L1 — tab-list.js:565-570:** the transport-level `catch` hardcodes
  `show({ reason:'failed', source:'configured' })`. A keyless zero-config user who hits a
  messaging failure reads "Your **configured** AI could not finish Smart Group" — misleading
  copy on an edge path (the two recovery actions still work).
- **L2 — core/grouping.js:135-141:** the route-selection failure path (settings read throw)
  likewise hardcodes `aiSource: 'configured'`. Same cosmetic mismatch.
- **L3 — sidepanel/panel.js:385-393:** `usesConfiguredProvider` re-derives
  `selectSmartGroupRoute`'s predicate in UI-land to decide the zero-config note's visibility.
  It agrees today, but it is a second copy of routing logic; if the route rule changes, the
  "no data leaves this machine" note could disagree with the actual route. Suggest deriving
  the note from `selectSmartGroupRoute` itself in a follow-up.
- **L4 — sidepanel/panel.js:405-415 (catch path):** if `getAISettings` fails,
  the zero-config note is shown unconditionally — a user whose configured remote provider
  will actually be used (worker route reads settings independently) could briefly see the
  local-only promise. Edge-of-edge; same follow-up as L3 would fix it.

## Commit 4 — G4 store trust package (`9e77bb7`)

### Verified correct

- **PRIVACY.md sentences vs code:** the "up to five stored favicon values per stash, scheme-
  and size-checked, fetched from the hosts the stored URLs name, local placeholder on
  rejection" claim matches `maxFavicons = 5` + `safeFaviconUrl` + inline SVG fallback
  (sidepanel/components/stash-list.js:157-168). The "bookmark HTML exports embed Google s2
  favicon URLs, requested when the file is opened" claim matches the export template
  (service-worker.js:513). The general local-only wording was consistently amended in three
  places so the document does not contradict itself.
- **store-listing.md vs manifest.json:** all 7 permissions (`tabs`, `tabGroups`, `storage`,
  `sidePanel`, `identity`, `alarms`, `bookmarks`), all 3 host permissions (OpenAI, Anthropic,
  Gemini), and the `drive.file` OAuth scope are each present and truthfully justified —
  nothing extra, nothing missing. "Does not inject a content script or read page content" is
  true: no `content_scripts`, no `scripting` permission in the manifest. The AI claims
  correctly distinguish on-device Chrome AI (verified above) from opt-in keyed providers and
  the optionally-keyed custom endpoint. No "arbitrary remote hosts"-style overclaim.
- **CHANGELOG v1.2.20:** matches what the code actually does, including the honest phrasing
  "does not send the grouping request over the network" (scoped to the local route) and a
  verification note with the real test-count progression (876 → 900).
- **Version parity:** `VERSION` = `manifest.json` = CHANGELOG heading = store-listing
  reference = `1.2.20`; the suite's parity test passes.

### Notes (LOW)

- **L6 — docs/reports/2026-07-21-codex-growth-wave-g1-g4.md:7:** the committed wave report
  still opens with "**Status:** BLOCKED before branch switch; G2–G4 were not started" — a
  stale header from the blocked resumed lane — while the appended G2/G3/G4 close-outs below
  document completion. Anyone reading top-down is misled for 90 lines. Suggest a one-line
  header fix at merge time (docs-only).

## Whole-branch checks

- **`bun test` run by this reviewer** (not copied from the report), tail:

  ```text
  900 pass
  0 fail
  4975 expect() calls
  Ran 900 tests across 47 files. [7.54s]
  ```

  (Mid-run stderr noise is synthetic-failure logging from expected failure-path tests.)
- **No new dependencies:** `git diff 5a6b40b..9e77bb7 -- package.json bunfig.toml bun.lock*`
  is empty.
- **No eval/remote code:** zero added `eval(`, `new Function`, or remote-script references in
  the range; manifest unchanged except the version string.
- **No debug leftovers:** zero added `console.log`/`debugger`; the only console calls in
  touched code are pre-existing `console.warn` failure logs.
- **Wave report honesty:** test counts, file lists, and assumptions in the report match the
  diff; verification numbers reproduced. The report's structure (a BLOCKED lane record with
  later close-outs appended) is confusing but not dishonest — see L6.

## What I did not check

- No live-browser run: the walkthrough, empty states, and fallback card were not exercised in
  an actual Chrome side panel (DOM-level tests plus CSS reading only). Chrome built-in AI
  behavior on a machine without the Gemini Nano model was not exercised live — the
  `unavailable` path is verified at the unit/coordinator level only.
- The pre-existing broker/provider-chrome/broker-client internals were verified untouched and
  grepped for network calls, but not line-by-line re-reviewed (they predate this wave and were
  reviewed in the brokering wave).
- `store/listing.txt`, `store/permissions.txt`, `store/privacy-policy.txt` — the older
  submission working copies are acknowledged as stale by the report; syncing them from
  `docs/store-listing.md` is the stated follow-up and was not re-verified here.
- Accessibility of the new UI (focus order, SR announcement beyond the `role="status"`
  region) was not audited.

## Suggested follow-ups (non-blocking)

1. Fix the wave report's stale BLOCKED header (L6) — one line, can ride the merge commit.
2. Thread the real route/source into the two hardcoded `'configured'` failure paths (L1, L2).
3. Derive the zero-config note's visibility from `selectSmartGroupRoute` (L3, also fixes L4).
