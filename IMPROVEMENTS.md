# TabKebab Improvement Plan

Prioritized roadmap for hardening, polish, and new capabilities.

---

## Priority 1 — Error Handling & Reliability

### 1.1 Replace silent catch blocks with logged warnings

**Files:** `service-worker.js`, `core/sessions.js`, `core/stash-db.js`

Dozens of empty `catch {}` blocks silently swallow failures in Drive sync, tab discarding, bookmark creation, and alarm management. At minimum, replace with `catch (e) { console.warn('context:', e); }` so failures are visible in DevTools.

### 1.2 Add retry with exponential backoff to Drive API

**File:** `core/drive-client.js`

`driveRequest()` retries once on 401 but has no handling for rate limits (429), transient failures (500/503), or network timeouts. A single flaky request kills the entire sync operation.

- Add retry loop (max 3 attempts) with exponential backoff
- Handle 429 with `Retry-After` header
- Surface persistent failures to the UI via toast

### 1.3 Validate AI provider responses

**File:** `service-worker.js` (`summarizeTabs`, `classifyTabs`)

AI responses contain array indices that aren't bounds-checked against the input batch. If the model returns `{ index: 999 }` for a 50-tab batch, it silently skips. Validate all indices, array lengths, and expected fields before consuming AI output.

### 1.4 Consistent error patterns across core modules

**Files:** `core/sessions.js`, `core/stash-db.js`

`sessions.js` throws on missing session; `stash-db.js` returns `undefined`. Standardize: all "not found" cases should throw or return null consistently, and callers should handle both.

### 1.5 Improve message handler error reporting

**File:** `service-worker.js`

`err.message` may be undefined for non-Error objects thrown in handlers. Log all errors with context (action name, relevant IDs) before sending the error response.

---

## Priority 2 — Input Validation & Security

### 2.1 Sanitize Drive profile name

**File:** `sidepanel/components/drive-sync.js`

Profile name from `prompt()` has no length limit, special character filtering, or validation. It's used directly in Drive API queries. Add max length (50 chars), restrict to alphanumeric + spaces/hyphens, trim whitespace.

### 2.2 Validate session/stash data on restore

**File:** `core/sessions.js`, `core/stash-db.js`

Tab titles aren't truncated (could be extremely long), favicon URLs aren't validated, and pinned state type isn't checked. Truncate titles to 500 chars, validate favicon URLs against http/https/chrome schemes, coerce pinned to boolean.

### 2.3 Validate group creation inputs

**File:** `service-worker.js` (`createTabGroup` handler)

No validation that `tabIds` are all valid integers, `title` length is reasonable, or `color` is a valid Chrome tab group color.

### 2.4 Audit HTML bookmark generation for XSS

**File:** `service-worker.js` (`generateBookmarkHtml`)

The custom `esc()` function is correct but critical — any missed escape on user-controlled data (tab titles, URLs) is an XSS vector. Add a code comment marking this as security-critical and consider adding single-quote escaping (`'` → `&#39;`).

---

## Priority 3 — Performance

### 3.1 Debounce progress UI updates

**Files:** `sidepanel/components/tab-list.js`, `session-manager.js`, `stash-list.js`

Progress callbacks fire on every tab operation. For hundreds of tabs, this causes unnecessary DOM thrashing. Throttle to max one update per 200ms using `requestAnimationFrame` or a simple timer.

### 3.2 Parallelize domain grouping operations

**File:** `core/engine/executor.js`

Tab moves for different target windows are sequential with 100ms delays between batches. Operations targeting different windows could run concurrently.

### 3.3 Optimize large bookmark HTML generation

**File:** `service-worker.js`

`generateBookmarkHtml` builds the entire page as one string. For 10K+ tabs this creates a multi-MB allocation. Consider streaming with array joins or pagination.

---

## Priority 4 — Code Quality

### 4.1 Remove console.log from production

**File:** `sidepanel/panel.js`

Contains `console.log('[TabKebab] panel.js module loaded')` and similar. Remove or gate behind a `DEBUG` constant.

### 4.2 Clean up unused variables

**File:** `service-worker.js`

The `compressed` variable in `createBookmarks` was previously unused (now fixed). Do a full audit for other read-but-unused values.

### 4.3 Standardize async error handling in IndexedDB

**File:** `core/stash-db.js`

Some IndexedDB operations use `request.onerror` handlers, others don't. Standardize: always attach `onerror` to reject the promise with a descriptive message.

---

## Priority 5 — Features & UX Enhancements

### 5.1 Undo for destructive operations

Add undo capability (with short timeout) for:
- Close all tabs in window
- Delete stash
- Delete session
- Clear duplicates

Implementation: stash the closed tabs temporarily in session storage for 10 seconds, show an "Undo" toast.

### 5.2 Keyboard shortcuts in side panel

Add keyboard navigation:
- `1-4` to switch between main tabs
- `/` to focus search/command bar
- `Escape` to close settings
- `Enter` on selected item to act on it

### 5.3 Export/import settings as file

Add "Export Settings" and "Import Settings" buttons to settings panel. Currently settings sync to Drive but can't be manually exported/imported as a standalone file.

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

## Implementation Order

1. **P1.1** Silent catches → logged warnings (quick, high-value)
2. **P1.2** Drive API retry logic (prevents sync failures)
3. **P2.1** Profile name sanitization (quick fix)
4. **P3.1** Debounce progress updates (quick, visible improvement)
5. **P4.1** Remove console.logs (quick cleanup)
6. **P1.3** AI response validation (prevents silent data loss)
7. **P1.4** Consistent error patterns (enables better error UX)
8. **P5.1** Undo for destructive ops (high user-value)
9. **P5.2** Keyboard shortcuts (accessibility + power users)
10. **P6.1** Unit tests (enables safe refactoring for everything else)
