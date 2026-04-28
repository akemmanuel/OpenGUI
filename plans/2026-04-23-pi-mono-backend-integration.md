# Pi Mono Backend Integration Plan

Date: 2026-04-23
Project: OpenGUI
Backend target: `@mariozechner/pi-coding-agent` from `badlogic/pi-mono`

## Goal

Add new backend named `pi` beside existing `opencode` and `claude-code` backends.

Scope for first working integration:

- select Pi from backend picker
- connect local project directory
- list sessions
- create/start sessions
- stream assistant output live
- show reasoning and tool execution in message list
- abort prompts
- compact sessions
- fork sessions
- rename and delete sessions
- list models/providers from Pi model registry
- list slash commands / prompt templates / skills
- search files for `@mentions`

Out of scope for first pass:

- MCP management
n- OpenCode-style permission prompts
- OpenCode-style interactive questions
- session revert / unrevert
- full provider auth UI inside OpenGUI
- full Pi extension UI bridge
- message paging from persisted sessions

## Why SDK direct, not subprocess RPC

Use Pi SDK directly in Electron main process.

Reason:

- stronger TypeScript surface
- no extra subprocess / JSONL layer
- lower latency
- easier runtime ownership per project
- easier session lifecycle control with `AgentSessionRuntime`
- easier packaging than spawning `pi --mode rpc`

## Pi APIs to use

Main package:

- `@mariozechner/pi-coding-agent`

Core APIs:

- `createAgentSessionRuntime()`
- `createAgentSessionFromServices()`
- `createAgentSessionServices()`
- `SessionManager`
- `AgentSessionRuntime`
- `AuthStorage`
- `ModelRegistry`

Key runtime methods:

- `runtime.newSession()`
- `runtime.switchSession()`
- `runtime.fork()`
- `session.prompt()`
- `session.abort()`
- `session.compact()`
- `session.setModel()`
- `session.setSessionName()`
- `session.subscribe()`

Key persistence/model methods:

- `SessionManager.list()`
- `SessionManager.open()`
- `modelRegistry.getAvailable()`
- `modelRegistry.find()`

## OpenGUI architecture fit

OpenGUI already has backend abstraction:

- `src/agents/backend.ts`
- `src/agents/opencode.ts`
- `src/agents/claude-code.ts`
- main-process bridge modules in repo root
- preload bridge in `preload.cjs`

Pi integration should follow same pattern:

1. main process ESM bridge module
2. preload bridge object
3. renderer adapter in `src/agents/pi.ts`
4. backend picker support

## New files

- `pi-bridge.mjs`
- `src/agents/pi.ts`
- `plans/2026-04-23-pi-mono-backend-integration.md`

## Existing files to change

- `package.json`
- `main.cjs`
- `preload.cjs`
- `src/types/electron.d.ts`
- `src/agents/index.ts`
- `src/hooks/use-agent-backend.ts`
- `src/components/ConnectionPanel.tsx`

Possible small changes if needed:

- `README.md`
- packaging file list in `package.json`

## Backend capabilities

Pi backend capabilities for phase 1:

```ts
{
  sessions: true,
  streaming: true,
  messagePaging: false,
  images: true,
  models: true,
  agents: false,
  commands: true,
  compact: true,
  fork: true,
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

- hide agent selector for Pi
- hide provider management for Pi in first pass
- hide MCP / questions / revert UI by capability flags

## Workspace model

Pi should behave like local CLI backend.

Workspace profile:

- `kind: "local-cli"`
- fields:
  - `directory: true`
  - `serverUrl: false`
  - `username: false`
  - `password: false`

`baseUrl` from existing connection config can be ignored by Pi bridge.

## Main-process bridge design

Implement `PiBridgeManager` in `pi-bridge.mjs`.

Manager owns project-scoped runtime state keyed by:

- `workspaceId`
- `directory`

Per target store:

- `AgentSessionRuntime`
- current `AgentSession`
- session event unsubscribe fn
- normalized session/message cache
- loaded session list cache
- session status cache
- last selected model cache

## Session storage decision

Use Pi default shared agent directory for first pass.

Meaning:

- existing Pi auth works automatically
- existing Pi sessions show automatically
- existing Pi skills/prompts/extensions affect runtime

No isolated OpenGUI-specific Pi home in first pass.

## Event translation strategy

OpenGUI UI expects OpenCode-like `Message` + `Part` shapes.

Do not refactor renderer in first pass.

Instead, bridge translates Pi session data and Pi events into shapes compatible with:

- `@opencode-ai/sdk/v2/client` `Session`
- `Message`
- `Part`
- `Provider`
- `Command`

This keeps renderer changes small.

### Pi to OpenGUI event mapping

Pi emits:

- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `agent_end`

Bridge should emit backend events like existing backends:

- `session.created`
- `session.updated`
- `message.updated`
- `message.part.updated`
- `message.part.delta`
- `session.status`
- `session.error`

### Message translation model

For user message:

- create one `Message` with role `user`
- create text part from user text

For assistant message:

- create one `Message` with role `assistant`
- convert Pi text blocks to `text` parts
- convert Pi thinking blocks to `reasoning` parts
- convert Pi tool calls + tool execution state to `tool` parts

For tool results:

- do not show them as separate OpenGUI messages
- merge them into corresponding assistant tool part state

### Live streaming behavior

- `message_update.text_delta` -> `message.part.delta` on text part
- `message_update.thinking_delta` -> `message.part.delta` on reasoning part
- `tool_execution_start` -> tool part `running`
- `tool_execution_update` -> tool part partial output
- `tool_execution_end` -> tool part `completed` or `error`

## Persisted transcript reconstruction

Need full transcript load when user opens old Pi session.

Use `SessionManager.open(path)` and reconstruct active branch transcript.

Reconstruction rules:

1. read active path messages from Pi session context
2. convert user messages to OpenGUI user message entries
3. convert assistant messages to assistant message + parts
4. match Pi `toolResult` messages back to assistant tool call blocks by `toolCallId`
5. synthesize OpenGUI-compatible tool part states

This gives stable old-session loading without depending on live event cache.

## IPC surface

Add new preload bridge namespace:

- `electronAPI.pi`

Methods should mirror Claude bridge shape where possible:

- `addProject(config)`
- `removeProject(directory, workspaceId)`
- `disconnect()`
- `listSessions(directory, workspaceId)`
- `deleteSession(sessionId, directory, workspaceId)`
- `updateSession(sessionId, title, directory, workspaceId)`
- `getSessionStatuses(directory, workspaceId)`
- `forkSession(sessionId, messageID?, directory, workspaceId)`
- `getProviders(directory, workspaceId)`
- `getAgents(directory, workspaceId)`
- `getCommands(directory, workspaceId)`
- `getMessages(sessionId, options, directory, workspaceId)`
- `startSession(input)`
- `prompt(sessionId, text, images, model, agent, variant, directory, workspaceId)`
- `abort(sessionId)`
- `summarizeSession(sessionId, model, directory, workspaceId)`
- `findFiles(directory, workspaceId, query)`
- `onEvent(callback)`

Unsupported features can return errors or empty arrays where adapter capability flags already hide UI.

## Renderer adapter

Add `src/agents/pi.ts`.

Responsibilities:

- define Pi backend capabilities
- define workspace profile
- adapt preload IPC envelope to `AgentBackendDescriptor`
- normalize `pi:event` payload into `AgentBackendEvent`

Behavior should match `src/agents/claude-code.ts` style.

## Models/providers mapping

Pi model registry returns Pi model shape. Convert into OpenGUI provider/model shape.

Provider mapping:

- one provider entry per provider ID
- `source: "api"`
- `env`: empty or inferred from model registry if possible
- `models`: model map converted to OpenCode-compatible shape

Model mapping should preserve:

- `id`
- `providerID`
- `name`
- reasoning capability
- image capability
- context limit
- output limit
- cost

No variants in first pass.

## Commands mapping

Pi exposes commands from:

- extension commands
- prompt templates
- skills

Map them into OpenGUI `Command[]`.

Suggested source mapping:

- extension commands -> `source: "command"`
- prompt templates -> `source: "command"`
- skills -> `source: "skill"`

Template string can be generated as:

- extension command: `/${name}`
- prompt template: `/${name}`
- skill: `/skill:${name}`

## File search

Implement locally in bridge.

Use project directory and:

- `rg --files` for file list
- substring / fuzzy filter in JS
- cap results to reasonable size

This avoids depending on Pi SDK for file mention search.

## Delete / rename / fork behavior

### Rename

- resolve session path
- switch runtime if target session not active or open temporary manager
- call `session.setSessionName(title)`
- refresh session list

### Delete

Pi SDK has no simple high-level delete session API.

Implement by:

- resolve session file path from session listing cache
- if deleting active session, create/switch to safe session first
- delete `.jsonl` file from disk
- refresh session list
- emit `session.deleted`

### Fork

Use Pi runtime fork support.

Need map OpenGUI `messageID` to Pi session entry ID.

Store mapping during transcript reconstruction and live event adaptation:

- assistant/user OpenGUI message ID -> Pi entry/message ID metadata

## Start/create session behavior

OpenGUI uses both `createSession()` and `startSession()` paths.

Pi bridge should support both:

### createSession

- `runtime.newSession()`
- optionally apply title
- return new normalized session

### startSession

- `runtime.newSession()`
- optionally apply title
- send `session.prompt(text, { images })`
- return normalized session immediately

## Images

Current UI sends image attachments as data URLs.

Pi wants base64 image blocks.

Bridge conversion:

1. parse data URL
2. extract mime type + base64 payload
3. convert to Pi `ImageContent`

If parsing fails:

- ignore invalid attachment and continue
- or return IPC error for malformed image

## Packaging

Add dependency:

- `@mariozechner/pi-coding-agent`

Package bundled app must include:

- `pi-bridge.mjs`
- `node_modules/@mariozechner/pi-coding-agent/**/*`
- transitive runtime assets if needed by package

Minimum packaging update target:

- add `pi-bridge.mjs` to electron-builder files list
- verify no missing ESM runtime files in packaged app

## Implementation order

### Phase 1: plumbing

1. add dependency to `package.json`
2. add `pi-bridge.mjs`
3. load bridge in `main.cjs`
4. add preload bridge in `preload.cjs`
5. extend `src/types/electron.d.ts`
6. add `src/agents/pi.ts`
7. update backend union + selector logic
8. add Pi to settings dropdown

### Phase 2: runtime + sessions

1. implement runtime manager per project
2. implement add/remove/disconnect
3. implement session list/load/create/start/rename/delete/fork
4. implement message reconstruction for old sessions
5. implement live event streaming adapter

### Phase 3: model + command support

1. implement provider/model conversion
2. implement model switching
3. implement command listing
4. implement file search
5. verify compact / abort

### Phase 4: polish

1. update packaging
2. update README if desired
3. lint / typecheck
4. manual smoke test via app UI

## Success criteria

Pi backend considered working when:

- user can select `Pi` in backend settings
- user can connect local project directory
- existing Pi sessions appear in sidebar
- new Pi session can be started from prompt box
- assistant text streams live
- reasoning and tool activity render in message list
- model selector works from Pi model registry
- abort works
- compact works
- fork works
- rename and delete work

## Known risks

1. Pi session transcript reconstruction may need tuning for tool/result pairing.
2. Packaging may need extra asset includes for Pi transitive deps.
3. Existing renderer assumes OpenCode-shaped objects; bridge translation must stay compatible.
4. Provider auth UI is intentionally postponed. First pass depends on external Pi auth or env vars.

## Post-MVP follow-ups

- Pi provider auth UI inside OpenGUI
- Pi tree navigation UI
- Pi extension UI bridge
- isolated Pi data dir option
- synthetic message paging for huge sessions
- backend-neutral internal types to remove OpenCode type dependency from generic UI
