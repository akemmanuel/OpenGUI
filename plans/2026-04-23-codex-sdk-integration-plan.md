# Codex TypeScript SDK Integration Plan

Date: 2026-04-23
Project: OpenGUI
Target backend: OpenAI Codex via `@openai/codex-sdk`

## Goal

Add new backend named `codex` beside existing:

- `opencode`
- `claude-code`
- `pi`

Use official TypeScript SDK from:

- `https://github.com/openai/codex/tree/main/sdk/typescript`

This plan is read-only and implementation-oriented.

---

## Executive summary

Codex TypeScript SDK is good fit for **live turn execution**.

It is **not** full backend SDK like OpenCode or Pi.

It gives:

- local CLI process wrapper
- thread start/resume
- streamed events
- model / sandbox / cwd / approval-policy flags
- image input by local file paths
- abort via `AbortSignal`

It does **not** give:

- thread listing
- thread transcript reading
- rename
- delete/archive
- fork
- model discovery
- provider discovery
- permission request callbacks for UI
- user-question / request-user-input bridge
- MCP management APIs
- skills listing
- slash command discovery

So recommended integration is:

1. build **Phase 1 Codex backend on top of `@openai/codex-sdk`**
2. fill missing pieces with **OpenGUI-owned metadata + transcript cache**
3. leave future escape hatch to Codex app-server protocol for full parity

---

## Repo facts discovered

### OpenGUI side

Current backend architecture already supports multiple backends:

- main-process bridges in repo root:
  - `opencode-bridge.mjs`
  - `claude-code-bridge.mjs`
  - `pi-bridge.mjs`
- preload bridge:
  - `preload.cjs`
- renderer adapters:
  - `src/agents/opencode.ts`
  - `src/agents/claude-code.ts`
  - `src/agents/pi.ts`
- backend abstraction:
  - `src/agents/backend.ts`
- backend picker:
  - `src/components/ConnectionPanel.tsx`
- backend selection state:
  - `src/hooks/use-agent-backend.ts`

Current Electron app loads local bridges in `main.cjs`.

Current app already uses temp-session replacement flow for Claude Code. Reducer supports `session.replaced` in `src/hooks/use-agent-impl-core.tsx`.

That pattern is useful for Codex because real thread id only appears after streaming starts.

### Codex SDK side

Cloned repo under:

- `/tmp/openai-codex`

Key files inspected:

- `/tmp/openai-codex/sdk/typescript/README.md`
- `/tmp/openai-codex/sdk/typescript/src/index.ts`
- `/tmp/openai-codex/sdk/typescript/src/codex.ts`
- `/tmp/openai-codex/sdk/typescript/src/thread.ts`
- `/tmp/openai-codex/sdk/typescript/src/events.ts`
- `/tmp/openai-codex/sdk/typescript/src/items.ts`
- `/tmp/openai-codex/sdk/typescript/src/exec.ts`
- `/tmp/openai-codex/codex-cli/package.json`
- `/tmp/openai-codex/codex-rs/app-server/README.md`

SDK exports:

- `Codex`
- `Thread`
- event types
- item types
- thread options
- codex options
- turn options

Main SDK methods:

- `new Codex(options)`
- `codex.startThread(threadOptions)`
- `codex.resumeThread(id, threadOptions)`
- `thread.run(input, turnOptions)`
- `thread.runStreamed(input, turnOptions)`
- `thread.id`

Thread event types from `sdk/typescript/src/events.ts`:

- `thread.started`
- `turn.started`
- `turn.completed`
- `turn.failed`
- `item.started`
- `item.updated`
- `item.completed`
- `error`

Thread item types from `sdk/typescript/src/items.ts`:

- `agent_message`
- `reasoning`
- `command_execution`
- `file_change`
- `mcp_tool_call`
- `web_search`
- `todo_list`
- `error`

SDK runtime behavior from `sdk/typescript/src/exec.ts`:

- spawns `codex exec --experimental-json`
- resolves bundled CLI from `@openai/codex`
- uses local child process, not remote hosted SDK session object
- supports:
  - `--model`
  - `--sandbox`
  - `--cd`
  - `--add-dir`
  - `--skip-git-repo-check`
  - `--output-schema`
  - `--image`
  - `approval_policy`
  - reasoning effort config
  - web search config
  - abort signal

Important packaging fact:

- `@openai/codex-sdk` resolves CLI binary from `@openai/codex`
- so OpenGUI must package **both** packages

---

## Why SDK-only integration is partial

OpenGUI backend abstraction expects backend to provide stable answers for:

- list sessions
- get messages for old sessions
- rename session
- delete session
- fork session
- list models/providers
- list commands
- permission prompts
- question prompts

Codex TS SDK only covers live execution path.

That means Codex integration needs local bridge-owned shims for:

- session index
- transcript persistence
- local title overrides
- local hidden/archive markers
- model catalog

Without those shims, backend would stream but feel incomplete in desktop UI.

---

## Recommended product shape

## Recommendation

Build **Codex Phase 1** on top of `@openai/codex-sdk`, with intentionally reduced capability flags.

Reason:

- uses exact SDK requested
- fits current bridge architecture
- avoids running separate server process
- lower integration risk
- lower latency
- bundled CLI path already solved by upstream package layout

Do not try full parity in first pass.

Leave future path to Codex app-server if OpenGUI later wants:

- true thread listing
- full stored transcript loading
- rename/archive/delete
- model list from source of truth
- approvals and questions
- MCP management

---

## Phase 1 scope

### In scope

- select `Codex` from backend picker
- connect local project directory
- start new thread from prompt box
- resume known thread by id
- stream assistant output live
- show reasoning blocks
- show command execution blocks
- show file-change blocks
- show MCP tool-call blocks as tool parts
- show todo lists
- abort running turn
- image input support
- model selection from curated model catalog
- session listing for OpenGUI-known Codex threads
- persisted OpenGUI transcript snapshots for reopened sessions
- best-effort file search for `@mentions`

### Out of scope for first pass

- provider auth UI
- permission prompts
- request-user-input / interactive question UI
- MCP config/status UI
- skills listing UI
- slash command discovery
- true thread rename in Codex storage
- true thread delete/archive in Codex storage
- backend-native fork
- revert / unrevert
- message paging for stored sessions
- full import of arbitrary external Codex session history

---

## Proposed backend capabilities

Recommended initial capability object:

```ts
{
  sessions: true,
  streaming: true,
  messagePaging: false,
  images: true,
  models: true,
  agents: false,
  commands: false,
  compact: false,
  fork: false,
  revert: false,
  permissions: false,
  questions: false,
  providerAuth: false,
  mcp: false,
  skills: false,
  config: false,
  localServer: false,
}
```

Notes:

- `compact` can be upgraded later if `/compact` via non-interactive exec proves reliable
- `commands` can be upgraded later if we expose curated slash commands
- `fork` should stay false until there is real persistence-level support, not fake copy-only behavior

Workspace profile should match other local CLI backends:

```ts
{
  kind: "local-cli",
  fields: {
    serverUrl: false,
    username: false,
    password: false,
    directory: true,
  }
}
```

---

## Architecture fit inside OpenGUI

Codex should follow existing local-bridge pattern.

### New files

- `codex-bridge.mjs`
- `src/agents/codex.ts`
- `plans/2026-04-23-codex-sdk-integration-plan.md`

### Existing files to modify

- `package.json`
- `main.cjs`
- `preload.cjs`
- `src/types/electron.d.ts`
- `src/agents/index.ts`
- `src/hooks/use-agent-backend.ts`
- `src/components/ConnectionPanel.tsx`
- optional docs:
  - `README.md`
  - `CONTRIBUTING.md`

---

## Dependency and packaging plan

## Dependencies

Add runtime dependencies:

- `@openai/codex-sdk`
- `@openai/codex`

Why both:

- SDK package is wrapper only
- actual CLI binary is resolved from `@openai/codex`
- `sdk/typescript/src/exec.ts` uses package resolution into CLI vendor bundle

## Electron packaging

Add to `package.json > build.files`:

- `codex-bridge.mjs`
- `node_modules/@openai/codex-sdk/**/*`
- `node_modules/@openai/codex/**/*`

Potentially verify whether extra platform-specific package globs are needed after install shape is known. Most likely whole `@openai/codex` package is enough because it already contains `vendor/`.

## App size impact

Codex binary bundle will increase release size.

Need expect larger `.deb` / `.dmg` / `.exe`.

---

## Main-process bridge design

Implement `CodexBridgeManager` in `codex-bridge.mjs`.

Bridge should own:

- project registry by `workspaceId + directory`
- live thread runtimes keyed by thread id
- active abort controllers keyed by thread id
- transcript cache keyed by thread id
- persisted local session index
- local session metadata overrides
- temporary image staging files

### Suggested internal structures

```ts
type CodexProject = {
  key: string;
  directory: string;
  workspaceId?: string;
};

type CodexSessionRecord = {
  id: string;
  directory: string;
  workspaceId?: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  reasoningEffort?: string;
  hidden?: boolean;
  origin: "opengui" | "discovered";
};

type LiveThreadState = {
  threadId: string | null;
  tempSessionId?: string;
  project: CodexProject;
  thread: Thread;
  abortController: AbortController | null;
  messages: Array<{ info: Message; parts: Part[] }>;
  currentAssistantMessageId: string | null;
  currentUserMessageId: string | null;
  startedAt: number;
  updatedAt: number;
  tempFiles: string[];
  model?: string;
  reasoningEffort?: string;
};
```

### Why main-process bridge

Same reasons as Pi and Claude Code bridges:

- local binary spawn belongs in Electron main
- avoid exposing subprocess logic to renderer
- centralize event fan-out over IPC
- control env, temp files, and lifecycle in one place

---

## IPC surface plan

Expose Codex channels parallel to Pi / Claude Code.

### Events

- `codex:bridge-event`

### Project lifecycle

- `codex:project:add`
- `codex:project:remove`
- `codex:disconnect`

### Sessions

- `codex:session:list`
- `codex:session:create`
- `codex:session:delete`
- `codex:session:update`
- `codex:session:statuses`
- `codex:session:start`
- `codex:messages`

### Prompting

- `codex:prompt`
- `codex:abort`
- `codex:session:summarize`

### Model / command metadata

- `codex:providers`
- `codex:agents`
- `codex:commands`

### Utility

- `codex:find:files`

Return shape should match existing preload bridge conventions:

```ts
{ success: true, data }
{ success: false, error }
```

---

## Renderer adapter plan

Create `src/agents/codex.ts` modeled after `src/agents/pi.ts`.

Responsibilities:

- define backend id `codex`
- set capability flags
- define workspace profile `local-cli`
- wrap native preload calls with `requireSuccess`
- normalize `codex:event` payloads into `AgentBackendEvent`
- tag sessions with `_projectDir` and `_workspaceId`

New backend registration:

- `src/agents/index.ts`: add `codex`
- `src/hooks/use-agent-backend.ts`: persist/restore `codex`

---

## Type definitions plan

Add `CodexBridge` to `src/types/electron.d.ts`.

Add new event union branch:

```ts
| {
    type: "codex:event";
    payload: unknown;
    directory?: string;
    workspaceId?: string;
  }
```

Add `ElectronAPI.codex?: CodexBridge`.

CodexBridge methods should mirror Pi/Claude where possible:

- `addProject`
- `removeProject`
- `disconnect`
- `listSessions`
- `createSession`
- `deleteSession`
- `updateSession`
- `getSessionStatuses`
- `getProviders`
- `getAgents`
- `getCommands`
- `getMessages`
- `startSession`
- `prompt`
- `abort`
- `summarizeSession`
- `findFiles`
- `onEvent`

No permission/question methods in phase 1.

---

## Session identity strategy

## Problem

New Codex thread id is unknown until stream emits `thread.started`.

OpenGUI wants session object immediately so UI can switch into it.

## Solution

Use Claude-style temp session flow.

### Start path

1. user sends first prompt from draft/no active session
2. bridge creates temporary session id like:
   - `codex:temp:<uuid>`
3. emit synthetic `session.created`
4. create synthetic user message immediately
5. launch `thread.runStreamed(...)`
6. when `thread.started` arrives:
   - store real thread id
   - emit `session.replaced` from temp -> real id
   - migrate cached messages, busy state, queued state

This already fits reducer support in `src/hooks/use-agent-impl-core.tsx`.

## Existing-session path

When prompting known thread:

- use `codex.resumeThread(threadId, threadOptions)`
- no temp replacement needed

---

## Session storage and indexing plan

Because SDK cannot list stored threads, OpenGUI must keep its own session index.

## Primary index

Persist lightweight Codex session registry in OpenGUI app data.

Suggested fields:

- `id`
- `directory`
- `workspaceId`
- `title`
- `preview`
- `createdAt`
- `updatedAt`
- `model`
- `reasoningEffort`
- `hidden`
- `origin`

This registry powers:

- sidebar session list
- reopen previous OpenGUI-created sessions
- local rename/delete overrides

## Secondary discovery

Optional best-effort discovery of Codex native sessions from:

- `CODEX_HOME/sessions/...`
- fallback `~/.codex/sessions/...`

Why optional:

- useful for showing sessions created outside OpenGUI
- but rollout format is not TS SDK contract
- parser must be best-effort and non-fatal

## Recommendation

Phase 1 should do:

1. guaranteed OpenGUI-owned local index
2. optional discovery layer behind tolerant parser

If discovery fails, backend still works.

---

## Transcript persistence plan

## Problem

SDK lacks `getMessages(threadId)`.

OpenGUI needs old messages when user reopens session.

## Solution

Persist **normalized OpenGUI transcript snapshots** per Codex thread.

### During live turn

As events stream in, bridge builds normalized bundles:

- `Message`
- `Part[]`

and persists them into local storage/file cache after terminal events.

### On reopen

`getMessages(sessionId)` loads from:

1. in-memory live cache if active
2. persisted normalized transcript snapshot if cold
3. optional best-effort Codex rollout parse if snapshot missing and native session exists

This avoids needing full Codex rollout reader in first pass.

## Why this is good enough

- OpenGUI only needs renderer-compatible transcript
- renderer already knows OpenCode-style `Message` + `Part`
- stored normalized snapshots isolate UI from Codex internal history format changes

---

## Message and part normalization plan

OpenGUI renderer already supports these useful part types:

- `text`
- `reasoning`
- `tool`
- `file`

Codex items should map into these existing shapes.

## User prompt message

On prompt submit:

- create user `Message`
- create one or more `text` parts from prompt text
- optionally create `file` parts for attached images

## Assistant message model

Use one assistant `Message` per turn.

As Codex items stream in, append or update parts under that assistant message.

### `agent_message`

Map to `text` part.

Behavior:

- first item -> create assistant message + text part
- update events -> emit `message.part.delta` when new text extends previous text
- fallback to `message.part.updated` if delta logic unclear

### `reasoning`

Map to `reasoning` part.

Behavior:

- same delta strategy as text
- preserve `time.start` and `time.end` where possible

### `command_execution`

Map to `tool` part.

Suggested normalized shape:

```ts
{
  type: "tool",
  tool: "shell",
  callID: item.id,
  state: {
    status: "running" | "completed" | "error",
    input: { command: item.command },
    output: item.aggregated_output,
    metadata: { exitCode: item.exit_code },
    time: { start, end }
  }
}
```

### `file_change`

Map to `tool` part, not new part kind.

Suggested normalized shape:

```ts
{
  type: "tool",
  tool: "apply_patch",
  callID: item.id,
  state: {
    status: item.status === "completed" ? "completed" : "error",
    input: {},
    output: "",
    metadata: { changes: item.changes }
  }
}
```

Reason:

- current renderer already knows tool timeline UI
- file-change details can live in metadata

### `mcp_tool_call`

Map to `tool` part.

Suggested normalized shape:

```ts
{
  type: "tool",
  tool: `${item.server}:${item.tool}`,
  callID: item.id,
  state: {
    status,
    input: item.arguments,
    output: item.result,
    error: item.error?.message,
  }
}
```

### `web_search`

Map to `tool` part:

```ts
{
  type: "tool",
  tool: "web_search",
  callID: item.id,
  state: {
    status: "completed",
    input: { query: item.query },
  }
}
```

### `todo_list`

Map to `tool` part in **TodoWrite-compatible** shape.

Reason:

- OpenGUI has `extractTodos()` in `src/lib/todos.ts`
- it expects todo data under `tool.state.input.todos`

Suggested normalized shape:

```ts
{
  type: "tool",
  tool: "todowrite",
  callID: item.id,
  state: {
    status: "running" | "completed",
    input: {
      todos: item.items.map(todo => ({
        content: todo.text,
        status: todo.completed ? "completed" : "pending",
        priority: "medium",
      }))
    }
  }
}
```

### `error`

Map to either:

- tool error part when clearly associated with active tool-like item
- `session.error` for session-level failures

Conservative first pass:

- emit `session.error`
- optionally attach tool part if active assistant message exists

---

## Streaming strategy

Always use `thread.runStreamed()`.

Do not use `thread.run()` for UI turns.

## Turn lifecycle mapping

### On start

- emit `session.status busy`

### On completion

- emit `session.status idle`
- persist transcript snapshot
- update session index timestamps / preview / title

### On turn failure

- emit `session.error`
- emit `session.status idle`
- keep partial transcript if any useful data already streamed

### On fatal stream error

- emit `session.error`
- emit `session.status idle`
- clean abort controller and temp files

---

## Abort plan

SDK supports `AbortSignal` through `TurnOptions.signal`.

Per active turn:

1. create `AbortController`
2. pass `signal` into `thread.runStreamed(..., { signal })`
3. store controller by thread id

On abort request:

1. call `controller.abort()`
2. clear busy session state
3. persist partial transcript snapshot
4. delete temp image files
5. emit `session.status idle`

Need careful cleanup in `finally` block regardless of success/failure.

---

## Image input plan

## Problem

OpenGUI renderer passes images as data URLs.

Codex SDK accepts images only as structured inputs using local file paths:

- `{ type: "local_image", path: "..." }`

## Solution

Bridge stages temp image files.

### Flow

1. renderer sends `images: string[]` data URLs
2. bridge decodes each data URL
3. bridge writes temp files in app temp dir
4. bridge constructs Codex input:

```ts
[
  { type: "text", text: promptText },
  { type: "local_image", path: tempPath1 },
  { type: "local_image", path: tempPath2 },
]
```

5. after turn completes/fails/aborts, bridge deletes temp files

### Requirements

- unique temp dir per turn
- guaranteed cleanup in `finally`
- preserve original extension from MIME when possible

This is mandatory for Codex image support.

---

## Model plan

## Problem

SDK can **set** model, but cannot **list** available models.

OpenGUI UI expects provider/model list.

## Recommended phase 1 solution

Return curated synthetic provider/model catalog from bridge.

### Provider

Single provider:

- `openai`

### Suggested model set

Initial curated list:

- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.4-nano`
- `gpt-5.3-codex`

Optional later additions:

- enrich from OpenGUI session history
- enrich from discovered native Codex metadata

## Reasoning variants

Codex thread options support reasoning effort values:

- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

Map OpenGUI `variant` selector to `modelReasoningEffort`.

This preserves current UI model/variant workflow without native model discovery API.

## Caveat

Curated model list can drift from real Codex availability.

Long-term better source of truth is Codex app-server `model/list`.

---

## Provider/auth plan

Codex SDK auth is CLI-side.

Likely user flows:

- sign in with ChatGPT in Codex CLI
- or set `CODEX_API_KEY`

Phase 1 should not attempt provider auth UI.

## UX implication

Connection panel / docs should explain:

- Codex runs locally
- authenticate outside OpenGUI first
- OpenGUI does not manage Codex auth in first pass

## Environment plan

Do not blindly inherit hostile Electron env without thought.

Recommended allowed env baseline:

- `PATH`
- `HOME` / `USERPROFILE`
- `SHELL`
- `TMPDIR` / `TMP` / `TEMP`
- `SSL_CERT_FILE`
- `HTTPS_PROXY`
- `HTTP_PROXY`
- `NO_PROXY`
- `CODEX_*`
- `OPENAI_*`

Then layer any bridge-specific env overrides on top.

---

## Working directory and trust plan

Codex requires working directory to be a git repo unless `skipGitRepoCheck` is set.

### Recommended defaults

- `workingDirectory = connected project directory`
- `skipGitRepoCheck = false`

If project is not trusted / not git repo, surface exact backend error.

Optional future enhancement:

- advanced toggle for `skipGitRepoCheck`

Do not enable by default.

---

## Commands and compaction plan

## Commands

SDK does not list commands.

Set `commands: false` in first pass.

Do not expose command picker until command behavior is validated.

## Compact

Possible implementation path:

- send prompt `/compact`

But this is only safe after validation in non-interactive `codex exec --experimental-json` mode.

### Recommendation

Phase 1:

- set `compact: false`

Phase 1.5 optional:

- test `/compact` manually
- if reliable, implement `summarizeSession()` by prompting `/compact`
- then flip `compact: true`

Do not promise compaction before validation.

---

## Rename, delete, archive, fork plan

SDK does not offer these session lifecycle APIs.

## Rename

Implement as OpenGUI-local title override only.

Behavior:

- user renames session in UI
- bridge updates local session index title
- session list and session metadata use override
- native Codex session storage remains unchanged

## Delete

Implement as local hide/archive only in first pass.

Behavior:

- remove from OpenGUI sidebar
- mark hidden in local session index
- do not delete Codex rollout files

Reason:

- avoid corrupting user native session storage
- SDK offers no safe delete contract

## Fork
n
Keep unsupported in first pass.

Reason:

- fake fork without true upstream thread history semantics will confuse users
- better to wait for app-server path or proven local transcript clone design

---

## File mention search plan

Use same cheap local search style as Pi/Claude bridges.

Implementation can remain SDK-independent.

For `findFiles(target, query)`:

- walk target directory
- ignore obvious heavy dirs like `.git`, `node_modules`, build outputs
- return matching relative paths

This avoids depending on Codex internals.

---

## Best-effort native Codex session discovery

This is optional but high-value.

## Potential source layout clues

Repo docs/tests indicate native sessions live under paths like:

- `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`

Thread metadata likely also backed by sqlite state DB under `CODEX_HOME` / `sqlite_home`.

## Recommended discovery approach

Phase 1 should keep parser conservative:

1. detect `CODEX_HOME` or fallback `~/.codex`
2. scan `sessions/**/rollout-*.jsonl`
3. derive thread id from filename when possible
4. infer preview/title/cwd best-effort
5. never fail backend if discovery parser breaks

If parser quality is low, hide feature behind fallback to OpenGUI-owned sessions only.

---

## Error handling plan

Need normalize Codex errors into OpenGUI errors.

Important cases:

### Auth missing

Likely surfaced by CLI process stderr or stream failure.

Behavior:

- emit `session.error`
- preserve partial transcript
- show exact message in UI

### Non-git repo / trust failure

Common error from SDK tests:

- `Not inside a trusted directory`

Behavior:

- bubble exact error
- keep session visible
- set idle

### Unsupported platform / missing CLI bundle

If package/binary resolution fails:

- fail bridge setup clearly
- show backend unavailable

### Parse failures in streamed events

If malformed JSONL line:

- emit session error
- abort turn
- include exact line parse context in logs, not necessarily full UI text

### Temp image staging failure

- fail prompt before spawning turn
- delete any already-written temp files

---

## UI copy changes

Current connection panel text hardcodes Claude Code style string for local CLI backends.

Need generalize copy.

Current text near directory field says local-cli backend means:

- `Claude Code runs locally in this project directory...`

Change to backend-sensitive copy, e.g.:

- `Codex runs locally in this project directory. Use stable paths to reuse the same chats.`
- or generic:
- `Selected backend runs locally in this project directory. Use stable paths to reuse the same chats.`

Add backend picker item:

- `Codex`

---

## Documentation changes

Update:

- `README.md`
- `CONTRIBUTING.md`

Document:

- new backend available: Codex
- local auth requirement
- package/binary bundled in releases
- project must generally be git repo

---

## Future path: Codex app-server backend

While this plan targets TypeScript SDK, repo inspection shows Codex app-server is much richer.

`codex-rs/app-server/README.md` exposes APIs for:

- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/list`
- `thread/read`
- `thread/name/set`
- `thread/archive`
- `thread/compact/start`
- `turn/start`
- `turn/interrupt`
- `model/list`
- `tool/requestUserInput`
- approval flows
- MCP operations
- filesystem helpers
- skills list

That means future migration path exists:

### Phase 2 possibility

Keep frontend backend id as `codex`, but replace bridge internals from:

- SDK-wrapper mode

to:

- app-server protocol mode

Benefits:

- real session browser parity
- real rename/archive/fork
- real model list
- real approvals/questions
- real stored transcript loading

This plan does not require that now, but architecture should not block it.

---

## Recommended implementation order

1. Add dependencies:
   - `@openai/codex-sdk`
   - `@openai/codex`
2. Add packaging globs in `package.json`
3. Add `codex-bridge.mjs` skeleton with IPC plumbing
4. Add preload bridge in `preload.cjs`
5. Add Electron types in `src/types/electron.d.ts`
6. Add renderer adapter `src/agents/codex.ts`
7. Register backend in:
   - `src/agents/index.ts`
   - `src/hooks/use-agent-backend.ts`
   - settings/backend picker UI
8. Implement temp-session start flow with `session.replaced`
9. Implement `runStreamed()` event pump and item normalization
10. Implement abort handling
11. Implement temp image staging
12. Implement local session index persistence
13. Implement persisted transcript snapshots
14. Implement `listSessions()` from local index
15. Add best-effort native discovery scan
16. Validate `/compact`; enable only if solid
17. Update docs

---

## Validation checklist

Codex backend considered working when:

- user can select `Codex` in settings
- user can open project directory
- first prompt in empty draft creates temp session
- temp session swaps to real thread id after `thread.started`
- user message appears immediately
- assistant text streams live
- reasoning items display correctly
- command execution items show status/output
- file-change items show as tool timeline entries
- todo-list items render via existing todo UI
- image prompts work through temp local files
- abort stops running turn cleanly
- restarted app still shows OpenGUI-created Codex sessions
- reopened session loads persisted transcript snapshot
- backend errors appear cleanly and do not wedge UI busy state
- packaged Electron build can launch Codex backend without external Codex install

---

## Main risks

1. **SDK feature gap**
   - most non-live session features need custom shims

2. **Transcript persistence complexity**
   - without local normalized snapshot cache, reopening sessions is weak

3. **Native session discovery fragility**
   - Codex rollout/storage format is not TS SDK contract

4. **Approval flow mismatch**
   - SDK config supports approval policy, but not UI review callbacks
   - interactive approval modes likely poor fit in phase 1

5. **Model list drift**
   - curated provider/model list can become stale

6. **Image temp file cleanup**
   - bugs can leak temp files

7. **Binary packaging size**
   - app artifacts get larger

8. **Non-git workspace friction**
   - Codex trust model may surprise users

---

## Final recommendation

Ship Codex as **Phase 1 local backend using `@openai/codex-sdk`** with deliberately reduced capabilities.

Do not chase full OpenCode/Pi parity in first pass.

Design bridge so these pieces are easy to replace later:

- session listing source
- transcript loading source
- model catalog source
- lifecycle ops like rename/archive/fork

That keeps path open for later migration to Codex app-server without changing renderer-facing backend id.

## Short version

- Use SDK for live turns
- Use OpenGUI cache/index for sessions and history
- Keep capabilities conservative
- Package both `@openai/codex-sdk` and `@openai/codex`
- Leave app-server migration path open
