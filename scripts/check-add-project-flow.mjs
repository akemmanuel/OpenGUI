#!/usr/bin/env node
/**
 * Verifies add-project + sidebar listing behavior (default-chat promotion scenario).
 * Exit 0 when all checks pass; exit 1 otherwise.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const testFiles = [
  "src/hooks/agent-chat-project-pipeline.test.ts",
  "src/hooks/agent-project-flow.test.ts",
  "src/lib/sidebar-project-entries.test.ts",
  "src/hooks/agent-project-connection.test.ts",
  "src/hooks/agent-reducer.test.ts",
  "src/components/sidebar/use-sidebar-model.test.ts",
];

function run(label, args) {
  const result = spawnSync("vp", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    console.error(`FAIL: ${label}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return false;
  }
  console.log(`ok: ${label}`);
  return true;
}

let ok = true;
ok = run("add-project flow tests", ["test", ...testFiles]) && ok;
ok = run("typecheck/lint (vp check)", ["check"]) && ok;

if (!ok) {
  console.error(
    "\nadd-project flow check FAILED — fix and re-run: pnpm run check:add-project-flow",
  );
  process.exit(1);
}

console.log("\nadd-project flow check PASSED");
