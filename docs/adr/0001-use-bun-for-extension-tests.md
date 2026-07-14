# ADR 0001: Use Bun for dependency-free extension tests

## Context

TabKebab is shipped as native browser ESM with no build step and no package dependencies. The repository had no automated tests, while the reviewed failures span pure policies, asynchronous orchestration, Chrome API boundaries, and browser-only IndexedDB/DOM behavior.

The test runtime must import the existing `.js` ESM directly, provide mocks and coverage, preserve the zero-dependency product constraint, and remain reproducible in CI.

## Decision

Pin Bun `1.3.11` in `.bun-version` and use `bun:test` for automated tests. A Bun preload installs repository-owned Chrome API test doubles. Tests extract or inject pure policy seams instead of emulating an entire browser.

No DOM or IndexedDB compatibility package is added. Browser-only behavior is verified by loading the unpacked extension in real Chrome and running the documented smoke matrix.

References: [Bun test runner](https://bun.sh/docs/test), [Bun Web API support](https://bun.sh/docs/runtime/web-apis).

## Alternatives rejected

- **Node's built-in test runner:** viable, but the repository's mixed browser ESM and CommonJS screenshot utilities require package-scope changes or loader flags. Bun imports both formats directly and supplies stronger built-in mocking and coverage.
- **Vitest, Jest, Happy DOM, or fake-indexeddb:** capable, but introduce package dependencies and simulated browser behavior that can diverge from Chrome.
- **Manual testing only:** cannot prevent regression in destructive and data-merging logic.

## Consequences

- Contributors and CI require the pinned Bun version.
- Pure logic and Chrome-call orchestration gain fast automated coverage without production dependencies.
- IndexedDB, DOM, extension lifecycle, OAuth, and Prompt API behavior remain explicit real-browser gates.
- Tests must not mistake a Chrome mock for proof of Chrome integration behavior.

## Status

Accepted on 2026-07-14.
