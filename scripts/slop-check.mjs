import { spawnSync } from "node:child_process";

const checks = [
  {
    name: "no legacy Runtime package",
    command: ["find", "packages/runtime", "-type", "f"],
  },
  {
    name: "no external coding-agent dependencies",
    pattern:
      "@earendil-works/pi|@opencode-ai/sdk|@openai/codex-sdk|claude-agent-sdk-lite|pi-daemon-server",
    paths: ["package.json", "packages", "src", "server", "main.ts", "vite.electron.config.ts"],
  },
  {
    name: "no bridge registration or project-slot product code",
    pattern: "BRIDGE_SETUP_BY_HARNESS_ID|harness-bridge-registrations|bridge-project-slot",
    paths: ["packages", "src", "server", "main.ts"],
  },
  {
    name: "no external Session identity fields in active product code",
    pattern: "HarnessId|OpenGuiClient|_harnessId|_backendId|_rawId",
    paths: ["src/App.tsx", "src/components", "src/features/host-provider", "src/protocol/host-"],
  },
  {
    name: "no removed product controls in active frontend code",
    pattern: "worktree|Mcp|MCP|externalHarness|restartHarnesses|getHarnessInventories",
    paths: ["src/App.tsx", "src/components", "src/features", "src/hooks", "src/protocol"],
  },
];

let failed = false;
for (const check of checks) {
  let output = "";
  if (check.command) {
    const result = spawnSync(check.command[0], check.command.slice(1), {
      encoding: "utf8",
    });
    output = result.status === 0 ? result.stdout.trim() : "";
  } else {
    const result = spawnSync(
      "rg",
      ["-n", check.pattern, ...check.paths, "--glob", "*.{ts,tsx,mjs,json}"],
      { encoding: "utf8" },
    );
    output = result.status === 0 ? result.stdout.trim() : "";
  }
  if (output) {
    failed = true;
    console.error(`not ok: ${check.name}\n${output}`);
  } else {
    console.info(`ok: ${check.name}`);
  }
}

if (failed) process.exit(1);
