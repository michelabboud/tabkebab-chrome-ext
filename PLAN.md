# TabKebab — Chrome Extension Plan

A privacy-first Chrome extension for organizing tabs, built with vanilla JS (no frameworks, no build tools).

## Features
1. **Group by domain** — Auto-group tabs by website domain using Chrome's native tab groups
2. **Save/restore sessions** — Save all current tabs as a named session, restore later
3. **Close duplicates** — Scan and close duplicate tabs
4. **Manual grouping** — Drag-and-drop tabs into custom-named groups
5. **Export/Import** — JSON file export/import for portability
6. **Google Drive sync** — Opt-in sync using the `drive.appdata` scope (never touches user files)

## UI
- **Side Panel** using Chrome's Side Panel API
- 5 tabs: Tabs | Sessions | Duplicates | Groups | Settings
- Dark/light mode via `prefers-color-scheme`

## Project Structure

```
TabKebab/
├── manifest.json                    # Manifest V3
├── service-worker.js                # Background event handler
├── sidepanel/
│   ├── panel.html                   # Side panel root
│   ├── panel.css                    # All styles
│   ├── panel.js                     # Entry point, navigation, message bus
│   └── components/
│       ├── tab-list.js              # Tab list with domain grouping
│       ├── session-manager.js       # Save/restore/delete sessions
│       ├── duplicate-finder.js      # Scan & close duplicates
│       ├── group-editor.js          # Manual groups + drag-and-drop
│       ├── drive-sync.js            # Google Drive connect/sync UI
│       ├── window-list.js           # Window management and consolidation
│       ├── ai-settings.js           # AI provider configuration UI
│       ├── command-bar.js           # AI natural language command bar
│       ├── stash-list.js            # Stash view with restore progress
│       ├── settings-manager.js      # Settings UI controller
│       ├── confirm-dialog.js        # Inline confirmation dialogs
│       └── toast.js                 # Notification toasts
├── core/
│   ├── storage.js                   # chrome.storage.local wrapper
│   ├── tabs-api.js                  # chrome.tabs/tabGroups wrapper
│   ├── sessions.js                  # Session CRUD logic
│   ├── duplicates.js                # Duplicate detection
│   ├── grouping.js                  # Domain + manual grouping logic
│   ├── drive-client.js              # Google Drive REST v3 client
│   ├── export-import.js             # JSON file export/import
│   └── stash-db.js                  # IndexedDB stash storage with lazy restore
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

## Implementation Phases

### Phase 1: Scaffold + Basic Tab Display
- Create `manifest.json` (Manifest V3, permissions: `tabs`, `sidePanel`, `storage`, `tabGroups`, `identity`)
- Create `service-worker.js` — opens side panel on icon click, handles messages
- Create `sidepanel/panel.html` + `panel.css` + `panel.js` — full UI shell with navigation
- Create `core/tabs-api.js` + `core/storage.js`
- Create `sidepanel/components/tab-list.js` — flat tab list with favicons, click-to-focus, close button
- Create `sidepanel/components/toast.js`
- Create placeholder icons

### Phase 2: Domain Grouping
- Create `core/grouping.js` — `getAllTabsGroupedByDomain()`, `applyDomainGroupsToChrome()`
- Update `tab-list.js` to render tabs under collapsible domain headers
- Wire "Group by Domain" button to create native Chrome tab groups

### Phase 3: Session Management
- Create `core/sessions.js` — save, restore, list, delete
- Create `sidepanel/components/session-manager.js` — session cards with restore/delete
- Wire service worker message handlers

### Phase 4: Duplicate Detection
- Create `core/duplicates.js` — URL normalization + duplicate grouping
- Create `sidepanel/components/duplicate-finder.js` — scan, display, close duplicates

### Phase 5: Manual Grouping (Drag-and-Drop)
- Create `sidepanel/components/group-editor.js` — HTML5 drag-and-drop between groups
- Add manual group CRUD to `core/grouping.js`
- "Apply to Chrome" button creates native tab groups

### Phase 6: Export/Import
- Create `core/export-import.js` — JSON file download + file input import with merge

### Phase 7: Google Drive Sync
- Create `core/drive-client.js` — OAuth via `chrome.identity`, Drive REST v3, appDataFolder
- Create `sidepanel/components/drive-sync.js` — connect/disconnect/sync UI
- Note: Requires Google Cloud Console project setup (user must provide client ID)

### Phase 8: Stash, Confirm Dialogs & Restore UX
- Create `core/stash-db.js` — IndexedDB-backed stash storage with lazy restore (adaptive batching, per-batch discard, progress callbacks)
- Create `sidepanel/components/stash-list.js` — stash cards with restore progress bar, "Restored" badge, re-restore confirmation
- Create `sidepanel/components/confirm-dialog.js` — inline confirmation dialogs replacing `window.confirm`
- Add confirmation dialogs to destructive actions (close duplicates, delete groups, clean Drive files)
- Add lazy restore + progress reporting to session restore (`core/sessions.js`)
- Service worker broadcasts `restoreProgress` messages for live UI updates

## Key Technical Decisions
- **Manifest V3** with ES modules (`"type": "module"` on service worker)
- **No build step** — vanilla JS, no bundler, no framework
- **Message passing** — side panel communicates with service worker via `chrome.runtime.sendMessage`
- **Manual groups store URLs, not tab IDs** — tab IDs are ephemeral across Chrome restarts
- **Google Drive scope: `drive.appdata`** — only accesses hidden app-specific folder
- **Manual sync only (v1)** — user clicks "Sync Now", no automatic background syncing

## Verification
1. Load unpacked extension at `chrome://extensions` (enable Developer Mode)
2. Click the extension icon — side panel should open
3. Test each feature tab by tab:
   - Tabs: see all open tabs, click to focus, close individual tabs, "Group by Domain"
   - Sessions: save a session, close tabs, restore session
   - Duplicates: open same URL 3x, scan, close duplicates
   - Groups: create a group, drag tabs into it, "Apply to Chrome"
   - Settings: export JSON, import JSON, (Google Drive requires Cloud Console setup)
