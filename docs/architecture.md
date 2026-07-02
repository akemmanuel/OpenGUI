# OpenGUI architecture notes

Contributor map of the repo **as it exists today**. Product language and ownership: [`CONTEXT.md`](../CONTEXT.md). Accepted decisions: [`docs/adr/`](./adr/).

## Layers (canonical)

Four layers — same definitions as [`CONTEXT.md` → Architecture](../CONTEXT.md#architecture):

| Layer                | Owns                                                                                                                                                                                                                                           | Does not own                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **OpenGUI Runtime**  | Harness Adapters, normalized `HarnessEvent` stream, Harness Inventory, Agent sends on **Harness Scope** (`harnessId` + directory + harness session id). Session/transcript **truth** stays in the Harness.                                     | Queued prompts, multi-Frontend transport, Workspaces, queue UI, `OpenGuiClient`        |
| **OpenGUI Backend**  | One embedded Runtime per process; HTTP/WebSocket/SSE and Desktop IPC transport; Queued prompts + Queue dispatch; Backend arbitration; backend access token auth; Backend persistence (queue, uploads cleanup). Delegates execution to Runtime. | Workspace identity, sidebar Project membership, Pending prompts, presentation metadata |
| **OpenGUI Frontend** | Workspaces, Frontend Projects (saved paths), Pending prompts, queue UI, session presentation metadata, UI preferences (via **Frontend persistence**). Talks only to Backend via `OpenGuiClient`.                                               | Harness SDK/CLI, session/transcript source of truth, shared queue storage              |
| **Shell**            | Bootstrap Frontend (Desktop / Web / Mobile): window chrome, file picker, sidecar lifecycle, static hosting.                                                                                                                                    | Harness execution, session truth, queue dispatch                                       |

**SDK v1** is in-process only: [`@opengui/runtime`](../packages/runtime/README.md). Target surface: `OpenGUI.create`, `at(directory)`, `SessionHandle` (`send`, `onStream`, `waitUntilIdle`) per [ADR 0007](./adr/0007-runtime-sdk-minimal-surface.md) and [`runtime-sdk-minimal-surface.md`](./plans/runtime-sdk-minimal-surface.md). No queue API in the SDK — use Backend for shared queues ([ADR 0005](./adr/0005-opengui-runtime-backend-split-and-sdk.md)).

**Harness** = coding-agent CLI/runtime (OpenCode, Claude Code, Codex, Pi). **Provider** = model/API vendor inside a Harness. Never call the OpenGUI server process an “agent backend” ([ADR 0001](./adr/0001-harness-terminology.md)).

## Where code lives today

Target layout is in [`plans/runtime-backend-sdk-split.md`](./plans/runtime-backend-sdk-split.md). Current mapping:

| Layer               | Package / entry                  | Main paths                                                                                                                                                                                                                                |
| ------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared wire types   | `@opengui/protocol`              | `packages/protocol/src/` (`HarnessId`, `OpenGuiCapabilities`, `QueueMode`, `SelectedModel`)                                                                                                                                               |
| Runtime             | `@opengui/runtime`               | `packages/runtime/src/` (`host.ts`, `harness-service.ts`, `harness-runtime.ts`, `open-gui.ts`)                                                                                                                                            |
| Harness Adapters    | `packages/runtime/src/adapters/` | `*-bridge.ts`, `harness-adapter-kit.ts`                                                                                                                                                                                                   |
| Runtime descriptors | Shared with Frontend protocol    | `src/agents/` (`backend.ts`, `cli-harness-factory.ts`, `protocol/`)                                                                                                                                                                       |
| Backend             | `@opengui/backend` + thin entry  | `packages/backend/src/` (`createBackendHost`, `host/`, `routes/`, `transport/` — SSE, RPC, FS, static, product API); `server/web-server.ts` (~15 lines, `serve()` only); queue/control services in `server/services/*` until a later pass |
| Frontend            | React app                        | `src/` (`App.tsx`, `components/`, `hooks/`, `features/`, `protocol/`)                                                                                                                                                                     |
| Desktop Shell       | Electron                         | `main.ts`, `preload.ts`, `main/backend-sidecar.ts`                                                                                                                                                                                        |

**Rule:** UI and hooks call **Backend** APIs only, not bridge IPC. Bridges register inside the Backend process via Runtime ([ADR 0005](./adr/0005-opengui-runtime-backend-split-and-sdk.md)).

**Repo map maintenance:** Any PR that moves `server/web-server.ts`, `packages/backend/**`, or Harness bridge modules under `packages/runtime/src/adapters/` must update this section (layer table and paths) in the same PR. CI guard: `pnpm run slop-check` (thin `web-server`, no `lib/harness-adapter-kit`).

**Storage:** [ADR 0004](./adr/0004-storage-source-of-truth-boundaries.md) — Harness owns sessions/transcripts; Backend SQLite owns queues/uploads; Frontend persistence owns Workspaces/Projects/UI.

**Session reads:** [ADR 0006](./adr/0006-harness-only-session-and-transcript-reads.md), plan [`session-read-slop-removal.md`](./plans/session-read-slop-removal.md), manual [`session-read-acceptance.md`](./manual/session-read-acceptance.md).

**Desktop transport:** [ADR 0003](./adr/0003-persistent-desktop-backend-transport.md) — Local Workspace uses private IPC, not loopback HTTP.

Implementation checklists:

- [`plans/runtime-backend-sdk-split.md`](./plans/runtime-backend-sdk-split.md) — packages / SDK (Phases 1–3 largely done).
- [`plans/contributor-experience-and-slop-removal.md`](./plans/contributor-experience-and-slop-removal.md) — docs, session index, naming, registry, guardrails.
- [`plans/session-read-slop-removal.md`](./plans/session-read-slop-removal.md) — ADR 0006 detail.

Optional CI: `node scripts/slop-check.mjs`.

## Harness architecture

Harness-facing modules live in `src/agents/`:

- `backend.ts` defines the normalized Harness interface and event shapes used by the app.
- `index.ts` defines supported Harness IDs and routing helpers.
- `cli-harness-factory.ts` contains shared local-CLI defaults and `createCliHarnessNormalizer()` for local CLI Harnesses.
- `claude-code.ts`, `codex.ts`, and `pi.ts` are small descriptors built from the CLI factory.
- `opencode.ts` declares OpenCode capabilities/workspace shape and delegates SDK event translation to `src/agents/protocol/opencode-map.ts`.
- `id-codec.ts` is the Harness ID-codec seam. `shared.ts` re-exports it and keeps session/message tagging helpers.

When adding or changing a Harness, keep protocol-specific mapping out of UI code. Normalize native events into `HarnessEvent` as close to the adapter as possible, then let the rest of the app consume the normalized event stream.

## Adding a Harness

A **Harness Adapter** is a bridge (`setupXBridge`) plus registry metadata. Start with [`docs/harness-bridge-contract.md`](./harness-bridge-contract.md) and `node scripts/scaffold-harness.mjs <id>`.

1. [`src/agents/harness-registry.ts`](../src/agents/harness-registry.ts) + [`harness-ids.ts`](../src/agents/harness-ids.ts) — id, label, CLI command.
2. [`cli-harness-factory.ts`](../src/agents/cli-harness-factory.ts) — `HARNESS_BACKEND_META`, `normalizeEvent`.
3. [`harness-bridge-registrations.ts`](../packages/runtime/src/harness-bridge-registrations.ts) — register bridge in `BRIDGE_SETUP_BY_HARNESS_ID`.
4. New `*-bridge.ts` under `packages/runtime/src/adapters/`.
5. [`server/harness-inventory.ts`](../server/harness-inventory.ts) — uses registry CLI map.
6. [`session-identity.ts`](../src/lib/session-identity.ts) — parse legacy ids only; new ids via `composeFrontendSessionId`.

Descriptors in `src/agents/<harness>.ts`: use `makeLocalCliCapabilities()` and `createCliHarnessNormalizer()` for tagged CLI streams; custom SDK events go in `src/agents/protocol/` with tests. Session IDs: `composeFrontendSessionId` / codecs in `src/agents/shared.ts`, not ad-hoc strings.

## Frontend feature slices

The current frontend is still centered on `src/App.tsx`, but several orchestration concerns have been moved into `src/features/`:

- `features/app-shell/useAppKeyboardShortcuts.ts` owns app-level keyboard shortcut orchestration.
- `features/session/useActiveSessionQueue.ts` owns active-session queue UI handlers.
- `features/session/useChatSessionSurface.ts` derives the active chat surface state.
- `features/worktree/useActiveWorktreeMerge.ts` owns active worktree merge and pull-request actions.
- `features/local-intent/` owns **Local intent orchestration** (Pending prompt → Agent send, Queued prompt dispatch from PromptBox). `HarnessProvider` (`use-agent-impl-core.tsx`) wires React state and delegates `sendPrompt` / `sendCommand` / queue side effects through `useLocalIntentOrchestration`.
- `features/agent-bootstrap/` — workspace persistence load + post-ready project/server bootstrap.
- `features/agent-resources/` — `loadServerResources` / resource catalog dedupe (`useAgentResourceCatalog`).

New UI orchestration should follow this direction: keep reusable visual pieces in `src/components/`, keep cross-component state orchestration in a named `src/features/<area>/` hook, and keep pure domain utilities in `src/lib/`.

## Shared UI primitives

Reusable UI building blocks live in `src/components/ui/`. Recent dialog work uses:

- `DialogShell` for common dialog layout and footer/body structure.
- `DialogHeader` for consistent dialog titles, descriptions, and icons.
- `ButtonGroup`, `FormField`, and `ToggleSwitch` for repeated form/action patterns.

Prefer these primitives before adding another one-off dialog header, footer, button group, or toggle implementation.

## Provider icons

Provider icons are resolved by `src/components/provider-icons/ProviderIcon.tsx` and `types.ts`. Vite expands the SVG asset manifest from `src/components/provider-icons/svgs/*.svg` with `import.meta.glob`, so adding an icon should only require dropping in a correctly named SVG unless new fallback or alias behavior is needed.

## Commands

Vite+ (`vp`) is a dev dependency. After `pnpm install`, use **`pnpm vp …`** or **`pnpm run <script>`** for tasks; a global `vp` on `PATH` is optional.

```bash
pnpm install        # install dependencies
pnpm run dev        # desktop dev; use dev:web for browser (append :web)
pnpm run start      # desktop prod; use start:web for browser (append :web)
pnpm vp check       # lint, format, and type checks
pnpm vp lint        # lint only
pnpm vp fmt         # format only
pnpm vp test        # tests
pnpm run build      # production build
pnpm vp run <task>  # named project tasks such as dist:linux
pnpm add <pkg>      # dependency changes
pnpm remove <pkg>   # dependency changes
```

Do not run `tsc` directly for typechecking.
