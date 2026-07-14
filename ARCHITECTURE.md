# TabKebab Architecture

TabKebab is a dependency-free Manifest V3 Chrome extension. Chrome loads the repository directly; there is no production build or bundling step.

`VERSION` is the repository version source of truth. `manifest.json` mirrors it for Chrome packaging.

## Runtime contexts

### Service worker

`service-worker.js` is the background event and command hub. It owns Chrome event listeners, alarm scheduling, tab/window mutations, Focus Mode interception, Drive orchestration, and access to cloud AI providers.

The service worker must not assume browser-document APIs are present. In particular, Chrome's Prompt API is unavailable in workers.

### Side panel

`sidepanel/panel.html` loads `sidepanel/panel.js` and the components under `sidepanel/components/`. The side panel owns user interaction, rendering, confirmations, and document-only capabilities such as Chrome Built-in AI.

Side-panel commands cross one checked runtime-message boundary. Background errors must become rejected operations before components display success.

### Core modules

`core/` contains tab, session, stash, Focus Mode, Drive, export, settings, and command logic. `core/engine/` implements the snapshot, solver, planner, and executor grouping pipeline. `core/ai/` contains provider adapters, key handling, caching, and request scheduling.

Pure policy and merge decisions belong in core modules that can run without Chrome. Chrome API calls remain at explicit adapters and orchestration boundaries.

## Persistence

- `chrome.storage.local`: sessions, settings, manual groups, Focus Mode preferences/history, Drive state, AI configuration, and sync metadata.
- `chrome.storage.session`: decrypted API-key cache only; Chrome clears it on browser restart, extension reload, update, or disable.
- IndexedDB: stashes and their window/tab metadata.
- Google Drive `drive.file`: profile-scoped canonical sync/settings files plus dated exports.

Credentials, decrypted keys, OAuth tokens, caches, and active Focus Mode state are never included in portable exports.

## External boundaries

- Chrome tabs, windows, groups, storage, alarms, identity, side panel, and bookmarks APIs.
- Google Drive REST API.
- OpenAI, Anthropic, Gemini, and user-configured OpenAI-compatible HTTP endpoints.
- Chrome Prompt API in the side-panel document only.

## Verification architecture

Bun `1.3.11` is the pinned test runtime. `bun:test` covers pure policies, data merges, response contracts, retry behavior, and mocked Chrome API orchestration without adding packages. Bun does not supply IndexedDB or a browser DOM; those integrations are verified in an unpacked-extension Chrome smoke matrix.

See:

- [Reliability hardening design](docs/superpowers/specs/2026-07-14-tabkebab-reliability-hardening-design.md)
- [Architecture decision records](docs/adr/README.md)
- [Current progress](PROGRESS.md)
