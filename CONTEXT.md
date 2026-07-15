# OpenGUI Context

OpenGUI is a multi-platform chat interface for long-running, general-purpose agent work against concrete project directories. One first-party OpenGUI Harness performs the work; Desktop runs it locally, while Web and Mobile connect to an OpenGUI Host.

The product architecture follows [ADR 0010](docs/adr/0010-first-party-opengui-harness.md). [`docs/architecture.md`](docs/architecture.md) maps the implementation; [`first-party-harness-replacement.md`](docs/plans/first-party-harness-replacement.md) records the replacement plan and remaining acceptance work.

## Language

### People and product

**Everyday Builder**:
A lightly technical person who uses OpenGUI for practical work such as presentations, email, websites, WordPress, scripts, and small business tools. They may know basic HTML, CSS, JavaScript, files, and hosting, but should not need to install or understand coding-agent CLIs.
_Avoid_: Normie, professional developer only, harness user

**OpenGUI**:
The product comprising the Frontend, its platform Shells, and the OpenGUI Host that performs and persists agent work.
_Avoid_: Multi-harness command center, coding-agent bridge UI

### Architecture

**OpenGUI Harness**:
The first-party agent engine that turns prompts into model turns and tool calls. A Host contains one Harness; the Harness is not an adapter over Pi, OpenCode, Codex CLI, Claude Code, or another external coding-agent runtime.
_Avoid_: External Harness, Runtime, bridge, adapter host, agent backend

**OpenGUI Host**:
The process that owns the Harness, Sessions, credentials, queues, multi-client arbitration, and the product interface consumed by Frontends. A Host runs locally with Desktop or remotely as a self-hosted or OpenGUI-hosted deployment.
_Avoid_: Harness, server (when the ownership role matters), external agent backend

**OpenGUI Frontend**:
The React application that presents Workspaces, Projects, Sessions, chat, tool calls, and settings. It controls work through a Host and never executes model tools itself.
_Avoid_: Harness UI, stateless renderer

**Shell**:
The platform scaffold that runs the Frontend and supplies platform integration. Desktop, Web, and Mobile are Shells, not separate agent implementations.
_Avoid_: Harness, Host

**Desktop Shell**:
The Electron Shell for Windows, macOS, and Linux. It starts and connects to the user's Local Host and provides native window, picker, notification, update, and secure-credential integration.
_Avoid_: Desktop Harness, Electron agent

**Web Shell**:
The browser Shell. It connects to a Remote Host and never claims browser-local filesystem or shell execution.
_Avoid_: Web Harness, browser agent runtime

**Mobile Shell**:
The iOS/Android Shell. It connects to a Remote Host and does not run a reduced phone-local Harness.
_Avoid_: Mobile Harness, local mobile shell mode

**Local Host**:
The Host started directly on the user's computer by the Desktop Shell. Its Harness runs with that user's operating-system permissions and environment.
_Avoid_: Local Workspace, localhost bridge, desktop CLI

**Remote Host**:
A self-hosted or OpenGUI-hosted Host reached over an authenticated connection by Desktop, Web, or Mobile Frontends.
_Avoid_: Remote Harness, Additional Harness

**OpenGUI-hosted Host**:
A Remote Host operated by OpenGUI in an isolated execution environment for one customer. The Harness is unrestricted inside that environment, but customers never share one unrestricted operating-system account.
_Avoid_: Shared agent process, unrestricted multi-tenant host

**Host connection**:
The URL and authentication material a Frontend uses to reach one Remote Host. It is presentation and transport configuration, not Session identity.
_Avoid_: Provider connection, Harness selection

### Work organization

**Workspace**:
A frontend-owned grouping for one Host connection, its Projects, Sessions, and presentation defaults. Workspace identity is not required by the Harness or stored in canonical Session entries.
_Avoid_: Backend workspace, execution scope

**Project**:
A directory on a Host that OpenGUI presents as a work target. It supplies the default working directory for Sessions and tools but is not a security boundary in unrestricted v1.
_Avoid_: Repository, Git root, artifact workspace, backend Project record

**Project connection**:
Frontend presentation state that makes a Host directory available in the sidebar and for new Sessions. Connecting or removing a Project does not create, move, or delete its files.
_Avoid_: Git clone, Harness attachment, mount

**Session**:
The canonical conversation and execution history for work against one Project through the OpenGUI Harness. The Host owns and persists it; any connected Frontend may observe and control it.
_Avoid_: External Harness Session, frontend transcript cache, chat row only

**Session entry**:
One ordered durable fact in a Session, such as a model change, reasoning change, message, tool call/result, compaction, or run lifecycle change. Entries form the canonical append-oriented Session log.
_Avoid_: Transport delta, bridge event, frontend action

**Session transcript**:
The user-visible projection of durable Session entries plus the current live run. It is read from the Host, not reconstructed from an external coding-agent transcript.
_Avoid_: Harness transcript, frontend source of truth

**Session title**:
The Host-owned display name of a Session. A Frontend may request a rename, but all connected Frontends observe the same title.
_Avoid_: External Harness title, local title override

**Session status**:
The Host-owned state of a Session, such as idle, running, failed, interrupted, or stopped.
_Avoid_: Frontend busy guess, external Harness readiness

**Run**:
One accepted User message processed by the Harness through zero or more model turns and tool calls until completion, failure, interruption, or abort. Only one Run executes in a Session at a time.
_Avoid_: Harness process, entire Session, queue item

**Live Session stream**:
The ordered Host-originated stream of Run, message, and tool updates for a Session. Streaming deltas are live observations; completed semantic content becomes durable Session entries.
_Avoid_: Bridge broadcast, provider-native event stream

**User message**:
A durable Session entry containing accepted user intent and the model/reasoning selection used for its Run.
_Avoid_: Draft, queued follow-up, provider request

**Pending prompt**:
Frontend-local PromptBox text that has not been accepted by the Host. It is not part of a Session transcript.
_Avoid_: User message, Session entry, queued follow-up

**Follow-up**:
A Host-owned prompt waiting in FIFO order while its Session is running. It becomes a User message when the Host dispatches it after the current Run ends.
_Avoid_: Steer, after-part prompt, frontend-only queue item

**Interrupt Session**:
A shared control action that aborts the current Run and its active model request or process tree. It does not delete the Session or discard waiting Follow-ups unless requested separately.
_Avoid_: Delete Session, send, close client

**Backend arbitration**:
The Host's arrival-order decision when multiple Frontends act on one Session concurrently. The resulting durable state and live events are authoritative for every Frontend.
_Avoid_: Client-side race resolution, Session owner

### Models and credentials

**Model connection**:
A Host-owned configuration that can authenticate and stream requests to a model endpoint. V1 includes a ChatGPT/Codex OAuth preset and custom OpenAI-compatible connections.
_Avoid_: External Harness, Workspace connection, CLI installation

**Model adapter**:
Internal Harness code that translates between the common agent-loop model interface and one model wire protocol. Model adapters do not own Sessions, tools, UI capabilities, or Projects.
_Avoid_: Harness Adapter, bridge, provider plugin

**Provider**:
A model vendor or endpoint grouping presented in model selection and connection settings. It is not an executable Harness.
_Avoid_: Agent backend, model adapter, Host

**Model**:
A concrete language model available through a Model connection.
_Avoid_: Provider, Harness, agent mode

**Reasoning level**:
The user selection controlling supported model reasoning effort. A change is recorded in Session order so replay uses the selection that applied to each User message.
_Avoid_: Harness variant, agent, global hidden default

**Provider credentials**:
Secrets or tokens held by the Host for a Model connection. They must not be included in Session entries, tool output, or frontend persistence.
_Avoid_: Host access token, Workspace password, transcript metadata

**Host access token**:
A credential used by a Frontend to authenticate to a Remote Host. It grants access to that Host but is not a model credential.
_Avoid_: Provider credential, ChatGPT token

### Harness capabilities

**Tool**:
One of the four fixed capabilities the Harness may expose to a model in v1: `read`, `write`, `edit`, or `shell`.
_Avoid_: MCP tool, extension, plugin

**Tool call**:
A model-requested invocation of a Tool with ordered input, live status, and a final result recorded in the Session.
_Avoid_: Raw log line, interaction request, provider event

**Tool call presentation**:
The existing compact transcript rendering of a Tool call and its status/output. It is presentation of Session data, not a separate Activity product area.
_Avoid_: Activity feed, Results panel, JSON inspector by default

**Shell tool**:
The unrestricted, non-interactive Tool that executes a command through the Host's configured native shell in the Project directory. Windows uses PowerShell; macOS and Linux use the configured user shell with a system fallback.
_Avoid_: Bash tool, terminal emulator, mobile-local shell, command sandbox

**Skill**:
An Agent Skills `SKILL.md` capability package whose metadata is advertised to the model and whose full instructions are loaded on demand with `read`. A Skill cannot register tools, hooks, providers, or UI in v1.
_Avoid_: Extension, MCP server, plugin runtime

**Compaction**:
A durable Session entry summarizing earlier context so a long Session can continue within a model's context limit while preserving visible history.
_Avoid_: Transcript deletion, frontend truncation

### Persistence and presentation

**Host persistence**:
The Host-owned durable source for Sessions, entries, Follow-ups, and Host settings. Session truth no longer belongs to an external coding-agent runtime.
_Avoid_: Harness cache, frontend transcript storage, bridge recovery index

**Frontend persistence**:
Per-device presentation state such as Workspaces, Project connections, selection, drafts, and UI preferences. It does not own shared Session or Follow-up truth.
_Avoid_: Session database, transcript cache, direct scattered localStorage

**PromptBox selection**:
Frontend composition state for the next User message, consisting in v1 of a Model and supported Reasoning level. External Harness, agent, variant, and worktree selection are not part of it.
_Avoid_: Harness selection, provider-native options, shared Session default

**Uploaded prompt file**:
A user-provided file made available to the Host and referenced from PromptBox text for a Run. It remains an ordinary Project-accessible file, not a separate artifact or result concept.
_Avoid_: Results item, base64-only message attachment

## Legacy terms

The following describe the architecture being removed and must not appear in new interfaces:

**External Harness**:
Pi, OpenCode, Codex CLI/SDK, Claude Code, Grok, or another third-party coding-agent runtime previously integrated by OpenGUI.
_Avoid in new code_: Harness ID, detected Harness, Harness inventory, Harness readiness

**Harness Adapter**:
Legacy integration code translating OpenGUI operations and events to one External Harness.
_Avoid in new code_: Bridge, project slot, daemon bridge

**OpenGUI Runtime**:
The legacy adapter-oriented package that hosted External Harnesses and normalized their events. ADR 0010 replaces this role with the first-party OpenGUI Harness inside the Host.
_Avoid in new code_: New public APIs built on `harnessId`

**Harness Scope**:
The legacy external Harness, directory, and external Session tuple. New execution uses a Host-owned Session that directly references its Project directory.
_Avoid in new code_: External session identity, directory-to-Harness routing
