# Multi-user Host access model

[ADR 0011](./0011-host-embedded-accounts-and-teams.md) treated a Remote Host as one trusted Team with ambient shared Sessions and Host-owned model credentials. Real hosting for friends, family, and clients needs a **user-default** world: private work by default, explicit shares, and optional Team principals—without turning OpenGUI into a hostile multi-tenant cloud or a container platform.

## Status

accepted

## Decision

### Threat model

- Target operators: **self-hosted Hosts for trusted circles** (friends, family, non-adversarial clients).
- Goals: privacy between users, clear model billing/authority, footgun reduction in the **product UI and file APIs**.
- Non-goals for this ADR: hostile multi-tenant isolation, per-user VMs/containers, or presenting path policy as a shell jail.
- Agent **`shell` remains unrestricted** at the OS-user level until a later sandbox ADR. Path grants apply to OpenGUI file/product surfaces; docs and UI must not claim shell isolation.

### Principals and shares

- Default subject is a **User** (Account), not a Team roommate.
- A **Team** is a named principal on the Host used for grouping and grants—not an ambient shared disk, keyring, or session space.
- **Explicit shares only.** Membership never implies path access, model access, or session access.
- Share objects include at least: path grants, model entitlements, session ACL entries, and session view links.

### Registration and invites

- Host owner configures `registrationMode`: **`invite_only`** (default for private Hosts) or **`open`**.
- **`canInvite`** is a capability (owner always has it). Invites are not ambient for every member.
- Inviter may attach initial **path grants** only for roots within **their own** grants, with access mode ≤ theirs. Owner may grant any root under Host `OPENGUI_ALLOWED_ROOTS`.
- Open registration creates an Account with **no** path grants until someone shares paths (remote is share-only).

### Paths (remote vs desktop)

- **Remote Host:** share-only paths. No auto-provisioned per-user home directories.
- Empty file/project state until grants exist; UI must say so calmly.
- Browse/file APIs are rooted at the actor’s grants (no parent-of-grant listing via those APIs).
- **Desktop Local:** unchanged OS-user world; default chat/project directory and OS app prefs remain **device** settings and must not appear on web.

### Model credentials

Three planes:

| Plane    | Configured by          | Usable by                                                |
| -------- | ---------------------- | -------------------------------------------------------- |
| **Host** | Host owner             | Users/Teams with an entitlement                          |
| **Team** | Team admin (and owner) | Team members with an entitlement to that Team connection |
| **User** | That user              | That user only (solo)                                    |

- BYOK (API keys) and BYOS (OAuth subscriptions) are first-class on User and Team planes unless disabled by policy.
- Host owner and Team admin may **disable** BYOK and/or BYOS for their scope. **Deny beats allow**; Host deny beats Team allow.
- Owner/admin cannot read User secrets.
- Secrets never appear in transcripts, tool output, Frontend persistence, or audit detail payloads.

### Sessions

- Every Session has a single **owner user**. Ownership is not the Team.
- Default ACL: **owner only**.
- Roles: **`view` | `run` | `admin` | `owner`**.
- **External / non-account share links:** **view-only** magic links (expiry/revoke); no tools, prompts, or path access.
- **Collaborative continue (`run`):** only for Team grantees, and only when the runner is entitled to the Session’s **pinned** Host or Team connection. Personal BYOK/BYOS is **solo-only** and cannot be the collab pin.
- Run identity for collab turns: the **runner** must hold entitlement to the pinned shared connection (not the owner’s personal secret).
- Desktop Local / single-user bypass keeps today’s unscoped Session list behavior.

### Settings surface

Three buckets:

1. **Device / shell prefs** (Desktop only): default terminal, OS file manager, default chat directory, local backend restart, etc.
2. **User prefs**: theme, language, new-chat model behavior, model age filter, notifications—per Account on remote when persisted server-side is available; local otherwise.
3. **Host admin**: registration mode, members, invites, capabilities (`canInvite`), path grants, Host/Team model connections & entitlements, BYOK/BYOS policy.

### Sandbox (deferred)

- No bubblewrap/container requirement in this ADR.
- Future optional Linux tool launcher may enforce grant-visible data + RO exec roots; product APIs stay launcher-agnostic.
- Global binaries may exist on the Host PATH; **capability entitlements** (e.g. `gh`) remain a later control when shell policy exists.

## Considered options

- **Keep ambient shared Sessions (ADR 0011):** rejected for multi-user privacy; clients and family should not see each other’s chats by default.
- **Hard multi-tenant VMs per user:** rejected for cost/complexity against the trusted-circle goal.
- **Policy-only path grants presented as security against shell:** rejected as theater while shell is unrestricted.
- **Team-owned Sessions:** rejected; user-owned + ACL is simpler lifecycle and matches “normally just a user.”
- **Collab on personal BYOK by default:** rejected; collab pins Host/Team connections only.
- **Auto user homes on remote:** rejected for simplicity; remote is share-only; Desktop keeps default dirs.

## Consequences

- ADR 0011 remains the embedded-identity and Account credential foundation but is **narrowed** wherever it required ambient Team Session sharing, invite-only-only registration, Host-only models, or “member ≈ full Host power” as the product default.
- ADR 0012 path grants remain the mediation mechanism for file/product surfaces; remote multi-user Hosts should run with grants **enforced** when more than one human Account exists.
- Implementation plan: [`multi-user-host-access.md`](../plans/multi-user-host-access.md).
- Glossary updates land with the plan phases in [`CONTEXT.md`](../../CONTEXT.md).

## Superseded / narrowed guidance

- ADR 0011 “all members share Sessions” → default **private**; share via ACL/links.
- ADR 0011 “Account creation is invite-only” → **default** invite-only; owner may enable **open** registration.
- ADR 0011 “Provider credentials stay Host-side; owner configures” → Host plane remains; **User and Team planes** added with entitlement and policy controls.
- ADR 0011 trusted-team unrestricted tools → still true at OS level for shell until sandbox work; **product authorization** is no longer ambient full Team access.
