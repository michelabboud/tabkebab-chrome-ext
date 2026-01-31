# TabKebab Improvement Plan

Prioritized roadmap for hardening, polish, and new capabilities.

---

## Priority 1 — Error Handling & Reliability

### ~~1.1 Replace silent catch blocks with logged warnings~~ ✅

**Files:** `service-worker.js`, `core/sessions.js`, `core/stash-db.js`

Replaced 18+ empty `catch {}` blocks with `catch (e) { console.warn('[TabKebab] context:', e); }` so failures are visible in DevTools.

### ~~1.2 Add retry with exponential backoff to Drive API~~ ✅

**File:** `core/drive-client.js`

Added retry loop (max 3 attempts) with exponential backoff and `Retry-After` header support for 429/500/502/503 responses.

### ~~1.3 Validate AI provider responses~~ ✅

**File:** `service-worker.js` (`summarizeTabs`, `classifyTabs`, `solver-ai.js`)

Added bounds-checking on array indices, `Array.isArray` checks, and type validation for all AI response fields.

### ~~1.4 Consistent error patterns across core modules~~ ✅

**Files:** `service-worker.js`

Added context-aware error logging with action names and safe `err?.message || String(err)` formatting in the message handler.

### ~~1.5 Improve message handler error reporting~~ ✅

**File:** `service-worker.js`

Included with P1.4 — all handler errors now log with context before sending the error response.

---

## Priority 2 — Input Validation & Security

### ~~2.1 Sanitize Drive profile name~~ ✅

**File:** `sidepanel/components/drive-sync.js`

Added max length (50 chars), restricted to alphanumeric + spaces/hyphens, trim whitespace, with secondary validation.

### ~~2.2 Validate session/stash data on restore~~ ✅

**Files:** `core/sessions.js`, `core/stash-db.js`

Added `sanitizeTab()` function: truncates titles to 500 chars, validates favicon URLs (http/https/chrome/data), coerces pinned to boolean.

### ~~2.3 Validate group creation inputs~~ ✅

**File:** `service-worker.js` (`createTabGroup` handler)

Validates `tabIds` as non-empty integer array, `color` against valid Chrome group colors, and truncates `title` to 200 chars.

### ~~2.4 Audit HTML bookmark generation for XSS~~ ✅

**File:** `service-worker.js` (`generateBookmarkHtml`)

Added single-quote escaping (`'` → `&#39;`) to `esc()` and marked it as security-critical with a comment.

---

## Priority 3 — Performance

### ~~3.1 Debounce progress UI updates~~ ✅

**Files:** `sidepanel/components/tab-list.js`, `session-manager.js`, `stash-list.js`

Throttled progress callbacks using `requestAnimationFrame` to batch DOM updates.

### 3.2 Parallelize domain grouping operations

**File:** `core/engine/executor.js`

Tab moves for different target windows are sequential with 100ms delays between batches. Operations targeting different windows could run concurrently.

### 3.3 Optimize large bookmark HTML generation

**File:** `service-worker.js`

`generateBookmarkHtml` builds the entire page as one string. For 10K+ tabs this creates a multi-MB allocation. Consider streaming with array joins or pagination.

---

## Priority 4 — Code Quality

### ~~4.1 Remove console.log from production~~ ✅

**File:** `sidepanel/panel.js`

Removed development `console.log` statements.

### ~~4.2 Clean up unused variables~~ ✅

**File:** `service-worker.js`

Removed 3 unused drive-client imports (`listDriveExports`, `deleteDriveExport`, `listSubfolderFiles`).

### ~~4.3 Standardize async error handling in IndexedDB~~ ✅

**File:** `core/stash-db.js`

Audited — all operations already had proper transaction-level `onerror` handlers. Request errors correctly bubble up.

---

## Priority 5 — Features & UX Enhancements

### ~~5.1 Undo for destructive operations~~ ✅

Added 8-second undo toast for:
- Delete session → re-inserts the session
- Delete stash → re-inserts the stash
- Close duplicates → reopens the closed tab URLs

Toast now supports an optional action button `{ label, callback }`.

### ~~5.2 Keyboard shortcuts in side panel~~ ✅

Added keyboard navigation + visible help button:
- `1-4` to switch between main views
- `/` to focus AI command bar
- `Escape` to close settings/help/unfocus inputs
- `?` to toggle comprehensive help overlay

Help overlay includes: view descriptions, feature explanations, shortcut reference, tips, and links to docs.

### ~~5.3 Export/import settings as file~~ ✅

Added "Export Settings" and "Import Settings" buttons to the General settings card. Exports as standalone JSON file.

### 5.4 Bulk operations toolbar

When multiple tabs are selected, show a floating toolbar with bulk actions: close, stash, group, move to window.

### 5.5 Session diff view

Before restoring a session, show what's changed: new tabs, removed tabs, moved tabs. Let users cherry-pick which parts to restore.

### 5.6 Tab search across all views

Add a global search bar that finds tabs across open tabs, stashes, and sessions — not just the current view.

---

## Priority 6 — Testing

### 6.1 Add unit tests for core modules

Critical untested paths:
- 4-phase grouping pipeline (snapshot → solver → planner → executor)
- Session v1 → v2 migration logic
- AI provider response parsing
- IndexedDB transaction handling
- Drive sync conflict resolution

### 6.2 Add integration tests for message handler

Test the full `handleMessage` flow for each action type, including error cases.

---

## Implementation Progress

| # | Item | Status |
|---|------|--------|
| 1 | P1.1 Silent catches → logged warnings | ✅ Done |
| 2 | P1.2 Drive API retry logic | ✅ Done |
| 3 | P2.1 Profile name sanitization | ✅ Done |
| 4 | P3.1 Debounce progress updates | ✅ Done |
| 5 | P4.1 Remove console.logs | ✅ Done |
| 6 | P1.3 AI response validation | ✅ Done |
| 7 | P1.4 Consistent error patterns | ✅ Done |
| 8 | P5.1 Undo for destructive ops | ✅ Done |
| 9 | P5.2 Keyboard shortcuts + help | ✅ Done |
| 10 | P2.2 Validate restore data | ✅ Done |
| 11 | P2.3 Validate group creation | ✅ Done |
| 12 | P2.4 XSS escape hardening | ✅ Done |
| 13 | P4.2 Remove unused imports | ✅ Done |
| 14 | P4.3 IndexedDB error audit | ✅ Done |
| 15 | P5.3 Export/import settings | ✅ Done |
| 16 | P3.2 Parallelize grouping ops | Planned |
| 17 | P3.3 Optimize bookmark HTML | Planned |
| 18 | P5.4 Bulk operations toolbar | Planned |
| 19 | P5.5 Session diff view | Planned |
| 20 | P5.6 Tab search across views | Planned |
| 21 | P6.1 Unit tests | Planned |
| 22 | P6.2 Integration tests | Planned |
