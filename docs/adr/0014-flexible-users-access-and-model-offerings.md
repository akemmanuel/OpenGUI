# Flexible users, access, and model offerings

OpenGUI already has Host-embedded Accounts ([ADR 0011](./0011-host-embedded-accounts-and-teams.md)), path grants ([ADR 0012](./0012-host-path-grants-and-tool-enforcement.md)), and a multi-user access model ([ADR 0013](./0013-multi-user-host-access-model.md)). What shipped is a solid **foundation** with too few **product options**: binary Host roles, a singleton Team costume, password-only Host login, OpenAI-compatible connections plus two hardcoded OAuth flows, and no user-facing model slug distinct from the upstream vendor model id.

This ADR decides the target shape for a flexible **users and access** system—including UI—so implementation can proceed in phases without reopening core seams.

## Status

accepted

Accepted by implementation on 2026-07-28. The merged vertical slice includes model offerings and
entitlements, Host-side offering resolution, `admin` / `viewer` roles, direct-user collaborative
`run` authorization, backend-oriented settings, and the corresponding integration tests. Evidence:
implementation commit `28ca43c`, the
[`flexible users and model offerings` plan](../plans/flexible-users-access-and-model-offerings.md),
and `packages/backend/src/identity/roles-model-offerings.integration.test.ts`. Later
auth strategies, Host login methods, secret-custody upgrades, and named Teams remain phased work;
they do not reopen the object and authorization boundaries decided here. In particular, this
acceptance does not claim that deferred plan phases 2, 4, or 5 have shipped.

## North star

**Branded Host for others (default).** An operator runs a Host for a trusted circle (friends, family, clients). Members see calm, intentional choices—**Company Model**, granted paths, private Sessions by default—not raw vendor key plumbing. Power-user multi-backend and enterprise SSO remain supported paths, not the primary story.

Where prior conversation left the north star unspecified, this default applies until superseded in the companion plan.

## Decision

### Three planes of “access” (keep separate)

| Plane             | Question                                    | Objects                                                    |
| ----------------- | ------------------------------------------- | ---------------------------------------------------------- |
| **Host identity** | Who may use this Host?                      | Account, Host credential, membership, Host auth methods    |
| **Authorization** | What may they do here?                      | Capabilities, path grants, session ACL, model entitlements |
| **Model access**  | Which models exist and how are they called? | Model backend, Provider credentials, Model offering        |

Do not collapse Host login secrets with Provider credentials. Do not treat Model connection labels as the only user-facing model identity.

### Domain objects

#### Host identity (extends 0011/0013)

- **Account**, **Host credential**, **Actor**, **invite**, **registration mode**, and Desktop Local bypass remain as in ADR 0011/0013.
- **Host role** expands beyond binary `owner` \| `member` to a small fixed set that can grow without rewrite:
  - **`owner`** — full Host control; unique primary owner remains (transfer is an explicit operation).
  - **`admin`** — members/invites (per policy), path grants, model backends/offerings on Host/Team planes, not ownership transfer or Host destroy.
  - **`member`** — use entitled resources; optional `canInvite` remains a capability bit.
  - **`viewer`** — read-oriented Host use where product surfaces allow (session view grants still refine per Session).
- Prefer **capabilities** on membership (`canInvite`, later `canManageModels`, …) over an explosion of roles. Roles are bundles of default capabilities.
- **Team** remains a share principal on one Host. v1 keeps a Host default Team; **named Teams/groups** are allowed later as additional principals without changing grant object shapes (`grantee_type: user \| team`).
- **Host auth methods** are pluggable configuration on the Host, not a central OpenGUI IdP:
  - v1 shipped: username + password (Better Auth).
  - Designed next: magic link / email OTP (optional SMTP), passkeys, OIDC/OAuth login to the **Host** (Authentik, Keycloak, Google, …).
  - Enabling a method is Host policy; password may remain for break-glass owner.

#### Authorization (extends 0012/0013)

- Explicit shares only; membership never implies path, model, or session access (ADR 0013).
- **Session** ownership + ACL (`view` \| `run` \| `admin` \| `owner`) and view-only links remain.
- **Fix collab `run` semantics:** a grantee with session role ≥ `run` may run when they are entitled to the Session’s **pinned shared model target** (Host/Team backend or Host/Team offering). User-plane personal credentials stay solo-only and cannot be the collab pin. Team-only share must not be required if a direct user grant already carries `run`.
- Path grants stay the mediation mechanism for file/product surfaces; shell isolation remains a later sandbox ADR.
- **Host API keys** gain optional **scopes** over time (e.g. sessions read, model use, admin). v1 scopes may mirror role bundles; path grants on keys remain.

#### Model access (new split)

Replace the overloaded “connection = picker entry = credential = upstream id” bundle with three objects:

1. **Model backend** (rename of durable **Model connection** configuration)
   - How the Host calls a provider endpoint: base URL, protocol route defaults, auth binding, transport hints.
   - Lives on a **plane**: `host` \| `team` \| `user` (ADR 0013).
   - Does **not** define the member-facing catalog by itself.

2. **Provider credential**
   - Secret material bound to a backend (or to a plane-owned credential slot the backend references).
   - Kinds: API key/token, OAuth/subscription tokens (BYOS), env-sourced reference, future plugin kinds.
   - Auth **strategy** is data, not hardcoded React cards: e.g. `bearer`, `header` (named header), `api_key_query` (discouraged), `device_oauth` (RFC 8628 config), `env`.
   - Custody: Host process holds secrets; product APIs never echo them; owner/admin cannot read user-plane secret values. Encryption-at-rest / OS keychain are implementation upgrades on the same object model.

3. **Model offering** (new)
   - User-facing catalog entry: stable **slug** (`company-model`), **display name** (“Company Model”), capabilities presentation, optional description.
   - **Route** resolves at prompt time on the Host:
     - `backendId` + `upstreamModelId` + optional protocol route override.
   - Sessions, picker selection, and entitlements speak in **offering ids (slugs)** on multi-user Hosts.
   - Desktop Local / single-user may continue to expose backend+upstream directly; offerings are still the recommended owner tool for branded menus.
   - Entitlements attach to offerings (and/or backends for admin). Granting `company-model` does not require exposing `gpt-4.1` in the picker.
   - Changing an offering’s upstream target does not rewrite historical Session selection ids; transcripts keep the slug; debug/owner UI may show resolved upstream.

**BYOK / BYOS** remain credential _kinds_ and policy flags (deny beats allow). They are not a substitute for plane or offering.

**Provider** in the UI sense is a grouping label (vendor or backend name). It is not an executable Harness and not an Account.

### Storage and module boundaries

- **Identity SQLite** continues to own: Accounts/membership, invites, API keys, path grants, session ACL/links, registration/model policy flags, **offering records**, **entitlements**, backend plane/ownership metadata.
- **Host durable state** owns: backend endpoint config needed to dial, credential ciphertext/slots, OAuth client config for device flows.
- Dual-write is acceptable only behind **one Host application service** (“Model access service”) that updates identity metadata and secret/endpoint state atomically from the product’s point of view (transaction across stores or compensate-on-failure with clear invariants). Callers must not touch only one half.
- Prefer evolving today’s `IdentityService` + `OpenGuiHost` split toward deeper modules rather than growing the god class: identity/authz, model-access, path-policy.

### UI surfaces (in scope for design)

Three buckets remain (ADR 0013); this ADR adds model-access clarity:

1. **Device / shell** (Desktop only) — unchanged.
2. **User prefs** — theme, language, default offering behavior.
3. **Host admin** — members/roles/capabilities, invites/registration, path grants, **backends**, **offerings**, entitlements, Host auth methods, BYOK/BYOS policy, API keys.

Member UX:

- Model picker lists **entitled offerings** (and permitted personal backends if policy allows).
- Settings expose personal backends/keys only when BYOK/BYOS allowed.
- Session share dialog matches enforced ACL (including fixed `run` rules).

Owner/admin UX:

- Backend editor (endpoint + auth strategy + test connection).
- Offering editor (slug, name, route target, visibility).
- Entitlement matrix simplified: per offering → users/teams (start with team toggle + per-user grants; full matrix can phase).

Tone: calm, existing shell patterns, full i18n (`en` / `de` / `es`) for new copy ([`PRODUCT.md`](../../PRODUCT.md)).

### Phased delivery principle

Design is decision-complete here; **build is phased** in the companion plan. No phase may ship security-theater UI (e.g. folder ACL without enforcement, offering entitlements without Host-side resolve).

## Considered options

- **Display-name-only renames on upstream ids:** rejected; entitlements, selection keys, and collab pins stay vendor-coupled.
- **One custom connection per alias with upstream-equal slug:** rejected as requiring external proxies and colliding with real model ids.
- **Keep connection-as-catalog forever:** rejected; blocks branded Hosts and clean entitlements.
- **Central OpenGUI identity cloud:** rejected for v1 self-host/airgap (ADR 0011 stands).
- **Hostile multi-tenant isolation / per-user containers:** rejected (ADR 0013 threat model).
- **Implement pluggable OAuth/HMAC/budgets before offerings:** rejected as priority; offerings+planes deliver operator value on today’s API-key backends first.
- **Fair equal-weight rewrite of identity and models with no north star:** rejected; branded Host orders the design.

## Consequences

- ADR 0011–0013 remain foundations; this ADR **extends** them (roles/capabilities, model object split, Host auth method slots, UI expectations) and **narrows** ambiguous collab `run` behavior.
- Glossary gains **Model backend**, **Model offering**, **Provider credential** strategy language; “Model connection” becomes the legacy/umbrella term during migration.
- Implementation plan: [`flexible-users-access-and-model-offerings.md`](../plans/flexible-users-access-and-model-offerings.md).
- Dead frontend types (`ProviderAuth` in `src/types/provider.ts` unused) should be replaced by protocol-level types owned with the model-access module—not revived ad hoc.
- Research and residual open questions live on the wayfinding map under `.scratch/flexible-users-and-access/`.

## Superseded / narrowed guidance

- Treating **modelIds on a connection** as the only catalog: superseded by **Model offerings** for multi-user and branded menus.
- Session collab `run` requiring a **Team** share even when a user was granted `run`: narrowed to entitlement + pin rules above.
- Provider settings as an unstructured list of preset cards only: narrowed toward backend + offering editors (presets become backend templates).
