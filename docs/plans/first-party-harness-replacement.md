# Plan: Replace external Harness bridges with the first-party OpenGUI Harness

Companion to [ADR 0010](../adr/0010-first-party-opengui-harness.md). Canonical product language: [`CONTEXT.md`](../../CONTEXT.md).

## Status

Planned. No implementation phase has started.

## Fixed product constraints

| Constraint | Decision                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Audience   | Lightly technical everyday builders, commonly familiar with WordPress and basic HTML/CSS/JavaScript                              |
| UI         | Preserve the current Projects/Sessions sidebar, transcript, inline tool calls, PromptBox, model/reasoning controls, and settings |
| Execution  | One first-party OpenGUI Harness; no Pi, OpenCode, Codex CLI/SDK, Claude Code, or Grok bridge                                     |
| Tools      | Exactly `read`, `write`, `edit`, and `shell`                                                                                     |
| Safety     | Unrestricted v1; no sandbox, approvals, command policy, MCP, or extensions                                                       |
| Sessions   | Host-owned append-oriented SQLite log                                                                                            |
| Models     | Codex/ChatGPT OAuth preset plus custom OpenAI-compatible connections                                                             |
| Skills     | Agent Skills `SKILL.md` format with progressive disclosure                                                                       |
| Targets    | Desktop local Host; Web and Mobile clients; self-hosted and OpenGUI-hosted remote Hosts                                          |
| Mobile     | Remote client only in v1; no phone-local reduced Harness                                                                         |
| Work       | General-purpose directory work, including presentations, email, HTML, WordPress over SSH, and Next.js                            |
| Git        | No Git or worktree product integration or prerequisite                                                                           |

## Non-goals

- Redesigning the app for a new audience
- Files, Activity, Results, artifact manifests, output directories, or task-type-specific UI
- Direct local execution on iOS or Android
- External Harness compatibility or optional legacy bridge plugins
- MCP, extension hooks, custom tool registration, or provider plugins
- Multi-tenant execution without per-customer infrastructure isolation
- Automatic import of existing external-Harness Sessions
- A public SDK in the first migration
- Interactive PTY support in the v1 `shell` tool

## Target architecture

```text
┌──────────────────────────────────────────────────────────┐
│ OpenGUI Frontend                                         │
│ Existing UI: Workspaces · Projects · Sessions · Chat     │
└───────────────────────────┬──────────────────────────────┘
                            │ product client interface
┌───────────────────────────▼──────────────────────────────┐
│ OpenGUI Host                                             │
│ auth · transport · queues · SQLite · multi-client state │
└───────────────────────────┬──────────────────────────────┘
                            │ one in-process interface
┌───────────────────────────▼──────────────────────────────┐
│ OpenGUI Harness                                          │
│ agent loop · context · models · skills · four tools      │
└───────────────┬───────────────────────┬──────────────────┘
                │                       │
        ┌───────▼────────┐      ┌──────▼─────────────────┐
        │ Model adapters │      │ Native Host resources │
        │ Codex Responses│      │ filesystem · shell    │
        │ OpenAI compat  │      │ child processes       │
        └────────────────┘      └────────────────────────┘
```

Deployment is one Host implementation with multiple shells:

```text
Desktop Shell ── private local transport ── local Host
Web Shell ────── authenticated HTTP/events ─ remote Host
Mobile Shell ─── authenticated HTTP/events ─ remote Host
```

The existing `@opengui/backend` package may retain its package name during migration. Product and architecture language calls the running process the **OpenGUI Host**. Do not spend a migration phase on package renaming unless it materially reduces coupling.

## Module shape

Create a fresh `packages/harness/` module. It must not import from `src/agents`, `server/services`, `packages/runtime`, external bridge modules, or frontend protocol types.

```text
packages/harness/src/
├── harness.ts              # small Host-facing interface
├── session.ts              # Session handle and run coordination
├── loop/                   # model → tools → model turn loop
├── context/                # durable entries → model context; compaction
├── models/
│   ├── transport.ts        # internal model seam
│   ├── openai-chat.ts      # custom OpenAI-compatible endpoint
│   └── codex-responses.ts  # Codex OAuth preset
├── tools/
│   ├── read.ts
│   ├── write.ts
│   ├── edit.ts
│   └── shell.ts
├── skills/                 # discovery, validation, prompt metadata
├── storage/                # SQLite schema, migrations, append/replay
└── test/                   # fake model, fake clock, temp database
```

### External seam

Prefer a session-first interface rather than a generic RPC-shaped method collection:

```ts
interface OpenGuiHarness {
  listSessions(projectDirectory: string): Promise<SessionSummary[]>;
  createSession(input: CreateSessionInput): Promise<HarnessSession>;
  openSession(sessionId: string): Promise<HarnessSession>;
  close(): Promise<void>;
}

interface HarnessSession {
  read(): Promise<SessionSnapshot>;
  run(prompt: PromptInput): AsyncIterable<SessionEvent>;
  followUp(prompt: PromptInput): Promise<void>;
  abort(): Promise<void>;
  setModel(selection: ModelSelection): Promise<void>;
  rename(title: string): Promise<void>;
  delete(): Promise<void>;
}
```

Names may change during implementation. Keep the interface small and hide storage transactions, provider deltas, tool schemas, queue dispatch, and context reconstruction inside the module.

### Internal seams

Only introduce seams where v1 has real variation:

- **Model transport:** Codex Responses/OAuth and custom OpenAI-compatible Chat Completions are two adapters.
- **Credential storage:** Desktop OS credential storage and remote Host secret storage are two adapters.
- **Frontend transport:** Desktop private transport and authenticated HTTP/event transport are two adapters to the same Host interface.

The fixed tools do not need a public plugin interface. The SQLite store does not need an alternative storage interface until a second implementation exists.

## Harness contracts

### Agent loop

One run performs:

1. append the accepted User message and `run_started` entry;
2. build model context from the active Session entries;
3. stream an assistant turn;
4. execute every requested tool call and append its result;
5. send the expanded context back to the model while tool calls continue;
6. append the completed Assistant message and `run_completed`, `run_failed`, or `run_aborted` entry;
7. dispatch the next persisted follow-up when the Session becomes idle.

Only one run may execute per Session. Follow-ups use one FIFO queue with no steer, after-part, front/back insertion, or provider-specific queue modes.

### Tool behavior

| Tool    | V1 contract                                                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`  | Read text with line/range limits and identify unsupported/binary content clearly. Absolute and Project-relative paths are allowed.                                                                       |
| `write` | Create or replace a file atomically; create parent directories when requested by the contract.                                                                                                           |
| `edit`  | Apply an exact, reviewable edit and fail clearly when the expected source does not match. Return a diff for the existing transcript renderer.                                                            |
| `shell` | Run one non-interactive command in the Project directory, stream combined stdout/stderr, truncate bounded returned output while retaining full output, support timeout/abort, and kill the process tree. |

Tools run with Host permissions and are not confined to the Project directory in v1. The Project directory is the default working directory, not a security boundary.

### Shell resolution

Resolve the executable once when a Host starts and report it in diagnostics and the system prompt:

1. explicit Host shell configuration, when present;
2. Windows: `pwsh`, then `powershell.exe`;
3. macOS/Linux: `$SHELL` when executable;
4. macOS/Linux fallback: `/bin/sh`.

Use the selected shell's command mode. For POSIX-family user shells this is normally `-lc`; for PowerShell use non-interactive command execution. A shell call does not preserve `cd`, variables, aliases, or process state for the next call.

### Minimal system prompt

Construct the prompt from only:

- a short statement that the model is OpenGUI's local general-purpose agent;
- one-line descriptions of the four available tools;
- concise behavior guidelines;
- available skill names, descriptions, and absolute `SKILL.md` paths;
- current date, Project directory, operating system, and selected shell.

Do not include external Harness documentation, MCP, extensions, Git workflow instructions, provider catalogs, or task-type-specific instructions. Tool schemas carry detailed calling instructions.

### Skills

- Accept directories containing `SKILL.md` with Agent Skills frontmatter.
- Discover bundled skills, Host-global skills, and Project-local skills.
- Put only validated name, description, and path metadata in the system prompt.
- Let the model use `read` to load full instructions on demand.
- Resolve relative references from the skill directory.
- Do not let skills register tools, hooks, model providers, UI, or extension code.
- Treat installation/marketplace behavior as separate from Harness discovery. Public marketplace expansion is not required for cutover.

## Session storage

The new database is the canonical Session and transcript store. Reuse `node:sqlite` infrastructure where useful, but do not extend the legacy queue-only `StorageService` or preserve its external-Harness identity model.

### Minimum schema direction

```text
sessions
  id
  project_directory
  title
  created_at
  updated_at

session_entries
  id
  session_id
  sequence
  kind
  payload_json
  created_at

session_follow_ups
  id
  session_id
  sequence
  prompt_json
  state
  created_at

settings
  key
  value_json
```

Required entry kinds:

- `session_created`
- `session_renamed`
- `model_changed`
- `reasoning_changed`
- `run_started`
- `user_message`
- `assistant_message`
- `tool_call`
- `tool_result`
- `compaction`
- `run_completed`
- `run_failed`
- `run_aborted`
- `run_interrupted`

Contracts:

- `(session_id, sequence)` is unique and monotonically increasing.
- Appending a semantic entry and updating Session metadata happen in one transaction.
- SQLite runs with foreign keys and WAL enabled.
- Schema migrations are explicit and tested from every released Harness schema version.
- Credentials never appear in Session entries, tool diagnostics, or plain SQLite settings.
- Streaming deltas are emitted live. The final semantic message is appended once.
- On startup, a `run_started` entry without a terminal run entry becomes `run_interrupted`.

### Context and compaction

- Rebuild model context from durable Session entries, not frontend transcript state.
- Preserve the model and reasoning selection that applied to each User message.
- Add automatic compaction before context overflow; append the summary and token boundary as a `compaction` entry.
- Failed overflow requests must not become normal assistant history.
- Context behavior must remain deterministic under replay tests.

## Host protocol

Replace the broad `OpenGuiClient` surface with a Host product interface centered on:

- Host health and version;
- model connections, authentication, model list, and diagnostics;
- Project directory registration/listing needed by the current UI;
- Session list/create/read/rename/delete;
- send/follow-up/abort;
- ordered live Session events and current-run snapshot;
- existing upload, file mention, and file-search behavior needed by PromptBox.

Do not expose:

- `harnessId`, Harness inventory, Harness capabilities, bridge channels, native provider events, MCP, permission/question compatibility, Git, or worktrees;
- external session IDs or directory-to-Harness routing hints; or
- parallel transcript projections in Runtime, Backend, and Frontend.

Desktop, HTTP, and Mobile clients must share generated or contract-tested request/response/event types.

## Frontend cutover

Preserve the visual structure and reuse the existing visual modules. Change orchestration and vocabulary only where the removed architecture requires it.

### Keep

- App shell, sidebar structure, Project rows, Session rows, search, and settings layout
- PromptBox composition, file uploads/mentions, model selection, reasoning selection, send/stop controls, and drafts
- Message Markdown, code, diff, shell/tool-call rendering, transcript viewport, scroll behavior, and notifications
- Desktop, Web, and Mobile responsive shells
- Themes, i18n, and UI primitives

### Remove or simplify

- Setup checks for installed external Harness CLIs
- Harness/agent/worktree selectors and Harness-specific variants
- Harness inventory and readiness UI
- MCP, external extension, bridge restart, and provider-via-Harness settings
- Git branch/worktree sidebar metadata and actions
- Frontend fields whose only purpose is external identity or transcript reconciliation, including `harnessId`, `_backendId`, `_rawId`, external capability maps, and bridge event compatibility

### Setup replacement

Keep the current wizard and settings surfaces. Replace external-Harness installation with:

1. ChatGPT/Codex sign-in;
2. optional custom OpenAI-compatible connection;
3. remote Host connection where the Shell does not provide a Local Host; and
4. the existing optional appearance/default-directory choices.

Do not add new Files, Activity, Results, or task-template surfaces.

## Migration phases

### Phase 0: decision and guardrails

- [x] Accept ADR 0010.
- [x] Record target language in `CONTEXT.md` and product direction in `PRODUCT.md`.
- [ ] Add a temporary CI guard that no new files are added under external bridge directories.
- [ ] Record a baseline of non-test LOC, dependencies, packaged size, startup time, and current acceptance tests.
- [ ] Freeze new external Harness features; only release-blocking fixes land during migration.

**Exit:** contributors know the old multi-Harness architecture is a removal target, not an interface the new Harness must implement.

### Phase 1: remove Git and worktree product code

- [ ] Remove `OpenGuiClient.git` and `OpenGuiClient.worktree`.
- [ ] Delete worktree hooks, dialogs, selectors, placement rules, setup detection, and merge actions.
- [ ] Delete Git branch/remote/status presentation and shell handlers.
- [ ] Remove worktree state, persistence keys, types, tests, and translations.
- [ ] Keep generic Project directories and the `shell` tool's ability to execute any installed command. “No Git” means no product integration or prerequisite, not a shell command blacklist.

**Exit:** the shipped UI and protocol contain no Git/worktree feature.

### Phase 2: create the independent Harness foundation

- [ ] Create `packages/harness` with no legacy Runtime imports.
- [ ] Define the small Harness/Session interface and semantic event union.
- [ ] Add deterministic fake model, fake clock, temporary SQLite database, and process runner test helpers.
- [ ] Implement SQLite schema/migrations and append/replay first.
- [ ] Implement model/reasoning changes, Session CRUD, run lifecycle, interruption recovery, and FIFO follow-ups.

**Exit:** a test can create a Session, append and replay entries, restart the Harness, and obtain the same snapshot.

### Phase 3: implement the four tools and agent loop

- [ ] Implement `read`, `write`, and `edit` with bounded output and clear error results.
- [ ] Implement platform-native `shell` resolution and process-tree cancellation.
- [ ] Implement streamed tool updates and final tool results.
- [ ] Implement the model/tool loop against the fake model.
- [ ] Implement minimal system prompt and skills discovery/loading.
- [ ] Implement abort, retry classification, context accounting, and compaction.

**Exit:** deterministic tests cover text-only turns, multiple sequential tool calls, tool failure, malformed arguments, abort, timeout, context compaction, and restart after an interrupted run.

### Phase 4: model connections and authentication

- [ ] Implement the internal model transport seam.
- [ ] Implement custom OpenAI-compatible Chat Completions streaming, including tool calls and usage.
- [ ] Implement Codex Responses streaming and OAuth login/refresh.
- [ ] Implement credential storage for Desktop and remote Hosts without putting secrets in Session SQLite.
- [ ] Add adapter conformance tests for text, reasoning, tool calls, abort, Unicode, empty output, usage, rate limits, malformed streams, and context overflow.
- [ ] Validate Codex OAuth distribution and refresh behavior before making it the default setup path.

**Exit:** a clean install can authenticate, select a model, run all four tools, restart, refresh credentials, and resume the Session.

### Phase 5: embed the Harness in the Host

- [ ] Create one Host-owned Harness instance per Host process.
- [ ] Replace external Harness bootstrap with first-party Harness bootstrap.
- [ ] Add the narrow Host endpoints and private Desktop transport methods.
- [ ] Stream ordered semantic events and current-run snapshots to multiple clients.
- [ ] Move queue arbitration onto the new FIFO follow-up model.
- [ ] Keep existing uploads/file mentions and directory browsing working.
- [ ] Ensure a run continues after all Frontends disconnect.

**Exit:** two clients can observe and control the same running Session, disconnect, reconnect, and recover from SQLite plus the live snapshot.

### Phase 6: cut the current UI over

- [ ] Replace setup wizard external-Harness checks with model authentication/Host connection.
- [ ] Replace resource catalog and model routing with Host-owned model connections.
- [ ] Connect existing Project, Session, transcript, tool-call, PromptBox, queue, and notification UI to the new Host interface.
- [ ] Replace the external-Harness reducer/provider state with minimal Project, Session, selection, run, follow-up, draft, and connection state.
- [ ] Remove Harness, agent, variant, MCP, permission, question, and worktree controls.
- [ ] Keep model/reasoning selection and existing visual layout.

**Exit:** the default Desktop build uses only the first-party Harness for a complete Project/Session workflow.

### Phase 7: delete the legacy architecture

- [ ] Delete `packages/runtime/src/adapters/**`.
- [ ] Delete `packages/claude-agent-sdk-lite/**`.
- [ ] Delete bridge registration, bridge IPC coercion, project slots, daemon/RPC compatibility, and Harness inventory.
- [ ] Delete external event normalization, transcript reconciliation, dispatch indexes, session identity codecs, and legacy external Session routing.
- [ ] Remove Pi, OpenCode, Codex SDK, Claude Code, and Grok dependencies and packaged assets.
- [ ] Remove old bridge scripts, tests, quality gates, docs, and package scripts.
- [ ] Remove the old `@opengui/runtime` public SDK unless a still-used internal module earns retention under a non-legacy interface.
- [ ] Add a slop check banning old Harness IDs, bridge registration, and frontend native provider event types.

**Exit:** repository search finds no product dependency on external coding-agent Harnesses; build artifacts contain none of their SDKs or daemons.

### Phase 8: platform and deployment acceptance

- [ ] Windows Desktop: PowerShell, process-tree abort, paths with spaces, Unicode, installer, updater, and no Git/Bash prerequisite.
- [ ] macOS Desktop: configured user shell, app-launched PATH, signing/notarization, abort, and updater.
- [ ] Linux Desktop: configured user shell with `/bin/sh` fallback, package formats, abort, and updater.
- [ ] Web: same-origin and separately hosted frontend against a remote Host.
- [ ] Mobile: connect/authenticate, reconnect to running Session, send/follow-up/abort, uploads, notifications, and no local execution claims.
- [ ] Self-hosted: persistent volume, auth, upgrades, SQLite backup, and shell diagnostics.
- [ ] OpenGUI-hosted: one isolated execution environment and credential boundary per customer.

**Exit:** the same Session can be started on its Host, observed from every supported client, and resumed after client reconnection.

### Phase 9: release migration and documentation

- [ ] Preserve existing Project/Workspace presentation where paths and Host connections remain valid.
- [ ] Start new first-party Sessions in the new database.
- [ ] Leave external Harness session files untouched; do not claim they were imported.
- [ ] Decide separately whether to offer a one-time read-only transcript importer.
- [ ] Handle legacy queued prompts explicitly; never dispatch them against guessed new Sessions.
- [ ] Rewrite README, setup, architecture, security, self-hosting, and mobile docs for the first-party Harness.
- [ ] Remove or archive superseded implementation plans after the release branch no longer needs them.

**Exit:** a new user can install Desktop, authenticate, add a Project, and run a long task without installing Git or an external coding-agent CLI.

## Test strategy

### Harness interface tests

- Session creation, rename, deletion, list ordering, and project scoping
- Exact ordered entry replay after process restart
- Model and reasoning changes at the correct point in context
- Text, reasoning, one tool call, many tool calls, and tool errors
- Follow-up FIFO ordering and one-running-run invariant
- Abort during model stream and during every tool
- Host crash leaving an interrupted run
- Compaction and context-overflow recovery
- Credentials and obvious secret fields excluded from entries and logs

### Tool tests

- Absolute, relative, missing, binary, large, and Unicode paths
- Atomic write failure and edit source mismatch
- Output line/byte truncation with retained full output
- Timeout and descendant-process termination
- Windows PowerShell quoting and exit codes
- macOS/Linux configured-shell selection and fallback

### Model adapter conformance

Run the same suite against recorded/fake streams for each adapter:

- text and reasoning deltas
- partial tool-call JSON
- multiple tool calls
- usage and finish reasons
- abort and network interruption
- authentication refresh
- rate limit and retry metadata
- context overflow
- malformed or unsupported responses

### Product acceptance

- Existing Project/sidebar/session/chat layout remains recognizable.
- No external Harness, Git, worktree, MCP, or extension setup is required.
- A long run survives Frontend disconnect.
- A second Frontend sees the current Session state.
- Desktop works without an external coding-agent CLI or Git installation.
- Web and Mobile clearly connect to a Host and never imply phone/browser-local shell execution.

## Quality gates

After each phase:

```bash
pnpm run test
pnpm run check
```

When changing Host Session paths, `OpenGuiClient`, or registry/bootstrap code:

```bash
pnpm run slop-check
```

Do not use `tsc` for project typechecking. Add Windows, macOS, and Linux CI coverage before the shell implementation is considered complete.

## Deletion targets

The migration succeeds by deleting compatibility, not moving it. Expected high-value removal areas include:

- `packages/runtime/src/adapters/`
- `packages/runtime/src/live-session-events/`
- `packages/claude-agent-sdk-lite/`
- most of `src/agents/`
- Harness inventory and registry modules
- external Session identity and transcript projection compatibility
- Git/worktree UI, hooks, protocol, shell handlers, tests, and state
- Harness-specific resource, permission, question, MCP, and provider UI paths
- bridge probe/debug scripts and bridge-specific quality workflows

Re-measure non-test LOC and packaged dependency size after Phases 1, 6, and 7. Net deletion is a release criterion; replacing every old type with an equally broad new abstraction is not acceptable.

## Risk register

| Risk                                                           | Mitigation                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Codex OAuth changes or cannot be distributed as assumed        | Feasibility and policy validation in Phase 4 before setup cutover; custom OpenAI-compatible connection remains available          |
| “OpenAI-compatible” endpoint quirks recreate bridge complexity | Support a narrow documented contract; isolate quirks inside model adapters; require conformance tests                             |
| Native user shells behave differently                          | Report exact shell, dynamically describe it to the model, test PowerShell and common POSIX shells, provide explicit Host override |
| GUI-launched apps have incomplete PATH                         | Resolve environment at Host startup through the selected login shell and expose diagnostics                                       |
| Unrestricted hosted execution crosses customer boundaries      | One isolated environment and credential boundary per customer; never share one unrestricted OS account                            |
| SQLite grows or corrupts during long Sessions                  | WAL, transactions, migrations, backup documentation, bounded tool payloads, and recovery tests                                    |
| Dual architecture lasts indefinitely                           | Freeze legacy features, define phase exit criteria, and delete all bridge code immediately after UI cutover                       |
| Existing users expect old Sessions                             | Leave source data untouched, communicate the cutover, and make import a separate explicit decision                                |
| Frontend rewrite expands scope                                 | Preserve current visual modules and ban new task-specific surfaces from this plan                                                 |

## First implementation slice

After the independent Git/worktree deletion, the first Harness slice should prove only:

1. create SQLite Session for a Project directory;
2. append a User message;
3. stream a fake model requesting `read`;
4. execute `read` and append the Tool result;
5. stream and append the final Assistant message;
6. close and reopen the database; and
7. replay an identical transcript through the Harness interface.

Do not begin OAuth, provider settings, frontend cutover, skills marketplace behavior, or bridge deletion until this slice is deterministic.
