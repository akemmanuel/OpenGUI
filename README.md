# OpenGUI

OpenGUI is a desktop and web coding agent built on the first-party OpenGUI Host and Harness.
The Host owns projects, model connections, Sessions, durable transcript history, and execution.
The Harness exposes four workspace tools: `read`, `write`, `edit`, and `shell`.

## Requirements

- Node.js 22.5 or newer
- pnpm 11.5.2
- An OpenAI-compatible model endpoint and API key

No external coding-agent CLI or SDK is required.

## Development

```bash
pnpm install
pnpm run dev       # Electron
pnpm run dev:web   # browser
```

## Verification

```bash
pnpm run check
pnpm run test
pnpm run slop-check
pnpm run build
```

## Production

```bash
pnpm run start       # Electron
pnpm run start:web   # browser
```

See [`docs/architecture.md`](docs/architecture.md),
[`docs/adr/0010-first-party-opengui-harness.md`](docs/adr/0010-first-party-opengui-harness.md),
and [`CONTRIBUTING.md`](CONTRIBUTING.md).
