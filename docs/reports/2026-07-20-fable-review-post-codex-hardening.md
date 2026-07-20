# TabKebab post-codex-hardening review — Fable, 2026-07-20

Verification-grade review of the repository state at `a670f77` (v1.2.18), focused on
(1) whether the recent codex hardening waves are actually sound, (2) ranked
improvement suggestions, and — per the owner's addendum — (3) **update safety** for
users on older versions and (4) **Chrome Web Store compliance**. Calibration, per the
owner: the extension is published on the Chrome Web Store but has **almost no users
yet**, so migration gaps are graded on intrinsic severity (not Critical-by-default),
awkward stored-data shapes are flagged as *fix-now-while-nobody's-installed*
opportunities, and improvements are ranked toward what makes a **new** user install,
succeed in the first five minutes, and stay.

Method: full read of the security-critical modules (`core/ai/*`, `core/drive-*`,
`core/export-*`, `core/sessions.js`, `core/stash-db.js`, `core/tab-restore.js`,
`core/state-mutation-lock.js`, broker pair, side-panel rendering surfaces,
`service-worker.js` handler/coordinator sections, `manifest.json`), claim tracing
against `ARCHITECTURE.md`/`CHANGELOG.md`/`PRIVACY.md`, one full local test run, and
one targeted reproduction script for the new F10 finding.

**Overall verdict: strong.** The codex hardening is real, not theater — six of seven
headline fixes verify as SOUND, one as SOUND-WITH-GAPS. No Critical findings. Update
safety: **no missing migration found** — every shipped storage-shape change has a
verified read path for old data. Store compliance: **clean** on remote-code policy
and permission minimality; privacy policy matches actual data flows on every major
claim, with two one-sentence gaps. Two High findings, both long-fuse correctness
bombs in the same core loop (save/delete/sync), one of them attacker-triggerable.

Test evidence (run locally during this review, Bun 1.3.11):

```
bun test → 854 pass / 0 fail / 4813 expect() calls, 40 files, 10.25s
```

This matches the v1.2.18 changelog claim exactly. F10 additionally reproduced with a
standalone script against `core/drive-sync.js` (output shown in F10 below).

---

## Verdict summary

### Codex fix verdicts

| Fix (commit) | Verdict |
|---|---|
| Deterministic Drive sync (`4a48a08`) | **SOUND** |
| Drive deletion convergence / tombstones (`fbea7ad`) | **SOUND** (see F1 for the cap gap) |
| Fail-closed Drive retention (`359f946`) | **SOUND** |
| Transactional portable import (`dc16829`) | **SOUND-WITH-GAPS** (F2) |
| AI credential lifecycle (`7b0d41a`) | **SOUND** (see F3 for threat-model notes) |
| Timeout abort lifecycle (`14d1900`) | **SOUND** |
| Side-panel Chrome AI broker (`13cc0d5`) | **SOUND** |
| Exact tab URL identity (`533a86e`) | **SOUND** |

### New-scope verdicts

| Dimension | Verdict |
|---|---|
| Update safety (old-version data → v1.2.18 code) | **PASS** — all shape changes have verified migrations/defaults; opportunity flags below |
| MV3 remote-code policy | **PASS** — zero eval/`new Function`/`importScripts`/script injection; no CSP relaxation |
| Privacy policy vs actual data flows | **PASS with two one-sentence gaps** (favicon traffic, see Store compliance) |
| Permission minimality | **PASS** — all 7 permissions + 3 host permissions verifiably used |

### Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| F10 | Capture paths store unbounded page-controlled strings (title/favicon); one >16 KiB value poisons storage — every later delete, auto-save cleanup, Drive sync, and export throws, with no in-product recovery | High | VERIFIED (reproduced) |
| F1 | Deletion tombstones accumulate forever against a hard 10,000 cap; at the cap, all session/group deletion permanently fails | High | VERIFIED |
| F2 | Portable import is compensating-rollback, not atomic: SW death between the two store writes commits a silent partial import | Medium | VERIFIED (code path) |
| F3 | Device-mode key encryption is obfuscation-level (install ID stored beside ciphertext); PBKDF2 100k iterations below current OWASP guidance | Medium | VERIFIED |
| F4 | `runtime.onMessage`/`onConnect` perform no sender assertion (currently unexploitable; future-proofing) | Low | VERIFIED |
| F5 | Stored stash `favIconUrl` rendered without scheme validation → remote-image privacy beacon in the side panel | Low | VERIFIED |
| F6 | Bookmark HTML export escapes correctly but does not scheme-filter `href` (imported `javascript:` URLs would survive) | Low | VERIFIED |
| F7 | Drive client: unbounded `Retry-After` sleep; two list endpoints still use unbounded `resp.json()` | Low | VERIFIED |
| F8 | `importStashes()` awaits between IndexedDB requests inside one transaction (fragile pattern) | Low | VERIFIED |
| F9 | `focus-panel` interpolates quote-unsafe-escaped values into attribute context (not exploitable today; defense-in-depth) | Info | VERIFIED |

**Counts: 0 Critical / 2 High / 2 Medium / 5 Low / 1 Info.**

Explicitly checked and clean:

- **XSS via tab titles/URLs in the side panel: not found.** All attacker-controlled
  strings (tab titles, URLs, favicons-as-text) render via `textContent`
  (`tab-list.js:430`, `global-search.js:273-280`, `window-list.js`, `toast.js:16`).
  The `innerHTML` template sites interpolate only counts, internal labels, or
  `escapeHtml()`-escaped values in text-node context (`session-manager.js:181`).
- **BYO keys never leave the worker boundary.** `getPublicSettings()` projects only
  allowlisted fields (`ai-client.js:686-712`); portable export runs
  `sanitizeAISettings()` before canonicalization (`export-schema.js:977`); public
  import parsing rejects secret/cache fields (`allowAISecretsAtRoot` defaults false
  and is only enabled for the trusted in-memory local-merge operand,
  `export-schema.js:229,255,813-818`). Zero `console.*` calls in `core/ai/`.
  Responses are scanned for exact submitted-secret reflection before return
  (`ai-client.js:908,927,947`).
- **Drive OAuth token is memory-only** via `chrome.identity.getAuthToken`
  (`drive-client.js:74-86`); never persisted, logged, or exported. Drive query-string
  injection checked: all filenames interpolated into `q` are fixed/dated or sanitized
  (`service-worker.js:2130`), profile names restricted to `[A-Za-z0-9 _-]{1,50}`
  (`drive-client.js:21-34`).
- **Message surface is internal-only.** No `content_scripts`, no
  `externally_connectable` in `manifest.json`, so web pages and other extensions
  cannot reach `onMessage`/`onConnect`. The broker port additionally requires the
  exact name `tabkebab:chrome-ai` (`service-worker.js:892-900`).
- **Exports/Drive payloads** contain sessions/stashes/bookmarks by design (documented
  in PRIVACY.md); credentials, tokens, install IDs, caches, and active Focus state are
  excluded (verified against `export-schema.js` allowlists).

---

## Update safety audit (owner addendum 1)

Every storage-shape change shipped across the fix waves was traced to a read path
that tolerates the old shape. Inventory:

| Stored data | Old shape | New-code handling | Verdict |
|---|---|---|---|
| Sessions (`chrome.storage.local`) | v1 flat `tabs` array | `migrateV1toV2()` at every read (`sessions.js:88-117`); Drive canonicalization counts both `tabs` and `windows` shapes (`drive-sync.js:167-186`) | SAFE (read-time, non-destructive) |
| Drive sync document | missing-version / v1, no tombstones | `migrateDriveSyncDocument()` → v2 with empty tombstone maps (`drive-sync.js:366-413`) | SAFE |
| `driveSyncTombstones` key | absent on old installs | every reader defaults to `emptyDriveTombstones()` (`sessions.js:239,272`) | SAFE |
| Settings | legacy missing/v1 envelope, missing keys | `validateSettingsPatch()` fills defaults per-key (`settings.js:120-132,161-164`) | SAFE |
| Portable exports | v1 full/partial, legacy Drive `savedAt` settings, unversioned dated backups | parser normalizes all to v2 in memory (`export-schema.js`, verified against ARCHITECTURE claims) | SAFE |
| Focus history | pre-`runId` records | separate legacy `id` namespace (documented + tested, `tests/core/focus-lifecycle.test.js`) | SAFE |
| AI response cache | pre-v1.2.14 weakly-scoped entries | cleared on install/update (`service-worker.js:916-922`) | SAFE (deliberate discard of disposable data) |
| Encrypted key blobs | — | blob shape `{ciphertext,salt,iv,usesPassphrase}` unchanged since the initial commit (`crypto.js:87-92`); no plaintext-key era exists in history; malformed blobs degrade to "re-enter key", not a crash (`ai-client.js:367-371`) | SAFE |
| `chrome.storage.session` key cache | cleared by Chrome on update | by design: keys relock (passphrase) or re-derive (device); documented in PRIVACY.md | SAFE |
| Stash IndexedDB | `DB_VERSION 1` | unchanged since initial commit; `onupgradeneeded` only creates (`stash-db.js:19-25`) | SAFE |

**No missing migration found.** A v1.2.x → v1.2.18 update does not brick or silently
discard stashes, sessions, settings, or keys.

**Fix-now-while-nobody's-installed opportunities** (cheapest they will ever be):

- **O1 — persist the session v1→v2 migration once.** Today v1 records live in
  storage forever and every reader pays the migration; a one-time locked rewrite
  would let the v1 branch be deleted eventually.
- **O2 — version the encrypted key blob.** The blob has no `version`/`iterations`
  field (`isEncryptedBlob` requires exactly 4 keys, `ai-client.js:336-349`), so
  raising PBKDF2 iterations (F3) later will need shape gymnastics. Add
  `version: 2, iterations: N` now with a legacy-default read path.
- **O3 — unify ID generation.** Sessions use `Date.now().toString(36)+random`
  (`sessions.js:80-82`) while everything modern uses `crypto.randomUUID()`.
  Standardize before IDs are in anyone's Drive.
- **O4 — give tombstones a pruning horizon field now** (pairs with F1), so the
  pruning policy ships as part of the schema rather than as a later migration.

---

## Store compliance audit (owner addendum 2)

**Remote code (MV3 policy): CLEAN.** No `eval`, `new Function`, `importScripts`,
dynamic `<script>` creation, or remote script URLs anywhere in `core/`, `sidepanel/`,
or `service-worker.js` (grep-verified). The manifest declares no `content_security_policy`
override and no `web_accessible_resources`. The Windows packager's positive allowlist
(`manifest.json`, `service-worker.js`, `core/`, `sidepanel/`, `icons/`) keeps the
site-verification HTML and all repo docs out of the shipped zip.

**Privacy policy vs actual data flows: MATCHES on every major claim.**

- The policy's key promise — AI providers receive "tab titles, simplified URLs
  (hostname + path)" — is true in code: `simplifyUrl()` strips protocol, query, and
  fragment and caps the path at 50 chars (`prompts.js:7-14`); titles cap at 80 chars;
  the Focus distraction check sends domain only (`prompts.js:142`). No page content,
  cookies, or history is ever read (the extension has no host access to pages at all).
- Gemini's header-auth claim, custom-endpoint HTTPS/loopback rules, Drive `drive.file`
  scope, session-storage key semantics, and the encryption description all match the
  implementation exactly. The only runtime endpoints in code are the three declared
  AI hosts plus `www.googleapis.com` (Drive); the remaining URLs are help links.
- **Two one-sentence gaps** (low takedown risk, cheap to close): (1) exported
  bookmark HTML embeds `https://www.google.com/s2/favicons?...` image URLs, so
  *opening the exported file* pings Google with visited domains
  (`service-worker.js:472`) — not extension runtime traffic, but worth declaring;
  (2) the side panel loads stored favicon URLs from arbitrary hosts when rendering
  stash previews (F5) — runtime traffic the policy doesn't mention.

**Permission minimality: PASS.** All seven permissions are load-bearing —
`bookmarks` and `identity` were specifically checked (16 real call sites:
`chrome.bookmarks.create` tree export, `chrome.identity.getAuthToken`/
`removeCachedAuthToken` for Drive). Host permissions are exactly the three AI APIs.
Note for the listing rather than the manifest: the `tabs` permission produces the
"Read your browsing history" install warning — unavoidable for a tab manager, but
the Store listing should preempt it explicitly (see improvement G4).

---

## Codex fix verification detail

### 1. Deterministic Drive sync — SOUND (`core/drive-sync.js`)

Verified: bounded validation before any merge (25 MiB / 10k entities / 10k tombstones
/ 100k tabs / depth 12 / dangerous-key rejection, `drive-sync.js:58-123`), canonical
key-sorted clones, newer-timestamp-wins with lexical tiebreak on canonical JSON
(`chooseEntity`, `drive-sync.js:419-429`). Merge is commutative: equivalent operands
produce byte-identical output, so the read-merge-write cycle converges even when two
profiles interleave writes (a lost remote write is re-merged from the loser's local
copy on its next sync; tombstone max-merge is monotonic). The whole coordinator runs
under the worker FIFO lock and holds it across read/merge/remote-write/local-commit
(`service-worker.js:315-359`), and remote-success/local-failure retry is idempotent.

### 2. Deletion convergence — SOUND, with F1 (`drive-sync.js:318-364`, `core/sessions.js:217-262`)

Verified: every deletion path records a tombstone ≥ max(entity timestamp, prior
tombstone, deletion time) in the same `Storage.setMany` commit that removes the
entity (`sessions.js:251-254` — single storage write, so no window where the entity
is gone but the tombstone is not). Merge removes an entity when its timestamp ≤ its
tombstone and retains tombstones even when a newer entity survives
(`drive-sync.js:465-477`). A deleted stash cannot resurrect through sync: resurrect
requires a strictly newer entity timestamp, which only explicit user import creates
(`modifiedAt = tombstone + 1`, `sessions.js:278-282`) — exactly the documented
recovery exception. Passive sync gets no such exception. Verified by test files
`tests/core/deletion-tombstones.test.js` and `tests/core/drive-sync.test.js`.

### 3. Fail-closed retention — SOUND (`core/drive-retention.js`)

Verified: inventory and selection fully complete before the first delete
(`coordinateDriveRetention`, `drive-retention.js:257-286`); a list/pagination failure
aborts with zero deletions (fail-closed). Conflicting metadata for one file ID throws
(`:170-179`). Canonical files, undated/unknown names, and every newest-per-category
file are structurally excluded from the deletion set; only old non-newest dated
copies below cutoff are selected. Per-file delete failures are collected as plain
records without stopping remaining deletes — reasonable, since each delete is
independent and the selection is already safe.

### 4. Transactional portable import — SOUND-WITH-GAPS (`core/export-import.js:309-377`)

What holds: pre-parse 25 MiB file limit, strict schema parse, merge under retained
tombstones, and a two-phase write (`storage.setMany` then `replaceAllStashes`) with
snapshot-based compensation on failure and `ImportRollbackError` when compensation
itself fails. `replaceAllStashes` revalidates the exact stash section and uses one
IndexedDB transaction with proper abort propagation (`stash-db.js:122-155`). All of
it runs under the worker mutation lock, so no concurrent mutation is clobbered by the
rollback snapshot.

The gap (F2): `chrome.storage.local` and IndexedDB cannot share a transaction, and
there is no persisted intent journal. If the MV3 service worker is killed between
`storage.setMany(localValues)` (`export-import.js:356`) and
`stashRepository.replace(merged.stashes)` (`:359`), the local sections are committed,
stashes are not, no rollback ever runs, and nothing records that an import was in
flight. Failure scenario: user imports a full backup, Chrome reaps the worker
mid-import (large stash validation makes this window non-trivial), sessions/settings
show imported data while stashes silently don't. Damage is bounded (merge is
local-wins/additive — nothing is lost, and re-running the import converges), which is
why this is Medium, not High. "Transactional" in the changelog overstates it;
"compensated two-phase with a crash window" is accurate.

### 5. AI credential lifecycle — SOUND (`core/ai/ai-client.js`, `core/ai/crypto.js`)

Verified end-to-end: `saveConfiguration()` validates public fields + full replacement
set before crypto; rejects submitted secrets appearing in editable public fields
(`:723-725`); encrypts in memory (AES-GCM, fresh salt/IV per blob); one local write
under the FIFO lock; best-effort session-cache write afterward with saved-but-locked
semantics on failure (`:764-780`). Session cache entries are fingerprint-bound to
current ciphertext, so a key/protection change invalidates stale plaintext. Custom
endpoints: HTTPS or HTTP-loopback only, no userinfo/query/fragment, and a stored key
cannot silently move origins (`customCredentialChangesOrigin`, `:597-603`). Gemini
auths via `x-goog-api-key` header, not URL. Legacy cache cleared on install/update
(`service-worker.js:916-922`). See F3 for the two threat-model caveats.

### 6. Timeout abort — SOUND (`core/ai/request-lifecycle.js`, `core/ai/queue.js`)

Verified: one fresh `AbortController` per attempt; timeout/external abort fire the
exact signal handed to the provider; the lifecycle never settles before the provider
promise finishes its own cleanup (`:74-95`) — so a queue retry cannot overlap a
timed-out attempt; timer and external listener are removed in `finally`, including on
synchronous provider throw; late success after abort is still a failure (`:86-87`).
Abort classification also checks `error.name === 'AbortError'` for custom abort
reasons. Queue retries only typed network/rate-limit failures, max 3 total attempts,
each retry after full settlement (`queue.js:106-127`). Fetch cancellation propagates
to the network layer because the same signal threads through `fetch()` and body reads
in all providers (spot-verified provider-claude/gemini/openai/custom).

### 7. Side-panel Chrome AI broker — SOUND (`sidepanel/chrome-ai-broker.js`, `core/ai/chrome-ai-broker-client.js`, `core/ai/chrome-ai-protocol.js`)

Verified: strict closed-shape protocol (exact own-enumerable keys, UUIDv4
correlation IDs, bounded prompts/options, 2 MiB canonical result ceiling, depth-12,
dangerous-key rejection, fixed typed error codes only); generation-guarded owner/
standby failover in the worker client; per-request provider + Web Lock exclusivity in
the panel with cancel-waits-for-cleanup semantics; duplicate request IDs marked
malformed and aborted once. The port surface is extension-internal (see clean-check
list above). Foreground-required fallback for background Focus classification
verified at `service-worker.js` (`checkWithAI` path) — no tab/counter/cache mutation
on skip.

### 8. Exact URL identity — SOUND (`core/tab-restore.js`, `core/duplicates.js`)

Verified: restore passes `savedTab.url` verbatim to `chrome.tabs.create`
(`tab-restore.js:189`); no normalization mutates the stored URL. `normalizeUrl` (used
only for duplicate detection) preserves hash and search (`duplicates.js:5-14`), so
hash-only-different tabs are neither deduped away nor rewritten. Forbidden schemes
(`about:`, `chrome:`, `data:`, `javascript:`, `blob:`, …) are skipped and *counted*
in the outcome (`skippedInvalid`) rather than silently dropped — correct, since
extensions cannot create those tabs anyway.

---

## Findings detail

### F10 — HIGH: unbounded capture poisons the delete/sync/export pipeline (reproduced)

Evidence: `saveSession()` stores `tab.title` and `tab.favIconUrl` **raw** — no
truncation, no validation (`sessions.js:146-151`); stash capture does the same. But
every deletion canonicalizes *all* stored sessions through the Drive validator
before deleting *any* (`deleteSessions` → `canonicalizeLocalSessions`,
`sessions.js:231`), and that validator hard-fails any string over
`MAX_DRIVE_STRING_LENGTH = 16_384` (`drive-sync.js:62`). Drive sync
(`readLocalDriveSyncDocument`) and portable export (same ceiling in
`export-schema.js`) validate identically. The existing `sanitizeTab()` truncation
runs only on the **restore** path (`tab-restore.js:31-52`), never at capture.

Reproduced against the real module:

```
$ bun brick-test.mjs   # session with a 20,000-char title / favicon data-URI
THROWS → Invalid Drive sync document: root.sessions[0].windows[0].tabs[0].title string exceeds the length limit
favicon THROWS → Invalid Drive sync document: root.sessions[0].windows[0].tabs[0].favIconUrl string exceeds the length limit
```

Failure scenario: any webpage sets a >16 KiB `document.title` (trivially
attacker-controlled, also occurs organically) or declares a large `data:` favicon
(multi-size icons routinely exceed 16 KiB base64). Hourly/daily **auto-save**
captures it with no user action. From that moment: every manual session delete
errors in the UI, auto-save cleanup fails silently forever (so auto-sessions
accumulate unboundedly), Drive sync fails, and full portable export fails — and the
poisoned session **cannot be deleted through the product**, because deletion
validates the whole collection before removing anything. Recovery requires DevTools
storage surgery.

Fix direction: apply capture-time sanitization symmetrical with the validator —
truncate titles (the restore path already picked 500 chars), cap or drop oversized
favicon values (scheme-allowlist them at the same time, which also closes F5), and
make `canonicalizeLocalSessions` degrade per-entity (sanitize-or-skip with a warning)
instead of failing the whole document, so one bad record can never hold the
collection hostage. Effort: small; the validator constants and the truncation helper
both already exist.

### F1 — HIGH: tombstone accumulation bricks deletion at the 10,000 cap

Evidence: `recordDeletionTombstones` throws when a new deletion would exceed
`MAX_DRIVE_TOMBSTONES_PER_KIND = 10_000` (`core/drive-sync.js:346-348`). Tombstones
are retained forever by design; there is no pruning, expiry, or compaction anywhere
(`grep prune/expire` across `core/` and `service-worker.js` — nothing). Every
deletion records one, including automated ones: auto-save rotation deletes expired
auto-sessions via `deleteSessions` (`service-worker.js:88`) — regardless of whether
Drive sync is even enabled.

Failure scenario: with `autoSaveIntervalHours: 1` (the allowed minimum,
`settings.js:55`) and 7-day retention, ~24 tombstones/day accumulate → the sessions
cap is reached in about 14 months. From that point, **every** `deleteSessions` call
for a not-yet-tombstoned ID throws: auto-save cleanup fails silently every hour
(`console.warn` only) so auto-sessions accumulate unboundedly, and the user's manual
"Delete" button errors with no recovery path in the product. At the default 24 h
interval the fuse is ~27 years — so this mainly threatens high-frequency
configurations, but the failure mode is permanent and undiagnosable from the UI,
hence High. The same fixed cap also means the sync document carries up to 10k dead
IDs per kind forever.

Fix direction: prune tombstones older than a horizon that safely exceeds any
realistic offline period of another profile (e.g. 180 days) during the locked sync
coordinator and during local deletion when near capacity. Pruning a tombstone only
risks resurrecting an entity from a device that has been offline longer than the
horizon — an acceptable, documentable trade-off, and the standard one for
tombstone-based CRDTs. See opportunity O4: add the horizon field to the schema now.

### F2 — MEDIUM: portable import crash window (detailed under fix #4 above)

`core/export-import.js:355-374`. Persist a small pending-import journal
(sections + phase) before phase 1; on worker startup, detect it and either roll
forward (re-apply from the journaled merged payload) or roll back, then clear it.

### F3 — MEDIUM: device-mode key protection is obfuscation; PBKDF2 iterations low

Evidence: device mode derives the AES key from a random UUID stored in the same
`chrome.storage.local` as the ciphertext (`crypto.js:16-23, 72-92`). Anything that
can read the extension's local storage (profile-directory malware, forensic copy,
cloud backup of the profile) holds both halves. This is inherent to
no-user-secret encryption and the passphrase mode exists precisely for stronger
protection — but PRIVACY.md/store copy should state the distinction plainly so users
with real key-compromise concerns choose passphrase mode. Separately,
`PBKDF2_ITERATIONS = 100_000` (`crypto.js:9`) is below OWASP's current
recommendation for PBKDF2-HMAC-SHA256 (600k); for the passphrase path this materially
lowers brute-force cost. Raising it is a one-line change plus transparent re-encrypt
on next successful unlock/save — cheapest if the blob gains a version/iterations
field now (opportunity O2).

### F4 — LOW: no sender assertion on the runtime message/port surface

`service-worker.js:1131` ignores `_sender`; `onConnect` (`:898`) checks only the port
name. Today this is safe (no content scripts, no `externally_connectable`), but the
entire handler map — including AI credential save/unlock and destructive Drive
cleanup — hangs off this one listener. If any future wave adds a content script or
external connectivity, this becomes the pivot. One guard
(`sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''))`)
future-proofs it cheaply.

### F5 — LOW: stored favicon URLs rendered without scheme validation

`stash-list.js:136` sets `img.src = tab.favIconUrl` from IndexedDB records. Favicon
URLs are attacker-influenced (a page declares its own favicon URL) and portable
import does not scheme-restrict them; MV3's default CSP for extension pages does not
restrict `img-src`. Scenario: a stashed or imported tab carries
`favIconUrl: "https://tracker.example/p.gif"` → opening the Stash view pings the
remote host with the user's IP whenever the panel renders. `sanitizeTab()` already
implements the right allowlist (`tab-restore.js:38-48`) but runs only on the restore
path — apply it at stash-save and import-validation time too (same change as F10's
capture-time sanitization), or at render. Also a PRIVACY.md declaration gap (see
Store compliance).

### F6 — LOW: bookmark HTML export lacks href scheme filtering

`service-worker.js:472` writes `<a href="${esc(tab.url)}">`. `esc()` correctly
escapes quotes (`:448`), so no attribute breakout — but a `javascript:` URL survives
escaping intact. Live tabs can't carry `javascript:` URLs, but imported portable
bookmarks are only validated as bounded strings. Scenario: malicious shared backup →
import → Drive HTML export → user opens the exported file and clicks a link. Filter
to `http(s)` at generation time (helper already exists in `tab-restore.js`).

### F7 — LOW: Drive client residual gaps

(a) `Retry-After` is honored without a ceiling (`drive-client.js:121`) — a hostile/
buggy 429 can park the coordinator for arbitrary minutes inside the mutation lock
(and the MV3 worker will usually be reaped mid-sleep, aborting the sync anyway); cap
at ~60 s. (b) `listDriveProfiles` (`:459`) and `listDriveExports` (`:524`) still use
raw `resp.json()` and skip `validateListedFile`, unlike every other read path that
goes through `readBoundedJsonResponse`; metadata-only, but inconsistent with the
stated "one bounded byte reader" architecture claim.

### F8 — LOW: `importStashes` awaits inside an IndexedDB transaction

`stash-db.js:91-118` interleaves `await` on wrapped `get` requests with `put` calls
in one transaction. This works in current Chrome (microtask timing keeps the
transaction alive) but is the classic fragile IDB pattern and inconsistent with the
carefully-written `replaceAllStashes`. Use cursor iteration or collect-then-write.

### F9 — INFO: attribute-context escaping in focus-panel

`focus-panel.js:327,332` interpolate `this._esc(d)` into `data-domain="…"` attribute
context; `_esc` (div/textContent trick, `:764-768`) does not escape quotes. Not
exploitable today because domain entries pass `canonicalHostname()` (URL parsing
rejects quotes) before storage — but the escaping helper's contract doesn't match its
usage. Add quote escaping to `_esc`/`escapeHtml` once, repo-wide.

---

## Ranked improvements (growth-first calibration)

Ranking principle per the owner: (1) what makes the core loop bulletproof and
obviously trustworthy for the *next* user, (2) Store standing, (3) polish. Data-loss
prevention still leads — a new user who loses a stash in week one never comes back.

1. **G1 — Capture-time sanitization (fixes F10, closes F5 in the same change).**
   Effort: S. The single highest-leverage fix in the repo: one pathological webpage
   must never be able to poison save/delete/sync/export. Truncate titles, allowlist
   and cap favicons at capture, and make collection canonicalization degrade
   per-entity instead of failing whole. Includes a regression test with a >16 KiB
   title.
2. **G2 — First-run experience.** Effort: M. Today install auto-opens the panel
   (`service-worker.js:925-931`) and then leaves the user alone; help hides behind
   `?`. There is no first-run tour, and empty states are inert text. A one-time
   3-step card (Group your tabs now → Stash a window → Sessions have your back) plus
   empty-state CTAs is the biggest install→retained-user conversion lever available.
3. **G3 — AI-less excellence.** Effort: S–M. Most new installs will have no API key.
   Today a no-key "Smart Group" click surfaces a raw error toast
   (`tab-list.js:540-542` → "Smart grouping failed: …") with no path to setup. Every
   AI touchpoint should degrade to an inviting one-tap "Set up AI (1 min) — or use
   Chrome's built-in, no key needed" state; auto-detecting an available Chrome
   built-in model and offering it as the zero-config default is the differentiator
   most worth polishing.
4. **G4 — Store trust package.** Effort: S. Preempt the `tabs`-permission install
   warning in the listing copy ("we never read page content — here's why a tab
   manager needs this"), add the two missing PRIVACY.md sentences (favicon service in
   exported HTML; stash-preview favicon fetches), and ship core-loop screenshots.
   Cheap insurance for a small extension's Store standing.
5. **G5 — Tombstone pruning (fixes F1) + opportunity O4.** Effort: S–M. Removes the
   second High; do it now while changing tombstone schema affects nobody.
6. **G6 — Schema opportunities O1–O3** (persisted session migration, versioned key
   blobs, unified IDs). Effort: S each. Pure "cheapest now" plays — every week of
   delay converts these from a code change into a migration.
7. **G7 — Pending-import journal (fixes F2).** Effort: M. Real but rare crash
   window; demoted under the no-install-base calibration.
8. **G8 — Credential hardening (F3) + sender guard (F4).** Effort: S–M. 600k PBKDF2
   via versioned blobs (after G6/O2), one sender assertion, one PRIVACY.md
   threat-model paragraph.
9. **G9 — i18n + a11y pass.** Effort: M–L. No `_locales/` exists — every string is
   hardcoded English — and ARIA is nearly absent outside `panel.html` and global
   search; toasts lack `aria-live`, overlays lack focus traps. Retrofit cost only
   grows; still behind the first-five-minutes items for a near-zero install base.
10. **G10 — Input-hygiene sweep (F6, F7, F8, F9).** Effort: S. Mechanical,
    well-testable, closes every remaining Low.

## What I did not review

- `core/focus.js` (1,155 lines), `core/grouping.js`, `core/engine/*` solver/planner
  internals, and most of `sidepanel/components/ai-settings.js` beyond the credential
  flows — spot-checked entry points and rendering/escaping surfaces only. The Focus
  lifecycle claims in ARCHITECTURE.md are extensively documented and test-covered
  (`tests/core/focus-*.test.js`, `tests/integration/focus-*.test.js`) but I did not
  independently re-derive that state machine.
- Runtime behavior in real Chrome: this is a static review plus the Bun suite and
  one targeted reproduction script (F10). OAuth flows, Prompt API behavior, IndexedDB
  timing (F8), and the SW-death windows (F2) were traced in code, not reproduced
  live.
- The live Chrome Web Store listing itself (copy, screenshots, declared-data form) —
  compliance was audited against the repo's PRIVACY.md/TERMS.md/store/ files and the
  code, not the dashboard. The published Store version was not confirmed; update
  safety was audited from the earliest tagged shapes (v1.2.5+) and the initial
  commit.
- The CI workflow, Windows packager internals, and the archived SDD evidence set
  (verified by v1.2.17/18 changelog gates, not re-executed).
- Provider adapters were checked for signal threading, auth-header placement, and
  key-reflection scanning — not for API-contract correctness against current
  OpenAI/Anthropic/Gemini schemas.

— Fable (pinned review subagent), 2026-07-20 (updated same day for the
published-extension addendum and the near-zero-users recalibration)
