### Task 9: Define portable export v2 and secret-free section merges

**Finding:** 10, complete export foundation

**Release checkpoint:** expected `v1.2.11`

**Files:**

- Create: `core/export-schema.js`
- Create: `tests/core/export-schema.test.js`
- Create: `tests/integration/bookmark-snapshot.test.js`
- Modify: `core/settings.js`
- Modify: `service-worker.js`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Canonical portable shape:**

```js
export const PORTABLE_EXPORT_VERSION = 2;
export const MAX_PORTABLE_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_PORTABLE_SECTION_RECORDS = 10_000;
export const MAX_PORTABLE_TABS_PER_RECORD = 10_000;
export const MAX_PORTABLE_TOTAL_TABS = 100_000;
export const MAX_PORTABLE_STRING_LENGTH = 16_384;
export const MAX_PORTABLE_NESTING_DEPTH = 12;

// core/settings.js
export const PORTABLE_SETTINGS_KEYS = Object.freeze(Object.keys(SETTINGS_DEFAULTS));

{
  version: 2,
  kind: 'full' | 'sessions' | 'stashes' | 'settings',
  exportedAt: '2026-07-14T12:00:00.000Z',
  sessions: [],
  stashes: [],
  manualGroups: {},
  keepAwakeDomains: [],
  bookmarks: [],
  settings: {},
  focusProfilePrefs: {},
  focusHistory: [],
  aiSettings: {
    enabled: false,
    providerId: null,
    providerConfigs: {
      openai: { model: 'gpt-4.1-nano' },
      custom: { model: 'default', baseUrl: 'http://localhost:11434/v1' },
    },
  },
}
```

Full documents require every section. Partial kinds require only their named section plus the envelope. `aiSettings` contains only `enabled`, `providerId`, provider `model`, and Custom `baseUrl`; it never contains `apiKey`, ciphertext, passphrase metadata, or unknown provider fields.

**Fixed schema interfaces:**

```js
export function sanitizeAISettings(aiSettings);
export function validateStashSection(value);
export function createPortableExportDocument(kind, sections, exportedAt);
export function parsePortableExportDocument(value);
export function mergePortableSections(existing, incoming, { tombstones, now });
```

- [ ] Write schema tests first for a complete v2 full payload, each partial kind, and deterministic serialization. Recursively scan serialized output and assert no key named `apiKey`, `token`, `credential`, `installId`, `focusState`, `driveSync`, or cache field exists.
- [ ] Add v1 compatibility fixtures for current full/session/stash/settings files and assert they normalize to the matching v2 sections in memory.
- [ ] Add preflight rejection tests for unsupported versions, missing required sections, malformed IDs/types/timestamps, arrays where records are required, non-JSON values, and `__proto__`/`constructor`/`prototype` keys. An `apiKey` anywhere inside imported `aiSettings` must reject the document rather than be silently persisted. Exercise exported `validateStashSection()` directly with valid and malformed stash arrays so the transactional IndexedDB boundary can revalidate independently.
- [ ] Add resource-bound tests for more than 10,000 records in any section, more than 10,000 tabs in one session/stash, more than 100,000 tabs across the document, strings above 16,384 characters, nesting deeper than 12, and cumulative in-memory payload cost above `MAX_PORTABLE_IMPORT_BYTES` even when every individual record/string is under its own cap. Reject before merge or storage access; Task 10 also covers the panel's pre-parse file-size boundary.
- [ ] Define merge tests: local record wins stable-ID collision for sessions/stashes/history; local object value wins manual-group/focus-preference key collision; keep-awake is set union; bookmarks use their stable `id`, with deterministic `createdAt/date/time` identity only for legacy records; imported allowlisted general settings overlay local values.
- [ ] Add `tests/integration/bookmark-snapshot.test.js`, stub `crypto.randomUUID()`, invoke the worker `{ action: 'createBookmarks' }` path with local and Drive destinations, and prove every newly persisted bookmark snapshot contains that stable ID before any destination write; the legacy tuple is never used for new data.
- [ ] Prove AI merge overlays only provider/model/base URL while preserving every existing encrypted `apiKey` and existing `usePassphrase` metadata byte-for-byte.
- [ ] Prove explicit import of a session/group hidden by a local tombstone revives it with `modifiedAt > tombstone` while retaining the tombstone; this is allowed because import is a direct user recovery action, unlike passive Drive sync.
- [ ] Run `bun test tests/core/export-schema.test.js tests/integration/bookmark-snapshot.test.js` and preserve failures from missing schema/sections, unsanitized settings, and bookmark records without stable IDs.
- [ ] Implement schema validation as pure code using own-property checks and null-prototype output records. Its single traversal maintains a cumulative budget: UTF-8 bytes of every own key/string plus 16 bytes for every scalar, property, array slot, and container; reject immediately when the total exceeds `MAX_PORTABLE_IMPORT_BYTES`, reject cycles/non-JSON values, and never use an unbounded stringify as the worker's size check. Export `validateStashSection()` and have `parsePortableExportDocument()` call that exact function for its stash section; validate every present section before returning any normalized data.
- [ ] Export `PORTABLE_SETTINGS_KEYS` from `core/settings.js`, derived exactly from `SETTINGS_DEFAULTS`, and consume it in export validation/merge. Never spread arbitrary storage keys into a portable document.
- [ ] Add `id: crypto.randomUUID()` to new bookmark snapshots in `service-worker.js`; preserve existing IDs and derive the tuple identity only while importing legacy bookmarks.
- [ ] Implement AI sanitization by constructing allowed fields, not by cloning and deleting known secrets.
- [ ] Implement the exact merge rules above without Chrome, DOM, or IndexedDB access.
- [ ] Run `bun test tests/core/export-schema.test.js tests/integration/bookmark-snapshot.test.js`, then the full three-command gate.
- [ ] Update `ARCHITECTURE.md` with the portable boundary and explicit import-recovery semantics, then close the task using the global chain.

