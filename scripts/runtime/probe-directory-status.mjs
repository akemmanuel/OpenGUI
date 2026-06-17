#!/usr/bin/env node
/**
 * Read-only @opengui/runtime probe: harness connection + per-session status map.
 *
 *   vp node scripts/runtime/probe-directory-status.mjs -d /path/to/repo
 */
import { MANAGED_HARNESS_IDS } from "@opengui/runtime";
import { createRuntime, logSection, parseArgs, printJson, usageLines } from "./lib.mjs";

const flags = parseArgs(process.argv);
if (flags.help) {
  console.log(
    usageLines("probe-directory-status.mjs", [
      "  --all-harnesses             Query every managed harness",
    ]).join("\n"),
  );
  process.exit(0);
}

const harnessIds = flags.allHarnesses ? [...MANAGED_HARNESS_IDS] : [flags.harness];
const { og, directory } = await createRuntime(flags);

try {
  await og.registerDirectory({ directory, harnessIds });
  const rows = [];
  for (const harnessId of harnessIds) {
    const handle = og.harness(harnessId);
    let status;
    let error;
    try {
      status = await handle.directoryStatus({ directory });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    rows.push({ harnessId, status, error });
  }

  if (flags.json) {
    printJson({ directory, rows });
    process.exit(0);
  }

  logSection(`directory status ${directory}`);
  for (const row of rows) {
    console.log(`\n${row.harnessId}:`);
    if (row.error) {
      console.log(`  error: ${row.error}`);
      continue;
    }
    const entry = row.status?.[row.harnessId];
    if (!entry) {
      console.log("  (no entry)");
      continue;
    }
    console.log(`  connected: ${entry.connected}`);
    if (entry.error) console.log(`  error: ${entry.error}`);
    const statusKeys = Object.keys(entry.statuses ?? {});
    console.log(`  session statuses: ${statusKeys.length}`);
    for (const [sid, st] of Object.entries(entry.statuses ?? {}).slice(0, 10)) {
      console.log(`    ${sid}: ${st?.type ?? "?"}`);
    }
  }
} finally {
  await og.close();
}
