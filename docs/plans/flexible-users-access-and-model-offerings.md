# Plan: Flexible users, access, and model offerings

Companion to [ADR 0014](../adr/0014-flexible-users-access-and-model-offerings.md). Builds on [ADR 0011](../adr/0011-host-embedded-accounts-and-teams.md), [ADR 0012](../adr/0012-host-path-grants-and-tool-enforcement.md), [ADR 0013](../adr/0013-multi-user-host-access-model.md), and plans [`host-identity-and-teams.md`](./host-identity-and-teams.md), [`multi-user-host-access.md`](./multi-user-host-access.md).

## Status

Design proposed. Implementation not started.

## North star

**Branded Host for others.** Operators configure backends and **Model offerings** (e.g. slug `company-model`, name “Company Model”). Members pick offerings, use granted paths, keep private Sessions by default. Raw upstream ids and provider key plumbing stay owner/admin concerns unless BYOK is explicitly allowed.

## Fixed decisions (from ADR 0014)

| Topic                       | Decision                                                                   |
| --------------------------- | -------------------------------------------------------------------------- |
| Deliverable of design track | ADRs + glossary + this plan (then build phases)                            |
| Scope                       | Host identity, authorization, model access, **UI**                         |
| Threat model                | Trusted-circle Host (ADR 0013); not hostile multi-tenant                   |
| Object split                | **Model backend** + **Provider credential** + **Model offering**           |
| Selection / entitlements    | Offerings (slugs) on multi-user Hosts                                      |
| Resolve time                | Host prompt path only                                                      |
| Planes                      | host \| team \| user unchanged                                             |
| BYOK/BYOS                   | Credential kinds + deny-beats-allow policy                                 |
| Roles                       | owner \| admin \| member \| viewer + capability bits                       |
| Team                        | Default Team remains; named Teams later without grant-shape rewrite        |
| Collab run                  | User or Team grantee ≥ run + pin + entitlement; no Team-share-only footgun |
| Host login                  | Password now; pluggable Host auth methods designed in                      |
| Secrets                     | Never in transcripts/UI lists; custody upgrade ≠ model change              |
| Desktop Local               | Account-free; offerings optional                                           |
| UI tone                     | Calm; i18n en/de/es                                                        |

## Non-goals (this program)

- Per-user VM/container isolation or bubblewrap requirement
- Central OpenGUI cloud accounts as the only identity
- Realtime collab UX (presence/cursors/CRDT)
- Full enterprise IAM (SCIM, HRIS sync) in first build phases
- HMAC/request-signing marketplace as phase-1 requirement
- Budget metering / spend caps (record as future entitlement attribute only)
- Replacing the four native tools or Harness Session store

## Current baseline (honest)

| Area       | Today                                                   | Gap                                                        |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| Host login | Username/password via Better Auth                       | No OIDC/passkey/magic link product path                    |
| Roles      | owner \| member + `canInvite`                           | No admin/viewer; most gates are owner-only                 |
| Team       | Hardcoded `host_default`                                | No named groups                                            |
| Sessions   | ACL + view links                                        | `run` enforcement overly Team-centric                      |
| Models     | Connection list + apiKeys map + Codex/xAI special cases | No offering/slug; dual-write identity↔host JSON; preset UI |
| Secrets    | Plaintext JSON 0600                                     | No keychain/encrypt; OAuth host-global slots               |
| UI         | TeamSettings + SettingsProviders cards                  | No backend/offering editors; weak entitlements UX          |

## Target architecture

```text
Frontend
  ├─ Identity gate (setup/login/register/invite; later Host auth methods)
  ├─ Model picker ← entitled Model offerings (+ personal backends if allowed)
  ├─ Session share UI ← ACL matching Host enforcement
  └─ Host admin: members, paths, backends, offerings, entitlements, auth methods
        │
        ▼
Host application services
  ├─ Identity & authz     (Accounts, membership, capabilities, session ACL, path policy)
  ├─ Model access         (backends, credentials, offerings, resolve+authorize)
  └─ Product routes / SSE / Harness (unchanged Session authority)
```

### Model resolve path

```text
SelectedModel { offeringId: "company-model" }  // multi-user
        │
        ▼
authorize(actor, offeringId, action=use)
        │
        ▼
offering.route → { backendId, upstreamModelId, protocol? }
        │
        ▼
load backend + credential strategy → transport.stream(model=upstreamModelId)
```

Desktop Local may keep `{ connectionId, modelId }` wire shape with `modelId` as upstream until offerings exist; multi-user remote should migrate selection to offering slugs.

### Suggested durable shapes (illustrative)

```text
model_backend
  id, plane, owner_type, owner_id, label, base_url,
  default_protocol, auth_strategy, created_at, ...

provider_credential
  id, backend_id?, plane, owner_*, kind,  # secret material in host secret store by id
  oauth_client_ref?, meta_json, ...

model_offering
  id (slug), display_name, description?,
  plane, backend_id, upstream_model_id, protocol_override?,
  capabilities_json, created_by, created_at, ...

model_offering_entitlement
  offering_id, subject_type, subject_id, ...
```

Migration: existing `modelConnections[]` + `apiKeys` + identity `host_model_connection` rows become backends + credentials; each former `modelId` can auto-mint an offering `slug = modelId` with `displayName` from capabilities when present.

## UI plan

### Principles

- Owner configures **intent** (offerings, grants); members see **results** (names, not plumbing).
- Never show secret values after save; show “configured” state + rotate.
- Test connection before enable when auth is API key/URL.
- Hide Desktop-only device settings on web (already ADR 0013).
- All new strings in `en` / `de` / `es`.

### Surfaces by phase

| Phase | UI                                                                               |
| ----- | -------------------------------------------------------------------------------- |
| 1     | Offering list/editor; picker shows offerings; owner “routes to …” detail         |
| 2     | Backend editor replacing raw preset-only flow; auth strategy fields; test button |
| 3     | Role/capability controls in Team settings; session share copy fixed for run      |
| 4     | Host auth method settings; login screen method picker                            |
| 5     | Entitlement matrix polish; optional named Teams; API key scopes UI               |

### Wireframes (textual)

**Offering editor (owner/admin)**

- Display name: `Company Model`
- Slug: `company-model` (immutable after create, or rename with redirect policy—default immutable)
- Backend: select Host backend
- Upstream model: `gpt-4.1` (or discover)
- Capabilities: context/reasoning overrides optional
- Entitlements: Team default on/off; add users

**Member picker**

- Group by Provider label or flat list
- Rows: display name only; subtitle optional (“Fast”) not upstream id unless entitled debug

## Implementation phases

### Phase 0 — Docs and vocabulary

- [x] ADR 0014 proposed
- [x] This plan
- [x] Glossary terms in `CONTEXT.md`
- [x] ADR index + architecture pointers
- [ ] Accept ADR 0014 after review (status → accepted)
- [ ] Wayfinding residual tickets resolved or explicitly deferred

### Phase 1 — Model offerings (vertical slice)

**Goal:** “Company Model” works on current API-key backends.

- [ ] Identity tables (or equivalent) for offerings + entitlements
- [ ] Model access service: create/update/list offerings; resolve slug → backend+upstream
- [ ] Migrate/link existing connections to backends; auto-offerings per model id
- [ ] Prompt/setModel authorize on offering id; pin collab to shared offering/backend
- [ ] Picker + Settings UI for offerings
- [ ] i18n
- [ ] Tests: entitlement deny, resolve, collab pin rejects user-plane credential, migration smoke

**Exit:** Member with team entitlement sees “Company Model”, runs against upstream; no upstream id required in picker.

### Phase 2 — Backend auth flexibility + custody

**Goal:** Connections are real backends with strategies; fewer hardcoded cards.

- [ ] Auth strategy on backend (`bearer`, `header`, `device_oauth` config, `env`)
- [ ] Generic device-OAuth wiring from config (Codex/xAI become templates)
- [ ] Transport uses strategy (keep Anthropic route `x-api-key` as strategy/preset)
- [ ] Single model-access write path (no half identity / half host state)
- [ ] Test-connection API
- [ ] Optional: encrypt secrets at rest or OS keychain on Desktop
- [ ] Retire unused `src/types/provider.ts` fossils in favor of protocol types
- [ ] Tests: header strategy, oauth template, dual-store invariant

**Exit:** Custom OpenAI-compatible + header-auth backend without code change; Codex/xAI not special-cased in Host class beyond presets.

### Phase 3 — Roles, capabilities, session run fix

**Goal:** Access control matches ADR 0014 without full SSO.

- [ ] Persist `admin` / `viewer` (or capability bundles); migration from member
- [ ] Replace blanket `requireOwnerUser` with capability checks where admin should act
- [ ] Fix session `run` authorization (user grant + pin + entitlement)
- [ ] API key scope field (even if only role-equivalent at first)
- [ ] Team settings UI for roles/capabilities
- [ ] Tests: admin model manage, viewer limits, user-run share

**Exit:** Operator can delegate model/member admin without sharing owner; session share run works for a named user.

### Phase 4 — Host auth methods

**Goal:** Flexible **Host** login, still embedded.

- [ ] Auth method registry on Host (password required-or-optional policy)
- [ ] OIDC login path (generic); optional magic link if SMTP configured
- [ ] Passkeys spike go/no-go
- [ ] Login UI method picker; invite accept still creates Account
- [ ] Docs: Docker/self-host auth configuration
- [ ] Tests: OIDC account link, disable password side effects, invite+OIDC

**Exit:** A Host can enable at least password + one external method without central OpenGUI IdP.

### Phase 5 — Harden multi-user product

**Goal:** Named Teams (optional), entitlement UX, polish.

- [ ] Named Team principals (if still needed after admin/capabilities)
- [ ] Entitlement matrix UI; default offerings for new members
- [ ] Registration domain allowlist (optional policy)
- [ ] Audit events for offering/backend changes
- [ ] PERFORMANCE/privacy pass on picker and admin
- [ ] Docs + acceptance checklist below green

**Exit:** Trusted-circle Host can be operated day-to-day without SQLite surgery.

## Module deepening (implementation guidance)

Prefer deep modules ([codebase-design](../../CONTEXT.md) vocabulary):

| Module         | Hard problem                                                            | Hide                                         |
| -------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| Model access   | Resolve+authorize offering; credential strategies; dual store invariant | SQLite/JSON layout, transport header details |
| Identity authz | Membership capabilities; session ACL; actor resolve                     | Better Auth internals                        |
| Path policy    | Already exists                                                          | keep                                         |

Avoid growing `identity.ts` and `SettingsProviders.tsx` as dump sites—new UI feature folders under `src/features/`.

## Migration notes

1. **Read path:** If offering missing, treat `connectionId/modelId` as legacy selection and resolve modelId as upstream on that backend.
2. **Write path:** New Sessions on remote identity Hosts store offering id when picker is offering-based.
3. **Entitlements:** Copy connection-level team entitlements onto auto-minted offerings during migration.
4. **OAuth tokens:** Remain backend-scoped credentials; plane metadata must catch up so user BYOS is not a second global slot by accident.
5. **No silent permission widen:** Migration must not grant members new offerings that old entitlements would have denied.

## Acceptance checks

1. Owner creates offering “Company Model” → `gpt-4.1` on a Host backend; member without entitlement cannot see or use it.
2. Member with entitlement selects “Company Model”; transcript/selection stable if owner switches upstream to another model id on same offering.
3. Personal BYOK offering/backend never becomes collab pin; collab run works for user-level session share when entitled to pinned shared target.
4. Admin (non-owner) can manage offerings when capability allows; viewer cannot.
5. Web UI never shows Desktop device settings; secrets never reappear in GET lists.
6. Desktop Local still works Account-free with direct backend models if no offerings configured.
7. i18n keys present for en/de/es for all new user-facing strings.
8. `pnpm run check` / tests for identity and model-access green; slop-check if Host routes change.

## Documentation touch list

| Doc                                          | Change                                               |
| -------------------------------------------- | ---------------------------------------------------- |
| [`CONTEXT.md`](../../CONTEXT.md)             | Offerings, backend, credential strategy; role terms  |
| [`docs/adr/README.md`](../adr/README.md)     | Index 0014                                           |
| [`docs/architecture.md`](../architecture.md) | Pointer to 0014 + this plan                          |
| [`docs/docker.md`](../docker.md) / self-host | Auth methods when Phase 4 lands                      |
| [`PRODUCT.md`](../../PRODUCT.md)             | Only if multi-user principles need offering language |
| Wayfinding map                               | `.scratch/flexible-users-and-access/map.md`          |

## Open items tracked on the map

Residual decisions and research stay on the wayfinding map (not silently decided here):

- Exact slug immutability / rename policy
- Whether picker groups by backend label vs flat offerings
- Passkeys go/no-go after spike
- Secret custody: encrypt vs keychain vs both
- Named Teams timing vs capability-only admin

See `.scratch/flexible-users-and-access/`.
