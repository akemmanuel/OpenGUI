# Host-embedded Accounts and Team membership

Remote OpenGUI Hosts today authenticate Frontends with a single shared secret (`OPENGUI_AUTH_TOKEN` / Bearer). That grants full Host power to anyone who knows the secret and provides no durable notion of who acted. Team collaboration on a shared Host needs real Accounts, invite-only membership, and automation credentials—without turning the Host into a multi-tenant execution plane or a central OpenGUI identity cloud.

## Status

accepted

## Decision

### Collaboration unit

- A **Team** is the set of people who share **one** OpenGUI Host. v1 does not introduce a cloud organization that spans many Hosts.
- **Workspace** remains Frontend-owned connection and presentation state for one Host. It is not Team identity and must not become the membership store.
- OpenGUI-hosted deployments continue to isolate customers at the **infrastructure** boundary (one unrestricted OS/container/VM environment per customer). Accounts and Teams never multiplex unrelated customers onto one unrestricted Host process.

### Where identity lives

- Account identity is **embedded in each Host** (same Host process / deployment). There is no central OpenGUI issuer in this ADR.
- Desktop **Local Host** does **not** require an Account. The OS user trusts the local process (existing private transport). Sign-in applies when connecting to a **Remote Host**.

### When Accounts are required

- Every **Remote Host** (Web Shell origin Host, self-hosted, OpenGUI-hosted, and any remote Workspace connection) uses **Accounts** after setup. Shared-secret login is not the normal product path.
- **First user on an empty Host** completes one-time **setup** and becomes **owner**. After that, Account creation is **invite-only** (no public sign-up).

### Credentials

- An **Account** has a unique **username** and a unique **email**. **Login is username + password.** Email is for identity, invites, and future recovery—not the login identifier in v1.
- Email verification is **not** required in v1. SMTP is optional; **invite links** are the primary join path.
- Product and automation access to Host APIs use a **Host credential**: an Account session token (or same-origin session cookie) or a **Host API key**.
- **`OPENGUI_AUTH_TOKEN` is not a product login mechanism.** Named, revocable **Host API keys** (secret shown once, stored hashed) replace env shared secrets for automation and break-glass. Upgrade may accept the legacy env token only until owner setup completes; afterward it must be rejected.
- Prefer `Authorization: Bearer` for Host product APIs (including SSE). Do not rely on long-lived secrets in query strings.

### Roles (v1)

- Roles are **`owner`** and **`member`** only.
  - **Owner**: members, invites, API keys, Host settings, Model connection / provider credential configuration.
  - **Member**: full use of Sessions, prompts, queues, and tools on that Host; cannot manage membership or Host identity settings.
- Role enum and storage must allow later `admin`, `viewer`, and path grants without a rewrite.
- Host API keys carry a role no higher than the minting owner's grant policy (v1: owner mints `owner` or `member` keys).

### Shared Sessions (not realtime collab)

- All members of a Team Host **share Sessions** on that Host: list, open, prompt, queue, and interrupt subject to ordinary Host arbitration.
- v1 does **not** ship realtime collaboration product features (presence, cursors, CRDT, pair-programming UX).
- Mutating Host actions record an **Actor** (`user` or `api_key`, id, display name) on relevant durable Session entries so shared transcripts are attributable.
- v1 does **not** implement per-Session ACLs or per-member Session ownership locks.

### Trust model and path authorization

- **v1 trust model: trusted Team on a private Host.** Any authenticated member has the same unrestricted tool power the Host already exposes (`read` / `write` / `edit` / `shell` under Host roots). Authentication answers _who may use this Host_, not _which paths_.
- **Per-folder / Project path grants with hard tool enforcement** are an explicit **later** goal, not v1. Until the Harness mediates every tool (including a coherent `shell` policy), the product **must not** present folder permissions as security.
- Projects remain directory-backed work targets. They are **not** a security boundary in identity v1 (consistent with unrestricted Host tools).
- Provider credentials stay Host-side. Members use them; they must not appear in Session entries, tool output, or Frontend persistence. Owner configures them in v1.

### Implementation direction

- Prefer **Better Auth** embedded in `@opengui/backend` (or a small Host-local identity module it owns) for password hashing and session lifecycle, with a short spike go/no-go. Invite-only and username login may use thin Host routes around Better Auth if plugins fight the model.
- Keep identity tables out of Session transcript ownership: separate identity SQLite (or clearly prefixed identity tables), not mixed into canonical Session log semantics ([ADR 0010](./0010-first-party-opengui-harness.md), storage boundaries).
- Evolve `createCorsAuth` / shared-secret middleware into request **Actor** resolution (Account session | API key | local bypass).
- Frontend: setup, login, invite accept, owner Team settings; i18n for user-facing copy; calm existing shell patterns ([`PRODUCT.md`](../../PRODUCT.md)).

## Considered options

- **Team as cloud org across many Hosts:** deferred. Needs a control plane, Host registration, and cross-Host credentials; not required for “share this Host.”
- **Central OpenGUI identity with Host JWT validation only:** rejected for v1 self-host simplicity and air-gapped deploys; embedded identity matches Team = this Host.
- **Keep shared `OPENGUI_AUTH_TOKEN` as primary login:** rejected; no actor attribution, no revoke-per-person, poor team UX.
- **Forced Account on Desktop Local Host:** rejected; local-first and offline use must not depend on identity.
- **Open sign-up on Remote Hosts:** rejected for unrestricted `shell` Hosts; first-owner then invite-only.
- **Email + password login:** rejected for v1 product preference; email remains on the Account, username logs in.
- **Ship folder ACL UI without Harness enforcement:** rejected as security theater. Path grants are a later phase with hard mediation.
- **Realtime collaboration in the same initiative:** rejected; shared Sessions + actors are enough for Team access.

## Consequences

- Docker and self-host docs shift from “set a bearer token” to “complete owner setup, invite members, mint API keys.”
- Remote Web and remote Workspace connections gain setup/login gates; Local Desktop behavior stays Account-free.
- Multi-client Session arbitration remains Host-authoritative; identity adds attribution, not a second Session truth.
- A future path-ACL ADR must specify tool mediation (path canonicalization, symlinks, and `shell`) before any read-only folder UX.
- Implementation sequence and acceptance checks live in [`host-identity-and-teams.md`](../plans/host-identity-and-teams.md).
- Glossary updates: [`CONTEXT.md`](../../CONTEXT.md).

## Superseded / narrowed guidance

- Docs and env references that treat **`OPENGUI_AUTH_TOKEN` as the normal Remote Host login** are superseded after identity setup exists on that Host.
- [ADR 0005](./0005-opengui-runtime-backend-split-and-sdk.md) “backend access token auth” remains the _slot_ for Host API auth but the mechanism becomes Account sessions and Host API keys, not a single shared secret.
- This ADR does **not** change ADR 0010 tool unrestrictedness in v1; it only identifies who may call the Host.
