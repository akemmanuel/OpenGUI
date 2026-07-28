# MCP support for OpenGUI: design and implementation considerations

Research date: 2026-07-26

## Executive recommendation

Add OpenGUI as an **MCP host/client**, not as an MCP server, and ship a deliberately narrow first version:

1. MCP server tools only.
2. Remote Streamable HTTP and explicitly approved local `stdio` configurations.
3. No MCP prompts, resources, sampling, elicitation, Apps, or Tasks in the first release.
4. Host-owned connections, credentials, lifecycle, authorization, and audit.
5. A small MCP broker behind a protocol-neutral tool interface consumed by the Harness.
6. Direct tool schemas for small catalogs; stable search/inspect/call meta-tools for large catalogs.
7. Per-actor or per-Session server isolation; never one ambient stateful MCP client shared across unrelated users.

This requires a new ADR. The accepted first-party Harness decision currently says exactly four tools and explicitly excludes MCP and extension mechanisms ([ADR 0010](../adr/0010-first-party-opengui-harness.md)). MCP should extend that architecture rather than reintroduce the deleted external-Harness bridge architecture.

## Why MCP belongs in the Host

MCP uses a host-client-server architecture. The MCP host coordinates clients, consent, security policy, authorization, context aggregation, and model integration; each MCP client has an isolated connection to one server ([MCP architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture)). Those responsibilities line up with the OpenGUI Host, not the Frontend and not a model transport.

The ownership split should be:

| OpenGUI module | MCP responsibility                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Host           | MCP configuration, credentials, connection ownership, actor authorization, lifecycle, OAuth callbacks, catalog cache, audit |
| Harness        | Select model-visible tools, execute calls through a narrow broker, persist normalized calls/results                         |
| Model adapters | Translate generic model tool definitions and calls to provider wire formats only                                            |
| Frontend       | Configuration, health, consent/approval, and existing inline tool-call presentation                                         |
| Shell          | Open browser for OAuth and disclose/approve local process execution; never execute MCP calls in the browser/mobile client   |

Do not put the MCP SDK directly in `OpenGuiHarness`, `OpenAiChatTransport`, React hooks, or Host routes. Keep it behind one deep module.

## Recommended deep modules

### 1. Protocol-neutral Harness tool seam

OpenGUI's current tool design is closed over `"read" | "write" | "edit" | "shell"` in `packages/harness/src/models/transport.ts`. Tool schemas are globally selected by name in `tools/tool-definitions.ts`, and execution is a switch in `tools/execute-tool.ts`. Both model adapters import the fixed schema registry. MCP makes all three assumptions invalid.

Replace this with a protocol-neutral definition and executor, conceptually:

```ts
interface AgentToolDefinition {
  modelName: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  source: { kind: "builtin" } | { kind: "mcp"; connectionId: string; toolName: string };
  fingerprint: string;
}

interface AgentToolSet {
  definitions: readonly AgentToolDefinition[];
  generation: string;
  invoke(
    call: { modelName: string; input: unknown },
    signal: AbortSignal,
  ): Promise<AgentToolResult>;
}
```

The actual external interface should remain smaller than the implementation. Callers should not learn MCP protocol versions, JSON-RPC IDs, SDK clients, transport classes, OAuth tokens, list cursors, or notification types.

Built-in tools and MCP tools are two real adapters at this seam. Model transports should receive complete generic definitions rather than reconstruct schemas from a fixed name union.

### 2. Host-owned `McpBroker`

Conceptually:

```ts
interface McpBroker {
  catalog(scope: McpActorScope): Promise<McpCatalogSnapshot>;
  call(
    scope: McpActorScope,
    ref: McpToolRef,
    input: unknown,
    signal: AbortSignal,
  ): Promise<McpResult>;
  close(): Promise<void>;
}
```

This module should hide:

- SDK version differences;
- `stdio` and Streamable HTTP transports;
- protocol negotiation and compatibility;
- OAuth and credential refresh;
- pagination of `tools/list`;
- `notifications/tools/list_changed` or newer cache TTL behavior;
- reconnection, timeout, cancellation, progress, and shutdown;
- MCP content-block normalization;
- tool-name mapping and collision handling;
- catalog caching and indexing;
- per-actor connection isolation.

The deletion test is strong: deleting the broker should make protocol, transport, auth, catalog, and lifecycle complexity reappear in the Host and Harness. That makes it a deep module rather than a wrapper around the SDK.

## Token-efficient tool exposure

### The failure mode to avoid

Sending every schema from every connected server on every model turn is not viable. Official MCP client guidance says that hundreds of tool definitions can consume most of the context and degrade latency and model performance. It recommends progressive discovery once definitions exceed a configurable context budget, with an example threshold of 1%-5% of the context window ([Client Best Practices](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices)).

OpenGUI also hashes the complete tool schema into its model cache generation. Changing schemas invalidates provider prompt caches. Official guidance specifically warns that adding/removing tools can cost more through cache misses than schema removal saves.

### Recommended hybrid

Use two modes selected deterministically before a model request:

#### Small catalog: direct mode

- Include selected MCP tool definitions directly with the four built-ins.
- Compute the serialized schema cost and switch modes at a configurable budget, initially 2% of the selected model's known context window.
- Preserve deterministic ordering: built-ins first, then connection order, then the server's stable tool order/name.
- Keep the exact array stable for the Run. Apply additions at the next Run or explicit refresh boundary. Removals and revoked access fail closed immediately at invocation.

Direct mode is best for one or two purpose-specific servers with a handful of tools. It avoids extra discovery turns and gives the model full JSON Schema validation information.

#### Large catalog: progressive mode

Expose three stable built-in meta-tools:

- `mcp_search_tools({ query, connection?, detailLevel?, limit? })`
- `mcp_get_tool({ toolRef })`
- `mcp_call_tool({ toolRef, arguments })`

The search response should contain compact opaque references, server labels, names, and one-line descriptions. `get` returns one bounded full schema. `call` validates the reference against the actor's current catalog and invokes it. Do not dynamically append discovered schemas to the provider's `tools` array in v1; routing all calls through stable meta-tools preserves the cache prefix.

Start with deterministic lexical/BM25-style search over server name, tool name, title, and description. Do not add embeddings or a second model until measurements show poor retrieval. The official guidance lists keyword, embedding, subagent, and hybrid approaches but does not require the more expensive options.

### Catalog rules

- Fetch all `tools/list` pages; MCP pagination uses opaque cursors and server-selected page sizes ([Pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination)).
- Cache normalized definitions and a content fingerprint outside model context.
- Re-index on `tools/list_changed` for 2025-era servers. The upcoming 2026 protocol adds `ttlMs`/`cacheScope`; honor those when supported.
- Bound tool count, schema bytes, schema nesting depth, description length, and validation time.
- Never dereference external JSON Schema `$ref` URLs. The 2026 release candidate explicitly allows full JSON Schema 2020-12 and warns clients to bound depth/validation and not auto-dereference external references ([2026 release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)).
- Record the catalog generation and chosen exposure mode in provider diagnostics and metrics, not the system prompt.

### Programmatic/code mode: later only

Official guidance describes sandboxed programmatic calling to keep large intermediate results out of model context. It can be highly token-efficient for tool chains, but it creates a new code-execution and authorization surface and requires a real no-network sandbox. OpenGUI's current `shell` tool is unrestricted and is not an acceptable sandbox. Defer code mode until OpenGUI has an independently reviewed capability sandbox.

## Protocol version strategy on 2026-07-26

There is an unusual timing issue:

- `2025-11-25` is the latest final MCP specification today.
- `2026-07-28` is a locked release candidate scheduled to become final in two days.
- The official TypeScript SDK v1.29.0 is the current production release.
- The split v2 SDK (`@modelcontextprotocol/client`) is still beta and targets the breaking 2026 protocol. Its own README says v1 remains supported for production until v2 stabilizes ([TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)).

Do not design OpenGUI around the 2025 stateful lifecycle. Put lifecycle behind `McpBroker`, implement production support with a pinned v1 SDK initially if shipping before v2 is stable, and add a compatibility test matrix. Re-evaluate the stable SDK immediately before implementation/merge.

The 2026 protocol removes the initialization handshake and protocol session, introduces `server/discover`, moves capabilities into per-request metadata, changes HTTP routing headers, and adds explicit list-cache semantics ([draft changelog](https://modelcontextprotocol.io/specification/draft/changelog)). Those changes are exactly why no lifecycle concepts should leak out of the broker.

Do not build new product dependencies on Roots, Sampling, or MCP Logging. They are deprecated in the 2026 revision; replacements are ordinary tool/resource parameters, OpenGUI's direct model integration, and stderr/OpenTelemetry respectively.

## Transport and lifecycle

### `stdio`

The client launches a child process and exchanges newline-delimited JSON-RPC over stdin/stdout; stderr is for logs ([Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)). Treat this as local code execution, not as adding an API endpoint.

Requirements:

- Show the exact executable, every argument, working directory, and environment-variable names before first launch. Do not truncate. Explicit consent is required by final SEP-1024 for one-click local configurations ([SEP-1024](https://modelcontextprotocol.io/seps/1024-mcp-client-security-requirements-for-local-server-)).
- Never invoke through a shell string. Spawn executable + argument array directly.
- Use an allowlisted, minimal environment; do not inherit the Host's complete environment by default.
- Never put secrets in command-line arguments, diagnostics, process titles, or Session entries.
- Capture bounded stderr diagnostics separately from protocol stdout.
- Apply startup, request, idle, and shutdown timeouts; kill the entire process tree on close/abort.
- Restrict installation/configuration to local Desktop users or trusted Host administrators. A remote member must not be able to make the Host run an arbitrary command.

Most importantly, an MCP `stdio` server runs with the Host OS account's authority. OpenGUI path grants and MCP Roots do not confine that process. If restricted actors can invoke the process, ADR 0012's security claim is bypassed. Either disable local MCP for restricted actors or launch servers in OS/container isolation with an explicit capability policy.

### Streamable HTTP

- Require HTTPS except explicit loopback development endpoints.
- Normalize URLs and prevent redirects to disallowed schemes/addresses.
- Protect OAuth discovery and redirects against SSRF, including private, loopback, link-local, cloud metadata, encoded addresses, DNS rebinding, and redirect hops. Official security guidance recommends network-level egress controls rather than hand-rolled checks ([Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)).
- Set strict connect/request/idle limits, response-size limits, and concurrency quotas.
- Do not forward OpenGUI Host credentials or model provider credentials to an MCP server.
- Never support arbitrary user-supplied authorization headers as an unclassified settings blob.

### Connection pooling and isolation

For 2025 stateful servers, one MCP client has one stateful server connection. Sharing it across users can leak server state, notifications, OAuth identity, and results. Key the runtime by at least:

```text
(connection configuration revision, credential owner, actor or Session isolation key)
```

Recommended defaults:

- personal credential: one runtime per user and server;
- shared Host credential: one runtime per Session unless the server is explicitly declared stateless and multi-user safe;
- local `stdio`: one process per Session by default, with an opt-in trusted shared mode for expensive servers;
- idle eviction with graceful close; hard close on credential revocation or policy revision.

The 2026 stateless core reduces HTTP connection-state concerns but does not make the downstream application or explicit handles user-safe. OpenGUI authorization still applies to every call.

## Authorization, ownership, and multi-user policy

MCP connections need the same conceptual planes as model infrastructure, but should not be merged with model connections:

- **Host connection**: configured by owner/admin; may use a shared service credential.
- **Team connection**: shared configuration and entitlement, if Team-scoped infrastructure is implemented.
- **User connection**: private endpoint/credential visible only to its owner.

Separate:

1. server configuration;
2. credentials;
3. user-facing connection/offering;
4. entitlement to see it;
5. permission to invoke each tool;
6. approval policy for a particular invocation.

Do not infer MCP entitlement from Project path access, Team membership, model entitlement, or Session visibility. Re-authorize immediately before catalog exposure and immediately before each call, just as Harness filesystem tools revalidate policy before effects.

Persist a Session's allowed connection IDs and policy revision at admission, but check current revocation at execution. Additions should not silently appear mid-Run. Record the durable actor on each call through the existing Run actor model.

## Consent and tool safety

MCP tool descriptions, schemas, annotations, icons, resource links, and outputs are untrusted server content. They can contain prompt injection or misleading safety claims.

Use a policy ladder:

1. denied;
2. ask every time;
3. allow for this Run;
4. allow for this Session;
5. allow for this connection/tool policy.

Default unknown MCP tools to `ask`. `readOnlyHint`, `destructiveHint`, and similar annotations can improve presentation but must not grant authority; server annotations are claims, not enforcement.

For a multi-client, long-running product, approval must be Host-owned durable state, not a modal promise living in one browser tab. Add semantic Session entries/events such as `tool_approval_requested` and `tool_approval_resolved`, bind the decision to actor, Session, Run, call ID, connection revision, tool name, argument fingerprint, and expiration, and abort safely if access changes while waiting.

If approval is intentionally omitted from the first release, the acceptable reduced scope is much smaller: explicitly installed/trusted servers, explicit Session enablement, admin-defined tool allowlists, and no restricted actors or shared remote credentials. Do not market that as safe arbitrary MCP support.

## Tool identity and provider compatibility

MCP tool names are only unique within one server, while model providers differ in name character and length limits. Never use a raw MCP name as global identity.

Maintain three identities:

- immutable OpenGUI `ToolRef`: connection ID + native MCP name;
- human label: server label + tool title/name;
- provider-safe `modelName`: deterministic, sanitized, bounded, collision-resistant alias.

Example shape: `mcp__github__create_issue__a1b2c3`. Keep the reverse map Host-side. A rename must not cause an old model alias to invoke a different tool. Persist the native identity and schema fingerprint in Session entries, not only the alias.

Provider adapters must accept full generic JSON Schema definitions. Add conformance fixtures for nested objects, arrays, enums, defaults, nullable/union forms, `oneOf`/`anyOf`/`allOf`, `$defs`/local `$ref`, empty schemas, Unicode, long descriptions, and provider-specific rejection limits.

## Result normalization and token control

MCP tool results can include text, image, audio, resource links, embedded resources, `structuredContent`, and `isError`. Normalize them once in the broker/tool layer:

```ts
interface AgentToolResult {
  status: "ok" | "error" | "denied" | "aborted";
  summary: string;
  structured?: unknown;
  attachments?: NormalizedAttachment[];
  truncated?: boolean;
  retainedOutputRef?: string;
  diagnostics?: SafeDiagnostic[];
}
```

Rules:

- Treat MCP `isError: true` as an executed tool error that the model can self-correct, not as a transport failure.
- Keep transport/protocol/auth failures distinct from tool execution errors.
- Reuse one byte-aware output limiter for built-in and MCP tools. The existing 5 KiB Harness limiter is a useful starting point, but full retained output must be access-controlled and cleaned up; an absolute temp path in model-visible output can leak Host topology.
- Prefer `structuredContent` when it validates against `outputSchema`; retain a concise text fallback.
- Bound each content block and total decoded size before persistence or model injection.
- Never automatically fetch resource links or embedded external URLs.
- Preserve supported images through the existing attachment path; defer audio until every model adapter and transcript renderer has an explicit policy.
- Add output summarization only as an explicit, metered policy. Silent secondary-model summarization creates cost, trust, and reproducibility problems.

## Persistence and reproducibility

Configuration and credentials belong in Host persistence, not Harness Session SQLite. Credentials must use the Host secret store and must never be returned by list routes.

Durable tool calls should include:

- Run and call IDs;
- source kind;
- connection ID and configuration revision;
- native server tool name and provider-safe alias;
- schema fingerprint;
- bounded/redacted input or a classified non-retained marker;
- approval decision ID;
- normalized result;
- timing, cancellation, and safe error classification.

The current Harness persists every tool input and output verbatim. MCP increases the chance that arguments/results contain passwords, tokens, personal data, database rows, or private documents. Decide retention before implementation. At minimum:

- never log headers, OAuth tokens, env values, or SDK objects;
- support connection/tool-level sensitive argument paths;
- redact before appending and before broadcasting;
- distinguish “not retained” from an empty value;
- set total per-call and per-Session storage limits;
- include retained MCP data in deletion/export/privacy behavior.

Exact replay of an external side effect is impossible and unsafe. Reproducibility means preserving what definition/revision was presented and what happened, not automatically re-invoking old MCP calls.

## Feature triage

| MCP feature           | First release                                    | Reason                                                                             |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Tools                 | Yes                                              | Direct fit with Harness loop and transcript                                        |
| `stdio`               | Yes, admin/local + explicit consent              | Broad ecosystem; high code-execution risk                                          |
| Streamable HTTP       | Yes                                              | Remote/self-hosted use case                                                        |
| Legacy SSE            | Compatibility only if telemetry proves necessary | Deprecated transport; avoid new product semantics                                  |
| Prompts               | No                                               | User-controlled templates need dedicated UI and compete with Skills                |
| Resources             | No                                               | Need resource picker, URI trust, subscriptions, size policy, and context semantics |
| Roots                 | No                                               | Security hint, not sandbox; deprecated in 2026                                     |
| Sampling              | No                                               | OpenGUI already owns direct model integration; deprecated in 2026                  |
| Logging               | No                                               | Use stderr + structured Host observability; deprecated in 2026                     |
| Elicitation/MRTR      | Later                                            | Requires durable, multi-client input/approval state                                |
| Tasks extension       | Later                                            | Overlaps OpenGUI Run lifecycle and requires explicit projection semantics          |
| MCP Apps              | Later/separate decision                          | Remote HTML/iframe sandbox and UI trust boundary, not “tool support”               |
| OpenGUI as MCP server | Separate ADR                                     | Different product, auth, and data-exposure problem                                 |

Prompts should not be silently injected into model context. The specification describes them as user-controlled. If added later, present them as explicit PromptBox actions and decide how they interact with Skills. Resources should be explicit user/model-selected context with byte budgets and provenance, not automatic ingestion.

## Frontend product shape

Keep MCP subordinate to the existing product:

- Add a **Connections → MCP** settings section, not a new top-level product area.
- Show server label, owner/scope, transport, auth state, health, tool count, last refresh, and trust warning.
- Configuration is a staged flow: validate → show exact effects/command → approve → connect → inspect tools → choose exposure/approval defaults.
- In the Session composer, use a compact “Connected tools” control similar to Skills. Session enablement should be explicit and locked for a Run.
- Reuse inline tool-call presentation. Add server identity, approval state, structured error, and safe expandable input/output. Unknown tools already have a generic renderer, which is a useful fallback.
- Never expose OAuth tokens, environment values, raw protocol messages, or full schemas by default.
- Update `en.json`, `de.json`, and `es.json` together for all user-facing text.

## Observability and operational limits

Measure before optimizing:

- configured/connected/healthy server counts;
- catalog tools and serialized schema bytes;
- estimated schema tokens and percentage of model context;
- direct vs progressive mode;
- search hit/call success and extra discovery turns;
- provider cache read/write tokens before and after MCP;
- connection startup, `tools/list`, tool-call, and first-progress latency;
- result bytes before/after truncation;
- approvals requested/allowed/denied/expired;
- timeout, cancellation, protocol, auth, and tool error rates;
- per-actor/server concurrency and rate limiting.

Use OpenTelemetry spans for Host → broker → transport → server calls with trace IDs, connection ID, tool alias, actor type, Session/Run IDs, timings, and safe status. Never attach arguments, results, URLs with secrets, headers, or tokens by default.

Set limits at configuration, connection, catalog, schema, request, result, concurrency, queue, and storage layers. A malicious server can otherwise consume memory through catalog churn, giant schemas, notifications, progress floods, or oversized results.

## Implementation sequence

### Phase 0: decision and spike

1. Accept an ADR superseding only ADR 0010's “exactly four tools/no MCP” clauses.
2. Fix scope to MCP client + tools only.
3. Re-check the stable spec and TypeScript SDK after 2026-07-28.
4. Build a throwaway compatibility spike against one stdio and one HTTP fixture, including both 2025 and 2026 protocol behavior if supported by the stable SDK.
5. Measure SDK bundle/package impact; the current v1 package includes server and web-framework dependencies, while v2 splits client/server packages.

### Phase 1: generic tool seam

1. Replace `ModelToolName` with complete generic model tool definitions.
2. Make built-in tools an adapter behind the new executor.
3. Preserve exact existing four-tool behavior with tests.
4. Move output limiting/normalization behind the shared seam.
5. Update OpenAI Chat and Codex Responses conformance tests.

### Phase 2: MCP broker core

1. Implement injected SDK adapter, fake transport/client, catalog pagination/cache, aliasing, and normalized results.
2. Implement Streamable HTTP without OAuth, then stdio with explicit process policy.
3. Support cancellation, timeout, close, list changes/cache TTL, and bounded diagnostics.
4. Add deterministic direct/progressive exposure and token-budget tests.

### Phase 3: Host policy and persistence

1. Add configuration revisioning, secret custody, connection planes, entitlement, and actor-scoped runtime keys.
2. Add SSRF/egress policy and local command consent.
3. Add durable Session approval state before enabling untrusted write-capable tools.
4. Add routes and contract tests with deny-by-default authorization.

### Phase 4: product UI

1. Settings management and diagnostics.
2. OAuth callback/browser flow.
3. Session tool enablement.
4. Inline MCP identity, approval, and result rendering.
5. Three-locale i18n and accessibility coverage.

### Phase 5: hardening

1. Official MCP conformance suite where applicable.
2. Adversarial servers: malformed JSON-RPC, giant/churning catalogs, invalid schemas, spoofed aliases, progress floods, hangs, crashes, auth refresh races, prompt-injection descriptions, and giant results.
3. Multi-user isolation tests proving no catalog, token, state, output, notification, or approval crosses actors/Sessions.
4. Desktop packaging tests on Windows/macOS/Linux and remote Host egress tests.
5. `pnpm run slop-check`, `pnpm run check`, focused tests, then full tests/build.

## Acceptance criteria

MCP support is ready only when:

- disabling/removing an MCP connection immediately prevents invocation;
- one actor cannot observe or use another actor's connection, credential, catalog state, result, or server process state;
- local server launch always shows and requires approval of the exact executable and arguments;
- a restricted actor cannot use MCP to bypass path/shell policy;
- large catalogs do not exceed the configured schema-token budget;
- the provider tool array remains stable within a Run and cache invalidation is measurable;
- all list pages, list changes/cache expiry, cancellation, timeout, reconnect, and shutdown paths are tested;
- tool errors are distinguishable from transport/auth/protocol errors;
- inputs/results are bounded and sensitive fields are redacted before persistence and broadcast;
- Frontends can disconnect/reconnect while approval or execution is pending without losing authoritative state;
- stdio descendants terminate on Host close/abort;
- no MCP SDK/protocol concepts leak into React or model adapter interfaces;
- the existing built-in tools and transcript replay remain behaviorally unchanged.

## Primary sources

- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture)
- [Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
- [Prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
- [Pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination)
- [Client Best Practices](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices)
- [Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [SEP-1024 local server installation consent](https://modelcontextprotocol.io/seps/1024-mcp-client-security-requirements-for-local-server-)
- [2026-07-28 release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [2026 draft changelog](https://modelcontextprotocol.io/specification/draft/changelog)
- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
