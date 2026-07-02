# Contributing to OpenGUI

Thanks for your interest in contributing to OpenGUI. This guide covers what you need to get started.

## Prerequisites

- [Node.js](https://nodejs.org/) 24+
- [pnpm](https://pnpm.io/) 11+
- [Vite+](https://github.com/mariozechner/vite-plus) (`vp`) — installed as a dev dependency; invoke with **`pnpm vp <command>`** after `pnpm install` (global `vp` is optional)
- At least one supported backend available locally (OpenCode CLI, Claude Code, Codex, or Pi)
- Git

Tooling convention: Node.js runs the app/server code, pnpm owns dependency installation and lockfile changes, and Vite+ (`vp`) is the command surface for checks, tests, builds, and project tasks. Use **`pnpm vp …`** or **`pnpm run <script>`**; do not assume `vp` is on your `PATH`.

## Setup

```bash
git clone https://github.com/akemmanuel/OpenGUI.git
cd OpenGUI
pnpm install
```

## Development

Use **`pnpm run dev`** for desktop and **`pnpm run dev:web`** for web — append **`:web`** to the dev task for the browser stack.

```bash
pnpm run dev       # Electron (desktop)
pnpm run dev:web   # browser + local backend API
```

## Code Style

This project uses Vite+ tasks:

```bash
pnpm run dev     # desktop development
pnpm run dev:web # web development
pnpm vp lint     # lint check
pnpm vp check    # lint, format, and type checks
pnpm vp test     # unit tests
pnpm vp fmt      # format
pnpm run build   # production build (runs vp build)
pnpm vp run <task>    # named project tasks, such as dist:linux
```

Use pnpm for dependency changes (`pnpm install`, `pnpm add`, `pnpm remove`, `pnpm update`). Do not run `tsc` directly for typechecking. Run `pnpm vp check` and `pnpm vp test` before submitting a PR.

## Commit Messages

Write clear, concise commit messages. Focus on the "why" rather than the "what."

- `fix: resolve model selector scroll-to-select issue`
- `feat: add keyboard shortcut for clearing prompt`
- `refactor: extract connection logic into separate hook`

## Pull Requests

1. Fork the repository
2. Create a feature branch from `master`: `git checkout -b my-feature`
3. Make your changes
4. Run `pnpm vp check` and `pnpm vp test`
5. If you moved `server/web-server.ts`, `packages/backend/**`, or `packages/runtime/src/adapters/**`, update [`docs/architecture.md`](docs/architecture.md) in the same PR
6. Commit your changes with a clear message
7. Push to your fork and open a pull request against `master`

Keep PRs focused on a single change. If you have multiple unrelated fixes, open separate PRs.

## Filing Issues

- **Bug reports**: Include steps to reproduce, expected behavior, actual behavior, and your OS/version.
- **Feature requests**: Describe the use case and why the feature would be valuable.

Check existing issues before opening a new one to avoid duplicates.

## Architecture Overview

If you're new to the codebase, start with [CONTEXT.md](CONTEXT.md), [docs/architecture.md](docs/architecture.md), and the ADRs in [docs/adr/](docs/adr/). Use **Harness** for coding-agent runtimes (OpenCode, Claude Code, Codex, Pi); reserve **provider** for model/API providers inside a Harness.

```
main.ts              Desktop Shell main process (window management, IPC)
preload.js           Desktop Shell preload API
packages/runtime/src/adapters/   Harness adapters (OpenCode, Claude, Codex, Pi)
packages/backend/src/   OpenGUI Backend (createBackendHost: RPC, SSE, FS, product API)
server/web-server.ts    Thin listen entry for browser/API-only mode
src/
  index.html          HTML entry point
  frontend.tsx        React entry point
  App.tsx             Main app layout/orchestrator
  agents/             Harness descriptors, event normalizers, and protocol mappers
  features/           Cross-component frontend orchestration hooks
  hooks/              Agent state, model state, and UI hooks
  components/         UI components (sidebar, messages, prompt box, dialogs, etc.)
  components/ui/      Reusable UI primitives such as DialogShell
  lib/                Utility modules and browser Electron shim
  types/              TypeScript type definitions
```

### Harness changes

Harness-facing code lives in `src/agents/`. Local CLI Harnesses should use `cli-harness-factory.ts` for shared capabilities/workspace defaults and tagged event normalization. Harnesses with custom SDK events should keep protocol mapping in `src/agents/protocol/` and add mapper tests. Use `id-codec.ts` and the shared tagging helpers instead of composing session IDs by hand.

### Frontend feature slices

`src/App.tsx` still composes the app shell, but cross-component orchestration should move into focused hooks under `src/features/<area>/`. Existing slices cover app keyboard shortcuts, active-session queue handlers, chat surface derivation, and active worktree merge actions. Keep reusable visual primitives in `src/components/ui/` and pure utilities in `src/lib/`.

### Provider icons

Provider icons are resolved from the SVG manifest under `src/components/provider-icons/svgs/`. Add a correctly named SVG there before changing React code; Vite expands the manifest automatically.

## Areas Where Help Is Needed

- Windows support hardening and broader testing
- Accessibility improvements
- More test coverage across UI and backend flows
- Performance profiling for large sessions
- Bug reports from different environments

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
