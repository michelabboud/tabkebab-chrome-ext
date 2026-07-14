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
8. [Focus Mode](#focus-mode)
9. [Bookmarks](#bookmarks)
10. [Natural Language Commands](#natural-language-commands)
11. [Google Drive Sync](#google-drive-sync)
12. [AI Configuration](#ai-configuration)
13. [Settings Reference](#settings-reference)
14. [Export & Import](#export--import)
15. [Keyboard & Tips](#keyboard--tips)
16. [Troubleshooting](#troubleshooting)

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

The header shows the TabKebab logo, a **version badge**, quick links to GitHub and the Privacy Policy, status icons for **Drive** and **AI** connections, a **Focus Mode** button (F), a **search** button (Ctrl+K), a **help button** (?), and a **gear icon** for Settings.

### Global Stats Bar

Below the navigation bar, a fixed stats bar displays three cards:

| Stat | Meaning |
|------|---------|
| **Windows** | Total open browser windows |
| **Tabs** | Total open tabs across all windows |
| **Active / Kebab** | Percentage of tabs that are active (not discarded) |

A hint line reads "Kebab = discarded tabs saving memory". The stats bar stays visible on every view and updates in real time.

### Navigation Bar

Four tabs switch between the main views. The active tab is highlighted with an accent underline. Each view retains its scroll position when you switch away and back.

### AI Command Bar

When AI is configured, a multi-line command bar appears below the stats bar. Type natural language commands and press **Enter** to send (or **Shift+Enter** for a new line). A small label shows the active AI provider name (e.g., "OpenAI", "Claude"). See [Natural Language Commands](#natural-language-commands) for details.

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

1. **Custom Groups** — groups you create within TabKebab. Includes a toolbar to create new groups. Each group card has:
   - Collapsible body with drag-and-drop tab slots
   - **Smart search input** — type to filter open tabs by title or URL; matching tabs appear with a **+** button to add them to the group
   - **URL paste** — if the input looks like a URL, an "Add URL" option appears to add it directly
   - **Apply to Chrome** — creates a native Chrome tab group from the custom group
2. **Chrome Tab Groups** — lists all native Chrome tab groups with their color and title. Click to expand and see member tabs. Groups with no title display as "Untitled Group".
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

The **Duplicates** sub-tab shows a **red badge** on the tab button with the current count of extra duplicate copies plus empty pages. This count is updated automatically every 60 seconds and after any close operation.

Click **Scan for Duplicates** to refresh the list. Results show:
- Number of duplicates found per URL
- Each duplicate group with checkboxes (first tab marked "KEEP", rest pre-checked for closing)
- **Close** button per tab or **Close All Duplicates** for bulk removal with lossless undo from each selected tab's exact original URL
- Badge resets to zero when all duplicates are resolved

URL fragments are part of duplicate identity. For example, `https://app.test/#/one` and `https://app.test/#/two` are different pages, while two exact copies of either route form their own duplicate group. **Undo** reopens the exact captured URLs, including query strings and fragments.

### Empty Pages

Above the duplicate list, an **Empty Pages** row appears if any blank tabs are detected. Empty pages include:
- `about:blank` tabs
- Tabs with no URL

Chrome's `chrome://newtab` and `chrome://new-tab-page` pages are intentionally preserved and are not offered as duplicate or empty-page cleanup targets.

Click **Close Empty Pages** to remove them all at once. The badge count includes both duplicates and empty pages.

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

- **Bring to Front** button — brings that browser window to the foreground
- **Consolidate** button intelligently reorganizes your windows (see below)
- Tab counts update in real time

### Consolidate Windows

The **Consolidate** button runs a 3-phase optimization:

1. **Redistribute from huge windows** — Windows with >100 tabs have excess tabs moved to smaller windows that have room. Targets ~50 tabs per window.

2. **Merge tiny windows** — Windows with <30 tabs are merged into larger windows to reduce clutter.

3. **Balance groups** — Windows with >8 Chrome tab groups have their smallest groups moved to windows with fewer groups. This keeps each window manageable.

After consolidation, the grouping pipeline runs automatically to organize tabs by domain.

| Threshold | Value | Purpose |
|-----------|-------|---------|
| Window cap | 100 tabs | Windows above this are considered oversized |
| Ideal size | 50 tabs | Target tabs per window after redistribution |
| Min size | 30 tabs | Windows below this get merged |
| Max groups | 8 | Groups per window before rebalancing |

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
- Tabs are restored in batches of up to six. Successful creations retain their own saved pinned/group metadata even if a sibling tab fails.
- In the default discard pipeline, only background tabs being discarded are temporarily muted. Each is unmuted after the discard attempt, including failure cleanup; the first visible tab stays active and unmuted.
- A non-discarding restore does not mute restored tabs.
- The result accounts for every saved tab as restored, already-open, invalid, or failed. An incomplete result shows a counted warning and keeps the original stash unchanged for recovery.
- Progress shows the creation and loading/discard phases without hiding partial failures.

### Other Stash Actions

- **Export** — download the stash as a JSON file
- **Delete** — permanently remove the stash (with confirmation)

### Settings Integration

- **Remove stash after restore** (Settings > General): deletes the stash only after a complete restore. Invalid URLs or Chrome API failures retain the unchanged stash even when removal was requested.

---

## Sessions View

Sessions capture a complete snapshot of your browser state. The view is split into two sub-tabs:

| Tab | Contents |
|-----|----------|
| **Saved** | Sessions you created manually via the Save button |
| **Auto** | Sessions created automatically by the auto-save scheduler |

The **Auto** tab displays a count badge and strips the `[Auto]` prefix from session names since the tab itself indicates the type.

### What's Saved in a Session

- All windows (positions not saved, only content)
- All tabs per window: URL, title, favicon URL, pinned state
- Tab group metadata: group name, color, which tabs belong to it
- Timestamp and session name

### Saving a Session

Type a name in the input at the top of the Sessions view and click **Save** (or press Enter). The snapshot is saved to `chrome.storage.local` and appears in the **Saved** tab.

### Auto-Save

TabKebab automatically saves a session:
- **On browser start**
- **At regular intervals** (default: every 24 hours)
- Auto-saves are subject to a retention policy (default: keep 7 days of auto-saves)
- At least 2 auto-saves are always kept regardless of retention

Auto-saved sessions appear in the **Auto** tab with just the date/time as their name.

### Restoring a Session

Click **Restore** on a session card to open in new windows matching the original layout. Click **Restore here** to open all tabs in the current window. In both modes, tabs already open (by URL) are skipped.

Session restore uses the same settlement-preserving coordinator as stash restore. Each saved tab is counted; valid siblings continue restoring after a creation failure; pinned state and groups stay associated with the correct successful tab. Incomplete restores show restored, duplicate, invalid, and failed counts while the saved session remains available to retry.

The default discard pipeline temporarily mutes only background tabs that are about to be discarded and always attempts to unmute them afterward. The first visible tab remains active and unmuted, and non-discarding restores never mute tabs.

### Session Actions

- **Export** — download as JSON (arrow icon)
- **Delete** — remove permanently with 8-second undo via toast

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

## Focus Mode

Focus Mode transforms TabKebab into a productivity assistant. Start a timed session, and TabKebab clears distractions — discarding or stashing non-focus tabs, blocking distracting navigations, and showing a live countdown with stats.

### Starting a Focus Session

Access Focus Mode via:
- **Header button** — click the target/crosshair icon in the header
- **Keyboard** — press `F` (when not in an input field)

### Built-in Profiles

Choose from 4 preset profiles, each with suggested domains and duration:

| Profile | Color | Suggested Duration | Allowed Domains |
|---------|-------|-------------------|-----------------|
| **Coding** | Cyan | 50 min | github.com, gitlab.com, stackoverflow.com, developer.mozilla.org, localhost |
| **Writing** | Purple | 25 min | docs.google.com, notion.so, grammarly.com |
| **Research** | Green | 45 min | (open browsing allowed) |
| **Meeting** | Blue | 60 min | meet.google.com, zoom.us, teams.microsoft.com, docs.google.com |

### Setup Options

Before starting, configure:

1. **Duration** — set minutes or check "Open-ended" for unlimited timer
2. **Tab Action** — what happens to non-focus tabs when you start:
   - **Kebab** — discard background non-focus tabs (they stay in the tab strip but unload); the active tab is never discarded
   - **Stash** — save and close background non-focus tabs (auto-restored when the session ends); the active tab is never closed
   - **Group** — create a Chrome tab group containing only eligible focus tabs. If Chrome metadata or Focus-state persistence fails after grouping begins, TabKebab rolls the partial group back instead of leaving it unmanaged.
   - **None** — monitor only, don't touch tabs
3. **Blocking Mode**:
   - **Strict Mode** — only allowlisted entries are permitted. With an empty allowlist, every non-internal URL is blocked.
   - **Curated Categories** — select categories to block (Social, Video, Gaming, News, Shopping, Entertainment)
   - **AI Detection** — AI categorizes unknown domains in real-time
4. **Allowlist** — add entries that are always permitted:
   - **Domain** — permits the exact host and true subdomains, but not lookalike suffixes
   - **URL** — permits only the canonical exact URL; path, query, and fragment case is preserved and prefix extensions do not match
   - **Chrome Group** — stores the group's exact title and rebinds it to every live group with that title when a run starts, the worker restarts, or a paused run resumes. Untitled groups cannot be saved.

Chrome and extension-internal pages are never blocked and are excluded from startup discard, stash, and grouping actions. The same allowlist policy is used both when Focus starts and when later navigations are evaluated. If a tab is still navigating when Focus starts, its pending destination controls classification and is the URL preserved by a Focus stash. Duplicate legacy preferences collapse to one entry with the same type and value.

Each session has a unique run ID. A deterministic or AI classification is applied only while that exact run is still active, its captured lifecycle generation is unchanged, the tab still exists, and either its current URL or its non-empty pending URL is exactly the URL that was classified. AI results must explicitly mark the page distracting with a finite numeric confidence strictly greater than `0.7`; fresh and cached results use the same rule. Pausing, pausing and resuming the same run, ending, replacing the run, closing the tab, or navigating elsewhere while classification is pending makes the result a no-op.

### The Focus HUD

Once started, the panel shows a colorful timer dashboard:

- **Profile-colored display** — the entire HUD glows in your profile's color with a subtle pulsing animation
- **Countdown timer** — large minutes:seconds display (or elapsed time if open-ended)
- **Progress bar** — visual progress toward your goal
- **Stats** — distractions blocked and focus tab count
- **Controls** — Pause, +5 min extend, End Session

The extension badge shows the remaining minutes during focus and `||` while paused. Pause, Resume, Extend, and End are bound to the run currently displayed by the panel; if that run has already been replaced, the stale command is ignored and the panel refreshes. Badge and side-panel updates are likewise tied to the current durable run, so a delayed event from an older run cannot repaint, blink, switch views, or clear a replacement session.

### Distraction Blocking

When you navigate to a blocked site during focus:

1. TabKebab intercepts the navigation and goes back
2. The distractions counter flashes and increments
3. A toast notification shows what was blocked

Blocking is a **soft block** — you can always navigate manually after the redirect. The friction is the point.

### Session End

When the timer expires (or you click End Session):

1. If tabs were stashed, they're automatically restored
2. Focus tab group is removed (tabs ungrouped)
3. Badge clears, timer stops
4. A **report overlay** shows your session stats:
   - Profile and duration
   - Distractions blocked
   - Focus tabs count
5. The session is saved to your focus history

Ending intent is saved before teardown begins. If Chrome suspends or restarts the service worker, TabKebab resumes an unfinished ending run without duplicating its history or repeating a successfully checkpointed stash restore or ungroup. An incomplete restore keeps the session in a non-blocking ending state until a later retry completes. A Focus-created group is ungrouped only when its durable token still matches browser-session ownership; after a full browser restart, a reused numeric group ID is left untouched. Restore, ownership, ungroup, alarm, badge, history, and final-state errors are merged into the session result without reactivating blocking.

### Focus History

Click "Recent Sessions" to see your last 50 focus sessions with date, profile, duration, and distraction count. Useful for tracking productivity over time.

### Preferences Per Profile

TabKebab remembers your choices for each profile:
- Blocked categories
- Allowlist entries
- Strict mode / AI blocking toggles
- Duration and tab action

Switch profiles and your last configuration is restored.

Chrome-group preferences remain title-only. Numeric Chrome group IDs are runtime data and are never saved as profile authority, so a browser restart cannot accidentally trust an ID that Chrome reused for another group.

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

1. Your command and current tab list (titles + URLs) are sent to the AI provider.
2. The AI returns structured actions (close, group, move, etc.). Domain filters match only the exact host and true subdomains: `github.com` includes `docs.github.com`, but not `notgithub.com` or `github.com.evil.test`.
3. A close action shows a confirmation preview. At confirmation, TabKebab queries the live tabs again, reapplies the original filter, and can only narrow the preview-approved IDs; a tab that navigated away is not closed. A title-based close also waits for any pending navigation to settle instead of trusting the previous page's stale title.
4. TabKebab executes the validated action and shows results in the command bar.

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

- **Drive retention** — auto-delete only strictly dated recoverable copies older than N days (default: 30)
- **Never delete from Drive** — override retention, keep everything forever
- Canonical `tabkebab-sync.json` and `tabkebab-settings.json` files are never retention candidates
- The newest copy in each bounded file category is preserved, including every tie; young, cutoff-equal, malformed, undated, wrong-folder, and unrelated JSON/HTML files are also preserved
- Manual cleanup reports deleted files plus canonical, newest, and undated files protected; any partial deletion is shown as incomplete rather than success
- Existing files are archived (copied with a timestamp) before overwrite; if the archive copy fails, the overwrite is aborted

### Cross-Profile Import

If you have multiple Chrome profiles connected to the same Google account, you can import settings from another profile:

1. In Settings > Google Drive, look for the profile list
2. Click a profile name to import its settings
3. An "Undo" button appears in case you want to revert

### Disconnecting

Click **Disconnect** to remove Chrome's cached OAuth token and stop syncing in TabKebab. This does not revoke the account-level grant; revoke that separately in your Google Account if desired. Your files remain regular files in Google Drive.

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
| Auto-kebab idle tabs | 3 hours | Discard tabs idle for N hours (0 = off) |
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

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **1** | Switch to Windows view |
| **2** | Switch to Tabs view |
| **3** | Switch to Stash view |
| **4** | Switch to Sessions view |
| **F** | Start Focus Mode |
| **/** | Focus the AI command bar |
| **?** | Toggle the help overlay |
| **Esc** | Close help/settings overlay, or blur the current input |

Shortcuts are disabled when typing in an input, textarea, or select. Press **Esc** in any input to blur it first.

### Help Overlay

Press **?** or click the help button (circle with question mark) in the header to open a comprehensive help overlay. It covers:
- View descriptions
- Key features
- All keyboard shortcuts
- Usage tips
- Links to the full guide and issue tracker

Click the backdrop or press **Esc** to dismiss.

### Tips for Power Users

- **Pin the side panel** for persistent access while browsing
- **Use domain grouping** first to organize, then refine with AI smart grouping
- **Set auto-kebab to 4-8 hours** to automatically free memory from forgotten tabs
- **Enable auto-bookmark on stash** so you never lose track of stashed tabs
- **Use compressed export + HTML bookmarks** for efficient Drive storage with browsable access
- **Connect Google Drive** across multiple computers with the same Google account for cross-device sync
- **Search tabs in custom groups** — use the smart input in each group card to quickly add tabs by name or URL

### Performance Tips

- For 100+ tabs, prefer **domain grouping** over AI grouping (faster, no API call)
- **Kebab tabs** regularly to keep memory usage low — the stats bar shows your Active/Kebab percentage
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
