#!/usr/bin/env node
/**
 * Read-only @opengui/runtime probe: register directory + list sessions per harness.
 *
 *   vp node scripts/runtime/probe-sessions.mjs -d /path/to/repo
 *   vp node scripts/runtime/probe-sessions.mjs -d . --all-harnesses
 */
import { MANAGED_HARNESS_IDS } from "@opengui/runtime";
import { createRuntime, logSection, parseArgs, printJson, usageLines } from "./lib.mjs";

const flags = parseArgs(process.argv);
if (flags.help) {
  console.log(
    usageLines("probe-sessions.mjs", [
      "  --all-harnesses             Try every managed harness",
    ]).join("\n"),
  );
  process.exit(0);
}

const harnessIds = flags.allHarnesses ? [...MANAGED_HARNESS_IDS] : [flags.harness];
const { og, directory } = await createRuntime(flags);
const dir = await og.at(directory);

try {
  logSection(`directory ${directory}`);
  const register = await og.registerDirectory({ directory, harnessIds });
  if (!flags.json) {
    console.log("registerDirectory:", register);
  }

  const results = [];
  for (const harnessId of harnessIds) {
    const handle = dir.harness(harnessId);
    let sessions = [];
    let error;
    try {
      sessions = await handle.sessions.list({ directory });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    results.push({ harnessId, sessionCount: sessions.length, sessions, error });
  }

  if (flags.json) {
    printJson({ directory, register, results });
    process.exit(0);
  }

  for (const row of results) {
    logSection(`${row.harnessId} sessions (${row.sessionCount})`);
    if (row.error) console.log(`error: ${row.error}`);
    for (const s of row.sessions.slice(0, 15)) {
      console.log(`  - ${s.id}  status=${s.status ?? "?"}  title=${JSON.stringify(s.title ?? "")}`);
    }
    if (row.sessions.length > 15) console.log(`  … +${row.sessions.length - 15} more`);
  }
} finally {
  await og.close();
}
