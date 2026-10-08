# TabKebab side panel: UI/UX after the overhaul

- **Date:** 2026-10-08
- **Build:** v1.3.0, branch `claude/sleepy-galileo-6w8h0l` (worker `tabkebab-service-worker.js`)
- **Method:** Same harness as the [review](uiux-review.md). The unpacked extension ran in headless Chromium through Playwright, and `sidepanel/panel.html` was opened at 360×800 in light and dark (`prefers-color-scheme`). The test browser had 3 windows, about 20 tabs on 12 domains, 3 Chrome groups (one collapsed), a pinned tab, duplicates, a blank page, 2 stashes and 2 saved sessions. Pages came from a local server, so favicons are placeholders.
- **Screenshots:** [`uiux-after-shots/`](uiux-after-shots/), 27 PNGs named `360-<theme>-<nn>-<state>.png` (256-colour, about 0.6 MB in total). The "before" shots are in [`uiux-review-shots/`](uiux-review-shots/).
- **Harness artefacts:** The `cgfnjdc…` domain row is the panel's own tab. It only exists because the panel ran as a tab during testing. The "device is not eligible for running on-device model" console warning comes from headless Chromium.

## Top 10: before and after

| # | Review item | Before | After | Status |
|---|---|---|---|---|
| 1 | Domain rows overflow sideways; Close off-screen | [02b tabs-domains-tall](uiux-review-shots/360-light-02b-tabs-domains-tall.png), [23b many tabs](uiux-review-shots/360-light-23b-domains-many-tabs.png) | [01 tabs-domains](uiux-after-shots/360-light-01-tabs-domains.png), [02 row ⋯ menu](uiux-after-shots/360-light-02-domains-row-menu.png), [dark 01](uiux-after-shots/360-dark-01-tabs-domains.png) | Done. Each row has a name that truncates, a count, W1/W2 only when the domain spans windows, **Stash**, and a **⋯** menu (Sleep tabs, Keep awake, Summarize (AI), Close N tabs…). The browser smoke measured `scrollWidth == clientWidth`. |
| 2 | Chrome group titles invisible at 360px | [03 tabs-groups](uiux-review-shots/360-light-03-tabs-groups.png) | [04 tabs-groups](uiux-after-shots/360-light-04-tabs-groups.png), [dark 04](uiux-after-shots/360-dark-04-tabs-groups.png) | Done. Group rows show the title, the tab count, **Stash** and **⋯** (Sleep, Keep awake, Collapse/Expand in tab strip, Ungroup, Close…). |
| 3 | Header clipped after "Replay guide" | [24 after-replay-guide](uiux-review-shots/360-light-24-after-replay-guide.png) | [20 after-replay-guide](uiux-after-shots/360-light-20-after-replay-guide.png) | Done. The root no longer scrolls: after the replay, the probe measured `documentElement.scrollTop = 0` and the header top at 0. |
| 4 | Colour-on-colour contrast; Focus HUD ignores theme | [21 focus-hud](uiux-review-shots/360-light-21-focus-hud.png) | [10 focus-hud](uiux-after-shots/360-light-10-focus-hud.png), [dark 10](uiux-after-shots/360-dark-10-focus-hud.png), [16 toast](uiux-after-shots/360-light-16-toast-undo.png), [15 confirm](uiux-after-shots/360-light-15-confirm-ungroup-all.png) | Done. Tokens use the review's AA values (`--kebab #b45309`, `--success #047857`, `--danger #dc2626`, tertiary text and dark borders), and the HUD uses theme `--focus-*` tokens. |
| 5 | No visible keyboard focus | [22b keyboard-focus-nav](uiux-review-shots/360-light-22b-keyboard-focus-nav.png) | [21 keyboard-focus](uiux-after-shots/360-light-21-keyboard-focus.png) | Done. There is a global `:focus-visible` ring, and the view bar is a roving ARIA tablist (←/→). |
| 6 | 215px of chrome; stats on every view | [02 tabs-domains](uiux-review-shots/360-light-02-tabs-domains.png), [09 settings](uiux-review-shots/360-light-09-settings.png) | [01 tabs-domains](uiux-after-shots/360-light-01-tabs-domains.png), [12 settings-top](uiux-after-shots/360-light-12-settings-top.png) | Done. A one-line strip shows "3 windows · 21 tabs · 0 sleeping", and it is hidden on Settings and Focus. |
| 7 | Domains toolbar: 6 buttons, 2 primaries | [02 tabs-domains](uiux-review-shots/360-light-02-tabs-domains.png) | [03 Group ▾ menu](uiux-after-shots/360-light-03-group-split-menu.png), [04 groups](uiux-after-shots/360-light-04-tabs-groups.png), [06 windows](uiux-after-shots/360-light-06-windows.png) | Done. The toolbar is one row: the split button **Group by domain ▾** (Smart group (AI), Ungroup all…), then **Sleep all** and a ⇕ toggle. Groups and Windows use the same pattern. |
| 8 | Smart Group messaging contradicts itself | [16 smart-group-no-ai](uiux-review-shots/360-light-16-smart-group-no-ai.png) | [22 smart-group-fallback](uiux-after-shots/360-light-22-smart-group-fallback.png) | Done. No note is shown up front. The "on-device AI is ready" hint appears only after a successful probe. When the probe fails, the fallback offers **Group by domain** or **Add an API key**. |
| 9 | Drive/AI status icons red when not opted in | [02 tabs-domains](uiux-review-shots/360-light-02-tabs-domains.png) (header) | [01 tabs-domains](uiux-after-shots/360-light-01-tabs-domains.png) (header), [19 command bar](uiux-after-shots/360-light-19-command-bar.png) (AI on: green dot) | Done. Not set up is grey with the tooltip "AI: off — click to set up". Configured is grey with a green dot. A failing feature is red. The ★ is now a sparkle icon. |
| 10 | Toasts silent, short, no Undo | [17 toast-after-stash](uiux-review-shots/360-light-17-toast-after-stash.png), [20a empty session name](uiux-review-shots/360-light-20a-session-save-empty-name.png) | [16 toast with Undo](uiux-after-shots/360-light-16-toast-undo.png), [08 sessions](uiux-after-shots/360-light-08-sessions.png) | Done. The toast container is a live region. A toast with an action stays 8s and pauses on hover or focus. Stashing a domain, group or window offers **Undo**. An empty session name saves as "Session — Oct 8, 10:38 PM". |

## Other states captured

| State | Light | Dark |
|---|---|---|
| Duplicates (scanned; badge = button count) | [05](uiux-after-shots/360-light-05-duplicates.png) | — |
| Windows (current window marked by an accent edge and a dot; styled Bring to front) | [06](uiux-after-shots/360-light-06-windows.png) | [06](uiux-after-shots/360-dark-06-windows.png) |
| Stash (Restore primary, ghost Delete, Export/Import in ⋯) | [07](uiux-after-shots/360-light-07-stash.png) | [07](uiux-after-shots/360-dark-07-stash.png) |
| Sessions (optional name, ⋯ for Export/Import) | [08](uiux-after-shots/360-light-08-sessions.png) | — |
| Focus setup (profiles, duration, Start at the top; Customize folded) | [09](uiux-after-shots/360-light-09-focus-setup.png) | — |
| Focus banner on other views | [11](uiux-after-shots/360-light-11-focus-banner.png) | — |
| Settings: sticky index, General, Features card | [12](uiux-after-shots/360-light-12-settings-top.png), [13](uiux-after-shots/360-light-13-settings-features.png) | [12](uiux-after-shots/360-dark-12-settings-top.png) |
| Settings: AI provider select with "Off" | [17](uiux-after-shots/360-light-17-settings-ai-off.png) | — |
| Search (Ctrl+K) | [14](uiux-after-shots/360-light-14-search.png) | — |
| Confirm dialog (Ungroup all) | [15](uiux-after-shots/360-light-15-confirm-ungroup-all.png) | — |
| Command bar (single line, "via Custom") | [19](uiux-after-shots/360-light-19-command-bar.png) | — |

## Review items not implemented, or done differently

- **Forced-dark token block generated from one source** (Dark mode section). This was not done. The OS-dark and `[data-theme="dark"]` blocks are still written twice. Instead, a test (`tests/sidepanel/foundation-shell.test.js`, "OS-dark and forced-dark token blocks are identical") stops them from drifting. A single generated source would need a build step, and the extension deliberately has none.
- **Back affordance ("← Tabs") on Settings and Focus** (Information architecture). This was done differently. There is no title bar or ×. Instead, the header button of the open view shows a selected state, and **Esc** returns to Tabs from both Settings and Focus setup.
- **Collapsed "Ask TabKebab… (set up AI)" command bar** (Command bar). The review offered two options, and the other one was taken: without AI, `/` opens search, and Help lists `/` as "AI command bar (or search)".
- **Focus HUD "Distractions blocked / Focus tabs" labels.** The base rule in `panel.css` still uses `--text-tertiary`, and `settings-focus.css` overrides it with `--text-secondary`. The effective colour follows the review.

## Bugs found in this pass (fixed, with regression tests)

1. **The Focus banner went stale across panels.** A Focus run ended or started in another window's panel, or ended by a direct `endFocus`, only changed `focusState` in storage. Only a timer expiry is broadcast. So the other panel kept a ticking "49:50 left" banner for a run that no longer existed, and missed new runs. The panel now syncs the banner and the header button from `chrome.storage` changes (`focusIndicatorStateFromStorageChange`). The banner's **End** ends the run the banner shows.
2. **Chrome logged a warning on every panel load:** "No output language was specified in a LanguageModel API request". The Smart group availability probe and the Chrome AI provider called `LanguageModel.availability()` and `create()` without naming the language. Both now pass `expectedInputs` and `expectedOutputs` (`en`).
