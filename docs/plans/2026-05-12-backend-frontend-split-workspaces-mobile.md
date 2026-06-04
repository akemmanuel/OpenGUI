# OpenGUI backend/frontend split, unified workspaces, remote hosting, mobile readiness

Date: 2026-05-12 (updated 2026-05-27)

> Superseded by CONTEXT.md for current domain language. In particular, Workspace is frontend-local and is not an OpenGUI Backend primitive.

## Summary

OpenGUI becomes a client/server product with one backend and multiple shells.

- **OpenGUI Backend** owns Harness adapters, project access, sessions, prompt queues, events, filesystem/git operations, and settings that affect execution. The only stateful layer. Deployable as Desktop sidecar, Docker container, or standalone server.
- **OpenGUI Frontend** is the React UI layer. Stateless; renders chat, navigation, settings. Talks only to one OpenGUI Backend via `OpenGuiClient`. Same codebase runs in Desktop Shell, Web Shell, and Mobile Shell.
- **Shell** is the platform-specific scaffold that bootstraps the Frontend. Three variants:
  - **Desktop Shell** (Electron main+preload): window controls, native file picker, updater, OS notifications, backend sidecar lifecycle.
  - **Web Shell** (browser): minimal -- no backend spawning, no native file dialog. Backend connection is same-origin or user-configured URL.
  - **Mobile Shell** (Capacitor JS): native file picker, push notifications, secure token storage. Never spawns a Backend, never opens a file browser or terminal.
- **Harness** is a coding-agent runtime (OpenCode, Claude Code, Codex, Pi) managed by the OpenGUI Backend. The Frontend never speaks to a Harness directly.
- **Harness Adapter** is the integration code translating Backend operations into Harness SDK calls.

Core rule: no Harness SDK, CLI, filesystem, git, worktree, or runtime state should live in Frontend code. Frontends talk to one OpenGUI Backend protocol.

### Headless Backend (resolved)

There is no separate "headless backend". The OpenGUI Backend is one binary. Only the deployment mode differs:

| Mode               | Host               | Auth           | Use Case                            |
| ------------------ | ------------------ | -------------- | ----------------------------------- |
| Managed Sidecar    | `127.0.0.1:random` | Random token   | Desktop default                     |
| Standalone (LAN)   | `0.0.0.0:PORT`     | Token/password | Dev, manual Docker                  |
| Docker (VPS)       | `0.0.0.0:PORT`     | Required       | Remote hosting behind reverse proxy |
| Web (mit Frontend) | `0.0.0.0:PORT`     | Required       | Serves Frontend assets + API        |

Desktop Shell manages the sidecar lifecycle (spawn, health-check, shut down). All other modes start the Backend independently.

## Goals

1. Split monolithic codebase into Backend and Frontend boundaries without breaking current desktop/web flows.
2. Let Desktop Shell run a local Backend sidecar or connect to a remote Backend.
3. Let Mobile Shell connect to remote/LAN Backend; never spawn a Backend locally.
4. Make OpenGUI frontend Workspaces across all Harnesses (OpenCode, Claude Code, Codex, Pi).
5. Make session/project identity stable using server-issued IDs, not absolute paths.
6. Keep current OpenCode remote-server flow as one Harness adapter detail.
7. Prepare for mobile: all APIs async, authenticated, paginated, resumable, payload-conscious.

## Non-goals

- Real-time collaboration / multi-user sessions.
- Phone-local Harness execution.
- Automatic project file sync between desktop and remote Backend.
- Cloud-hosted OpenGUI SaaS account system.
- Replacing all Harness adapter internals in one rewrite.

## Architecture overview

```txt
OpenGUI Frontends                Shells
  ├─ Desktop UI  ←→ Desktop Shell  (Electron: window, updater, sidecar)
  ├─ Web UI      ←→ Web Shell      (browser: same-origin / URL)
  └─ Mobile UI   ←→ Mobile Shell   (Capacitor: native picker, push, no backend)
        │
        │ HTTPS + WebSocket/SSE  (always via OpenGuiClient)
        ▼
OpenGUI Backend
  ├─ Auth / tokens
  ├─ Workspace service
  ├─ Project service
  ├─ Session/message service
  ├─ Event bus
  ├─ Prompt queue / runtime coordinator
  ├─ Git / worktree / filesystem service
  ├─ Settings / provider / model service
  └─ Harness adapter registry
        ├─ OpenCode adapter
        ├─ Claude Code adapter
        ├─ Codex adapter
        └─ Pi adapter

Harnesses (coding-agent CLIs/SDKs)
  OpenCode, Claude Code, Codex, Pi
```

One Backend binary. Three Shells sharing one React Frontend.

## Repository layout

Migration is gradual. Target layout:

```txt
apps/
  backend/            Node.js HTTP/WS server, Harness adapters, services
  frontend/           React app + protocol client (shell-agnostic)
  desktop/            Electron main/preload + sidecar supervisor
  mobile/             Capacitor JS scaffold

packages/
  protocol/           Shared request/response/event schemas, OpenGuiClient
  backend-core/       Workspace/project/session orchestration (may stay in apps/backend)
```

Short-term (while migrating):

```txt
server/               Backend services + routes + adapters
src/                  Frontend React + protocol client
main.ts               Electron main (Desktop Shell)
preload.ts            Electron preload (Desktop Shell)
main/                 Desktop Shell helpers (update-manager, etc.)
```

Do not block split on package reshuffle. First create protocol boundary, then move files.

## Runtime modes

### 1. Desktop Shell + Managed Sidecar (default)

```txt
Desktop Shell (Electron)
  ├─ starts Backend on 127.0.0.1:<random-port>
  ├─ creates random auth token
  ├─ waits for /api/health
  └─ loads Frontend with Backend URL + token

OpenGUI Backend
  ├─ bound to 127.0.0.1
  ├─ local filesystem access
  └─ runs local Harnesses (OpenCode, Claude, Codex, Pi)
```

Desktop Shell stores BackendProfile:

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

### 2. Desktop/Web + Local External Backend

User starts Backend manually or via Docker. Frontend connects to configured URL.

### 3. Remote Backend (Desktop, Web, or Mobile)

Backend runs on server. All three Shells connect over HTTPS/WSS.

Important: Backend operates on its own paths. A VPS Backend edits files on the VPS, not the user's laptop. Remote mode is remote control, not local-file UI.

### 4. Mobile Shell -> Remote Backend

Mobile Shell never starts a Backend. It connects to a remote or LAN Backend.

Mobile Shell responsibilities:

- Native file picker (for adding projects to a remote Backend)
- Push notifications
- Secure token storage
- No terminal, no file browser, no Backend spawning

## Backend protocol principles

1. **Typed and versioned**: clients discover protocol version and Backend capabilities.
2. **HTTP for commands/query**: predictable request/response APIs.
3. **WebSocket or SSE for events**: one resumable event stream per client.
4. **Server-issued IDs**: no path-only keys in client state.
5. **Idempotent where needed**: reconnecting Frontend can safely resync.
6. **Pagination everywhere**: sessions, messages, files, logs.
7. **Capability-driven UI**: Backend reports features by Harness, project, workspace, and platform.
8. **Transport-agnostic client**: React code calls `OpenGuiClient`, not `window.electronAPI`.

## API skeleton (unchanged from previous plan)

Base:

```
GET  /api/health
GET  /api/version
GET  /api/capabilities
POST /api/auth/login
POST /api/auth/refresh
POST /api/auth/logout
```

Workspaces:

```

```

Projects:

```
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId
POST   /api/projects/:projectId/connect
POST   /api/projects/:projectId/disconnect
GET    /api/projects/:projectId/status
```

Sessions:

```
GET    /api/sessions?projectId=&harnessId=&cursor=&limit=
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

```
GET  /api/sessions/:sessionId/messages?cursor=&limit=&direction=older|newer
POST /api/sessions/:sessionId/prompt
POST /api/sessions/:sessionId/command
POST /api/sessions/:sessionId/abort
POST /api/permissions/:permissionId/respond
POST /api/questions/:questionId/reply
POST /api/questions/:questionId/reject
```

Harnesses (formerly /api/agent-backends):

```
GET  /api/harnesses
GET  /api/projects/:projectId/providers?harnessId=
GET  /api/projects/:projectId/models?harnessId=
GET  /api/projects/:projectId/agents?harnessId=
GET  /api/projects/:projectId/commands?harnessId=
POST /api/projects/:projectId/providers/:providerId/connect
POST /api/projects/:projectId/providers/:providerId/disconnect
```

Filesystem/git/worktrees:

```
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

```
GET /api/events?cursor=<lastEventId>
```

Protocol transport decision: **WebSocket first**, with fallback to SSE. The existing WebSocket event transport in `web-server.ts` already works; lean into it.

## Protocol package

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

- `HttpOpenGuiClient`: real Backend API (used by Web and Mobile Shells, and Desktop Shell in remote mode)
- `ElectronCompatOpenGuiClient`: temporary adapter over `window.electronAPI` during migration (Desktop Shell only, phased out)

Frontend hooks depend only on `OpenGuiClient`.

## Universal workspace model

```ts
interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  defaultProjectId?: string;
  defaultHarnessId?: HarnessId;
  settings: WorkspaceSettings;
}

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
  harnesses: ProjectHarnessConfig[];
}

interface ProjectHarnessConfig {
  harnessId: HarnessId;
  enabled: boolean;
  connectionMode: "local-cli" | "remote-server" | "managed-server";
  remoteUrl?: string;
  authRef?: string;
  defaultModel?: SelectedModel;
  defaultAgent?: string;
}

interface SessionRecord {
  id: string; // OpenGUI canonical ID
  rawId: string; // native Harness session ID
  workspaceId: string;
  projectId: string;
  harnessId: HarnessId;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "error" | "unknown";
  metadata?: Record<string, unknown>;
}
```

Canonical session key: `projectId + harnessId + rawId`

## Harness adapter contract

```ts
interface HarnessAdapter {
  id: HarnessId;
  label: string;
  capabilities: HarnessCapabilities;

  connectProject(scope: HarnessScope, config: ProjectHarnessConfig): Promise<void>;
  disconnectProject(scope: HarnessScope): Promise<void>;
  getProjectStatus(scope: HarnessScope): Promise<ConnectionStatus>;

  listSessions(scope: HarnessScope, input: ListSessionsInput): Promise<ListSessionsResult>;
  createSession(scope: HarnessScope, input: CreateSessionInput): Promise<SessionRecord>;
  updateSession(scope: HarnessScope, input: UpdateSessionInput): Promise<SessionRecord>;
  deleteSession(scope: HarnessScope, sessionId: string): Promise<boolean>;

  getMessages(scope: HarnessScope, input: GetMessagesInput): Promise<MessagePage>;
  prompt(scope: HarnessScope, input: PromptInput): Promise<void>;
  abort(scope: HarnessScope, sessionId: string): Promise<void>;

  subscribe(listener: (event: HarnessAdapterEvent) => void): () => void;
}
```

Backend core translates adapter events into OpenGUI events with canonical IDs.

## Event model

```ts
interface OpenGuiEventEnvelope<T = OpenGuiEvent> {
  id: string;
  type: T["type"];
  createdAt: string;
  workspaceId?: string;
  projectId?: string;
  sessionId?: string;
  harnessId?: HarnessId;
  payload: T;
}
```

Event types (canonical, unchanged from previous plan).

For mobile and flaky networks:

- Client sends last seen event ID on reconnect.
- Backend replays recent events from in-memory ring buffer or persistent event log.
- If replay cursor expired, backend tells client to refetch affected resource.

## Prompt queue ownership

Moved to Backend. Reasons:

- Desktop can close while Backend keeps running.
- Mobile/web clients can observe same queue.
- Multiple Frontends connected to same Backend see consistent busy/queued state.

Frontend may keep unsent textarea drafts locally, but queued prompts belong to Backend.

## Settings ownership

Backend settings:

- Workspaces/projects
- Allowed roots
- Provider credentials refs
- Harness config
- Model defaults
- MCP config
- Plugin config
- Prompt queues
- Session metadata shared across clients

Frontend-local settings:

- Theme
- Sidebar width/collapse
- Language
- Density
- Local draft text
- Currently selected Backend profile
- Mobile notification preferences

Shared UI metadata (with Backend sync):

- Pins
- Colors/tags
- Last active session per workspace
- Project order

## Shell responsibilities after split

### Desktop Shell (Electron)

Keep in Electron:

- Window controls (frame, min, max, close)
- Updater (`electron-updater`)
- Native `shell.openExternal`
- Native folder picker (`dialog.showOpenDialog`)
- Backend sidecar process lifecycle (spawn, health-check, stop)
- Secure token injection into renderer
- OS notifications

Move out of Electron (into Backend):

- Harness adapters (opencode-bridge, claude-code-bridge, etc.)
- Session state
- Prompt queue
- Provider/model runtime state
- Git/worktree ops
- Filesystem server browsing

Desktop Shell launch flow:

```txt
1. Read selected BackendProfile.
2. If profile is local-managed:
   a. Spawn Backend sidecar with OPENGUI_AUTH_TOKEN and OPENGUI_ALLOWED_ROOTS
   b. Wait for /api/health
   c. Restart or show error if failed
3. Load Frontend (React).
4. Provide Backend URL/token to Frontend through preload.
5. On exit, stop sidecar if user configured "stop with app".
```

### Web Shell (browser)

- No Backend spawning
- No native file dialog (use Backend's file API)
- Backend connection via configured URL or same-origin proxy
- Only window.open / location.href for external navigation

### Mobile Shell (Capacitor)

- No Backend spawning
- No terminal opening
- No local file browser (use Backend's fs API)
- Native folder picker only as helper for remote Backend project config
- Push notification registration
- Secure token storage (Capacitor Preferences / Keychain)
- Platform-specific status bar, safe areas, keyboard handling

## Auth and security

- Auth required unless explicitly disabled for development.
- Local sidecar bound to `127.0.0.1` by default.
- Local sidecar uses random high-entropy token.
- Remote Backend refuses to start without auth secret or explicit `OPENGUI_INSECURE_NO_AUTH=1`.
- CORS allowlist, default same-origin only.
- HTTPS expected behind reverse proxy.
- WebSocket/SSE requires auth.
- Allowed roots enforced for every path API and every Harness project.
- Secrets redacted in logs/events.
- Provider tokens stored in Backend secure store where possible.
- Audit log for destructive project/git/provider operations.

## Deployment

### Docker / Web

One container running the Backend that also serves compiled Frontend assets. See existing `Dockerfile` and `docker-compose.yml`.

The Web Shell is just a browser pointing at the server URL.

### Capacitor Mobile

Mobile Shell wraps the same Frontend build. The Capacitor app is a WebView pointing at the compiled Frontend, plus platform plugins.

The Backend is always remote -- either on LAN (Tailscale, home server) or a public VPS.

## Data storage

Backend needs persistent store.

Option A: JSON files in user data dir (current) -- ok for single-user local, fragile for event replay.
Option B: SQLite -- recommended target.

Key tables:

```
workspaces
projects
project_harnesses
sessions
session_mappings
message_cache
prompt_queue
settings
secrets_metadata
events
backend_profiles (Desktop Shell only, not in Backend)
```

Recommended: storage interface now, SQLite before remote hardening.

## Migration plan

### Phase 0: Glossary and architecture freeze (COMPLETE)

- CONTEXT.md updated with Harness, Shell, OpenGUI Backend, OpenGUI Frontend.
- Architecture decisions recorded in this document.
- NEXT: Create ADR for the Harness terminology change.

### Phase 1: Protocol boundary in Frontend

Goal: All Frontend code calls `OpenGuiClient`, not `window.electronAPI`.

Status: `OpenGuiClient` interface exists. `ElectronCompatOpenGuiClient` exists. Partial hook migration done.

Remaining tasks:

- Audit all hooks and services for direct `window.electronAPI` references.
- Replace with `OpenGuiClient` calls.
- Add missing methods to `OpenGuiClient` (git, worktree, backend:install, file find).
- Remove `window.electronAPI` type references from shared types.
- Remove `__openGuiTransport` hacks.

Success: Frontend is transport-agnostic. Desktop Shell can swap transport without code changes.

### Phase 2: Backend service layer

Goal: Backend has real services, not FakeIPC.

Tasks:

- Create `server/services/` with WorkspaceService, ProjectService, SessionService, EventBus.
- Move workspace logic from frontend settings store to Backend services.
- Create Harness adapter registry.
- Let old IPC handlers (in main.ts and web-server.ts) call the same services.
- Add `StorageService` interface (JSON local for now).

Success: Same UI works. Services can be called without Electron-shaped event objects.

### Phase 3: Real HTTP routes

Goal: `/api/*` routes replace `/api/rpc` fake IPC.

Tasks:

- Implement `/api/health`, `/api/capabilities`, `/api/harnesses`.
- Implement workspace/project/session/message routes.
- Implement event stream with canonical events.
- Add typed `HttpOpenGuiClient`.
- Switch Web Shell to `HttpOpenGuiClient`.
- Remove `/api/rpc` handler.

Success: Browser mode uses real Backend API. Desktop Shell still uses Electron IPC compat.

### Phase 4: Desktop Sidecar

Goal: Desktop Shell spawns Backend as separate process. Renderer uses HTTP.

Tasks:

- Build Backend as separate entrypoint (`apps/backend/server.ts` or `server/entry.ts`).
- Electron main spawns Backend process in local-managed mode.
- Preload gives Frontend Backend URL/token, not giant agent IPC.
- Keep native Shell APIs (window, dialog, updater) separate in preload.
- Add `desktop:openDirectory` and `desktop:openExternal` to `OpenGuiClient` interface.

Success:

- Desktop renderer uses `HttpOpenGuiClient` like web.
- Harness adapters run in Backend process, not Electron main.
- Existing bridges moved to Backend codebase.

### Phase 5: Universal workspace/session persistence

Goal: Backend owns all workspace/project/session state.

Tasks:

- Introduce server-issued workspace/project/session IDs.
- Migrate existing workspace state from frontend settings.
- Map native Harness session IDs to canonical `SessionRecord`.
- Make all Harnesses respect `HarnessScope`.
- Move prompt queues to Backend.
- Add `StorageService` SQLite implementation.

Success: All Harnesses show workspaces/projects consistently. Same remote Backend can be controlled by multiple Frontends simultaneously.

### Phase 6: Remote hardening

Goal: Backend is safe to expose on a network.

Tasks:

- Add auth middleware (token validation).
- Add allowed root enforcement everywhere.
- Add CORS policy.
- Add token management UI in settings.
- Add Docker and reverse proxy docs.
- Add audit/security warnings.

Success: User can host Backend on a server and connect from desktop/web safely.

### Phase 7: Mobile Shell

Goal: Capacitor app connects to any remote Backend.

Tasks:

- Build Capacitor scaffold (iOS + Android).
- Wire `OpenGuiClient` with Capacitor HTTP plugin.
- Add platform-specific Shell: push notifications, secure storage, native picker.
- Add capability flags for mobile UI (no terminal, no local backend, no file browser).
- Add device registration endpoints (`POST /api/devices/register`).
- Strip desktop-only UI elements behind capability query.

Success: Mobile app exists and can control a remote Backend.

### Phase 8: Repo restructure

Goal: Target monorepo layout.

Tasks:

- Move Backend code to `apps/backend/`.
- Move Frontend code to `apps/frontend/`.
- Move Desktop Shell code to `apps/desktop/`.
- Move Mobile Shell code to `apps/mobile/`.
- Extract `packages/protocol/` from `src/protocol/`.
- Update build configs (package.json, tsconfig, vite configs, electron-builder config).
- Update CI/CD pipelines.

Success: Clean monorepo with clear boundaries.

## Testing strategy

Unit tests:

- Protocol schema validation
- Workspace/project/session ID mapping
- Path allowlist checks
- Event normalization
- Harness scope mapping
- Prompt queue dispatch rules

Integration tests:

- Start Backend, create workspace/project, create session, send prompt, receive events
- Reconnect event stream with cursor
- Remote auth rejects missing token
- Path traversal and symlink escape blocked
- Two Frontends see same session/queue state

Desktop tests/manual:

- Local-managed Backend starts/stops
- Backend crash shows recovery UI
- Remote profile connects
- Native folder picker adds project to local Backend

Mobile tests:

- Capacitor app connects to Backend
- Push notification registration
- Event stream over HTTPS
- Token refresh on reconnect

## Compatibility with existing OpenCode server mode

Keep OpenCode remote server support as a Harness connection mode:

```ts
connectionMode: "remote-server";
remoteUrl: "http://...";
```

Flow: Frontend -> OpenGUI Backend -> OpenCode remote server

Do not expose OpenCode server directly as OpenGUI Backend.

## Risks

1. **Big-bang rewrite risk**: avoid by introducing protocol client first and keeping compat adapters.
2. **Identity bugs**: solve with canonical IDs and explicit native ID mappings.
3. **Remote security risk**: do not document public hosting until auth + allowed roots are done.
4. **Event mismatch across Harnesses**: normalize adapter events in Backend core, not Frontend.
5. **Mobile payload size**: paginate messages early and strip heavy tool payloads.
6. **Sidecar packaging**: ensure Backend entrypoint and dependencies are in Electron build.
7. **Path confusion**: always label paths as backend-local in UI when connected remotely.
8. **Mobile Shell scope creep**: Mobile Shell must NEVER spawn a Backend, open a terminal, or browse local files. Enforce via capability flags.

## Open decisions (resolved)

1. **Transport**: WebSocket first (already works in web-server.ts). Same event envelope.
2. **Storage**: Start with JSON. Add storage interface now. SQLite before Phase 6.
3. **Stop Backend on Desktop exit**: User setting. Default: stop with app.
4. **Backend serves Frontend assets**: Yes for Docker/Web. Keep Frontend static-hostable.
5. **Multi-user**: No. Single-owner token auth. Design auth middleware for future extension.
6. **Capacitor vs React Native**: Capacitor. Lets Mobile Shell use the same compiled React build.
7. **No headless Backend product**: The Backend IS the headless Backend. One binary.

## First implementation checklist (updated)

- [x] `OpenGuiClient` interface and provider in Frontend.
- [x] `ElectronCompatOpenGuiClient` over current `window.electronAPI`.
- [ ] Complete `OpenGuiClient` hook migration (audit and convert all remaining direct electronAPI calls).
- [ ] Add `server/services/` with workspace, project, session services.
- [ ] Add canonical `Workspace`, `Project`, `SessionRecord`, `HarnessScope` types.
- [ ] Harness terminology is current: use `HarnessId` and `harnesses` in API and types.
- [ ] Add real `/api/harnesses`, `/api/projects/*`, `/api/sessions/*` routes.
- [ ] Add auth/token middleware skeleton.
- [ ] Add Desktop Shell BackendProfile model.
- [ ] Add local sidecar launch in Desktop Shell.
- [ ] Add migration for existing frontend workspace settings.
- [ ] Add Capacitor scaffold (Phase 7 prep).
