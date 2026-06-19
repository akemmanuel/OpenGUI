#!/usr/bin/env node
/**
 * Read-only @opengui/runtime probe: providers, models, agents, commands for a directory.
 *
 *   vp node scripts/runtime/probe-resources.mjs -d /path/to/repo -H pi
 */
import {
  createRuntime,
  logSection,
  parseArgs,
  printJson,
  summarizeResources,
  usageLines,
} from "./lib.mjs";

const flags = parseArgs(process.argv);
if (flags.help) {
  console.log(usageLines("probe-resources.mjs").join("\n"));
  process.exit(0);
}

const { og, directory } = await createRuntime(flags);
const dir = await og.at(directory);
const handle = dir.harness(flags.harness);

try {
  await og.registerDirectory({ directory, harnessIds: [flags.harness] });
  const bundle = await handle.loadResources({ directory });
  const summary = summarizeResources(bundle);

  if (flags.json) {
    printJson({ directory, harnessId: flags.harness, bundle, summary });
    process.exit(0);
  }

  logSection(`${flags.harness} resources @ ${directory}`);
  console.log(`providers: ${summary.providerCount}, models: ${summary.modelCount}`);
  console.log(`agents: ${summary.agents.length}, commands: ${summary.commands.length}`);
  if (summary.models.length) {
    console.log("\nmodels (sample):");
    for (const m of summary.models) console.log(`  ${m.provider}/${m.modelId}`);
  }
  if (summary.agents.length) {
    console.log("\nagents:");
    for (const a of summary.agents) console.log(`  ${a.id ?? a.name}`);
  }
  if (summary.commands.length) {
    console.log("\ncommands:");
    for (const c of summary.commands) console.log(`  ${c.id ?? c.name}`);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (flags.json) {
    printJson({ error: message, directory, harnessId: flags.harness });
    process.exit(1);
  }
  console.error(`loadResources failed: ${message}`);
  process.exit(1);
} finally {
  await og.close();
}
