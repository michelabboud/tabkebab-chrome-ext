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

## Branch Strategy

- **`main`** — production, matches the published Chrome Web Store version
- **`dev`** — active development, all PRs target this branch

**Do not submit PRs directly to `main`.**

## Submitting Changes

1. Make your changes on your feature branch
2. Test thoroughly in Chrome
3. Push to your fork
4. Open a Pull Request targeting the **`dev`** branch
5. Describe what you changed and why

## Guidelines

- **No frameworks, no build tools** — this project is vanilla HTML, CSS, and JS
- **No external dependencies** — keep it zero-dependency
- **Match the existing code style** — follow the patterns you see in the codebase
- **Test your changes** — load the extension and verify everything works
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
