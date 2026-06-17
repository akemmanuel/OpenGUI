# Plan: Contributor experience, layer hygiene, and slop removal

**Goal:** Docs match ADRs; code matches docs; adding harnesses and changing layers does not require archaeology. **Slop** = second sources of truth, deprecated paths still on product hot paths, and names that contradict CONTEXT.

**Companion plans (do not duplicate detail here):**

- Session/transcript reads: [`session-read-slop-removal.md`](./session-read-slop-removal.md) + [ADR 0006](../adr/0006-harness-only-session-and-transcript-reads.md)
- Runtime package / SDK: [`runtime-backend-sdk-split.md`](./runtime-backend-sdk-split.md) + [ADR 0005](../adr/0005-opengui-runtime-backend-split-and-sdk.md); minimal SDK API: [ADR 0007](../adr/0007-runtime-sdk-minimal-surface.md) + [`runtime-sdk-minimal-surface.md`](./runtime-sdk-minimal-surface.md)
- Storage boundaries: [ADR 0004](../adr/0004-storage-source-of-truth-boundaries.md)

---

## What counts as slop

| Kind                 | Definition                                                          | Example                                                                          |
| -------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Lie**              | UI/API succeeds with empty or invented data when Harness failed     | `getMessages` → `{ messages: [] }` on error                                      |
| **Shadow index**     | Backend SQLite/memory treated as session list or transcript source  | `listSessionRecords`, `replaceScopeSessions`, `ensureSession` after harness list |
| **Ghost identity**   | Session exists in Backend without Harness proof                     | `sessionRecordFromWireIdentity` on GET/messages                                  |
| **Wrong layer name** | Code/docs say Backend owns adapters or “headless” deploy            | README pre-2026 layer blur                                                       |
| **Execution slop**   | `workspaceId` / Project CRUD on execution when scope is `directory` | `/api/projects`, `connectProject` (mostly removed)                               |
| **Registry slop**    | Same harness list copied in 6 files                                 | `HARNESS_IDS` vs `MANAGED_HARNESS_IDS` vs `SESSION_ID_HARNESS_IDS`               |
| **API slop**         | Two client methods for one product behavior                         | `sync` list vs harness list; duplicate session list entry points                 |
| **Naming slop**      | `backendId` for Harness; `setHarnessId` for harness picker          | `agent-session-utils` `_backendId` fallback                                      |

**Not slop (bounded legacy):**

- `session_*` base64url ids — parse only; do not create new ones ([`session-identity.ts`](../../src/lib/session-identity.ts))
- `opencode:` localStorage key migration — read-once migrate in [`safe-storage.ts`](../../src/lib/safe-storage.ts)
- SQLite `projects` table — migration join only; no product CRUD ([runtime-backend-sdk-split](./runtime-backend-sdk-split.md) Phase 2b)
- `ensureSessionFromRuntime` on **mutations** (create/fork/prompt) when queue needs a stable internal row — not for list/get messages

---

## How to work this plan

| Track                         | Focus                                                 | Typical PR size    |
| ----------------------------- | ----------------------------------------------------- | ------------------ |
| **0 — Docs & language**       | Reading order, API-only vs headless, architecture map | Small              |
| **1 — Session read slop**     | Finish existing plan                                  | Small–medium       |
| **2 — Backend session index** | Shrink `SessionService` product use                   | Medium             |
| **3 — Protocol & naming**     | Client types, `_backendId`, deprecated exports        | Small, ongoing     |
| **4 — workspaceId**           | Bridges + HTTP bodies directory-first                 | Large, incremental |
| **5 — Harness registry**      | Before many new harnesses                             | Medium             |
| **6 — Physical split**        | `packages/backend`, bridges under runtime             | Large              |

**Order:** **0** → finish **1** → **2** in parallel with **5** (harnesses) → **3** whenever touching files → **4**/**6** when convenient.

---

## Track 0 — Documentation and terminology

### 0.1 Reading order (CONTEXT)

- [x] Top of [`CONTEXT.md`](../../CONTEXT.md): ADR index → architecture.md → runtime-backend-sdk-split → this plan.

### 0.2 Ban “headless” in deploy/product copy

**Say:** API-only Backend, Combined Backend + Frontend, OpenGUI Runtime (in-process).

**Tasks:**

- [x] CONTEXT: _Avoid_ under API-only Backend includes `headless`, `headless server`.
- [ ] `rg -i headless docs/ README.md packages/*/README.md` — only _Avoid_ lines and this plan.
- [ ] `docs/docker.md`, `docs/mobile.md`: use API-only Backend.
- [ ] Trim or replace “Headless Backend (resolved)” in [`2026-05-12-backend-frontend-split-workspaces-mobile.md`](./2026-05-12-backend-frontend-split-workspaces-mobile.md) (historical file).

### 0.3 Single repo map

- [x] [`docs/architecture.md`](../architecture.md): layer table + where code lives.
- [ ] Rule: any PR that moves `web-server` or bridges updates architecture.md in the same PR.

### 0.4 ADR index

- [x] [`docs/adr/README.md`](../adr/README.md) + link to this plan.

---

## Track 1 — Session read slop (finish ADR 0006)

**Status:** Phases 1–2 done; Phase 3 mostly done; Phase 4 open.

From [`session-read-slop-removal.md`](./session-read-slop-removal.md):

- [ ] **Tests:** `http-client.test.ts`, agent hook tests — errors vs empty messages.
- [ ] **Guardrails:** Comment or remove product use of `SessionService.listSessions`; optional CI `rg` ban on `sync` in `session-query` / query types.
- [ ] **Manual:** ADR 0006 acceptance table (list → open → kill harness → wrong id).

**Exit:** Product never lists or loads messages except via harness path; failures are visible.

---

## Track 2 — Backend session index slop

**Problem:** `SessionService` still holds `ensureSession`, `replaceScopeSessions`, `listSessionRecords`, and resolve helpers that can invent or hydrate rows against ADR 0004/0006.

### 2.1 Inventory call sites

```bash
rg 'listSessionRecords|replaceScopeSessions|sessionRecordFromWireIdentity|ensureSession\(' server/ src/protocol --glob '*.ts'
```

| Symbol                             | Intended use after cleanup                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `listDirectorySessionsFromHarness` | **Only** product list                                                                              |
| `resolveSessionRecordForMutation`  | Queue, prompt, delete, rename — harness relist or scoped error                                     |
| `ensureSessionFromRuntime`         | Internal row for queue dispatch only if still required; document in `session-lifecycle-actions.ts` |
| `sessionRecordFromWireIdentity`    | **Delete** from read paths; narrow or delete export                                                |
| `listSessionRecords`               | **Delete** if no callers                                                                           |
| `replaceScopeSessions`             | **Delete** (deprecated ADR 0004)                                                                   |
| `syncDirectorySessions`            | **Delete** wrapper; callers use harness list                                                       |

### 2.2 Tasks

- [x] `session-record-actions.ts` / `listSessionRecords`: grep callers; remove or restrict to tests.
- [x] `session-service.ts`: remove `replaceScopeSessions` if unused; tighten `ensureSession` doc “mutations + queue only”.
- [x] `session-resolve.ts`: read uses harness list only; mutation relist + `ensureSession` (no wire stub); harness list errors propagate.
- [ ] `server/services/index.ts`: stop re-exporting dead symbols.
- [ ] Tests: align server resolve tests with harness-only reads; keep **legacy `session_*` parse** tests in `session-identity` only.

### 2.3 Exit criteria

- [x] No HTTP handler uses `listSessionRecords` or `sync` for sidebar refresh (slop-check + session-query).
- [ ] `session-read-slop-removal` Phase 4 guardrails checked off.

---

## Track 3 — Protocol, client, and naming slop

### 3.1 Harness naming in Frontend

- [ ] `agent-session-utils.ts`: prefer `_harnessId` only; plan removal date for `_backendId` fallback.
- [x] Hooks / UI state: `activeTargetHarnessId`, `preferredHarnessId`, `desiredHarnessIds`, `allHarnesses` (bulk rename done).
- [x] `createHarnessIdCodec` canonical in `src/agents/index.ts`; `createBackendIdCodec` only in `id-codec.ts` (+ alias test); slop-check bans new uses.

### 3.2 Client API surface

- [x] One list story: `sessions.query` JSDoc canonical; `harnesses.listDirectorySessions` `@deprecated` in `client.ts`.
- [x] `HarnessTarget`: `workspaceId` JSDoc on `backend.ts` (routing only).
- [x] Runtime package: removed `RuntimeProjectRef` / `ProjectConnectionConfig` exports; server uses `DirectoryConnectionConfig`.

### 3.3 Deprecated server exports

Remove after grep shows zero product imports:

- [x] `syncDirectorySessions` ([`session-sync.ts`](../../server/services/session-sync.ts))
- [ ] `session-project-scope.ts` deprecated helpers → `directory-scope.ts`
- [ ] `harness-scope.ts` deprecated alias
- [ ] `session-queue-actions.ts` deprecated list helper

**Exit:** Each `@deprecated` in `server/services` has a removal milestone in this plan or session-read plan.

---

## Track 4 — `workspaceId` slop (execution vs routing)

**Rule:** Harness Scope on the wire = `directory` + `harnessId` + session id. `workspaceId` is optional Frontend metadata for multi-workspace **routing**, not Backend domain identity.

### 4.1 HTTP / `server/`

- [ ] Audit `rg workspaceId server/` — classify: routing vs execution.
- [ ] Execution handlers: accept `directory` from body/query; do not require `workspaceId`.

### 4.2 Bridges

- [ ] Document in [`harness-bridge-contract.md`](./harness-bridge-contract.md) (create with Track 5): `directory` first; `workspaceId` optional for adapter-internal maps only.

### 4.3 Exit criteria

- [ ] `packages/runtime/README.md` remains “no workspaceId on Runtime types”.

---

## Track 5 — Harness registry slop (extensibility)

- [x] `src/agents/harness-ids.ts` — leaf const + type (no codec imports).
- [x] `src/agents/harness-registry.ts` — id, label, cliCommand; inventory via `CLI_COMMAND_BY_HARNESS`.
- [x] Derive: `HARNESS_IDS`, `MANAGED_HARNESS_IDS` (from `HARNESS_ID_VALUES` in runtime), registry labels/cli.
- [x] Test: `harness-registry.test.ts` (registry ↔ ids; `MANAGED_HARNESS_IDS` alignment).
- [x] `docs/harness-bridge-contract.md`.
- [x] `BRIDGE_SETUP_BY_HARNESS_ID` + loop in `registerHarnessAdapters`; `scripts/scaffold-harness.mjs` checklist stub.

---

## Track 6 — Structural slop (packages)

From [`runtime-backend-sdk-split.md`](./runtime-backend-sdk-split.md) Phase 4:

- [ ] Finish Tracks 1–2 before claiming storage cleanup complete.
- [ ] Move `server/web-server.ts` → `packages/backend` incrementally.
- [x] Move `*-bridge.ts` → `packages/runtime/src/adapters/` (incl. `pi-daemon-server.ts`).
- [ ] Move `lib/harness-adapter-kit` beside adapters; lazy harness loading in `createOpenGUI({ harnesses: [...] })` (see [runtime-sdk-minimal-surface.md](./runtime-sdk-minimal-surface.md) Phase E).

---

## Guardrails (prevent slop regression)

### G1 — `scripts/slop-check.mjs`

```bash
node scripts/slop-check.mjs
```

Checks: no `/api/projects`, no `connectProject`, no `sync: true` in protocol, no `listSessionRecords(` in server (non-test).

### G2 — PR checklist

- Layer ownership matches CONTEXT if you touched server/runtime/bridges.
- Session list/messages: harness-only path.
- i18n for new UI strings.
- `docs/architecture.md` if files moved.

### G3 — Deprecation policy

`@deprecated` + replacement; remove within 2 tranches touching that module.

---

## Roadmap (suggested)

| Sprint theme      | Tracks               | Outcome                          |
| ----------------- | -------------------- | -------------------------------- |
| **Hygiene**       | 0.2, 1 remainder, G1 | Docs + tests honest about errors |
| **Index diet**    | 2, 3.3               | SessionService not on read path  |
| **Harness scale** | 5, 4.2 docs          | N new harnesses from registry    |
| **Packages**      | 6                    | Folders match mental model       |
| **Naming**        | 3.1–3.2              | No `backendId` in new code       |

---

## Verification (every tranche)

```bash
vp check
vp test
node scripts/slop-check.mjs
```

Manual: add Project → list → send → queue → Desktop Local Workspace.

---

## References

- [CONTEXT.md](../../CONTEXT.md)
- [docs/architecture.md](../architecture.md)
- [docs/adr/README.md](../adr/README.md)
- [session-read-slop-removal.md](./session-read-slop-removal.md)
- [runtime-backend-sdk-split.md](./runtime-backend-sdk-split.md)
