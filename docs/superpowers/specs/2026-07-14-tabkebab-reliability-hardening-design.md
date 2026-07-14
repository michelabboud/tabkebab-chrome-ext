# TabKebab Reliability Hardening Design

**Status:** Architecture approved on 2026-07-14; written specification awaiting review.

## Goal

Remove every confirmed code-review defect without a broad rewrite, establish automated regression protection, and restore trustworthy behavior for destructive tab operations, backups, Focus Mode, and AI integrations.

## Scope

This design covers all thirteen findings reported against commit `426ddf3`:

1. Incomplete stash restoration can delete the source stash.
2. Drive retention can delete canonical sync/settings files.
3. Stale Focus Mode AI and teardown actions can affect current tabs.
4. Focus startup ignores URL/group allowlists and strict-empty semantics.
5. Natural-language domain filters can match unrelated hosts.
6. Duplicate cleanup conflates hash routes and cannot Undo closed tabs.
7. Passphrase-protected keys cannot be unlocked after restart.
8. Chrome Built-in AI executes in an unsupported worker context.
9. Background errors can be rendered as successful UI operations.
10. Drive deletions resurrect and full export omits non-secret settings/data.
11. Global search omits every open tab.
12. Restored tabs remain muted.
13. AI timeouts can leave multiple billable requests running.

## Non-goals

- No framework, bundler, production dependency, or UI redesign.
- No rewrite of the grouping engine, service worker, Drive client, or side panel.
- No export of API keys, decrypted secrets, OAuth tokens, install identifiers, caches, or active Focus Mode state.
- No claim that Bun mocks validate Chrome itself; browser-only behavior remains a real-Chrome gate.
- No unrelated cleanup of legacy code or store content.

## Global constraints

- Chrome must continue loading the repository directly as a Manifest V3 extension.
- Runtime behavior remains dependency-free and telemetry-free.
- Bun `1.3.11` is the only new development prerequisite and is pinned; the extension gains no runtime dependency.
- Existing local data, Drive sync version 1, and export version 1 remain readable.
- All destructive operations fail closed and preserve a recoverable source on partial failure.
- Errors are structured for code but human-readable in the UI.

## Delivery strategy

Work proceeds as vertical hardening slices. Each slice starts with failing Bun tests, implements the smallest durable fix, passes the full test and syntax suite, updates relevant documentation, and closes independently. Data-loss and wrong-tab risks form the first release gate.

A tactical patch set was rejected because it would leave the message contract and testing problem in place. A large modular rewrite was rejected because it delays user-safety fixes and creates a larger regression surface.

## Architecture

### 1. Bun test boundary

Use the pinned `.bun-version`; add `bunfig.toml` and `tests/setup.js`. The preload exposes resettable Chrome API doubles, in-memory `chrome.storage.local`/`session`, event emitters, controllable tabs/windows/groups, runtime ports, and fake provider requests.

Tests import existing ESM directly. Browser-only integrations are isolated behind small functions or injected adapters so their policy can be tested without simulating a browser. IndexedDB CRUD and DOM rendering remain in Chrome smoke tests.

Coverage is reported for changed logic. The quality gate is behavioral coverage of every success and failure path in scope, not a repository-wide percentage inflated by trivial files.

### 2. Restore outcome and audio safety

Session and stash restoration return one consistent outcome:

```js
{
  requestedCount,
  restoredCount,
  skippedDuplicate,
  skippedInvalid,
  errors,
  complete
}
```

`complete` is true only when there are no invalid entries or errors and every requested tab is either restored or already open as a duplicate. Default delete-after-restore deletes a stash only when `complete` is true. An incomplete restore retains the original stash and reports exactly what was not restored.

Tabs are muted only while a discard pipeline needs to suppress loading audio. Tabs are unmuted after discard, and the initially visible tab is never left muted. Non-discarding restore modes do not mute tabs.

### 3. Focus Mode run identity and lifecycle

Each focus run receives a unique `runId`. Runtime states are `active`, `paused`, and `ending`. `endFocus()` persists `ending` before it recreates or ungroups tabs, so navigation listeners cannot block teardown work.

Every asynchronous distraction action validates all of the following immediately before `goBack` or removal:

- Stored state exists and is `active`.
- Stored `runId` matches the request's run.
- The tab still exists.
- The tab's current or pending URL still matches the classified URL.
- AI classification is `distraction: true` with confidence greater than `0.7`, including cached results.

Focus startup uses the same complete allowlist predicate as navigation blocking. Domain and exact-URL entries match directly. Persisted Chrome-group entries are resolved by exact group title to every matching current runtime group ID; stale numeric group IDs are not trusted across browser sessions. Strict mode with an empty allowlist blocks every non-internal URL.

### 4. Safe matching and duplicate recovery

Natural-language domain filters canonicalize an input host and match only exact hosts or subdomains:

```js
hostname === expected || hostname.endsWith(`.${expected}`)
```

Duplicate normalization preserves URL fragments. This prefers a false negative for ordinary anchor links over closing a distinct hash-routed application page. Duplicate records retain each tab's original URL; Undo reopens those original URLs rather than a normalized group key.

### 5. Drive retention, merge, and export

Retention considers only dated archive/export files. Canonical `tabkebab-sync.json` and `tabkebab-settings.json` are never candidates for automatic or manual age cleanup. The newest recoverable file in each dated category is also preserved when cleanup runs.

Drive sync adopts the version 2 tombstone format in ADR 0003. Local session/group removal records a tombstone, merge selects the greatest deletion timestamp, and an entity survives only when it is newer than the tombstone. Version 1 inputs migrate in memory and are written as version 2 only after a successful merge.

Portable export becomes version 2 and contains:

- Sessions, stashes, and manual groups.
- Keep-awake domains and bookmarks.
- General settings.
- Focus profile preferences and history.
- AI provider/model/custom-endpoint configuration with every `apiKey` removed.

Import validates every section before changing storage, snapshots the affected local records, merges by stable ID, preserves existing encrypted keys, and never imports Drive connection state or an active Focus session. A write failure restores the snapshot before reporting failure. Version 1 export files continue to import.

### 6. AI key and request lifecycle

The settings UI queries `needsPassphrase(providerId)`. An unlock action accepts a provider ID and passphrase, decrypts into `chrome.storage.session`, and returns only `{ unlocked: true }`; it never returns the key. A failed passphrase remains a checked error. Changing passphrase protection without supplying a replacement key is rejected rather than producing mismatched metadata.

Every provider accepts an `AbortSignal`. `AIClient` owns an `AbortController` per attempt and aborts it at timeout. Timeout and abort errors are non-retryable automatically; explicit user retry creates a new request. Network/rate-limit retry remains bounded, but only after the prior provider promise has settled.

Chrome Built-in AI follows ADR 0002. A named side-panel runtime port brokers request IDs and Prompt API results. Port disconnect rejects outstanding work. If no panel broker exists, the service worker returns a foreground-required error and background Focus Mode skips the request safely.

### 7. Runtime messaging and UI contracts

Add one side-panel message client:

```js
export async function sendOrThrow(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}
```

Every request/response component uses it. Broadcast events and long-lived Chrome-AI ports remain separate. Success toasts and state updates occur only after `sendOrThrow()` resolves.

`getGroupedTabs` is standardized as an array response. Global search accepts that array, flattens its `tabs`, and treats malformed/error responses as unavailable rather than as an empty successful search.

## Error handling principles

- Preserve source data on partial failure.
- Validate state at the point of side effect, not only when work begins.
- Treat AI output, remote Drive data, imported JSON, and runtime messages as untrusted data.
- Return deterministic counts and previews from validated local data.
- Never display success from an error-shaped response.
- Distinguish unsupported context, unavailable provider, authentication failure, timeout, cancellation, and network failure.

## Compatibility and migration

- Existing focus state without `runId` is treated as legacy and ended safely before a new run starts.
- Existing group allowlist entries retain their title/value and are rebound to live group IDs.
- Drive sync version 1 is read with empty tombstones.
- Export version 1 remains importable; export version 2 is always emitted after the change.
- Existing passphrase-encrypted blobs remain decryptable through the new unlock action.
- Existing session and stash records require no destructive migration.

## Automated verification

The Bun suite covers:

- Incomplete/complete stash deletion decisions and restore counts.
- Mute/discard/unmute ordering.
- Focus run mismatch, pause/end, URL change, cached confidence, allowlist type, group rebinding, and strict-empty behavior.
- Exact/subdomain natural-language matching.
- Hash-route duplicate separation and Undo URL capture.
- Retention exclusions and newest-archive preservation.
- Tombstone creation, two-profile merge, delete-vs-update ordering, and version 1 migration.
- Export sanitization, schema validation, version 1 import, preflight rejection, and write-failure rollback.
- Passphrase unlock success/failure without key disclosure.
- Timeout abort and retry classification.
- Chrome-AI port connect, request correlation, disconnect, timeout, and absent-panel behavior.
- `sendOrThrow()` and representative component success/error paths.
- Global-search array flattening.

Required commands at every implementation closeout:

```bash
bun test
bun test --coverage
bun test tests/syntax.test.js
```

The Bun syntax test parses every tracked JavaScript file and validates `manifest.json`, so verification does not require Node.

## Real-Chrome smoke matrix

Load the unpacked extension in a clean Chrome profile and verify:

1. Complete and forced-partial stash restores, including retained recovery data.
2. Session/stash restore audio state before and after discard.
3. Focus pause/end during delayed classification, strict-empty behavior, URL allowlist, and group allowlist after browser restart.
4. Duplicate cleanup/Undo with ordinary URLs and two distinct hash routes.
5. Natural-language close preview against lookalike domains.
6. Drive version 1 migration, two-profile deletion convergence, canonical retention, and full export/import.
7. Passphrase unlock after full browser restart.
8. Chrome Built-in AI with the panel open and graceful failure after panel closure.
9. Provider timeout cancellation with one observed network attempt.
10. Forced background errors display failure and never success.
11. Ctrl+K returns tabs, stashes, and sessions.

## Acceptance criteria

The initiative is complete only when all thirteen findings have a failing regression test before their fix, the automated suite passes, the Chrome smoke matrix passes with evidence, user-facing documentation matches actual behavior, and the released artifact is verified at its exact commit.

No finding may be closed solely because the implementation looks correct or because syntax/LSP checks pass.

## Risks and mitigations

- **Service-worker concurrency:** use run IDs, request IDs, and port-disconnect rejection rather than mutable implicit state.
- **Remote merge mistakes:** keep merge functions pure, migrate version 1 in memory, and retain tombstones.
- **False browser confidence from mocks:** keep a mandatory real-Chrome matrix for every browser-only boundary.
- **Scope growth:** extract only seams directly needed by the thirteen findings; unrelated refactors remain out of scope.
- **Credential exposure:** sanitize by allowlist and test that secret-bearing keys never appear in serialized exports or messages.
