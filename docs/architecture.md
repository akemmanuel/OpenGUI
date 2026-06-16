# OpenGUI architecture notes

This document is the contributor-facing map of the codebase as it exists today. For product terminology and ownership rules, read [`CONTEXT.md`](../CONTEXT.md). For accepted decisions, read [`docs/adr/`](./adr/).

## Layers

OpenGUI keeps three layers separate:

- **OpenGUI Backend** owns Harness adapters, sessions/events, filesystem/git operations, queues, and backend persistence.
- **OpenGUI Frontend** is the React presentation layer. It owns Workspaces, Projects, pending prompts, presentation metadata, and UI preferences.
- **Shells** bootstrap the Frontend for Desktop, Web, and Mobile. Shell code should not own Harness execution or session truth.

Use the project term **Harness** for coding-agent runtimes such as OpenCode, Claude Code, Codex, and Pi. Use **provider** only for model/API providers inside those Harnesses.

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

1. Add the Harness ID/type information in `src/agents/index.ts` and any backend/runtime routing owned by the implementation slice.
2. Define capabilities and workspace requirements in `src/agents/<harness>.ts`.
   - If it is a tagged local CLI event stream, prefer `makeLocalCliCapabilities()`, `LOCAL_CLI_WORKSPACE`, and `createCliHarnessNormalizer()` from `cli-harness-factory.ts`.
   - If it has custom SDK events, add a protocol mapper under `src/agents/protocol/` and test the mapper directly.
3. Use `createBackendIdCodec()`/shared tagging helpers instead of composing session IDs by hand.
4. Add tests for the normalizer or protocol mapper before wiring the Harness into UI selection.

## Frontend feature slices

The current frontend is still centered on `src/App.tsx`, but several orchestration concerns have been moved into `src/features/`:

- `features/app-shell/useAppKeyboardShortcuts.ts` owns app-level keyboard shortcut orchestration.
- `features/session/useActiveSessionQueue.ts` owns active-session queue UI handlers.
- `features/session/useChatSessionSurface.ts` derives the active chat surface state.
- `features/worktree/useActiveWorktreeMerge.ts` owns active worktree merge and pull-request actions.

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

Use Vite+ (`vp`) for project tasks and pnpm for dependency changes:

```bash
pnpm install        # install dependencies
pnpm run dev        # desktop development (Electron)
pnpm run dev:web    # web development (browser)
vp check            # lint, format, and type checks
vp lint             # lint only
vp fmt              # format only
vp test             # tests
vp build            # production build
vp run <task>       # named project tasks such as dist:linux
pnpm add <pkg>      # dependency changes
pnpm remove <pkg>   # dependency changes
```

Do not run `tsc` directly for typechecking.
