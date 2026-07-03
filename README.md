<p align="center">
  <img src="opengui-dark.svg" alt="OpenGUI" width="280" />
</p>

<p align="center">
  Desktop + web command center for coding-agent harnesses.
  Run <a href="https://opencode.ai">OpenCode</a>, Claude Code, Codex, and Pi
  across multiple projects with streaming chat, prompt queue, model switching,
  voice input, and MCP tools.
</p>

<p align="center">
  <a href="https://github.com/akemmanuel/OpenGUI/releases/latest"><img src="https://img.shields.io/github/v/release/akemmanuel/OpenGUI?label=release&color=blue" alt="Latest Release" /></a>
  <a href="https://github.com/akemmanuel/OpenGUI/blob/master/LICENSE"><img src="https://img.shields.io/github/license/akemmanuel/OpenGUI" alt="License" /></a>
  <a href="https://github.com/akemmanuel/OpenGUI/stargazers"><img src="https://img.shields.io/github/stars/akemmanuel/OpenGUI?style=social" alt="Stars" /></a>
  <a href="https://github.com/akemmanuel/OpenGUI/releases"><img src="https://img.shields.io/github/downloads/akemmanuel/OpenGUI/total?color=green" alt="Downloads" /></a>
  <a href="https://github.com/akemmanuel/OpenGUI/actions"><img src="https://img.shields.io/github/actions/workflow/status/akemmanuel/OpenGUI/build.yml?branch=master" alt="Build Status" /></a>
  <a href="https://github.com/akemmanuel/OpenGUI/issues"><img src="https://img.shields.io/github/issues/akemmanuel/OpenGUI" alt="Issues" /></a>
</p>

<p align="center">
  <a href="https://github.com/akemmanuel/OpenGUI/releases/latest">Download latest release</a>
  ·
  <a href="#why-opengui">Why OpenGUI</a>
  ·
  <a href="#highlights">Highlights</a>
  ·
  <a href="#build-from-source">Build from source</a>
  ·
  <a href="#configuration">Configuration</a>
</p>

OpenGUI gives coding-agent users a proper desktop and browser workflow for
long sessions. Manage multiple projects visually, run different harnesses from
one UI, watch responses stream live, queue prompts while your agent works, and
switch models or agents without terminal juggling.

> **Early but usable.** Bug reports and PRs welcome.

---

## Quick Start

**1. Download** the [latest release](https://github.com/akemmanuel/OpenGUI/releases/latest)
(Linux `.deb`, macOS `.dmg`, or Windows `.exe`).

**2. Install** one supported harness (e.g. [OpenCode](https://opencode.ai)) on your `PATH`.

**3. Launch** OpenGUI, connect a workspace, and start prompting.

That's it. No terminal needed after setup.

---

## Screenshots

<p align="center">
  <img src="screenshot.png" alt="OpenGUI Screenshot" width="800" />
</p>

> <!-- TODO: Replace screenshot with short demo GIF showing: open project, switch backend, send prompt, stream response, queue prompt. -->
>
> Tracked in [issue #…](https://github.com/akemmanuel/OpenGUI/issues)

---

## Why OpenGUI

OpenGUI is for people who love coding agents but want a stronger workflow than
terminal tabs alone:

- **🎯 Multi-harness workspace** — run OpenCode, Claude Code, Codex, Pi, and Grok Build in one app instead of juggling separate terminals.
- **📂 Multi-project sessions** — keep separate sessions per workspace and switch instantly.
- **⚡ Stream responses live** — see tokens stream in with real-time usage tracking.
- **📥 Prompt queue** — queue prompts while your agent is busy; they auto-dispatch when idle.
- **🎛️ Switch providers/models** — change backend, model, agent, or variant from the UI.
- **🔧 MCP tools & skills** — configure tools and skills without leaving the app.
- **🎤 Voice input** — use a Whisper-compatible transcription endpoint for speech-to-text.

---

## Highlights

|        | Feature                           | Description                                  |
| ------ | --------------------------------- | -------------------------------------------- |
| 🏗️     | **Multi-agent workspace**         | OpenCode, Claude Code, Codex, Pi, Grok Build |
| 📂     | **Multi-project workspaces**      | Parallel coding sessions per project         |
| ⚡     | **Real-time streaming**           | SSE with live token & context tracking       |
| 📥     | **Prompt queue**                  | Auto-dispatch when assistant becomes idle    |
| 🎛️     | **Model/backend/agent selection** | Switch directly from chat UI                 |
| ⌨️     | **Slash commands**                | Built-in commands from the prompt box        |
| 🎨     | **Syntax highlighting**           | Powered by Shiki                             |
| 🌗     | **Dark/light theme**              | System-aware toggle                          |
| 🖥️🌐📱 | **Desktop, web & Docker**         | Electron, browser, or container deployment   |
| 🐧🍎🪟 | **Cross-platform builds**         | Linux, macOS, Windows                        |

---

## Supported Harnesses

| Harness                                                                | OpenGUI Support |
| ---------------------------------------------------------------------- | --------------- |
| [OpenCode](https://opencode.ai)                                        | ✅ Full         |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) | ✅ Full         |
| [Codex](https://codex.ai)                                              | ✅ Full         |
| [Pi](https://pi.ai)                                                    | ✅ Full         |
| [Grok Build](https://x.ai/cli)                                         | ✅ Full         |

Use one backend or switch between them per workflow.

---

## Download

Grab a prebuilt app from the [latest release](https://github.com/akemmanuel/OpenGUI/releases/latest):

| Platform   | Format           | Notes                     |
| ---------- | ---------------- | ------------------------- |
| 🐧 Linux   | `.deb`           | Debian/Ubuntu-based       |
| 🍎 macOS   | `.dmg`           | Intel & Apple Silicon     |
| 🪟 Windows | `.exe` installer | Unsigned — see note below |

> **Windows note:** Windows builds are unsigned. SmartScreen will warn on first launch.
> Click **More info → Run anyway**.

### Requirements

Backend requirements depend on what you use:

- **OpenCode harness** — [OpenCode CLI](https://opencode.ai) installed and on `PATH`
- **Grok Build harness** — [Grok Build CLI](https://x.ai/cli) installed (`grok` on `PATH`) and authenticated (`grok login` or `XAI_API_KEY`)
- **Other harnesses** — local CLI and auth for that harness on your machine

> **Windows prerequisite for OpenCode:** OpenCode must be on `PATH` or at
> `%USERPROFILE%\.opencode\bin\opencode.exe`.

---

## Build from source

### Prerequisites

- [Node.js](https://nodejs.org/) **24+**
- [pnpm](https://pnpm.io/) **11+**
- At least one supported harness configured locally (e.g. OpenCode CLI on `PATH`)

OpenGUI uses **Vite+** ([vite-plus](https://github.com/mariozechner/vite-plus)) as
a dev dependency. After `pnpm install`, run it as `pnpm vp <command>`.
No global installs needed — Electron and other deps come from `pnpm install`.

```bash
pnpm install
```

### Tooling (Vite+)

Lint, format, typecheck, test, build, and named tasks use Vite+ (`vp`).
Prefer `pnpm vp …` or `pnpm run <script>` when a script exists in `package.json`.
A global `vp` on your `PATH` is optional, not required.

No manual config file needed. Connection settings live in the UI.

### Development

| Goal                               | Command            |
| ---------------------------------- | ------------------ |
| Desktop app (Electron, hot reload) | `pnpm run dev`     |
| Web UI (browser + API)             | `pnpm run dev:web` |

For web dev, open the URL Vite prints in the terminal (default port is often 5173).
Browser folder picker uses server paths. To restrict browsable folders:

```bash
export OPENGUI_ALLOWED_ROOTS=/path/to/projects
```

### Production

Build the frontend bundle first, then start:

```bash
pnpm run build        # or: pnpm vp build
pnpm run start        # Electron
pnpm run start:web    # browser + backend API
```

For internet-facing deploys, keep OpenGUI bound to `localhost` and put
Apache or another HTTPS reverse proxy in front.

### Docker

Official image: `ghcr.io/akemmanuel/opengui:latest`

Docker supports **contained mode** and **host-control mode** (uses host CLIs
through `nsenter` while Docker manages the web server).

See [docs/docker.md](docs/docker.md) for details and
[docs/apache.md](docs/apache.md) for Apache reverse proxy + Basic Auth.

### Distribution builds

| Platform          | Command               |
| ----------------- | --------------------- |
| 🐧 Linux `.deb`   | `pnpm run dist:linux` |
| 🍎 macOS `.dmg`   | `pnpm run dist:mac`   |
| 🪟 Windows `.exe` | `pnpm run dist:win`   |

---

## Architecture

Four layers. See [`CONTEXT.md`](CONTEXT.md) and
[ADR 0005](docs/adr/0005-opengui-runtime-backend-split-and-sdk.md) for details.

```
┌─────────────────────────────────────────────────┐
│                   Shell                          │
│  Desktop (Electron) · Web · Mobile (Capacitor)  │
├─────────────────────────────────────────────────┤
│               OpenGUI Frontend                   │
│  React UI · Workspaces · Projects · Chat · Queue │
├─────────────────────────────────────────────────┤
│               OpenGUI Backend                    │
│  HTTP/SSE · Queue dispatch · Auth · Persistence  │
├─────────────────────────────────────────────────┤
│               OpenGUI Runtime                    │
│  Harness Adapters · Event normalization · SDK    │
├─────────────────────────────────────────────────┤
│    OpenCode · Claude Code · Codex · Pi · Grok    │
└─────────────────────────────────────────────────┘
```

Key source layout:

| Path                              | Role                                                 |
| --------------------------------- | ---------------------------------------------------- |
| `main.ts`                         | Desktop Shell (window, IPC, backend sidecar)         |
| `preload.js`                      | Desktop Shell preload API                            |
| `packages/runtime/src/adapters/*` | Harness Adapters (hosted inside Backend via Runtime) |
| `packages/backend/src/`           | Backend host (SSE, RPC, FS, product API)             |
| `server/web-server.ts`            | Thin HTTP listen entry (calls `createBackendHost`)   |
| `src/`                            | Frontend React app                                   |

See [docs/architecture.md](docs/architecture.md) for contributor architecture
notes and the harness addition guide.

---

## Configuration

OpenGUI stores connection and UI preferences via the app settings interface.

**Voice input** (speech-to-text) requires a Whisper-compatible transcription
server. Set the endpoint URL in **Settings → General → Voice transcription endpoint**.
The microphone button only appears when an endpoint is configured.
The server should accept a multipart `POST` with an `audio` file field and return
`{ text, language, duration_seconds }`.

---

## SDK (`@opengui/runtime`)

Embed the same in-process harness runtime the app uses — list sessions, stream
events, and send prompts on a filesystem **directory** without HTTP or React.

Quickstart and API contracts: [`packages/runtime/README.md`](packages/runtime/README.md)

```bash
pnpm run test:runtime   # SDK unit tests
pnpm run test:bridges   # Bridge mapping tests
```

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- 🐛 Found a bug? [Open an issue](https://github.com/akemmanuel/OpenGUI/issues)
- 💡 Have an idea? Start a [discussion](https://github.com/akemmanuel/OpenGUI/discussions)
- 🔀 Want to contribute? Open a PR

---

## Star History

If you find OpenGUI useful, please give it a star on GitHub — it helps others
discover the project.

<a href="https://github.com/akemmanuel/OpenGUI/stargazers">
  <img src="https://api.star-history.com/svg?repos=akemmanuel/OpenGUI&type=Date" alt="Star History Chart" width="600" />
</a>

---

## License

MIT — see [LICENSE](LICENSE) for details.
