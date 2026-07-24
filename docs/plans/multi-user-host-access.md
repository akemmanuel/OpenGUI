# Plan: Multi-user Host access

Companion to [ADR 0013](../adr/0013-multi-user-host-access-model.md). Builds on identity/path work in [ADR 0011](../adr/0011-host-embedded-accounts-and-teams.md), [ADR 0012](../adr/0012-host-path-grants-and-tool-enforcement.md), and [`host-identity-and-teams.md`](./host-identity-and-teams.md).

## Status

In progress. Phases below are the implementation order.

## Fixed decisions (from design grill)

| Topic              | Decision                                                      |
| ------------------ | ------------------------------------------------------------- |
| Default subject    | User; Team is a share principal                               |
| Shares             | Explicit only (paths, models, sessions)                       |
| Registration       | `invite_only` \| `open`; owner switch                         |
| Invites            | `canInvite` capability; grants ⊆ inviter access               |
| Remote paths       | Share-only; no auto homes                                     |
| Desktop paths      | OS world + device default chat dir                            |
| Models             | Host / Team / User planes; BYOK+BYOS; deny-beats-allow policy |
| Sessions           | User-owned; ACL `view\|run\|admin\|owner`                     |
| External links     | View-only magic links                                         |
| Collab run         | Team grantee + entitlement to **pinned** Host/Team connection |
| Personal BYOK/BYOS | Solo only                                                     |
| Shell / sandbox    | Unrestricted for now; no bwrap requirement                    |
| Settings           | Device (desktop-only) / user prefs / Host admin               |
| Threat model       | Trusted circle; not hostile multi-tenant                      |

## Non-goals (this plan)

- Per-user VM/container isolation
- Bubblewrap/landlock product dependency
- Realtime collab UX
- Central cloud identity
- Forcing Accounts on Desktop Local

## Phases

### Phase 0 — Docs + settings honesty

- [x] ADR 0013 + this plan
- [x] Gate device settings (terminal, file manager, default chat directory, local backend restart) to Desktop (`isElectron`)
- [x] Hide OS “open in terminal/file browser” affordances on web where dead (already local-workspace gated)
- [x] i18n for any new copy
- [x] Architecture/CONTEXT pointers to ADR 0013

### Phase 1 — Registration mode + `canInvite`

- [x] Persist Host `registration_mode` (`invite_only` default, `open`)
- [x] Owner API to read/update Host policy
- [x] Open registration route when mode is `open` (create Account, no path grants)
- [x] `can_invite` on membership (owner always true)
- [x] Owner can toggle `canInvite` per member
- [x] Create-invite authorized by owner **or** `canInvite`
- [x] Invite path-grant attachment: only roots within inviter grants (owner: Host roots)
- [x] Team settings UI: registration mode, member invite capability (invite path picker UI still thin — API ready)
- [x] Frontend login/setup: register UI when open

### Phase 2 — Session ownership + ACL + view links

- [x] Durable Session owner in identity access layer
- [x] Default ACL owner-only on remote identity Hosts (new Sessions)
- [x] Local/desktop-local bypass: unscoped list (today’s behavior)
- [x] Session share APIs: grant `view`/`run`/`admin` to user or Team
- [x] List/read/prompt/delete enforce ACL
- [x] `run` limited to owner until Phase 3 model entitlements
- [x] View-only public share tokens (create/revoke/resolve)
- [x] UI: share dialog, private-by-default session list chrome, open view-link page

### Phase 3 — Model planes + entitlements

- [x] Connection records: `plane` = host \| team \| user + owner principal
- [x] User connection CRUD for self; secrets never listed
- [x] Team connection CRUD for Team admin/owner
- [x] Host connections remain owner-managed
- [x] Entitlements: who may use which connection/models
- [x] Host/Team policy flags: allow BYOK, allow BYOS (deny beats allow)
- [x] Session pin for collab: Host/Team connection id only
- [x] Model picker shows only entitled + own connections
- [x] Collab `run` enforcement completes here

### Phase 4 — Path share UX + enforcement defaults

- [x] Remote multi-user: document/enforce path grants on when identity ready and >1 user (or always enforced on remote)
- [x] Share-only empty states in project picker
- [x] Inviter path picker limited to accessible roots (API enforces; UI picker TBD)
- [x] No remote “default chat directory” settings (Phase 0)
- [ ] Capability stubs for future tool entitlements (`gh`, etc.) — optional table only

### Phase 5 — Hardening + docs

- [x] Integration tests for registration, canInvite, session ACL, view links (model entitlements later)
- [x] Docker/self-host docs
- [x] PRODUCT/CONTEXT glossary
- [x] Full suite slop-check / check / test before release

## Acceptance checks

1. Web settings never show terminal / file manager / default chat directory.
2. Owner can switch Host to open registration; new user has no path grants.
3. Member without `canInvite` cannot create invites; with it, can only grant own paths.
4. New Sessions on remote are invisible to other users until shared.
5. View link shows transcript without Host credential; cannot prompt.
6. User BYOK appears only for that user; collab pin rejects user-plane connections.
7. Desktop Local remains Account-free with device prefs intact.

## Implementation notes

- Prefer identity SQLite for ACL, policy, entitlements, share tokens—not transcript log pollution.
- Harness Session rows may store `owner_user_id` / `pinned_connection_id` as metadata if cleaner than a side table; access checks stay in Backend.
- Ship Phase 2 `run` as owner-only until Phase 3 entitlements land if needed to avoid a half-enforced collab story.
- Keep UI calm; full i18n `en`/`de`/`es`.
