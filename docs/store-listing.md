# TabKebab — Chrome Web Store listing

## Short description

Group, stash, restore, and focus your Chrome tabs. Smart Group can use Chrome's local AI with no account or API key.

## Long description

TabKebab turns Chrome's side panel into a practical workspace for organizing
open tabs without handing your browsing data to another company.

Chrome shows a broad warning for the `tabs` permission. Here is what TabKebab
actually reads: metadata for your currently open tabs — URL, title, favicon URL,
pinned and active state, window, and Chrome tab-group membership. It uses that
metadata to display your tabs, group them, find duplicates, stash or restore
them, save sessions, and run Focus features. TabKebab does not read page
content, keystrokes, form data, cookies, passwords, or your full browsing
history.

No TabKebab account is required. TabKebab has no application server, analytics,
telemetry, tracking, or crash-reporting backend. Local features keep their data
in your Chrome profile, and nothing is sent to us because there is no TabKebab
server to receive it.

Smart Group works with Chrome's built-in AI when that on-device model is
available: no account or API key is needed, and the grouping request stays on
your machine. If Chrome's model is unavailable, TabKebab offers one-click domain
grouping and a path to optional AI settings instead of blocking your work.
OpenAI, Anthropic Claude, and Google Gemini are optional and are contacted only
after you supply the matching API key. You may also configure your own
OpenAI-compatible endpoint, which can be local or remote and may use a key if
that endpoint requires one.

Google Drive sync is optional and requires you to connect a Google account.
Network-backed AI and Drive receive only the data needed for the action you
choose. Exported files are downloaded where you direct them. Stash previews can
load stored HTTP(S) favicons from the hosts named by those icon URLs, and opened
bookmark HTML exports can load favicon images from Google's s2 service. See
`PRIVACY.md` for the full disclosure.

### Features

- Start quickly with a skippable four-step guide to group, stash, and restore
  tabs; replay it from Settings at any time.
- Group open tabs by domain into native, color-coded Chrome tab groups.
- Use Smart Group with Chrome's local built-in AI by default, or choose an
  optional configured AI provider.
- Fall back cleanly to deterministic domain grouping if AI is unavailable,
  times out, or fails.
- Stash a window, tab group, or domain locally, close only successfully saved
  tabs, and restore the stash later.
- Save and restore complete multi-window sessions, including pinned tabs and
  Chrome group layout, with duplicate-aware restore.
- Find duplicate tabs across windows and close selected duplicates.
- Discard idle tabs to free memory, with per-domain keep-awake controls and
  optional automation.
- Run time-bounded Focus sessions with built-in profiles, distraction blocking,
  a countdown, and local history.
- Search across open tabs, sessions, and stashes, and run supported natural
  language tab commands.
- Export and import portable JSON backups; optionally create Chrome bookmark
  snapshots or sync TabKebab-created files through Google Drive.
- Use actionable empty states that take you directly to the next useful step.

### Privacy at a glance

- Zero TabKebab data collection, telemetry, analytics, ads, or tracking.
- No TabKebab account and no TabKebab backend server.
- Local Chrome AI is on-device and needs no API key.
- OpenAI, Anthropic Claude, and Google Gemini are opt-in and require your own
  API key; custom endpoints are entirely user-configured.
- API keys stored by TabKebab are encrypted with AES-GCM 256-bit and are never
  persisted to disk in plaintext.
- Google Drive sync is opt-in and uses the limited `drive.file` scope.

## Why these permissions

This list mirrors `manifest.json` version 1.2.20 exactly.

### Chrome permissions

- **`tabs`** — Reads metadata for currently open tabs and performs the tab
  actions the user requests: activate, move, group, ungroup, discard, close,
  create, and restore tabs. The extension uses URL, title, favicon URL, pinned
  and active state, window, and group metadata. It does not inject a content
  script or read page content.
- **`tabGroups`** — Queries Chrome's native tab groups and creates, renames,
  recolors, collapses, and restores them.
- **`storage`** — Stores settings, sessions, encrypted AI credentials, AI cache
  entries, first-run state, Drive state, Focus state, and related local data in
  `chrome.storage.local` or `chrome.storage.session`.
- **`sidePanel`** — Registers and opens the side panel that contains
  TabKebab's interface.
- **`identity`** — Gets and clears OAuth tokens only for optional Google Drive
  sync.
- **`alarms`** — Schedules enabled automation and maintenance: session
  auto-save, automatic tab discard and stash checks, Drive sync, Drive
  retention cleanup, bookmark snapshots, and the active Focus timer.
- **`bookmarks`** — Reads the Chrome bookmark tree and creates user-enabled
  TabKebab bookmark snapshot folders and entries.

### Host permissions

- **`https://api.openai.com/*`** — Allows optional OpenAI requests after the
  user supplies an OpenAI API key and invokes or enables an AI-backed action.
- **`https://api.anthropic.com/*`** — Allows optional Anthropic Claude requests
  after the user supplies an Anthropic API key and invokes or enables an
  AI-backed action.
- **`https://generativelanguage.googleapis.com/*`** — Allows optional Google
  Gemini requests after the user supplies a Gemini API key and invokes or
  enables an AI-backed action.

The manifest does not request broad web-page host access.

### OAuth scope

- **`https://www.googleapis.com/auth/drive.file`** — Lets optional Drive sync
  access only files TabKebab created or that the user explicitly opened with
  TabKebab. It does not grant access to every file in the user's Drive.
