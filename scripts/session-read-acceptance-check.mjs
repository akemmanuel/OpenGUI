#!/usr/bin/env node
/**
 * Automated companion for docs/manual/session-read-acceptance.md (ADR 0006).
 * Covers backend list/query errors, harness-only mapping, and client message errors.
 * Full UI steps (sidebar, harness offline) still require manual checklist before release.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const testFiles = [
  "src/adr-0006-session-read-acceptance.test.ts",
  "src/server-session-resolve.test.ts",
  "src/server-session-harness-list.test.ts",
  "src/server-session-query.test.ts",
  "src/protocol/http-client.test.ts",
  "src/hooks/agent-message-loading.test.ts",
  "src/hooks/session-query-errors.test.ts",
  "src/hooks/agent-session-index-merge.test.ts",
  "packages/runtime/src/adapters/__tests__/harness-adapter-kit.test.ts",
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
ok = run("session-read acceptance tests", ["test", ...testFiles]) && ok;
ok = run("slop-check", ["run", "slop-check"]) && ok;

if (!ok) {
  console.error(
    "\nsession-read acceptance check FAILED — see docs/manual/session-read-acceptance.md",
  );
  process.exit(1);
}

console.log(
  "\nsession-read acceptance check PASSED (automated). Run manual steps in docs/manual/session-read-acceptance.md before release.",
);
