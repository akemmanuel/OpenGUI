# Contributing to OpenGUI

Thanks for your interest in contributing to OpenGUI. This guide covers what you need to get started.

## Prerequisites

- [Bun](https://bun.sh) v1.2+ runtime
- [pnpm](https://pnpm.io/) 10+
- [Vite+](https://github.com/mariozechner/vite-plus) (`vp`) available via project dependencies
- At least one supported backend available locally (OpenCode CLI, Claude Code, Codex, or Pi)
- Git

Tooling convention: Bun runs the app/server code, pnpm owns dependency installation and lockfile changes, and Vite+ (`vp`) is the command surface for development, checks, tests, builds, and project tasks.

## Setup

```bash
git clone https://github.com/akemmanuel/OpenGUI.git
cd OpenGUI
pnpm install
```

## Development

Run Electron app in development mode (renderer HMR + Electron shell):

```bash
vp run dev
```

Or run browser version with backend API:

```bash
vp run dev:web
```

## Code Style

This project uses Vite+ tasks:

```bash
vp lint          # lint check
vp check         # lint, format, and type checks
vp test          # unit tests
vp fmt           # format
```

Run `vp check` and `vp test` before submitting a PR.

## Commit Messages

Write clear, concise commit messages. Focus on the "why" rather than the "what."

- `fix: resolve model selector scroll-to-select issue`
- `feat: add keyboard shortcut for clearing prompt`
- `refactor: extract connection logic into separate hook`

## Pull Requests

1. Fork the repository
2. Create a feature branch from `master`: `git checkout -b my-feature`
3. Make your changes
4. Run `vp check` and `vp test`
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
main.ts              Electron main process (window management, IPC)
preload.js           Preload script (contextBridge API for renderer)
opencode-bridge.ts   IPC bridge to OpenCode SDK (SSE, sessions, prompts)
claude-code-bridge.ts IPC bridge to Claude Code SDK
codex-bridge.ts      IPC bridge to Codex SDK
pi-bridge.ts         IPC bridge to Pi runtime
server/web-server.ts  Bun runtime backend for browser mode (RPC, events, server FS browser)
src/
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
