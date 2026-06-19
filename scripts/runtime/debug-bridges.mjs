#!/usr/bin/env node
/**
 * Costing smoke test for the Pi and OpenCode OpenGUI SDK bridges.
 *
 *   node --experimental-strip-types scripts/runtime/debug-bridges.mjs -d .
 *   node --experimental-strip-types scripts/runtime/debug-bridges.mjs --harness pi
 */
import { resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PROMPT = "Reply with exactly: OPENGUI_STREAM_OK";
const DEFAULT_MODELS = {
  pi: { providerID: "nvidia", modelID: "openai/gpt-oss-20b" },
  opencode: { providerID: "nvidia", modelID: "openai/gpt-oss-120b" },
};

const colors = {
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

function parseArgs(argv) {
  const flags = {
    directory: process.env.OPENGUI_RUNTIME_DIRECTORY || process.cwd(),
    harnesses: ["pi", "opencode"],
    prompt: DEFAULT_PROMPT,
    dataDir: "",
    json: false,
    showDuplicates: false,
    debugAdapterObservations: false,
    timeoutMs: 180_000,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--show-duplicates") flags.showDuplicates = true;
    else if (arg === "--debug-adapter-observations") flags.debugAdapterObservations = true;
    else if (arg === "--directory" || arg === "-d") flags.directory = argv[++i] || flags.directory;
    else if (arg === "--harness" || arg === "-H") {
      const value = String(argv[++i] || "").trim();
      flags.harnesses = value === "both" ? ["pi", "opencode"] : value.split(",").filter(Boolean);
    } else if (arg === "--prompt" || arg === "-p") flags.prompt = argv[++i] || flags.prompt;
    else if (arg === "--data-dir") flags.dataDir = argv[++i] || "";
    else if (arg === "--timeout-ms") flags.timeoutMs = Number(argv[++i]) || flags.timeoutMs;
    else if (!arg.startsWith("-") && !flags._positionalDirectorySeen) {
      flags.directory = arg;
      flags._positionalDirectorySeen = true;
    }
  }

  flags.directory = resolve(flags.directory);
  if (!flags.dataDir) {
    flags.dataDir = resolve(
      homedir(),
      ".config",
      "opengui-runtime-bridge-debug",
      String(process.pid),
    );
  }
  return flags;
}

function usage() {
  console.log(`Usage: node --experimental-strip-types scripts/runtime/debug-bridges.mjs [options]

Options:
  -d, --directory <path>     Repo/project directory (default: cwd)
  -H, --harness <id|both>    pi, opencode, comma-list, or both (default: both)
  -p, --prompt <text>        Prompt to send (default: exact smoke-test reply)
  --timeout-ms <ms>          Wait timeout per harness (default: 180000)
  --show-duplicates          Print duplicate canonical events too
  --debug-adapter-observations
                            Also print raw Harness Adapter observations
  --json                     Print machine-readable JSON only
  -h, --help                 Show this help

Models:
  pi        nvidia/openai/gpt-oss-20b
  opencode  nvidia/openai/gpt-oss-120b

Warning: this sends real prompts to the selected harnesses.`);
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || "unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function firstAssistantText(messagesPayload) {
  const messages = Array.isArray(messagesPayload?.messages) ? messagesPayload.messages : [];
  const assistant = [...messages].reverse().find((message) => message?.info?.role === "assistant");
  if (!assistant) return "";
  return (assistant.parts || [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function lastAssistantModel(messagesPayload) {
  const messages = Array.isArray(messagesPayload?.messages) ? messagesPayload.messages : [];
  const assistant = [...messages].reverse().find((message) => message?.info?.role === "assistant");
  if (!assistant?.info) return null;
  return {
    providerID: assistant.info.providerID,
    modelID: assistant.info.modelID,
  };
}

function sameSession(left, right) {
  if (!left || !right) return false;
  const a = String(left);
  const b = String(right);
  return a === b || a.split(":").pop() === b.split(":").pop();
}

function partText(part) {
  if (typeof part?.text === "string") return part.text;
  if (typeof part?.content === "string") return part.content;
  return "";
}

function renderMessages(messagesPayload) {
  const messages = Array.isArray(messagesPayload?.messages) ? messagesPayload.messages : [];
  if (!messages.length) {
    line(`  ${colors.dim}(no transcript messages returned)${colors.reset}`);
    return;
  }

  line(`\n  ${colors.bold}Transcript (${messages.length} messages)${colors.reset}`);
  for (const [index, message] of messages.entries()) {
    const info = message?.info || {};
    const role = info.role || "unknown";
    const model = info.model
      ? `${info.model.providerID || "?"}/${info.model.modelID || "?"}${info.model.variant ? `:${info.model.variant}` : ""}`
      : info.modelID
        ? `${info.providerID || "?"}/${info.modelID}`
        : "";
    line(
      `  ${colors.cyan}#${index + 1} ${role}${colors.reset}${model ? ` ${colors.dim}${model}${colors.reset}` : ""}`,
    );
    for (const part of message.parts || []) {
      const text = partText(part);
      const label = part?.type || "part";
      if (text) {
        line(`    ${colors.yellow}${label}${colors.reset}:`);
        for (const textLine of text.split("\n")) line(`      ${textLine}`);
      } else {
        line(
          `    ${colors.yellow}${label}${colors.reset}${part?.state?.status ? ` (${part.state.status})` : ""}`,
        );
      }
    }
  }
}

function line(text = "") {
  process.stdout.write(`${text}\n`);
}

function oneLine(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteChunk(value) {
  return JSON.stringify(String(value ?? ""));
}

async function runHarness({
  og,
  directory,
  harnessId,
  prompt,
  timeoutMs,
  json,
  showDuplicates,
  debugAdapterObservations,
}) {
  const model = DEFAULT_MODELS[harnessId];
  const result = {
    harnessId,
    model,
    ok: false,
    steps: [],
    liveEvents: [],
    harnessEvents: [],
    errors: [],
  };

  if (!model) {
    result.errors.push({
      phase: "config",
      message: `No default model configured for ${harnessId}`,
    });
    return result;
  }

  if (!json) {
    line(
      `\n${colors.bold}${colors.cyan}▶ ${harnessId}${colors.reset} ${colors.dim}${model.providerID}/${model.modelID}${colors.reset}`,
    );
  }

  const cleanupFns = [];
  try {
    const dir = await og.at(directory);
    await dir.connect({ harnesses: [harnessId] });
    result.steps.push("connected");
    const harness = dir.harness(harnessId);

    let currentSessionId = "";
    const shownHarnessEvents = new Set();
    const shownLiveEvents = new Set();

    if (debugAdapterObservations) {
      const offHarness = harness.on("event", (event) => {
        const text = partText(event.part);
        result.harnessEvents.push({
          type: event.type,
          sessionID: event.sessionID,
          status: event.status?.type ?? event.status,
          field: event.field,
          delta: event.delta,
          partType: event.part?.type,
          partTextLen: typeof event.part?.text === "string" ? event.part.text.length : undefined,
          text,
        });
        if (!json && (!event.sessionID || sameSession(event.sessionID, currentSessionId))) {
          const signature = JSON.stringify({
            type: event.type,
            sessionID: event.sessionID,
            status: event.status?.type ?? event.status,
            field: event.field,
            delta: event.delta,
            partType: event.part?.type,
            text,
          });
          const duplicate = shownHarnessEvents.has(signature);
          shownHarnessEvents.add(signature);
          if (duplicate && !showDuplicates) return;

          if (event.type === "session.status") {
            line(
              `  ${colors.dim}raw:${colors.reset} session.status ${event.status?.type ?? event.status}`,
            );
          } else if (event.type === "message.part.delta") {
            line(
              `  ${colors.dim}raw:${colors.reset} part.delta ${event.field || "text"} ${quoteChunk(event.delta)}`,
            );
          } else if (event.type === "message.part.updated") {
            const label = event.part?.type || "part";
            const len = text.length;
            line(`  ${colors.dim}raw:${colors.reset} part.updated ${label} len=${len}`);
            if (text) line(`       ${oneLine(text)}`);
          } else if (
            ["message.updated", "message.replaced", "session.created"].includes(event.type)
          ) {
            line(`  ${colors.dim}raw:${colors.reset} ${event.type}`);
          }
        }
      });
      cleanupFns.push(offHarness);
    }

    const resources = await harness.loadResources({ directory });
    const providers = resources?.providersData?.providers ?? resources?.providersData?.all ?? [];
    result.modelFound = providers.some(
      (provider) => provider.id === model.providerID && provider.models?.[model.modelID],
    );
    if (!result.modelFound)
      throw new Error(`Model not found: ${model.providerID}/${model.modelID}`);
    result.steps.push("model found");

    const session = await harness.sessions.create({ title: `OpenGUI bridge debug ${harnessId}` });
    currentSessionId = session.id;
    result.sessionId = session.id;
    result.steps.push("session created");

    const offLive = session.onEvent((event) => {
      result.liveEvents.push({
        type: event.type,
        reason: event.reason,
        partKind: event.partKind,
        text: event.text,
        textLen: event.text?.length,
      });
      if (!json) {
        const signature = JSON.stringify(event);
        const duplicate = shownLiveEvents.has(signature);
        shownLiveEvents.add(signature);
        if (duplicate && !showDuplicates) return;

        if (event.type === "part.text.appended") {
          line(
            `  ${colors.green}event:${colors.reset} ${event.type} ${event.partKind} ${quoteChunk(event.text)}`,
          );
        } else if (event.type === "part.text.replaced") {
          line(
            `  ${colors.green}event:${colors.reset} ${event.type} ${event.partKind} ${quoteChunk(event.text)}`,
          );
        } else if (event.type === "run.finished") {
          line(
            `  ${colors.green}event:${colors.reset} ${event.type} ${event.reason || ""}`.trimEnd(),
          );
        } else {
          line(`  ${colors.green}event:${colors.reset} ${event.type}`);
        }
      }
    });
    cleanupFns.push(offLive);

    await session.send(prompt, { model });
    result.steps.push("send accepted");
    await session.waitUntilIdle({ timeoutMs });
    result.steps.push("idle");

    const messages = await session.messages({ limit: 10 });
    result.messages = messages;
    result.assistantText = firstAssistantText(messages);
    result.assistantModel = lastAssistantModel(messages);
    result.messagesShape = Object.keys(messages || {});
    result.ok = true;
  } catch (error) {
    result.errors.push({
      name: error?.name,
      code: error?.code,
      message: error?.message || String(error),
    });
  } finally {
    for (const cleanup of cleanupFns.reverse()) {
      try {
        cleanup();
      } catch {
        // best-effort cleanup
      }
    }
  }

  result.counts = {
    live: result.liveEvents.length,
    harness: result.harnessEvents.length,
    liveTypes: countBy(result.liveEvents, "type"),
    harnessTypes: countBy(result.harnessEvents, "type"),
  };

  if (!json) {
    const status = result.ok
      ? `${colors.green}PASS${colors.reset}`
      : `${colors.red}FAIL${colors.reset}`;
    line(`  status: ${status}`);
    if (result.assistantText) line(`  final: ${colors.bold}${result.assistantText}${colors.reset}`);
    if (result.assistantModel?.modelID) {
      line(`  used: ${result.assistantModel.providerID}/${result.assistantModel.modelID}`);
    }
    if (result.messages) renderMessages(result.messages);
    line(`  events: ${JSON.stringify(result.counts.liveTypes)}`);
    if (debugAdapterObservations) line(`  raw: ${JSON.stringify(result.counts.harnessTypes)}`);
    for (const err of result.errors) line(`  ${colors.red}error:${colors.reset} ${err.message}`);
  }

  return result;
}

const flags = parseArgs(process.argv);
if (flags.help) {
  usage();
  process.exit(0);
}

const { createOpenGUI } = await import("@opengui/runtime");
const og = await createOpenGUI({ allowedRoots: [flags.directory], dataDir: flags.dataDir });
const results = [];

try {
  if (!flags.json) {
    line(`${colors.bold}OpenGUI bridge debug${colors.reset}`);
    line(`${colors.dim}directory: ${flags.directory}${colors.reset}`);
  }

  for (const harnessId of flags.harnesses) {
    results.push(
      await runHarness({
        og,
        directory: flags.directory,
        harnessId,
        prompt: flags.prompt,
        timeoutMs: flags.timeoutMs,
        json: flags.json,
        showDuplicates: flags.showDuplicates,
        debugAdapterObservations: flags.debugAdapterObservations,
      }),
    );
  }
} finally {
  await og.close().catch(() => undefined);
}

if (flags.json) {
  console.log(JSON.stringify({ directory: flags.directory, results }, null, 2));
} else {
  const failed = results.filter((result) => !result.ok).length;
  line(
    `\n${colors.bold}Summary:${colors.reset} ${results.length - failed}/${results.length} passed`,
  );
  if (failed) process.exitCode = 1;
}
