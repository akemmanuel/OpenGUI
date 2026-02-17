# OpenGUI

A graphical desktop interface for [OpenCode](https://opencode.ai) - the open-source AI coding assistant.

OpenGUI wraps the OpenCode server in an Electron shell with a React frontend, giving you a native desktop experience for managing AI-assisted coding sessions across multiple projects.

> This was a weekend project, vibecoded in 4 days with the $200 Claude Pro plan and the $20 OpenAI Plus plan. Expect some bugs and rough edges. Feel free to open PRs - contributions and bug reports are welcome.

## Features

- **Multi-project support** - connect multiple project directories simultaneously, each with its own sessions
- **Real-time streaming** - watch assistant responses stream in via SSE with live token/context usage tracking
- **Model & agent selection** - switch between providers, models, agents, and model variants on the fly
- **Slash commands** - invoke OpenCode commands directly from the prompt box
- **Voice input** - speech-to-text transcription via configurable STT endpoint
- **Prompt queue** - queue messages while the assistant is busy; they auto-dispatch when idle
- **MCP tools & skills** - manage MCP servers and skills from the UI
- **Syntax highlighting** - code blocks rendered with shiki, theme-aware
- **Math rendering** - LaTeX/KaTeX support in assistant responses
- **Dark/light theme** - system-aware with manual toggle
- **Cross-platform** - builds for Linux (.deb) and macOS (.dmg)

## Prerequisites

- [Bun](https://bun.sh) v1.2+
- [OpenCode CLI](https://opencode.ai) installed and available in your PATH
- [Electron](https://www.electronjs.org/) (installed as a dev dependency)

## Getting Started

Install dependencies:

```bash
bun install
```

No manual config file is required. Connection settings are managed in the UI.

### Development

Run the web frontend + Electron in development mode (with HMR):

```bash
bun run dev
```

Or run just the web frontend (no Electron):

```bash
bun run dev:web
```

### Production

Build the frontend bundle:

```bash
bun run build
```

Run the Electron app in production mode:

```bash
bun run start:electron
```

### Distribution

Build a `.deb` package (Linux):

```bash
bun run dist
```

Build a `.dmg` installer (macOS):

```bash
bun run dist:mac
```

## Architecture

```
main.cjs            Electron main process (window management, IPC)
preload.cjs         Preload script (contextBridge API for renderer)
opencode-bridge.mjs IPC bridge to the OpenCode SDK (SSE, sessions, prompts)
src/
  index.ts          Bun web server (development + production)
  index.html        HTML entry point
  frontend.tsx      React entry point
  App.tsx           Main app layout
  hooks/
    use-opencode.tsx  Central state management (context + reducer)
    useSTT.ts         Speech-to-text hook
  components/       UI components (sidebar, messages, prompt box, etc.)
  lib/              Utility modules
  types/            TypeScript type definitions
```

## Configuration

OpenGUI stores connection and UI preferences via the app settings interface.

Voice input (speech-to-text) requires a Whisper-compatible transcription server. Set the endpoint URL in **Settings > General > Voice transcription endpoint**. The microphone button only appears when an endpoint is configured. The server should accept a multipart `POST` with an `audio` file field and return `{ text, language, duration_seconds }`.

## License

MIT
