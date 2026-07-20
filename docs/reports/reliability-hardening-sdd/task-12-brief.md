# Task 12 Implementation Brief

## Objective

Implement the approved Task 12 slice from `docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md`: make passphrase-protected API keys unlockable after a full browser restart, expose only public AI configuration over runtime messaging, and replace split settings/key writes with one validated, worker-serialized protection transition.

- Base commit: `2970c99f7284f080a7a0b3a0df401771c5944d99`
- Expected version/tag after controller closeout: `1.2.14`
- Finding: 7
- Phase checkpoint: Phase 3 credential-safety foundation; Task 13 consumes the resulting AI client without changing its settings contract
- Worktree: `/home/michel/projects/tabkebab-chrome-ext/.worktrees/reliability-hardening`
- Implementation report: `/home/michel/projects/tabkebab-chrome-ext/.git/worktrees/reliability-hardening/sdd/task-12-report.md`

Start only from the controller-confirmed clean Task 11 commit. The implementer verifies `git rev-parse HEAD` equals `2970c99f7284f080a7a0b3a0df401771c5944d99` before creating tests or production changes.

Task 11 is also the Phase 2 release checkpoint. Before replacing the placeholder or dispatching Task 12, the controller must finish the `v1.2.13` commit/tag/push, verify exact-commit CI, and create and verify the Phase 2 GitHub release. Do not mix the current uncommitted Task 11 tree with Task 12 credential work.

Read the approved design, ADRs 0001-0003, every later committed ADR, and the committed Task 7-11 interfaces before coding. Preserve Task 7's one worker-local FIFO state-mutation lock, Task 9/10's secret-free portable AI boundary and encrypted-key preservation, and Task 11's `sendOrThrow()` request contract. If a committed interface differs, report the exact conflict rather than creating a second lock, settings schema, encryption format, or messaging helper.

Do not tag, push, publish a release, mutate `main`, or touch the parent checkout. The root controller owns those steps after independent review. Do not implement Task 13 abort/retry lifecycle or Task 14 Chrome-AI broker/port behavior.

## Required files

Create:

- `tests/ai/ai-client-passphrase.test.js`

Modify only as needed within Task 12 scope:

- `docs/reports/2026-07-14-reliability-smoke.md`
- `core/ai/ai-client.js`
- `core/ai/provider.js`
- `service-worker.js`
- `sidepanel/components/ai-settings.js`
- `sidepanel/panel.html`
- `sidepanel/panel.js`
- `tests/core/portable-worker.test.js`
- `GUIDE.md`
- `PRIVACY.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `PROGRESS.md`
- `VERSION`
- `manifest.json`
- the Task 12 checklist in the approved plan
- an existing dependency-free test helper only after a genuine missing boundary is demonstrated RED

The three additions above correct stale omissions in the canonical Task 12 file list:

- `tests/core/portable-worker.test.js` currently requires the unsafe split `setAIApiKey` action to exist. Replace that assertion with lock coverage for the atomic `saveAISettings` and `unlockAIApiKey` actions; retaining the bypass is not an acceptable way to satisfy the old test.
- `sidepanel/panel.js` owns command-bar/body/status availability, but its listeners currently react only to local `aiSettings` changes. Unlock changes session state, so the shell needs an awaited refresh callback or an equally checked session-change listener.
- `ARCHITECTURE.md` must record the new public/private settings boundary, atomic transition, blob-bound session cache, and lock-aware availability.

Do not change `core/ai/crypto.js`, PBKDF2/AES-GCM parameters, encrypted-blob shape, queue behavior, provider fetch/signal/retry behavior, or the portable export schema. Task 12 uses the existing encrypt/decrypt boundary; it does not implement Task 13 request lifecycle behavior. The Task 12 plaintext-boundary correction below does change how test/model-list provider configuration is assembled: the worker builds it from private persisted state rather than trusting an action-supplied raw config. No new ADR is required unless implementation would contradict an accepted decision.

## Prerequisite contracts

Consume rather than redefine the committed equivalents of:

```js
// Task 7 worker ownership
export async function withStateMutationLock(operation);

// Task 11 checked side-panel request boundary
export async function sendOrThrow(message);

// Existing crypto boundary
encryptApiKey(plainKey, passphrase);
decryptApiKey(encryptedBlob, passphrase);
```

The `saveAISettings` and `unlockAIApiKey` worker actions are state-changing entry points and must run through the existing worker lock. Core methods called from that critical section do not reacquire it. This serializes saves/unlocks with Task 10 portable import so a stale read-transform-write cannot lose an encrypted key or cache plaintext for a replaced blob.

## Fixed client and runtime interfaces

Keep the approved names and response shapes exactly:

```js
AIClient.needsPassphrase(providerId); // Promise<boolean>
AIClient.unlockApiKey(providerId, passphrase); // Promise<void>
AIClient.saveConfiguration(publicSettings, keyUpdates, passphrase);
// Promise<{ saved: true, unlocked: boolean }>
AIClient.getPublicSettings();

{ action: 'needsAIPassphrase', providerId }
// -> exactly { needsPassphrase: boolean }

{ action: 'unlockAIApiKey', providerId, passphrase }
// -> exactly { unlocked: true }

{
  action: 'saveAISettings',
  settings,
  keyUpdates: [{ providerId, plainKey }],
  passphrase: string | null,
}
// -> exactly { saved: true, unlocked: boolean }

{ action: 'testAIConnection', providerId }
// -> exactly { success: boolean }

{ action: 'listModels', providerId }
// -> exactly { models: Array<{ id: string, name: string }> }
```

`getAISettings` calls `AIClient.getPublicSettings()`. Remove the split public `setAIApiKey` route after all current callers are migrated; retain a legacy internal method only if `rg` proves a non-runtime caller still needs it and focused tests cover it. No runtime response may contain a raw key, passphrase, encrypted blob, salt, IV, ciphertext, install ID, session-cache value, or private settings object.

The last two request shapes are a mandatory correction to the current unsafe boundary. The panel must not send `config`, `apiKey`, or a newly entered key to test/model-list actions. `AIClient` reconstructs the provider's model, Custom endpoint, and optional key from private persisted settings plus a fingerprint-valid session entry. Reject action-supplied `config` or private fields before provider or network work.

## Plaintext request boundary

The plan permits a newly entered plaintext key/passphrase only in the checked one-shot `saveAISettings` request needed for immediate encryption. Current `AISettings.buildProviderConfig()` also places raw input keys in `testAIConnection` and `listModels`; Task 12 must remove that path because no later task modifies the AI settings component.

- If a provider key or relevant Custom endpoint/model edit is still unsaved, do not send a provider action. Display exactly `Save AI settings before testing or loading models.`
- If the selected provider has a passphrase blob but no valid session entry, do not send a provider action. Display exactly `Unlock this provider before testing or loading models.`
- After a successful atomic save and any required unlock, test/model-list requests contain only `action` and `providerId`; the worker reconstructs private provider configuration.
- The worker rejects an injected `config`, `apiKey`, passphrase, endpoint override, or other private action field. Tests prove the injected value reaches neither the provider nor a runtime response/log.
- Public Custom `baseUrl` is persisted and validated before it can be used. Accept only the intended HTTP(S) endpoint form; reject malformed schemes, embedded credentials, and unbounded values without echoing them in an error.

## Public settings shape and private boundary

`getPublicSettings()` constructs a fresh allowlisted object. It never clones private settings and deletes secrets afterward:

```js
{
  enabled: boolean,
  providerId: 'openai' | 'claude' | 'gemini' | 'chrome-ai' | 'custom' | null,
  providerConfigs: {
    openai: { model, hasApiKey, usesPassphrase },
    claude: { model, hasApiKey, usesPassphrase },
    gemini: { model, hasApiKey, usesPassphrase },
    'chrome-ai': { model, hasApiKey: false, usesPassphrase: false },
    custom: { model, baseUrl, hasApiKey, usesPassphrase },
  },
  protectionMode: 'device' | 'passphrase' | 'mixed',
}
```

- `hasApiKey` and `usesPassphrase` are booleans derived from each stored encrypted blob. They are output-only metadata and are rejected if echoed in a save request.
- `protectionMode` considers stored key blobs, not the legacy global flag: all device blobs -> `device`; all passphrase blobs -> `passphrase`; both -> `mixed`. With no stored key blob, report `device`.
- `usePassphrase` and private `apiKey` blobs never cross the runtime boundary. A stored `usePassphrase` value may remain internally for compatibility, but it is not public authority.
- Preserve recognized model values and Custom `baseUrl`. Do not expose unknown provider/config fields.
- Return fresh values without mutating the private stored object.

The editable `settings` request is an own-property allowlist containing `enabled`, `providerId`, recognized provider model fields, Custom `baseUrl`, and desired `protectionMode`. Reject arrays, inherited/dangerous keys, unknown providers/fields, private/status fields, malformed types, and a selected provider outside `ProviderId` before crypto, local storage, or session storage is called.

## Passphrase truth and unlock semantics

- Validate `providerId` against the fixed provider enum before storage. Key updates are allowed only for OpenAI, Claude, Gemini, and Custom; Chrome AI never accepts one.
- `needsPassphrase(providerId)` reads the selected provider's own encrypted blob and accepts a session cache entry only when that entry is bound to the current blob identity. It returns true only when a stored blob exists, its own `usesPassphrase === true`, and no fingerprint-valid session key is cached. The legacy global flag cannot make a device blob require a passphrase or make a protected blob appear unlocked.
- Missing keys and device-protected keys return false from `needsPassphrase()`.
- `unlockApiKey()` requires a non-empty string passphrase and a known provider. It decrypts only that provider's passphrase-protected stored blob. Any decrypt/authentication failure becomes exactly `AIAuthError('Incorrect passphrase')` with no raw crypto error or secret-bearing cause in a runtime response.
- A successful unlock stores decrypted material only under `aiDecryptedKey_<providerId>` in `chrome.storage.session` and returns no key. Bind the entry to a non-secret deterministic identity of the current encrypted blob so a cache value for an older blob is never accepted. The worker maps the void result to exactly `{ unlocked: true }`.
- A merely truthy or legacy raw session value is not proof that it belongs to the current blob. An already fingerprint-valid session entry makes unlock idempotently successful without rewriting local encrypted settings. Unlocking never changes blob protection metadata.
- No plaintext is written to local storage, logged, included in an exception message, or returned.

## Lock-aware availability

`AIClient.isAvailable()` must reflect whether the configured provider can be used now, not merely whether encrypted bytes exist:

| Provider state | `isAvailable()` |
| --- | --- |
| OpenAI/Claude/Gemini passphrase blob with no or stale session entry | `false` |
| OpenAI/Claude/Gemini passphrase blob with fingerprint-valid session entry | `true` |
| OpenAI/Claude/Gemini device blob | `true` |
| Required cloud-provider key absent | `false` |
| Custom base URL with no stored key | `true` |
| Custom with a stored passphrase key that is locked | `false` |
| Custom with a device key or fingerprint-valid unlocked passphrase key | `true` |
| Chrome AI selected | configured/available under the existing Task 12 contract; model/runtime availability remains its existing connection test |

Wrong unlock cannot flip availability. Correct unlock must refresh both the AI settings component and the panel shell's command bar, body class, provider label, and status icon. Use an optional awaited callback injected by `sidepanel/panel.js`, or a session-storage listener that examines cache key names only and handles refresh rejection explicitly. Do not read, log, or forward the session change value.

## Protection transition truth table

`publicSettings.protectionMode` is the requested mode. `passphrase` is an own required request field, but it carries encryption material only when this transaction encrypts one or more replacement blobs into passphrase mode:

- Target `passphrase` with one or more `keyUpdates` requires a non-empty string passphrase.
- A public-only edit that preserves existing uniform passphrase blobs requires `passphrase === null`; it does not force needless passphrase re-entry and it preserves every blob byte-for-byte.
- Target `device` requires `passphrase === null`.
- `mixed` is preservation-only: it is accepted only when the current stored blobs are mixed, `keyUpdates` is empty, and the save changes public model/provider/endpoint fields only. Its passphrase is null.
- Except for preservation-only `mixed`, the requested mode must equal the mode derived from the resulting blobs. Because zero blobs derive `device`, a `passphrase` target with no current or replacement key is unrealizable and rejects before any write.
- Missing `passphrase`, an empty passphrase where encryption requires one, a non-string/non-null value, an unnecessary secret on a no-encryption save, or any inconsistent mode/passphrase pair rejects before any write.

Apply these transition rules:

| Current blobs | Requested operation | Required key updates |
| --- | --- | --- |
| Uniform mode | Public edits only, same mode | None; preserve every private blob byte-for-byte |
| Uniform mode | Replace a subset, same mode | Exactly the supplied unique providers; preserve other blobs |
| Uniform mode | Change device <-> passphrase | Replacement plaintext for every stored key provider |
| Mixed mode | Public edits only, preserve `mixed` | None; preserve mixed blobs byte-for-byte |
| Mixed mode | Any key replacement or normalization | Select `device` or `passphrase` and supply every stored provider key |
| No stored keys | Add keys | Encrypt supplied unique keys in the selected device/passphrase mode |

- `keyUpdates` must be a dense array of own plain objects with exactly `providerId` and a non-empty string `plainKey`. Reject duplicate providers and unknown/no-key providers before encryption.
- A protection change missing even one required stored provider replacement rejects before encryption/storage and leaves local settings plus session cache byte-for-byte unchanged.
- Encrypt every replacement successfully in memory before the one canonical local settings write. One encryption failure writes nothing.
- Persist `usePassphrase: true` for normalized passphrase mode, `false` for normalized device mode, and `null` only while deliberately preserving a legacy mixed set. A successful normalization never leaves `mixed` metadata.

## Atomic persistence and session-cache order

`saveConfiguration()` follows this order inside the existing worker critical section:

1. Read the private current `aiSettings` once.
2. Validate and canonicalize the complete public request, key-update list, desired mode, and transition requirements.
3. Build a fresh next private settings object, preserving every private blob not replaced.
4. Encrypt all required replacements in memory.
5. Perform exactly one canonical local `aiSettings` write.
6. Only after local commit, update affected `chrome.storage.session` cache entries in one best-effort batch.
7. Return exactly `{ saved: true, unlocked: true }` when the cache update required for this save succeeds; on cache failure retain the valid encrypted local commit, make affected old cache entries unusable/locked, and return exactly `{ saved: true, unlocked: false }`.

A local settings write failure propagates as a checked error and leaves the pre-call session cache unchanged. A post-commit session failure never rolls back valid encrypted settings or returns an ambiguous top-level failure. Tests must begin the cache-failure case with stale affected session entries and prove none can be consumed for the new blobs; implementation may invalidate them or bind cache entries to blob identity, but it must not add another persistent secret key.

The “one local write” invariant means exactly one canonical `aiSettings` write. Existing device-mode encryption may provision the separate `installId` through the unchanged crypto boundary. Seed it in call-order tests, and add a fresh-profile multi-provider device test proving all blobs use one consistent install ID. Do not launch first-time device encryptions concurrently: parallel `getInstallId()` calls can generate different device secrets before either write becomes visible.

For a public-only save with no replacement cache batch, define `unlocked` from the selected provider's resulting lock state rather than treating “nothing to cache” as vacuous unlock success. A selected locked passphrase provider returns `unlocked: false`; a device/no-key/Chrome configuration returns the appropriate lock-free result. Pin this with tests so the response name has one deterministic meaning.

Every success/error/log scan uses distinctive sentinel key/passphrase/ciphertext values and proves they occur only in the one-shot request or private storage adapter where inherently required. Do not print those sentinels in the report; record hashes/counts and boolean absence checks only.

## Side-panel behavior

- Task 11's `AISettings.send()` remains a `sendOrThrow()` adapter. All new handlers await it; returned `{ error }` and transport failures produce failure UI only.
- Add exactly `#ai-unlock-section`, `#ai-unlock-passphrase`, `#btn-unlock-ai`, and `#ai-unlock-result`.
- Refresh and provider selection call `needsAIPassphrase` for the selected provider through an awaited/caught handler. Hide/reset the unlock section when false; show it when true. No new event callback may leak an unhandled checked rejection.
- Correct unlock requires the exact `{ unlocked: true }` response, clears the passphrase input, shows success, invokes the panel-owned availability refresh, and hides the section once `needsPassphrase` becomes false. Wrong unlock shows failure only and performs no success toast/state mutation.
- Public `hasApiKey` drives key placeholders. The UI never receives or tests for `config.apiKey`.
- `protectionMode === 'mixed'` sets the protection checkbox's `indeterminate` state and remains mixed during model/endpoint-only saves. A deliberate user toggle clears indeterminate and chooses device/passphrase; do not collapse mixed mode merely because `checked` is false.
- Build one exact allowlisted settings object and one unique `keyUpdates` array, then send one `saveAISettings` request. Do not spread the public response back into the request because its `hasApiKey`/`usesPassphrase` fields are output-only. Remove the settings-first/key-loop behavior.
- Validate the exact `{ saved: true, unlocked: boolean }` response. On ordinary success, clear submitted key/passphrase inputs only after resolution. On committed-but-locked success, clear the now-persisted secret inputs, render an explicit saved-but-locked warning, refresh public settings, and do not show the ordinary success toast.
- A rejected transition displays exactly `Re-enter every saved API key before changing key protection.` when all-provider replacement is required; it never clears the inputs or claims partial success.
- `testConnection()` and `loadModels()` use the plaintext-boundary rules above. A non-empty key input or other relevant dirty persisted configuration produces the save-first copy and zero runtime/provider calls. A locked provider produces the unlock-first copy and zero runtime/provider calls.
- `sidepanel/panel.js` injects one checked availability refresh seam into `AISettings`, or owns an equivalent safe session listener. After right unlock, both `updateAIVisibility()` and `updateAIStatusIcon()` settle; failure is reported/handled without reversing the successful unlock.

Do not add a DOM emulator. Automated tests own the core/runtime secret and transaction boundary; the real-Chrome gate owns rendered unlock behavior.

## Mandatory strict TDD sequence

Do not change production behavior until steps 1-12 exist and step 13 has produced genuine RED evidence.

1. Create `tests/ai/ai-client-passphrase.test.js` and isolate AIClient/worker imports with restored module/global stubs.
2. Add `needsPassphrase` cases: protected locked, fingerprint-valid cached, stale/legacy cached, device blob despite stale global true, passphrase blob despite stale global false, no key, Chrome/no-key provider, unknown provider, and legacy mixed blobs.
3. Add unlock cases: full session reset then correct unlock, wrong passphrase with exact typed error and unchanged session, already fingerprint-valid idempotence, stale cache replacement, missing/non-string/empty passphrase, no-key/device blob behavior, and exact `{ unlocked: true }` worker response.
4. Add public-settings tests for every provider/config flag, zero/uniform/mixed protection modes, fresh outputs/input immutability, and recursive absence of blob/ciphertext/salt/IV/private-passphrase/install/session fields. Permit only the intended boolean `usesPassphrase` output metadata.
5. Add malformed runtime/save cases: unknown provider, inherited/dangerous/unknown fields, missing/inconsistent passphrase, malformed/sparse key-update arrays, unknown/no-key update providers, duplicate provider updates, output-only metadata echoed as input, and invalid/unbounded/credential-bearing Custom endpoints. Assert zero crypto/local/session/provider mutation.
6. Add the complete protection truth table: same-mode public edit; same-mode subset replacement; both direction changes requiring every stored provider; mixed preservation; mixed replacement/normalization requiring every key; and new device/passphrase keys.
7. Add call-order/atomicity tests proving all validation/encryption precedes one canonical `aiSettings` write, session follows local, local failure preserves prior local/session bytes, encryption failure writes no `aiSettings`, and private blobs not replaced are byte-identical.
8. Add a fresh-profile multi-provider device-encryption case proving all replacements decrypt under one provisioned install ID; do not hide a concurrent first-install race by seeding the ID in this case.
9. Inject session-cache failure after local success, beginning with stale affected session entries. Assert valid committed ciphertext, `{ saved: true, unlocked: false }`, stale entries unusable by `getApiKey()`/availability, and later `unlockApiKey()` repopulation. Cover successful all-provider replacement in both protection directions.
10. Add lock-aware availability cases for every row in the table above, including Custom-without-key, Custom locked key, wrong unlock, correct unlock, and a public-only save of an already locked selected provider.
11. Add worker/action tests proving `getAISettings`, `needsAIPassphrase`, `unlockAIApiKey`, and `saveAISettings` return the exact public shapes; the removed `setAIApiKey` action is unavailable; and `saveAISettings` plus `unlockAIApiKey` each have one outer worker-lock boundary. Update the stale action assertion in `tests/core/portable-worker.test.js` rather than retaining the bypass.
12. Add plaintext-boundary tests. Reject `testAIConnection`/`listModels` messages containing `config` or private fields before provider work; prove valid requests contain only action/provider ID and reconstruct config from private state. Import Task 11's `AISettings` without a DOM shim, preserve its checked adapter, and assert source/pure seams enforce the exact save-first and unlock-first copy with zero runtime call. Leave rendered unlock/mixed-checkbox assertions to real Chrome.
13. Run the pre-change focused suite and preserve genuine RED output in `task-12-report.md`:

    ```bash
    bun test tests/ai/ai-client-passphrase.test.js
    ```

    Expected RED causes are the missing unlock/runtime route, private `getAISettings` response, global-flag passphrase check, unbound session cache, lock-unaware availability, split settings/key writes, raw test/model-list config, stale lock assertion, non-atomic protection transitions, and absent session-failure semantics.
14. Implement the minimum Task 12 production slice and make the focused suite GREEN. Do not add Task 13 signals/errors/queue changes or Task 14 ports.
15. Re-run the focused command and record exact pass/fail/expect counts.
16. Run every final gate freshly and record its output:

    ```bash
    bun --version
    bun test tests/ai/ai-client-passphrase.test.js
    bun test tests/core/portable-worker.test.js tests/core/export-schema.test.js tests/core/export-import.test.js tests/sidepanel/component-messaging.test.js
    bun test
    bun test --coverage
    bun test tests/syntax.test.js
    git diff --check
    test "$(cat VERSION)" = "$(bun -e 'console.log((await Bun.file("manifest.json").json()).version)')"
    test -z "$(find . -maxdepth 1 -type f \( -name 'package.json' -o -name 'package-lock.json' -o -name 'bun.lock' -o -name 'bun.lockb' -o -name 'yarn.lock' -o -name 'pnpm-lock.yaml' \) -print)"
    git status --short
    ```

    Bun remains `1.3.11`; focused/full/coverage/syntax runs pass; `git diff --check` is clean; both versions equal `1.2.14`; no root package/lockfile exists. Record coverage honestly without inventing a repository-wide threshold.

Restore every crypto method, clock, console method, storage adapter, runtime handler, and module stub in `finally`. No test order dependence, production failure hook, plaintext fixture in documentation, DOM/IndexedDB emulator, dependency, or build step is allowed.

## Real-Chrome credential gate

Use the installed official Chrome for Testing, a disposable profile, and synthetic credentials/provider fulfillment only. Do not use a real provider key or expose the synthetic key/passphrase in commands, logs, screenshots, or evidence.

1. Generate the synthetic provider key and passphrase at runtime in memory. In the real side-panel document, save the key with passphrase protection through the one atomic action. Record only provider ID, protection mode, exact response shape, and redacted/hash equality; never place either secret in a command, fixture output, screenshot, or tracked document.
2. Fully exit Chrome and verify cleanup of the first process before relaunching the same disposable user-data directory. Extension reload or worker suspension alone is not a browser restart.
3. Before panel code can unlock anything, confirm `chrome.storage.session` contains no decrypted-key entry after restart while the local encrypted blob hash is unchanged and `getAISettings` reports only `hasApiKey: true`, `usesPassphrase: true`, and `protectionMode: 'passphrase'`.
4. Confirm the Unlock UI appears, the command bar/body/status are unavailable, and the key placeholder comes from `hasApiKey`, not a private blob. Submit a wrong passphrase and require a checked failure, no success UI, availability still false, identical local/session state hashes, and no secret in service-worker/panel logs.
5. Submit the correct passphrase. Require exact `{ unlocked: true }`, cleared input, hidden unlock prompt after refresh, a session entry by key name/presence only, and refreshed command bar/body/status availability true.
6. Click the production Test Connection flow. Require its runtime request to contain only action/provider ID, then fulfill exactly one provider request with CDP or an equivalently credential-free loopback response before external network. Compare the authorization value to the in-memory synthetic key without printing either. Label the result synthetic: it validates unlock-to-provider plumbing, not external authentication or provider quality.
7. Recursively scan captured worker/panel console entries and every runtime response for the actual in-memory secret markers without printing the markers. Require zero plaintext/passphrase/ciphertext disclosure, zero unexpected provider attempts, and zero external requests reaching network.
8. Record exact Chrome build and binary SHA-256, generated extension ID, exact tested worktree tree, first-process exit proof, redacted state/result booleans, provider attempt count, and cleanup commands/counts. The generated unpacked ID need not match the documented OAuth dev/store identity because Task 12 uses no Google OAuth or real credential.
9. Remove the disposable profile and stop every Chrome/Xvfb/CDP process/listener in `finally`; require zero matching processes and no retained synthetic credential material.

If the browser/provider boundary is unavailable, record the exact blocker and do not claim it passed. A Bun mock is not a substitute for the full-restart/session-clearing/UI gate.

## Documentation, version, report, and commit

- Update `GUIDE.md` with restart unlock, per-provider locked status, mixed-protection normalization, and the requirement to re-enter affected keys for a protection change.
- Update `PRIVACY.md` with the exact local encrypted/session-only plaintext boundary and state that unlock responses/logs never contain the key or passphrase. Correct the existing false statement that `chrome.storage.session` is wiped on every service-worker idle restart: it survives ordinary worker restarts and is cleared when the extension is disabled, reloaded, updated, or the browser restarts. Do not claim that provider prompts remain local for cloud providers.
- Update `ARCHITECTURE.md` with the fresh public settings projection, blob-authoritative protection mode, fingerprint-bound session cache, worker-serialized atomic save/unlock boundary, committed-but-locked failure semantics, lock-aware availability, and private provider-config reconstruction for test/model-list actions.
- Update `CHANGELOG.md` and `PROGRESS.md` with only behavior and evidence that landed. Do not claim abort-safe requests or Chrome-AI foreground brokering.
- Append redacted Task 12 browser evidence and cleanup to `docs/reports/2026-07-14-reliability-smoke.md`.
- Set `VERSION` and `manifest.json` to `1.2.14`.
- Close a Task 12 plan checkbox only after its named RED/GREEN, transaction, documentation, or real-browser evidence exists.
- Write `task-12-report.md` in the established five sections: what was built; verification evidence with RED/GREEN/full-gate counts and secret-absence/browser evidence; assumptions; concerns/adjacent observations; close-out confirmation. Include the protection truth table, storage/session call order, public response scan, model/agent ledger, exact version comparison, full commit hash, and final clean-worktree result.
- Commit with author email `29182417+michelabboud@users.noreply.github.com` and trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- Leave the worktree clean and report the full commit hash. No tag, push, release, `main` mutation, parent-checkout mutation, real credential, or unredacted secret evidence.

After independent review, the controller will tag/push `v1.2.14`, wait for exact-commit CI, and verify the remote tag target. Task 12 is not the Phase 3 GitHub release checkpoint: do not create a Task 12 GitHub release, attach an artifact, or publish to the Chrome Web Store. The Phase 3/final GitHub release remains Task 15. The dependency audit remains not applicable because the repository has no root package or lockfile.

## Resolved plan/file conflicts

These corrections are mandatory even though the original Task 12 file list omitted them; the approved safety invariant wins over the stale enumeration:

1. Remove `setAIApiKey` and update `tests/core/portable-worker.test.js`; otherwise the old test forces an unsafe atomic-save bypass to remain.
2. Remove plaintext `config` from test/model-list runtime messages; the global one-shot plaintext rule cannot be deferred because later tasks do not modify `sidepanel/components/ai-settings.js`.
3. Make `isAvailable()` lock-aware and update `sidepanel/panel.js`; session-only unlock otherwise leaves global AI UI stale and locked providers falsely available.
4. Bind session plaintext to encrypted-blob identity; otherwise a committed blob replacement plus failed session write can send a stale old key.
5. Correct `PRIVACY.md` session-lifetime wording and update `ARCHITECTURE.md`; the current docs do not describe Chrome's actual session-storage lifetime or the new credential boundary.

## Approved checklist (complete Task 12 intent)

- The implementer starts from the controller-supplied reviewed Task 11 hash and consumes the existing worker lock and `sendOrThrow()` boundary.
- `needsPassphrase` trusts the selected blob plus a fingerprint-valid session entry, not stale global metadata or a merely truthy cache value; protected restart unlock works without returning a key.
- `getPublicSettings` is fresh and allowlisted, exposes only public config plus booleans/protection mode, and never crosses ciphertext/private metadata.
- Runtime inputs reject unknown/malformed/duplicate/private data before crypto or storage; every success/error/log response is secret-free.
- Uniform and mixed protection transitions follow the complete truth table; required all-provider replacement is fail-closed.
- Validation and all encryption precede one local settings write; session cache follows local commit; failures have the exact unchanged or committed-but-locked semantics.
- Affected stale session plaintext cannot survive a committed blob replacement.
- `isAvailable()` follows the provider-specific locked/device/Custom/no-key truth table; wrong unlock stays unavailable and correct unlock refreshes the panel shell through a checked seam.
- Test/model-list messages carry no raw provider config or key, provider configuration is reconstructed privately, and dirty/locked UI paths produce the exact save-first/unlock-first copy with zero provider call.
- The obsolete `setAIApiKey` runtime route and stale portable-worker assertion are removed; `saveAISettings` and `unlockAIApiKey` each use one outer worker lock.
- The UI uses one checked atomic save, preserves mixed indeterminate state, handles committed-but-locked responses explicitly, and provides a per-provider restart Unlock flow without optimistic success.
- Strict pre-change RED, focused GREEN, full Bun/coverage/syntax/whitespace/version/dependency gates, and honest coverage evidence are recorded.
- Real Chrome proves full-restart lock state, wrong/right unlock, one synthetic provider call, zero secret disclosure, and complete cleanup.
- No cryptography redesign, Task 13 request lifecycle, Task 14 broker, production dependency, build step, second lock, tag, push, or release is included.
- Guide/privacy/architecture docs, corrected session-lifetime wording, smoke evidence, version `1.2.14`, five-section report, model ledger, commit trailer, full hash, and clean worktree are complete before controller review.
