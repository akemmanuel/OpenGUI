# Bridge test matrix

Regression targets for harness adapters under `packages/runtime/src/adapters/`.

| Issue                             | Harness     | Automated test                                                               |
| --------------------------------- | ----------- | ---------------------------------------------------------------------------- |
| #130 duplicate reasoning          | Pi          | `src/pi-bridge-mapping.test.ts` — `syncAssistantParts` single reasoning part |
| #130 duplicate reasoning          | Codex       | `src/codex-bridge-mapping.test.ts` — one reasoning part per thread item      |
| #130 duplicate reasoning          | Claude Code | `src/claude-code-bridge-mapping.test.ts` — `makeReasoningPart` index ids     |
| #128 Session connection not found | OpenCode    | `src/opencode-bridge-mapping.test.ts` — `getConnectionForSession` routing    |
| #131 Pi Action fail               | Pi          | `src/pi-bridge-abort.test.ts` + extend with action RPC when fixture exists   |

## Layout

- **Pure mapping:** `packages/runtime/src/adapters/*-bridge-mapping.ts` + `src/*-bridge-mapping.test.ts`
- **Shared kit:** `packages/runtime/src/adapters/harness-adapter-kit.ts` + `packages/runtime/src/adapters/__tests__/harness-adapter-kit.test.ts`
- **Manager behavior:** `src/pi-bridge-abort.test.ts` (Pi `PiBridgeManager`)

## CI

```bash
pnpm run test:bridges
```

Runs adapter unit tests only (no live Pi/Codex daemons).

## Wiring status

| Harness     | Bridge imports mapping module           |
| ----------- | --------------------------------------- |
| Pi          | Yes                                     |
| OpenCode    | Partial (event parse + session routing) |
| Codex       | Yes (thread read + live item normalize) |
| Claude Code | Yes (session + reasoning/tool helpers)  |
| Grok Build  | Yes (live message bundles)              |

## Rule

New event → transcript mapping: add or extend a fixture test in `src/*-bridge-mapping.test.ts` before merge.
