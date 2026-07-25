# Handoff: Implement flexible users, access, and model offerings

**Repo:** `/Users/gestaltraeume/Documents/OpenGUI`  
**Next session focus:** **Implement** the design (start build), not re-litigate architecture from scratch.  
**Date context:** Design package written in prior session; ADR still **proposed**, not formally accepted via wayfinding ticket.

---

## Mission

Implement the flexible users/access/model-offerings program per the published plan, beginning with **Phase 1 — Model offerings (vertical slice)** unless the human redirects.

Primary product outcome for Phase 1: an operator can define a **Model offering** (e.g. slug `company-model`, display name “Company Model”) that routes to an existing backend + upstream model id; members only see/use entitled offerings.

---

## Authoritative artifacts (read these first)

Do **not** reinvent design from chat. Load:

| Artifact                     | Path                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------- |
| ADR (proposed)               | `docs/adr/0014-flexible-users-access-and-model-offerings.md`                    |
| Implementation plan          | `docs/plans/flexible-users-access-and-model-offerings.md`                       |
| Glossary                     | `CONTEXT.md` (Accounts/Team + Models sections)                                  |
| Prior multi-user foundations | `docs/adr/0011-*.md`, `0012-*.md`, `0013-*.md`                                  |
| Existing plans               | `docs/plans/multi-user-host-access.md`, `docs/plans/host-identity-and-teams.md` |
| Wayfinding map               | `.scratch/flexible-users-and-access/map.md`                                     |
| Residual decision tickets    | `.scratch/flexible-users-and-access/issues/*.md`                                |
| Project agent rules          | `AGENTS.md` (Vite+/pnpm, i18n, no raw `tsc`)                                    |

Architecture index already points at 0014: `docs/architecture.md`, `docs/adr/README.md`.

---

## Decisions already baked into docs (defaults)

Human chose:

1. **Destination = design package** then build (A).
2. **Full scope** = identity + authorization + model access + **UI** (not model-only).
3. North star was **“idk”** → docs defaulted to **Branded Host for others** (offerings-first).

If implementation hits an unresolved ticket in `.scratch/.../issues/`, either:

- use the ADR/plan default and note it in the PR/commit message, or
- stop and resolve the ticket with the human (grilling) before coding that branch.

**Do not block Phase 1** on Host OIDC, passkeys, named Teams, or keychain work (later phases).

---

## Suggested implementation order (Phase 1)

From `docs/plans/flexible-users-access-and-model-offerings.md` Phase 1:

1. **Model access service** surface (avoid growing `IdentityService` forever if you can extract cleanly; plan allows evolving split).
2. Durable **offerings + entitlements**; link/migrate existing `host_model_connection` + host JSON connections → backends + auto-offerings per model id.
3. **Resolve on Host** at prompt/setModel: offering slug → backend + `upstreamModelId`.
4. Authorize via entitlements; collab pin = shared host/team target only (no user-plane pin).
5. **UI:** offering editor (owner/admin path as roles allow today = owner); picker lists offerings; i18n `en`/`de`/`es`.
6. Tests for deny/allow, resolve, migration smoke, pin rules.
7. Run `pnpm run check` / relevant tests; `pnpm run slop-check` if Host routes or frontend Host transport change.

### Key code today (baseline, not target)

- Identity god-module: `packages/backend/src/identity/identity.ts`
- Host secrets/settings: `packages/backend/src/host/opengui-host.ts` (`apiKeys`, modelConnections, Codex/xAI OAuth)
- Product model routes: `packages/backend/src/routes/host-product.ts`
- Identity routes: `packages/backend/src/routes/identity.ts`
- Provider settings UI: `src/components/SettingsProviders.tsx`
- Picker: `src/components/ModelSelector.tsx`
- Selection shape: `packages/protocol/src/selected-model.ts` (`providerID` + `modelID` — multi-user should move toward offering slug in `modelID` or extend carefully with backward compat)
- Dead unused types (replace, don’t revive ad hoc): `src/types/provider.ts`
- Transport sends wire `model` = selected model id today: `packages/harness/src/models/openai-chat.ts` — resolution must happen **before** transport sees upstream id, on the Host

### Dual-store invariant

Identity SQLite owns plane/entitlement metadata; host JSON owns endpoint + secrets. Phase 1 must not leave orphan half-writes. Prefer one application write path with compensate-on-failure (see ADR 0014).

---

## Out of scope for this implementation session (unless human expands)

- Phase 4 Host login methods (OIDC/passkeys)
- Full admin/viewer role matrix (Phase 3) — Phase 1 can stay owner-managed offerings
- Secret encryption/keychain (Phase 2+)
- Named Teams
- Realtime collab UX
- Hostile multi-tenant isolation

---

## Wayfinding note

Map tickets 01–08 are mostly still **open**. Ticket **01-accept-adr-0014** was never closed with the human. Proceeding to implement implies treating proposed ADR 0014 + plan as the build spec; if the human objects, revise ADR before large merges.

When a residual decision is forced by code, update the relevant `.scratch/.../issues/*` answer or the plan checkbox—don’t leave silent drift.

---

## Workflow / tooling

- Package manager: **pnpm** (pinned); Vite+ via `pnpm vp` / `pnpm run`
- Dev: `pnpm run dev` (desktop) / `pnpm run dev:web`
- Quality: `pnpm run check` (not raw `tsc`)
- User-facing strings → `src/i18n/locales/{en,de,es}.json` together
- Commits: only if human asks

---

## Suggested skills

Invoke as needed (load skill files first):

1. **`tdd`** — Phase 1 entitlements/resolve/pin behavior is security-sensitive; test-first fits.
2. **`codebase-design`** — when placing the model-access module seam (deep module vs growing `identity.ts`).
3. **`domain-modeling`** — if glossary terms drift while coding; keep `CONTEXT.md` clean of implementation detail.
4. **`diagnosing-bugs`** — if dual-write or session ACL/run regressions appear.
5. **`impeccable`** — only when polishing offering editor / picker UX after behavior works.
6. **Do not** re-run full **wayfinder chart** unless scope blows up; optionally **wayfinder work-through** for ticket 01 if human wants formal ADR accept first.
7. **`grilling`** — only for open `.scratch` decisions that block the current phase.

---

## Success for the next agent

- Phase 1 exit criteria in the plan met (or a clear PR-sized slice toward them with tests).
- No secrets in GET lists / transcripts.
- Legacy `connectionId` + upstream `modelId` selection still works where offerings aren’t configured (Desktop Local / migration read path).
- Docs phase checkboxes updated when work lands; ADR status left `proposed` until human accepts unless they say to mark `accepted`.

---

## Conversation residue (not in docs)

- Human disliked current auth/providers flexibility; compared an external review that over-focused on provider laundry list and underweighted multi-user identity—prefer ADR 0014 framing.
- Custom model slugs (“Company Model”) were the concrete hook that crystallized **offerings**.
- Human explicitly asked to **stop grilling and write docs**, then **handoff to implement**.
