# Host-owned MCP tool connections

## Status

accepted

## Context

ADR 0010 deliberately limited the first-party Harness to four built-in tools and excluded MCP during the external-Harness replacement. That migration is complete enough to add MCP without restoring bridge, external Session, or external Harness compatibility.

Naively adding every MCP schema to every model request would waste context and invalidate provider prompt caches. Local MCP servers also execute with the Host operating-system account's authority and can bypass path grants unless restricted actors are denied access.

## Decision

- OpenGUI acts as an MCP host/client. Exposing OpenGUI as an MCP server is a separate decision.
- The first supported MCP capability is server-provided tools over approved local `stdio` commands and Streamable HTTP endpoints.
- MCP connections, credentials, process/network lifecycle, catalogs, and actor isolation belong to the OpenGUI Host.
- The Harness consumes MCP through a protocol-neutral `AgentToolSource`; model adapters receive complete generic tool definitions and do not import the MCP SDK.
- Built-in and MCP tool calls use the same durable Session `tool_call` and `tool_result` entries and bounded result handling.
- Small catalogs are exposed directly. Catalogs above the schema budget use stable search, inspect, and call meta-tools to preserve context and prompt-cache stability.
- MCP runtimes are isolated by actor and Session. Configuration changes close existing runtimes.
- Restricted path-policy actors receive no MCP tools. MCP Roots are not treated as confinement.
- Local command configuration requires explicit approval of the visible executable and exact argument list. Secrets remain Host-owned and are never returned by list routes.
- Prompts, resources, Roots, sampling, elicitation, Tasks, Apps, arbitrary headers, and OpenGUI-as-server are outside this decision.

## Consequences

- ADR 0010's “exactly four tools” and “no MCP” clauses are superseded. The four built-in tools remain fixed; MCP tools are Host-authorized external capabilities, not Harness plugins.
- The MCP SDK is isolated in `packages/backend/src/mcp/`.
- Host administrators can add trusted MCP connections. Enabled connections are available to unrestricted Sessions on that Host.
- A local MCP server is equivalent to running trusted code with Host authority. The settings UI and documentation must state this plainly.
- Further multi-user connection planes, OAuth, per-call approval, and additional MCP capabilities require follow-up decisions.

## References

- [`docs/research/mcp-support-design.md`](../research/mcp-support-design.md)
- [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP client best practices](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices)
