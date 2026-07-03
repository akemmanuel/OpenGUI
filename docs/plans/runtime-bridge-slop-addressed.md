# Runtime bridge slop — addressed (2026-07)

Checklist from harness/SDK hot-path review. **Automated:** `pnpm run slop-check` (bridge tests, ingress, ts-nocheck policy).

## Bugs fixed

| Issue                                           | Fix                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Double streaming (`onStream` + `waitUntilIdle`) | Single harness subscription + `wait-until-idle.ts`                                   |
| Pi tool calls on wrong assistant bundle         | Time-based `pairPendingAssistantsWithCanonical`; `findCurrentAssistantBundleInCache` |
| `Pi operation requires a Project directory`     | `resolvePiProjectForSession` uses `sessionIndex` before single-project fallback      |
| OpenCode overlapping SSE on reconnect           | `abortOpenCodeSseBeforeRestart` before `_startSSE`                                   |

## Structural slop

| Area                                           | Change                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `getListProject` / `ensureProject` boilerplate | `pi-project-slot.ts` (`createEmptyPiProjectShell`, `resolvePiProjectKeyFromTarget`)                          |
| `handleSessionEvent` switch                    | `pi-bridge-session-events.ts` (assistant start, tool start; more can move incrementally)                     |
| Transcript delta merging                       | `transcript-part-delta.ts` + tests                                                                           |
| Event ingress chain                            | `harnessEventsToLiveSessionEvents()` — compat → bus → normalizer at one API                                  |
| `// @ts-nocheck`                               | **Removed** repo-wide; `slop-check` bans `@ts-nocheck` and explicit `any` in `packages/runtime/src/adapters` |

## Tests (required by slop-check)

- `session-handle.test.ts`, `wait-until-idle.test.ts`
- `pi-bridge-live-resolution.test.ts`, `pi-bridge-session-events.test.ts`, `pi-project-slot.test.ts`
- `opencode-sse-lifecycle.test.ts`
- `transcript-part-delta.test.ts`, `harness-events-to-live.test.ts`
- Existing `session-transcript-projection.test.ts` (delta edge cases)

## Still large (Track 6)

- `opencode-bridge.ts` — window-scoped setup; IPC factories already DRY inside setup; full `opencode-bridge-ipc.ts` extract pending.
- Bridge monoliths still need method-level typing (`unknown` + narrowing); no `any`.

## Phase E IPC (2026-07)

- Pi + Claude RPC tables → `pi-bridge-ipc.ts`, `claude-code-bridge-ipc.ts`.
- Codex/Grok project slots → `harness-bridge-project-slot.ts`.
- See [bridge-ipc-dedup-phase-e.md](./bridge-ipc-dedup-phase-e.md).
