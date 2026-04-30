# Contributing to OpenGUI

Thanks for your interest in contributing to OpenGUI. This guide covers what you need to get started.

## Prerequisites

- [Bun](https://bun.sh) v1.2+
- At least one supported backend available locally (OpenCode CLI, Claude Code, Codex, or Pi)
- Git

## Setup

```bash
git clone https://github.com/akemmanuel/OpenGUI.git
cd OpenGUI
bun install
```

## Development

Run Electron app in development mode (renderer HMR + Electron shell):

```bash
bun dev
```

Or run browser version with Bun backend API:

```bash
bun dev:web
```

## Code Style

This project currently uses `oxlint` via Bun scripts:

```bash
bun run lint          # lint check
bun run lint:check    # lint check
bun run lint:fix      # auto-fix where possible
bun run typecheck     # TypeScript-aware checks
bun test              # unit tests
```

Run `bun run lint:check`, `bun run typecheck`, and `bun test` before submitting a PR.

## Commit Messages

Write clear, concise commit messages. Focus on the "why" rather than the "what."

- `fix: resolve model selector scroll-to-select issue`
- `feat: add keyboard shortcut for clearing prompt`
- `refactor: extract connection logic into separate hook`

## Pull Requests

1. Fork the repository
2. Create a feature branch from `master`: `git checkout -b my-feature`
3. Make your changes
4. Run `bun run lint:check`, `bun run typecheck`, and `bun test`
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
main.cjs              Electron main process (window management, IPC)
preload.cjs           Preload script (contextBridge API for renderer)
opencode-bridge.mjs   IPC bridge to OpenCode SDK (SSE, sessions, prompts)
server/web-server.ts  Bun backend for browser mode (RPC, events, server FS browser)
src/
  index.ts            Renderer-only Bun dev server entry
  index.html          HTML entry point
  frontend.tsx        React entry point
  App.tsx             Main app layout
  hooks/              Custom React hooks (state management, backends, STT)
  components/         UI components (sidebar, messages, prompt box, etc.)
  lib/                Utility modules, including browser Electron shim
  types/              TypeScript type definitions
```

## Areas Where Help Is Needed

- Windows support hardening and broader testing
- Accessibility improvements
- More test coverage across UI and backend flows
- Performance profiling for large sessions
- Bug reports from different environments

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
