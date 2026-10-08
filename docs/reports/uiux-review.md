# TabKebab side panel: UI/UX review

- **Date:** 2026-10-08
- **Build reviewed:** v1.3.0 (working tree on `dev`), unpacked in headless Chromium 141 (Playwright 1.56.1)
- **Method:** The extension was loaded through `launchPersistentContext`, and `sidepanel/panel.html` was opened at 360×800 and 480×900. The test browser had 3 windows and 25 tabs across 15 domains, 3 Chrome groups (one collapsed), one pinned tab, duplicates and blank pages. A 60-tab stress set was added at the end. Screens were captured in light, dark (`prefers-color-scheme`) and the in-app forced-dark theme. A DOM script checked overflow, hit-target size and missing labels. WCAG ratios were computed from the `panel.css` tokens.
- **Screenshots:** [`uiux-review-shots/`](uiux-review-shots/) — the 33 screenshots cited below, named `<width>-<theme>-<nn>-<state>.png` (73 were captured in total with a Playwright harness against the unpacked extension).
- **Harness artefacts:** Some screenshots show mojibake (`Â·`, `â€"`) and YouTube titles of "/watch". The local test server caused these. They are not product bugs. The domain group labelled `cgfnjdc…` is the panel's own tab, which only exists because the panel ran as a tab during testing.

## Executive summary

TabKebab's visual language is coherent: tokenised colours, pill navigation, cards and good empty states. The confirm dialog is well built, with a focus trap, Escape and focus return. The main problems are about fitting the panel's width and being robust:

1. **The busiest view does not fit a side panel.** On Tabs → Domains, each row's actions overflow sideways. Rows are 551px wide inside a 356px panel at 360 wide, and still overflow at 480. The per-domain **Close** button is reachable only by scrolling sideways.
2. **Chrome group names are invisible** in Groups at 360px, because the action buttons squeeze the name to 0px.
3. **Several bugs come from layout and tokens:**
   - The header gets permanently clipped after "Replay guide".
   - White-on-amber, white-on-green and white-on-red pairs fail AA in both themes.
   - The Focus HUD uses dark-theme cyan in light mode (1.75:1).
   - There is no visible keyboard focus ring on buttons (1.01:1 in dark).
4. **Navigation chrome takes about 27% of the height** before any content: header, nav, stats cards and hint (about 215 of 800px). The three-card stats bar also shows on Settings and Focus, where it is irrelevant.
5. **Too many controls at once.** The Domains toolbar has 6 buttons over 3 rows, with two competing primary buttons. A Smart Group note contradicts the fallback banner shown right below it. Drive and AI status icons are red when you simply have not opted in.

Most fixes are small CSS or token changes. The two medium items are the row-action redesign and the toolbar consolidation.

---

## Top 10 (ranked by impact ÷ effort)

### 1. Domain rows overflow sideways; per-domain Close is off-screen (Effort: M)

**Evidence:**
- `360-light-02b-tabs-domains-tall.png`, `480-light-02-tabs-domains.png` and `360-light-23b-domains-many-tabs.png`.
- The audit measured `.view-container` scrollWidth at 551px against a client width of 356px at 360 wide, and 551 against 476 at 480 wide. Button right edges reach 482px.
- A horizontal scrollbar is visible at the bottom of the view.
- The pill columns are ragged: the `count` / `W1, W3` / ☾ / Stash / Kebab / Close cluster starts at a different x on each row because `.domain-name { flex: 1 }` (`panel.css:640`) has no `min-width: 0` or ellipsis.
- The window label wraps to two lines ("W1,\nW3").

**Change:**
- Use a two-zone row: the name truncates, and the actions are right-aligned and fixed:
  ```css
  .domain-group-header .domain-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .domain-group-header .window-label { white-space: nowrap; }
  ```
- Collapse Stash, Kebab, Close and keep-awake into **one ⋯ overflow button** (28×28) that opens a small menu. Alternatively, show them only on `:hover` / `:focus-within` of the row, as an absolutely positioned action strip over the right side with a `--bg-hover` background.
- Keep the count pill always visible. Show the window label only when the domain spans more than one window.
- Add `overflow-x: hidden` on `.view-container` as a guard after the fix.
- Code locations: `tab-list.js:231-360` and `panel.css:605-680, 2144-2420`.

### 2. Chrome group titles are not rendered in Groups at 360px (Effort: S)

**Evidence:**
- `360-light-03-tabs-groups.png` and `360-light-03b-tabs-groups-tall.png`. Group headers show only a colour dot and "2 tabs". The titles "Review", "Watch later" and "Shopping" are missing.
- The action strip (Stash · Kebab · ☾ · Collapse · Ungroup) overflows to x=476.
- Cause: `.chrome-group-actions { flex-shrink: 0 }` (`panel.css:1013-1018`) together with `.group-name { flex: 1; min-width: 0 }` (`panel.css:997`). The name is the only part that can shrink, so it shrinks to 0.

**Change:**
- Give the name a floor: `.chrome-group-header .group-name { flex: 1 1 80px; }`.
- Let the actions wrap under the title: `.chrome-group-header { flex-wrap: wrap; } .chrome-group-actions { flex-basis: 100%; justify-content: flex-end; }` at `@media (max-width: 420px)`.
- Better: use the same ⋯ overflow pattern as #1. Replace the text "Collapse"/"Expand" with the chevron the row already has (the ▼ at the left duplicates it).

### 3. Header gets permanently clipped after "Replay guide", anchor links and status icons (Effort: S)

**Evidence:**
- `360-light-24-after-replay-guide.png`. Also visible in every capture taken after the replay in the main run, for example `360-dark-02-tabs-domains.png` and `360-light-20-sessions-list.png`, where the logo and "TabKebab" are cut off at the top.
- The probe measured `document.documentElement.scrollTop = 32` after clicking `#btn-relaunch-walkthrough`.
- `body` is `height: 100vh; overflow: hidden` (`panel.css:130-142`), but `html` can still scroll. `scrollIntoView` (`panel.js:156`, `panel.js:103`, `panel.js:497`) and the `href="#settings-ai-section"` anchor (`panel.html:225`) scroll the root. The user has no way to scroll it back.

**Change:**
- `html { height: 100%; overflow: hidden; } body { height: 100%; }`.
- Call `scrollIntoView({ block: 'nearest' })` on elements inside `.view-container`, or set `.view-container.scrollTop` directly.
- Make the Smart Group link a button that calls `navigatePanel({view:'settings', sectionId:'settings-ai-section'})` instead of a fragment link.

### 4. Colour-on-colour contrast fails AA; the Focus HUD ignores the theme (Effort: S)

**Evidence:** See the contrast table below.
- White on `--kebab` (Kebab All): 2.15:1.
- White on `--success` (every success toast): 2.54:1 in light, 1.92:1 in dark.
- White on `--danger`: 3.76:1 in light, 2.77:1 in dark.
- `--kebab` text on `--kebab-soft` (Kebab chip): 1.99:1.
- KEEP badge: 2.35:1.
- Focus HUD timer and label: `#22d3ee` on near-white is **1.75:1** (`360-light-21-focus-hud.png`). `_getProfileColor()` hard-codes dark-palette hex values (`focus-panel.js:554-561`), so the light tokens `--focus-cyan: #0891b2` etc. (`panel.css:3084`) are never used.

**Change** (light tokens unless noted):
- `--kebab: #b45309` (white text 5.02:1, and it is still amber), with `--kebab-hover: #92400e`.
- `--success: #047857` (5.48:1).
- `--danger: #dc2626` (4.83:1), with `--danger-hover: #b91c1c`.
- Dark theme: keep the light tints for text-on-dark, but switch filled buttons and toasts to dark text: `.toast.success, .action-btn.danger, .action-btn.kebab { color: #111827 }` under the dark selectors. This gives 9.23:1, 6.41:1 and 6.33:1.
- In `focus-panel.js`, return `var(--focus-${colorName})` instead of hex, so the light and dark tokens apply.

### 5. No visible keyboard focus on buttons, tabs or chips (Effort: S)

**Evidence:**
- `360-light-22b-keyboard-focus-nav.png` and `360-light-22c-keyboard-focus-after-transition.png`.
- The computed focus style is the user-agent default, `auto 1px rgb(16,16,16)`. That is invisible on the blue primary buttons, and 1.01:1 against the dark background.
- `.action-btn { transition: all }` (`panel.css:463`) also animates the outline in from 0.
- Only `.domain-group-header`, `.tab-item` and the confirm-dialog buttons get a real ring (`panel.css:3871-3880`).
- `.input:focus { outline: none }` (`panel.css:530`) relies on a border colour change only.

**Change:**
```css
:where(button, a, select, input, textarea, [role="tab"], [tabindex]):focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
.action-btn:not(.secondary):focus-visible { outline-color: var(--text-primary); }
.action-btn { transition: background-color var(--transition), border-color var(--transition), box-shadow var(--transition), transform var(--transition); }
```

### 6. About 215px of fixed chrome; the stats bar shows everywhere (Effort: M)

**Evidence:**
- `360-light-02-tabs-domains.png`: header 60px, nav 50px, three stat cards plus a hint line 105px. Content starts at about y=215.
- The same block repeats on Settings, Focus and Stash (`360-light-09-settings.png`, `360-light-08-focus-setup.png`), where it carries no information.
- "100% ACTIVE / KEBAB" is jargon that needs a hint line (`panel.html:90-104`).

**Change:**
- Replace the cards with one 28px inline strip under the nav: `3 windows · 27 tabs · 0 sleeping`. Use `--text-secondary` at 12px, and put the explanation in a `title` or tooltip on "sleeping".
- Hide the strip on Settings and Focus (`#global-stats-bar` hidden when `view-settings` or `view-focus` is visible).
- This recovers about 80px, which is roughly 3 more domain rows.

### 7. Domains toolbar: 6 buttons, 3 rows, 2 equal primaries (Effort: M)

**Evidence:**
- `360-light-02-tabs-domains.png`: Group by Domain (blue), Smart Group (blue), Ungroup All, Kebab All (orange), Collapse All, Expand All. That is 4 colours of emphasis.
- Groups has a second Kebab All / Collapse All / Expand All row (`360-light-03-tabs-groups.png`). Windows has a third (`360-light-05-windows.png`).

**Change:**
- Use one row: `[Group ▾]` as a split button (default "By domain", menu with "Smart (AI)" and "Ungroup all"), then `[Sleep all]` as a secondary button with an amber icon, then a single icon toggle for collapse/expand all (⇕, 28×28, `aria-pressed`).
- Reuse the same component in Groups and Windows.
- Only one filled primary per view.

### 8. Smart Group messaging contradicts itself (Effort: S)

**Evidence:**
- `360-light-16-smart-group-no-ai.png`. The static note (`panel.html:207-210`) says "Smart Group uses Chrome's built-in AI by default. No key or account is needed…". Directly below, the fallback says "Chrome's built-in AI isn't available here yet…".
- The note is shown on every visit, even before the user has tried the feature (`360-light-02-tabs-domains.png`).

**Change:**
- Probe availability on load (the `chrome-ai-broker` already exists) and remove the always-on note.
- Show a one-line hint only when the probe succeeds. Use a `title` on the button: "Groups tabs by topic using on-device AI. Nothing leaves this computer."
- When the probe fails, disable nothing. On click, show the existing fallback with the copy: "On-device AI isn't ready in this Chrome. **Group by domain** now, or **add an API key** for topic grouping."

### 9. Drive and AI status icons are alarm-red when the user simply hasn't opted in (Effort: S)

**Evidence:**
- Every screenshot shows a red cloud and a red star in the header.
- `.status-icon.disconnected { color: var(--danger) }` (`panel.css:3743`), plus a red `::after` dot (`panel.css:3762`).
- Both features are opt-in per CLAUDE.md and the privacy positioning, so red reads as "something is broken" on first run.
- The ★ glyph for AI is also ambiguous (it reads as "favourite").

**Change:**
- Not configured: `color: var(--text-tertiary)` with no dot.
- Configured and OK: `--text-secondary` with a green dot.
- Configured and failing (token expired, decrypt locked): `--danger` dot.
- Swap ★ for a sparkle or chip icon.
- Tooltip copy: "AI: off — click to set up" instead of "AI: Not configured".

### 10. Toasts are silent to screen readers, short-lived and the main undo is missing (Effort: S)

**Evidence:**
- `#toast-container` has no live region (`panel.html:846`, `toast.js:11-41`). Toasts last a fixed 3000ms, including toasts that carry an action button.
- Stash-by-domain only says "Stashed 2 tabs from www.reddit.com" (`360-light-17-toast-after-stash.png`, `tab-list.js:310`) with no Undo, although stash deletion has one (`stash-list.js:350`).
- Validation is done with an error toast: "Enter a session name" (`session-manager.js:382`, `360-light-20a-session-save-empty-name.png`).

**Change:**
- `<div id="toast-container" role="status" aria-live="polite">`. Use `role="alert"` on `.toast.error`.
- Duration: `action ? 8000 : type === 'error' ? 6000 : 3500`. Pause the timer on hover or focus.
- Add `{ label: 'Undo', callback: () => restoreStash(id) }` to the domain, window and group stash toasts.
- Sessions: default the name to `Session — Oct 8, 9:18 PM` when the field is empty, instead of showing an error.

---

## Full findings by category

### Information architecture and navigation

- **Hidden 5th and 6th views.** Focus and Settings are full views, but they open from header icons. When either is open, no nav pill is selected (`360-light-08-focus-setup.png`, `360-light-09-settings.png`), so the user loses their bearings. Add a back affordance ("← Tabs") in the view heading, or give Settings and Focus a visible title bar with a close ×. Escape already closes Settings (`panel.js:571`). Make Escape close Focus setup too.
- **Duplicates and Groups sit under Tabs, while Windows is top level.** The guide's mental model (`GUIDE.md:90-140`) describes "All | Domains | Groups" with Kebab, Stash and Group dropdowns, none of which exist. Either update `GUIDE.md` §Tabs View, §Toolbar and §Navigation Bar ("accent underline" is now a filled pill), or align the UI. GUIDE.md is published on tabkebab.com, so this drift is user-facing.
- **Nav order.** The order is Windows · Tabs · Stash · Sessions, but Tabs is the default and the main view. Put Tabs first and remap the shortcuts to 1 = Tabs, 2 = Windows, or keep the keys and move only the visual order.
- **The tabs do not follow the ARIA tab pattern.** They have `role="tab"`, but there are no `aria-controls` or `role="tabpanel"`, no arrow-key roving, and every tab is a Tab stop (`panel.html:83-88, 191-195`). Add a roving `tabindex` with ArrowLeft/ArrowRight in `panel.js:110` and `panel.js:213`.
- **The empty domain label.** `about:blank` and other non-http tabs are grouped under a domain with an empty name, so the row shows only "2" (`360-light-02b-tabs-domains-tall.png`, second row). Label it "Blank & browser pages" (`tab-list.js:255`).
- **The 480px header crowds.** GitHub and Privacy links plus the version pill sit in the header (`480-light-02-tabs-domains.png`). They already exist in Settings → About. Remove `.header-meta` from the header (`panel.html:73-80`).

### Visual hierarchy, density and consistency

- **Unstyled "Bring to Front" button.** `.window-focus-btn` (`panel.css:2134`) has no background, border or radius, so it renders as a native grey button. In dark mode it shows as a white slab (`360-dark-05-windows.png`). Add `class="action-btn secondary"` in `window-list.js:404`.
- **"Window 1" wraps to two lines** when the ACTIVE badge is present (`360-light-05-windows.png`). Use `white-space: nowrap` on the window title. Move "ACTIVE" to a 6px dot or a left border.
- **Stash and session cards** (`360-light-19-stash-list.png`, `360-light-20-sessions-list.png`):
  - **Delete** is the only filled, high-chroma button on the card, so the destructive action is visually primary.
  - **Restore** is not emphasised.
  - The download icon is a 24px outlined blue square that matches nothing else.

  Make Restore primary and Restore here secondary. Make Delete a ghost button (`color: var(--danger); background: transparent`) or move it into a ⋯ menu. Give the download icon `aria-label="Export"` and the secondary style.
- **Redundant stash title.** "www.amazon.com (2 tabs)", followed by "2 tabs · Oct 8…", repeats the count. Drop "(2 tabs)" from the name.
- **Duplicate group headers show raw percent-encoded URLs** (`360-light-04-duplicates-scanned.png`), for example `http://stackoverflow.com:8123/questions/1?t=javascript%20-%20How…`. Show `decodeURI(hostname + pathname)` truncated to 1 line, with the full URL in `title`.
- **Font-size sprawl.** `panel.css` uses 15 font sizes: 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 16, 18, 20 and 48px. Define `--fs-xs: 11px; --fs-sm: 12px; --fs-md: 13px; --fs-lg: 15px; --fs-xl: 18px` and map 9–10.5 → 11, 11.5 → 12, 12.5 → 13. The 9px and 10px text (stats labels, window label, dupe badge, stats hint) is below comfortable reading size.
- **Inline styles fight the token system.** `style="margin-top: 12px"` and `style="flex:0"` appear about 20 times (`panel.html:148, 180, 307, 311, 365, 369, 631…`). Add utilities such as `.mt-3` and `.flex-none`.
- **Focus profile icons are text glyphs.** Research is "?" and Meeting is ">>" (`360-light-08-focus-setup.png`), and "?" reads like a help or placeholder icon. Use small inline SVGs: magnifier for Research, people for Meeting.
- **Block-category chips.** Active chips are solid red (`360-light-08b-focus-setup-tall.png`), which reads as an error or destructive state. Use `--accent-soft` with a ✓ for active.

### Dark mode

- **Most tertiary text fails.** `--text-tertiary #6b7280` on `--bg-card #1a1a1d` is 3.59:1, and it is used for setting hints, empty states and chevrons. Use `#8b8f98` (5.36:1).
- **White on `--accent #3b82f6`** is 3.68:1, which passes only for large or bold text. Nav pills and buttons are 12–12.5px semibold. Use `#2563eb` as the filled-button background in dark mode (5.17:1) and keep `#3b82f6`/`#60a5fa` for text and links.
- **Borders.** `--border #2a2a2e` against cards is 1.21:1, so cards and inputs nearly vanish (`360-dark-09-settings.png`). Use `--border: #34343a` and `--border-strong: #52525b` (2.25:1). Input borders should use `--border-strong`.
- **Forced dark.** The `[data-theme="dark"]` block duplicates the media block. Consider generating both from one source, for example a `:root[data-theme="dark"], :root:not([data-theme="light"])` selector inside the media query plus a standalone rule, so they cannot drift. The focus tokens already show this risk (`panel.css:3090-3104`).

### Accessibility

- **Hit targets under 24px.** The audit flagged 68 elements on Domains at 360px:
  - Row chips `.stash-btn`, `.kebab-btn` and `.close-btn` are 48×20, 56×20 and 46×18.
  - `.keep-awake-btn` is 27×20.
  - The tab × is 17×16.
  - The focus tag remove × is 12×14 and the keep-awake list × is 16×14.
  - `.help-close` is 20×20.
  - Native checkboxes and radios are 13×13 (Focus setup, Duplicates).

  Set `min-height: 24px` on all of these (`panel.css:2144, 2163, 2375, 2399`). Pad the × buttons to 24×24 with a negative margin so the layout does not move. Use `accent-color: var(--accent); width: 16px; height: 16px` on checkboxes and radios, and make the whole `<label>` the target.
- **Missing accessible names** (audit):
  - Inputs and selects: `#session-name`, `#new-group-name`, `#new-group-color`, `.search-input`, `#keep-awake-domain-input`, `#focus-duration`, `#focus-add-type`, `#focus-add-value`, `#focus-add-blocked`.
  - Every `.setting-number` and `.setting-select` in Settings: the visible label is a sibling `<span>`, not a `<label for>`.
  - Icon buttons: `+` (`#btn-add-allowlist`, `#btn-add-blocked`), every `×` remove button, `ℹ` summarize and `☾/☀` keep-awake (these have `title` only).

  Use `<label for>` or `aria-label` for the fields. For the icon buttons, add an `aria-label` such as "Remove github.com" or "Keep github.com awake", plus `aria-pressed` on keep-awake.
- **Clickable divs.** `.find-result-item` (`command-bar.js:118`) and `.tab-item` rows are clickable divs. Ensure each has `tabindex="0"`, `role="button"` and Enter/Space handling, as `keyboard-activate.js` does elsewhere.
- **No `prefers-reduced-motion` handling anywhere in `panel.css`.** There are 13 keyframe animations. Among them, `body.focus-blink` flashes the whole panel red three times (`panel.css:3725-3732`), and `focus-hud-glow` and `focus-heartbeat` loop forever. Add:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
  }
  ```
  Also pass `behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'` to the `scrollIntoView` calls.
- **The help overlay** is a plain `div`, not a dialog, and has no focus trap (`panel.js:600`). Reuse the confirm-dialog pattern: `role="dialog"`, `aria-modal`, focus the close button and restore focus on close.

### Feedback, errors and destructive-action safety

- **Focus HUD has two "end" buttons** ("End Early" in the header and "End Session" at the bottom, `focus-panel.js:577, 606`). Both end the session immediately with no confirmation (`360-light-21c-focus-ended-immediately.png`; it shows the report, not a dialog). Keep one button, "End session", and use `showConfirm({title:'End focus early?', message:'You have 49:58 left. Your stats so far will be saved.', confirmLabel:'End session', danger:true})` when more than 1 minute remains.
- **Focus progress at 0%** renders an empty track and a stray "0%" on its own line (`360-light-21-focus-hud.png`). Put the percentage inline with the timer subline ("49:58 remaining · 0%") and give the empty track a visible `--bg-tertiary` fill.
- **Raw platform errors reach users:**
  - "Failed to connect: The user turned off browser signin" (`360-light-15b-settings-drive-connect-attempt.png`, `drive-sync.js:93`). Map known `chrome.identity` errors to "Sign in to Chrome first (Chrome menu → Turn on sync / Sign in), then try Connect again."
  - The generic toast pattern `'X failed: ' + err.message` appears in about 40 places. Route these through one `friendlyError(err)` helper.
- **Domain-row Close** is an outlined red chip next to Kebab, separated by 4px. A mis-click is easy, although the confirm dialog (`360-light-18-confirm-close-domain.png`) mitigates it. With #1, Close moves into the overflow menu.
- **The Close-All-Duplicates count** in the button ("Close All Duplicates (3)") does not match the nav badge ("5", which also counts blank pages, `panel.js:278`). Either badge duplicates only, or label it "5 to clean up".
- **Disabled "Sync Now"** when Drive is not connected has no explanation (`360-light-09-settings.png`). Hide it until connected, as Disconnect already is.

### Onboarding and empty states

- **The walkthrough wraps at 360px.** On step 2, "Next" drops to its own row under Open Tabs, Skip tour and Back (`360-light-01b-walkthrough-step2.png`). Put "Skip tour" as a text link in the header row (next to "2 OF 4") and keep Back and Next on the right.
- **The walkthrough's step actions are no-ops.** "Open Tabs" is shown while you are already on Tabs, and "Find tabs to stash" only navigates. Make step actions highlight the target control: add `.highlight-section`, which already exists (`panel.js:497`), to `#btn-group-by-domain` on step 2 and to the first `.stash-btn` on step 3.
- **Walkthrough copy** (`first-run-walkthrough.js:7-30`) reads stiffly:
  - "Stash what you do not need now" → "Stash tabs for later".
  - "Use Stash on a domain, group, or window to save those tabs and close them safely." → "Hit **Stash** on any domain, group or window. The tabs close, but nothing is lost."
  - "Use one simple loop to clear tab clutter without losing your place." → "Group, stash, restore: three steps to a calmer tab bar."
- **The empty states for Stash and Sessions are good** (`360-light-06-stash.png`, `360-light-07-sessions.png`). However, Export/Import sit directly under the empty message as equal-weight buttons. Move them into a ⋯ menu in the view header, since they are rare actions.
- **The Custom Groups empty state** "No custom groups. Create one above." could teach drag and drop instead: "Name a group, then drag tabs into it."

### Settings complexity

Settings has 8 cards and about 30 controls on one scroll (`360-light-09b-settings-tall.png`). The opt-in Google Drive card is first, while AI, the most-asked-about feature in the store listing, is seventh and hidden behind an "Enable AI Features" checkbox.

- **Reorder by frequency:** General (theme, default view, replay guide) → Tab Sleep (keep-awake) → AI → Automation → Tab Limits → Bookmarks → Google Drive → About.
- **Add a sticky in-page index** at the top: General · Sleep · AI · Automation · Bookmarks · Drive, as chips that scroll to each section.
- **Collapse advanced cards by default** using `<details>`: Bookmarks formats, Drive retention and Tab Limits.
- **AI:** replace the "Enable AI Features" checkbox with the provider select itself, where "Off" is the first option. Picking a provider expands the config. This removes a step and a state ("enabled but no provider").
- **Tab Sleep list** (`360-light-09b-settings-tall.png`) is a fixed-height scroller of about 40 defaults, with 16×14 × buttons. Show a count ("37 domains") with "Show all" and a filter box.
- **Bulk-action buttons** "Export Settings" / "Import Settings" inside General should move to an "Backup & restore" card next to About.

### Command bar

- With no AI configured, the command bar is removed entirely (`panel.js:384`). The `/` shortcut then silently does nothing (`panel.js:557`), while Help still advertises "/ Focus AI command bar" (`360-light-10-help-overlay.png`). Either make `/` fall back to opening search (Ctrl+K), or show a one-line collapsed bar ("Ask TabKebab… (set up AI)") that links to the AI settings.
- When it is configured:
  - The `<textarea rows=2>` with a "Go" button takes about 70px of permanent height. Use a single-line input that grows on focus.
  - The empty provider label should read "via OpenAI".
  - "Thinking..." should use the existing `.pipeline-progress` indeterminate bar.
  - Command confirmation uses a non-danger "Confirm" button even for close actions (`command-bar.js:200`). Use `danger` when the parsed action is close or stash.

### Focus mode

- **Setup is long** (about 1150px tall at 360, `360-light-08b-focus-setup-tall.png`). Put the profile chips, duration and **Start Focus** at the top, and fold "When focus starts", "Blocking", "Allowed" and "Blocked" into a "Customize" `<details>` that remembers its open state. The Start button is currently below the fold.
- **The AI Detection toggle** shows a hint but stays enabled when no AI is configured. Disable it with "Set up AI to use this", or hide it.
- **The tabs list is unaware of Focus.** While focus is active, the header target icon is the only cue (`360-light-21b-tabs-while-focus-active.png`). Add a 28px banner across views: "Focus · Coding · 49:58 left · End". The HUD already exists, so reuse its timer.
- **"Distractions blocked 0 / Focus tabs 6"** use 11px `--text-tertiary` labels (2.54:1 in light). Raise them to `--text-secondary`.

### Overflow and truncation

- **Tab titles** truncate correctly with ellipsis in Groups and Windows (`360-light-03b-tabs-groups-tall.png`), but rows have no `title` tooltip with the full title. Set `title.title = tab.title + '\n' + tab.url` in `tab-list.js:461` and `group-editor.js:283, 443`.
- **The 60-tab stress test** (`360-light-23-windows-many-tabs.png`) stays responsive, and the red "72 tabs" danger pill works. The Domains view at 83 tabs (`360-light-23b-domains-many-tabs.png`) inherits issue #1.
- **No sideways scrolling outside Domains.** Every other view measured `scrollWidth == clientWidth` at 360px.

---

## Contrast table (WCAG 2.x, from `panel.css` tokens)

AA requires 4.5:1 for normal text, 3:1 for large or bold text of 14px and up, and 3:1 for non-text UI.

| Theme | Pair | Foreground | Background | Ratio | Result |
|---|---|---|---|---|---|
| Light | text-primary on bg-primary | `#111827` | `#ffffff` | 17.74 | Pass |
| Light | text-secondary on bg-primary | `#6b7280` | `#ffffff` | 4.83 | Pass |
| Light | text-secondary on bg-secondary (cards) | `#6b7280` | `#f8f9fa` | 4.59 | Pass (barely) |
| Light | text-tertiary (stats hint, empty states, chevrons, stat labels) | `#9ca3af` | `#ffffff` | **2.54** | Fail |
| Light | accent text / links | `#2563eb` | `#ffffff` | 5.17 | Pass |
| Light | white on accent (primary buttons, active nav) | `#ffffff` | `#2563eb` | 5.17 | Pass |
| Light | white on danger (Delete, Close All, error toast) | `#ffffff` | `#ef4444` | **3.76** | Fail (12px) |
| Light | white on kebab (Kebab All) | `#ffffff` | `#f59e0b` | **2.15** | Fail |
| Light | white on success (success toast) | `#ffffff` | `#10b981` | **2.54** | Fail |
| Light | kebab text on kebab-soft (Kebab chip) | `#f59e0b` | `#f59e0b` @10% on white | **1.99** | Fail |
| Light | danger text on white (Close chip) | `#ef4444` | `#ffffff` | **3.76** | Fail (11px) |
| Light | accent on accent-soft (Stash chip, count pill) | `#2563eb` | `#2563eb` @8% on white | 4.65 | Pass |
| Light | success on success-soft (KEEP badge) | `#10b981` | `#10b981` @8% on white | **2.35** | Fail |
| Light | Focus HUD timer and label (hard-coded) | `#22d3ee` | `#f5fdff` | **1.75** | Fail |
| Light | border vs bg (cards, inputs; non-text) | `#e5e7eb` | `#ffffff` | 1.24 | Below 3:1 (input borders) |
| Light | toggle-off / border-strong vs white (non-text) | `#d1d5db` | `#ffffff` | 1.47 | Below 3:1 |
| Dark | text-primary on bg-primary | `#f3f4f6` | `#0f0f10` | 17.41 | Pass |
| Dark | text-secondary on bg-card | `#9ca3af` | `#1a1a1d` | 6.84 | Pass |
| Dark | text-tertiary on bg-primary | `#6b7280` | `#0f0f10` | **3.96** | Fail |
| Dark | text-tertiary on bg-card (setting hints) | `#6b7280` | `#1a1a1d` | **3.59** | Fail |
| Dark | accent text | `#3b82f6` | `#0f0f10` | 5.21 | Pass |
| Dark | white on accent (buttons, nav pill) | `#ffffff` | `#3b82f6` | **3.68** | Large text only |
| Dark | white on danger | `#ffffff` | `#f87171` | **2.77** | Fail |
| Dark | white on kebab | `#ffffff` | `#f97316` | **2.80** | Fail |
| Dark | white on success (toast) | `#ffffff` | `#34d399` | **1.92** | Fail |
| Dark | accent on accent-soft (Stash chip) | `#3b82f6` | `#3b82f6` @10% on bg | 4.70 | Pass |
| Dark | kebab on kebab-soft | `#f97316` | `#f97316` @15% on bg | 5.64 | Pass |
| Dark | danger text | `#f87171` | `#0f0f10` | 6.93 | Pass |
| Dark | border vs bg-card (non-text) | `#2a2a2e` | `#1a1a1d` | 1.21 | Below 3:1 |
| Dark | UA focus ring vs bg (non-text) | `#101010` | `#0f0f10` | **1.01** | Invisible |

**Suggested replacements and their measured ratios:**

| Theme | Token or pair | New value | Ratio |
|---|---|---|---|
| Light | `--kebab` | `#b45309` | 5.02 (white text) |
| Light | `--success` | `#047857` | 5.48 |
| Light | `--danger` | `#dc2626` | 4.83 |
| Light | `--text-tertiary` | `#6b7280` (and `--text-secondary` → `#4b5563`, about 7.5) | 4.83 |
| Light | Focus cyan | `#0e7490` | 5.36 |
| Dark | `--text-tertiary` | `#8b8f98` | 5.36 on card |
| Dark | Filled danger, kebab and success | text `#111827` | 6.41, 6.33 and 9.23 |
| Dark | Filled-button background | `#2563eb` | 5.17 |

---

## Quick wins (≤ 1h each)

1. `html { height:100%; overflow:hidden }` to fix the header clipping (#3). Change `scrollIntoView` calls to `block:'nearest'`.
2. Add the global `:focus-visible` rule and replace `transition: all` on `.action-btn` (#5).
3. Token swaps: `--kebab #b45309`, `--success #047857`, `--danger #dc2626`, light `--text-tertiary #6b7280`, dark `--text-tertiary #8b8f98`, dark `--border #34343a`.
4. In `focus-panel.js:554` `_getProfileColor`, return `var(--focus-${name})` instead of hard-coded dark hex.
5. `.chrome-group-header .group-name { flex: 1 1 80px }` so group titles reappear (#2).
6. `.domain-group-header .domain-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }` and `.window-label { white-space:nowrap }`.
7. Add `class="action-btn secondary"` to the "Bring to Front" button (`window-list.js:404`).
8. `role="status" aria-live="polite"` on `#toast-container`, `role="alert"` on error toasts, and an 8s duration for toasts with an action.
9. Add the `@media (prefers-reduced-motion: reduce)` block.
10. Status icons: neutral grey when not configured, red only on failure. Swap ★ for a sparkle icon.
11. Remove the always-on Smart Group zero-config note (`panel.html:207-210`), or show it only after a successful availability probe.
12. Label the empty-domain group "Blank & browser pages" (`tab-list.js:255`).
13. Default the session name to a timestamp instead of the "Enter a session name" error toast (`session-manager.js:382`).
14. Remove the duplicate "End Early" button in the Focus HUD (`focus-panel.js:577`) and add a confirm to "End session".
15. Add `aria-label` to `+`, `×`, `ℹ` and `☾/☀` buttons, plus `aria-pressed` on keep-awake. Add `<label for>` to settings numbers and selects.
16. `min-height: 24px` on `.stash-btn`, `.kebab-btn`, `.close-btn` and `.keep-awake-btn`. Pad × buttons to 24×24.
17. Make `/` open search when the AI command bar is hidden (`panel.js:557`).
18. Drop "(2 tabs)" from stash names. Decode URLs in Duplicates group headers.
19. Remove `.header-meta` (GitHub · Privacy · version) from the header. It is already in About.
20. Update `GUIDE.md` §Tabs View, §Toolbar and §Navigation Bar to match the current Domains / Groups / Duplicates UI.
