# Contributing

## Setup

Install Node.js 22.5 or newer and pnpm 11.5.2, then run:

```bash
pnpm install
pnpm run dev
```

Use `pnpm run dev:web` for browser development.

## Architecture

OpenGUI has one product path:

1. The preserved React frontend calls the OpenGUI Host.
2. The Host owns projects, model connections, Sessions, and transport.
3. The first-party Harness owns execution and the append-oriented SQLite Session log.
4. Model turns can invoke only `read`, `write`, `edit`, and `shell`.

Do not add external coding-agent SDKs, CLI adapters, compatibility facades, alternate Session
identity schemes, Git/worktree orchestration, MCP, or plugin runtimes.

Read [`CONTEXT.md`](CONTEXT.md), [`docs/architecture.md`](docs/architecture.md), and
[`docs/adr/0010-first-party-opengui-harness.md`](docs/adr/0010-first-party-opengui-harness.md)
before changing product boundaries.

## Quality

```bash
pnpm run check
pnpm run test
pnpm run slop-check
pnpm run build
```

Use Vite+ through the package scripts or `pnpm vp`. Never use `tsc` for typechecking.
When user-facing text changes, update `src/i18n/locales/en.json`, `de.json`, and `es.json`.
