#!/usr/bin/env node
/**
 * Read-only @opengui/runtime smoke: inventories → register → sessions → resources
 * → directory status → messages (first session). No prompts.
 *
 *   vp node scripts/runtime/probe-all-readonly.mjs -d /path/to/repo
 *   OPENGUI_RUNTIME_HARNESS=opencode vp node scripts/runtime/probe-all-readonly.mjs -d .
 */
import {
  createRuntime,
  logSection,
  parseArgs,
  printJson,
  summarizeMessages,
  summarizeResources,
  usageLines,
} from "./lib.mjs";

const flags = parseArgs(process.argv);
if (flags.help) {
  console.log(usageLines("probe-all-readonly.mjs").join("\n"));
  process.exit(0);
}

const started = performance.now();
const { og, directory, dataDir } = await createRuntime(flags);
const dir = await og.at(directory);
const handle = dir.harness(flags.harness);
const report = { directory, harnessId: flags.harness, dataDir, steps: {} };

try {
  report.steps.inventories = og.getHarnessInventories();
  if (!flags.json) {
    logSection("inventories");
    for (const inv of report.steps.inventories) {
      console.log(`${inv.harnessId}: ${inv.status} (${(inv.models ?? []).length} models)`);
    }
  }

  report.steps.register = await og.registerDirectory({
    directory,
    harnessIds: [flags.harness],
  });
  if (!flags.json) {
    logSection("registerDirectory");
    console.log(report.steps.register);
  }

  report.steps.sessions = await handle.sessions.list({ directory });
  if (!flags.json) {
    logSection("sessions");
    console.log(`count: ${report.steps.sessions.length}`);
    for (const s of report.steps.sessions.slice(0, 5)) {
      console.log(`  ${s.id} ${s.status ?? ""} ${s.title ?? ""}`);
    }
  }

  try {
    const bundle = await handle.loadResources({ directory });
    report.steps.resources = summarizeResources(bundle);
    if (!flags.json) {
      logSection("resources");
      console.log(report.steps.resources);
    }
  } catch (err) {
    report.steps.resourcesError = err instanceof Error ? err.message : String(err);
    if (!flags.json) {
      logSection("resources (failed)");
      console.log(report.steps.resourcesError);
    }
  }

  try {
    report.steps.directoryStatus = await handle.directoryStatus({ directory });
    if (!flags.json) {
      logSection("directoryStatus");
      console.log(report.steps.directoryStatus);
    }
  } catch (err) {
    report.steps.directoryStatusError = err instanceof Error ? err.message : String(err);
  }

  const firstSession = report.steps.sessions[0]?.id;
  if (firstSession) {
    try {
      const raw = await handle.messages({
        directory,
        sessionId: firstSession,
        limit: flags.limit,
      });
      report.steps.messages = summarizeMessages(raw);
      if (!flags.json) {
        logSection(`messages (${firstSession})`);
        console.log(report.steps.messages);
      }
    } catch (err) {
      report.steps.messagesError = err instanceof Error ? err.message : String(err);
      if (!flags.json) console.log(`messages skipped: ${report.steps.messagesError}`);
    }
  } else {
    report.steps.messages = { skipped: "no sessions" };
  }

  report.elapsedMs = Math.round(performance.now() - started);
  if (flags.json) printJson(report);
  else {
    logSection("done");
    console.log(`elapsed: ${report.elapsedMs}ms`);
  }
} finally {
  await og.close();
}
