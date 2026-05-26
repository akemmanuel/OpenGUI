#!/usr/bin/env node

/**
 * PROTOTYPE — throwaway CLI for answering:
 * "How does OpenGUI provider auth behave when OpenCodeConnection is imported directly?"
 *
 * Run: pnpm run prototype:opencode-bridge
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, env } from "node:process";
import { OpenCodeConnection } from "./dist-electron/opencode-bridge.js";
import { DEFAULT_SERVER_URL } from "./src/lib/constants.ts";
import { createInitialState, reducePrototypeState } from "./opencode-bridge.prototype.logic.ts";

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;

const target = {
  directory: process.cwd(),
  workspaceId: "local",
  baseUrl: env.OPENCODE_BASE_URL || DEFAULT_SERVER_URL,
  username: env.OPENCODE_USERNAME || undefined,
  password: env.OPENCODE_PASSWORD || undefined,
};

const connection = new OpenCodeConnection(() => {});
const rl = createInterface({ input, output });
let state = createInitialState({
  question:
    "Can we drive OpenCode provider listing/auth/connect/OAuth directly through OpenCodeConnection?",
  target,
});

const render = () => {
  console.clear();
  const selectedAuth = state.authMethods[state.selectedProviderID] || [
    { type: "api", label: "API key (UI fallback)" },
  ];
  console.log(bold("OpenCode bridge prototype"));
  console.log(dim("WARNING: connect/disconnect mutates the live OpenCode server auth state."));
  console.log(dim(state.question));
  console.log();
  console.log(bold("State"));
  console.log(
    JSON.stringify(
      {
        target: state.target,
        status: connection.getStatus(),
        selectedProviderID: state.selectedProviderID,
        providers: state.providers,
        selectedAuth,
        lastOAuth: state.lastOAuth,
        lastAction: state.lastAction,
        lastError: state.lastError,
        history: state.history,
      },
      null,
      2,
    ),
  );
  console.log();
  console.log(bold("Commands"));
  console.log(`${bold("refresh")} ${dim("list providers + auth methods")}`);
  console.log(`${bold("select <provider>")} ${dim("change selected provider")}`);
  console.log(`${bold("auth")} ${dim("show auth methods for selected provider")}`);
  console.log(`${bold("oauth [methodIndex]")} ${dim("start OAuth for selected provider")}`);
  console.log(`${bold("callback <code-or-url> [methodIndex]")} ${dim("finish OAuth")}`);
  console.log(`${bold("connect <api-key>")} ${dim("store API key on the live server")}`);
  console.log(`${bold("disconnect")} ${dim("remove selected provider auth on the live server")}`);
  console.log(`${bold("state")} ${dim("re-render current state")}`);
  console.log(`${bold("quit")} ${dim("disconnect prototype")}`);
};

const refresh = async () => {
  const providers = await connection.listAllProviders();
  const authMethods = await connection.getProviderAuthMethods();
  state = reducePrototypeState(state, {
    type: "refreshed",
    providers: {
      all: providers.all.map((provider) => ({ id: provider.id })),
      connected: providers.connected,
    },
    authMethods,
  });
};

const runCommand = async (line: string) => {
  const [command, ...rest] = line.trim().split(" ");
  const arg = rest.join(" ").trim();

  if (!command) return "continue" as const;

  if (command === "refresh") {
    await refresh();
    return "continue" as const;
  }

  if (command === "select") {
    if (!arg) throw new Error("Usage: select <provider>");
    state = reducePrototypeState(state, { type: "selected-provider", providerID: arg });
    await refresh();
    return "continue" as const;
  }

  if (command === "auth") {
    state = reducePrototypeState(state, {
      type: "action",
      message: `auth methods loaded for ${state.selectedProviderID}`,
    });
    return "continue" as const;
  }

  if (command === "oauth") {
    const method = arg ? Number(arg) : undefined;
    const authorization = (await connection.oauthAuthorize(state.selectedProviderID, method)) || {};
    state = reducePrototypeState(state, {
      type: "oauth-started",
      providerID: state.selectedProviderID,
      authorization,
    });
    return "continue" as const;
  }

  if (command === "callback") {
    if (!arg) throw new Error("Usage: callback <code-or-url> [methodIndex]");
    const [code, methodText] = arg.split(/\s+/);
    const method = methodText ? Number(methodText) : undefined;
    const ok = await connection.oauthCallback(state.selectedProviderID, method, code);
    state = reducePrototypeState(state, {
      type: "action",
      message: `oauth callback for ${state.selectedProviderID} -> ${ok}`,
    });
    await refresh();
    return "continue" as const;
  }

  if (command === "connect") {
    if (!arg) throw new Error("Usage: connect <api-key>");
    await connection.setProviderAuth(state.selectedProviderID, { type: "api", key: arg });
    state = reducePrototypeState(state, {
      type: "action",
      message: `connected ${state.selectedProviderID} with API key`,
    });
    await refresh();
    return "continue" as const;
  }

  if (command === "disconnect") {
    await connection.removeProviderAuth(state.selectedProviderID);
    state = reducePrototypeState(state, {
      type: "action",
      message: `disconnected ${state.selectedProviderID}`,
    });
    await refresh();
    return "continue" as const;
  }

  if (command === "state") {
    state = reducePrototypeState(state, { type: "action", message: "rendered state" });
    return "continue" as const;
  }

  if (command === "quit" || command === "q") {
    return "quit" as const;
  }

  throw new Error(`Unknown command: ${command}`);
};

try {
  await connection.connect({
    baseUrl: target.baseUrl,
    username: target.username,
    password: target.password,
    directory: target.directory,
  });
  await refresh();
  while (true) {
    render();
    let line = "";
    try {
      line = await rl.question(`\n${bold("> ")}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ERR_USE_AFTER_CLOSE") {
        break;
      }
      throw error;
    }
    try {
      const result = await runCommand(line);
      if (result === "quit") {
        break;
      }
    } catch (error) {
      state = reducePrototypeState(state, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  rl.close();
  connection.disconnect();
}
