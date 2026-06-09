#!/usr/bin/env node
/**
 * THROWAWAY PROTOTYPE — Claude SDK replacement terminal driver.
 *
 * Question this prototype answers:
 *   Does OpenGUI's local Claude SDK replacement actually
 *   work against a real local Claude Code CLI with the same options shape used
 *   by claude-code-bridge.ts: pathToClaudeCodeExecutable, stream-json output,
 *   includePartialMessages, settingSources, preset tools, canUseTool permission
 *   callback, query.close()/return(), and session helpers?
 *
 * Run from OpenGUI:
 *   pnpm run prototype:claude-sdk
 *
 * This can invoke real Claude and may consume Claude usage. Use Plan mode or a
 * harmless prompt first.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  getSessionMessages,
  listSessions,
  query,
} from "../BetterSDK/dist/index.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`OpenGUI Claude SDK replacement terminal prototype

Run:
  pnpm run prototype:claude-sdk

Environment:
  CLAUDE_CODE_EXECUTABLE=/path/to/claude  Override local claude executable

Warning: this invokes real Claude unless you only inspect the menu/help.
`);
  process.exit(0);
}

const rl = createInterface({ input, output });
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const state = {
  cwd: process.cwd(),
  cli: process.env.CLAUDE_CODE_EXECUTABLE?.trim() || "claude",
  model: undefined,
  permissionMode: "plan",
  permissionPolicy: "ask", // ask | allow | deny
  includePartialMessages: true,
  running: false,
  activeSessionId: null,
  lastError: null,
  lastPrompt: null,
  lastResult: null,
  lastInit: null,
  models: [],
  counters: {
    messages: 0,
    permissions: 0,
    hooks: 0,
    streamEvents: 0,
    assistant: 0,
    result: 0,
  },
  recentMessages: [],
  sessions: [],
};

function remember(message) {
  state.counters.messages += 1;
  if (message?.session_id) state.activeSessionId = message.session_id;
  if (message?.type === "stream_event") state.counters.streamEvents += 1;
  if (message?.type === "assistant") state.counters.assistant += 1;
  if (message?.type === "result") {
    state.counters.result += 1;
    state.lastResult = message;
  }
  if (message?.type === "system" && message?.subtype === "init") state.lastInit = message;
  state.recentMessages.push(summarizeMessage(message));
  state.recentMessages = state.recentMessages.slice(-12);
}

function summarizeMessage(message) {
  if (!message || typeof message !== "object") return String(message);
  if (message.type === "stream_event") return `stream_event:${message.event?.type ?? "?"}`;
  if (message.type === "assistant") {
    const text = (message.message?.content ?? [])
      .filter((p) => p?.type === "text")
      .map((p) => p.text)
      .join(" ")
      .slice(0, 100);
    return `assistant ${message.message?.id ?? ""} ${text}`.trim();
  }
  if (message.type === "result") return `result error=${Boolean(message.is_error)} ${message.subtype ?? ""}`;
  if (message.type === "system") return `system:${message.subtype ?? "?"} session=${message.session_id ?? ""}`;
  if (message.type === "user") return `user session=${message.session_id ?? ""}`;
  return `${message.type ?? "unknown"} ${JSON.stringify(message).slice(0, 120)}`;
}

function render() {
  console.clear();
  console.log(bold("OpenGUI Claude SDK replacement prototype"));
  console.log(dim("Throwaway terminal driver for real local claude CLI integration."));
  console.log();
  console.log(`${bold("cwd")}: ${state.cwd}`);
  console.log(`${bold("cli")}: ${state.cli}`);
  console.log(`${bold("model")}: ${state.model ?? "(default)"}`);
  console.log(`${bold("permissionMode")}: ${state.permissionMode}`);
  console.log(`${bold("permissionPolicy")}: ${state.permissionPolicy}`);
  console.log(`${bold("includePartialMessages")}: ${state.includePartialMessages}`);
  console.log(`${bold("running")}: ${state.running}`);
  console.log(`${bold("activeSessionId")}: ${state.activeSessionId ?? "(none)"}`);
  console.log(`${bold("lastPrompt")}: ${state.lastPrompt ?? "(none)"}`);
  console.log(`${bold("lastError")}: ${state.lastError ?? "(none)"}`);
  console.log();
  console.log(bold("counters"));
  console.log(JSON.stringify(state.counters, null, 2));
  console.log();
  console.log(bold("recent messages"));
  for (const line of state.recentMessages) console.log(`  - ${line}`);
  if (state.recentMessages.length === 0) console.log(dim("  (none yet)"));
  console.log();
  console.log(bold("sessions cache"));
  for (const s of state.sessions.slice(0, 8)) {
    console.log(`  - ${s.sessionId} ${dim(s.summary ?? s.firstPrompt ?? "")}`);
  }
  if (state.sessions.length === 0) console.log(dim("  (not loaded)"));
  console.log();
  console.log(bold("models cache"));
  for (const m of state.models.slice(0, 12)) {
    const value = m?.value ?? m?.id ?? JSON.stringify(m).slice(0, 60);
    const label = m?.displayName ?? m?.name ?? m?.description ?? "";
    console.log(`  - ${value} ${dim(label)}`);
  }
  if (state.models.length === 0) console.log(dim("  (not loaded)"));
  console.log();
  console.log(bold("actions"));
  console.log("  1  run harmless real query");
  console.log("  2  run custom real query");
  console.log("  3  list sessions via replacement SDK");
  console.log("  4  show active/latest session messages");
  console.log("  5  list supported models via replacement SDK");
  console.log("  6  change cwd");
  console.log("  7  change model");
  console.log("  8  cycle permission mode");
  console.log("  9  cycle permission callback policy");
  console.log("  p  toggle partial stream events");
  console.log("  q  quit");
  console.log();
}

function buildOptions() {
  return {
    cwd: state.cwd,
    model: state.model || undefined,
    pathToClaudeCodeExecutable: state.cli,
    includePartialMessages: state.includePartialMessages,
    settingSources: ["user", "project", "local"],
    tools: { type: "preset", preset: "claude_code" },
    disallowedTools: ["AskUserQuestion"],
    permissionMode: state.permissionMode,
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: "OpenGUI Prototype",
    },
    canUseTool: async (toolName, toolInput, context) => {
      state.counters.permissions += 1;
      render();
      console.log(bold("Permission callback fired"));
      console.log(JSON.stringify({ toolName, input: toolInput, context }, null, 2));
      if (state.permissionPolicy === "allow") return { behavior: "allow", updatedInput: toolInput };
      if (state.permissionPolicy === "deny") return { behavior: "deny", message: "Denied by prototype" };
      const answer = (await rl.question("Allow this tool call? [y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes"
        ? { behavior: "allow", updatedInput: toolInput }
        : { behavior: "deny", message: "Denied by prototype" };
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [async (hookInput, toolUseID) => {
            state.counters.hooks += 1;
            state.recentMessages.push(`hook PreToolUse toolUseID=${toolUseID ?? ""}`);
            state.recentMessages = state.recentMessages.slice(-12);
            return { continue: true };
          }],
        },
      ],
    },
  };
}

async function runQuery(prompt) {
  state.running = true;
  state.lastPrompt = prompt;
  state.lastError = null;
  state.lastResult = null;
  state.lastInit = null;
  state.recentMessages = [];
  state.counters = { messages: 0, permissions: 0, hooks: 0, streamEvents: 0, assistant: 0, result: 0 };
  render();
  console.log(dim("Starting real Claude subprocess..."));

  const handle = query({ prompt, options: buildOptions() });
  try {
    const init = await handle.initializationResult();
    state.lastInit = init;
    render();
    console.log(dim("Initialized. Streaming messages..."));
    for await (const message of handle) {
      remember(message);
      render();
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.stack || error.message : String(error);
  } finally {
    state.running = false;
    await handle.close?.().catch?.(() => {});
    render();
    await rl.question("Query finished. Press Enter to continue...");
  }
}

async function refreshSessions() {
  state.lastError = null;
  try {
    state.sessions = await listSessions({ dir: state.cwd, limit: 50 });
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
  }
}

async function showMessages() {
  const fallback = state.sessions[0]?.sessionId;
  const sessionId = state.activeSessionId || fallback;
  if (!sessionId) {
    await rl.question("No active/listed session. Press Enter...");
    return;
  }
  try {
    const messages = await getSessionMessages(sessionId, {
      dir: state.cwd,
      includeSystemMessages: false,
    });
    console.clear();
    console.log(bold(`Messages for ${sessionId}`));
    console.log(JSON.stringify(messages.slice(-20), null, 2));
  } catch (error) {
    console.log(error instanceof Error ? error.stack || error.message : String(error));
  }
  await rl.question("Press Enter...");
}

async function listModels() {
  state.lastError = null;
  state.models = [];
  render();
  console.log(dim("Launching Claude config probe for supportedModels()..."));
  const neverPrompt = (async function* () {
    await new Promise(() => {});
  })();
  const handle = query({
    prompt: neverPrompt,
    options: {
      cwd: state.cwd,
      model: "haiku",
      pathToClaudeCodeExecutable: state.cli,
      settingSources: ["user", "project", "local"],
      permissionMode: "acceptEdits",
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "OpenGUI Prototype",
      },
    },
  });
  try {
    await handle.initializationResult();
    state.models = await handle.supportedModels();
  } catch (error) {
    state.lastError = error instanceof Error ? error.stack || error.message : String(error);
  } finally {
    await handle.close?.().catch?.(() => {});
  }
}

function cyclePermissionMode() {
  const modes = ["plan", "default", "acceptEdits", "dontAsk", "bypassPermissions"];
  state.permissionMode = modes[(modes.indexOf(state.permissionMode) + 1) % modes.length];
}

function cyclePermissionPolicy() {
  const policies = ["ask", "allow", "deny"];
  state.permissionPolicy = policies[(policies.indexOf(state.permissionPolicy) + 1) % policies.length];
}

while (true) {
  render();
  const choice = (await rl.question("Choose action: ")).trim().toLowerCase();
  if (choice === "q") break;
  if (choice === "1") {
    await runQuery("Say exactly: OK. Do not use tools.");
  } else if (choice === "2") {
    const prompt = await rl.question("Prompt: ");
    if (prompt.trim()) await runQuery(prompt);
  } else if (choice === "3") {
    await refreshSessions();
  } else if (choice === "4") {
    await showMessages();
  } else if (choice === "5") {
    await listModels();
  } else if (choice === "6") {
    const cwd = await rl.question(`cwd [${state.cwd}]: `);
    if (cwd.trim()) state.cwd = cwd.trim();
  } else if (choice === "7") {
    const model = await rl.question(`model blank=default [${state.model ?? ""}]: `);
    state.model = model.trim() || undefined;
  } else if (choice === "8") {
    cyclePermissionMode();
  } else if (choice === "9") {
    cyclePermissionPolicy();
  } else if (choice === "p") {
    state.includePartialMessages = !state.includePartialMessages;
  }
}

rl.close();

