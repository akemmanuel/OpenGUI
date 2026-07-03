# Harness bridge TypeScript lint cleanup — workflows

**Source:** Pi workflow `bridge_lint_cleanup_workflows` (run `mr46we1f-4074lc`, verdict `plans_ready`).

**Goal:** `pnpm vp lint` → **0** errors on each `packages/runtime/src/adapters/*-bridge.ts`, with `pnpm run slop-check`, `test:runtime`, and `test:bridges` green.

## Hard rules

| Rule | Why |
|------|-----|
| No `any` | Slop-check + user policy; use `unknown` + narrowing |
| No `@ts-nocheck` | Enforced in `packages/runtime` and `lib` |
| No bulk `: unknown` on every param | Reverted on monoliths (~3.3k errors) |
| Prefer mapping / types / session-events modules | `grok-build-bridge.ts` is the reference (0 errors) |
| Measure with `pnpm vp lint` | Not `tsc` |

## Current baseline (re-check before each run)

```bash
for f in grok-build-bridge pi-bridge codex-bridge claude-code-bridge opencode-bridge; do
  echo -n "$f: "
  pnpm vp lint 2>&1 | rg "adapters/${f}\.ts.*error typescript" | wc -l
done
```

| Bridge | ~Errors | Dominant codes |
|--------|---------|----------------|
| grok-build | 0 | hygiene only (`no-base-to-string` on ACP coercion) |
| codex | 120 | TS2339, TS2345 |
| claude-code | 168 | TS7006, TS2339, TS2345 |
| pi | 263 | TS18048, TS2345, TS2322 |
| opencode | 414 | TS7006, TS2571, TS2339 |

## Execution order

1. **grok-build** — lock reference patterns (`asHarnessString`, mapping split)
2. **codex** — mapping dedupe + provider/RPC + live handlers (~120 → 0)
3. **claude-code** — SDK options, typed Maps, history extract
4. **pi** — transcript guards, SDK boundary cast, session-events, RPC
5. **opencode** — `OpenCodeSdkClient` facade + IPC factories (largest)

Run **one bridge per workflow invocation**; batches inside a workflow are **sequential**.

## Saved Pi workflows

Runnable scripts live in [`.pi/workflows/bridge-lint/`](../.pi/workflows/bridge-lint/README.md). Invoke via Pi `workflow` tool (paste script) or saved name once registered.

| `meta.name` | File | Target |
|-------------|------|--------|
| `grok_build_lint_hygiene` | `grok_build_lint_hygiene.js` | 0 errors + clear coercion warnings |
| `codex_bridge_mapping_first` | `codex_bridge_mapping_first.js` | codex → 0 |
| `claude_code_types_history` | `claude_code_types_history.js` | claude → 0 |
| `pi_bridge_boundary_layers` | `pi_bridge_boundary_layers.js` | pi → 0 |
| `opencode_client_facade` | `opencode_client_facade.js` | opencode → 0 |

## Done criteria

- `pnpm vp lint 2>&1 | rg 'adapters/.*-bridge\.ts.*error' | wc -l` → **0**
- `pnpm run slop-check` → exit 0
- `pnpm run test:runtime` and `pnpm run test:bridges` pass
- Logic stays in `*-bridge-mapping.ts` (and planned extracts: `pi-bridge-rpc`, `claude-code-bridge-history`, `opencode-bridge-git`, etc.)

## Risks & mitigations

1. **Bulk `:unknown` on RPC params** → named input types + narrow once at IPC boundary
2. **Parallel edits on one monolith** → one bridge active per run; verify after each batch
3. **Mid-migration extract** → mapping batch first; re-export; then move chunks
4. **Slop-check regression** → run after every batch
5. **SDK type drift** → alias in `*-bridge-types.ts`; single cast site

## Per-bridge batch summaries

### codex (`codex_bridge_mapping_first`)

1. mapping-types-and-dedupe — export `CodexMessageBundle`, dedupe helpers from mapping
2. provider-and-app-server-rpc — provider cache, thread guards
3. tool-parts-and-mcp-guards — `CodexToolPart`, `mcpContentToText`
4. manager-session-and-index — `WindowLike`, transcript guards
5. live-handlers-and-prompt-inputs — assistant/tool handlers
6. run-app-server-turn-and-setup — notifications, `setupCodexBridge` types

### claude (`claude_code_types_history`)

1. `makeClaudeQueryOptions` + `ClaudeAgentOptions`
2. `claude-code-bridge-types.ts` Maps + `resolveTarget` arity
3. `claude-code-bridge-history.ts` extract + mapping dedupe
4. `ClaudeLiveQueryState` + permission handler
5. public API signatures
6. `setupClaudeCodeBridge` IPC guards

### pi (`pi_bridge_boundary_layers`)

1. transcript branch narrowing in mapping
2. `getLiveState` / `getSessionCache` non-null patterns
3. `createRuntime` single `SessionManager` cast
4. `pi-bridge-session-events.ts` typed host
5. OAuth + provider narrow
6. `pi-bridge-rpc.ts` IPC parse helpers

### opencode (`opencode_client_facade`)

1. local server `Promise` types + health JSON guards
2. mapping helpers + `OpenCodeHttpError`
3. `_client: ReturnType<typeof createOpencodeClient>` + `_requireClient()`
4. connection method signatures + prompt parts union
5. `OpenCodeWindowState` + setup types
6. IPC handler factories
7. registration lambdas
8. optional `opencode-bridge-git.ts`

Full edit lists: `~/.pi/workflows/projects/opengui-*/runs/mr46we1f-4074lc.json` journal entries.