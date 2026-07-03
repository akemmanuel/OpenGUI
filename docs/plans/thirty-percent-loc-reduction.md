# Execution plan: ~30% net LoC reduction

**Status:** Active (2026-06-29).  
**Decision:** [ADR 0009](../adr/0009-frontend-composition-and-loc-reduction.md).  
**Domain:** [CONTEXT.md](../../CONTEXT.md). **Slop taxonomy:** [contributor-experience-and-slop-removal.md](./contributor-experience-and-slop-removal.md).  
**Tactical spine (god provider):** [loc-reduction-highest-impact.md](./loc-reduction-highest-impact.md).

## Baseline and goal

| Scope            | Non-test LOC (approx.) |
| ---------------- | ---------------------- |
| `src/`           | ~48,400                |
| `server/`        | ~4,800                 |
| `packages/`      | ~16,900                |
| `lib/` + `main/` | ~1,000                 |
| **Total**        | **~71,000**            |

**Target:** ~**21,000** lines **net deleted** (not moved). Re-measure after each phase:

```bash
find src server packages lib main \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.*' | xargs wc -l | tail -1
```

**Already green:** `pnpm run slop-check` (session read slop, no shadow list paths). Do not regress ADR 0006 / 0008.

---

## Slopspot map (where the lines hide)

| Rank | Location                                                 | LOC (approx.) | Slop kind                                   |
| ---- | -------------------------------------------------------- | ------------- | ------------------------------------------- |
| 1    | `src/hooks/use-agent-impl-core.tsx`                      | 2,564         | God provider / shadow `features/`           |
| 2    | `packages/runtime/src/adapters/*-bridge.ts` (×5)         | 10,789        | Repeated IPC + project/session maps         |
| 3    | `src/hooks/agent-reducer.ts`                             | 1,316         | Monolithic chrome + activity reducer        |
| 4    | `src/hooks/` (total)                                     | ~14,580       | Shallow splits + overlapping tests          |
| 5    | `src/components/ModelSelector.tsx`                       | 832           | Duplicate catalog state vs cache            |
| 6    | Live path: Runtime compat + `live-message-projection.ts` | ~500+         | Dual projection owners                      |
| 7    | `src/protocol/http-client.ts` + tests                    | ~1,730        | Parallel to Runtime client (thin over time) |
| 8    | Legacy compat (`_backendId`, storage migration)          | ~400–800      | Bounded until 2026-08                       |

**Do not count as slop cuts:** harness behavior, `BetterSDK` TS, bulk test deletion, shadcn `components/ui/`.

---

## Phases (order is mandatory)

### Phase A — Quick wins (1–2 PRs) → **~300–800 LOC**

From [loc-reduction Tranche 1](./loc-reduction-highest-impact.md#tranche-1--quick-wins-1-pr-100250-loc-low-risk) + transcript tail + ModelSelector:

| ID  | Task                                                                                                | Primary files                                                         |
| --- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A1  | Remove noop activation APIs still exported from `agent-session-activation`                          | `agent-session-activation.ts`, `use-agent-impl-core.tsx`              |
| A2  | Row model purity (footers/visibility in `transcript-row-model.ts`)                                  | `transcript-row-model.ts`, `useMessageListModel.ts`, `message-list/*` |
| A3  | ModelSelector → shared `ensureHarnessResourceCatalog` + cache pending only                          | `ModelSelector.tsx`, `ensure-harness-resource-catalog.ts`             |
| A4  | Delete `BetterSDK/src/*.js` one-line stubs if build allows                                          | `BetterSDK/src/`                                                      |
| A5  | `slop-check`: ban second `new LiveSessionProjection` outside `session-transcript` (already partial) | `scripts/slop-check.mjs`                                              |

**Verify:** `pnpm vp test`, `pnpm run slop-check`, `pnpm vp check`.

---

### Phase B — God provider split (2–5 PRs) → **~1,800–2,400 LOC**

Finish [loc-reduction Tranche 2](./loc-reduction-highest-impact.md#tranche-2--split-use-agent-impl-coretsx-24-prs-152k-loc-moveddeleted).

| PR  | Extract                                             | New module                                                  | Exit                                             |
| --- | --------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| B1  | Project connect, hydration, session index           | `features/agent-projects/useAgentProjectOrchestration.ts`   | **done** — impl-core ~1.9k lines (was ~2.5k)     |
| B2  | Workspace CRUD, persistence, presentation           | `features/agent-workspaces/`                                | **done** — impl-core ~1.5k lines                 |
| B3  | Context `useMemo` + exported hooks                  | `features/agent-provider-shell/`                            | **done** — shell + hooks re-exported             |
| B4  | Resource routing effect (still in impl-core ~1200+) | `features/agent-resources/useAgentResourceRouting`          | **done** — default target + harness fallback     |
| B5  | Provider body + backend events + actions assembly   | `agent-provider-shell/`, `agent-events/`, `agent-sessions/` | **done** — `use-agent-impl-core.tsx` ~34 lines   |
| B5b | Thin wrappers + reducer types + slice tests         | `agent-reducer-types`, `agent-reducer-slices.test.ts`       | **partial** — provider harness/persistence hooks |

**Acceptance:** `use-agent-impl-core.tsx` **&lt; 600 lines** ✓; orchestration in `useInternalAgentProviderBody`; manual Local Workspace boot path.

---

### Phase C — Reducer split (2–3 PRs) → **~600–1,000 LOC**

| ID  | Task                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| C1  | `workspaceReducer`: workspaces, projects, connection, hydration, resources cache, meta, worktrees           | **done** — `agent-reducer-workspace-slice.ts`        |
| C2  | `sessionActivityReducer`: `MERGE_PROJECT_SESSIONS`, selection, busy/status, queue, permissions, `SESSION_*` | **done** — `agent-reducer-session-activity-slice.ts` |
| C3  | Compose in provider; keep `BIND_ASSISTANT_TURN_FROM_TRANSCRIPT` minimal                                     | **done** — queue → workspace → session → `state`     |

**Do not** reintroduce `SET_MESSAGES`, `_sessionBuffers`, or `TRANSCRIPT_*` in reducer (`slop-check`).

---

### Phase D — Live-event unification (3–6 PRs, **not** mixed with B/C) → **~1,500–3,000 LOC**

Follow [live-session-event-unification.md](./live-session-event-unification.md):

1. Runtime normalizer: snapshot → semantic patches; dedupe `run.started` / `run.finished`.
2. SDK/Backend: product consumers see `LiveSessionEvent` only on hot paths.
3. Frontend: fold `live-message-projection.ts` into store or consume server-projected only — **one** projection owner.
4. Delete compat reconcile branches in hooks once SSE is canonical.
5. Extend `slop-check` for harness-native part event names on Frontend product paths.

**D1 (done):** slop guards for `message.part.*` in hooks/features + `harnessEventToAgentStreamEvents` export surface; single canonical live ingress via `useBackendEventSubscription` (removed duplicate path in `handleHarnessEvent`).

**D2 (done):** projected transcript (`transcript.snapshot` / `transcript.message.removed`) ingested only in `useBackendEventSubscription` via `projected-transcript-events.ts`; `handleHarnessEvent` is harness lifecycle + connection only.

**D3 (done):** removed `transcript.message` from `ProjectedTranscriptEvent` / `createSessionTranscripts` ingest; SSE + UI use `LiveSessionEvent` + snapshots/removals only.

**D4 (done):** stop mid-run `transcript.snapshot` on message-order changes; keep idle snapshot + `transcript.message.removed`. Session meta tests aligned to `sidebarSection` / `displayProjectDir` (send uses execution directory).

**D5 (done):** `LiveSessionEvent` types + `LiveSessionEventNormalizer`; harness ingress via `harnessEventsToLiveSessionEvents` (`packages/runtime/src/live-session-events/`).

**D6 (done):** `SessionHandle.onEvent()`; `onStream()` derived from canonical live events; `waitUntilIdle` without duplicate lifecycle dispatch.

**D7 (done):** Backend live publish path normalizes bridge events to `LiveSessionEvent` before SSE (`publishLiveSessionHarnessEvent`).

**D8 (done):** Frontend hot paths consume `LiveSessionEvent` / projected transcript via `useBackendEventSubscription`; raw `message.part.*` guarded by `slop-check` (hooks, features, components).

**D9 (done):** SDK public surface — README quickstart and examples use `session.onEvent` only; `harness.on("event")` documented as diagnostics only; `HarnessEventHandler` demoted from primary `@opengui/runtime` exports; `debug-bridges.mjs` prints canonical events by default (`--debug-adapter-observations` for raw bridge).

**D10 (done):** `slop-check` live-event guards — `harness.on("event")` only in `scripts/runtime/debug-bridges.mjs`; no `ingestHarnessEvent` on server/hooks/features hot paths; `LiveSessionEventNormalizer` only in `live-session-event-bus.ts`; `HarnessEvent` type export marked `@deprecated` on SDK surface (see [live-session-event-unification.md](./live-session-event-unification.md) Phase 8).

Align with [frontend-session-transcript-simplification.md](./frontend-session-transcript-simplification.md) Phases 4–7.

---

### Phase E — Bridge IPC dedup (large, **needed for full 30%**) → **~2,500–4,500 LOC**

| ID  | Task                                                                             |
| --- | -------------------------------------------------------------------------------- |
| E1  | `registerHarnessIpcRouter` or handler table in `harness-adapter-kit.ts`          |
| E2  | Shared project/session memory base; per-bridge only harness-specific protocol    |
| E3  | Incremental `workspaceId` map removal where `directory` + harness scope suffices |

**Start when:** B + C stable; harness registry tests green.

---

### Phase F — Package host moves → **~500–1,500 net**

[contributor Track 6](./contributor-experience-and-slop-removal.md#track-6--structural-slop-packages): SSE/RPC/FS from `server/web-server.ts` → `packages/backend`; delete duplicate bootstrap between host and routes.

---

### Phase G — Compat sunset (2026-08 window) → **~400–800 LOC**

Remove `_backendId` read paths, narrow `session_*` decode branches, shrink legacy blocks in `agent-state-persistence.ts`.

---

## Cumulative targets

| Through phase                         | Net LOC (range) | % of baseline |
| ------------------------------------- | --------------- | ------------- |
| A                                     | 0.3–0.8k        | ~0.5–1%       |
| A+B+C                                 | 2.7–4.2k        | ~4–6%         |
| +D                                    | 4.2–7.2k        | ~6–10%        |
| +E                                    | 6.7–11.7k       | ~9–16%        |
| +F+G                                  | 7.6–14.0k       | ~11–20%       |
| **+E full + hook/test consolidation** | **~18–21k**     | **~25–30%**   |

To hit **30%**, commit to **Phase E** and aggressive deletion of redundant hook/tests after **B5**.

---

## First PR starter (recommended)

**Scope:** Phase A only (single PR).

```bash
pnpm vp test
pnpm run slop-check
pnpm vp check
```

Checklist:

- [x] A1 noop APIs removed (already absent from `agent-session-activation`)
- [x] A2 row build in `build-message-list-transcript-rows.ts`
- [x] Tranche 3: `message-list-viewport-state.ts`; spacing in `transcript-row-model.ts`
- [x] Tranche 4: `ensure-harness-resource-catalog.ts` (ModelSelector + `useAgentResourceCatalog`)
- [x] A3 ModelSelector uses `isCatalogKeyPending` + `catalogPendingKey`
- [x] A4 BetterSDK `src/*.js` stubs deleted
- [x] A5 `slop-check` LiveSessionProjection guard (unchanged)
- [x] No new hardcoded UI strings (i18n unchanged)
- [ ] LOC note in PR description (before/after `wc` command above)

Then open **B1** (`features/agent-projects` facade).

---

## References

- [ADR 0009](../adr/0009-frontend-composition-and-loc-reduction.md)
- [loc-reduction-highest-impact.md](./loc-reduction-highest-impact.md)
- [contributor-experience-and-slop-removal.md](./contributor-experience-and-slop-removal.md)
- [model-selector-catalog-cache.md](./model-selector-catalog-cache.md)
- [live-session-event-unification.md](./live-session-event-unification.md)
- [frontend-session-transcript-simplification.md](./frontend-session-transcript-simplification.md)
- [docs/architecture.md](../architecture.md)
