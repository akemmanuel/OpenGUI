# OpenGUI Context

**Start here (contributors):** Architecture and glossary below → [`docs/adr/README.md`](docs/adr/README.md) (decisions) → [`docs/architecture.md`](docs/architecture.md) (repo map) → [`docs/plans/runtime-backend-sdk-split.md`](docs/plans/runtime-backend-sdk-split.md) (extraction status). SDK shape: [ADR 0007](docs/adr/0007-runtime-sdk-minimal-surface.md), plan [`runtime-sdk-minimal-surface.md`](docs/plans/runtime-sdk-minimal-surface.md). Improvement roadmap: [`docs/plans/contributor-experience-and-slop-removal.md`](docs/plans/contributor-experience-and-slop-removal.md).

OpenGUI is a command center for long-running coding-agent work across projects and Harnesses. The core distinctions here are about where user intent lives in the **OpenGUI Frontend** versus when it becomes shared **OpenGUI Backend** state or a **Harness** operation through the **OpenGUI Runtime**.

## Architecture

OpenGUI is split into four layers:

- **OpenGUI Runtime** -- In-process engine behind Harness execution: Harness Adapters, normalized Harness events, Harness Inventory, Agent sends, and Harness Scope operations (sessions and transcripts via the Harness, not durable OpenGUI caches). Single-process integrators and the OpenGUI SDK use the Runtime directly. It does not own Queued prompts, multi-client transport, or Frontend presentation.
- **OpenGUI Backend** -- Networked host that embeds one OpenGUI Runtime and adds shared multi-Frontend concerns: HTTP/WebSocket/SSE (and Desktop private IPC transport), Queued prompts with Queue dispatch, Backend arbitration, backend access token auth, and Backend persistence for queue and uploaded-prompt cleanup. It does not define the Workspace primitive or sidebar Project membership. Deployable as a Desktop sidecar, Docker container, or standalone server.
- **OpenGUI Frontend** -- React UI rendering navigation, chat, and settings, and owning presentation state such as Workspaces, Project connections, Pending prompts, Queued prompts UI, and Session placement. Talks only to an OpenGUI Backend via `OpenGuiClient`. Runs identically in Desktop, Web, and Mobile.
- **Shell** -- Platform-specific scaffold that bootstraps the Frontend. Three variants:
  - **Desktop Shell** (Electron main+preload): window controls, native file picker, updater, OS notifications, backend sidecar lifecycle.
  - **Web Shell** (browser): minimal -- no backend spawning, no native file dialog. Backend connection is same-origin or user-configured URL.
  - **Mobile Shell** (Capacitor JS): native file picker, push notifications, secure token storage. Never spawns a backend or opens a terminal.

**Harness**:
A coding-agent runtime (Claude Code, Codex, Pi, or another supported CLI) that OpenGUI Runtime manages through Harness Adapters. Harness availability is not Project-specific. The Frontend never speaks to a Harness directly; it reaches execution only through an OpenGUI Backend that embeds the Runtime.
_Avoid_: Agent backend, agent runtime (in product UI), bridge, provider

**Detected Harness**:
A Harness CLI OpenGUI finds already installed and available on the user's machine. Setup does not show a Detected Harness list; detected readiness only determines whether the user can start Agent sends after completing setup.
_Avoid_: recommended harness, preferred harness, default agent, onboarding harness picker

**No Harness Installed**:
The setup and home state where OpenGUI cannot find any available Harness CLI on the user's machine. Setup may still be completed because execution readiness is separate from presentation preferences; Agent sends remain unavailable until a Harness is installed, authenticated, and model-ready.
_Avoid_: failed setup, broken app, install every harness, equal install menu, privileged fallback harness

**Skip Harness Setup**:
The setup wizard path where a user intentionally continues without a model-ready Harness, then configures non-execution preferences such as Default chat directory and appearance. Skipping Harness setup does not show a Harness picker or installer; after setup, Detected Harnesses may be used immediately while No Harness Installed keeps Agent sends unavailable.
_Avoid_: skip onboarding, ready without harness, cancel setup, install another harness in setup

**Harness Adapter**:
The local integration code in OpenGUI Runtime that translates normalized Runtime operations into Harness SDK or CLI calls. One adapter per Harness type.
_Avoid_: Bridge, provider glue, agent SDK glue

**Guided Harness Install**:
A user-approved setup flow where OpenGUI helps install a specific Harness and then verifies whether it is available. It must not silently install anything or present guided installation for every Harness.
_Avoid_: silent install, bundled agent, automatic setup, default npm install, all-harness installer

**Manual Guided Harness Install**:
A guided install path where OpenGUI does not execute the installer itself. OpenGUI shows the official install command or installer source, offers copy and open-terminal actions, and then performs Install Verification after the user completes installation outside OpenGUI.
_Avoid_: silent install, hidden script execution, package-manager fallback, automatic `curl | bash`

**Official Installer Consent**:
The explicit approval step before OpenGUI starts or guides a Harness install action. OpenGUI shows what it will install in plain language, shows the command or installer source when relevant, and offers manual instructions as an alternative.
_Avoid_: hidden script execution, blind install, terminal-only setup

**Install Verification**:
The post-install check where OpenGUI detects whether a Harness CLI became available after Guided Harness Install. OpenGUI polls automatically and also lets the user manually request another check.
_Avoid_: assume installed, user-only confirmation, one-shot detection

**Harness Readiness**:
The user-facing availability state of a Harness: not installed, installed but not authenticated, installed but unable to report models, ready, or broken. A verified CLI install is not ready until the Harness has usable provider credentials or CLI-authenticated provider state and at least one runtime-discovered model available for explicit PromptBox selection.
_Avoid_: installed means ready, backend available, binary found, hidden default model

**Harness Inventory**:
The Runtime-produced snapshot of a Harness's current usability: CLI availability, version, authentication state, runtime-discovered models, agents/options when available, diagnostic message, and check time. Harness Inventory is the source for model selection; OpenGUI does not invent fixed model lists when a Harness cannot report models.
_Avoid_: static model catalog, guessed model list, CLI detection result

**Model-ready Harness**:
A Harness whose Inventory says it is ready and includes at least one runtime-discovered model. Only Model-ready Harnesses may be selected for an Agent send that requires model selection.
_Avoid_: usable because installed, send with CLI default, implicit model fallback

**Harness Scope**:
The harness+project-directory+session tuple that scopes a Harness operation inside OpenGUI Runtime. Frontend Workspaces may choose and route that scope, but they are not part of it.
_Avoid_: Agent session context (vague), cwd (too narrow), workspace-scoped harness

**OpenGUI Runtime**, **OpenGUI Backend**, and **OpenGUI Frontend** are defined in **Architecture** above. Use those bullets for layer ownership; the entries here only add _Avoid_ aliases where useful.

**OpenGUI Runtime** — _Avoid_: SDK only, bridge folder, in-app backend server

**OpenGUI Backend** — _Avoid_: server, headless backend, daemon, harness host without Runtime

**OpenGUI Frontend** — _Avoid_: renderer, stateless client

**Backend persistence**:
The OpenGUI Backend's SQLite-backed storage boundary for OpenGUI-owned shared state that is not canonical Harness state, such as Queued prompts, queue dispatch state, backend execution settings, and uploaded prompt file cleanup records. Backend persistence is scoped to one OpenGUI Backend instance and must not store Frontend Workspace identity, Project navigation membership, Session lists, or Session transcripts.
_Avoid_: workspace database, session cache, message cache, frontend settings store

**Frontend Host**:
The deployment surface that serves static OpenGUI Frontend assets for the Web Shell. It may be the same process/container as an OpenGUI Backend or a separate static host configured to connect to an OpenGUI Backend.
_Avoid_: web backend, frontend backend, bundled app server

**API-only Backend**:
An OpenGUI Backend deployment that serves only backend APIs and no Web Shell assets. Desktop Shell, Mobile Shell, and a separately hosted Web Shell may connect to it; non-API browser routes return not found.
_Avoid_: headless, headless backend, headless server, backend without app

**Standalone Web Frontend**:
A Web Shell deployment where static OpenGUI Frontend assets are hosted separately from the OpenGUI Backend and configured with a target backend URL. It requires the target OpenGUI Backend to allow the frontend origin.
_Avoid_: extra web workspace, frontend-only backend

**Combined Backend + Frontend**:
A convenience deployment where one process or container serves both the OpenGUI Backend API and the static OpenGUI Frontend assets. Web Shell uses the same origin by default in this mode.
_Avoid_: monolith, web backend

**Frontend persistence**:
The single Frontend-owned storage boundary for durable per-device presentation, connection, and preference state. Frontend persistence stores small typed documents for UI restoration and local intent, not canonical backend data, execution state, Session transcripts, or shared queues. App code should use one storage abstraction rather than scattering direct browser storage mechanisms.
_Avoid_: localStorage directly, IndexedDB cache, offline backend mirror, transcript cache

**Desktop Shell**:
The Electron main+preload process. Owns window controls (frame, minimize, maximize, close), native file picker, updater, OS notifications, backend sidecar lifecycle. Does NOT own agent logic, session state, prompt queues, or git operations.
_Avoid_: Desktop app, main process

**Desktop IPC Backend Transport**:
The Electron-only transport used by the Desktop Shell for its built-in Local Workspace to call the local OpenGUI Backend through an Electron-controlled private channel instead of an HTTP listener on localhost. It preserves the `OpenGuiClient` boundary while avoiding user-visible local ports, loopback auth tokens, firewall prompts, and duplicate localhost sidecar confusion. HTTP remains the transport for Web, Mobile, Additional Workspaces, and remote OpenGUI Backends.
_Avoid_: localhost desktop backend, closed protocol, renderer HTTP sidecar, private server port

**Persistent Desktop Backend**:
The single user-session-local OpenGUI Backend process for Desktop's Local Workspace that may remain running after all Desktop Shell windows close. It is intentionally persistent so long-running Sessions, Queued prompts, and Harness work can continue, but it must be discoverable, reused by later Desktop Shell launches, health-checked, and explicitly stopped or replaced when stale. Persistence must never create multiple unmanaged ghost backends.
_Avoid_: detached ghost process, per-window backend, one backend per launch, immortal sidecar

**Web Shell**:
The browser environment. No native desktop APIs. Backend connection is same-origin or user-configured URL. Cannot spawn a backend or open a terminal.
_Avoid_: Web app (vague), browser mode

**Mobile Shell**:
Capacitor JS scaffold for iOS/Android. Provides native file picker, push notifications, secure token storage, but never spawns a Backend or opens a terminal. Connects only to a remote or LAN Backend.
_Avoid_: Mobile app, phone client

**Provider credentials**:
Backend-owned credentials or references needed for Harness execution, such as API keys, OAuth tokens, or CLI-authenticated provider state. The Frontend may collect or configure them, but execution uses credentials available to the OpenGUI Backend.
_Avoid_: frontend secret, local browser credential

**Everyday Builder**:
A non-technical or lightly technical person using OpenGUI to get coding-agent help with practical software work, such as websites, WordPress, PHP, scripts, or small business tools. They may recognize terminals and files but should not need to understand package managers, daemon processes, ports, environment variables, or CLI authentication flows to use the product.
_Avoid_: Normie, power user, professional developer only

**Backend access token**:
A bearer token used by a Frontend or Shell to authenticate to an OpenGUI Backend API, matching the Backend's configured `OPENGUI_AUTH_TOKEN`. It is Workspace connection material, not a provider credential and not a username/password login.
_Avoid_: workspace password, backend password, provider token

## Language

**Workspace**:
A durable, frontend-local connection-and-organization boundary containing an immutable OpenGUI Backend URL, editable auth material, plus the Projects, Sessions, and defaults the app presents together. A Workspace may have no Project connections and still show backend health, Harness availability, and settings. Many Workspaces may point to the same OpenGUI Backend, and the same backend-owned Session may appear in different Frontends' Workspaces, but within one Frontend presentation a Session belongs to one Workspace at a time. Deleting a Workspace deletes only saved connection material and frontend presentation state. A Workspace is never a backend primitive: backend APIs, storage records, and Harness scopes must not require a Workspace ID. Some Shells may start with no Workspace at all until the user connects to an OpenGUI Backend.
_Avoid_: backend workspace, backend profile, server tab, repo group, OpenCode server

**Local Workspace**:
The built-in, non-removable frontend Workspace for the Shell's default OpenGUI Backend connection. Desktop has one Local Workspace for its default local Backend sidecar; Web has one Local Workspace for the OpenGUI Backend that served the frontend. Mobile has no Local Workspace because it cannot spawn or assume a phone-local OpenGUI Backend.
_Avoid_: mobile local workspace, localhost workspace, device workspace

**Additional Workspace**:
A user-created Workspace pointing at an explicitly configured OpenGUI Backend URL. Desktop and Mobile may have unlimited Additional Workspaces; Web Shell never has Additional Workspaces because its backend target is deployment-owned rather than user-managed.
_Avoid_: non-local workspace, extra local workspace, server tab

**Configured Web Workspace**:
The single, non-removable Workspace used by a Standalone Web Frontend. Its OpenGUI Backend URL and display name come from Frontend Host configuration such as container environment variables, not from user-editable frontend Workspace state; if no name is configured, the UI falls back to the backend hostname and then OpenGUI.
_Avoid_: web additional workspace, browser-selected backend, stored web workspace

**Workspace Chrome**:
UI controls for viewing, switching, creating, editing, reordering, or removing Workspaces. Shells with a single non-removable Workspace may hide Workspace Chrome even though a Workspace exists internally.
_Avoid_: workspace itself, project sidebar

**Multi-Workspace Shell**:
A Shell that allows users to create, save, switch, and remove Additional Workspaces. Desktop and Mobile are Multi-Workspace Shells; Web is not.
_Avoid_: workspace count, multi-server backend

**Workspace Tabs**:
The tab-strip and plus-button form of Workspace Chrome. Workspace Tabs are shown only when the Shell has at least one Workspace and is a Multi-Workspace Shell; hide them when there is no Workspace or when the Shell does not support multiple Workspaces.
_Avoid_: workspace chrome in general, project tabs

**No Workspace**:
A frontend state where the Shell has no saved Workspace and therefore no active OpenGUI Backend connection. Mobile starts here on first launch and offers Connect to OpenGUI Backend as the primary action, which creates an Additional Workspace. Desktop and Web normally do not enter this state because each has a Local Workspace.
_Avoid_: disconnected workspace, empty local workspace

**PromptBox selection**:
Frontend-local composition state choosing the Harness, model, agent, and variant for the next Agent send. When a Frontend loads an existing Session, PromptBox selection is replaced by the latest User message selection in that Session; when a Frontend starts a new Pending prompt target, PromptBox selection is inherited from the immediately previous in-memory PromptBox selection.
_Avoid_: shared session setting, backend default, assistant model, persisted default, compatibility fallback

**PromptBox action controls**:
The visible controls for turning PromptBox text into an Agent send and for interrupting a running Session. When PromptBox text exists and the Session is idle, Send is active. When PromptBox text exists and the Session is running, both Interrupt Session and Send are active so the user can either stop current work or submit follow-up intent. When PromptBox text is empty and the Session is idle, Send remains visible but inactive. When PromptBox text is empty and the Session is running, only Interrupt Session is shown.
_Avoid_: one-button toggle, send-as-stop, disabled stop while running

**User message selection**:
The Harness, model, agent, and variant recorded on a User message as the execution intent for that message. For PromptBox selection, the latest User message selection in a Session is the only transcript-derived source of truth; Assistant message models are display facts for history and must not drive PromptBox selection.
_Avoid_: assistant selection, resolved model default, inferred model

**No PromptBox selection**:
A Frontend state where PromptBox has no Harness, model, or variant selected and therefore cannot send until the user explicitly chooses a valid selection. OpenGUI uses No PromptBox selection when loading an existing Session with no User message selection, or when starting the first Pending prompt target without an immediately previous in-memory PromptBox selection.
_Avoid_: server fallback, provider default, implicit model, best effort selection

**Default chat directory**:
A Workspace-local Project path selected for the next Pending prompt when starting a new chat without choosing a specific Project first. Each Workspace has its own Default chat directory because project paths are meaningful only for that Workspace's OpenGUI Backend connection.
_Avoid_: global chat directory, app default project

**Chats section**:
The sidebar area for Sessions started from the Workspace's Default chat directory. It is hidden when the Default chat directory is empty, and visible when the Default chat directory is set to an existing directory.
_Avoid_: global chats, projectless chats, always-visible chats

**Default chat directory verification**:
The check that a saved Default chat directory still exists and is accessible through the active OpenGUI Backend before OpenGUI treats it as usable. A non-empty saved path alone is not enough to show the Chats section or allow starting a chat from it.
_Avoid_: string-only default directory, assume path exists, stale chats target

**Invalid Default chat directory**:
A saved Default chat directory that no longer exists or is no longer accessible through the active OpenGUI Backend. OpenGUI clears an Invalid Default chat directory instead of preserving it as a recovery state.
_Avoid_: stale default directory, missing-folder warning state, disconnected default chats

**Optional Setup Preference**:
A setup wizard preference the user may configure during onboarding or skip without blocking completion. Default chat directory and appearance preferences are Optional Setup Preferences.
_Avoid_: required setup step, onboarding blocker, execution readiness

**Project-connected Prompt**:
The chat input shown only when it is attached to an active Session or an active Project target. If no Project is connected, OpenGUI shows an empty state such as No project connected instead of rendering a disabled PromptBox.
_Avoid_: disabled global prompt, send-time folder prompt, implicit home directory

**Uploaded prompt file**:
A user-provided file that the Project-connected Prompt makes available to the OpenGUI Backend before an Agent send by storing it as a backend-accessible temporary file and inserting a file mention for that temporary path into the prompt text. Uploaded prompt files are ordinary files, not prompt images or separate message attachments.
_Avoid_: image attachment, prompt image, base64 attachment, client-only file

**No project connected**:
The chat empty state shown when there is no active Session and no active Project target. When a valid Default chat directory exists, the empty state invites the user to connect a Project or start a chat; when it does not, the user must connect a Project first.
_Avoid_: no chats, select or create a session, disconnected prompt

**No session selected**:
The chat empty state shown when one or more Projects are connected but there is no active Session and no active Project target. It replaces the No project connected state in Workspaces that already have connected Projects.
_Avoid_: no project connected, blank logo state, disabled prompt

**Project**:
A Workspace-scoped, Frontend-owned work target rooted at a concrete directory that the app presents in navigation and uses to request Sessions. A Project belongs to exactly one Frontend Workspace presentation and is not a backend-owned domain object. The Frontend may resolve a Project path against the active OpenGUI Backend when it needs backend-owned Sessions or execution, but backend Project records are implementation details and must not define Workspace Project membership.
_Avoid_: repo, repository root, backend project, global app project

**Session**:
The harness-owned canonical conversation record OpenGUI presents for work performed against one Project through one Harness. OpenGUI discovers Sessions by asking the Harness for the relevant Project and does not maintain a durable Session list cache as a source of truth. A Session is identified by its Harness session ID as routed through OpenGUI, is shared across Frontends connected to the same OpenGUI Backend for that Project and Harness, appears to any Frontend currently presenting that Project, can outlive temporary OpenGUI Frontend unavailability, and does not switch Harnesses after creation.
_Avoid_: thread only, draft, chat row

**Harness Session**:
The harness-native conversation or thread that backs an OpenGUI Session inside one Harness. A Harness Session is runtime state, not the canonical app-level conversation identity.
_Avoid_: Session, canonical session, workspace session

**Session transcript**:
The shared message history for a Session, sourced on demand from the backing Harness Session through the OpenGUI Backend. OpenGUI does not persist a durable transcript cache as a source of truth; when messages for a Session are requested, the Backend asks the Harness. Frontends may render or filter transcript content locally but do not mutate canonical transcript content.
_Avoid_: frontend transcript, local message history

**Harness session summary**:
The normalized session metadata returned on a Session list read or session-metadata read. It contains only fields the Harness reported for that Harness Scope; OpenGUI Backend does not add fields from memory, SSE, or recovered identity.
_Avoid_: backend session row, cached session, SessionRecord as wire truth

**Session list read**:
A request that asks which Sessions exist for one Project directory and one Harness. The Harness is the only source for list membership; OpenGUI does not answer from backend persistence or an in-memory session index.
_Avoid_: sync list, session query cache, SQLite session list

**Session message page read**:
A request for one page of Session transcript for an explicit Harness Scope. The Harness is the only source for page content; product calls require `directory`, `harnessId`, and session identity. Unknown session or missing scope is an error, not an empty success. While a Session is running, new transcript content arrives through the Live Session stream; message pages load history and gap-fill after reconnect.
_Avoid_: silent empty messages, recovered session transcript, backend message cache

**Session status**:
The backend-owned execution state of a Session, such as idle, running, or error, derived from Harness state and backend orchestration. Frontends display Session status but do not own it.
_Avoid_: frontend busy state, local status

**Live Session stream**:
The shared, backend-originated status and output stream for a running Session. Any connected Frontend that opens or lists that Session can see its current progress live, even if another Frontend started it.
_Avoid_: join stream, private run, owner-only output

**Shared Session control**:
Any connected Frontend may act on a shared Session, including interrupting it, sending a follow-up, or managing its shared queue. Shared Sessions have no single owner in the product model.
_Avoid_: session owner, locked session, creator-only control

**Interrupt Session**:
A shared control action that stops the current running work in a Session. It does not clear the shared queue by default and is distinct from queuing a prompt and from deleting the Session.
_Avoid_: send, delete, implicit busy follow-up

**Backend arbitration**:
When multiple Frontends act on the same shared Session at nearly the same time, the OpenGUI Backend decides by arrival order and emits the resulting Session state as the source of truth for all connected Frontends. If concurrent follow-up sends race on an idle Session, the first accepted one becomes the immediate Agent send and later ones become Queued prompts once the Session is busy.
_Avoid_: client-side race resolution, per-frontend session truth

**Session title**:
The canonical name of a Session as defined by its Harness. OpenGUI may request a rename, but the Harness is the only source of truth for the title.
_Avoid_: local title override, frontend-only title, frontend title

**Pending prompt**:
Frontend-local prompt text stored in `sessionDrafts` before a Session exists. It is scoped to the selected Project and Frontend Workspace, and pressing send creates the shared Session with its initial title before dispatching the Agent send.
_Avoid_: Draft session, unsent session

**Queued prompt**:
A backend-owned, shared Session-level prompt stored in the one shared queue for an existing shared Session. A Queued prompt captures model/agent/variant intent when queued, cannot exist before a Session exists, is visible across connected Frontends, follows shared backend queue order, and is the default result of a normal follow-up sent while the Session is busy. It remains queued during temporary Harness unavailability and is not yet part of the Session transcript until dispatch.
_Avoid_: pending message, buffered turn, frontend-only queue item

**Queued prompt target**:
The minimal Harness Scope reference stored with a Queued prompt so the OpenGUI Backend can dispatch it later: Harness, Project directory, and Harness Session ID. This target is part of queued execution intent, not a Session cache, routing hint, or canonical Session record. OpenGUI must not use queued prompt targets to answer Session listing or transcript requests.
_Avoid_: session cache, routing cache, last seen project, session index

**After-part prompt**:
A Queued prompt mode that waits until all currently running tools finish, then interrupts the Session and dispatches the prompt. It is for steering immediately after the current tool part completes, not for ordinary queueing.
_Avoid_: normal queue item, immediate send, generic interrupt

**Queue dispatch**:
The backend orchestration that turns a Queued prompt into an Agent send when a Session becomes idle, when dispatch is requested immediately, or when an after-part trigger fires. Frontends may request dispatch, but only the backend performs it.
_Avoid_: queue flush, frontend-only auto-send side effect

**Agent send**:
The moment OpenGUI turns local intent into a Harness operation such as `startSession`, `prompt`, or `sendCommand`. Pending prompts and queued prompts exist before an agent send; Harness transcript state exists after it.
_Avoid_: enqueue, draft

**Local intent orchestration**:
The frontend-local orchestration around Pending prompts and send requests before they become shared backend actions. It coordinates with Queue dispatch, Project connection, and Session lifecycle rules.

**Project connection**:
Frontend-local state that a Workspace-scoped Project path is selected for navigation and Agent sends. OpenGUI Runtime does not expose a separate connect or attach API; the first Session listing or Agent send for a directory establishes Harness access for that Harness Scope. Execution failures (disallowed path, missing folder, Harness not ready) surface on those operations; the Frontend may remember and display them beside the Project without removing it from the sidebar.
_Avoid_: mount, backend project binding, attachDirectory, connectProject

**Remove Project**:
The sidebar action that removes a Workspace-scoped Frontend Project from that Workspace presentation. It must not delete files on disk or backend-owned Sessions. Sessions that were displayed under that Project survive in backend state and may become invisible in that Workspace until the Project is added again.
_Avoid_: delete project files, delete sessions, backend project deletion

**Session project assignment**:
A frontend-local Session's singular effective display Project in one Frontend presentation, determined by `assignedProjectDir` in sessionMeta when set (the target of a move), falling back to `_projectDir` or the Session's directory. Moving a Session changes presentation only, must target a Project already connected in that Frontend Workspace, and does not retarget the underlying execution scope.
_Avoid_: session relocation, reparenting, retargeting, multi-home session

**Session presentation metadata**:
Frontend-local display state for a Session, such as pinning, color, tags, sidebar ordering, and Session project assignment. It does not change shared Session identity, transcript, title, or execution scope.
_Avoid_: shared session metadata, backend session metadata

**Execution Project**:
The concrete Project directory a Harness Session actually runs against. Execution Project is part of execution scope, while Session project assignment is presentation, and it does not change after Session creation.
_Avoid_: display project, assigned project, moved project

**Orphan Session**:
A Session that still exists in OpenGUI but is no longer attached to any currently connected Project in the active Workspace presentation. It keeps its identity, transcript, and metadata, and an already-open or directly opened view may remain temporarily without Project attachment, but it lacks a visible Project home until reattached or reassigned.
_Avoid_: deleted session, lost chat, missing transcript

**Workspace root project**:
The primary project directory for a repository when related worktrees are present. Worktree directories expand from a Workspace root project but do not replace it.
_Avoid_: canonical path, main worktree

**Delete Session**:
A backend-owned destructive action that removes a shared Session itself and makes it disappear for every connected Frontend. If shared Queued prompts exist, OpenGUI should require confirmation but still allow deletion. OpenGUI has no separate local-only session removal concept.
_Avoid_: hide session, dismiss session, remove from my view

**Clear Session Queue**:
A backend-owned action that removes all Queued prompts for one shared Session without deleting the Session itself.
_Avoid_: interrupt session, delete session

**Session lifecycle**:
The local orchestration for creating, renaming, deleting, reverting, unreverting, and forking sessions. It coordinates UI state and transcript refresh around backend session mutations after a session already exists or is being created.
_Avoid_: chat CRUD, transcript actions

**Session title reconciliation**:
The local orchestration that keeps the displayed Session title aligned with the Harness title across Harness Session replacement and rename requests. The Harness remains the only source of truth for the title.
_Avoid_: local title override, rename patching, title fixup

**Workspace lifecycle**:
The frontend-local orchestration for creating, renaming, reauthenticating, switching, and removing Workspaces, including Project re-resolution when auth changes. A Workspace's OpenGUI Backend URL is not editable after creation; a different URL means creating a different Workspace.
_Avoid_: backend profile lifecycle, workspace CRUD, tabs logic, edit backend URL

**Tool**:
A backend-owned external capability exposed through MCP.
_Avoid_: frontend tool, plugin

**Tool call**:
A single visible use of a Tool within a Session transcript or Live Session stream. A Tool call has a tool name, input, output, and status (`running`, `success`, or `error`); protocol states such as pending are implementation details and present as running. Tool calls are passive execution metadata attached to an assistant turn, not chat-equivalent assistant content and not user-actionable prompts.
_Avoid_: plugin call, raw log line, assistant message, permission request, question prompt

**Tool call presentation**:
The compact UI rendering of a Tool call. Collapsed Tool call rows show a status icon plus a semantic label for known tools, or a prettified tool name for unknown/custom MCP tools. Inputs are hidden for now. Outputs, including error text, terminal text, structured output, and images, are shown only when the Tool call is expanded. A Tool call is expandable only when it has meaningful output; empty, whitespace-only, or structurally useless output must not create an expansion affordance or blank body. Long expanded output is bounded and scrollable.
_Avoid_: always show input, JSON inspector by default, empty expandable row, inline error by default

**Interaction request**:
A user-actionable, agent-blocking request inside a Session where the agent is paused until the user decides something. Permission requests and question prompts are Interaction requests, not ordinary Tool calls. They should render as prominent actionable panels rather than passive collapsible Tool call rows.
_Avoid_: tool output, permission tool call, question tool call, passive transcript metadata

**Harness restart**:
A user-requested recovery action that hard-restarts all Harness processes managed by OpenGUI, not just the currently selected Harness. It stops background agent processes such as the Pi daemon before starting them again.
_Avoid_: server restart, selected backend restart, soft reconnect

## Flagged ambiguities

**Backend Workspace**:
Resolved as invalid terminology. Any backend service, API route, storage table, or Session identity using `workspaceId` is describing either frontend **Workspace** state, a Workspace-scoped frontend **Project**, **Session presentation metadata**, or execution scope in the wrong layer.

**Backend Project record**:
Legacy internal persistence that treated directories as backend CRUD entities with Workspace IDs. Invalid as a product concept; being removed in favor of Harness Scope keyed by directory on each Runtime operation and Frontend-owned Project paths.
_Avoid_: Project in product language, Workspace Project, /api/projects

## Example dialogue

**Dev**: If the user picks a project but has not sent anything yet, do we already have a session?

**Domain expert**: No. That is a **Pending prompt**. It is local-only until an **Agent send** happens.

**Dev**: And when the agent is busy and the user types the next instruction?

**Domain expert**: That becomes a **Queued prompt**. The OpenGUI Backend owns it as shared Session intent until Queue dispatch sends it to the Harness.

**Dev**: So both drafting and queuing stay outside the agent transcript?

**Domain expert**: Exactly. **Pending prompts** are frontend-local before a Session exists. **Queued prompts** are backend-owned shared Session intent, but they still are not transcript content until **Queue dispatch** performs an **Agent send**.
