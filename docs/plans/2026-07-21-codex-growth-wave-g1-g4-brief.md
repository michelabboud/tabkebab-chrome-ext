# Codex Growth Wave — G1/G2/G3/G4 (dispatch brief)

- **Date:** 2026-07-21 · **Author:** Fable (orchestrator) · **Executor:** codex (headless lane)
- **Spec source (READ FIRST):** `docs/reports/2026-07-20-fable-review-post-codex-hardening.md`
  — the Fable review that defined G1–G6 (F10 reproduction evidence is in there).
- **Base:** branch `feat/growth-wave-g2-g4` off current `main` (v1.2.19, includes G1). Commit per logical
  change, conventional messages matching the repo's log style. **Do NOT push. Do NOT merge.**
  Fable reviews the branch before merge.

## Scope — G1 follow-ups + three tasks, in order

### G1 — DONE, do not redo (build on it)

G1 (capture-time sanitization, F10+F5) shipped on `main` at v1.2.19 (`864698d`), built by a
Fable lane and independently reviewed CLEAN-WITH-NOTES (867/0 across three runs). Your branch
starts on top of it. **Do not touch** `core/tab-restore.js` sanitizers, the `sessions.js`
heal, the service-worker stash capture sites, or `tests/core/capture-sanitization.test.js`
except where a G1 follow-up below explicitly says so.

**G1 follow-ups (from the independent review — build these as part of this wave):**
1. **Read-path heal (MEDIUM-LOW, demonstrated):** pre-existing poisoned records still brick
   `readLocalDriveSyncDocument()` (core/drive-sync.js:541) and
   `buildPortableExportPayload('sessions')` until the first successful delete triggers the
   heal write-back (`deleteSessions` early-returns without write-back when nothing was
   deleted). Fix: apply the same heal (reuse `canonicalizeLocalSessions`' logic — do NOT
   fork it) on the sync-read and export-read paths so a sync/export-only user un-bricks
   without ever deleting. Tests: poisoned store → sync read resolves, export resolves,
   healed shape persists.
2. **Invariant tests:** the never-close-uncaptured-tab invariant across all 4 service-worker
   stash sites and the `safeFaviconUrl` render gate have zero direct test coverage (verified
   by manual trace only). Add failure-path tests: capture rejected → tab NOT closed;
   zero-representable stash → error, no save, nothing closed; render gate rejects
   `javascript:`/oversized, passes valid http/data.
3. **LOW cosmetic:** heal drops unrepresentable-URL tabs without updating `window.tabCount`
   → recompute tabCount during heal.
4. **LOW consistency:** `saveSession` with all tabs unrepresentable stores `windows: []` —
   reject with the same error shape the stash paths use.

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
