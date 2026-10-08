# Full Code Review — Repair Plan

Source: full-codebase review of `main` @ d8a0e6d (2026-10-08). 900/900 tests passed at review time; every
finding below is a gap the suite does not cover. Each workstream owns a disjoint set of files so they can
be implemented in parallel and merged cleanly. Every fix ships with a regression test (`bun test`).

Severity: H = High, M = Medium, L = Low.

> Note: the worker entry has since been renamed `service-worker.js` → `tabkebab-service-worker.js`
> (feature code lives in `core/background/`). References below use the original filename.

---

## WS1 — Stash / Focus data safety
Files: `core/focus.js`, `core/focus-policy.js`, `core/focus-blocklists.js`, `core/tab-restore.js`,
`sidepanel/components/focus-panel.js`, `service-worker.js` (only `persistCapturedStash`).

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1.1 | H | Stash closes tabs restore refuses to reopen (`chrome-extension:`, `about:`, `data:`, `edge:`…) → permanent loss | Export one `isRestorableUrl` from `tab-restore.js`; stash/auto-stash only capture+close restorable tabs; non-restorable tabs stay open |
| 1.2 | H | Focus stash with an unrestorable tab never completes → ENDING forever, tabs re-open every wake, Focus blocked | Focus stash captures only restorable tabs via `sanitizeCapturedTab`; end-of-session treats `skippedInvalid` as non-fatal; recovery path for already-stuck states |
| 1.3 | H | "+5 min" on open-ended (duration 0) session ends it | `extendFocus` is a no-op (or hidden button) when duration is 0; UI hides +5 for open-ended |
| 1.4 | M | Focus "group" action merges all windows into one group, breaks user groups, unpins | Group only ungrouped, unpinned tabs per window; record and restore prior state on teardown where feasible |
| 1.5 | L | Blocked domains stored raw; URLs / `*.x.com` never match | Normalize via same path as allowlist (strip scheme/path, leading `*.`), reject invalid |
| 1.6 | L | `'armor games.com'` typo | `'armorgames.com'` |
| 1.7 | L | Focus panel `_esc` doesn't escape `"` in attributes | Proper attribute escaping |
| 1.8 | L | Double refresh double-wires Start button → two runs | Render-generation token; ignore stale renders |
| 1.9 | L | Profile chip race loads wrong prefs | Sequence token on `_loadProfilePrefs` |
| 1.10 | L | Restored Focus stashes accumulate | Delete Focus stash after complete restore |

## WS2 — AI safety & reliability
Files: `core/nl-executor.js`, `core/ai/*.js` (except `smart-group-route.js` untouched unless needed),
`service-worker.js` (NL command handler only), `sidepanel/chrome-ai-broker.js`.

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 2.1 | H | Close confirmation shows AI-authored text, not real match set | Build confirmation server-side from `matchingTabs` (count + sample titles); never display `parsed.confirmation` alone; reject over-broad filters (e.g. matches ≥ all tabs / trivial `urlContains`) |
| 2.2 | M | NL group/move run unconfirmed with unvalidated color/name, pulls tabs across windows | Validate color enum / name string; group per window; require confirmation when action touches tabs in multiple windows or > N tabs |
| 2.3 | M | Failed/unparsed AI responses cached 24h | Cache only when response is usable (`parsed` non-null when JSON expected, non-empty text) |
| 2.4 | M | Gemini 2.5 thinking consumes `maxOutputTokens` | Set `thinkingConfig: { thinkingBudget: 0 }` for 2.5 flash models (or raise budget) |
| 2.5 | L | OpenAI o-series/gpt-5 reject `max_tokens`/`temperature`; 4xx retried as network error | Use `max_completion_tokens`, omit temperature for reasoning models; non-retryable error type for 4xx (all providers) |
| 2.6 | L | Device-key "encryption" is obfuscation; PBKDF2 100k | Correct comments/docs; store iteration count per record, new records use 600k, legacy decrypt still works |
| 2.7 | L | Second side panel cancels pending Chrome AI requests | Keep existing port's in-flight requests; route new ones to newest port |
| 2.8 | L | Timeout can't fire if Chrome AI never answers | Reject on timeout independently of operation settlement |
| 2.9 | L | Cache read-modify-write race | Serialize cache mutations; don't rewrite on hit (or batch LRU touch) |

## WS3 — Drive sync, retention, import
Files: `core/drive-client.js`, `core/drive-sync.js`, `core/drive-retention.js`, `core/export-schema.js`,
`core/export-import.js`, `core/sessions.js` (tombstone call sites only), `core/settings.js` (if needed).

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 3.1 | H | Tombstones never pruned; hitting 10k cap breaks deletes and uploads invalid sync file that bricks every device | Prune tombstones older than a TTL (e.g. 180 days) and cap to newest N on record and merge; validate merged doc **before** upload; on invalid remote, recover (prune/repair) instead of throwing forever |
| 3.2 | M | Non-idempotent POSTs retried on 5xx → duplicate folders/files → permanent "ambiguous" | Don't retry POST creates blindly: re-lookup before retrying; when multiple matches exist pick deterministic (oldest) instead of failing |
| 3.3 | M | Retention permanently deletes the only copy of per-stash exports | Exclude per-stash exports from category pruning, or keep newest per stash name; prefer trash over permanent delete |
| 3.4 | L | Imported full export can redirect AI to custom endpoint / change retention | Import never enables AI or changes provider/baseUrl/retention-destructive settings without explicit user choice (keep local values) |
| 3.5 | L | `Retry-After` HTTP-date → NaN; huge values sleep holding lock | Parse both forms; clamp to sane max (e.g. 60s), fail otherwise |
| 3.6 | L | `listDriveProfiles` / `listDriveExports` read first page only | Use paginated `listFilesInFolder`-style loop + validation; delete `listDriveExports` if unused |

## WS4 — Service worker scheduling, storage, bookmarks
Files: `service-worker.js` (alarms, bookmarks, auto-kebab, side panel open), `manifest.json`,
`core/stash-db.js`, `core/tabs-api.js`.

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 4.1 | M | Bookmark HTML export: `innerHTML = textContent` → DOM XSS | Highlight via text nodes / escape before insert |
| 4.2 | M | Alarms cleared+recreated on every startup/settings save → long intervals never fire | Only (re)create alarms that are missing or whose period changed; use `delayInMinutes` for first fire |
| 4.3 | M | Auto-bookmark-on-stash bookmarks everything except stashed tabs | Bookmark the captured stash tabs before closing; apply to all stash entry points |
| 4.4 | M | Auto-bookmark alarm duplicates full tree every 12h | Replace the day's folder contents (or skip when unchanged) |
| 4.5 | M | Incognito tabs persisted (auto-save, stash, Drive, bookmarks) | Filter `tab.incognito` in persistence paths |
| 4.6 | M | No `unlimitedStorage` → 10MB quota | Add `unlimitedStorage` permission |
| 4.7 | M | stash-db writes lack `onabort` → hang + wedge mutation lock | Reject on `onabort` (and `oncomplete` resolves) for all write txs |
| 4.8 | M | `closeTabs` partial close reports success | Close ids individually (or retry without stale ids) and report actual count |
| 4.9 | L | Auto-kebab discards audible tabs; auto-stash closes audible/pinned | Skip `audible` and `pinned` |
| 4.10 | L | `sidePanel.open` without user gesture always fails | Remove/guard non-gesture calls |

## WS5 — Grouping engine
Files: `core/grouping.js`, `core/engine/*.js`.

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 5.1 | M | AI solver accepts a tab in multiple groups / non-integer indices | Dedupe across groups (first wins), `Number.isInteger`, re-check group size ≥ 2 after dedupe |
| 5.2 | M | Engine groups/moves pinned tabs | Exclude pinned tabs from snapshot |
| 5.3 | L | Snapshot includes popup/app/incognito-window tabs | Restrict tabs to normal windows of same incognito state |
| 5.4 | L | Closed tab mid-run causes verification passes to re-create groups | Prune desired state to live tab ids before each verification pass |
| 5.5 | L | `cleanupBlankTabs` closes user's own New Tab pages | Only close blank tabs the executor created (track ids) |
| 5.6 | L | `tabUrls` missing → TypeError in `moveTabToManualGroup` / `applyManualGroupToChrome` | `Array.isArray` guard |

## WS6 — Side panel UI
Files: `sidepanel/panel.js`, `sidepanel/components/{tab-list,window-list,duplicate-finder,group-editor,
confirm-dialog,stash-list,session-manager,command-bar}.js`.

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 6.1 | M | Duplicates/Groups close stale tab ids (e.g. empty page now has content) | Re-query live state at action time (re-validate URL/group membership) and refresh views on `tabsChanged` |
| 6.2 | M | Domains list render race duplicates groups | Render generation token + debounce `tabsChanged` refresh |
| 6.3 | L | Shortcuts fire with modifiers / under open dialog; dialog no Escape/focus trap | Ignore when ctrl/meta/alt or dialog open; Escape cancels; focus trap |
| 6.4 | L | Headers/tab rows not keyboard accessible | `tabindex=0`, `role=button`, Enter/Space handlers |
| 6.5 | L | "Ungroup All" unconfirmed | Confirm dialog |
| 6.6 | L | Concurrent restores clobber `activeRestoreId` | Track a set/map of active restore ids |
| 6.7 | L | Undefined SW responses crash callers | Guard responses with clear error |

---

## Out of scope / documented only
- Custom AI provider relies on server CORS (no host permission) — document in GUIDE; adding `optional_host_permissions` is a product decision.

## Integration
1. Each workstream implemented in an isolated worktree with tests.
2. Merge all into `claude/sleepy-galileo-6w8h0l`, resolve conflicts (`service-worker.js` is shared by WS1/2/4 on disjoint functions).
3. Full `bun test` green, push.

## Addendum — 4.11 Chrome bookmark nesting limits (user report)
Scheduled/manual Chrome bookmark export (`saveToChromeBoomarks`) builds Bar › TabKebab › date › Windows|Groups|Domains › name › bookmark
with no depth budget, ignores a moved/renamed root, and accumulates date folders forever.
Fix (WS4): `MAX_BOOKMARK_DEPTH` budget with progressive flattening when the root sits deeper; persist root folder id;
keep newest N date folders (removeTree only `YYYY-MM-DD` folders under the root); cap bookmarks per export.

## WS7 — Third-party upgrades (runs after WS2 merges; shares `core/ai/provider-*.js`)
The extension ships zero npm dependencies; "third parties" are CI actions, the Bun toolchain, and AI provider models/APIs.

| Item | Current | Target | Notes |
|------|---------|--------|-------|
| `actions/checkout` | v4 | v7 | Node 24 runtime (Node 20 removed from runners Sep 2026); workflow uses `pull_request`, unaffected by v7 fork restriction |
| `actions/upload-artifact` | v4 | v7 | |
| `oven-sh/setup-bun` | v2 | v2 (≥ 2.2.0, Node 24) | |
| `.bun-version` | 1.3.11 | 1.4.2 | latest stable; suite already passes on 1.4.2 |
| OpenAI default | `gpt-4.1-nano` (**deprecated**) | current low-cost model (verify ID on developers.openai.com) | reasoning-model params via WS2 2.5 |
| Gemini default | `gemini-2.5-flash` (restricted to existing users) | `gemini-3.8-flash` | drop shut-down `gemini-3-pro-preview` from list; thinking control per model family; raise output budget |
| Claude default | `claude-haiku-4-5` | `claude-haiku-5-5` | no non-default `temperature` (400), no prefill, thinking on by default → `output_config.effort: "low"` + adequate `max_tokens`; drop deprecated `*-20250514` IDs; list Haiku/Sonnet/Opus 5.5; `anthropic-version: 2023-06-01` unchanged |
| Saved settings | stored retired/deprecated model IDs | migrate on load to provider default | |

## Status (2026-10-08)
All workstreams WS1–WS7 implemented and merged into `claude/sleepy-galileo-6w8h0l`; `bun test` 1081 pass / 0 fail (from 900).
Integration fixes added during merge: auto-bookmark-on-stash only covers restorable (actually stashed) tabs; Drive settings import keeps
`neverDeleteFromDrive` on and never shortens `driveRetentionDays`.
Open / needs live verification:
- ~~Gemini 3.x `thinkingLevel: "low"` casing~~ — verified 2026-10-08 with a live `gemini-3.8-flash` call (finishReason STOP); no change needed.
- `core/focus.js` `handleDistraction` still calls `chrome.sidePanel.open` without a user gesture (already caught; no-op).
- Not exercised in a real browser: all changes are covered by mocked-Chrome tests only.
