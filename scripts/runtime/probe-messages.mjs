#!/usr/bin/env node
/**
 * Read-only @opengui/runtime probe: list sessions, pick one, fetch transcript (no prompt).
 *
 *   vp node scripts/runtime/probe-messages.mjs -d /path/to/repo -H pi
 *   vp node scripts/runtime/probe-messages.mjs -d . -s pi:abc123 --limit 5
 */
import {
  createRuntime,
  logSection,
  parseArgs,
  printJson,
  summarizeMessages,
  usageLines,
} from "./lib.mjs";

const flags = parseArgs(process.argv);
if (flags.help) {
  console.log(
    usageLines("probe-messages.mjs", [
      "  -s, --session <id>          Session id (default: first listed)",
      "  --limit <n>                 Message limit (default: 20)",
    ]).join("\n"),
  );
  process.exit(0);
}

const { og, directory } = await createRuntime(flags);
const dir = await og.at(directory);
const handle = dir.harness(flags.harness);

try {
  await og.registerDirectory({ directory, harnessIds: [flags.harness] });
  const sessions = await handle.sessions.list({ directory });
  const sessionId = flags.sessionId || sessions[0]?.id;
  if (!sessionId) {
    const out = { directory, harnessId: flags.harness, sessions: [], message: "no sessions" };
    if (flags.json) printJson(out);
    else console.log("No sessions to read messages from.");
    process.exit(0);
  }

  const payload = await handle.messages({
    directory,
    sessionId,
    limit: flags.limit,
  });
  const summary = summarizeMessages(payload);

  if (flags.json) {
    printJson({ directory, harnessId: flags.harness, sessionId, summary, raw: payload });
    process.exit(0);
  }

  logSection(`messages ${sessionId}`);
  console.log(`shape: ${summary.shape}, count: ${summary.count ?? "n/a"}`);
  if (summary.sample) printJson(summary.sample);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (flags.json) {
    printJson({ error: message });
    process.exit(1);
  }
  console.error(`messages failed: ${message}`);
  process.exit(1);
} finally {
  await og.close();
}
