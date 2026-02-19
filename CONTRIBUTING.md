# Contributing to OpenGUI

Thanks for your interest in contributing to OpenGUI. This guide covers what you need to get started.

## Prerequisites

- [Bun](https://bun.sh) v1.2+
- [OpenCode CLI](https://opencode.ai) installed and available in your PATH
- Git

## Setup

```bash
git clone https://github.com/akemmanuel/OpenGUI.git
cd OpenGUI
bun install
```

## Development

Run the web frontend + Electron in development mode (with HMR):

```bash
bun run dev
```

Or run just the web frontend (no Electron):

```bash
bun run dev:web
```

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting. Always use the bun scripts:

```bash
bun run lint          # check and auto-fix lint + format issues
bun run lint:check    # check only, no auto-fix
bun run format        # auto-fix formatting only
```

Run `bun run lint` before submitting a PR to make sure your code passes.

## Commit Messages

Write clear, concise commit messages. Focus on the "why" rather than the "what."

- `fix: resolve model selector scroll-to-select issue`
- `feat: add keyboard shortcut for clearing prompt`
- `refactor: extract connection logic into separate hook`

## Pull Requests

1. Fork the repository
2. Create a feature branch from `master`: `git checkout -b my-feature`
3. Make your changes
4. Run `bun run lint` to verify code style
5. Commit your changes with a clear message
6. Push to your fork and open a pull request against `master`

Keep PRs focused on a single change. If you have multiple unrelated fixes, open separate PRs.

## Filing Issues

- **Bug reports**: Include steps to reproduce, expected behavior, actual behavior, and your OS/version.
- **Feature requests**: Describe the use case and why the feature would be valuable.

Check existing issues before opening a new one to avoid duplicates.

## Architecture Overview

If you're new to the codebase, here's where things live:

```
main.cjs            Electron main process (window management, IPC)
preload.cjs         Preload script (contextBridge API for renderer)
opencode-bridge.mjs IPC bridge to the OpenCode SDK (SSE, sessions, prompts)
src/
  index.ts          Bun web server (development + production)
  index.html        HTML entry point
  frontend.tsx      React entry point
  App.tsx           Main app layout
  hooks/            Custom React hooks (state management, STT)
  components/       UI components (sidebar, messages, prompt box, etc.)
  lib/              Utility modules
  types/            TypeScript type definitions
```

## Areas Where Help Is Needed

- Windows support (currently Linux and macOS only)
- Accessibility improvements
- Test coverage (there are currently no tests)
- Performance profiling for large sessions
- Bug reports from different environments

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
