# TabKebab User Guide

A complete guide to every feature in TabKebab.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [The Side Panel](#the-side-panel)
3. [Tabs View](#tabs-view)
4. [Windows View](#windows-view)
5. [Stash View](#stash-view)
6. [Sessions View](#sessions-view)
7. [Tab Sleep (Kebab)](#tab-sleep-kebab)
8. [Bookmarks](#bookmarks)
9. [Natural Language Commands](#natural-language-commands)
10. [Google Drive Sync](#google-drive-sync)
11. [AI Configuration](#ai-configuration)
12. [Settings Reference](#settings-reference)
13. [Export & Import](#export--import)
14. [Keyboard & Tips](#keyboard--tips)
15. [Troubleshooting](#troubleshooting)

---

## Getting Started

### Installation

1. Clone the repository or download the source:
   ```
   git clone https://github.com/michelabboud/tabkebab-chrome-ext.git
   ```
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer Mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the TabKebab folder
5. The TabKebab icon appears in your toolbar

### Opening the Side Panel

- **Click** the TabKebab icon in the toolbar, or
- **Right-click** the icon and select "Open side panel"
- **Pin** the icon for quick access: click the puzzle-piece icon in the toolbar, then pin TabKebab

The side panel opens on the right side of your browser and stays open as you browse.

### First Launch

On first launch, TabKebab opens to the **Tabs** view showing all tabs in your current window. The four main views are accessible via the navigation bar at the top:

| Tab | Purpose |
|-----|---------|
| **Windows** | Overview of all browser windows with tab counts |
| **Tabs** | Live tab list with grouping, search, and management |
| **Stash** | Saved tab collections stored in IndexedDB |
| **Sessions** | Full browser state snapshots |

---

## The Side Panel

### Header

The header shows the TabKebab logo and a **gear icon** to access Settings. Settings is a full-screen overlay covering all configuration options.

### Navigation Bar

Four tabs switch between the main views. The active tab is highlighted with an accent underline. Each view retains its scroll position when you switch away and back.

### AI Command Bar

When AI is configured, a command bar appears at the top of the main area. Type natural language commands and press Enter or click **Go**. See [Natural Language Commands](#natural-language-commands) for details.

---

## Tabs View

The Tabs view is the primary workspace. It has a toolbar row and four sub-views.

### Toolbar

- **Refresh** — reload the tab list
- **Sub-view buttons**: All | Domains | Groups | a groups editor icon
- **Find Duplicates** — scan all windows for duplicate tabs
- **Kebab** dropdown — sleep (discard) tabs by scope
- **Stash** dropdown — stash and close tabs by scope
- **Group** dropdown — organize tabs into Chrome groups

### Sub-view: All Tabs

Shows every tab in the current window as a flat list. Each tab row displays:

- **Favicon** (from Google's favicon API)
- **Title** (truncated with ellipsis)
- **URL** (dimmed, truncated)
- **Status indicator**: active tab has an accent dot; discarded tabs show a sleep icon

**Actions per tab** (on hover):
- Close (X button)
- Right-click context for pin, discard, move to window

### Sub-view: By Domain

Tabs grouped by their domain name. Each domain section shows:
- Domain name and tab count badge
- Collapsible: click the header to expand/collapse
- Tabs listed within each domain

### Sub-view: By Chrome Group

Shows tabs organized by their Chrome native tab group. Includes:
- Group color dot and name
- Ungrouped tabs in a separate section
- Collapsible group headers

### Sub-view: Groups Editor

A unified editor for managing tab groups. Three collapsible sections:

1. **Chrome Tab Groups** — lists all native Chrome tab groups with their color and title. Click to expand and see member tabs.
2. **Custom Groups** — groups you create within TabKebab. Includes a toolbar to create new groups.
3. **Ungrouped Tabs** — tabs not belonging to any group.

Each section header has a **collapse/expand chevron**.

### Grouping Tabs

The **Group** dropdown offers:

- **By Domain** — groups all tabs by their domain into Chrome native tab groups. Domains with only 1 tab are left ungrouped.
- **Smart (AI)** — sends tab titles and URLs to your configured AI provider. The AI creates contextual groups (e.g., "Research", "Shopping", "Work Tools").
- **Ungroup All** — removes all tab group assignments.

When grouping runs, a **4-phase progress indicator** appears:

1. **Snapshot** — captures current tab state
2. **Solving** — determines group assignments (domain-based or AI)
3. **Planning** — calculates which Chrome operations are needed
4. **Executing** — moves tabs and creates groups in Chrome

### Finding Duplicates

Click **Find Duplicates** to scan all windows. Results show:
- Number of duplicates found
- List of duplicate sets with tab titles
- **Close Duplicates** button with confirmation dialog
- Keeps the most recent copy of each duplicate

---

## Windows View

Shows all open browser windows as cards.

### Window Cards

Each card displays:
- **Window number** (Window 1, Window 2, etc.)
- **Tab count badge** with color coding:
  - **Green**: below warning threshold
  - **Yellow**: above warning threshold (default: 20)
  - **Red**: above danger threshold (default: 50)
- **Focused window** indicator

### Actions

- Click a window card to **focus** that window
- **Consolidate** button merges all tabs from all windows into the current window
- Tab counts update in real time

---

## Stash View

Stashing saves tabs and closes them, freeing browser resources while preserving your work.

### Creating a Stash

Use the **Stash** dropdown in the Tabs toolbar:

- **Stash Window** — saves and closes all tabs in the current window
- **Stash by Group** — saves and closes tabs by their Chrome group
- **Stash by Domain** — saves and closes tabs grouped by domain
- **Stash All** — saves and closes all tabs across all windows

Each stash records: tab URLs, titles, favicon URLs, pinned state, group metadata, source type, and timestamp.

### Stash List

Stashes appear as cards with:
- **Name** (based on source: window name, group name, or "All Tabs")
- **Tab count** badge
- **Favicon previews** — up to 5 favicons from the stashed tabs
- **Source badge** — Window, Group, Domain, or All
- **Restored badge** — shows if the stash has already been restored
- **Timestamp**

### Restoring a Stash

Click the **Restore** button on a stash card.

- If the stash has a "Restored" badge, a confirmation dialog asks if you want to restore again.
- **Small stashes** (under 20 tabs): all tabs open at once.
- **Large stashes** (20+ tabs): uses **pipeline restore**:
  1. Tabs are created in batches of 5
  2. Each batch loads in the background
  3. After loading, tabs are discarded to save memory
  4. Progress bar shows two phases: "Creating tabs..." then "Loading... X / Y ready"
  5. An animated stripe on the progress bar indicates active loading

### Other Stash Actions

- **Export** — download the stash as a JSON file
- **Delete** — permanently remove the stash (with confirmation)

### Settings Integration

- **Remove stash after restore** (Settings > General): automatically deletes the stash after successful restore.

---

## Sessions View

Sessions capture a complete snapshot of your browser state.

### What's Saved in a Session

- All windows (positions not saved, only content)
- All tabs per window: URL, title, favicon URL, pinned state
- Tab group metadata: group name, color, which tabs belong to it
- Timestamp and session name

### Saving a Session

Click **Save Session** in the Sessions view. A dialog lets you name the session (default: timestamp). The snapshot is saved to `chrome.storage.local`.

### Auto-Save

TabKebab automatically saves a session:
- **On browser start** (labeled "Auto-save (startup)")
- **At regular intervals** (default: every 24 hours)
- Auto-saves are subject to a retention policy (default: keep 7 days of auto-saves)
- A maximum of 2 auto-saves are kept at any time

### Restoring a Session

Click **Restore** on a session card. A dropdown offers three modes:

| Mode | Behavior |
|------|----------|
| **Original Windows** | Creates new windows matching the saved layout. Tabs already open (by URL) are skipped. |
| **Current Window** | Opens all tabs in the current window. Duplicates skipped. |
| **Single Window** | Opens all tabs in one new window regardless of original window layout. |

**Pipeline restore** (same as stash) activates for sessions with 20+ tabs, with two-phase progress tracking.

### Session Actions

- **Rename** — edit the session name
- **Export** — download as JSON
- **Delete** — remove permanently

---

## Tab Sleep (Kebab)

"Kebab" means discarding a tab — Chrome keeps it in the tab strip but unloads it from memory. The tab reloads when you click on it.

### How to Kebab

The **Kebab** dropdown in the Tabs toolbar offers:

- **Kebab Domain** — discard all tabs on a specific domain
- **Kebab Group** — discard all tabs in a Chrome group
- **Kebab Window** — discard all tabs in the current window
- **Kebab All** — discard all tabs across all windows

### Keep-Awake List

Some tabs should never be discarded (email clients, calendars, real-time tools). The keep-awake list protects these domains.

**Default protected domains** include: `gmail.com`, `calendar.google.com`, `outlook.com`, `slack.com`, `teams.microsoft.com`, `discord.com`, and others.

**Manage the list** in Settings > Tab Sleep:
- **Add domain** — type a domain and click Add
- **Remove** — click X next to any domain
- **Suggest (AI)** — if AI is configured, click to get AI suggestions for which domains to protect based on your current tabs
- **Reset to Defaults** — restore the original domain list

### Auto-Kebab

In Settings > Automation, set **Auto-kebab idle tabs** to a number of hours. Tabs idle for longer than this threshold are automatically discarded. The keep-awake list is respected. Set to 0 to disable.

### Auto-Stash

Set **Auto-stash inactive tabs** to a number of days. Tabs inactive for longer are automatically stashed and closed. Set to 0 to disable.

---

## Bookmarks

TabKebab can create organized bookmarks from your current tabs in three formats.

### Bookmark Formats

| Format | Hierarchy |
|--------|-----------|
| **By Windows** | TabKebab / date / Windows / Window 1 / tabs |
| **By Groups** | TabKebab / date / Groups / group name / tabs |
| **By Domains** | TabKebab / date / Domains / domain / tabs |

Enable one or more formats in Settings > Bookmarks.

### Destinations

| Destination | Storage |
|-------------|---------|
| **Chrome Bookmarks** | Creates folders in Chrome's bookmark bar under a "TabKebab" folder |
| **Local Storage** | Saves to `chrome.storage.local` (max 50 snapshots) |
| **Google Drive** | Uploads JSON to `TabKebab/{profile}/bookmarks/` on Drive |
| **All** | Saves to all three destinations |

### Creating Bookmarks

1. Configure formats and destination in Settings > Bookmarks
2. Click **Bookmark Now** in the Bookmarks settings section
3. Or enable **Auto-bookmark on stash** to create bookmarks every time you stash tabs

### Compressed Export

Enable **Compressed export** to save bookmark JSON without whitespace formatting. Reduces file size on Drive.

### HTML Bookmark Page

Enable **HTML bookmarks to Drive** to upload a self-contained, browsable HTML page alongside the JSON file. The HTML page features:

- **Tab navigation** — switch between Windows, Groups, and Domains views
- **Clickable pills** — each group/window/domain appears as a pill button at the top of its panel; click to scroll to that group
- **Live search** — type to filter tabs across all panels with highlighted matches
- **Collapsible groups** — click any group header to collapse/expand
- **Dark/light mode** — follows your system preference
- **Responsive** — works on mobile (URL column hidden on small screens)

Open the HTML file directly in Google Drive's preview to browse your bookmarks from any device.

---

## Natural Language Commands

When an AI provider is configured, the command bar appears at the top of the panel.

### Supported Commands

Type natural language instructions like:

| Command | What it does |
|---------|-------------|
| "close YouTube tabs" | Closes all tabs with YouTube URLs |
| "find my GitHub tabs" | Highlights/filters GitHub tabs |
| "group by project" | AI groups tabs by inferred project context |
| "close all shopping tabs" | AI identifies and closes shopping-related tabs |
| "stash all social media" | Stashes tabs the AI classifies as social media |
| "how many tabs do I have?" | Returns tab count information |

### How It Works

1. Your command and current tab list (titles + URLs) are sent to the AI provider
2. The AI returns structured actions (close, group, move, etc.)
3. TabKebab executes the actions and shows results in the command bar

Commands never send page content, cookies, passwords, or browsing history — only tab titles and URLs.

---

## Google Drive Sync

### Connecting

1. Go to Settings > Google Drive
2. Click **Connect Google Drive**
3. A popup asks you to sign in with your Google account
4. Enter a **profile name** (e.g., "Work", "Personal") — this scopes all data to a subfolder
5. Once connected, the status shows your profile name and last sync time

### Folder Structure

```
Google Drive/
  TabKebab/
    {profile name}/
      tabkebab-sync.json      # Main sync file
      tabkebab-settings.json  # Settings backup
      sessions/
        sessions-2026-01-31.json
      stashes/
        stashes-2026-01-31.json
      bookmarks/
        bookmarks-2026-01-31-1738300800000.json
        bookmarks-2026-01-31.html
      archive/
        tabkebab-sync-2026-01-30T14-30-00.json
```

### Syncing

- **Sync Now** — manually push all data to Drive
- **Auto-sync** — set an interval in hours (Settings > Google Drive > Auto-sync interval)
- Data pushed: sessions, stashes, bookmarks, settings

### Auto-Export Options

- **Auto-export sessions** — include sessions in every sync
- **Auto-export stashes** — include stashes in every sync

### Retention & Cleanup

- **Drive retention** — auto-delete files older than N days (default: 30)
- **Never delete from Drive** — override retention, keep everything forever
- Files are archived (copied with timestamp) before being overwritten

### Cross-Profile Import

If you have multiple Chrome profiles connected to the same Google account, you can import settings from another profile:

1. In Settings > Google Drive, look for the profile list
2. Click a profile name to import its settings
3. An "Undo" button appears in case you want to revert

### Disconnecting

Click **Disconnect** to revoke the OAuth token and stop syncing. Your files remain on Google Drive — they're just regular files in your Drive.

---

## AI Configuration

### Setting Up a Provider

1. Go to Settings (gear icon in the header)
2. The AI section appears in settings with provider options
3. Select a provider from the dropdown
4. Enter your API key (if required)
5. Optionally set a passphrase to encrypt the API key
6. Choose a model

### Available Providers

| Provider | Models | API Key Required | Notes |
|----------|--------|-----------------|-------|
| **OpenAI** | GPT-4.1, GPT-5, o4-mini | Yes | Most popular option |
| **Anthropic Claude** | Haiku, Sonnet, Opus | Yes | Strong reasoning |
| **Google Gemini** | 2.5 Flash, 2.5 Pro, 3.0 | Yes | Google's models |
| **Chrome Built-in AI** | Gemini Nano | No | Runs on-device, requires Chrome flags |
| **Custom Endpoint** | Any | Depends | OpenAI-compatible API (Ollama, LM Studio, etc.) |

### API Key Security

- Keys are encrypted with **AES-GCM 256-bit** using PBKDF2 key derivation (100,000 iterations)
- Optional **passphrase** for encryption; otherwise a per-profile install ID is used
- Decrypted keys are held in **session storage** (cleared on browser restart)
- Plaintext keys are **never written to disk**

### Chrome Built-in AI

To use Gemini Nano (on-device, no API key):

1. You need Chrome 127+ with specific flags enabled
2. Go to `chrome://flags/#optimization-guide-on-device-model` → Enable
3. Go to `chrome://flags/#prompt-api-for-gemini-nano` → Enable
4. Restart Chrome
5. Select "Chrome Built-in AI" as your provider in TabKebab

### Response Caching

AI responses are cached locally (LRU, max 200 entries, 24-hour expiry) to avoid redundant API calls. Same tab configuration → cached response → no API cost.

---

## Settings Reference

Access settings via the **gear icon** in the header.

### General

| Setting | Default | Description |
|---------|---------|-------------|
| Remove stash after restore | On | Auto-delete stash entries once restored |
| Default view | Tabs | Which view opens on launch |
| Theme | System | Light, Dark, or follow system preference |

### Tab Limits

| Setting | Default | Description |
|---------|---------|-------------|
| Warning threshold (yellow) | 20 | Tabs per window before yellow badge |
| Danger threshold (red) | 50 | Tabs per window before red badge |

### Automation

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-save interval | 24 hrs | Hours between automatic session saves |
| Auto-save retention | 7 days | Days to keep auto-saved sessions |
| Auto-kebab idle tabs | 0 (off) | Discard tabs idle for N hours |
| Auto-stash inactive tabs | 0 (off) | Stash tabs inactive for N days |

### Bookmarks

| Setting | Default | Description |
|---------|---------|-------------|
| By Windows | Off | Bookmark tabs organized by window |
| By Groups | Off | Bookmark tabs organized by Chrome group |
| By Domains | Off | Bookmark tabs organized by domain |
| Destination | Chrome | Where to save (Chrome / Local / Drive / All) |
| Auto-bookmark on stash | Off | Create bookmarks when stashing tabs |
| Compressed export | Off | Compact JSON without whitespace |
| HTML bookmarks to Drive | Off | Upload browsable HTML alongside JSON |

### Google Drive

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-export sessions | Off | Include sessions in Drive sync |
| Auto-export stashes | Off | Include stashes in Drive sync |
| Auto-sync interval | 0 (manual) | Hours between automatic syncs |
| Drive retention | 30 days | Auto-delete files older than this |
| Never delete from Drive | Off | Override retention, keep all files |

### Tab Sleep (Kebab)

The keep-awake domain list is managed in this section. Add, remove, or reset domains. Use AI suggestions if a provider is configured.

---

## Export & Import

### Full Export

In Settings, use the **Export All** button to download a JSON file containing:
- All sessions
- All stashes
- All custom groups
- All settings
- Keep-awake domain list

### Full Import

Use **Import** to load a previously exported JSON file. This merges with existing data (doesn't overwrite unless there are conflicts).

### Individual Exports

- **Session export**: click the export icon on any session card → downloads `session-{name}.json`
- **Stash export**: click the export icon on any stash card → downloads `stash-{name}.json`

---

## Keyboard & Tips

### Tips for Power Users

- **Pin the side panel** for persistent access while browsing
- **Use domain grouping** first to organize, then refine with AI smart grouping
- **Set auto-kebab to 4-8 hours** to automatically free memory from forgotten tabs
- **Enable auto-bookmark on stash** so you never lose track of stashed tabs
- **Use compressed export + HTML bookmarks** for efficient Drive storage with browsable access
- **Connect Google Drive** across multiple computers with the same Google account for cross-device sync

### Performance Tips

- For 100+ tabs, prefer **domain grouping** over AI grouping (faster, no API call)
- **Kebab tabs** regularly to keep memory usage low
- **Stash old tabs** instead of keeping them open — they're safely stored in IndexedDB
- **Pipeline restore** handles large sessions gracefully — let it complete without interrupting

---

## Troubleshooting

### "Tab not responding" after restore

Large session restores create many tabs at once. The pipeline restore (batched creation + discard) mitigates this, but Chrome may still be sluggish for a moment. Wait for the progress bar to complete.

### AI features not appearing

- Ensure you've selected a provider and entered a valid API key in Settings
- Check that the API key has credits/quota remaining
- For Chrome Built-in AI, verify the required flags are enabled in `chrome://flags`

### Google Drive not syncing

- Check that you're signed into Chrome with the same Google account
- Click **Disconnect** then **Connect** to re-authenticate
- Ensure your Google account has available Drive storage

### Stash data not appearing

Stashes are stored in IndexedDB, which is per-profile. If you switched Chrome profiles, your stashes are in the other profile's storage.

### Extension not loading

- Verify Developer Mode is enabled in `chrome://extensions`
- Check for errors in the extension's service worker console (click "Inspect views: service worker" on the extension card)
- Ensure all files are present (didn't accidentally delete any)

### API key issues

- If you set a passphrase, you'll need to re-enter it after Chrome restarts
- If you forgot your passphrase, remove the API key and add it again
- Keys are encrypted at rest — they can't be recovered from storage

---

## Contact & Support

- **GitHub**: [github.com/michelabboud/tabkebab-chrome-ext](https://github.com/michelabboud/tabkebab-chrome-ext)
- **Issues**: [github.com/michelabboud/tabkebab-chrome-ext/issues](https://github.com/michelabboud/tabkebab-chrome-ext/issues)
- **Privacy Policy**: [PRIVACY.md](PRIVACY.md)
- **Terms of Service**: [TERMS.md](TERMS.md)
