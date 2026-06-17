# Harness bridge IPC contract

Contributors adding a **Harness Adapter** (`packages/runtime/src/adapters/*-bridge.ts`) should match this contract. Domain terms: [CONTEXT.md](../CONTEXT.md). Registry: [`src/agents/harness-registry.ts`](../src/agents/harness-registry.ts).

## Registration

1. Add a row to `HARNESS_REGISTRY` and `HARNESS_ID_VALUES` in [`harness-ids.ts`](../src/agents/harness-ids.ts) / registry.
2. Add `HARNESS_BACKEND_META` in [`cli-harness-factory.ts`](../src/agents/cli-harness-factory.ts).
3. Add bridge under [`packages/runtime/src/adapters/`](../packages/runtime/src/adapters/) and add `BRIDGE_SETUP_BY_HARNESS_ID` in [`harness-bridge-registrations.ts`](../packages/runtime/src/harness-bridge-registrations.ts) (`registerHarnessAdapters` loops managed ids).
4. CLI probe uses `CLI_COMMAND_BY_HARNESS` via [`server/harness-inventory.ts`](../server/harness-inventory.ts).

Optional: `node scripts/scaffold-harness.mjs <id>` prints the checklist.

Run `pnpm run slop-check` and harness registry / bridge registration tests after changes.

## IPC channel names

Runtime [`HarnessService`](../packages/runtime/src/harness-service.ts) calls `${harnessId}:${suffix}`.

Common suffixes: `project:add`, `project:remove`, `session:list`, `session:create`, `session:delete`, `session:update`, `messages`, `prompt`, `abort`, `command:send`, `permission`, `providers`, `agents`, `commands`.

Return shape from [`lib/harness-adapter-kit.ts`](../lib/harness-adapter-kit.ts): `{ success: true, data }` or `{ success: false, error }`.

## Events

Broadcast on `${harnessId}:bridge-event`. Normalize via `HARNESS_BACKEND_META[id].normalizeEvent`.

## Session identity

Use `composeFrontendSessionId(harnessId, rawId)`. Tag sessions with `_harnessId`, `_rawId`, directory.

## Scope: `directory` first, `workspaceId` optional

**Product execution scope** is `directory` + `harnessId` + session id ([ADR 0005](../adr/0005-opengui-runtime-backend-split-and-sdk.md), [CONTEXT.md](../../CONTEXT.md) **Harness Scope**). HTTP and `OpenGuiClient` must not require `workspaceId` to run an Agent send or list sessions.

**`workspaceId` on bridge IPC** is optional metadata for:

- Frontend **Workspace** routing (e.g. remote OpenGUI Backend auth / Codex app-server workspace)
- Adapter-internal project maps (`makeHarnessProjectKey(workspaceId, directory)`)

Do not treat `workspaceId` as a backend domain id or session list filter on its own. Prefer `directory` on every new handler signature; pass `workspaceId` only when an adapter already needs it for remote workspace separation.
