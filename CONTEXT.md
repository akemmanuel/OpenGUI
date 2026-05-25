# OpenGUI Context

OpenGUI is a command center for long-running coding-agent work across projects and backends. The core distinctions here are about where user intent lives locally versus when it is actually sent into a backend session.

## Language

**Draft session**:
A local-only conversation target selected before a backend session exists. It carries the intended project and backend, but nothing has been sent into the agent yet.
_Avoid_: unsent session, pending chat

**Queued prompt**:
A local-only prompt stored by OpenGUI to be sent later into an existing backend session. A queued prompt belongs to a session, but it is not yet part of that session's backend transcript.
_Avoid_: pending message, buffered turn

**Queue dispatch**:
The local orchestration that turns a Queued prompt into an Agent send when a session becomes idle, when the user sends one immediately, or when an after-part trigger fires.
_Avoid_: queue flush, auto-send side effect

**Agent send**:
The moment OpenGUI turns local intent into a backend operation such as `startSession`, `prompt`, or `sendCommand`. Draft sessions and queued prompts exist before an agent send; backend transcript state exists after it.
_Avoid_: enqueue, draft

**Project connection**:
A local attachment between a workspace and one or more project directories that OpenGUI keeps hydrated across agent backends. It is how OpenGUI knows which sessions belong under which project in the UI.
_Avoid_: mount, project binding

**Project connection registry**:
The backend-local registry that keeps exact Project connections, backend session routing, and question routing aligned for one backend window. It prevents Project-scoped operations from silently reusing a different Project connection.
_Avoid_: loose connection cache, directory fallback map

**Workspace root project**:
The primary project directory for a repository when related worktrees are present. Worktree directories expand from a Workspace root project but do not replace it.
_Avoid_: canonical path, main worktree

**Session lifecycle**:
The local orchestration for creating, renaming, deleting, reverting, unreverting, and forking sessions. It coordinates UI state and transcript refresh around backend session mutations after a session already exists or is being created.
_Avoid_: chat CRUD, transcript actions

**Session title reconciliation**:
The local orchestration that preserves a user-forced or generated session title across backend session replacement, retries persistence when needed, and keeps local naming requests aligned with the current session ID.
_Avoid_: rename patching, title fixup

**Workspace lifecycle**:
The local orchestration for creating, updating, switching, and removing workspaces, including how the active session and project connections follow those workspace changes.
_Avoid_: workspace CRUD, tabs logic

**Plugin**:
A user-facing add-on that extends an agent with additional behaviour or knowledge. In the product interface, prefer Plugin over Skill because users understand plugins as installable functionality.
_Avoid_: Skill, extension, add-on

**Installed Plugin**:
A Plugin already available to the user's agent, whether installed for the current project or globally. Installed Plugins are shown as one list; implementation sources such as filesystem or agent SDK are not navigation concepts.
_Avoid_: Filesystem skill, SDK skill, Agent SDK

**Plugin Scope**:
Where an Installed Plugin is available: either the current project or all projects for the user. When the active directory is the user's home directory, home-level `.agents/skills` entries are Global, not Project.
_Avoid_: Local, filesystem

**Published Plugin**:
An Installed Plugin with recorded source metadata from an external source. It remains Published even if the source later becomes unavailable or changes.
_Avoid_: Skill, marketplace skill

**Custom Plugin**:
An Installed Plugin without recorded external source metadata and maintained locally by the user.
_Avoid_: Local skill, filesystem skill

**Plugin Update**:
A refresh of a Published Plugin from its recorded external source. Update availability is based on source metadata and recorded hashes, not on whether the plugin appears in the catalog UI today.
_Avoid_: Marketplace reinstall

**Plugin Source of Truth**:
Installed Plugin identity, scope, and origin come from the local skills lockfiles, not from catalog search results. The catalog is for discovery, not for deciding what is installed.
_Avoid_: infer installed state from marketplace results

**Plugin Group**:
A Plugin made of multiple related capabilities installed from an explicit recorded plugin package. Grouping is based on recorded plugin metadata, not inferred from a shared source repository.
_Avoid_: show every grouped skill as an unrelated plugin, infer groups from source

**General Plugins**:
Installed Plugins without recorded plugin grouping metadata. General Plugins are shown separately from Plugin Groups.
_Avoid_: ungrouped skills

**Installed Plugins Layout**:
Installed Plugins are organized first by Plugin Scope and then by grouping. Within each scope, Plugin Groups are shown separately from General Plugins.
_Avoid_: flat installed skill list

**Cross-Scope Duplicate Plugin**:
The same Plugin installed in both Project and Global scopes. Cross-scope duplicates are shown separately because scope is part of installed identity.
_Avoid_: dedupe project and global installs

**Plugin Capability**:
An individual capability inside a Plugin Group. A standalone Plugin has exactly one capability.
_Avoid_: Skill in product UI

**Plugin Group Action**:
An action applied to every capability in a Plugin Group, such as updating or removing the group.
_Avoid_: ambiguous update button on grouped capabilities

**Capability Action**:
An action applied to one Plugin Capability inside a group.
_Avoid_: hidden per-skill operation

**Discover Plugins**:
The product area where users browse, search, and install Plugins they do not yet have. Browsing emphasizes Plugin packages or groups; searching emphasizes matching capabilities within those Plugins.
_Avoid_: Marketplace, Skills Marketplace

**Plugins Tab Default**:
The Plugins settings tab opens to Installed Plugins by default because settings is primarily for managing what is already configured.
_Avoid_: default to Discover

**Tool**:
A configured external capability exposed through MCP. Tools are managed separately from Plugins even though both can extend agent behaviour.
_Avoid_: Plugin

## Example dialogue

**Dev**: If the user picks a project but has not sent anything yet, do we already have a session?

**Domain expert**: No. That is a **Draft session**. It is local-only until an **Agent send** happens.

**Dev**: And when the agent is busy and the user types the next instruction?

**Domain expert**: That becomes a **Queued prompt**. OpenGUI owns it locally until it is sent.

**Dev**: So both drafting and queuing stay outside the backend?

**Domain expert**: Exactly. Only an **Agent send** puts anything into the agent.
