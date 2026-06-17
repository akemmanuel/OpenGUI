# Runtime read-only probes

Scripts exercise **`@opengui/runtime`** without **prompts**, **abort**, or **session create**. Use them to verify harness CLIs, directory registration, sessions, models/agents/commands, status maps, and transcripts.

Run from repo root with Vite+:

```bash
vp node scripts/runtime/probe-inventories.mjs
vp node scripts/runtime/probe-sessions.mjs -d .
vp node scripts/runtime/probe-resources.mjs -d . -H pi
vp node scripts/runtime/probe-directory-status.mjs -d .
vp node scripts/runtime/probe-messages.mjs -d . -H pi --limit 10
vp node scripts/runtime/probe-all-readonly.mjs -d .
```

### Environment

| Variable                    | Purpose                     |
| --------------------------- | --------------------------- |
| `OPENGUI_RUNTIME_DIRECTORY` | Default `-d` path           |
| `OPENGUI_RUNTIME_HARNESS`   | Default harness (`pi`)      |
| `OPENGUI_RUNTIME_DATA_DIR`  | Persistent runtime data dir |

### npm scripts

```bash
pnpm run runtime:probe:inventories
pnpm run runtime:probe:sessions -- -d /path/to/repo
pnpm run runtime:probe:all -- -d .
```

Add `--json` on any probe for machine-readable output.

### Cost note

These calls may still start harness daemons or hit local CLIs (e.g. Pi, OpenCode). They do **not** send user prompts to agents.
