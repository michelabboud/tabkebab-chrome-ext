### Task 1: Establish the Bun regression and CI boundary

**Release checkpoint:** expected `v1.2.3`

**Files:**

- Create: `bunfig.toml`
- Create: `tests/setup.js`
- Create: `tests/helpers/chrome-mock.js`
- Create: `tests/harness.test.js`
- Create: `tests/syntax.test.js`
- Create: `sidepanel/message-client.js`
- Create: `tests/sidepanel/message-client.test.js`
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `PROGRESS.md`
- Modify: `VERSION`
- Modify: `manifest.json`

**Fixed test interfaces:**

```js
// tests/helpers/chrome-mock.js
export function createChromeEvent();
export function createRuntimePortPair(name = 'test-port');
// returns { clientPort, workerPort }
export function installChromeMock(overrides = {});
export function resetChromeMock();
export function readStorageArea(areaName);
```

`installChromeMock()` accepts `{ local, session, tabs, windows, groups, failures, runtimeHandler }`, installs the global `chrome`, and returns `{ calls, setRuntimeHandler, snapshot, connect }`. It must provide resettable `storage.local`, `storage.session`, `storage.onChanged`, `runtime.sendMessage`, `runtime.connect`, `runtime.onMessage`, `runtime.onConnect`, `runtime.onStartup`, `runtime.onInstalled`, tabs/windows/tabGroups events, alarms, action, sidePanel, bookmarks, identity, and call-recording stubs. Storage setters must emit Chrome-shaped change records and support one-shot injected failures. `runtime.connect()` returns the client port from `createRuntimePortPair()`, dispatches its worker peer through `runtime.onConnect`, posts only to the peer, and disconnects both ends exactly once.

- [ ] Create `tests/harness.test.js` first. Assert test-to-test storage/listener isolation, local/session separation, Chrome-shaped change events, seeded tab/window/group mutations, listener removal, peer-only port delivery, one-shot disconnect, and one-shot failure injection.
- [ ] Run `bun test tests/harness.test.js` and preserve the expected failures before the helper and preload are implemented.
- [ ] Create `tests/syntax.test.js`. Use `Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.js'])` to enumerate tracked plus not-yet-added JavaScript while excluding ignored output, `new Bun.Transpiler({ loader: 'js' }).transformSync(source)` to parse each file, and `JSON.parse` plus assertions to verify `manifest_version === 3` and `manifest.version === VERSION`.

```js
test('every repository JavaScript file parses', async () => {
  const listed = Bun.spawnSync([
    'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.js',
  ]);
  expect(listed.exitCode).toBe(0);
  const files = new TextDecoder()
    .decode(listed.stdout)
    .split('\0')
    .filter(Boolean);
  expect(files.length).toBeGreaterThan(0);
  const transpiler = new Bun.Transpiler({ loader: 'js' });
  for (const file of files) {
    expect(() => transpiler.transformSync(await Bun.file(file).text())).not.toThrow();
  }
});
```

- [ ] Implement `tests/helpers/chrome-mock.js`. Each event returned by `createChromeEvent()` must expose `addListener`, `removeListener`, `hasListener`, and an async `dispatch(...args)` that awaits listeners.
- [ ] Implement `tests/setup.js` with `beforeEach(() => installChromeMock())` and `afterEach(() => resetChromeMock())`. Do not install DOM or IndexedDB shims.
- [ ] Write `tests/sidepanel/message-client.test.js` red first, then create the approved `sendOrThrow()` implementation in `sidepanel/message-client.js`. Cover unchanged success, `{ error }` rejection, native rejection, and valid null; later tasks consume this boundary rather than reimplementing error checks.
- [ ] Add `bunfig.toml`:

```toml
[test]
preload = ["./tests/setup.js"]
coverageSkipTestFiles = true
```

- [ ] Add `.github/workflows/ci.yml` with a `test` job on `pull_request`, `workflow_dispatch`, and pushes to `main` only (not tag pushes). Use `actions/checkout@v4` and `oven-sh/setup-bun@v2` with `bun-version-file: .bun-version`. Its required commands, in order, are `bun test`, `bun test --coverage`, and `bun test tests/syntax.test.js`.
- [ ] Add `coverage/` to `.gitignore`. Do not ignore test evidence reports.
- [ ] Run `bun test tests/harness.test.js`, then all three global commands, and confirm zero failures. Confirm `git status --short` contains no coverage output.
- [ ] Document the pinned Bun prerequisite, local commands, mock-versus-Chrome boundary, and CI gate in `README.md`, `CONTRIBUTING.md`, and `ARCHITECTURE.md`.
- [ ] Close the task using the global version/docs/commit/tag/push chain.

