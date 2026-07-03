# Phase E: Bridge IPC dedup — outcomes

**Status:** In progress (2026-07-03).  
**Contract:** [harness-bridge-contract.md](../harness-bridge-contract.md).

## Baseline vs current (monolith `*-bridge.ts`)

| File                  | Before | After (partial)                         |
| --------------------- | ------ | --------------------------------------- |
| pi-bridge.ts          | ~2948  | ~2817                                   |
| claude-code-bridge.ts | ~1818  | ~1667                                   |
| codex-bridge.ts       | ~2071  | ~2065                                   |
| grok-build-bridge.ts  | ~865   | ~860                                    |
| opencode-bridge.ts    | ~2438  | unchanged (window-scoped IPC factories) |
| **Total monoliths**   | ~10140 | ~10047                                  |

## New modules

| Module                           | Role                                                  |
| -------------------------------- | ----------------------------------------------------- |
| `pi-bridge-ipc.ts`               | Pi harness RPC table (`registerPiHarnessRpcHandlers`) |
| `claude-code-bridge-ipc.ts`      | Claude RPC + permission/fork                          |
| `harness-bridge-ipc-coerce.ts`   | Shared IPC string coercion                            |
| `harness-bridge-project-slot.ts` | `ensureHarnessProjectSlot` for Codex/Grok             |

## Checklist

### E — IPC dedup

- [x] **E-S3** `pnpm run test:bridges` green (after project-slot test fix)
- [x] **E-S4** `pnpm run slop-check` green
- [x] Pi + Claude setup tables extracted to `*-bridge-ipc.ts`
- [x] Codex/Grok use shared project slot helper
- [ ] **E-S1** Monolith total ≤ 6500 (stretch; requires OpenCode + manager extractions)
- [ ] **E-S2** Zero inline `registerHarnessRpcHandlers` tables in monoliths (Pi/Claude done)
- [ ] OpenCode `opencode-bridge-ipc.ts` extract (deferred — closure-heavy)

### T — Abort tests

- [x] **T-S1** `packages/runtime/src/adapters/__tests__/pi-bridge-abort.test.ts`
- [x] **T-S2** `registerPiBridgeProjectForTests` (no private Map poke)
- [x] **T-S4** Streaming replacement in `pi-bridge-session-events.test.ts`
- [x] **bridge-test-matrix.md** updated

### M — ModelSelector

- [x] **M-S1** `ModelSelector.tsx` ≤ 350 LOC (306)
- [x] **M-S2** Catalog via `ensureHarnessResourceCatalog`
- [x] **M-S3** `ModelSelector.catalog.test.tsx` (cache dedupe)

## Verification

```bash
pnpm run slop-check
pnpm run test:bridges
pnpm vp test src/components/ModelSelector.catalog.test.tsx
pnpm vp check
```

## Next PRs

1. OpenCode IPC module (mechanical extract of handler registrations only).
2. Incremental manager slim-down per [bridge-lint-cleanup-workflows.md](../bridge-lint-cleanup-workflows.md).
3. Optional: extend `slop-check` to require `*-bridge-ipc.ts` when setup exceeds N lines.
