# Plan: Model selector catalog cache & load deduplication

**Problem:** Opening the harness → model picker feels like a full reload every time: harness inventory is refetched on each `open`, and `loadResources` runs through a **separate** path from the agent’s `loadServerResources`, even when the same harness + workspace + directory catalog is already in memory.

**Goal:** One canonical catalog cache and one deduped loader. Reopen picker → instant UI when scope unchanged; switching harness tab → load once per scope, then cached.

**Related:** [PromptBox harness readiness](./promptbox-harness-readiness.md) (dialog UX is done; this plan fixes **data** slop). [Contributor slop](./contributor-experience-and-slop-removal.md) — duplicate load paths = **API slop**.

---

## Current slop (evidence)

| Issue                                                                                 | Where                         | Effect                                                                                                               |
| ------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Picker-only `draftProviders` + `draftCatalogKey`                                      | `ModelSelector.tsx`           | No reuse of `workspaceResources` / `useModelState().providers`                                                       |
| `loadResources` on open when key mismatch                                             | `ensureCatalogForHarness`     | Duplicate RPC vs `loadServerResources` (no shared in-flight dedupe)                                                  |
| `getHarnessInventories()` every `open`                                                | `ModelSelector` effect        | Full-screen “Checking harnesses…”; `inventoriesReady` reset                                                          |
| `workspaceResources[workspaceId]` holds **one** `(loadedHarnessId, loadedProjectKey)` | `SET_WORKSPACE_RESOURCES`     | Last routed harness wins; picker’s other harness tab cannot hit cache                                                |
| Inventory `models[]` always empty from server                                         | `server/harness-inventory.ts` | `modelReadyHarnessIds` in `harness-inventory-view` is dead; readiness is CLI-only (OK) but refetch is still wasteful |

**Not a bug:** Closing the dialog without clearing `draftCatalogKey` already skips `loadResources` on immediate reopen **if** effects don’t race. Users still see inventory spinner and loading states because inventory + effect ordering (`catalogMatchesDialog`) are sloppy.

---

## Design principles

1. **Single cache key** — Same string everywhere: `catalogKey = harnessId + NUL + workspaceId + NUL + directory` (today’s `createCatalogKey`; add `makeProjectKey` alignment: empty directory → `""` in key).
2. **Single loader** — One function used by agent routing **and** model picker (and future Settings refresh).
3. **Cache survives dialog close** — Module- or context-level map, not React state cleared on unmount.
4. **Inventory is global, TTL’d** — CLI probes are workspace-agnostic; fetch once per app session (or ~60s TTL), not per dialog open.
5. **Optimistic UI** — Show cached catalog immediately; background refresh only when explicit invalidation or stale TTL (optional phase 2).

---

## Target architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ resourceCatalogCache: Map<catalogKey, ProvidersData + meta> │
└───────────────────────────┬─────────────────────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │ ensureResourceCatalog()   │
              │  - hit cache → return     │
              │  - in-flight Map → join   │
              │  - miss → loadResources   │
              │  - write cache + dispatch │
              │    SET_WORKSPACE_RESOURCES│
              │    (when active workspace)│
              └─────────────┬─────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
  use-agent-impl     ModelSelector      refreshProviders
  routing effect     on open / tab      (action)
```

**Harness inventory (parallel, lighter):**

```text
harnessInventorySnapshot: { rows, fetchedAt } + getHarnessInventoriesCached({ maxAgeMs })
  ← ModelSelector, SetupWizard (migrate to shared helper)
```

---

## Implementation tracks

### T1 — Catalog cache module + unified loader

**New:** `src/lib/resource-catalog-cache.ts` (or `src/hooks/resource-catalog.ts` if it needs client injection only via params).

- `makeCatalogKey({ harnessId, workspaceId, directory })` — export; replace duplicate in `ModelSelector`.
- `getCachedProviders(key): Provider[] | null`
- `setCachedCatalog(key, bundle: { providersData, agentsData?, commandsData? })` — store full bundle for future agent/command reuse in picker (agents optional in T1).
- `ensureResourceCatalog(client, target, harnessId, options?: { updateGlobalState?: boolean })`:
  - Dedupe in-flight by `key` (promise map).
  - On success: update cache; if `updateGlobalState`, dispatch `SET_WORKSPACE_RESOURCES` via injected callback (keep reducer as SoT for **active** workspace UI).
- Unit tests: cache hit, in-flight coalescing, key normalization (null directory).

**Refactor:** `loadServerResources` in `use-agent-impl-core.tsx` → thin wrapper calling `ensureResourceCatalog` with `updateGlobalState: true` and existing selection/agent side effects **after** bundle returns (keep current reducer dispatches in one place).

**Acceptance:**

- [x] Two simultaneous `ensureResourceCatalog` same key → one `loadResources` RPC (mock client in test).
- [x] Routing effect still loads once per harness+project when cache cold; second navigation uses cache + `ACTIVATE_WORKSPACE_RESOURCES` where applicable.

### T2 — Extend workspace cache model (multi-harness per workspace)

Today `workspaceResources[workspaceId]` is a single slot. Picker needs **per catalog key** within a workspace.

**Option A (recommended):** Keep flat `resourceCatalogCache` Map as SoT for catalogs; `workspaceResources[workspaceId]` remains “last activated” slice for `providers`/`agents` on active tab (unchanged). Picker reads **only** `resourceCatalogCache` + committed providers when keys match.

**Option B:** Nest `workspaceResources[workspaceId].byCatalogKey[key]` — larger reducer change.

Deliver **Option A** in T2; document in `CONTEXT.md` one line: “Resource catalogs are keyed by harness + workspace + directory; active workspace UI shows the routed catalog.”

**Acceptance:**

- [x] Open picker → Codex tab after Pi was routed: Codex catalog loads once; second open Codex tab uses cache.
- [x] Select model on Codex → routing updates; global `providers` match Codex without redundant load if cache warm.

### T3 — ModelSelector slim-down

- Remove local `draftProviders` / `draftCatalogKey` state as **source of truth**; use:
  - `catalogKey` for dialog harness + `dialogCatalogTarget`
  - `getCachedProviders(catalogKey)` for list building
  - `ensureResourceCatalog` on open / harness tab / directory change (with loading flag from promise state)
- **Seed on open:** If `catalogKey` matches active workspace resources (`loadedHarnessId` + `loadedProjectKey` + harness) **or** cache hit, render list immediately (no “Loading catalog…”).
- **Committed providers:** When `!open`, trigger unchanged. When `open` and cache empty, show spinner until `ensureResourceCatalog` completes.
- Delete duplicate `catalogRequestRef` if unified loader owns request ids.

**Acceptance:**

- [x] Reopen picker same harness + project: no inventory gate (T4) + no catalog spinner.
- [x] Change harness tab: spinner only for uncached harness; cached tab instant.

### T4 — Harness inventory cache

**New:** `src/lib/harness-inventory-cache.ts`

- `fetchHarnessInventories(client, { maxAgeMs = 60_000 })`
- Invalidate on: `opengui:harness-install-changed` custom event (optional, if Settings installs CLI), or manual `invalidateHarnessInventoryCache()` from Settings after install hint.

**ModelSelector:**

- Replace per-open `getHarnessInventories` + `inventoriesReady` reset with cached fetch.
- On dialog open: if snapshot fresh, `status: "ready"` immediately for `createHarnessInventoryView`.
- Background refresh if stale (optional): show tabs immediately with stale hints, update rows when fetch completes.

**SetupWizard:** Switch to same helper (one less direct RPC pattern).

**Acceptance:**

- [x] Open picker 10× in 30s → 1 inventory RPC (or 1 per TTL), not 10.
- [ ] First open after TTL → one refresh, no full UI block if stale snapshot shown (if implementing stale-while-revalidate).

### T5 — Invalidation rules

| Event                                                        | Action                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| User changes chat directory / workspace                      | New `catalogKey`; cache miss → load                        |
| Settings “refresh models” (if exists) or harness auth change | `invalidateCatalogKeys({ harnessId })` or full clear       |
| `refreshProviders` action                                    | `ensureResourceCatalog` force refresh for **routed** scope |
| Project disconnect                                           | Evict keys matching `projectKey` prefix (optional T5b)     |

Document invalidation in module header comment; no hidden magic.

### T6 — Tests & slop-check

- [x] `resource-catalog-cache.test.ts` — hit, miss, in-flight
- [ ] `ModelSelector` integration test (RTL): mock client, open twice → `loadResources` call count 1
- [ ] Run `pnpm run slop-check` if touching session paths (unlikely); `pnpm vp test` for new tests

---

## Migration / risk

| Risk                                       | Mitigation                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Stale catalog after provider config change | TTL or Settings invalidation; `refreshProviders` bypasses cache            |
| Memory growth (many harnesses × projects)  | Cap cache size LRU ~20 keys (phase 2)                                      |
| Race: tab switch faster than load          | Unified loader already serializes by key; UI shows per-key loading         |
| Web vs Electron client                     | `ensureResourceCatalog` takes `OpenGuiClient`; no `window` in cache module |

---

## Out of scope (for now)

- Server-side catalog caching inside harness bridges (`pi:providers` still hits CLI each miss — OK).
- Merging inventory `models[]` with `loadResources` (inventory stays CLI readiness only).
- Renaming `ModelSelector` → `HarnessModelSelector` (cosmetic).

---

## Suggested PR order

1. **T1** — cache + refactor `loadServerResources` (no UI change yet; behavior parity).
2. **T4** — inventory cache (quick win, visible spinner removal).
3. **T3 + T2** — ModelSelector wired to cache (main UX fix).
4. **T5 + T6** — invalidation + tests.

**Estimate:** 2–3 focused PRs if T1+T4 ship together, then T3/T2.

---

## Done when

- Opening the model picker with unchanged harness, workspace, and directory does **not** call `getHarnessInventories` (within TTL) or `loadResources`.
- All `loadResources` for catalog display go through `ensureResourceCatalog`.
- Plan checklist above is checked off or explicitly deferred with issue links.
