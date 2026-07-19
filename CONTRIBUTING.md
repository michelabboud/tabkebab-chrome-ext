# Contributing to TabKebab

Thanks for your interest in contributing to TabKebab!

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```
   git clone https://github.com/YOUR_USERNAME/tabkebab-chrome-ext.git
   ```
3. Create a branch from `dev`:
   ```
   git checkout dev
   git checkout -b your-feature-name
   ```
4. Load the extension in Chrome:
   - Open `chrome://extensions`
   - Enable **Developer Mode**
   - Click **Load unpacked** and select the project folder
5. Install Bun `1.3.11`, the exact version pinned in `.bun-version`

No package installation is required. TabKebab has no runtime or test dependencies and Chrome loads its source files directly.

## Branch Strategy

- **`main`** — release-ready source and GitHub release history; the separately
  operated Chrome Web Store listing may lag
- **`dev`** — active development, all PRs target this branch

**Do not submit PRs directly to `main`.**

## Submitting Changes

1. Make your changes on your feature branch
2. Run the complete automated gate from the repository root:
   ```bash
   bun test
   bun test --coverage
   bun test tests/syntax.test.js
   ```
3. Test browser-only behavior thoroughly in unpacked Chrome; use the
   [real-Chrome smoke matrix](docs/guides/real-chrome-smoke-matrix.md) for a
   release candidate
4. Push to your fork
5. Open a Pull Request targeting the **`dev`** branch
6. Describe what you changed and why

GitHub Actions repeats the three Bun commands, in order, for pull requests,
manual dispatches, and pushes to `main`. A dependent `windows-latest` job then
runs `package.cmd`, verifies its exact positive-allowlist archive and version,
and uploads one versioned extension artifact; tag pushes are excluded. A local
package is only test evidence—the release matrix uses the artifact produced by
the exact successful CI run.

## Guidelines

- **No frameworks, no build tools** — this project is vanilla HTML, CSS, and JS
- **No external dependencies** — keep it zero-dependency
- **Match the existing code style** — follow the patterns you see in the codebase
- **Test success and failure paths** — start behavior changes with a failing regression, then run the full gate
- **Respect the test boundary** — the Chrome mock verifies policy and API orchestration, not DOM, IndexedDB, extension lifecycle, OAuth, or Prompt API behavior; verify those in real Chrome
- **Keep PRs focused** — one feature or fix per PR

## Reporting Bugs

Open an issue at [GitHub Issues](https://github.com/michelabboud/tabkebab-chrome-ext/issues) with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Chrome version and OS

## Feature Requests

Open an issue describing the feature and why it would be useful. Discussion before implementation helps avoid wasted effort.

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
