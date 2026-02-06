# Changelog

All notable changes to TabKebab are documented in this file.

---

## [1.2.0] — 2026-02-07

### Added

- **Focus Mode** — time-bounded productivity sessions with distraction blocking
  - 4 built-in profiles: Coding, Writing, Research, Meeting
  - Live countdown timer with profile-colored HUD (cyan/purple/green/blue) and glowing animation
  - Distraction interception: blocks navigation to distracting sites during focus
  - Three blocking modes: Strict Mode (whitelist only), Curated Categories (6 blocklists), AI Detection
  - Flexible allowlist supporting domains, URLs, and Chrome tab groups
  - Tab actions on focus start: Kebab, Stash, Group, or None
  - Session reports with stats (duration, distractions blocked, focus tabs)
  - Focus history (last 50 sessions)
  - Preferences saved per profile (categories, allowlist, duration, etc.)
  - Focus button in header with `F` keyboard shortcut
  - Badge countdown on extension icon during active sessions
- **Empty pages cleanup** — separate row in Duplicates tab to find and close blank/empty pages (about:blank, new tabs)
- **Header status icons** — Drive and AI connection status indicators with click-to-navigate to settings
- **Downward tooltips** — header icon tooltips now appear below buttons to prevent clipping at window edge

### Changed

- **Auto-kebab default** — now enabled by default at 3 hours (was 0/off)
- **Duplicate badge** — now includes empty pages count in the badge total
- **Consolidate windows improved** — now a 3-phase smart consolidation:
  - Phase 1: Redistributes excess tabs from huge windows (>100 tabs) to smaller ones
  - Phase 2: Merges tiny windows (<30 tabs) into larger ones
  - Phase 3: Balances groups across windows (max 8 groups per window)
  - Targets 50 tabs per window for optimal organization

### Fixed

- **Tooltip visibility** — header tooltips no longer clip behind the window border
- **Empty pages counter** — badge updates correctly after closing empty pages

---

## [1.1.0] — 2026-02-01

### Added

- **Global stats bar** — fixed bar between the nav and view area showing Windows count, Tabs count, and Active/Kebab percentage across all views
- **Stats hint** — subtle "Kebab = discarded tabs saving memory" explainer below the stats bar
- **Header version badge** — v1.1.0 label and GitHub/Privacy quick-links in the header
- **Session sub-tabs** — Sessions view now has **Saved** and **Auto** tabs; auto-saves display with the `[Auto]` prefix stripped and a count badge on the Auto tab
- **Duplicate badge** — red pill counter on the Duplicates sub-tab button showing the number of extra copies
- **Periodic duplicate check** — background scan every 60 seconds to keep the badge current
- **Custom Group tab search** — each custom group card has a smart input to search open tabs by title/URL or paste a URL directly, with + buttons to add
- **AI command bar upgrade** — input replaced with a multi-line textarea (Enter sends, Shift+Enter for newline) and a provider label showing the active AI provider name
- **Keyboard shortcuts** — `1`–`4` switch main views, `/` focuses the AI command bar, `?` toggles the help overlay, `Esc` closes overlays or blurs inputs
- **Help overlay** — accessible via `?` key or the help button; covers views, features, shortcuts, and tips with links to the full guide and issue tracker

### Changed

- **Custom Groups first** — Groups sub-view now shows Custom Groups above Chrome Tab Groups
- **Collapsible group cards** — custom group header click toggles body and add-tab area visibility
- **Stats moved global** — stats bar removed from the Windows view and placed in a fixed position visible on every view
- **Sub-nav scoping** — Tabs sub-nav handler scoped to `#view-tabs` to prevent interference with the new Sessions sub-nav

### Fixed

- **Double-escaped group names** — `escapeHtml()` was applied to `.textContent` causing entities like `&amp;` to render literally
- **Undefined CSS variable** — `.find-results-list` used `var(--bg)` which doesn't exist; corrected to `var(--bg-card)`
- **Stats null crash** — `refreshGlobalStats()` now guards against null responses from the service worker
- **Collapse/Expand crash** — `collapseAll()` and `expandAll()` in WindowList now return early if `lastWindows` is empty or null
- **Dark theme kebab mismatch** — `[data-theme="dark"]` kebab colors (yellow) now match `prefers-color-scheme: dark` (orange)
- **modifiedAt over-update** — `moveTabToGroup()` and `removeTabFromAllGroups()` no longer touch `modifiedAt` on groups that didn't contain the removed tab
- **Favicon fallback inconsistency** — command-bar.js now uses the same grey-rectangle SVG fallback and `{ once: true }` error handler as all other components
- **Untitled group fallback** — Chrome groups with empty titles now display "Untitled Group" in chips, section headers, and the group editor
- **Badge not resetting** — duplicate badge now updates correctly after closing all duplicates (scan awaited before dispatching)
- **Red dot with no duplicates** — added `.dupe-badge[hidden] { display: none }` to prevent CSS specificity override of the `[hidden]` attribute
- **Dead status field** — removed hardcoded `status` computation from `getWindowStats()` (client uses settings-based thresholds)

### Improved

- **URL matching performance** — `renderGroups()` and `applyToChrome()` use `Set` instead of `Array.includes()` for O(1) lookups

---

## [1.0.0] — 2026-01-28

Initial release.

- 4-phase grouping engine (Snapshot → Solver → Planner → Executor)
- Domain and AI-powered smart grouping
- Sessions with auto-save, restore modes, and pipeline restore
- Stash with IndexedDB storage and lazy restore
- Bookmarks in three formats with multiple destinations
- Tab sleep (Kebab) with keep-awake domain list
- Natural language AI command bar
- Google Drive sync with profile scoping and retention
- Five AI providers: OpenAI, Claude, Gemini, Chrome Built-in, Custom
- AES-GCM 256-bit API key encryption
- Full data export/import
- Configurable settings for limits, automation, and sync
