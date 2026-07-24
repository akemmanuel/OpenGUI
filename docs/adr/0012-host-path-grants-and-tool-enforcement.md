# Host path grants and tool enforcement

Host Accounts identify who may use a Remote Host, but ADR 0011 intentionally does not make Projects or folders a security boundary. Partially trusted Team members require a path policy that cannot be bypassed through another route, a Harness tool, a symlink, or `shell`. This ADR defines that policy and the order in which it may be exposed.

## Status

accepted

## Decision

### Feature mode and actors

- `OPENGUI_PATH_GRANTS=disabled|enforced` controls the policy and defaults to `disabled` for compatibility. Grant administration may exist while disabled, but no UI may claim that grants are enforced.
- Desktop Local actors, owner Accounts, and owner Host API keys remain unrestricted within global `OPENGUI_ALLOWED_ROOTS`.
- Member Accounts and member Host API keys are deny-by-default when enforcement is enabled. Their grants are independent: an API key does not inherit its creator's user grants.
- A grant is `read` or `write`; `write` implies `read`. Replacing one subject's grants is atomic and advances a durable policy revision.

### Paths and grants

- Every grant root is stored as a canonical, existing directory beneath a canonical global allowed root. Containment is path-segment-aware, not string-prefix-based.
- Restricted actors may not traverse symbolic links. Checks walk path components with `lstat`; writes may address a missing suffix only after every existing ancestor has passed policy.
- Session visibility and Session creation follow the Session's canonical Project path. A read grant makes that Project visible; no grant hides it. Sidebar filtering alone is never enforcement.
- Restricted actors cannot use `shell`. The first enforced version does not attempt to parse commands or infer their filesystem effects.

### Complete mediation before product exposure

Enforcement must cover every path from an actor to Host capabilities before the feature is presented in the Frontend:

- HTTP product and filesystem routes, uploads, and downloads;
- RPC and Desktop/private transports;
- SSE subscription and Session visibility;
- Session list/open/create and canonical Project selection; and
- all Harness `read`, `write`, and `edit` tool invocations, with `shell` disabled for restricted actors.

Uploaded prompt files fail closed for restricted actors. The Host must not grant a shared upload/temp root merely to make an attachment work; it must place or copy the upload into an authorized destination through the same policy.

### Security guarantee

Portable `realpath`/`lstat` checks protect against ordinary static path traversal and symlink escapes. They cannot close every check-to-use race when the restricted actor can mutate the filesystem as the same operating-system user. Defending against that same-user TOCTOU threat requires OS-level isolation (separate users, sandbox/container/VM, descriptor-relative platform APIs where available) and is explicitly outside this policy's guarantee.

The policy foundation therefore exposes one effective-policy interface for later route and Harness injection. Callers must authorize immediately before use and must not cache a decision across policy revisions or unrelated filesystem operations.

## Enforcement interface

The identity database owns `host_path_grant` and `path_policy_revision`. Only an owner **user** may list or atomically replace grants for a user or API key. Removing a member or revoking/removing an API key removes that subject's grants.

`IdentityService.effectivePathPolicy(actor)` is the enforcement entry point. It returns the revision, whether the actor is restricted, whether shell is available, normalized grants, `authorizePath(path, access, options)`, and `canAccessProject(path)`. HTTP, RPC, SSE, Session operations, uploads, skills, and Harness tools consume this policy. Identity `me` responses report whether enforcement is active and ready; the Frontend exposes grant administration only in that state.

## Considered options

- **Project IDs as ACLs:** rejected because Projects are directory-backed and aliases/symlinks would make identity ambiguous.
- **Read-only UI filtering:** rejected as security theater; direct APIs and tools would bypass it.
- **Command allow/deny lists for shell:** rejected because shell syntax, subprocesses, interpreters, and platform differences cannot provide coherent path confinement.
- **Allow shared temp uploads:** rejected because access to a shared staging root leaks data and creates a policy bypass.
- **Claim complete same-user filesystem isolation:** rejected; portable preflight checks cannot eliminate same-user TOCTOU.

## Consequences

- ADR 0010's unrestricted tools remain the behavior while path grants are disabled and for unrestricted actors. For restricted actors under enforcement, this ADR narrows it by disabling shell and mediating the other tools.
- Grant administration is exposed only while complete enforcement is active. Restricted uploads are placed beneath an authorized writable Project rather than a shared temporary root.
- OpenGUI-hosted deployments still need infrastructure isolation between customer Teams; path grants do not create a safe multi-tenant OS account.
- The implementation sequence remains in [`host-identity-and-teams.md`](../plans/host-identity-and-teams.md).
