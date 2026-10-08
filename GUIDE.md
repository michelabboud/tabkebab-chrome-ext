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

On first launch, TabKebab opens to the **Tabs** view, and a short **Getting started** card walks you through the group → stash → restore loop in four steps (click **Skip tour** to dismiss it, or replay it later from Settings > General > **Replay guide**). The four main views are in the view bar at the top, in this order:

| View | Key | Purpose |
|------|-----|---------|
| **Tabs** | `1` | Live tabs by domain, Chrome groups and custom groups, and duplicates |
| **Windows** | `2` | Overview of all browser windows with tab counts |
| **Stash** | `3` | Saved tab collections stored in IndexedDB |
| **Sessions** | `4` | Full browser state snapshots |

Focus Mode and Settings open from icons in the header.

---

## The Side Panel

### Header

The header shows the TabKebab logo and, from left to right:

- **Drive status** (cloud) and **AI status** (sparkle) icons. Both features are opt-in, so "not set up" is a neutral grey icon (for example "AI: off — click to set up"). A configured feature that works shows a small green dot, and only a configured feature that is failing turns red. Click either icon to jump to its Settings section.
- **Focus Mode** (target icon, `F`). It pulses red while a focus session runs.
- **Search** (magnifier, `Ctrl+K`).
- **Help** (`?`).
- **Settings** (gear).

While Focus or Settings is open, its header icon shows as selected instead of a view-bar tab. The version number, privacy policy and GitHub links are in Settings > About.

### View Bar

Four pill-shaped tabs switch between **Tabs**, **Windows**, **Stash** and **Sessions**. The selected view is a filled pill. Press `1`–`4`, or focus the bar and use the `←` / `→` arrow keys. Each view keeps its scroll position when you switch away and back.

### Stats Strip

Under the view bar, one line summarizes your browser, for example `3 windows · 21 tabs · 0 sleeping`. "Sleeping" tabs are discarded ("kebab'd") to free memory; they reload when you open them. The strip updates in real time and is hidden on Settings and Focus, where it carries no information.

### Focus Banner

While a focus session is running or paused, a slim banner across every view reads, for example, `Focus · Coding · 49:58 left` (or `12:30 elapsed` for an open-ended session, plus `· paused` when paused). Click it to open the Focus view, or click **End** to end the session (see [Session End](#session-end)). The banner is hidden while the Focus view itself is open, and it stays visible even if Focus Mode is switched off in Settings > Features, so a running session can always be ended. It also follows sessions started, paused or ended from a TabKebab panel in another window.

### AI Command Bar

When an AI provider is set up, a one-line command bar appears under the stats strip: "Ask TabKebab… (e.g. close YouTube tabs)". Press `/` to jump to it, type a command and press **Enter** (or click **Go**). **Shift+Enter** adds a new line. A small label under it shows the provider, for example "via OpenAI". See [Natural Language Commands](#natural-language-commands).

### Search

Press `Ctrl+K` (`Cmd+K` on macOS) or click the magnifier to search **open tabs**, **stashes** and **sessions** at once by title or URL. `Ctrl+K` works even while you are typing in a field, and `/` opens search when the AI command bar is not set up.

- Results are grouped into **Open Tabs**, **Stashes** and **Sessions** with a count each. Up to 10 are listed per group; **Show all N** opens the matching view.
- Use `↑` / `↓` to move through results and **Enter** to open one: a tab is brought to the front in its window, and a stash or session opens its view with that card scrolled into view and highlighted.
- Press **Esc** or click outside to close search.

---

## Tabs View

The Tabs view is the primary workspace. A sub-tab bar switches between three sub-views: **Domains**, **Groups** and **Duplicates** (the Duplicates tab carries a red badge when duplicates exist).

Every tab row shows the favicon and title. Hover a row to see the full title and URL, click it to switch to that tab, or click **×** to close it. Discarded (sleeping) tabs are dimmed.

### Domains

Tabs from all windows, grouped by domain. Blank and browser-internal pages are listed together under **Blank & browser pages**.

**Toolbar** (one row):

- **Group by domain ▾** — a split button. The main part groups tabs into Chrome tab groups by domain (see [Grouping Tabs](#grouping-tabs)). The **▾** part opens a menu with **Smart group (AI)** and **Ungroup all…**.
- **Sleep all** — discard (kebab) every background tab in every window to free memory. Active tabs, keep-awake domains and already-sleeping tabs are skipped.
- **⇕** — collapse or expand every domain row at once.

**Domain rows.** Each row shows the domain name (long names are truncated), a tab count, and `W1, W2` when the domain is open in more than one window; its tabs are then split into per-window sub-lists. Click a row to collapse or expand it. On the right of each row:

- **Stash** — save and close this domain's tabs (see [Stash View](#stash-view)). A toast offers **Undo**.
- **⋯** — more actions for this domain:
  - **Sleep tabs (Kebab)** — discard this domain's tabs.
  - **Keep awake** — a check item; when on, this domain is never discarded and the row is marked.
  - **Summarize tabs (AI)** — shown when AI is available.
  - **Close N tabs…** — close all of this domain's tabs, after a confirmation.

### Groups

Three collapsible sections (click a section title to fold it):

1. **Custom Groups** — groups you create within TabKebab. Type a name, pick a color and click **Create**. Each group card has:
   - Collapsible body with drag-and-drop tab slots (drag tabs in from anywhere in the Groups view)
   - **Smart search input** — type to filter open tabs by title or URL; matching tabs appear with a **+** button to add them to the group
   - **URL paste** — if the input looks like a URL, an "Add URL" option appears to add it directly
   - **Apply to Chrome** — creates a native Chrome tab group from the custom group
   - **Delete group** — removes the custom group locally; its deletion propagates to other connected profiles at the next sync
2. **Chrome Tab Groups** — every native Chrome tab group with its color, title and tab count (groups with no title show as "Untitled Group"). The section toolbar has **Sleep all** (discard every grouped tab) and **⇕** (collapse or expand all groups in Chrome's tab strip). Each group row has **Stash** and a **⋯** menu with **Sleep tabs (Kebab)**, **Keep awake**, **Collapse in tab strip** / **Expand in tab strip**, **Ungroup** and **Close N tabs…**.
3. **Ungrouped Tabs** — tabs not belonging to any group.

### Grouping Tabs

Grouping lives in the **Group by domain ▾** split button on the Domains toolbar:

- **Group by domain** (main button) — groups tabs by their domain into Chrome native tab groups. Domains with only 1 tab are left ungrouped, and pinned tabs, blank pages and browser-internal pages are never grouped.
- **Smart group (AI)** (in the ▾ menu) — groups tabs by topic (e.g., "Research", "Shopping", "Work Tools"). It uses your configured AI provider, or Chrome's on-device AI when that is available without setup; a one-line hint under the toolbar says so when on-device AI is ready. If Smart group can't run, an inline notice explains why and offers **Group by domain** now or **Add an API key**.
- **Ungroup all…** (in the ▾ menu) — removes every tab group after a confirmation ("Ungroup all tabs?"). Tabs stay open; group names and colors are lost.

When grouping runs, a **4-phase progress indicator** appears:

1. **Snapshot** — captures current tab state
2. **Solving** — determines group assignments (domain-based or AI)
3. **Planning** — calculates which Chrome operations are needed
4. **Executing** — moves tabs and creates groups in Chrome

### Finding Duplicates

The **Duplicates** sub-tab shows a **red badge** with the number of extra duplicate copies (blank pages are not counted). The count is refreshed every 60 seconds and after any close operation.

Click **Scan for duplicates** to refresh the list. Results show:
- One card per duplicated URL, showing a readable host and path (hover for the full URL)
- Each tab with a checkbox: the first copy is marked **KEEP**, the rest are pre-checked for closing
- **Close** per tab, or **Close N duplicates** to close every checked copy at once. The toast offers **Undo**, which reopens the exact original URLs.
- The badge resets to zero when all duplicates are resolved

URL fragments are part of duplicate identity. For example, `https://app.test/#/one` and `https://app.test/#/two` are different pages, while two exact copies of either route form their own duplicate group. **Undo** reopens the exact captured URLs, including query strings and fragments.

### Empty Pages

Above the duplicate list, an **Empty Pages** row appears if any blank tabs are detected. Empty pages include:
- `about:blank` tabs
- Tabs with no URL

Chrome's `chrome://newtab` and `chrome://new-tab-page` pages are intentionally preserved and are not offered as duplicate or empty-page cleanup targets.

Click **Close Empty Pages** to remove them all at once. Empty pages are counted in this row, not in the Duplicates badge.

---

## Windows View

Shows all open browser windows as cards. The toolbar has **Consolidate windows** (see below) and **⇕** to collapse or expand every card.

### Window Cards

Each card header displays:
- A **status dot** colored by tab count:
  - **Green**: below the warning threshold
  - **Yellow**: at or above the warning threshold (default: 20)
  - **Red**: at or above the danger threshold (default: 50); the count turns into a red "N tabs" badge
- **Window number** (Window 1, Window 2, etc.) and the tab count
- The **current window** is marked with an accent edge on the card and a small dot after its name

Click a header to expand the card. The body lists the window's Chrome groups as chips and collapsible sections (plus an **Ungrouped** section), and a **Bring to front** button.

### Actions

- **Stash** — save and close every tab in that window. A toast offers **Undo**.
- **⋯** — **Sleep tabs (Kebab)** for that window; for other windows also **Bring to front** and **Close window…** (with confirmation).
- Tab counts update in real time

### Consolidate Windows

The **Consolidate windows** button runs a 3-phase optimization:

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

Click **Stash** on any of these rows:

- a **domain** row in Tabs > Domains — saves and closes that domain's tabs
- a **Chrome group** row in Tabs > Groups — saves and closes the group's tabs
- a **window** card in Windows — saves and closes all tabs in that window

Blank pages, browser-internal pages, other pages a restore could not reopen (such as extension pages, `about:` and `data:` URLs) and incognito tabs stay open and are not stashed (pinned tabs are stashed and come back pinned). A toast confirms what was stashed, for example "Stashed 3 tabs from github.com", with an **Undo** button for 8 seconds: Undo reopens those tabs and removes the stash. Focus Mode (Stash action), auto-stash and AI commands can also create stashes.

Each stash records: tab URLs, titles, favicon URLs, pinned state, group metadata, source type, and timestamp.

### Stash List

Stashes appear as cards with:
- **Name** (the domain, group, or window it came from)
- **Source badge** — Window, Group, or Domain
- **Restored badge** — shows if the stash has already been restored
- **Favicon previews** from the stashed tabs
- **Tab count** and **timestamp**

### Restoring a Stash

Click **Restore** on a stash card to reopen the tabs in their own windows, or **Restore here** to open them in the current window.

- If the stash has a "Restored" badge, a confirmation dialog asks if you want to restore again.
- Tabs are restored in batches of up to six. Successful creations retain their own saved pinned/group metadata even if a sibling tab fails.
- In the default discard pipeline, only background tabs being discarded are temporarily muted. Each is unmuted after the discard attempt, including failure cleanup; the first visible tab stays active and unmuted.
- A non-discarding restore does not mute restored tabs.
- The result accounts for every saved tab as restored, already-open, invalid, or failed. An incomplete result shows a counted warning and keeps the original stash unchanged for recovery.
- Progress shows the creation and loading/discard phases without hiding partial failures.

### Other Stash Actions

- **Export** (⤓ icon) — download the stash as a JSON file
- **Save to Google Drive** (cloud icon) — shown when Drive is connected
- **Delete** — removes the stash, with an **Undo** button in the toast for 8 seconds
- The **⋯** menu next to the "Stashed tabs" heading has **Export stashes (JSON)** and **Import stashes…**

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

Incognito tabs and pages that cannot be reopened (such as extension pages, `about:` and `data:` URLs) are not saved.

### Saving a Session

Type a name in the input at the top of the Sessions view and click **Save** (or press Enter). The name is optional: leave it empty and the session is named after the current date and time, for example **Session — Oct 8, 9:18 PM**. The snapshot is saved to `chrome.storage.local` and appears in the **Saved** tab.

The **⋯** menu next to **Save** has **Export all data (JSON)** and **Import JSON…** (see [Export & Import](#export--import)).

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

- **Export** (⤓ icon) — download as JSON
- **Delete** — remove locally with an 8-second Undo action. The deletion propagates to other connected profiles at the next sync.

Session Undo restores exactly one newer copy while retaining the deletion's convergence metadata. That retained metadata prevents an older copy from another profile from replacing the restored session during the next sync. Manual-group deletion also propagates at the next sync, but it does not offer Undo.

---

## Tab Sleep (Kebab)

"Kebab" means discarding a tab — Chrome keeps it in the tab strip but unloads it from memory. The tab reloads when you click on it.

### How to Kebab

- **Sleep all** on the Tabs > Domains toolbar — discard every background tab in every window
- **Sleep all** on the Tabs > Groups toolbar — discard every tab that is in a Chrome group
- **⋯ > Sleep tabs (Kebab)** on a domain row, a Chrome group row, or a window card — discard just those tabs

The active tab of each window, keep-awake domains and tabs that are already sleeping are skipped. The stats strip shows how many tabs are sleeping.

### Keep-Awake List

Some tabs should never be discarded (email clients, calendars, real-time tools). The keep-awake list protects these domains.

**Default protected domains** include: `gmail.com`, `calendar.google.com`, `outlook.com`, `slack.com`, `teams.microsoft.com`, `discord.com`, and others.

**Toggle a domain** from its row: **⋯ > Keep awake** on a domain or Chrome group row in the Tabs view.

**Manage the list** in Settings > Tab Sleep (Kebab):
- **Add domain** — type a domain and click Add
- **Count and filter** — the list shows how many domains are protected; type in **Filter domains** to find one, and click **Show all** to expand a long list
- **Remove** — click × next to any domain
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
- **Header button** — click the target icon in the header
- **Keyboard** — press `F` (when not in an input field)

Press **Esc** to leave the Focus setup and go back to Tabs.

### Built-in Profiles

Choose from 4 preset profiles, each with suggested domains and duration:

| Profile | Color | Suggested Duration | Allowed Domains |
|---------|-------|-------------------|-----------------|
| **Coding** | Cyan | 50 min | github.com, gitlab.com, stackoverflow.com, developer.mozilla.org, localhost |
| **Writing** | Purple | 25 min | docs.google.com, notion.so, grammarly.com |
| **Research** | Green | 45 min | (open browsing allowed) |
| **Meeting** | Blue | 60 min | meet.google.com, zoom.us, teams.microsoft.com, docs.google.com |

### Setup Options

The top of the setup screen has everything needed to start:

1. **Profile** — Coding, Writing, Research or Meeting
2. **Duration** — minutes, or check **Open-ended** for an unlimited timer
3. **Start Focus**

Everything else is folded under **Customize** (it remembers whether you left it open):

1. **When focus starts** — what happens to non-focus tabs:
   - **Kebab non-focus tabs** — discard background non-focus tabs (they stay in the tab strip but unload); the active tab is never discarded
   - **Stash non-focus tabs** — save and close background non-focus tabs (auto-restored when the session ends); the active tab is never closed
   - **Group focus tabs only** — create a Chrome tab group containing only eligible focus tabs. If Chrome metadata or Focus-state persistence fails after grouping begins, TabKebab rolls the partial group back instead of leaving it unmanaged.
   - **Do nothing (monitor only)** — don't touch tabs
2. **Blocking**:
   - **Strict Mode** — only allowlisted entries are permitted. With an empty allowlist, every non-internal URL is blocked.
   - **AI Detection** — AI categorizes unknown domains in real-time. It is disabled until AI is set up; a **Set up AI** link opens the AI settings.
   - **Block categories** — select categories to block (Social, Video, Gaming, News, Shopping, Entertainment)
3. **Allowed (whitelist)** — add entries that are always permitted:
   - **Domain** — permits the exact host and true subdomains, but not lookalike suffixes
   - **URL** — permits only the canonical exact URL; path, query, and fragment case is preserved and prefix extensions do not match
   - **Chrome Group** — stores the group's exact title and rebinds it to every live group with that title when a run starts, the worker restarts, or a paused run resumes. Untitled groups cannot be saved.
4. **Blocked domains (additional)** — extra domains to block on top of the categories

Chrome and extension-internal pages are never blocked and are excluded from startup discard, stash, and grouping actions. The same allowlist policy is used both when Focus starts and when later navigations are evaluated. If a tab is still navigating when Focus starts, its pending destination controls classification and is the URL preserved by a Focus stash. Duplicate legacy preferences collapse to one entry with the same type and value.

Each session has a unique run ID. A deterministic or AI classification is applied only while that exact run is still active, its captured lifecycle generation is unchanged, the tab still exists, and either its current URL or its non-empty pending URL is exactly the URL that was classified. AI results must explicitly mark the page distracting with a finite numeric confidence strictly greater than `0.7`; fresh and cached results use the same rule. Pausing, pausing and resuming the same run, ending, replacing the run, closing the tab, or navigating elsewhere while classification is pending makes the result a no-op.

### The Focus HUD

Once started, the Focus view shows a timer dashboard in your profile's color (with matching light and dark theme colors):

- **Header** — "Focus mode · Coding", plus a **Paused** tag while paused
- **Timer** — large minutes:seconds display, with "remaining · N%" for a timed session or "elapsed" for an open-ended one
- **Progress bar** — timed sessions only
- **Stats** — distractions blocked and focus tab count
- **Controls** — **Pause** / **Resume**, **+5 min** (timed sessions only), and **End Session**

Outside the Focus view, the [Focus banner](#focus-banner) keeps the countdown and an **End** button visible on every view.

The extension badge shows the remaining minutes during focus and `||` while paused. Pause, Resume, Extend, and End are bound to the run currently displayed by the panel; if that run has already been replaced, the stale command is ignored and the panel refreshes. Badge and side-panel updates are likewise tied to the current durable run, so a delayed event from an older run cannot repaint, blink, switch views, or clear a replacement session.

### Distraction Blocking

When you navigate to a blocked site during focus:

1. TabKebab intercepts the navigation and goes back
2. The distractions counter flashes and increments
3. A toast notification shows what was blocked

Blocking is a **soft block** — you can always navigate manually after the redirect. The friction is the point.

### Session End

When the timer expires, or you click **End Session** in the HUD or **End** in the banner:

- A timed session with more than a minute left first asks **End focus early?** ("You have 49:58 left. Your stats so far will be saved.") with **Keep focusing** and **End session**. Open-ended sessions, and timed sessions in their last minute, end right away.

Then:

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

Click **Recent Sessions** at the bottom of the setup screen to see your last 50 focus sessions with date, profile, duration, and distraction count. Useful for tracking productivity over time.

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
| **Chrome Bookmarks** | Creates folders in Chrome's bookmark bar under a "TabKebab" folder (see limits below) |
| **Local Storage** | Saves to `chrome.storage.local` (max 50 snapshots) |
| **Google Drive** | Uploads JSON to `TabKebab/{profile}/bookmarks/` on Drive |
| **All** | Saves to all three destinations |

Chrome bookmark exports are kept bounded:

- At most 4 folder levels below the bookmark bar. If you move the TabKebab folder deeper, lower levels are flattened into the bookmark titles (for example `Windows · Window 1`).
- A renamed or moved TabKebab folder is found again and reused.
- The newest 30 date folders are kept; older date folders under the TabKebab folder are removed.
- One export stops at 5,000 bookmarks and says so.
- Exporting again on the same day replaces that day's snapshot instead of duplicating it.

Incognito tabs are never bookmarked. **Auto-bookmark on stash** bookmarks exactly the tabs that were stashed.

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

When an AI provider is set up, the command bar appears under the stats strip. Press `/` to jump to it.

### Supported Commands

Type natural language instructions like:

| Command | What it does |
|---------|-------------|
| "close YouTube tabs" | Closes tabs on youtube.com and its subdomains, after a confirmation |
| "find my GitHub tabs" | Lists the matching tabs with **Group**, **Close all** and **Dismiss** buttons |
| "group my docs tabs" | Groups the matching tabs into a named Chrome tab group (one group per window) |
| "move Jira tabs to a new window" | Moves the matching tabs into a new window |
| "switch to my Gmail tab" | Brings the first matching tab to the front |

The supported actions are close, group, move (to a new window), switch to a tab, and find. Matching is by domain, text in the title, or text in the URL.

### How It Works

1. Your command and the current tab list (titles and domains, up to 200 tabs) are sent to the AI provider.
2. The AI returns one structured action (close, group, move, focus or find) with a filter. Filters that would match far too broadly are rejected. Domain filters match only the exact host and true subdomains: `github.com` includes `docs.github.com`, but not `notgithub.com` or `github.com.evil.test`.
3. A close action always shows a confirmation, and a group or move asks first when it spans more than one window or more than 20 tabs. The confirmation is built from the actual matching tabs (count, windows, pinned tabs, titles), never from AI-written text. Pinned tabs are never grouped. At confirmation, TabKebab queries the live tabs again, reapplies the original filter, and can only narrow the preview-approved IDs; a tab that navigated away is not closed. A title-based close also waits for any pending navigation to settle instead of trusting the previous page's stale title.
4. TabKebab executes the validated action and shows results in the command bar. A "find" command lists the matching tabs with **Group**, **Close all** and **Dismiss** buttons.

Commands never send page content, cookies, passwords, or browsing history — only your command plus tab titles and domains.

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

- **Drive retention** — move only strictly dated recoverable copies older than N days (default: 30) to the Google Drive trash; nothing is permanently deleted by TabKebab
- **Never delete from Drive** — override retention, keep everything forever
- Canonical `tabkebab-sync.json` and `tabkebab-settings.json` files are never retention candidates
- The newest copy in each bounded file category is preserved, including every tie, and the newest export of every individually exported stash is kept; young, cutoff-equal, malformed, undated, wrong-folder, and unrelated JSON/HTML files are also preserved
- **Clean Drive Files** reports the files removed (moved to the trash) plus canonical, newest, and undated files protected; any partial cleanup is shown as incomplete rather than success
- Sync deletion records (which make a deleted session or custom group stay deleted on other profiles) expire after 180 days and are capped, so sync can't break permanently
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

1. Open Settings (gear icon) and click the **AI** chip in the index at the top — or just click the AI status icon in the header
2. In **AI provider**, pick a provider. The first option, **Off**, means AI is disabled; picking a provider expands its setup
3. Enter your API key (if required); **Show** reveals what you typed
4. Optionally check **Protect API key with passphrase**; otherwise the key uses device protection
5. Choose a model (**Load** fetches the provider's current list) and, for Custom, review the endpoint URL
6. Click **Save Settings**, then **Test Connection**

To turn AI off, choose **Off** and click **Save Settings**. Your saved keys stay encrypted in storage. To hide every AI control as well, switch off **AI** in Settings > Features.

**Test Connection** and **Load Models** use only the saved provider configuration. If the selected provider has unsaved changes, save them first. A passphrase-protected key must also be unlocked for the current browser session before either action or any AI command can use it.

### Available Providers

| Provider | Models | API Key Required | Notes |
|----------|--------|-----------------|-------|
| **OpenAI** | GPT-6 Luna (default), GPT-5.x, GPT-4.1 | Yes | Most popular option |
| **Anthropic Claude** | Haiku 5.5 (default), Sonnet, Opus | Yes | Strong reasoning |
| **Google Gemini** | 3.8 Flash (default), 3.x Flash-Lite, 3.1 Pro | Yes | Google's models |
| **Chrome Built-in AI** | Gemini Nano | No | Runs on-device in a supported Chrome side panel |
| **Custom Endpoint** | Any | Depends | OpenAI-compatible API (Ollama, LM Studio, etc.) |

### API Key Security

- Keys are encrypted with **AES-GCM 256-bit** using PBKDF2 key derivation (600,000 iterations for keys saved with this version; keys saved by older versions still decrypt)
- Optional **passphrase** protection derives the encryption key from a passphrase you know; otherwise device protection uses a random per-profile install ID
- Decrypted keys are held only in **session storage**. They survive service-worker idle/suspension, but Chrome clears them on a full browser restart, extension reload, extension update, or disable
- Plaintext keys are **never written to disk**
- Settings and newly entered keys are validated, encrypted, and committed as one operation; keys and passphrases are never returned in a runtime response or written to logs
- Changing between device and passphrase protection requires re-entering every stored provider key. Older profiles with a mixture of protection modes show an indeterminate setting and likewise require every key to normalize the profile

After a browser restart, select the protected provider and use the **Unlock selected provider** field (enter the passphrase and click **Unlock**). A wrong passphrase leaves the provider locked and does not alter the encrypted key. The correct passphrase unlocks only that provider for the current browser session.

### Custom Endpoint Safety

Remote Custom endpoints must use HTTPS. Plain HTTP is accepted only for loopback development hosts such as `localhost`, `*.localhost`, `127.0.0.0/8`, and `[::1]`; endpoint URLs cannot contain credentials, query strings, or fragments. Changing the origin of a Custom endpoint that already has a stored key requires re-entering that key. Portable imports cannot redirect an existing local Custom key to a different origin; the local endpoint is preserved instead.

Google Gemini authentication is sent in the `x-goog-api-key` request header, never in the request URL. TabKebab also rejects provider errors or successful responses that reflect a submitted credential.

### Request Timeouts and Retries

Each AI attempt has a 120-second limit. When that limit is reached, TabKebab cancels the provider operation and waits for its cleanup before the UI becomes available again. A connection test reports failure and model loading returns no models; a timed-out late response is never cached.

Only transient network and rate-limit failures retry automatically, with at most three total attempts. Timeout, cancellation, authentication, unavailable-provider, malformed-result, and local Chrome AI failures do not retry automatically. Clicking **Test Connection** or submitting the command again is an explicit new attempt, started only after the prior attempt has settled.

### Chrome Built-in AI

[Chrome Built-in AI](https://developer.chrome.com/docs/ai/built-in-apis) uses
Chrome's on-device Prompt API and requires a supported Chrome/device
configuration. Extension use is supported from Chrome 138. The model must
already report `available`; TabKebab does not silently start a model download
when Chrome reports `downloadable` or `downloading`.

The Prompt API is a document-only capability, so keep the TabKebab side panel
open while testing the connection or starting uncached Chrome AI work. TabKebab
automatically reconnects a live panel after a Manifest V3 worker restart. When
multiple browser windows have TabKebab panels open, the newest connection owns
requests and older connections remain available as standbys. Provider work is
serialized across those documents with an extension-origin Web Lock, including
cleanup during failover. Closing a panel aborts its in-flight work and suppresses
late results; Chrome then tears down that panel document. Another open standby
can resume after cleanup, otherwise the worker reports that foreground access
is required.

Background Focus Mode never opens the panel by itself. With Chrome AI selected
and the panel closed, a new uncached classification is skipped safely: the tab,
Focus counter, Focus state, and AI cache are left unchanged. A previously cached
classification may still proceed through the normal live run/tab/URL guard.

To use it:

1. Confirm the Prompt API and on-device model are supported and already
   available in Chrome.
2. Open the TabKebab side panel.
3. Select **Chrome Built-in AI** and save the AI settings.
4. Use **Test Connection** before relying on it for interactive commands.

### Response Caching

AI responses are cached locally (LRU, max 200 entries, 24-hour expiry) to avoid redundant API calls. Cache identities are SHA-256 hashes scoped to the provider, model, prompts, credential, complete Custom endpoint, and request options, so changing an account, endpoint, or request configuration cannot reuse an older response.

---

## Settings Reference

Access settings via the **gear icon** in the header; press **Esc** to go back to Tabs. A sticky row of chips at the top — **General · Features · Sleep · AI · Automation · Bookmarks · Drive** — jumps to each section (chips for switched-off features are hidden). The cards appear in this order:

1. General
2. Features
3. Tab Sleep (Kebab)
4. AI Features
5. Automation
6. Tab Limits (advanced, collapsed by default)
7. Bookmarks
8. Google Drive
9. Backup & restore
10. About (version, privacy policy, terms, GitHub)

Settings save as soon as you change them, except the AI card, which has its own **Save Settings** button.

### General

| Setting | Default | Description |
|---------|---------|-------------|
| Theme | System | Light, Dark, or follow system preference |
| Default view | Tabs | Which view opens on launch |
| Remove stash after restore | On | Auto-delete stash entries once restored |
| Getting started | — | **Replay guide** restarts the four-step getting-started card |

### Features

TabKebab is a toolbox: keep everything, or switch off what you don't use to
declutter the panel. The **Features** card (right after General) has one
switch per feature. Every switch is **on** by default, changes save and apply
immediately (no reload), and turning a feature off **never deletes its data**:
turn it back on and everything is where you left it.

| Switch | What turning it off does |
|--------|--------------------------|
| Focus Mode | Hides the Focus button, the Focus banner and the `F` shortcut. A session that is already running finishes normally; new sessions can't start. |
| AI | Hides the AI status icon, Smart group, AI summaries, AI keep-awake suggestions, the command bar and the AI settings card. Your provider settings and keys stay saved. |
| AI command bar | Hides only the natural-language command bar (it also needs AI on). |
| Search | Hides the search button and the `Ctrl+K` / `/` search. |
| Windows view | Hides the Windows view and window consolidation. |
| Stash | Hides the Stash view and every Stash button, and stops auto-stash. Existing stashes stay stored and restorable. |
| Sessions | Hides the Sessions view and stops auto-save. Saved sessions are kept. |
| Duplicates | Hides the Duplicates sub-tab and badge and stops the background duplicate scan. |
| Automation | Stops the auto-save, auto-kebab and auto-stash schedules (and old auto-save pruning) and hides the Automation card. |
| Bookmarks | Stops bookmark snapshots (Bookmark Now, auto-bookmark on stash) and hides the Bookmarks card. |
| Google Drive | Stops Drive sync and Drive retention, hides the Drive status icon, Drive buttons and the Drive card. Nothing is removed from Drive. |

Notes:

- The number-key shortcuts follow the visible views: with Windows off,
  `1` Tabs, `2` Stash, `3` Sessions. The help dialog (`?`) lists only what is
  switched on, and the getting-started guide skips steps for features that are off.
- If the view you're on is switched off, the panel goes back to Tabs.
- Recovery always works: listing and restoring stashes and sessions, undo,
  and **Backup & restore** / Export stay available whatever is switched off.
- The switches are part of exported settings. Importing settings merges them
  per feature and never weakens the Drive retention guards.

### Tab Sleep (Kebab)

The keep-awake domain list is managed in this section: add, filter, remove, or reset domains. Use **Suggest (AI)** if AI is available. See [Keep-Awake List](#keep-awake-list).

### AI Features

The **AI provider** select (Off, OpenAI, Claude, Gemini, Chrome Built-in AI, Custom) and the selected provider's key, model and passphrase. See [AI Configuration](#ai-configuration).

### Automation

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-save interval | 24 hrs | Hours between automatic session saves |
| Auto-save retention | 7 days | Days to keep auto-saved sessions |
| Auto-kebab idle tabs | 3 hours | Discard tabs idle for N hours (0 = off) |
| Auto-stash inactive tabs | 0 (off) | Stash tabs inactive for N days |

### Tab Limits

Collapsed by default; click **Tab Limits (Advanced)** to open it.

| Setting | Default | Description |
|---------|---------|-------------|
| Warning threshold (yellow) | 20 | Tabs per window before yellow badge |
| Danger threshold (red) | 50 | Tabs per window before red badge |

### Bookmarks

Destination, auto-bookmark on stash and **Bookmark Now** are always shown; the format and export options are folded under **Folder formats and export options**.

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

**Connect Google Drive** is shown until you connect; then **Sync Now**, **Disconnect** and the settings below appear. Retention options are folded under **Retention and cleanup**.

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-export sessions | Off | Include sessions in Drive sync |
| Auto-export stashes | Off | Include stashes in Drive sync |
| Auto-sync interval | 0 (manual) | Hours between automatic syncs |
| Drive retention | 30 days | Move dated copies older than this to the Drive trash |
| Never delete from Drive | Off | Override retention, keep all files |

### Backup & restore

**Export Settings**, **Export all data** and **Import Settings**. See [Export & Import](#export--import).

---

## Export & Import

### Full Export

Use **Export all data (JSON)** in the Sessions **⋯** menu, or **Export all data** in Settings > Backup & restore, to download a portable version-2 backup containing:

- All sessions
- All stashes
- All custom groups
- Keep-awake domain list
- Local bookmark snapshots
- Effective general settings, including defaults not yet written to storage
- Focus profile preferences and history
- AI provider/model choices and custom base URL, but no API key or passphrase metadata

The export intentionally excludes Drive/OAuth state, install identifiers, active Focus state, caches, and decrypted or encrypted API-key material.

### Full Import

Use **Import JSON…** in the Sessions **⋯** menu to load a supported full or sessions file. TabKebab rejects files above 25 MiB, malformed data, secrets, and the wrong export kind before changing storage.

Imports merge under one service-worker lock. Existing same-ID sessions, stashes, groups, bookmarks, Focus preferences, and history remain authoritative; keep-awake domains are combined; imported general settings update the local settings (but never weaken Drive retention); and imported AI settings contribute only per-provider model choices: an import never turns AI on, switches the AI provider, or sets a Custom endpoint, and an existing encrypted local key is kept. The eight local-storage sections commit together, and IndexedDB stashes are replaced atomically. If either commit fails, TabKebab restores the affected snapshots and reports failure instead of claiming success.

After a settings or full import, TabKebab also refreshes its automation schedules. A red committed-warning message means the data was imported but one or more schedules could not be refreshed; restart TabKebab before relying on automatic actions.

### Individual Exports

- **Session export**: click the ⤓ export icon on any session card → downloads a one-session v2 file
- **Stash export**: click the ⤓ export icon on any stash card → downloads a one-stash v2 file
- **All stashes**: use **Export stashes (JSON)** in the Stash **⋯** menu; **Import stashes…** accepts only stash files
- **Settings**: use **Export Settings** or **Import Settings** in Settings > Backup & restore; the importer accepts only settings files

---

## Keyboard & Tips

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **1** | Switch to Tabs view |
| **2** | Switch to Windows view |
| **3** | Switch to Stash view |
| **4** | Switch to Sessions view |
| **← / →** | Move between views (or sub-tabs) when the view bar has keyboard focus |
| **F** | Open Focus Mode |
| **Ctrl+K** / **Cmd+K** | Open or close search (works even while typing) |
| **/** | Jump to the AI command bar, or open search when AI is not set up |
| **?** | Toggle the help dialog |
| **Esc** | Close search or help; leave Settings or Focus setup (back to Tabs); in a field, leave the field |

The number keys follow the views that are switched on: with Windows off, `1` is Tabs, `2` Stash and `3` Sessions. Single-key shortcuts never fire while you type in an input, textarea, or select, or together with Ctrl/Cmd/Alt, so `Ctrl+F` stays the browser's find. Press **Esc** in any input to leave it first.

### Help Dialog

Press **?** or click the help button (circle with question mark) in the header to open the help dialog. It covers:
- View descriptions
- Key features
- Keyboard shortcuts (matching the views that are switched on)
- Usage tips
- Links to the full guide and issue tracker

Press **Esc** or **?**, click **×**, or click the backdrop to close it.

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
- **Kebab tabs** regularly to keep memory usage low — the stats strip shows how many tabs are sleeping
- **Stash old tabs** instead of keeping them open — they're safely stored in IndexedDB
- **Pipeline restore** handles large sessions gracefully — let it complete without interrupting

---

## Troubleshooting

### "Tab not responding" after restore

Large session restores create many tabs at once. The pipeline restore (batched creation + discard) mitigates this, but Chrome may still be sluggish for a moment. Wait for the progress bar on the card to complete.

### AI features not appearing

- Ensure **AI** is on in Settings > Features, and that you've selected a provider (not **Off**), entered a valid API key and clicked **Save Settings**
- Check that the API key has credits/quota remaining
- For Chrome Built-in AI, use a supported Chrome/device with an already
  available on-device Prompt model and keep the side panel open. TabKebab does
  not silently start a model download.

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

- If you set a passphrase, re-enter it in **Unlock selected provider** after Chrome fully restarts, the extension reloads or updates, or you disable and re-enable it
- Service-worker idle by itself does not lock the key; the session-storage entry remains available
- Save a changed provider selection before using **Test Connection** or **Load Models**
- If you forgot your passphrase, remove the API key and add it again
- Keys are encrypted at rest — they can't be recovered from storage

### Release-candidate verification

Maintainers verify browser-only behavior against the single zip produced by
the exact successful CI run, not against the repository checkout. The
[real-Chrome smoke matrix](docs/guides/real-chrome-smoke-matrix.md) covers
recoverable restores, Focus races and URL identity, Drive v2 convergence and
retention, portable export/import, passphrase restart unlock, Chrome AI's
foreground boundary, the production 120-second timeout, checked UI failures,
and Ctrl+K. Its disposable-profile and cleanup rules intentionally exclude
private browsing data and credentials from evidence.

---

## Contact & Support

- **GitHub**: [github.com/michelabboud/tabkebab-chrome-ext](https://github.com/michelabboud/tabkebab-chrome-ext)
- **Issues**: [github.com/michelabboud/tabkebab-chrome-ext/issues](https://github.com/michelabboud/tabkebab-chrome-ext/issues)
- **Privacy Policy**: [PRIVACY.md](PRIVACY.md)
- **Terms of Service**: [TERMS.md](TERMS.md)
