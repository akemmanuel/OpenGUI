# Frontend composition boundary and ~30% net LoC reduction

OpenGUI’s Frontend still concentrates most product orchestration in `src/hooks/use-agent-impl-core.tsx` (~2.5k lines) and a monolithic `agent-reducer.ts` (~1.3k lines), while transcript correctness has largely moved to `src/features/session-transcript/` per [ADR 0008](./0008-session-transcript-projection-in-runtime.md). Harness bridges under `packages/runtime/src/adapters/` (~10.7k lines across five files) repeat IPC and project/session scaffolding. These are **structural slop** (shadow architecture and shallow module splits), distinct from the **forbidden-pattern slop** already guarded by `scripts/slop-check.mjs` and [contributor-experience-and-slop-removal.md](../plans/contributor-experience-and-slop-removal.md).

A baseline inventory (2026-06-29, non-test `src/` + `server/` + `packages/` + `lib/` + `main/`) is ~**71k** lines. A **30% net reduction** target is ~**21k** lines deleted (file moves and renames do not count).

## Status

accepted

## Decision

1. **Primary reduction strategy** is **composition over colocation**: shrink `HarnessProvider` to wiring-only (&lt;600 lines) by finishing `src/features/*` facades (`agent-bootstrap`, `agent-resources`, `agent-projects`, `agent-workspaces`, `agent-provider-shell`) and **deleting** duplicate effects, noop hook APIs, and redundant glue in `src/hooks/agent-*` once call sites move. Master checklist: [`docs/plans/thirty-percent-loc-reduction.md`](../plans/thirty-percent-loc-reduction.md).

2. **Reducer diet**: split or slim `agent-reducer.ts` so it owns **session activity**, workspace/project **chrome**, and queue/interaction state only — not transcript merge, not resource-catalog loading, not lifecycle orchestration that belongs in feature hooks. Transcript remains in `features/session-transcript` and Runtime projection per ADR 0008.

3. **Live-event unification** ([`live-session-event-unification.md`](../plans/live-session-event-unification.md)) is a **separate PR series** from provider split. Frontend must converge on **one** live projection path (no parallel `LiveSessionProjection` maps in hooks + store). Product paths consume canonical `LiveSessionEvent` / projected transcript from Backend, not harness-native `message.part.*` shapes.

4. **Bridge IPC deduplication** (shared router / base session memory in `harness-adapter-kit`) is **optional for correctness** but **required to reach ~21k net delete** without cutting product behavior. Order: after provider split and live-event tranche are stable.

5. **Explicit non-goals** for this ADR:
   - Deleting tests or `components/ui/*` shadcn bulk to hit a number.
   - Removing `BetterSDK` TypeScript used by `claude-code-bridge`.
   - Re-opening harness-only session reads or Backend shadow indexes ([ADR 0006](./0006-harness-only-session-and-transcript-reads.md)).
   - Persisting transcript projection in SQLite ([ADR 0004](./0004-storage-source-of-truth-boundaries.md)).

6. **Verification bar** for every tranche: `pnpm vp check`, `pnpm vp test`, `pnpm run slop-check`, and manual Desktop Local Workspace (add project → list → send → queue) per contributor plan.

## Considered options

- **Big-bang rewrite of bridges first**: rejected — highest regression risk; does not unblock Frontend maintainability.
- **Frontend-only deletes without Runtime live unification**: rejected — leaves duplicate projection and reconcile ladders ([`frontend-session-transcript-simplification.md`](../plans/frontend-session-transcript-simplification.md)).
- **Count moves into `packages/backend` as reduction**: rejected — moves alone do not meet net-delete goal; dedup after move is in scope.

## Consequences

- New work should land in `src/features/<domain>/` rather than growing `use-agent-impl-core.tsx`.
- [`docs/plans/loc-reduction-highest-impact.md`](../plans/loc-reduction-highest-impact.md) remains the tactical spine; [`thirty-percent-loc-reduction.md`](../plans/thirty-percent-loc-reduction.md) adds phase targets and cumulative math toward 30%.
- [`docs/architecture.md`](../architecture.md) should note `features/` as the intended Frontend orchestration home when PRs move host or split providers.
- Extend `slop-check.mjs` when new anti-patterns appear (e.g. second `LiveSessionProjection` outside `session-transcript`, reintroduced `TRANSCRIPT_*` in `agent-reducer`).
- Realistic ceiling **without** bridge dedup: ~15–18% net; **with** bridge tranche: path to ~21k.

## References

- [CONTEXT.md](../../CONTEXT.md)
- [ADR 0005](./0005-opengui-runtime-backend-split-and-sdk.md) — layer split
- [ADR 0008](./0008-session-transcript-projection-in-runtime.md) — projection in Runtime
- [contributor-experience-and-slop-removal.md](../plans/contributor-experience-and-slop-removal.md) — slop taxonomy
- [loc-reduction-highest-impact.md](../plans/loc-reduction-highest-impact.md) — god provider tranches
