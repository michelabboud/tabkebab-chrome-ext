<p align="center">
  <img src="icons/logo.svg" alt="TabKebab" width="400">
</p>

The Chrome Web Store listing is operated separately and may lag the GitHub
source/release version documented here. Check the Store listing's displayed
version before assuming a GitHub hardening change is installed from the Store.

<p align="center">
  <strong>Stack and organize your browser tabs like a kebab skewer.</strong>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/tabkebab/cgfnjdcioainbclbbihglaopbhikhdob">
    <img src="https://img.shields.io/badge/Chrome_Web_Store-Add_to_Chrome-blue?logo=googlechrome&logoColor=white" alt="Add to Chrome">
  </a>
</p>

<p align="center">
  <a href="https://tabkebab.com">Website</a> &middot;
  <a href="GUIDE.md">User Guide</a> &middot;
  <a href="CHANGELOG.md">Changelog</a> &middot;
  <a href="PRIVACY.md">Privacy Policy</a> &middot;
  <a href="TERMS.md">Terms of Service</a> &middot;
  <a href="https://github.com/michelabboud/tabkebab-chrome-ext/issues">Report Issue</a>
</p>

---

TabKebab is a Chrome side-panel extension that tames tab chaos. Group, stash, sleep, and restore tabs across windows — manually or with AI. Zero dependencies, zero telemetry, everything stays local unless you opt in.

## Features

### Tab Management

- **Four views** in the view bar, in this order: **Tabs · Windows · Stash · Sessions** (Focus Mode and Settings open from the header)
- **Tabs sub-views**: Domains, Groups (custom groups, Chrome tab groups, ungrouped tabs), and Duplicates
- **Live tab list** with favicon and title; click a row to switch to the tab, **×** to close it; sleeping (discarded) tabs are dimmed
- **Row actions** — every domain, Chrome group, and window row has **Stash** plus a **⋯** menu (sleep, keep awake, collapse/expand, ungroup, close…)
- **Drag-and-drop** tabs into custom groups
- **Window health** — status dot per window with color-coded thresholds (green / yellow / red)
- **Hash-aware duplicate detection** with a badge counter (refreshed every 60s while the panel is open) and bulk close with lossless undo from each tab's exact original URL
- **Empty pages cleanup** — find and close blank tabs (`about:blank` or missing URLs) while preserving Chrome's new-tab pages
- **Safe AI domain commands** — match only an exact host or its true subdomains, reject lookalike hosts, and revalidate live tabs before a confirmed close
- **Stats strip** — one line such as `3 windows · 21 tabs · 0 sleeping`, hidden on Settings and Focus
- **Toasts with Undo** — stashing a domain, group, or window, deleting a stash or session, and closing duplicates all offer **Undo**

### Tab Grouping

- **Group by domain ▾** split button — one click groups tabs by domain into Chrome native tab groups; the **▾** menu has **Smart group (AI)** and **Ungroup all…** (with confirmation)
- **AI smart grouping** — understands context (research, shopping, work, entertainment) and creates meaningful groups; uses Chrome's on-device AI when no provider is set up and it is available, and falls back to **Group by domain** or **Add an API key** when it can't run
- **Pinned tabs, popup/app windows, blank pages, and browser-internal pages are left alone** by grouping
- **4-phase pipeline**: Snapshot → Solver → Planner → Executor with live progress per phase
- **Custom groups** — create, rename, recolor, and manage your own groups with three ways to add tabs: drag-and-drop, text search filter, or URL paste
- **Collapsible section headers** in the Groups sub-view

### Sessions

- **Save** full snapshots of every window, tab, and tab group layout
- **Saved / Auto tabs** — sessions view split into **Saved** (user-created) and **Auto** (automatic) sub-tabs for clean separation
- **Recoverable restore outcomes** — every saved tab is reported as restored, already open, invalid, or failed
- **Restore modes**: original windows (**Restore**) or the current window (**Restore here**)
- **Audio-safe pipeline restore**: batched creation → temporary background mute → discard → guaranteed unmute cleanup; non-discarding restores never mute
- **Auto-save** on browser start and at configurable intervals (default 24h), with retention policy (default 7 days, always keeping the 2 newest)
- **Optional name** — an empty name saves as e.g. "Session — Oct 8, 9:18 PM"
- **Incognito tabs are never saved or sent to AI**, and pages that cannot be reopened are left out
- **Per-session export** as JSON for sharing or backup
- **Rename and delete** sessions from the panel

### Stash

- **Stash and close** tabs by window, Chrome group, domain, or all at once
- Stored locally in **IndexedDB**
- **Never closes what it can't bring back** — incognito tabs and pages restore cannot reopen (extension pages, `about:`, `data:`) stay open and are not stashed
- **Fail-closed stash restore**: incomplete restores retain the unchanged IndexedDB source even when delete-after-restore is enabled
- **Two-phase progress bar**: "Creating tabs..." then "Loading... X / Y ready" with animated stripe
- **Restored badge** on stashes already restored, with confirmation before re-restoring
- **Favicon previews**, source badges, tab count, and one-click restore or delete
- **Per-stash export** as JSON

### Bookmarks

- **Three bookmark formats**: By Windows, By Groups, By Domains
- **Multiple destinations**: Chrome Bookmarks, Local Storage, Google Drive, or all
- **Auto-bookmark on stash** — automatically bookmark exactly the tabs that were stashed
- **Bounded Chrome bookmark exports** — at most 4 folder levels, a renamed or moved TabKebab folder is reused, the newest 30 date folders are kept, one export is capped at 5,000 bookmarks, and the day's snapshot is replaced rather than duplicated
- **Compressed export** — compact JSON to save space on Drive
- **HTML bookmark page** — browsable, searchable HTML uploaded to Google Drive with:
  - Tab navigation (Windows / Groups / Domains)
  - Clickable pills for quick-jump to any group
  - Live search with highlighted matches
  - Dark/light mode support
  - Responsive layout

### Tab Sleep (Kebab)

- **Discard tabs** to free memory while keeping them in the tab strip
- **Per-domain keep-awake exceptions** — protect email, calendars, AI tools
- **AI-assisted classification** suggests which domains to protect
- **Sleep by** domain, group, window, or everything at once
- **Auto-kebab** idle tabs after configurable hours (default: 3 hours)

### Focus Mode

- **Time-bounded productivity sessions** with live countdown timer
- **4 built-in profiles**: Coding, Writing, Research, Meeting — each with preset allowed/blocked domains
- **Profile-colored HUD** — timer display glows in profile color (cyan, purple, green, blue), with matching light and dark theme colors
- **Focus banner** — a slim banner on every view shows the time left (or elapsed) with an **End** button, and stays in sync across panels in other windows
- **Open-ended sessions** — show elapsed time and a single **End Session** button
- **Distraction blocking** with three modes:
  - **Strict Mode** — only allowlisted entries are accessible; an empty list blocks every non-internal URL
  - **Curated Categories** — block Social, Video, Gaming, News, Shopping, Entertainment
  - **AI Detection** — AI categorizes unknown domains in real-time
- **Complete allowlist policy** — exact hosts/true subdomains, canonical exact URLs, and Chrome groups rebound by exact title on each run
- **Tab actions on start** — Kebab, Stash, Group, or monitor-only
- **Session reports** — stats on duration, distractions blocked, focus tabs
- **Focus history** — review your last 50 sessions
- **Preferences saved per profile** — your category selections and settings remembered
- **Keyboard shortcut** — press `F` to open Focus Mode

### Natural Language Commands

- **Command bar** under the stats strip (press `/`), with a label showing the active provider
- Type commands like *"close YouTube tabs"*, *"find my GitHub tabs"*, *"move my docs tabs to a new window"*
- Supported actions: close, group, move to a new window, switch to a tab, and find
- Close confirmations are built from the actual matching tabs (count, windows, pinned, titles), not from AI-written text; over-broad filters are rejected, and group/move ask for confirmation across windows or above 20 tabs
- Works with any configured AI provider

### Keyboard Shortcuts

- **1–4** — switch between Tabs, Windows, Stash, and Sessions (numbers follow the views that are switched on)
- **← / →** — move between views when the view bar has focus
- **F** — open Focus Mode
- **Ctrl+K / Cmd+K** — search open tabs, stashes, and sessions
- **/** — focus the AI command bar, or open search when the command bar is not available
- **?** — toggle the help dialog
- **Esc** — close search or help, leave Settings or Focus setup (back to Tabs), or leave an input
- Single-key shortcuts never fire while typing or together with Ctrl/Cmd/Alt, so `Ctrl+F` stays the browser's find

### Google Drive Sync

- **Profile-scoped** — each Chrome profile gets its own folder
- **Folder structure**: `TabKebab / {profile} / sessions, stashes, bookmarks, archive`
- **Manual or automatic** sync at configurable intervals
- **Fail-closed retention** — only old, strictly dated recoverable copies are eligible; canonical, newest, young, malformed, undated, and unrelated files are protected, and the newest export of every individually exported stash is kept
- **Recoverable cleanup** — retention moves files to the Google Drive trash instead of permanently deleting them
- **Bounded deletion records** — sync deletion records expire after 180 days and are capped, so sync cannot break permanently
- **Archive before overwrite** — previous versions must be copied successfully before existing content is updated
- **Cross-profile settings import** from other profiles on the same Google account
- **HTML bookmark export** alongside JSON

### AI Providers

- **OpenAI** — GPT-6 Luna (default), GPT-5.x, GPT-4.1
- **Anthropic Claude** — Haiku 5.5 (default), Sonnet, Opus
- **Google Gemini** — 3.8 Flash (default), 3.x Flash-Lite, 3.1 Pro preview (2.5 Flash/Pro listed for existing users only)
- **Chrome Built-in AI** — Gemini Nano, on-device, no API key needed
- **Custom endpoint** — any OpenAI-compatible API (Ollama, LM Studio, Groq, Together AI)
- **Off by default** — the **AI provider** select starts at **Off**; saved settings that name a retired model move to the provider default
- **Per-family request shapes** — reasoning models, thinking controls, and no unsupported sampling parameters
- **Encrypted API key storage** with AES-GCM 256-bit (PBKDF2, 600,000 iterations for new keys) and optional passphrase
- **Response caching** — LRU cache (200 entries, 24h expiry) to avoid redundant calls
- **Request queue** with concurrency control

### Export & Import

- **Portable v2 full backup** of sessions, IndexedDB stashes, custom groups, keep-awake domains, bookmarks, effective settings, Focus preferences/history, and non-secret AI configuration
- **Transactional import** — validates before storage access, merges under one worker lock, and rolls back affected local/IndexedDB state on failure
- **Import guards** — an imported file can never enable AI or change the AI provider or endpoint (only per-provider model choices are taken), and a settings import can never weaken Drive retention
- **Individual v2 exports** for sessions, stashes, and settings
- **Secret-free files** — API keys, passphrase metadata, Drive/OAuth state, install IDs, active Focus state, and caches are excluded
- **Bounded input** — files over 25 MiB and malformed or wrong-kind documents reject before import
- **Google Drive backup** with subfolder organization
- **JSON format** throughout — human-readable, version-controllable

### Settings

- **Features** — 11 on/off switches (Focus Mode, AI, AI command bar, Search, Windows view, Stash, Sessions, Duplicates, Automation, Bookmarks, Google Drive). All default on; a switched-off feature is hidden, its schedules stop, and its actions are refused, but its data is never deleted and recovery (restore, undo, export) always works
- **Section index** — a sticky row of chips jumps to General, Features, Sleep, AI, Automation, Bookmarks, and Drive
- **Default view** selection (Tabs, Windows, Stash, Sessions)
- **Theme** (System, Light, Dark)
- **Tab count thresholds** — configurable yellow/red warning levels (Tab Limits, collapsed by default)
- **Automation** — auto-save interval, retention, auto-kebab, auto-stash
- **Bookmark configuration** — formats, destinations, compression, HTML export
- **Drive sync** — connection, auto-export toggles, sync interval, retention
- **Keep-awake domains** — manage the protected domain list
- **Backup & restore** — Export Settings, Export all data, Import Settings

## Tech Stack

- **Manifest V3** with ES modules throughout
- **Side panel UI** — zero external dependencies
- **IndexedDB** for stash storage
- **Chrome APIs**: tabs, tabGroups, windows, bookmarks, storage, identity, alarms, sidePanel
- **`unlimitedStorage`** permission so large session and stash histories are not lost to the 10 MB `chrome.storage.local` quota
- **Modular service worker** — `tabkebab-service-worker.js` registers listeners and routes messages to `core/background/*.js`; console output is prefixed `[TabKebab:<scope>]`
- **Google Drive REST v3** with OAuth2 (`drive.file` scope)
- **4-phase grouping engine**: snapshot → solver → planner → executor
- **Adaptive batched operations** — lazy mode for 20+ tabs (5/batch with delay and per-batch discard)
- **AES-GCM 256-bit encryption** for API keys with PBKDF2 key derivation (600,000 iterations for new keys; older keys still decrypt)

## Install

### From source (Developer Mode)

1. Clone this repo:
   ```
   git clone https://github.com/michelabboud/tabkebab-chrome-ext.git
   ```
2. Open `chrome://extensions` and enable **Developer Mode**
3. Click **Load unpacked** and select the cloned folder
4. Click the TabKebab icon or pin it to open the side panel

### Setting up Google Drive (optional)

See [Google Drive Setup Guide](store/google-drive-setup.md) for OAuth configuration.

### Setting up AI features (optional)

1. Open Settings in the side panel (or click the AI status icon in the header)
2. In **AI Features**, pick a provider in **AI provider** (the first option, **Off**, means AI is disabled)
3. Enter your API key (if required), choose a model, and click **Save Settings**, then **Test Connection**
4. The AI command bar, Smart group, and other AI actions become available (AI must also be on in Settings → Features)

## Development and verification

The extension remains dependency-free and Chrome loads this repository directly; there is no package install, bundler, or generated runtime output. Automated tests use Bun `1.4.2`, pinned in [`.bun-version`](.bun-version). Install that exact Bun version and verify it with `bun --version` before running the gate.

Run the same commands required by CI from the repository root:

```bash
bun test
bun test --coverage
bun test tests/syntax.test.js
```

The repository-owned Chrome mock resets local/session storage, listeners, tab/window/group state, runtime ports, failures, and call records between tests. It is intentionally an orchestration boundary, not a browser emulator: DOM, IndexedDB, extension lifecycle, OAuth, and Chrome Prompt API behavior still require the [real-Chrome smoke matrix](docs/guides/real-chrome-smoke-matrix.md).

GitHub Actions runs all three commands, in that order, for pull requests, manual dispatches, and pushes to `main`. After they pass, a dependent Windows job runs `package.cmd`, verifies the version and exact archive root, and uploads one `tabkebab-extension-<version>` artifact. The packager includes only `manifest.json`, `tabkebab-service-worker.js`, `core/`, `sidepanel/`, and `icons/`; it is release packaging, not a runtime build. Tag pushes do not trigger this workflow.

## Project Structure

```
TabKebab/
  manifest.json              # Extension manifest (MV3)
  bunfig.toml                # Bun test preload and coverage settings
  tabkebab-service-worker.js # Service worker entry: registers listeners, wires the router
  tests/                     # Bun regressions and Chrome API test doubles
  icons/                     # Logo and icon assets (SVG + PNG)
  core/
    background/              # Worker feature modules (one handler map each)
      router.js              # Message router + feature-switch gating (ACTION_FEATURES)
      tabs.js                # Tab/window actions, duplicates, keep-awake, kebab
      sessions.js            # Auto-save and session actions
      grouping.js            # Domain/smart grouping, manual + native groups
      stash.js               # Stash capture, restore, delete, undo
      bookmarks.js           # Bookmark snapshots, Chrome tree + HTML export
      drive.js               # Drive sync, exports, retention
      settings.js            # Settings, Drive settings import, portable files
      ai.js                  # AI actions, NL commands, Chrome AI panel port
      focus.js               # Focus readiness, ticks, navigation interception
      alarms.js              # Managed alarm schedule and dispatch
      lifecycle.js           # Browser startup, install/update, worker start
    log.js                   # Per-scope logger ([TabKebab:<scope>])
    tabs-api.js              # Chrome tabs/windows API wrapper
    sessions.js              # Session save/restore with v1→v2 migration
    stash-db.js              # IndexedDB stash storage
    grouping.js              # 4-phase grouping orchestrator
    duplicates.js            # Duplicate tab detection + empty pages
    focus.js                 # Focus Mode engine: state, timer, blocking
    focus-profiles.js        # Built-in focus profiles
    focus-blocklists.js      # Curated distraction blocklists
    focus-policy.js          # Pure Focus allowlist/blocking policy
    focus-ai.js              # Focus AI classification boundary
    tab-restore.js           # Shared session/stash restore coordinator
    nl-executor.js           # Natural language command execution
    settings.js              # Settings schema and CRUD
    storage.js               # Storage abstraction layer
    export-import.js         # Full data export/import
    export-schema.js         # Portable v2 schema and merge
    drive-client.js          # Google Drive REST API client
    drive-sync.js            # Drive sync schema, merge, tombstones
    drive-retention.js       # Fail-closed Drive retention policy
    ai/                      # AI provider abstraction
      ai-client.js           # Unified AI client
      provider.js            # Base provider class
      provider-openai.js     # OpenAI provider
      provider-claude.js     # Anthropic Claude provider
      provider-gemini.js     # Google Gemini provider
      provider-chrome.js     # Chrome Built-in AI provider
      provider-custom.js     # Custom endpoint provider
      crypto.js              # API key encryption
      cache.js               # Response LRU cache
      queue.js               # Request queue
      request-lifecycle.js   # Per-attempt timeout/abort lifecycle
      prompts.js             # AI prompt templates
    engine/                  # 4-phase grouping engine
      snapshot.js            # Phase 1: Capture tab state
      solver.js              # Phase 2: Domain-based solving
      solver-ai.js           # Phase 2 alt: AI-based solving
      planner.js             # Phase 3: Plan Chrome operations
      executor.js            # Phase 4: Execute tab moves/groups
      types.js               # Shared type definitions
  sidepanel/
    panel.html               # Main side panel UI
    panel.css                # Styles
    panel.js                 # View controller & navigation
    feature-flags.js         # Settings → Features switches on the panel side
    message-client.js        # Checked sendOrThrow() worker messaging
    components/
      tab-list.js            # Tab list + grouping controls
      window-list.js         # Windows view
      session-manager.js     # Sessions view
      stash-list.js          # Stash view
      group-editor.js        # Groups sub-view & editor
      duplicate-finder.js    # Duplicate detection UI + empty pages
      focus-panel.js         # Focus Mode UI: setup, timer, report, history
      command-bar.js         # AI command bar
      drive-sync.js          # Drive sync controls
      settings-manager.js    # Settings UI bindings
      global-search.js       # Ctrl+K search
      first-run-walkthrough.js # Getting-started guide
      ai-settings.js         # AI provider settings
      confirm-dialog.js      # Confirmation dialogs
      toast.js               # Toast notifications
```

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Current progress](PROGRESS.md)
- [Changelog](CHANGELOG.md)
- [Architecture decisions](docs/adr/README.md)
- [Reliability hardening design](docs/superpowers/specs/2026-07-14-tabkebab-reliability-hardening-design.md)
- [Reliability hardening implementation plan](docs/superpowers/plans/2026-07-14-tabkebab-reliability-hardening.md)
- [Reliability hardening SDD evidence archive](docs/reports/reliability-hardening-sdd/README.md)

## Credits

Created by **Michel Abboud**.

This project was built with the assistance of AI systems including Claude by Anthropic and Codex by OpenAI. In the spirit of full transparency: architecture decisions, code implementation, icon/logo design, documentation, and commit messages were produced through human-AI collaboration. Michel retains final review and approval.

## License

See [LICENSE](LICENSE) for details.

---

<p align="center">
  <a href="https://github.com/michelabboud/tabkebab-chrome-ext">GitHub</a> &middot;
  <a href="https://github.com/michelabboud/tabkebab-chrome-ext/issues">Issues</a> &middot;
  <a href="PRIVACY.md">Privacy</a> &middot;
  <a href="TERMS.md">Terms</a>
</p>
