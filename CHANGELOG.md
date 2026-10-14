# Changelog

## 0.7.0

OpenGUI 0.7.0 brings the release in line with what has been running on managed Hosts, and
focuses on reliability: long chats, flaky providers, restricted shells, and account recovery.

### Reliability

- Automatically retry temporary model provider failures (overloaded, connection drops, generic
  "please retry" errors) up to three times with backoff, before any output is shown, and show
  the retry in the chat. Context compaction retries the same way instead of pausing the Session.
  Attempts that already took a minute or longer fail right away instead of retrying, so a
  hanging provider no longer holds a run for half an hour.
- Clearer failed-run messages: usage limits show when the model is available again and suggest
  switching models; outages and expired credentials explain what to do next.
- Compaction handoffs no longer need project filesystem access, so restricted Accounts can
  compact; failed compactions are labelled correctly and pause until you compact again, now
  with a "Compact now" button on the error.
- The Host shuts down gracefully on `SIGTERM`: active runs are stopped cleanly and the durable
  state lock is released, so restarts no longer leave a stale lock behind. Locks left by an
  earlier run of the same container are recovered automatically, and so are locks left by a
  recreated container (including 0.6.x) once their holder has been gone for a minute. The
  shipped compose files allow 15 s for a stop.
- A Host that fails to start now logs the reason and exits, so Docker restarts it, instead of
  staying up and answering every request with an error.
- Fixed a crash of the whole Host when an OpenAI WebSocket connection timed out.
- Prompts queued for the same Session are always admitted in the order they arrived.
- `/api/health` reports low disk space, and the app warns when the Host is almost full.

### Accounts

- Admins can now reset passwords for members and viewers; only the owner resets admins.
- Locked-out owners can be recovered from the Host shell with `scripts/reset-password.ts`.
- Optional owner-configured mail confirms contact email changes.

### Sandboxed shells and previews

- Production shell broker: 16 bounded parallel commands, a pre-execution "busy" response that
  the Host retries briefly, output tail and request limits, cleanup of exactly the cancelled
  container, optional cgroup slice, and a 900 s command cap.
- Shell image with Chromium and Playwright (`docker/sandbox/Shell.Dockerfile`), isolated
  development previews (`docker/sandbox/preview-compose.yml`), and an Astro preview runner.
- Shell image lifecycle tooling (`scripts/sandbox-shell-lifecycle.ts`): keeper-based retention,
  label-scoped cleanup, restricted-grant probes, restore verification, and alerts.
- Broker faults are classified (unreachable, timeout, unauthorized, busy, rejected) instead of
  surfacing as generic tool errors; the preflight checks the configured shell image.

### Profile and settings

- A profile panel replaces the profile menu: open it from your avatar at the bottom of the
  sidebar to change appearance, language and personal instructions, sign out, or open
  **Manage account** for your name, email and password.
- Settings are grouped into Agent, Host and This computer, with Desktop options in their own
  section.
- Connecting an MCP server takes one paste: an `https://` address or a start command such as
  `npx …` or `uvx …` from the server's setup guide. OpenGUI fills in the name, arguments and
  environment, and asks you to confirm that you trust commands that run on the Host.

### Chat

- Sticky date and time while scrolling through a conversation.
- Fixed file uploads to Remote Hosts failing with 401.
- Offerings keep the upstream model's reasoning capabilities.

### Housekeeping

- German and Spanish translations load on demand, cutting the initial download by about 110 KB.
- Fresh Hosts no longer log a false "Database schema mismatch" error on first start.
- Updated all dependencies to their latest releases, including pi-ai 1.2 (more provider errors
  retried upstream, Codex header overrides now built in, so the local patch is gone), Effect 4,
  Electron 44.7, Vite+ 1.1, Better Auth 1.7.7 and happy-dom 21. This also clears the
  `source-map-js` security advisory.
- Server-side retries, timeouts, cancellation, locks and shutdown now run on Effect 4
  (ADR 0016). Shutdown also closes the accounts database, which it previously left open.
- Removed design prototypes, unused dependencies (`@tanstack/react-virtual`, `next-themes`),
  dead helpers, the stale Biome config, and outdated bridge-era docs.

## 0.6.3

- Added scoped custom instructions with host, personal, and per-project scopes plus team-based project editors.
- Added profile menu with account switching in the sidebar footer.
- Added OpenCode request headers support and upgraded pi-ai to 0.99.1 with refreshed model catalogs.
- Refreshed dependencies including Vite Plus 1.0, Electron 44, React 19.3, and Vitest 5.

## 0.6.2

- Routed codex and opencode built-ins through pi-ai catalog metadata with OpenCode Zen support.
- Added responding sidebar sections with enable/disable setting.
- Added named Teams with per-person access summaries and a model access editor.
- Centralized the model catalog and provider catalogs with canonical capabilities.

## 0.6.1

- Added multi-select actions for moving and deleting Sessions from the sidebar.
- Added Host-wide custom instructions that are applied to every new model turn.
- Fixed model switching so canonical reasoning efforts and durable Session state stay in sync.
- Improved Harness recovery from provider failures, tool failures, unresponsive tools, and background shell processes.
- Restored moving Sessions between Projects and made queued follow-up removal idempotent.

## 0.6.0

OpenGUI 0.6.0 introduces the first-party Host and Harness, durable Host-owned Sessions, multi-user
Remote Hosts, model and provider management, and Host-owned MCP connections. It also adds guided
Remote Host authentication during workspace setup and clearer device authorization flows for
subscription providers.

### Highlights

- First-party Harness with durable Host-owned Sessions, automatic context compaction, Agent
  Skills, image input/tool support, and the built-in `read`, `write`, `edit`, and `shell` tools.
- Multi-user Remote Hosts with Accounts, invites, roles, explicit path/model/Session grants,
  Host API keys, private Sessions by default, and authentication integrated into workspace setup.
- Model backends and member-facing model offerings with Host/Team/User ownership planes, plus
  improved OAuth device authorization, cancellation, retry, and recovery flows.
- Host-owned MCP stdio and Streamable HTTP connections, bounded discovery, connection health,
  last-known-good catalogs, and recoverable tool failures.
- Refined sidebar Project/Session hierarchy and transcript, model, provider, and settings work.
- Fixed packaged Desktop Host startup by ensuring Photon’s WebAssembly runtime is unpacked beside
  `dist-electron/backend.js`.

### Breaking migration note

Sessions created by the old external-Harness architecture are **not imported** into the new
first-party Harness database. OpenGUI does not delete or modify the external Harness source files,
but those Sessions do not appear in the new sidebar. Back up any old application data that must be
retained; there is no supported automatic importer.

The exported MCP broker contract changed in 0.6: consumers must call `refresh(scope)` before
expecting `catalog(scope)` to contain tools, and catalog diagnostics are scoped to the actor and
Session.

Remote Host operators should back up the Host data directory before upgrading. macOS artifacts
are unsigned unless release signing is configured, and Android uses the repository's temporary
debug signing configuration.

## 0.6.0-rc.2 — release candidate

- Fixed Linux and other packaged Desktop builds failing to start the Host sidecar because Photon’s
  WebAssembly runtime was not unpacked beside `dist-electron/backend.js`.

## 0.6.0-rc.1 — release candidate

This candidate replaces the external coding-agent integration architecture with the first-party
OpenGUI Host and Harness. It is a minor release because it adds substantial product capabilities
and changes Session persistence; it is not yet the stable 0.6.0 release.

### Highlights

- First-party Harness with durable Host-owned Sessions, automatic context compaction, Agent
  Skills, image input/tool support, and the built-in `read`, `write`, `edit`, and `shell` tools.
- Multi-user Remote Hosts with Accounts, invites, roles, explicit path/model/Session grants,
  Host API keys, and private Sessions by default.
- Model backends and member-facing model offerings with Host/Team/User ownership planes.
- Host-owned MCP stdio and Streamable HTTP connections, bounded discovery, connection health,
  last-known-good catalogs, and recoverable tool failures.
- Refined sidebar Project/Session hierarchy and transcript, model, provider, and settings work.

### Breaking migration note

Sessions created by the old external-Harness architecture are **not imported** into the new
first-party Harness database. OpenGUI does not delete or modify the external Harness source files,
but those Sessions do not appear in the new sidebar. Treat the old application data as a separate
backup if it must be retained. There is no supported automatic importer in this candidate.

The exported MCP broker contract is also new for 0.6: consumers must call `refresh(scope)` before
expecting `catalog(scope)` to contain tools, and catalog diagnostics are scoped to the actor and
Session. This is an intentional prerelease API boundary rather than a 0.5-compatible adapter.

Remote Host operators should back up the Host data directory before upgrading and test the
candidate against a copy. Desktop, Web/Docker, and Android packaging still require platform smoke
testing; macOS artifacts are unsigned unless release signing is configured, and the Android
candidate currently uses the repository's temporary debug signing configuration.
