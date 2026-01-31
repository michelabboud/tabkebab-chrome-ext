<p align="center">
  <img src="icons/logo.svg" alt="TabKebab" width="400">
</p>

<p align="center">
  <strong>Stack and organize your browser tabs like a kebab skewer.</strong>
</p>

<p align="center">
  <a href="GUIDE.md">User Guide</a> &middot;
  <a href="PRIVACY.md">Privacy Policy</a> &middot;
  <a href="TERMS.md">Terms of Service</a> &middot;
  <a href="https://github.com/michelabboud/tabkebab-chrome-ext/issues">Report Issue</a>
</p>

---

TabKebab is a Chrome side-panel extension that tames tab chaos. Group, stash, sleep, and restore tabs across windows — manually or with AI. Zero dependencies, zero telemetry, everything stays local unless you opt in.

## Features

### Tab Management

- **Live tab list** with favicon, title, URL, and active/discarded status
- **Sub-views**: All Tabs, By Domain, By Chrome Group, and a unified Groups editor
- **Drag-and-drop** tab reordering within and across groups
- **Close, pin, discard, or move** individual tabs from the side panel
- **Tab count badges** per window with color-coded thresholds (green / yellow / red)
- **Duplicate detection** and bulk close across all windows with confirmation

### Tab Grouping

- **Domain grouping** — one-click to group all tabs by domain into Chrome native tab groups
- **AI smart grouping** — understands context (research, shopping, work, entertainment) and creates meaningful groups
- **4-phase pipeline**: Snapshot → Solver → Planner → Executor with live progress per phase
- **Custom groups** — create, rename, recolor, and manage your own groups
- **Collapsible section headers** in the Groups sub-view

### Sessions

- **Save** full snapshots of every window, tab, and tab group layout
- **Restore** with automatic deduplication — already-open tabs are skipped
- **Restore modes**: original windows, current window, or single new window
- **Pipeline restore** for large sessions (20+ tabs): batched creation → load → discard with two-phase progress tracking
- **Auto-save** on browser start and at configurable intervals (default 24h), with retention policy
- **Per-session export** as JSON for sharing or backup
- **Rename and delete** sessions from the panel

### Stash

- **Stash and close** tabs by window, Chrome group, domain, or all at once
- Save to **IndexedDB** — no storage limits
- **Lazy restore** for large stashes: batched with per-batch discard to avoid overwhelming Chrome
- **Two-phase progress bar**: "Creating tabs..." then "Loading... X / Y ready" with animated stripe
- **Restored badge** on stashes already restored, with confirmation before re-restoring
- **Favicon previews**, source badges, tab count, and one-click restore or delete
- **Per-stash export** as JSON

### Bookmarks

- **Three bookmark formats**: By Windows, By Groups, By Domains
- **Multiple destinations**: Chrome Bookmarks, Local Storage, Google Drive, or all
- **Auto-bookmark on stash** — automatically create bookmarks when stashing
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
- **Auto-kebab** idle tabs after configurable hours

### Natural Language Commands

- Type commands like *"close YouTube tabs"*, *"find my GitHub tabs"*, *"group by project"*
- AI interprets intent and executes tab operations
- Works with any configured AI provider

### Google Drive Sync

- **Profile-scoped** — each Chrome profile gets its own folder
- **Folder structure**: `TabKebab / {profile} / sessions, stashes, bookmarks, archive`
- **Manual or automatic** sync at configurable intervals
- **Retention policy** with auto-cleanup of old files
- **Archive before overwrite** — previous versions saved before updating
- **Cross-profile settings import** from other profiles on the same Google account
- **HTML bookmark export** alongside JSON

### AI Providers

- **OpenAI** — GPT-4.1, GPT-5, o4-mini
- **Anthropic Claude** — Haiku, Sonnet, Opus
- **Google Gemini** — 2.5 Flash/Pro, 3.0 preview
- **Chrome Built-in AI** — Gemini Nano, on-device, no API key needed
- **Custom endpoint** — any OpenAI-compatible API (Ollama, LM Studio, Groq, Together AI)
- **Encrypted API key storage** with AES-GCM 256-bit and optional passphrase
- **Response caching** — LRU cache (200 entries, 24h expiry) to avoid redundant calls
- **Request queue** with concurrency control

### Export & Import

- **Full export/import** of all data: sessions, stashes, groups, settings
- **Individual exports** for sessions and stashes
- **Google Drive backup** with subfolder organization
- **JSON format** throughout — human-readable, version-controllable

### Settings

- **Default view** selection (Tabs, Windows, Stash, Sessions)
- **Theme** (System, Light, Dark)
- **Tab count thresholds** — configurable yellow/red warning levels
- **Automation** — auto-save interval, retention, auto-kebab, auto-stash
- **Bookmark configuration** — formats, destinations, compression, HTML export
- **Drive sync** — connection, auto-export toggles, sync interval, retention
- **Keep-awake domains** — manage the protected domain list

## Tech Stack

- **Manifest V3** with ES modules throughout
- **Side panel UI** — zero external dependencies
- **IndexedDB** for stash storage (no size limits)
- **Chrome APIs**: tabs, tabGroups, windows, bookmarks, storage, identity, alarms, sidePanel
- **Google Drive REST v3** with OAuth2 (`drive.file` scope)
- **4-phase grouping engine**: snapshot → solver → planner → executor
- **Adaptive batched operations** — lazy mode for 20+ tabs (5/batch with delay and per-batch discard)
- **AES-GCM 256-bit encryption** for API keys with PBKDF2 key derivation

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

1. Open Settings in the side panel
2. Scroll to the AI section (visible after connecting a provider)
3. Select a provider, enter your API key, and choose a model
4. The AI command bar and smart grouping features will activate

## Project Structure

```
TabKebab/
  manifest.json              # Extension manifest (MV3)
  service-worker.js          # Background service worker & message hub
  icons/                     # Logo and icon assets (SVG + PNG)
  core/
    tabs-api.js              # Chrome tabs/windows API wrapper
    sessions.js              # Session save/restore with v1→v2 migration
    stash-db.js              # IndexedDB stash storage
    grouping.js              # 4-phase grouping orchestrator
    duplicates.js            # Duplicate tab detection
    nl-executor.js           # Natural language command execution
    settings.js              # Settings schema and CRUD
    storage.js               # Storage abstraction layer
    export-import.js         # Full data export/import
    drive-client.js          # Google Drive REST API client
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
    components/
      tab-list.js            # Tab list + grouping controls
      window-list.js         # Windows view
      session-manager.js     # Sessions view
      stash-list.js          # Stash view
      group-editor.js        # Groups sub-view & editor
      duplicate-finder.js    # Duplicate detection UI
      command-bar.js         # AI command bar
      drive-sync.js          # Drive sync controls
      settings-manager.js    # Settings UI bindings
      ai-settings.js         # AI provider settings
      confirm-dialog.js      # Confirmation dialogs
      toast.js               # Toast notifications
```

## Credits

Created by **Michel Abboud**.

This project was built with the assistance of AI (Claude by Anthropic). In the spirit of full transparency: architecture decisions, code implementation, icon/logo design, documentation, and commit messages were produced through human-AI collaboration. Every line of code was reviewed and approved by the author.

## License

See [LICENSE](LICENSE) for details.

---

<p align="center">
  <a href="https://github.com/michelabboud/tabkebab-chrome-ext">GitHub</a> &middot;
  <a href="https://github.com/michelabboud/tabkebab-chrome-ext/issues">Issues</a> &middot;
  <a href="PRIVACY.md">Privacy</a> &middot;
  <a href="TERMS.md">Terms</a>
</p>
