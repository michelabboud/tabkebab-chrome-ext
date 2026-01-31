  # TabKebab 🍢

  Stack and organize your browser tabs like a kebab skewer.

  TabKebab is a Chrome side panel extension that tames tab chaos. Group, stash, sleep, and restore tabs across windows — manually or with AI.

  ## Features

  ## Organize
  - Group tabs by domain into Chrome native tab groups with one click
  - AI-powered smart grouping that understands context (research, shopping, work, etc.)
  - Drag-and-drop custom groups with color coding
  - Consolidate scattered windows into fewer, organized ones

  ## Stash
  - Save and close tabs by window, Chrome group, or domain — offloaded to IndexedDB
  - Restore later in discarded mode so tabs don't all load at once
  - Favicon previews, source badges, and one-click restore or delete

  ## Sessions
  - Save full snapshots of every window, tab, and group layout
  - Restore with automatic deduplication — already-open tabs are skipped
  - Auto-saves on browser start and every 24 hours, keeping the last 2
  - Per-session export for sharing or backup

  ## Tab Sleep (Kebab)
  - Discard tabs to free memory while keeping them in the tab strip
  - Per-domain keep-awake exceptions (email, calendars, AI tools protected by default)
  - AI-assisted classification suggests which domains to protect
  - Sleep by domain, group, window, or everything at once

  ## Find & Clean
  - Duplicate detection and bulk close across all windows
  - Natural language commands: "close YouTube tabs", "find my GitHub tabs", "group by project"

  ## Export & Sync
  - Full JSON export/import of sessions, stashes, groups, and settings
  - Individual session and stash exports
  - Google Drive sync (optional)

  ## AI Providers
  - OpenAI (GPT-4.1, GPT-5, o4-mini)
  - Anthropic Claude (Haiku, Sonnet, Opus)
  - Google Gemini (2.5 Flash/Pro, 3.0 preview)
  - Chrome Built-in AI (Gemini Nano, on-device, no API key)
  - Any OpenAI-compatible endpoint (Ollama, LM Studio, Groq, Together AI)

  ## Tech

  - Manifest V3, ES modules throughout
  - Side panel UI with zero dependencies
  - IndexedDB for stash storage (no size limits)
  - Batched tab operations with backpressure (10 tabs/batch, 50ms delay)
  - Encrypted API key storage with optional passphrase lock

  ## Install

  1. Clone this repo
  2. Open chrome://extensions → enable Developer Mode
  3. Click "Load unpacked" → select the project folder
  4. Click the TabKebab icon or pin it to open the side panel

  ---
