# Plan: Minimal `@opengui/runtime` SDK surface

**ADR:** [0007](../adr/0007-runtime-sdk-minimal-surface.md)  
**Depends on:** [runtime-backend-sdk-split.md](./runtime-backend-sdk-split.md) (Phases 0–3 baseline), [ADR 0005](../adr/0005-opengui-runtime-backend-split-and-sdk.md), [ADR 0006](../adr/0006-harness-only-session-and-transcript-reads.md)  
**Glossary:** [CONTEXT.md](../../CONTEXT.md)

## Goal

Ship a **small, publishable** `@opengui/runtime` that feels like Pi's session loop (send, stream, wait) while enforcing OpenGUI's **Harness Scope** and **Harness-only truth**—without Pi extensions, Backend queues, or Frontend `HarnessEvent` on the public API.

## Success criteria

| Criterion              | Check                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| Integrator hello-world | `create` → `at(dir)` → `harness` → `sessions.create/open` → `send` + `onStream` in <30 lines |
| Read honesty           | `list` / `messages` propagate harness errors; no fake `[]` on failure                        |
| Size discipline        | Default export ≤ ~15 symbols; lazy `harnesses: []` skips unused adapter init                 |
| Docs                   | Example ladder (4 scripts); "Pi-only?" points to `@earendil-works/pi-coding-agent`           |
| App unchanged          | OpenGUI Frontend still uses Backend + `HarnessEvent`; SDK path is additive                   |

## Non-goals (this plan)

- `@opengui/client` (remote Backend)
- SDK queue / steer / followUp as cross-harness API
- Re-export Pi coding-agent
- Full typed transcript across all harnesses (v1.1)
- Moving bridges out of monorepo (separate publish pipeline is Phase E)

---

## Phase A — Scope ergonomics (no behavior change)

**Outcome:** Stop repeating `directory` on every call; same `HarnessService` underneath.

- [x] Add `DirectoryHandle` with canonical `path` from `resolveSafeDirectory`.
- [x] `og.at(directoryInput)` → `DirectoryHandle`; `directory.connect({ harnesses? })` wraps `registerDirectory`.
- [x] `directory.harness(id)` returns `HarnessHandle` bound to directory (`directoryPath`, optional `directory` on methods).
- [x] Deprecation note on bare `og.harness(id)` without `at()`—keep working via `allowedRoots`.
- [x] Tests: `at()` rejects out-of-root; connect idempotent (`src/open-gui-sdk.test.ts`).

**Files (likely):** `packages/runtime/src/open-gui.ts`, `packages/runtime/src/directory-handle.ts` (new), `src/open-gui-sdk.test.ts`.

---

## Phase B — `SessionHandle` (expose existing `HarnessService`)

**Outcome:** Create/open session without fake `RuntimeSessionRef` structs in integrator code.

- [x] `HarnessScope.sessions`: `list()`, `create({ title? })`, `open(id: string)` (opaque id from list/create).
- [x] `SessionHandle`: `send(text, opts?)`, `abort()`, `messages({ limit?, before? })`, `close()`.
- [x] `send` delegates to `promptSession`; `open` accepts harness-listed id (parse internally).
- [x] `create` wires `HarnessService.createSession`.
- [x] Errors: `BRIDGE_ERROR` on harness RPC failures; existing `SESSION_BUSY` / `HARNESS_MISMATCH`.
- [x] Tests: `src/open-gui-sdk.test.ts` (create, open, `sessionIdFromCreateResult`).

**Files:** `packages/runtime/src/session-handle.ts` (new), `open-gui.ts`, `harness-service.ts` (unchanged RPC).

---

## Phase C — Streaming + wait (Pi ergonomics, small types)

**Outcome:** Embedders get `text.delta` without subscribing to full `HarnessEvent`.

- [x] Define `AgentStreamEvent` union (~8 variants): `run.start` / `run.end`, `text.delta`, `thinking.delta`, `tool.start` / `tool.end`, optional `error`.
- [x] `SessionHandle.onStream(handler)` — filter harness-global events to **this session** (today: per-handle emitter + session id filter).
- [x] Pi: map from bridge path or existing normalized events where possible; document harness gaps in README matrix.
- [x] `SessionHandle.waitUntilIdle({ timeoutMs? })` — status map + `run.end` / idle (no pi-agent-core export).
- [x] `send(opts?: { whileBusy?: "fail" | "wait"; waitTimeoutMs? })` — default `fail` (ADR 0005); `wait` uses `waitUntilIdle` then retry once.
- [x] Do **not** add steer/followUp in this phase.

**Files:** `packages/runtime/src/agent-stream.ts` (new), `open-gui.ts` (`HarnessHandleImpl` ingest), tests.

---

## Phase D — Diagnostics + script mode

**Outcome:** CONTEXT-aligned readiness + CI one-liner.

- [x] `og.diagnose()` → `{ ok, harnesses: [{ harnessId, cliOnPath, ready, hint? }] }` from `getHarnessInventories()` + registry labels.
- [x] `runAgent(og, { directory, harness, message, onStream? })` → `RunAgentResult` (`sessionId`, `assistantText?`, `reason`).
- [x] `scripts/runtime/run-agent.mjs` + existing probe ladder (list, inventories, messages, …).
- [x] Update `packages/runtime/README.md` with diagnose + runAgent; quickstart uses create + send + `onEvent` (canonical live stream).

**Files:** `packages/runtime/src/run-agent.ts` (new), README, `scripts/runtime/`.

---

## Phase E — Lightweight boot + publish boundary

**Outcome:** Cold start and external consumers.

- [x] Implement `createOpenGUI({ harnesses?: HarnessId[] })` — register only listed adapters ([contributor plan](./contributor-experience-and-slop-removal.md) Track 6 item).
- [ ] Extract minimal types to `packages/protocol` or `runtime/src/protocol/` (HarnessId, `SessionSummary`, `AgentStreamEvent`, errors)—no `App.tsx` imports.
- [ ] `package.json` `exports` → `dist/index.js` + types; build step in `vp build` or `packages/runtime` script.
- [ ] `private: false` + publish checklist (when ready)—out of scope until dist clean.

**Files:** `host.ts`, `harness-bridge-registrations.ts`, `packages/runtime/package.json`, `tsconfig`/`vite` lib build.

---

## Phase F — Capabilities + runtime (optional v1.1)

**Outcome:** Fork/compact only where registry says yes.

- [ ] `harness.capabilities` from `HARNESS_BACKEND_META` (single re-export path in runtime package).
- [ ] `SessionRuntime` on harness when `capabilities.fork`: `newSession`, `fork(messageId?)`, guarded methods.
- [ ] Typed `Transcript` for Pi + OpenCode first; others `unknown` + doc.

---

## Doc / index updates

- [x] ADR [0007](../adr/0007-runtime-sdk-minimal-surface.md)
- [x] [`docs/adr/README.md`](../adr/README.md) — row for 0007
- [x] [`runtime-backend-sdk-split.md`](./runtime-backend-sdk-split.md) — link Phase 3 follow-up to this plan
- [x] [`contributor-experience-and-slop-removal.md`](./contributor-experience-and-slop-removal.md) — SDK track points to 0007 + this plan
- [x] [`docs/architecture.md`](../architecture.md) — SDK bullet: minimal surface per 0007

---

## Order of work

```text
A (at/connect) → B (SessionHandle) → C (stream/wait) → D (diagnose/runAgent)
     ↓ parallel where safe
E (lazy harness + dist) after B/C stable
F when harness contributors need fork in SDK
```

**Suggested PR slices:** A alone → B → C → D → E.

---

## Risk notes

| Risk                                          | Mitigation                                                          |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `AgentStreamEvent` incomplete on codex/claude | Document per-harness matrix; stream may be no-op until mapped       |
| Dual API (`HarnessHandle` vs `SessionHandle`) | Deprecate `prompt({ directory })` in README; keep one release cycle |
| Publish still imports `../../../src`          | Phase E gate: `rg` CI check on published file list                  |
| `wait` on send blurs "no queue"               | ADR 0007: single-session poll only; document vs Backend queue       |

---

## Acceptance test (manual)

From repo root, after Phase D:

```bash
pnpm run runtime:example:minimal   # hypothetical script
# or vp node packages/runtime/examples/03-create-send-stream.mjs
```

Expect: streamed text, clean `og.close()`, no HTTP, no prompts queued in SQLite.
