# Codex Growth Wave — G1/G2/G3/G4 (dispatch brief)

- **Date:** 2026-07-21 · **Author:** Fable (orchestrator) · **Executor:** codex (headless lane)
- **Spec source (READ FIRST):** `docs/reports/2026-07-20-fable-review-post-codex-hardening.md`
  — the Fable review that defined G1–G6 (F10 reproduction evidence is in there).
- **Base:** branch `feat/growth-wave-g1-g4` off current `main` (1.2.18). Commit per logical
  change, conventional messages matching the repo's log style. **Do NOT push. Do NOT merge.**
  Fable reviews the branch before merge.

## Scope — four tasks, in order

### G1 — Capture-time sanitization (fixes F10 HIGH + F5 LOW) — BUILD TO THIS SPEC

This spec was produced by a Fable implementation pass that was reverted for lane-ownership
reasons — the analysis is verified (its variant went 867/0 on the full suite). Follow it
exactly; deviations need a stated reason in your report.

**Root cause:** capture stores page-controlled strings raw; every delete/sync/export
canonicalizes ALL stored sessions against `MAX_DRIVE_STRING_LENGTH` (16,384, drive-sync.js)
BEFORE mutating anything, so one oversized title/favicon/URL bricks delete, cleanup, sync,
and export with no in-product recovery. Reproduced: `canonicalizeLocalDriveSyncDocument`
throws "string exceeds the length limit" on a 20,000-char title or favicon.

**Capture call sites to sanitize** (all five build the same raw `{url, title, favIconUrl,
pinned}` literal):
- `sessions.js` `saveSession` (~:146-151) — also bound the session name (500) and Chrome
  group-meta titles (200, matching the existing `createTabGroup` handler bound), and skip
  windows left empty after filtering
- `service-worker.js` auto-stash (~:232)
- `service-worker.js` `stashWindow` (~:1958)
- `service-worker.js` `stashGroup` (~:2003) — group title also feeds the stash NAME here
- `service-worker.js` `stashDomain` (~:2049)
- Manual groups need NOTHING: the handler already bounds URLs via `requireRuntimeUrl` at 16,384.

**Sanitizer contract** (put it in `core/tab-restore.js` next to the existing restore-path
`sanitizeTab()` and REUSE it — same title truncation at 500, same favicon scheme allowlist):
- URL: trim; if empty or >16,384 chars the tab is UNREPRESENTABLE — return null / skip the
  tab (never truncate a URL)
- title: truncate to 500 (existing restore constant); normalize non-string to `''`
- favIconUrl: scheme allowlist `{http, https, chrome, data}` (identical to existing
  `sanitizeTab` — do not invent a new policy) PLUS length ≤ 16,384 (exactly the
  canonicalization contract, so nothing storable is rejected and nothing stored can poison);
  violations become `''` (cosmetic — never drop the tab over a favicon); normalize
  non-string to `''`
- emit a COMPLETE shape: no field may be `undefined` (chrome.storage drops undefined but the
  test mock and the contract must not depend on that)

**Two safety invariants — keep them:**
- Stash paths must NEVER close a tab that was not captured into the stash (track captured
  originals; close only those, still excluding `chrome://`)
- A stash that would contain zero representable tabs → return an error, don't save an empty
  stash

**Pre-existing-poison heal (BUILD it — proved small, ~50 lines + 4 tests):** in `sessions.js`
`canonicalizeLocalSessions`, heal each stored session BEFORE validation, touching ONLY values
that would fail the canonical bound: >16,384 titles re-bounded to 500, >16,384 favicons →
`''`, unrepresentable-URL tabs dropped, >16,384 group titles → 200, >16,384 names → 500.
CRITICAL: values BETWEEN the capture and canonical bounds (e.g. a legal legacy 2,000-char
title) must stay byte-identical — heal repairs poison, it does not retroactively re-police
old data. Handle both v2 (`windows[].tabs`) and v1 (flat `tabs`) shapes. The healed shape
persists on the next deletion write-back, which also un-bricks Drive sync. Follow-up only
(do NOT build now): symmetric heal for `manualGroups` inside drive-sync.js.

**F5 (same task):** gate the stash-view favicon render (`sidepanel/components/stash-list.js`
img.src) with the SAME two constraints (scheme allowlist + length) so stored and rendered
policies match.

**Regression tests** (failure paths first; `tests/core/capture-sanitization.test.js`):
1. Capture a live tab with a 20,000-char title → stored title ≤500, then the FULL chain
   succeeds: `readLocalDriveSyncDocument` resolves, `buildPortableExportPayload('sessions')`
   resolves, `deleteSessions` deletes
2. Oversized `data:`-URI favicon (>16,384) → stored `''` while the tab survives
3. `javascript:` favicon → `''` (also test `ftp:` rejected, valid `data:` kept)
4. Tab with >16,384-char URL → skipped at capture, sibling tab survives, sync doc still valid
5. Oversized session name → bounded at 500
6. Pre-existing poisoned stored session + clean session: deleting the CLEAN one succeeds and
   the write-back persists the healed poisoned record (title 500, favicon `''`)
7. The poisoned session itself is deletable
8. Pre-existing tab with unrepresentable URL → dropped by heal, not fatal
9. Legal legacy 2,000-char title survives heal byte-identical
10. Pure sanitizer unit rows: null/array/missing-url/whitespace-url/oversized-url → null;
    `pinned` coerced to boolean; `groupId` and exact URL (incl. hash) preserved
Chrome-mock note: the mock preserves undefined-valued properties where real chrome.storage
drops them — that's why the complete-shape rule exists.

### G2 — First-run experience (the growth lever)

Today: the side panel auto-opens on install and then… nothing. No tour, inert empty states.
Build:
1. A lightweight, **skippable** first-run walkthrough INSIDE the panel (not a new tab, not a
   modal storm): 3–4 steps max covering the core loop — group tabs → stash a session →
   restore it. Runs once (flag in `chrome.storage.local`), dismissible at every step,
   re-launchable from settings.
2. Actionable empty states: every list that can be empty (stashes, sessions, focus profiles)
   gets a one-line explanation + a real CTA button that performs the obvious first action —
   not just grey text.
3. **HARD UI LAW (owner's rule): no drawers/slide-over shelves for anything involving input
   or configuration.** Real sections/pages or split panes only. Match the existing panel's
   design language (`sidepanel/` CSS conventions) — this must look native to the product,
   not bolted on.

### G3 — AI-less excellence (the differentiator)

Today: clicking Smart Group with no API key = raw error toast, dead end.
Build:
1. **Chrome built-in AI as the zero-config default** for Smart Group: if no BYO key is
   configured, try the built-in AI (the repo already brokers it — `sidepanel/chrome-ai-broker.js`)
   transparently. No key, no account, no data leaves the machine — say exactly that in the UI
   at the point of use.
2. Graceful degradation ladder: built-in AI unavailable (unsupported Chrome/model not
   downloaded) → a friendly inline explanation with two paths: "use domain grouping instead"
   (one click, works today) and "set up an API key" (link to the existing settings section).
   The raw error toast dies.
3. Never block the core loop on AI: any AI failure falls back to a working non-AI action,
   stated plainly. Timeouts/aborts follow the patterns the hardening waves established.

### G4 — Store trust package (docs + copy, no logic)

1. Add the two missing PRIVACY.md sentences the review specified: (a) exported bookmark HTML
   embeds Google s2 favicon URLs; (b) stash previews fetch stored favicons from their
   original hosts. Match PRIVACY.md's existing voice.
2. Draft the Web Store listing copy at `docs/store-listing.md`: short + long description that
   **preempts the `tabs`-permission scare** in plain honest language (what is read, what is
   never sent anywhere, the no-account/no-server stance), feature bullets aligned to the
   actual product, and a "why these permissions" section mirroring the manifest exactly.

## Standing rules for this lane

- Tests are mandatory for every behavior change (G2 flag logic, G3 fallback ladder — happy
  AND failure paths). Full suite `bun test` must be green; include the output tail in your
  close-out report. The repo's version-parity syntax test must stay green if you bump.
- Version: bump per the repo's per-fix release convention (VERSION + manifest + CHANGELOG in
  lockstep) once at the end of the wave.
- No new dependencies. No `eval`/remote code (Store policy — the repo is clean, keep it so).
- No drawers (see G2). No dark patterns in the tour. No telemetry.
- Anything ambiguous in the UX: prefer the smallest honest version; note the fork in the
  report instead of gold-plating.
- Close-out report: `docs/reports/2026-07-21-codex-growth-wave-g1-g4.md` — what changed,
  test output, screenshots optional, forks/assumptions, follow-ups.

*Fable reviews the branch on completion; Michel gates the merge + Store release.*
