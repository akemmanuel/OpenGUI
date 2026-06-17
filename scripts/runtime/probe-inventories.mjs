#!/usr/bin/env node
/**
 * Read-only @opengui/runtime probe: harness CLI inventories (models, auth, diagnostics).
 *
 *   vp node scripts/runtime/probe-inventories.mjs
 *   vp node scripts/runtime/probe-inventories.mjs --json
 */
import { createRuntime, parseArgs, printJson, usageLines } from "./lib.mjs";

const flags = parseArgs(process.argv);
if (flags.help) {
  console.log(usageLines("probe-inventories.mjs").join("\n"));
  process.exit(0);
}

const { og } = await createRuntime(flags);
try {
  const inventories = og.getHarnessInventories();
  if (flags.json) {
    printJson(inventories);
    process.exit(0);
  }
  console.log(`Harness inventories (${inventories.length} managed)`);
  for (const row of inventories) {
    const modelIds = (row.models ?? []).map((m) => m.id ?? m.modelID ?? m.name).filter(Boolean);
    console.log(`\n• ${row.harnessId}  status=${row.status}  auth=${row.auth?.status ?? "?"}`);
    if (row.message) console.log(`  message: ${row.message}`);
    if (row.diagnostics?.cli?.resolvedPath) {
      console.log(`  cli: ${row.diagnostics.cli.resolvedPath}`);
    }
    console.log(
      `  models (${modelIds.length}): ${modelIds.slice(0, 8).join(", ")}${modelIds.length > 8 ? "…" : ""}`,
    );
    const agents = (row.agents ?? []).map((a) => a.id ?? a.name).filter(Boolean);
    if (agents.length) console.log(`  agents: ${agents.join(", ")}`);
  }
} finally {
  await og.close();
}
