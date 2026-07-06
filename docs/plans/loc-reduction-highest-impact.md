# Execution plan: highest-impact LoC reduction

**Status:** Active (2026-06-19).  
**Master plan (30% target):** [thirty-percent-loc-reduction.md](./thirty-percent-loc-reduction.md) · **ADR:** [0009](../adr/0009-frontend-composition-and-loc-reduction.md).  
**Domain:** [CONTEXT.md](../../CONTEXT.md). **Slop taxonomy:** [contributor-experience-and-slop-removal.md](./contributor-experience-and-slop-removal.md).

## Executive summary

Most transcript **migration is already landed**: no reducer-owned `messages`, no `frontend-live-session-bridge`, no virtual scroller. **`resource-catalog-cache`** and **`harness-inventory-cache`** exist. Remaining LoC is concentrated in **`use-agent-impl-core.tsx` (~2.9k)** and **duplicate orchestration wiring**, not in re-building transcript merge.

**Highest impact next:** split the god provider into `src/features/*` hooks and delete duplicate/stub seams. **Second:** finish transcript plan Phase 4–6 (row model purity, dead constants). **Third:** `ModelSelector` catalog UX dedupe (smaller LoC, high perceived perf).

---

## Already done (do not re-litigate)

| Item                                  | Evidence                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Active transcript store               | `src/features/session-transcript/active-session-transcript-store.ts`                      |
| Messages off `InternalAgentState`     | `agent-state-types.ts` has no `messages` field                                            |
| MessageList reads transcript snapshot | `useMessageListModel.ts` → `useActiveTranscriptSnapshot()`                                |
| Unified catalog loader                | `src/lib/resource-catalog-cache.ts` + `ensureResourceCatalog` in impl-core                |
| Inventory TTL                         | `src/lib/harness-inventory-cache.ts` + `ModelSelector` on open                            |
| Virtual scroller removed              | No `useVirtualMessageScroller` in tree                                                    |
| MessageBubble architecture            | `MessageBubble.architecture.test.ts`                                                      |
| Session activation stubs              | `useAgentSessionActivation` — selection only; reconcile lives in transcript orchestration |

Update [frontend-session-transcript-simplification.md](./frontend-session-transcript-simplification.md) checklist to reflect Phases 1–3 largely complete.

---

## Tranche 1 — Quick wins (1 PR, ~100–250 LoC, low risk)

**Goal:** Remove dead exports and duplicate bridges without behavior change.

| #   | Task                                  | Files                                                                         | Delete / change                                                                                                                                |
| --- | ------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Remove unused session buffer constant | `agent-message-state.ts`                                                      | `MAX_SESSION_BUFFER_CACHE` (grep shows definition only)                                                                                        |
| 1.2 | Slim session activation hook          | `agent-session-activation.ts`                                                 | Remove noop `refreshActiveSessionMessages` / `scheduleSessionMessageReconcile` from hook API; impl-core already defines real implementations   |
| 1.3 | Collapse transcript bridge ref        | `use-agent-impl-core.tsx`                                                     | [x] `transcriptHandlers` passed directly to `useBackendEventSubscription` (no `transcriptBridgeRef`)                                           |
| 1.4 | `transcript.message` ingest           | `use-active-session-transcript-orchestration.ts`                              | [x] Removed no-op `transcript.message` branch (bus does not publish; see `server/projected-transcript-publish.ts`)                             |
| 1.5 | Move message utilities                | `agent-message-state.ts` → `src/features/session-transcript/message-utils.ts` | `getMessageText`, `limitMessageWindow`, `MESSAGE_PAGE_SIZE`, `getChildSessionId`; update imports; shrink misleading `agent-message-state` name |

**Verify:** `pnpm vp test`, `pnpm run slop-check`, `pnpm vp check`.

---

## Tranche 2 — Split `use-agent-impl-core.tsx` (2–4 PRs, ~1.5–2k LoC moved/deleted) — **done (2026-07)**

**Goal:** `HarnessProvider` becomes composition of feature hooks; file target **&lt; 600 lines**. Current `use-agent-impl-core.tsx` is a thin provider entry (~34 lines); orchestration lives under `src/features/*`.

Extracted in this order (dependencies top → bottom):

### 2.1 `features/agent-bootstrap/` (~400 lines out) — **done**

**Owns:** Workspace hydration from persistence; post-ready project bootstrap (local server check/start), `buildBootstrapProjectConfigs`, initial `loadServerResources` + `loadSessionIndex`.

**Exports:** `useAgentWorkspacePersistence`, `useAgentProjectBootstrap`

**Cut from impl-core:** workspace init effect + startup bootstrap effect; `stateRef`/`getState` moved to top of provider body for bootstrap hooks.

### 2.2 `features/agent-resources/` (~350 lines out) — **done**

**Owns:** `loadServerResources`, resource load dedupe refs, `clearResourceLoadDedupe` (used by `refreshProviders`).

**Exports:** `useAgentResourceCatalog` → `{ loadServerResources, loadedResource*Ref, clearResourceLoadDedupe }`

**Done:** harness routing effect moved to `useAgentResourceRouting`; catalog loading stays in `useAgentResourceCatalog`.

### 2.3 `features/agent-projects/` (~500 lines out) — **done**

**Owns:** Project connect/remove, hydration (`updateProjectHydration`, `loadSessionIndex`), `expectedDirectoriesRef`, session index refresh, default chat directory.

**Done:** call sites moved behind `useAgentProjectOrchestration` facade.

### 2.4 `features/agent-workspaces/` (~400 lines out) — **done**

**Owns:** Workspace CRUD/switch plans, persistence effects, presentation (`resolveWorkspacePresentation`).

**Done:** workspace orchestration lives in `useAgentWorkspaceOrchestration`; provider-level persistence effects live under `agent-provider-shell`.

### 2.5 `features/agent-provider-shell/` (~250 lines out) — **done**

**Owns:** Context value assembly (`sessionCtx`, `connectionCtx`, `modelCtx`, `actionsCtx`), provider nesting, exported hooks (`useSessionState`, etc.).

**Kept in impl-core:** Only the thin provider wrapper and `<ActiveSessionTranscriptProvider>`.

### Acceptance (Tranche 2)

- [x] `rg "use-agent-impl-core" src/` — only `HarnessProvider` entry and test imports where needed.
- [x] No new circular imports (`features/*` may import `hooks/agent-reducer`, not vice versa).
- [ ] Manual: Desktop Local Workspace — boot, add project, list sessions, send, queue.

---

## Tranche 3 — Transcript plan finish (1–2 PRs, ~300–800 LoC)

Per [frontend-session-transcript-simplification.md](./frontend-session-transcript-simplification.md) **remaining**:

| Phase | Work                                                                                                                                 | LoC impact               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| **4** | Row model: ensure all message-list visibility/footer logic in `transcript-row-model.ts`; thin `useMessageListModel`                  | −100–300 in message-list |
| **5** | Already plain viewport — delete dead scroll helpers if any remain in `message-list-viewport.ts`                                      | −0–150                   |
| **6** | Grep reducer for orphan transcript actions (`BIND_ASSISTANT_TURN_FROM_TRANSCRIPT` stays); remove unused child-session globals if any | −50–200                  |
| **7** | Extend `slop-check.mjs` per plan (ban `TRANSCRIPT_*` in hooks if reintroduced)                                                       | +guardrails              |

**Do not start** live-event unification ([live-session-event-unification.md](./live-session-event-unification.md)) in the same PR as provider split — Runtime-heavy, different reviewers.

---

## Tranche 4 — ModelSelector diet (1 PR, ~150–300 LoC) — **done (2026-07)**

Catalog cache exists; **remaining slop** was in `ModelSelector.tsx` (~829):

- [x] Split into `ModelSelector.tsx` (~306), `ModelSelectorContent`, hooks (`useModelSelectorCatalog`, etc.), `model-selector-groups.ts`.
- [x] `ModelSelector.catalog.test.tsx` — single `loadResources` per catalog key.
- See [model-selector-catalog-cache.md](./model-selector-catalog-cache.md) T1–T6.

---

## Tranche 5 — Structural (when Tranche 2 stable)

From contributor plan **Track 6**:

- Move host SSE/RPC/FS from `server/web-server.ts` → `packages/backend`.
- ~~Colocate `lib/harness-adapter-kit` under `packages/runtime/src/adapters/`.~~ Done (`harness-adapter-kit.ts` + `adapters/__tests__/`).

**LoC:** mostly **moves**; net delete = duplicate bootstrap between `server/` and `packages/backend`.

---

## Priority matrix

| Tranche                     | User-visible risk | LoC / complexity reduction | Start when            |
| --------------------------- | ----------------- | -------------------------- | --------------------- |
| **1** Quick wins            | Low               | Low                        | **Now**               |
| **2** God provider split    | Medium            | **Highest**                | After Tranche 1 green |
| **3** Transcript phases 4–7 | Medium            | Medium                     | Parallel with 2.5     |
| **4** ModelSelector         | Low               | Low–medium                 | Anytime               |
| **5** Packages              | Medium            | Long-term                  | After 2               |

---

## First PR checklist (Tranche 1)

```bash
pnpm vp test
pnpm run slop-check
pnpm vp check
```

- [x] 1.1–1.2 applied (Tranche 1 started 2026-06-19)
- [x] 1.5 message-utils move; removed `agent-message-state.ts`
- [ ] No new hardcoded UI strings (i18n unchanged in tranche 1)
- [ ] Optional: 1.3–1.5 if timeboxed in same PR

---

## References

- [frontend-session-transcript-simplification.md](./frontend-session-transcript-simplification.md)
- [contributor-experience-and-slop-removal.md](./contributor-experience-and-slop-removal.md)
- [architecture.md](../architecture.md) — Frontend feature slices direction
- [CONTEXT.md](../../CONTEXT.md)
