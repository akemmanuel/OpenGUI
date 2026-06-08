# Persistent Desktop Backend uses private IPC, not localhost HTTP

## Status

accepted

## Context

Desktop currently starts a managed OpenGUI Backend sidecar on a random localhost HTTP port and exposes that URL to the renderer. When startup health checks fail, repeated app launches can create multiple `opengui` processes that are hard for users to understand or kill. Loopback HTTP also creates avoidable auth-token, firewall, antivirus, and random-port lifecycle complexity for Desktop's built-in Local Workspace.

The Desktop Backend should be able to remain running after Desktop Shell windows close so long-running Sessions, Queued prompts, and Harness work can continue. Persistence is intentional, but unmanaged duplicate ghost processes are not.

## Decision

Desktop's built-in Local Workspace will use a Persistent Desktop Backend reached through a private Desktop IPC Backend Transport instead of a localhost HTTP listener.

The backend remains a separate process from Electron main. Later Desktop Shell launches discover and reuse the existing user-session-local backend through a deterministic private IPC endpoint, such as a Windows named pipe or Unix domain socket. A small metadata/lock file may be used for diagnostics, startup arbitration, PID tracking, and stale-process cleanup, but localhost random ports are not the Desktop Local Workspace transport.

HTTP remains available for Web, Mobile, Additional Workspaces, remote OpenGUI Backends, and standalone backend deployments.

## Considered Options

- **Random localhost HTTP sidecar**: simple and shared with web code, but causes duplicate sidecars, random-port health failures, user-visible backend URLs, token plumbing, and Windows/macOS firewall or antivirus suspicion.
- **Backend inside Electron main**: removes process discovery, but risks freezing the Desktop Shell if backend work or Harness orchestration hangs.
- **OS service / LaunchAgent**: robust persistence, but adds installer and platform-service complexity too early.
- **Separate backend process over private IPC**: preserves isolation and persistence while avoiding localhost port lifecycle problems.

## Consequences

- Desktop needs an `OpenGuiClient` transport backed by Electron IPC/private backend IPC, separate from the HTTP client used by Web/Mobile/remote workspaces.
- Startup must enforce at most one Persistent Desktop Backend per OS user/session and must reuse healthy existing backends.
- Stale or unhealthy Persistent Desktop Backends must be explicitly stopped or replaced by killing the backend process tree, not by spawning another unmanaged backend.
- The renderer should no longer display localhost backend URLs for Desktop's Local Workspace.
