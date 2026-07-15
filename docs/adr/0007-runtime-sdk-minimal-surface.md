# Minimal `@opengui/runtime` SDK surface

[ADR 0005](./0005-opengui-runtime-backend-split-and-sdk.md) established **`@opengui/runtime`** as the in-process SDK but left the integrator API as a thin wrapper around `HarnessHandle` (`directory` on every call, harness-global events, `SESSION_BUSY` without wait helpers). Pi's SDK (`createAgentSession`, `subscribe`, `waitForIdle`) shows what embedders expect; CONTEXT and ADRs 0004/0006 define what OpenGUI must **not** duplicate (queues, Workspace scope, backend session/transcript caches). We need an explicit **minimal public surface** so the package stays small and publishable while remaining powerful across Harnesses.

## Status

superseded by ADR-0010

## Decision

- **Positioning:** `@opengui/runtime` is a **thin multi-harness shell** around **Harness Scope** (`directory` + `harnessId` + session id), **Harness-only reads** (list + message pages), and **Harness Inventory** diagnostics—not a re-export of `@earendil-works/pi-coding-agent` and not a second Pi platform (extensions, skills, ResourceLoader, RPC mode).
- **Steal from Pi (ergonomics only):** session-first workflow (`open` / `create` → `send` → `subscribe` for streaming → `waitUntilIdle`); `send()` resolves when the accepted agent run finishes; a **small** streaming event union (`AgentStreamEvent`, not full Pi `AgentSessionEvent`); optional **`runAgent()`** one-shot for scripts/CI.
- **Steal from CONTEXT (contracts):** no `workspaceId` on SDK types; **Project** is integrator's `directory` path only; list and transcript reads **fail** on harness errors—no empty success ([ADR 0006](./0006-harness-only-session-and-transcript-reads.md)); readiness via **Harness Inventory** shape (`diagnose()`), not invented model lists.
- **Do not put in v1 SDK:** Backend **queue** API ([ADR 0005](./0005-opengui-runtime-backend-split-and-sdk.md)); Pi **steer** / **followUp** / `queue_update` as **core** contract (session-local queue is harness-specific; shared queue stays Backend); primary export of **`HarnessEvent`** / `message.part.updated` (Frontend UI transport—map internally from bridges); public `AuthStorage` / `ModelRegistry` / `Agent.state`; lazy-load flag **`harnesses: HarnessId[]`** is required for lightweight cold start once implemented.
- **Target entry surface (names may adjust):** `OpenGUI.create` (alias `createOpenGUI`), `og.at(directory)`, `harness(id).sessions` (`list` | `create` | `open`), **`SessionHandle`** (`send`, `abort`, `messages`, `onStream`, `waitUntilIdle`, `close`), `resources()` / `diagnose()`, `runAgent()`, `OpenGuiError` + small shared types. **`SessionRuntime`** (`newSession`, `fork`, `switch`) only behind **`capabilities`** (e.g. `fork`, `compact`), not on every harness.
- **Pi-only depth:** document **`@earendil-works/pi-coding-agent`** for integrators who need extensions, tree navigation, or Pi RPC/JSON modes; OpenGUI SDK does not bundle or re-export that package in v1.
- **Publishing:** published tarball must expose **compiled `dist/` + `.d.ts`** with **no** imports from repo `src/` or `server/` paths; shared wire types may move to `@opengui/protocol` later without expanding the default export count.

## Considered Options

- **Re-export Pi SDK as `@opengui/runtime/pi`:** rejected—doubles dependency weight and blurs "one multi-harness SDK" story.
- **Full Pi `AgentSessionEvent` as public type:** rejected—large, Pi-shaped; normalization cost across four harnesses.
- **SDK queue parity (steer/followUp for all harnesses):** rejected—conflicts ADR 0005; Backend owns shared **Queued prompts** per CONTEXT.
- **Keep `HarnessHandle.prompt({ directory, … })` as the only API:** rejected—repetitive and unlike proven embed patterns; keep as deprecated shim during migration.
- **Expose `HarnessEvent` to integrators:** rejected—optimized for React message list, not minimal embeds.

## Consequences

- Implementation plan: [`docs/plans/runtime-sdk-minimal-surface.md`](../plans/runtime-sdk-minimal-surface.md).
- [`packages/runtime/README.md`](../../packages/runtime/README.md) and examples align with **SessionHandle** flow; Pi quickstart updated to **create + send + stream**, not list-only.
- Bridge work stays internal: Pi (and others) may still use Pi SDK inside adapters; SDK consumers see **`AgentStreamEvent`** mapping only.
- Tests: harness-only read semantics for SDK `list`/`messages`; `SESSION_BUSY` + `waitUntilIdle` / `send({ whileBusy: "wait" })` where implemented.
- [`runtime-backend-sdk-split.md`](../plans/runtime-backend-sdk-split.md) Phase 3 "lightweight SDK" goal is satisfied by this ADR's surface, not by the current `HarnessHandle`-only sketch alone.
- Future **`@opengui/client`** should mirror **method names** (`at`, `sessions.open`, `send`) over HTTP where Backend exposes the same Harness Scope—not queue helpers in the runtime package.

## References

- [ADR 0004](./0004-storage-source-of-truth-boundaries.md) — Harness owns sessions/transcripts
- [ADR 0005](./0005-opengui-runtime-backend-split-and-sdk.md) — Runtime vs Backend; no SDK queue
- [ADR 0006](./0006-harness-only-session-and-transcript-reads.md) — strict reads
- [CONTEXT.md](../../CONTEXT.md) — Harness Scope, Inventory, Session list/message reads
- Pi SDK: `earendil-works/pi` `packages/coding-agent/docs/sdk.md` (ergonomics reference only)
