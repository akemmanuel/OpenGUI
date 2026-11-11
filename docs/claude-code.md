# Claude Code provider

The `claude-code` provider runs Claude models through [Claude Code](https://claude.com/claude-code)
with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). It lets a Host use
a Claude subscription (Pro, Max, Team) the way Claude Code does, as well as a long-lived token or an
Anthropic API key. To pi and the rest of OpenGUI it is an ordinary pi provider
(`packages/harness/src/models/claude-code/`).

## How it works

OpenGUI keeps its agent loop. Tools, path policy, permissions, compaction and the Session
transcript stay in the Harness, exactly as for every other provider. Only the model call changes.

- **One Claude Code process per Session**, kept warm between requests so its prompt cache and context
  survive. Claude Code reads none of its own settings: built-in tools, `CLAUDE.md`, memory, auto
  compaction, tool search, skills, background tasks and the advisor are off, and the system prompt
  is OpenGUI's.
- **OpenGUI runs every tool.** OpenGUI's tools reach Claude as `mcp__og__<tool>` from an in-process
  MCP server. Each handler holds its call; the response ends with the tool calls, the Harness runs
  them as usual, and their results arrive with the next request and release the handlers. Calls run
  one at a time, in order.
- **Only what Claude has not seen is sent.** The runtime fingerprints the transcript entries the
  process has seen (`protocol.ts`). New tool results release held calls; new user messages are sent
  as user messages (during a tool batch they are queued first, so Claude Code hands them over right
  after the results); the same request again returns the same reply, even while it is still being
  written. Anything else (another model wrote the history, an edit, a compaction, a changed prompt,
  tool set, model, effort or credential, a stopped process) starts a **fresh process**, whose first
  message carries the earlier conversation as a `<conversation-checkpoint>` transcript.
- **Reasoning** is Claude Code's effort (`low` to `max`). Thinking summaries stream as reasoning.
  Changing the effort in a conversation starts a fresh process.
- **Stopping a run** stops its process; the next request starts fresh.
- **Usage** reports input, cache read and cache write tokens per response. Costs are estimates at
  standard API prices; on a subscription nothing is billed per token.
- Failures are worded so OpenGUI classifies them like any provider's (authentication, rate or usage
  limit, context window, unavailable), so runs retry or stop as usual.

Idle processes stop after 10 minutes; one holding tool calls waits up to 2 hours (a run's limit). At
most 6 processes stay live; the least recently used idle one stops first. Sessions are not written to
`~/.claude/projects`, so they do not appear in `claude --resume`.

Adapted from the Claude bridge in crocov3, which runs the same protocol over HTTP from a container.
Here it runs in the Host process.

## Signing in

Settings › Providers › Claude Code offers:

- **Subscription → Use Claude Code's login on this computer.** Uses the account the `claude` CLI is
  signed in to on the Host machine. Run `claude` and `/login` first. Only the Host's own connection
  can use it. A personal connection on a multi-user Host must bring its own credential.
- **Subscription → Paste a token from `claude setup-token`.** A long-lived token for one Claude
  account, stored in Host secret storage.
- **API key.** An Anthropic Console key; requests are billed to its organization.

Ambient `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` variables are
removed from Claude Code's environment, so the chosen sign-in is the one used. Token and API-key
sign-ins run with their own `CLAUDE_CONFIG_DIR`, never the user's.

Anthropic allows a person to use their own Claude plan through Claude Code and the Agent SDK.
Offering that login to other people is not allowed without approval. Do not share a Host connection
signed in with a personal plan through model offerings to other members.

## Claude Code executable

The Host looks for Claude Code in this order:

1. `OPENGUI_CLAUDE_CODE_EXECUTABLE`, if set;
2. the native build that ships with the Agent SDK for this platform (development, web and Docker
   installs);
3. an installed `claude` on `PATH`, in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` or
   `/usr/local/bin`.

The desktop app does not bundle Claude Code (it is over 300 MB), so it uses an installed one.

## Settings

| Variable                         | Effect                                                                  |
| -------------------------------- | ----------------------------------------------------------------------- |
| `OPENGUI_CLAUDE_CODE_EXECUTABLE` | Path of the Claude Code executable to run.                              |
| `OPENGUI_CLAUDE_CODE_DEBUG=1`    | Logs process starts, fresh sessions, failures and Claude Code's stderr. |
