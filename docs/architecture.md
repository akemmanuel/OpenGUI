# OpenGUI architecture

Contributor map of the repository as it exists for the 0.6 release line. Canonical product
language is in [`CONTEXT.md`](../CONTEXT.md); accepted decisions are indexed in
[`docs/adr/`](./adr/README.md).

## Runtime shape

```text
Desktop Shell ─┐
Web Shell ─────┼─ OpenGUI Frontend ── authenticated Host API/events ── OpenGUI Host
Mobile Shell ──┘                                                   ├─ identity + authorization
                                                                   ├─ model/provider credentials
                                                                   ├─ MCP connections
                                                                   └─ first-party Harness
                                                                      ├─ Session SQLite
                                                                      ├─ model adapters
                                                                      └─ built-in + MCP tools
```

| Layer              | Owns                                                                                                                   | Main paths                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Shells**         | Electron lifecycle/native integration, browser hosting, and Capacitor packaging                                        | `main.ts`, `main/`, `preload.ts`, `server/`, `android/`, `src/shell/` |
| **Frontend**       | Workspaces (Host connections), Projects in the sidebar, presentation state, PromptBox, transcript and settings UI      | `src/components/`, `src/features/`, `src/hooks/`, `src/lib/`          |
| **Host**           | Product routes and events, Session lifecycle, queues, identity/authz, settings/secrets, model access, MCP, path policy | `packages/backend/src/`                                               |
| **Harness**        | Agent loop, durable Session entries, context/compaction, Skills, model transports, and tool execution                  | `packages/harness/src/`                                               |
| **Wire contracts** | Shared provider catalogs and protocol primitives; frontend Host contracts remain in the app until extracted            | `packages/protocol/src/`, `src/protocol/`                             |

There is no active external-Harness Runtime, bridge registry, or coding-agent CLI adapter. The
package name `@opengui/backend` remains for compatibility, but product and architecture language
calls the running process the **OpenGUI Host**. Historical Runtime/bridge plans describe superseded
migration states, not the current implementation ([ADR 0010](./adr/0010-first-party-opengui-harness.md)).

## Ownership rules

- A **Host** contains one first-party **Harness**. The Harness owns durable Session entries and Run
  execution; the Host owns access, orchestration, settings, and the client-facing API.
- Frontend code talks through `OpenGuiHostClient` in `src/protocol/`. It does not import the Harness,
  MCP SDK, identity database, or model transport implementations.
- Desktop starts a private loopback Host sidecar and uses Desktop Local identity bypass. Web and
  Mobile connect to an authenticated Remote Host; Mobile never executes a phone-local Harness.
- Remote Hosts are share-only by default. Identity, roles, Session ACLs, model entitlements, and
  path grants live under `packages/backend/src/identity/` and `path-policy/`. Path grants mediate
  product/file surfaces; they are not an operating-system shell sandbox.
- Model adapters implement wire protocols behind the Harness model interface. Provider credentials
  and backend/offering resolution stay Host-side ([ADR 0014](./adr/0014-flexible-users-access-and-model-offerings.md)).
- MCP lifecycle, credentials, catalog limits, diagnostics, and actor policy stay behind
  `packages/backend/src/mcp/McpBroker`; the Harness consumes only `AgentToolSource`
  ([ADR 0015](./adr/0015-host-owned-mcp-tool-connections.md)).

## Persistence

| Data                                                                         | Authority                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Sessions, entries, follow-ups, Run replay                                    | Harness SQLite in the Host data directory                   |
| Accounts, memberships, grants, ACLs, offerings, entitlements, API-key hashes | Host identity SQLite                                        |
| Model/MCP endpoint settings and secret slots                                 | Host durable state; secrets are never returned by list APIs |
| Workspace connections, connected sidebar Projects, UI preferences            | Frontend persistence                                        |

External-Harness Sessions are not imported into first-party Harness storage. See
[`CHANGELOG.md`](../CHANGELOG.md) before upgrading from 0.5.x.

## Important seams

- `packages/backend/src/host/opengui-host.ts` — Host application boundary and Harness bootstrap.
- `packages/backend/src/routes/` — authenticated HTTP product, identity, filesystem, and event APIs.
- `packages/backend/src/identity/` — Accounts, roles, grants, Session ACL, model offerings.
- `packages/backend/src/mcp/` — MCP broker and Harness tool-source adapter.
- `packages/harness/src/open-gui-harness.ts` — first-party Harness composition.
- `packages/harness/src/storage/` — schema-versioned Session persistence.
- `packages/harness/src/models/` — model transport adapters.
- `packages/harness/src/tools/` — `read`, `write`, `edit`, `shell`, and image handling.
- `src/features/host-provider/` — Frontend Host state/event orchestration.
- `src/features/session-transcript/` — live plus durable transcript projection.

When changing Host routes, Session paths, or frontend Host transport, run
`pnpm run slop-check` in addition to the standard gates.

## Development commands

```bash
pnpm install --frozen-lockfile
pnpm run dev           # Desktop development
pnpm run dev:web       # Web development
pnpm run check         # format, lint, and type checks through Vite+
pnpm run test
pnpm run slop-check
pnpm run build
```

Release CI uses Node.js 24 and pnpm 11.8.0. Never invoke `tsc` directly; use Vite+ checks.
