# Plan: Host-embedded Accounts and Team membership

Companion to [ADR 0011](../adr/0011-host-embedded-accounts-and-teams.md). Canonical product language: [`CONTEXT.md`](../../CONTEXT.md).

## Status

Implemented through Phase 4. Path grants remain opt-in with enforcement disabled by default.

## Fixed product constraints

| Constraint          | Decision                                                            |
| ------------------- | ------------------------------------------------------------------- |
| Collaboration unit  | Team = people who share **one** Host                                |
| Identity placement  | Embedded in each Host; no central issuer in v1                      |
| Local Desktop       | Never requires an Account                                           |
| Remote Host         | Always Accounts after setup                                         |
| Login               | **Username + password**; Account also has unique **email**          |
| Bootstrap           | First user becomes **owner**; then **invite-only**                  |
| Automation          | Named **Host API keys**; not `OPENGUI_AUTH_TOKEN` as product login  |
| Roles v1            | **`owner`** + **`member`** only                                     |
| Sessions            | **Shared** among all members; Host arbitration unchanged            |
| Collab UX           | **No** realtime presence/cursors/CRDT in this plan                  |
| Path ACL v1         | **Not enforced**; do not ship folder-permission security UI         |
| Path ACL north star | Hard tool enforcement in a **later** plan/ADR                       |
| Model credentials   | Host-owned; **owner** configures; members use; never in transcripts |
| UI tone             | Existing calm setup/dialog patterns; full i18n (`en` / `de` / `es`) |

## Non-goals

- Central OpenGUI cloud accounts or cross-Host SSO
- Multi-Team or multi-tenant unrestricted shell on one OS account
- Realtime collaboration product features
- Per-folder / Project security enforcement or read-only path UX in v1
- Forced login on Desktop Local Host
- Email + password as the login identifier
- Email verification or SMTP as a hard dependency
- Per-Session ACLs or Session “ownership” locks
- Replacing Model connection OAuth / API key flows with user login
- Public SDK changes for identity

## Target architecture

```text
Frontend (Web / Desktop remote / Mobile)
  │  setup / login / invite accept  →  /api/auth/* , /api/identity/*
  │  product APIs + SSE             →  Authorization: Bearer <Host credential>
  ▼
OpenGUI Host (@opengui/backend)
  ├─ Identity module (Better Auth spike + invites + API keys + Actor)
  ├─ Authorize middleware (session | api_key | local bypass)
  ├─ Product routes (sessions, prompts, queue, models, fs)
  └─ OpenGUI Harness (unchanged trust: unrestricted tools for authenticated actors)
```

### Cardinality (v1)

```text
1 Host ──1── Team ──*── Members (Accounts + role)
                ├──*── Invites
                └──*── Host API keys
Sessions: visible and controllable by every Member
Workspace: Frontend connection record only (may store Host credential)
```

### Setup state machine (Remote Host)

| State      | Behavior                                                                                |
| ---------- | --------------------------------------------------------------------------------------- |
| `no_owner` | Public: health, static UI, **setup** (create owner). Product APIs unauthorized.         |
| `ready`    | Public: health, auth routes, invite accept. All other `/api/*` require Host credential. |

`/api/health` (and `/api/host/health` if present) stay reachable and report identity state, e.g. `{ identity: "setup" \| "ready", authRequired: true }`.

### Actor

Every authenticated request resolves an **Actor**:

| Field         | Meaning                        |
| ------------- | ------------------------------ |
| `type`        | `user` \| `api_key` \| `local` |
| `id`          | Account id or API key id       |
| `displayName` | Username or key label          |
| `role`        | `owner` \| `member`            |

Local Desktop IPC uses `type: local` (or equivalent bypass) without Account tables.

Mutations that accept user intent (prompt, follow-up, interrupt, rename, delete session, etc.) persist actor attribution on durable entries where applicable.

### Credential types

| Credential                  | Use                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Account session             | Interactive Frontend after username/password login (cookie same-origin and/or bearer for native/cross-origin) |
| Host API key                | Automation, scripts, break-glass; `ogui_…` prefix; hash at rest; role bound                                   |
| Legacy `OPENGUI_AUTH_TOKEN` | Upgrade only until owner setup completes; then reject                                                         |

### Roles (v1 matrix)

| Action                                             | owner | member |
| -------------------------------------------------- | ----- | ------ |
| Setup (only if no owner)                           | —     | —      |
| Login / logout / me                                | yes   | yes    |
| Create/revoke invites                              | yes   | no     |
| List/kick members, reset member password           | yes   | no     |
| Mint/revoke API keys                               | yes   | no     |
| Configure model connections / provider secrets     | yes   | no     |
| List/create/use Sessions, prompt, queue, interrupt | yes   | yes    |
| Read transcripts / SSE                             | yes   | yes    |

## Better Auth

**Default:** embed Better Auth in the Host identity module.

**Spike go/no-go (1–2 days) before committing:**

- [x] Username + password sign-in with email stored unique on user
- [x] Disable public sign-up; only setup creates users in Phase 1
- [x] Session usable as Bearer on product routes
- [x] Mount cleanly on Hono beside existing `/api/*`
- [x] Separate identity SQLite file

**If spike fails:** keep argon2/bcrypt password hashing + Host-owned session table; do not force a bad BA fit.

**Team model:** single implicit Team per Host (`host_default`). Prefer thin membership tables over a full multi-org product surface unless the organization plugin fits with almost no UI.

## Package / code map (intended)

```text
packages/backend/src/
  identity/
    auth.ts           # Better Auth (or fallback) instance
    setup.ts          # first owner
    invites.ts
    api-keys.ts
    actor.ts
    roles.ts
    db.ts             # identity sqlite path + migrations
  http/
    authorize.ts      # Actor resolution; CORS helpers may stay in cors-auth.ts
  routes/
    identity.ts       # setup, members, invites, keys, mount /api/auth/*

src/features/identity/   # Frontend
  auth-client.ts
  useHostSession.ts
  SetupScreen.tsx
  LoginScreen.tsx
  InviteAcceptScreen.tsx
  TeamSettings.tsx
```

Frontend Host transport continues to go through existing client paths; Workspace `authToken` (or successor field) holds the Host credential for remote shells. Run `pnpm run slop-check` when Host routes or Frontend Host transport change.

## Phases

### Phase 0 — Spec

- [x] ADR 0011
- [x] This plan
- [x] `CONTEXT.md` terms
- [x] `docs/adr/README.md` index row
- [x] `docs/architecture.md` pointer
- [x] `docs/docker.md` stub note (full rewrite in Phase 2)

**Exit:** contributors share one vocabulary and trust model.

### Phase 1 — Setup, login, authorize

- [x] Identity DB + Better Auth spike (go/no-go)
- [x] First-owner setup endpoint + single-use lock
- [x] Login / logout / session me
- [x] `authorize` middleware: require Actor on remote product APIs; local bypass; health public
- [x] Health payload includes identity state
- [x] Web Frontend: setup + login gates when remote and `setup`/`ready`
- [x] Desktop Local: no gate
- [x] Tests: setup once, 401 without creds, login success, local bypass unchanged
- [x] Owner can mint first API key via API (UI may wait for Phase 2)

**Exit:** Remote Host refuses anonymous product API use after setup; owner can use the app end-to-end with username/password.

### Phase 2 — Invites, members, API keys, docs

- [x] Create/list/revoke invites; accept invite (username, password, email)
- [x] Member list; remove member; owner reset member password
- [x] API keys UI: create (show once), list, revoke
- [x] After owner exists: reject `OPENGUI_AUTH_TOKEN`
- [x] Upgrade path: token allowed only in `no_owner`
- [x] Update deployment and architecture documentation
- [x] i18n for all new UI strings

**Exit:** owner invites a second human; both share Sessions; revoke and key rotation work.

### Phase 3 — Actor attribution + shared-Session UX

- [x] Persist actor on user messages / relevant control entries
- [x] Transcript and queue UI show actor display names (“you” vs others)
- [x] Lightweight auth audit log (login failures, revokes, key mint); owner-user-only API,
      cursor pagination (maximum 100 rows/page), and newest 10,000 events retained
- [x] Tests for actor stamp on prompt path

**Exit:** shared Host is intelligible as multi-user without realtime collab features.

### Phase 4 — Path grants (separate initiative)

Companion decision: [ADR 0012](../adr/0012-host-path-grants-and-tool-enforcement.md).

Foundation:

- [x] `OPENGUI_PATH_GRANTS=disabled|enforced`, default disabled
- [x] Idempotent grant schema, atomic subject replacement, cleanup, and policy revision
- [x] Owner-user-only user/API-key list and replace routes
- [x] Canonical containment and no-symlink traversal policy helpers with focused tests
- [x] Effective actor policy and canonical Project visibility interfaces for later injection
- [x] Identity feature status in `me`

Enforcement and product exposure:

- [x] Inject policy into HTTP filesystem/product routes and uploads
- [x] Inject policy into RPC, private transport, and SSE paths
- [x] Mediate every Harness `read` / `write` / `edit` call
- [x] Disable `shell` for restricted actors at the model and Harness boundaries
- [x] Filter Session list/open/create and direct-ID operations by canonical Project path
- [x] Add adversarial bypass tests across transports and tools
- [x] Add owner grant UI only when the Host reports enforcement ready

**Do not** merge folder-permission checkboxes that `shell` can bypass.

## Migration

| Deploy state                 | Behavior                                                          |
| ---------------------------- | ----------------------------------------------------------------- |
| Fresh Remote Host            | Setup → owner; no env token path                                  |
| Existing token, no owner yet | Allow setup; optionally accept legacy token until setup completes |
| Owner exists                 | Bearer must be session or API key; env token rejected             |
| Desktop Local only           | No identity required                                              |

## Threat model (v1)

**Protected**

- Anonymous internet clients cannot use product APIs on a ready Remote Host
- Per-person and per-key revocation
- Distinct actors on shared Sessions
- No shared password as the primary team join story

**Accepted (document in ops docs)**

- With path grants disabled, any `member` remains a full operator of the Host process
- With path grants enforced, portable path checks do not defend against a cooperating same-OS-user process racing filesystem topology
- Invite link secrecy depends on HTTPS and link handling
- Without SMTP, recovery is owner-driven password reset

**Guidance:** bind partially trusted Team Hosts to private networks/VPN; treat members as fully trusted on that machine.

## Testing strategy

- Unit: actor resolve, invite expiry/single-use, API key hash/verify, setup once, role guards
- Integration (`packages/backend`): health identity states; setup → login → session list; invite second user; revoke → 401; API key access; env token rejected when ready
- Frontend: remote gate; local bypass; invite accept
- `pnpm run slop-check` on Host route / transport edits
- Manual: `pnpm run dev:web` combined Host; Desktop local; Desktop + remote Host login

## Acceptance checklist

- [x] Remote Host: anonymous `/api/capabilities` is 401 after setup
- [x] Setup creates exactly one owner; second setup fails
- [x] Username/password login works; email is not required to type at login
- [x] Invite link adds a member who sees shared Sessions when grants are disabled
- [x] Owner revokes member; credential stops working
- [x] API key can call product API; revoke stops it
- [x] `OPENGUI_AUTH_TOKEN` is not documented as login and does not work when ready
- [x] Local Desktop never shows a mandatory login wall
- [x] Actor names appear on prompts from different members
- [x] Path-grant UI appears only when complete enforcement is active
- [x] en/de/es strings present for identity and path-grant UI
- [x] ADR 0010 unrestricted tools remain unchanged unless ADR 0012 enforcement is active

## Open follow-ups (not blocking Phase 0–3)

- Password reset email when SMTP configured
- Owner transfer / Host reset
- `admin` / `viewer` roles
- OpenGUI-hosted provisioning still one isolated Host per customer Team
