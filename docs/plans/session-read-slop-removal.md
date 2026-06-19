# Plan: Session and transcript read slop removal

Companion to [ADR 0006](../adr/0006-harness-only-session-and-transcript-reads.md). Domain terms: [CONTEXT.md](../../CONTEXT.md).

## Goal

One honest read path: **Harness session summary** on list; **Harness message pages** on transcript fetch; **GET + query only** for lists; errors surface, no ghosts.

## Non-goals

- Rewriting queue dispatch or SQLite queue schema
- Moving `web-server.ts` into `packages/backend` (see [runtime-backend-sdk-split](./runtime-backend-sdk-split.md))
- Removing all in-memory `SessionService` in one PR (shrink usage first; list reads stop depending on it)
- Changing Live Session stream / SSE event shapes

## Target behavior (acceptance)

| Action                                  | Expected                                                            |
| --------------------------------------- | ------------------------------------------------------------------- |
| Sidebar / project refresh               | Only sessions returned by Harness for each `(directory, harnessId)` |
| `POST /api/sessions/query`              | Fan-out harness lists; no `sync`; per-scope errors in `errors[]`    |
| `GET /api/sessions?directory&harnessId` | Same harness list rules; ignore/remove `sync`                       |
| Open chat, Harness fails                | UI shows error, not empty thread                                    |
| Open chat, session missing              | Error, not `{ messages: [] }`                                       |
| `grep sync` on session list API         | No product branch to in-memory list                                 |

## Phase 1 - Backend list path (single truth)

- [x] **`querySessionsForResolvedProjects`**: always call `listDirectorySessionsFromHarness`; delete `sync` parameter and `listSessionRecords` branch in `session-query.ts`.
- [x] **`listSessionsForRequest`**: require `directory` + `harnessId` for list; always harness path; remove default `sync !== "false"` behavior in `web-server.ts` `GET /api/sessions`.
- [x] **`listDirectorySessionsFromHarness`**: return mapped summaries **without** `ensureSession` per row (or gate behind explicit non-product flag if queue still needs warm-up-prefer removing).
- [x] **Request bodies**: stop accepting `sync` on `POST /api/sessions/query` (ignore deprecated field one release or reject in dev).
- [x] **Tests**: update `session-harness-list.test.ts` and add query test asserting no `SessionService` list branch; harness failure → error item.

**Exit:** `vp test` green; manual refresh shows only harness sessions.

## Phase 2 - Backend read resolve + messages

- [x] **`resolveSessionRecord`**: remove `sessionRecordFromWireIdentity` from paths used by `GET /api/sessions/:id` and `.../messages` (harness relist or hard error).
- [x] **`listSessionMessagesThroughHarness`**: unchanged source (already harness); ensure caller has strict scope from session summary or resolved harness row.
- [x] **Document** internal-only resolve for mutations (queue/prompt) if still needed-must not power list/get messages.

**Exit:** No "Recovered session" in API responses; messages require scope.

## Phase 3 — Protocol + Frontend

- [x] **`http-client.ts`**: remove `sync: true` from `listDirectorySessions`; implement via `POST /api/sessions/query` or `GET` only.
- [x] **`sessions.query`**: default harness-only (no `sync` param); remove from `OpenGuiClient` types when unused.
- [x] **`getMessages`**: delete catch that returns empty page on `Session not found`; propagate `OpenGuiRpcError`.
- [x] **`fetchSessionMessagePage` / hooks**: handle error state in UI (i18n keys in `en.json`, `de.json`, `es.json`).
- [x] **Collapse client entry points**: `harnesses.listDirectorySessions` → thin wrapper over query/GET or deprecate in favor of `sessions.query` with same semantics.
- [x] **Update** `http-client.test.ts` and agent hook tests for errors vs empty.

**Exit:** Opening missing session shows error; sidebar uses query/GET only.

## Phase 4 - Guardrails

- [x] **`docs/architecture.md`**: link ADR 0006 under Harness / read paths.
- [x] **Comment** on `SessionDispatchIndex`: not for product list reads (`listSessions` removed).
- [x] **Optional**: `pnpm run slop-check` / `scripts/slop-check.mjs` guardrails (session index + protocol slop).
- [ ] **Manual checklist** (Desktop or Web): [`docs/manual/session-read-acceptance.md`](../manual/session-read-acceptance.md). _(Run before release; automated slop-check + tests are green.)_

  | Step                        | Expected                                                 |
  | --------------------------- | -------------------------------------------------------- |
  | Add project / directory     | Project appears; harness scopes resolve                  |
  | List sessions               | Only harness-returned rows; no ghost “Recovered session” |
  | Open session → messages     | Transcript loads from harness                            |
  | Stop harness / offline      | List or open shows **error**, not empty sidebar/thread   |
  | Wrong or unknown session id | Message fetch **error**, not `{ messages: [] }`          |

## File map (primary touch points)

```text
server/services/session-query.ts
server/services/session-harness-list.ts
server/services/session-resolve.ts
server/web-server.ts          # GET /api/sessions, query handler
src/protocol/client.ts        # drop sync from types
src/protocol/http-client.ts
src/hooks/agent-message-loading.ts
src/hooks/use-agent-impl-core.tsx
CONTEXT.md                    # done (glossary)
```

## Risks

| Risk                                                | Mitigation                                                     |
| --------------------------------------------------- | -------------------------------------------------------------- |
| Queue/dispatch relied on `ensureSession` after list | Warm scope from queue target + harness get; relist on dispatch |
| Slower sidebar (always harness)                     | Expected; fix Harness perf, not cache lies                     |
| Remote workspaces break on strict scope             | Pass `directory` from Frontend Project on every messages call  |

## Verification

- [ ] `vp check` / `vp test`
- [ ] Manual ADR 0006 acceptance table
- [ ] `scripts/runtime/probe-*.mjs` still readonly-no change required unless documenting parity

## References

- [ADR 0006](../adr/0006-harness-only-session-and-transcript-reads.md)
- [ADR 0004](../adr/0004-storage-source-of-truth-boundaries.md)
- [runtime-backend-sdk-split](./runtime-backend-sdk-split.md) Phase 4 (package move, separate track)
