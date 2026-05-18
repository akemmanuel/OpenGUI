# OpenGUI backend/frontend split, unified workspaces, remote hosting, mobile readiness

Date: 2026-05-12

## Summary

OpenGUI should become a client/server product:

- **Backend** owns agent runtimes, projects, workspaces, sessions, events, settings that affect runtime, git/worktree operations, filesystem access, prompt queue execution, and provider/model state.
- **Frontend** owns rendering, navigation, UI preferences, local form drafts, and connection profile selection.
- **Desktop app** is a frontend shell that can either launch a local backend sidecar or connect to a remote backend.
- **Web app** is the same frontend served by a backend or static host.
- **Mobile app** later becomes another frontend that talks to the same backend API over HTTPS/WebSocket.

Core rule: no agent SDK, CLI, filesystem, git, worktree, or runtime state should live in frontend code after migration. Frontends talk to one OpenGUI backend protocol.

## Goals

1. Split codebase into backend and frontend boundaries without breaking current desktop/web flows.
2. Let desktop app run a local backend when wanted.
3. Let desktop/web/mobile connect to hosted backend later.
4. Make OpenGUI workspaces universal across OpenCode, Claude Code, Codex, and Pi.
5. Make session/project identity stable without relying only on absolute paths.
6. Keep current OpenCode remote-server flow, but treat it as one backend adapter detail, not app architecture.
7. Prepare for mobile by making all APIs async, authenticated, paginated, resumable, and payload-conscious.

## Non-goals for first split

- Real-time collaboration/multiple users editing same session.
- Phone-local agent execution.
- Automatic project file sync between desktop and remote backend.
- Cloud-hosted OpenGUI SaaS account system.
- Replacing all bridge internals in one big rewrite.

## Current state

OpenGUI already has pieces of this shape:

- `server/web-server.ts` runs a Bun server for browser mode.
- `src/lib/web-electron-api.ts` shims Electron preload calls through `/api/rpc` and `/api/events`.
- `preload.ts` exposes the same app API through Electron IPC.
- `opencode-bridge.ts`, `claude-code-bridge.ts`, `codex-bridge.ts`, and `pi-bridge.ts` host agent runtime logic.
- `src/agents/backend.ts` defines a useful adapter-like interface.
- Workspace IDs already appear in bridge calls, but semantics differ by backend and are still mostly frontend/UI driven.

Main issue: backend behavior is hidden behind Electron-shaped IPC. Browser mode fakes IPC instead of exposing a real product protocol. Frontend still thinks it talks to `window.electronAPI`.

## Target architecture

```txt
OpenGUI Frontends
  ├─ Desktop app (Electron shell)
  ├─ Web app (browser)
  └─ Mobile app later (iOS/Android)
        │
        │ HTTPS + WebSocket/SSE
        ▼
OpenGUI Backend API
  ├─ Auth/session/token layer
  ├─ Workspace service
  ├─ Project service
  ├─ Session/message service
  ├─ Event bus
  ├─ Prompt queue/runtime coordinator
  ├─ Git/worktree/filesystem service
  ├─ Settings/provider/model service
  └─ Agent adapter registry
        ├─ OpenCode adapter
        ├─ Claude Code adapter
        ├─ Codex adapter
        └─ Pi adapter
```

Backend is product core. Frontends are replaceable clients.

## Proposed repository layout

Migration can happen gradually. Final-ish shape:

```txt
apps/
  desktop/            Electron main/preload/shell, backend supervisor
  frontend/           React app, browser-safe, no runtime/agent logic
  backend/            Bun HTTP/WebSocket server

packages/
  protocol/           shared request/response/event schemas + client
  core/               workspace/project/session orchestration
  agents/             common adapter contract
    opencode/
    claude-code/
    codex/
    pi/
  desktop-bridge/     window controls, updater, native picker only
```

Short-term shape can stay flatter:

```txt
server/               real backend server + services
src/                  frontend + shared types until extracted
*.bridge.ts           adapters, moved later
```

Do not block split on package reshuffle. First create protocol boundary, then move files.

## Runtime modes

### 1. Desktop-managed local backend

Default desktop mode.

```txt
OpenGUI Desktop
  ├─ starts backend sidecar on 127.0.0.1:<random-port>
  ├─ creates random auth token
  ├─ waits for /api/health
  └─ loads frontend with backend URL/token

OpenGUI Backend
  ├─ bound to localhost
  ├─ has local project filesystem access
  └─ runs local OpenCode/Claude/Codex/Pi runtimes
```

Use random available port by default. Avoid fixed ports except optional override.

Desktop stores profile:

```ts
interface BackendProfile {
  id: string;
  name: string;
  mode: "local-managed" | "local-external" | "remote";
  url: string;
  tokenRef?: string;
  managed?: {
    pid?: number;
    startedAt?: number;
    version?: string;
  };
}
```

### 2. Local external backend

User starts backend manually, desktop/browser connects to it.

Useful for dev, Docker, custom process managers.

### 3. Remote backend

Backend runs on server, desktop/web/mobile connect over HTTPS/WSS.

Important rule: backend operates on backend-local paths. A VPS backend edits files on VPS, not user laptop. Desktop remote mode is a remote control UI, not direct local-file UI.

### 4. Future mobile backend access

Mobile only connects to remote or LAN/Tailscale backend. Mobile does not run agent CLIs.

## Backend protocol principles

1. **Typed and versioned**: clients discover protocol version and backend capabilities.
2. **HTTP for commands/query**: predictable request/response APIs.
3. **WebSocket or SSE for events**: one resumable event stream per client.
4. **Server-issued IDs**: no path-only keys in client state.
5. **Idempotent where needed**: reconnecting frontend can safely resync.
6. **Pagination everywhere**: sessions, messages, files, logs.
7. **Capability-driven UI**: backend reports features by agent, project, workspace, and platform.
8. **Transport-agnostic client**: React code calls `OpenGuiClient`, not `window.electronAPI`.

## API skeleton

Base:

```txt
GET  /api/health
GET  /api/version
GET  /api/capabilities
POST /api/auth/login                optional for remote; token bootstrap for local sidecar
POST /api/auth/refresh
POST /api/auth/logout
```

Workspaces:

```txt
GET    /api/workspaces
POST   /api/workspaces
GET    /api/workspaces/:workspaceId
PATCH  /api/workspaces/:workspaceId
DELETE /api/workspaces/:workspaceId
```

Projects:

```txt
GET    /api/workspaces/:workspaceId/projects
POST   /api/workspaces/:workspaceId/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId
POST   /api/projects/:projectId/connect
POST   /api/projects/:projectId/disconnect
GET    /api/projects/:projectId/status
```

Sessions:

```txt
GET    /api/sessions?workspaceId=&projectId=&agentBackendId=&cursor=&limit=
POST   /api/sessions
GET    /api/sessions/:sessionId
PATCH  /api/sessions/:sessionId
DELETE /api/sessions/:sessionId
POST   /api/sessions/:sessionId/fork
POST   /api/sessions/:sessionId/compact
POST   /api/sessions/:sessionId/revert
POST   /api/sessions/:sessionId/unrevert
```

Messages and prompting:

```txt
GET  /api/sessions/:sessionId/messages?cursor=&limit=&direction=older|newer
POST /api/sessions/:sessionId/prompt
POST /api/sessions/:sessionId/command
POST /api/sessions/:sessionId/abort
POST /api/permissions/:permissionId/respond
POST /api/questions/:questionId/reply
POST /api/questions/:questionId/reject
```

Providers/models/agents:

```txt
GET  /api/agent-backends
GET  /api/projects/:projectId/providers?agentBackendId=
GET  /api/projects/:projectId/models?agentBackendId=
GET  /api/projects/:projectId/agents?agentBackendId=
GET  /api/projects/:projectId/commands?agentBackendId=
POST /api/projects/:projectId/providers/:providerId/connect
POST /api/projects/:projectId/providers/:providerId/disconnect
```

Filesystem/git/worktrees:

```txt
GET  /api/fs/roots
GET  /api/fs/list?path=&cursor=&limit=
GET  /api/fs/search?projectId=&query=&limit=
GET  /api/git/repo?projectId=
GET  /api/git/branches?projectId=
GET  /api/git/worktrees?projectId=
POST /api/git/worktrees
DELETE /api/git/worktrees/:worktreeId
POST /api/git/merge
POST /api/git/merge/abort
```

Events:

```txt
GET /api/events?cursor=<lastEventId>
```

Use WebSocket or SSE. SSE is simpler for server-to-client event stream. WebSocket is better if mobile needs bidirectional heartbeat/control later. Either way, event envelope should be same.

## Protocol package

Create shared protocol types and a client facade.

```ts
interface OpenGuiClient {
  health(): Promise<HealthResponse>;
  capabilities(): Promise<CapabilitiesResponse>;

  workspaces: WorkspaceApi;
  projects: ProjectApi;
  sessions: SessionApi;
  messages: MessageApi;
  providers: ProviderApi;
  fs: FileSystemApi;
  git: GitApi;

  events: {
    subscribe(input: SubscribeEventsInput): EventSubscription;
  };
}
```

Implementations:

- `HttpOpenGuiClient`: real backend API.
- `ElectronCompatOpenGuiClient`: temporary adapter over `window.electronAPI` while migrating.
- Later `MobileOpenGuiClient`: likely same HTTP client with platform storage/auth integration.

Frontend hooks depend only on `OpenGuiClient`.

## Universal workspace model

OpenGUI Workspace is app-level, independent from any agent-specific workspace concept.

```ts
interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  defaultProjectId?: string;
  defaultAgentBackendId?: AgentBackendId;
  settings: WorkspaceSettings;
}
```

```ts
interface Project {
  id: string;
  workspaceId: string;
  displayName: string;
  path: string; // backend-local absolute path
  canonicalPath: string; // realpath if available
  allowedRootId?: string;
  git?: ProjectGitInfo;
  createdAt: string;
  updatedAt: string;
  agentBackends: ProjectAgentBackendConfig[];
}
```

```ts
interface ProjectAgentBackendConfig {
  agentBackendId: AgentBackendId;
  enabled: boolean;
  connectionMode: "local-cli" | "remote-server" | "managed-server";
  remoteUrl?: string;
  authRef?: string;
  defaultModel?: SelectedModel;
  defaultAgent?: string;
}
```

Session identity:

```ts
interface SessionRecord {
  id: string; // OpenGUI canonical ID
  rawId: string; // native agent session ID
  workspaceId: string;
  projectId: string;
  agentBackendId: AgentBackendId;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "error" | "unknown";
  metadata?: Record<string, unknown>;
}
```

Canonical session key:

```txt
workspaceId + projectId + agentBackendId + rawId
```

Never key sessions only by `rawId` or `directory`.

## Agent workspace semantics

Each adapter maps OpenGUI scope to native agent scope.

```ts
interface AgentScope {
  workspaceId: string;
  projectId: string;
  projectPath: string;
  agentBackendId: AgentBackendId;
}
```

OpenCode:

- Keep OpenGUI workspace ID as UI/core scope.
- Only send OpenCode workspace headers if explicitly needed and known safe.
- Existing comment in `opencode-bridge.ts` warns that sending OpenCode workspace header can hide sessions. Preserve that behavior until explicit OpenCode workspace support is designed.

Claude Code:

- Store/list sessions scoped through OpenGUI workspace/project.
- If Claude native session store lacks workspace support, backend maintains mapping metadata.

Codex:

- Same as Claude: native session ID plus OpenGUI mapping.
- Existing code already carries `workspaceId`; make backend own and validate it.

Pi:

- Same universal adapter scope.
- Ensure session/message/project mapping works even if Pi native runtime has no workspace concept.

## Agent adapter contract

Move bridges toward this shape:

```ts
interface AgentAdapter {
  id: AgentBackendId;
  label: string;
  capabilities: AgentBackendCapabilities;

  connectProject(scope: AgentScope, config: ProjectAgentBackendConfig): Promise<void>;
  disconnectProject(scope: AgentScope): Promise<void>;
  getProjectStatus(scope: AgentScope): Promise<ConnectionStatus>;

  listSessions(scope: AgentScope, input: ListSessionsInput): Promise<ListSessionsResult>;
  createSession(scope: AgentScope, input: CreateSessionInput): Promise<SessionRecord>;
  updateSession(scope: AgentScope, input: UpdateSessionInput): Promise<SessionRecord>;
  deleteSession(scope: AgentScope, sessionId: string): Promise<boolean>;

  getMessages(scope: AgentScope, input: GetMessagesInput): Promise<MessagePage>;
  prompt(scope: AgentScope, input: PromptInput): Promise<void>;
  abort(scope: AgentScope, sessionId: string): Promise<void>;

  subscribe(listener: (event: AgentAdapterEvent) => void): () => void;
}
```

Backend core translates adapter events into OpenGUI events with canonical IDs.

## Event model

Use one envelope:

```ts
interface OpenGuiEventEnvelope<T = OpenGuiEvent> {
  id: string; // monotonic event ID or ULID
  type: T["type"];
  createdAt: string;
  workspaceId?: string;
  projectId?: string;
  sessionId?: string;
  agentBackendId?: AgentBackendId;
  payload: T;
}
```

Event examples:

```ts
type OpenGuiEvent =
  | { type: "workspace.created"; workspace: Workspace }
  | { type: "workspace.updated"; workspace: Workspace }
  | { type: "workspace.deleted"; workspaceId: string }
  | { type: "project.created"; project: Project }
  | { type: "project.updated"; project: Project }
  | { type: "project.deleted"; projectId: string }
  | { type: "project.connection.status"; status: ConnectionStatus }
  | { type: "session.created"; session: SessionRecord }
  | { type: "session.updated"; session: SessionRecord }
  | { type: "session.deleted"; sessionId: string }
  | { type: "session.status"; sessionId: string; status: SessionStatus }
  | { type: "message.snapshot"; sessionId: string; messages: MessageEntry[]; cursor: string | null }
  | { type: "message.updated"; sessionId: string; message: Message }
  | { type: "message.part.updated"; sessionId: string; part: Part }
  | {
      type: "message.part.delta";
      sessionId: string;
      messageId: string;
      partId: string;
      field: string;
      delta: string;
    }
  | { type: "permission.requested"; sessionId: string; request: PermissionRequest }
  | { type: "permission.cleared"; sessionId: string }
  | { type: "question.requested"; sessionId: string; request: QuestionRequest }
  | { type: "question.cleared"; sessionId: string }
  | { type: "runtime.error"; sessionId?: string; error: string };
```

For mobile and flaky networks:

- Client sends last seen event ID on reconnect.
- Backend replays recent events from in-memory ring buffer or persistent event log.
- If replay cursor expired, backend tells client to refetch affected resource.

## Prompt queue ownership

Move prompt queue execution to backend.

Why:

- Desktop can close while backend keeps running.
- Mobile/web clients can observe same queue.
- Multiple frontends connected to same backend see consistent busy/queued state.

Backend stores queue records:

```ts
interface PromptQueueItem {
  id: string;
  workspaceId: string;
  projectId: string;
  sessionId: string;
  agentBackendId: AgentBackendId;
  text: string;
  attachments: AttachmentRef[];
  mode: "next" | "after-part";
  status: "queued" | "dispatching" | "sent" | "failed" | "cancelled";
  createdAt: string;
}
```

Frontend may keep unsent textarea drafts locally, but queued prompts belong to backend.

## Settings ownership

Split settings into classes.

Backend settings:

- workspaces/projects
- allowed roots
- provider credentials refs
- agent backend config
- model defaults
- MCP config
- skills config
- prompt queues
- session metadata shared across clients

Frontend-local settings:

- theme
- sidebar width/collapse
- language
- density
- local draft text
- currently selected backend profile
- mobile notification preferences

Shared UI metadata with backend sync:

- pins
- colors/tags
- last active session per workspace
- project order

## Filesystem and allowed roots

Backend must enforce filesystem boundaries.

```ts
interface AllowedRoot {
  id: string;
  path: string;
  label: string;
  writable: boolean;
}
```

Rules:

- Every project path must live under an allowed root unless local desktop user explicitly grants it.
- Remote backend default should require configured `OPENGUI_ALLOWED_ROOTS`.
- Resolve symlinks with `realpath` before access checks.
- Never trust frontend paths.
- Return display labels and project IDs to clients; avoid making UI depend on absolute path identity.

Mobile impact: mobile file picker is backend file picker. Phone does not browse its local filesystem for projects.

## Desktop shell responsibilities after split

Keep in Electron:

- window controls
- updater
- native open external
- native folder picker as convenience for local backend only
- backend sidecar process lifecycle
- secure token injection into renderer
- OS notifications if needed

Move out of Electron:

- agent bridges
- session state
- prompt queue
- provider/model runtime state
- git/worktree ops
- filesystem server browsing

Desktop launch flow:

```txt
1. Read selected backend profile.
2. If profile is local-managed:
   a. spawn backend sidecar with OPENGUI_AUTH_TOKEN and OPENGUI_ALLOWED_ROOTS
   b. wait for /api/health
   c. restart or show error if failed
3. Load frontend.
4. Provide backend profile/token to frontend through preload or secure initial config.
5. On app exit, stop sidecar if user configured "stop with app"; otherwise leave running.
```

## Auth and security

Remote backend is powerful. It can edit files, run commands through agents, access provider credentials, and expose project contents.

Minimum security before remote-hosting docs:

- Auth required unless explicitly disabled for dev.
- Local sidecar bound to `127.0.0.1` by default.
- Local sidecar uses random high-entropy token.
- Remote backend refuses to start without auth secret or explicit `OPENGUI_INSECURE_NO_AUTH=1`.
- CORS allowlist, default same-origin only.
- HTTPS expected behind reverse proxy.
- WebSocket/SSE requires auth.
- Allowed roots enforced for every path API and every agent project.
- Secrets redacted in logs/events.
- Provider tokens stored in backend secure store where possible.
- Audit log for destructive project/git/provider operations.

Future multi-user model can add users/roles, but single-owner token auth is enough for first remote-ready backend.

## Mobile compatibility

This plan is mobile-compatible if these rules hold:

1. Frontend core never imports Electron APIs.
2. Frontend core talks only to `OpenGuiClient`.
3. API supports HTTPS/WSS, auth, pagination, and reconnection.
4. Backend owns all agent/runtime/filesystem state.
5. Workspaces/projects/sessions use server-issued IDs.
6. Large message data is paged and trimmed.
7. Attachments use upload/download endpoints, not browser-only file assumptions.
8. Events are resumable or can force resource refetch.
9. Capability endpoint lets mobile hide desktop-only actions.

Mobile app shape:

```txt
iOS/Android OpenGUI
  ├─ stores backend profile/token in secure OS storage
  ├─ connects to remote/local-network backend
  ├─ subscribes to events
  ├─ sends prompts/approvals
  ├─ receives push notifications later
  └─ never runs coding agent CLIs directly
```

Mobile-specific future endpoints/hooks:

```txt
POST /api/devices/register
POST /api/devices/unregister
POST /api/notifications/test
PATCH /api/users/me/notification-settings
```

Push notifications should be optional and event-driven:

- session completed
- permission requested
- question requested
- queue item failed
- backend disconnected from project

## Data storage

Backend needs persistent store. Start simple, but design for migration.

Option A: JSON files in user data dir

- easiest migration from current settings store
- ok for single user/local desktop
- fragile for concurrent frontends and event replay

Option B: SQLite

- recommended target
- good for sessions metadata, workspaces, project maps, prompt queue, event log
- easy backup/export
- works local and server

Recommended: introduce storage interface first, use JSON for initial migration if needed, then SQLite before remote docs become serious.

Key tables later:

```txt
workspaces
projects
project_agent_backends
sessions
session_mappings
message_cache
prompt_queue
settings
secrets_metadata
events
backend_profiles (desktop-local only)
```

Secrets should not be plain rows if platform secure storage is available. For server, support env-provided secret encryption key.

## Migration plan

### Phase 0: Write and accept design

- Keep current behavior.
- Agree on boundaries, IDs, and runtime modes.
- Decide protocol transport: HTTP + SSE first, or HTTP + WebSocket first.

### Phase 1: Introduce protocol client in frontend

Create `OpenGuiClient` and make frontend hooks call it instead of `window.electronAPI` directly.

Tasks:

- Add `src/protocol` or `packages/protocol` types.
- Wrap existing Electron API in `ElectronCompatOpenGuiClient`.
- Wrap existing web `/api/rpc` in temporary `RpcCompatOpenGuiClient` if needed.
- Refactor hooks/services gradually.

Success:

- Most app code no longer references `window.electronAPI` except desktop shell features and client bootstrap.

### Phase 2: Create backend service layer behind existing server

Refactor `server/web-server.ts` so fake IPC is not the app core.

Tasks:

- Add workspace service.
- Add project service.
- Add session service.
- Add event bus.
- Add adapter registry.
- Let old IPC handlers call services temporarily.

Success:

- Same UI works.
- Backend services can be called without Electron-shaped event objects.

### Phase 3: Add real HTTP routes beside `/api/rpc`

Tasks:

- Implement `/api/health`, `/api/capabilities`, workspace/project/session/message routes.
- Implement event stream with canonical events.
- Add typed HTTP client.
- Switch frontend to HTTP client in web mode.

Success:

- Browser mode no longer depends on fake IPC for core agent operations.

### Phase 4: Desktop sidecar mode

Tasks:

- Build backend as separate entrypoint.
- Electron main spawns backend process in local-managed mode.
- Preload gives frontend backend URL/token, not giant agent API.
- Keep native shell/window APIs separate.

Success:

- Desktop renderer uses same HTTP client as browser.
- Agent bridges run in backend process, not Electron main.

### Phase 5: Universal workspace/project/session persistence

Tasks:

- Introduce server-issued workspace/project/session IDs.
- Migrate existing workspace state from frontend settings.
- Map native session IDs to canonical `SessionRecord`.
- Make all backends respect `AgentScope`.
- Move prompt queues to backend.

Success:

- Claude Code, Codex, Pi, and OpenCode all show workspaces/projects consistently.
- Same remote backend can be controlled by browser and desktop simultaneously.

### Phase 6: Remote hardening

Tasks:

- Add auth middleware.
- Add allowed root enforcement everywhere.
- Add CORS policy.
- Add token management UI.
- Add Docker/server docs.
- Add Apache/Nginx reverse proxy docs.
- Add audit/security warnings.

Success:

- User can host backend on a server and connect from desktop/web safely enough for single-owner use.

### Phase 7: Mobile-ready polish

Tasks:

- Ensure pagination for all heavy endpoints.
- Add event replay or resync protocol.
- Add attachment upload API.
- Add capability flags for mobile UI.
- Add push notification registration hooks.
- Extract frontend state logic so React Native/mobile can reuse protocol and maybe core reducers.

Success:

- Mobile app can be built without backend redesign.

## Testing strategy

Unit tests:

- protocol schema validation
- workspace/project/session ID mapping
- path allowlist checks
- event normalization
- adapter scope mapping
- prompt queue dispatch rules

Integration tests:

- start backend, create workspace/project, create session, send prompt mock, receive events
- reconnect event stream with cursor
- remote auth rejects missing token
- path traversal and symlink escape blocked
- two frontends see same session/queue state

Desktop tests/manual checks:

- local-managed backend starts/stops
- backend crash shows recovery UI
- remote profile connects
- native folder picker adds project to local backend

Migration tests:

- existing settings/workspaces migrate once
- old sessions still appear under generated project/workspace records

## Compatibility with existing OpenCode server mode

Keep OpenCode remote server support as an adapter connection mode:

```ts
connectionMode: "remote-server";
remoteUrl: "http://...";
```

But OpenGUI backend remains the client-facing backend. Flow:

```txt
Frontend -> OpenGUI Backend -> OpenCode remote server
```

Do not expose OpenCode server directly as OpenGUI backend. It lacks OpenGUI workspace/project/session metadata, Claude/Codex/Pi support, prompt queues, and unified events.

## Risks

1. **Big-bang rewrite risk**: avoid by introducing protocol client first and keeping compat adapters.
2. **Identity bugs**: solve with canonical IDs and explicit native ID mappings.
3. **Remote security risk**: do not document public hosting until auth + allowed roots are done.
4. **Event mismatch across agents**: normalize adapter events in backend core, not frontend.
5. **Mobile payload size**: paginate messages early and strip heavy tool payloads.
6. **Local sidecar packaging**: ensure backend entrypoint and dependencies are included in Electron build.
7. **Path confusion**: always label paths as backend-local in UI when connected remotely.

## Open decisions

1. Use SSE or WebSocket for first real event stream?
   - SSE simpler and robust for server-to-client.
   - WebSocket better for bidirectional mobile heartbeats and future collaboration.
   - Recommendation: WebSocket if current web event transport already works well; otherwise SSE with same event envelope.

2. JSON store first or SQLite now?
   - Recommendation: storage interface now, SQLite before remote hardening completes.

3. Stop local backend when desktop exits?
   - Recommendation: user setting. Default stop with app for normal users, keep running for advanced users.

4. Should backend serve frontend assets in production?
   - Recommendation: yes for simple web/Docker deployment, but keep frontend build static-hostable.

5. Should remote backend support multiple users now?
   - Recommendation: no. Single-owner token auth first. Design auth middleware so multi-user can be added later.

## First implementation checklist

- [x] Add `OpenGuiClient` interface and provider in frontend.
- [x] Add `ElectronCompatOpenGuiClient` over current `window.electronAPI`.
- [~] Replace direct agent bridge use in hooks with client methods. Started with backend discovery, resource loading, project connect/disconnect, project session listing/statuses, event subscription, directory picker, message loading, prompt dispatch, abort, permissions, questions, file search, and rename.
- [~] Add backend service folders: workspaces, projects, sessions, events, adapters. Workspace service started.
- [ ] Add canonical `Workspace`, `Project`, `SessionRecord`, `AgentScope` types.
- [~] Add real `/api/health`, `/api/capabilities`, `/api/workspaces` routes. Capabilities + workspace CRUD started; health already existed.
- [~] Add typed HTTP client for backend protocol. `HttpOpenGuiClient` started with capabilities + workspace CRUD.
- [ ] Add auth/token middleware skeleton, disabled only in dev/local compat.
- [ ] Add desktop backend profile model.
- [ ] Add local sidecar launch spike.
- [ ] Add migration for existing frontend workspace settings.

## Desired end state

```txt
Same React UI code can run as:

Desktop local:
  Electron frontend -> localhost OpenGUI backend -> local agents/files

Desktop remote:
  Electron frontend -> remote OpenGUI backend -> remote agents/files

Browser:
  Browser frontend -> OpenGUI backend -> agents/files

Mobile:
  Native/mobile frontend -> OpenGUI backend -> agents/files
```

OpenGUI workspaces become universal product concepts. Agent-native workspace/session details stay inside adapters. Backend is the stable contract. Frontends become thin clients.
