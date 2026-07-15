# Replace external harness integrations with a first-party OpenGUI Harness

OpenGUI currently delegates agent execution and session ownership to external coding-agent Harnesses such as Pi, OpenCode, Codex, and Claude Code. Normalizing their incompatible installation, authentication, session, event, tool, model, and lifecycle behavior has become the largest source of defects and complexity. OpenGUI will replace those integrations with one first-party **OpenGUI Harness**, while preserving the current project/sidebar/chat/prompt UI and the existing Desktop, Web, and Mobile shells.

## Status

accepted

## Decision

- OpenGUI owns one first-party **OpenGUI Harness**. It is not an adapter over another coding-agent CLI or SDK.
- The Harness exposes exactly four model-callable tools in v1: `read`, `write`, `edit`, and `shell`.
- Tools are unrestricted in v1. They run with the operating-system permissions and environment of the OpenGUI Host process. There is no sandbox, command policy, approval layer, MCP, or extension mechanism.
- `shell` uses the Host's native configured shell rather than pretending every platform has Bash:
  - Windows uses PowerShell, preferring `pwsh` and falling back to Windows PowerShell.
  - macOS and Linux use the user's configured shell, normally `$SHELL`, and fall back to `/bin/sh` when none is configured.
  - Self-hosted and OpenGUI-hosted deployments use the shell configured in their Host environment.
  - Each call is non-interactive, starts in the Session's Project directory, streams combined stdout/stderr, supports timeout and abort, and terminates its child process tree when stopped.
- The Harness owns Sessions and Session transcripts. They are stored in an append-oriented SQLite log owned by the OpenGUI Host. Model changes, reasoning changes, user messages, assistant messages, tool calls/results, compaction, and run lifecycle are durable Session entries.
- Token and tool-output deltas are live transport events, not canonical transcript rows. Completed semantic entries are persisted. An unfinished run is recoverable as interrupted after a Host restart.
- The Harness supports skills through the Agent Skills `SKILL.md` format and progressive disclosure. Skills do not provide extension hooks or register new tools in v1.
- Model support in v1 consists of a Codex/ChatGPT OAuth preset and custom OpenAI-compatible connections. Provider-specific streaming and authentication sit behind internal seams; they are not external Harnesses.
- The OpenGUI Host owns Harness execution, SQLite, queues, credentials, and multi-client arbitration. It exposes one product interface to Frontends.
- Desktop runs a local Host directly on the user's computer. Web and Mobile are clients of a self-hosted or OpenGUI-hosted Host. Direct phone-local Harness execution is not part of v1 because mobile operating systems cannot provide the same unrestricted shell and process environment.
- An OpenGUI-hosted Host gives each customer an isolated OS/container/VM environment. The Harness remains unrestricted inside that environment; infrastructure isolation prevents customers from sharing one unrestricted host account.
- Projects remain directory-backed work targets. The Harness is general-purpose and does not encode presentations, email, WordPress, HTML, Next.js, files, results, or artifacts as separate product concepts.
- The current UI shape remains: Workspaces where applicable, Projects and Sessions in the sidebar, transcript with inline tool calls, PromptBox, model/reasoning selection, and settings. Migration is subtractive: remove Harness, agent, worktree, Git, MCP, and external-runtime controls without adding Files, Activity, Results, or task-specific surfaces.

## Interface direction

The OpenGUI Host is the only product caller of the Harness. The Harness presents a session-first interface with operations equivalent to:

- list, create, open, rename, and delete Sessions for a Project directory;
- send a prompt, enqueue a follow-up, abort a run, and subscribe to ordered live events;
- read the durable Session log and current run snapshot;
- select a model and reasoning level; and
- close cleanly, including terminating child processes.

The exact TypeScript names are intentionally left to the implementation plan. The interface must not contain `harnessId`, external Harness capabilities, bridge channels, external session IDs, or provider-native event shapes.

## Superseded decisions

This decision supersedes the following ADRs where they describe the external multi-Harness architecture:

- [ADR 0001](./0001-harness-terminology.md): Harness now means the first-party OpenGUI execution engine, not an external CLI/runtime.
- [ADR 0004](./0004-storage-source-of-truth-boundaries.md): the OpenGUI Host, not an external Harness, owns Sessions and transcripts in SQLite.
- [ADR 0005](./0005-opengui-runtime-backend-split-and-sdk.md): the adapter-oriented OpenGUI Runtime is replaced by the first-party Harness inside the Host.
- [ADR 0006](./0006-harness-only-session-and-transcript-reads.md): Session and transcript reads come from Host-owned SQLite.
- [ADR 0007](./0007-runtime-sdk-minimal-surface.md): the multi-Harness `@opengui/runtime` SDK is not a v1 product goal.
- [ADR 0008](./0008-session-transcript-projection-in-runtime.md): transcript normalization across external Harnesses is removed.

ADR 0002's uploaded-prompt-file behavior, ADR 0003's persistent Desktop Host and private local transport direction, and ADR 0009's frontend composition direction remain applicable unless replaced separately.

## Considered options

- **Continue repairing and deduplicating bridges:** rejected because event normalization, session identity, lifecycle reconciliation, readiness, and provider capability differences remain even after code deduplication.
- **Use Pi or another coding-agent SDK directly behind a single bridge:** rejected because OpenGUI would still delegate its core Session, tool, model, and lifecycle behavior to another Harness and inherit its product surface.
- **Keep external Harnesses as optional plugins:** rejected for v1 because the compatibility architecture and support burden would remain in the core product.
- **Run a reduced Harness directly on mobile:** rejected for v1 because the missing shell, restricted filesystem, background execution limits, and unavailable desktop toolchains would make Sessions and skills behave differently by client.
- **Standardize on Bash everywhere:** rejected because Windows does not include Bash and requiring Git for Windows contradicts removal of Git prerequisites and easy setup.
- **Build output-type concepts into the Harness:** rejected because the same four tools and skills can produce presentations, email, websites, WordPress changes over SSH, Next.js projects, and future work without product-specific execution paths.

## Consequences

- The bridge and compatibility layers are deleted rather than adapted to the new Harness.
- Existing external-Harness Sessions are not silently migrated into the new database. Their source files remain untouched; migration or import is a separate decision.
- Desktop packaging must provide everything needed to start the Host and selected native shell without requiring an external coding-agent CLI. General project toolchains may still be installed or configured by the user or agent.
- Long-running runs continue in the Host after a Web or Mobile client disconnects. Clients can reconnect and rebuild state from durable entries plus the current live-run snapshot.
- OpenAI-compatible does not imply one universal wire format. Codex Responses/OAuth and custom Chat Completions-compatible endpoints require separate, tested internal adapters.
- The accepted implementation sequence is recorded in [`first-party-harness-replacement.md`](../plans/first-party-harness-replacement.md).
