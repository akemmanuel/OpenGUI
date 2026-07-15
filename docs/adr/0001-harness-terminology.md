# Use "Harness" for coding-agent runtimes, not "Agent Backend"

We renamed all references to "agent backend" (OpenCode, Claude Code, Codex, Pi runtimes) to "Harness" to eliminate a naming collision. The same term "Backend" was used for both the coding-agent runtimes and the OpenGUI server process, making every architecture discussion ambiguous. "Harness" is intentionally unfamiliar -- it has no overloaded meaning in the project and forces explicitness in code and conversation.

## Status

superseded by ADR-0010

## Considered Options

- **Agent Runtime**: accurate but too long; collides with JavaScript "runtime".
- **Agent**: too generic; conflicts with the "agent" concept inside each coding-agent CLI.
- **Provider**: already used for API key providers (Anthropic, OpenAI, Google).
- **Backend** (keep): caused the collision this ADR fixes.
- **Harness**: novel, short, no existing overload in the codebase.

## Consequences

- Code references to `AgentBackendId` become `HarnessId`. API routes like `/api/agent-backends` become `/api/harnesses`.
- The CONTEXT.md glossary now has a dedicated section for architecture terms (Harness, Harness Adapter, Harness Scope) separate from the session/prompt language.
- Terminalogy-only changes are batched into one refactor commit to avoid churn.
