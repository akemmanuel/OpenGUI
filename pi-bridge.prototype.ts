#!/usr/bin/env node

/**
 * PROTOTYPE — throwaway CLI for answering:
 * "How does OpenGUI provider auth behave when PiBridgeManager is imported directly?"
 *
 * Run: vp node --experimental-strip-types ./pi-bridge.prototype.ts
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { PiBridgeManager } from "./pi-bridge.ts";
import { createInitialState, reducePrototypeState } from "./pi-bridge.prototype.logic.ts";

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;

const manager = new PiBridgeManager(() => []);
const target = {
  directory: process.cwd(),
  workspaceId: "local",
};
const authFile = path.join(homedir(), ".pi", "agent", "auth.json");
const authSnapshot = await readFile(authFile, "utf8").catch(() => null);
const state0 = createInitialState({
  question: "Can we drive Pi provider listing/auth/connect/OAuth directly through PiBridgeManager?",
  target,
  authFile,
  authRestoreMode: authSnapshot === null ? "delete-on-exit" : "restore-existing",
});
let state = state0;

const rl = createInterface({ input, output });

const cleanup = async () => {
  await manager.disconnect().catch(() => {});
  if (authSnapshot === null) {
    await rm(authFile, { force: true }).catch(() => {});
    return;
  }
  await mkdir(path.dirname(authFile), { recursive: true });
  await writeFile(authFile, authSnapshot, "utf8");
};

const render = () => {
  console.clear();
  const selectedProvider = state.providers.selected;
  const selectedAuth = state.authMethods[state.selectedProviderID] || [
    { type: "api", label: "API key (UI fallback)" },
  ];
  const frame = {
    target: state.target,
    authFile: state.authFile,
    authRestoreMode: state.authRestoreMode,
    selectedProviderID: state.selectedProviderID,
    providers: {
      total: state.providers.total,
      connected: state.providers.connected,
      sample: state.providers.sample,
      selected: selectedProvider,
    },
    selectedAuth,
    lastOAuth: state.lastOAuth,
    lastAction: state.lastAction,
    lastError: state.lastError,
    history: state.history,
  };

  console.log(bold("Pi bridge prototype"));
  console.log(dim(state.question));
  console.log();
  console.log(bold("State"));
  console.log(JSON.stringify(frame, null, 2));
  console.log();
  console.log(bold("Commands"));
  console.log(`${bold("refresh")} ${dim("list providers + auth methods")}`);
  console.log(`${bold("select <provider>")} ${dim("change selected provider")}`);
  console.log(`${bold("auth")} ${dim("show auth methods for selected provider")}`);
  console.log(`${bold("oauth")} ${dim("start OAuth for selected provider")}`);
  console.log(`${bold("callback <code-or-url>")} ${dim("finish code/callback-based OAuth")}`);
  console.log(`${bold("connect <api-key>")} ${dim("store API key via bridge; restored on exit")}`);
  console.log(`${bold("disconnect")} ${dim("remove selected provider auth; restored on exit")}`);
  console.log(`${bold("state")} ${dim("re-render current state")}`);
  console.log(`${bold("quit")} ${dim("exit and restore auth.json snapshot")}`);
};

const refresh = async () => {
  const providers = await manager.listAllProviders(target);
  const authMethods = await manager.getProviderAuthMethods(target);
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
    const authorization = await manager.oauthAuthorize(target, state.selectedProviderID);
    state = reducePrototypeState(state, {
      type: "oauth-started",
      providerID: state.selectedProviderID,
      authorization,
    });
    return "continue" as const;
  }

  if (command === "callback") {
    if (!arg) throw new Error("Usage: callback <code-or-url>");
    const ok = await manager.oauthCallback(target, state.selectedProviderID, 0, arg);
    state = reducePrototypeState(state, {
      type: "action",
      message: `oauth callback for ${state.selectedProviderID} -> ${ok}`,
    });
    await refresh();
    return "continue" as const;
  }

  if (command === "connect") {
    if (!arg) throw new Error("Usage: connect <api-key>");
    await manager.connectProvider(target, state.selectedProviderID, {
      type: "api",
      key: arg,
    });
    state = reducePrototypeState(state, {
      type: "action",
      message: `connected ${state.selectedProviderID} with API key`,
    });
    await refresh();
    return "continue" as const;
  }

  if (command === "disconnect") {
    await manager.disconnectProvider(target, state.selectedProviderID);
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
  await cleanup();
}
