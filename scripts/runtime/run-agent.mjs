#!/usr/bin/env node
/**
 * One-shot agent send via @opengui/runtime (costs tokens).
 *
 *   vp node scripts/runtime/run-agent.mjs -d /path/to/repo -H pi "Say hello in one word"
 *   vp node scripts/runtime/run-agent.mjs --json -d . "List top-level files in one sentence"
 */
import { parseArgs, resolveDirectory, usageLines } from "./lib.mjs";

function parseRunAgentArgs(argv) {
  const flags = parseArgs(argv);
  const messageParts = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") continue;
    if (arg.startsWith("-")) {
      if (
        arg === "-d" ||
        arg === "--directory" ||
        arg === "-H" ||
        arg === "--harness" ||
        arg === "--data-dir"
      )
        i++;
      continue;
    }
    if (!flags.directory && !arg.startsWith("-")) {
      flags.directory = arg.trim();
      continue;
    }
    messageParts.push(arg);
  }
  flags.message = messageParts.join(" ").trim();
  return flags;
}

const flags = parseRunAgentArgs(process.argv);
if (flags.help || !flags.message) {
  console.log(
    [
      ...usageLines("run-agent.mjs", [
        "  --json                      JSON result (RunAgentResult)",
        "",
        "Positional: [directory] <message>",
      ]),
      "",
      "Example:",
      '  vp node scripts/runtime/run-agent.mjs -d . -H pi "Summarize this repo in one sentence"',
    ].join("\n"),
  );
  process.exit(flags.help ? 0 : 1);
}

const { runAgent } = await import("@opengui/runtime");
const directory = resolveDirectory(flags);
const { createRuntime } = await import("./lib.mjs");
const { og } = await createRuntime({ ...flags, directory });

try {
  const result = await runAgent(og, {
    directory,
    harness: flags.harness,
    message: flags.message,
  });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`sessionId: ${result.sessionId}`);
    console.log(`reason: ${result.reason}`);
    if (result.assistantText) console.log(`\n${result.assistantText}`);
  }
} finally {
  await og.close();
}
