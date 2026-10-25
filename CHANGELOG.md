# Changelog

## 0.7.4

### Security

- Image previews on token-authenticated Hosts, including hosted web, send the Host credential
  only to the Host's own origin. Before this fix, an image mention pointing at another origin
  could send the viewer's session token there. Hosts running 0.7.2 or 0.7.3 should update.
- Image previews loaded with the Host credential are shown only for raster image types. SVG
  and other content no longer becomes a blob URL with the app's origin.
- `/api/fs/file` refuses files larger than 25 MB instead of reading them into memory.

### Chat

- Opening a chat no longer waits forever: Session loads time out after 15 seconds, and a failed
  load shows an error with a retry button instead of a spinner.
- Returning to a chat while another one is still loading shows its transcript again instead
  of an empty view.

### Files

- `@` file suggestions skip `.astro`, `.opengui-qa`, and `.opengui-worktrees`, so generated
  copies no longer push real Project files out of the results or slow the search down.
  `.opengui-uploads/` remains searchable.

## 0.7.3

### ChatGPT tools

- Codex models connected through a ChatGPT subscription can now search the web, open results,
  and find text within pages. Searches retain references within each Session and show source
  links in the transcript.
- Generate images with Codex models, including transparent backgrounds and edits using up to
  five reference images from the Project. Generated images are saved in `.opengui-images/`,
  kept out of version control, and previewed below the tool call.
- Admins can control web search (live, cached, or off) and image generation in
  Settings → Integrations. Shared offerings can use the Host's ChatGPT subscription only when
  explicitly enabled; this option is off by default.
- Tool calls refresh expired credentials once and report clear errors for authentication,
  permissions, usage limits, and temporary service failures. Reference images respect Host
  path permissions.

## 0.7.2

### Images and uploads

- Show previews for Host image files referenced in assistant replies, including Project-relative,
  absolute, Windows, and file URL paths. Click a preview to open the image viewer. Remote image
  URLs remain blocked, and inaccessible files show an unavailable placeholder.
- Fix Desktop Local transcript image previews by using the backend sidecar's actual address.
  Token-authenticated Remote Host previews now load with the appropriate Host credentials.
- Keep uploads associated with a Project in its `.opengui-uploads/` directory, including on
  Desktop Local, so they survive temporary-directory cleanup. A local `.gitignore` keeps them
  out of version control.
- File responses now include content security headers and refresh images overwritten in place.

### Providers

- Custom backends can declare supported reasoning levels in Settings. The composer offers the
  selected levels using the existing model capability configuration.

### Operations

- Add `scripts/backup-databases.ts` for verified SQLite snapshots from inside the Host's
  container or sandbox. Snapshots are self-contained files with restricted permissions.
- Correct backup guidance for sandboxed Hosts: opening live databases from outside the sandbox,
  even for read-only queries, can destroy live WAL state. Run the backup command inside the
  container and copy the closed snapshots instead.

## 0.7.1

### Chat and sidebar

- Navigate long conversations with a prompt rail, prompt previews, and keyboard shortcuts:
  `Alt+Up` / `Alt+Down` move between prompts and `Alt+End` jumps to the latest message.
- A scroll-to-end button shows when you are reading earlier messages and highlights new output
  without pulling you away from your place.
- Fully hide the sidebar or drag its edge to resize it. The width is remembered; double-click
  the resize handle to reset it. Keyboard resizing is also supported.
- Completed turns stop their thinking and response timers reliably, even when delayed Session
  reads or stream reconnects arrive after completion. Reconnecting also repairs missed events.

### Preferences

- Appearance, language, and chat preferences are grouped in Settings, with the chat sidebar
  still available while Settings is open.
- Open quick preferences beside the Settings button to change theme, accent, font size,
  contrast, chat width, and language.
- Adjust chat width continuously from 40% to 100%; the transcript and prompt share the setting,
  and existing width preferences carry over.
- Updated English, German, and Spanish translations for the new controls.

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
- The desktop app's backend now exits with the app, even after a crash or force quit, and a
  backend left running by an earlier version is stopped on the next launch instead of blocking
  it with "Backend sidecar exited before becoming healthy". A state lock left behind by a crash
  is recovered even when its old process ID now belongs to another program, which blocked
  macOS upgrades from 0.6.x. If the backend still fails to start, the error now says why.
- Fixed a crash of the whole Host when an OpenAI WebSocket connection timed out.
- Prompts queued for the same Session are always admitted in the order they arrived.
- `/api/health` reports low disk space, and the app warns when the Host is almost full.

### Providers

- Connect any provider pi supports, not just ChatGPT, xAI and OpenCode: Anthropic, OpenAI,
  Google Gemini and Vertex, Amazon Bedrock, Azure OpenAI, Mistral, OpenRouter, GitHub Copilot,
  Groq, Cerebras, DeepSeek, Fireworks, Together, Hugging Face, Moonshot, Z.AI, MiniMax, Vercel
  and Cloudflare gateways, and more. Settings lists them all with search; each offers its own
  API-key or subscription sign-in, including device codes, browser sign-in with a pasted code,
  and the extra values some providers ask for.
- Members connect their own providers under the existing BYOK/BYOS policy and can always remove
  their own credentials. Personal credentials never pick up the Host's environment variables.
- Existing ChatGPT, SuperGrok, xAI API, OpenCode Zen and OpenCode Go connections move over
  automatically, and Sessions that used them keep working. SuperGrok and the xAI API key are now
  one xAI connection (the API key wins if both were set).
- OpenCode Zen without a key no longer impersonates the OpenCode CLI or sends the CLI's public
  key. OpenCode currently rejects such requests (`FreeTierError`); add a Zen API key to use it.

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
- "Send now" on a queued message no longer hides the start of the new reply while it streams.
- Offerings keep the upstream model's reasoning capabilities.

### Housekeeping

- Removed the Android app. It only wrapped the web app, which works in mobile browsers, so
  phones should use the Web app instead. Releases no longer include an APK.
- German and Spanish translations load on demand, cutting the initial download by about 110 KB.
- Fresh Hosts no longer log a false "Database schema mismatch" error on first start.
- Updated all dependencies to their latest releases, including pi-ai 1.2 (more provider errors
  retried upstream, Codex header overrides now built in, so the local patch is gone), Effect 4,
  Electron 44.7, Vite+ 1.2, Better Auth 1.7.7 and happy-dom 21. This also clears the
  `source-map-js` security advisory and 22 advisories in packages used to build the desktop
  installers.
- Server-side retries, timeouts, cancellation, locks and shutdown now run on Effect 4
  (ADR 0016). Shutdown also closes the accounts database, which it previously left open.
- Removed design prototypes, unused dependencies (`@tanstack/react-virtual`, `next-themes`,
  `@capacitor/assets`, `@effect/vitest`), dead helpers and storage keys, about 170 unused
  translations, outdated screenshots, the stale Biome config, and outdated bridge-era docs.
- Fixed plural messages ("3 messages reverted"), and a setup wizard hint and a model
  backend placeholder that showed raw translation keys.

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
