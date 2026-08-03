import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenGuiHost, type OpenGuiHost, type SessionAccessGate } from "./opengui-host.ts";
import type {
  DurableActor,
  ExecutionPolicyResolver,
  ModelTransport,
  ShellToolExecutor,
} from "@opengui/harness";
import type { SkillSourceResolver } from "./skills-management.ts";

export function modelTransportEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const model = env.OPENGUI_MODEL_TRANSPORT;
  const modelPiAi = model === undefined || model === "pi-ai";
  const codex = env.OPENGUI_CODEX_TRANSPORT;
  const codexPiAi =
    modelPiAi &&
    codex !== "native" &&
    (codex === undefined ||
      codex === "auto" ||
      codex === "sse" ||
      codex === "websocket" ||
      codex === "websocket-cached");
  const codexPiTransport = codexPiAi && codex !== undefined ? codex : "auto";
  const openAi = env.OPENGUI_OPENAI_RESPONSES_TRANSPORT;
  const openAiResponsesTransport =
    openAi === undefined || openAi === "auto"
      ? "auto"
      : openAi === "websocket" || openAi === "sse"
        ? openAi
        : "sse";
  return {
    usePiAiTransport: modelPiAi,
    usePiAiCodexTransport: codexPiAi,
    codexPiTransport,
    openAiResponsesTransport,
    ownerModelDiagnostics: env.OPENGUI_OWNER_MODEL_DIAGNOSTICS === "1",
  } as const;
}

export async function createHostContext(
  options: {
    dataDirectory?: string;
    resolveExecutionPolicy?: ExecutionPolicyResolver;
    shellExecutor?: ShellToolExecutor;
    sessionAccess?: SessionAccessGate;
    model?: ModelTransport;
    resolveModelOffering?: (
      offeringId: string,
      actor?: DurableActor,
    ) => Promise<{ connectionId: string; modelId: string }>;
    homeDirectory?: string;
    skillSourceResolver?: SkillSourceResolver;
    authorizeSkillManagement?: (actor: DurableActor | undefined) => Promise<void>;
    authorizeMcpUse?: (actor: DurableActor | undefined) => Promise<boolean>;
    usePiAiTransport?: boolean;
    usePiAiCodexTransport?: boolean;
    codexPiTransport?: "auto" | "websocket" | "websocket-cached" | "sse";
    openAiResponsesTransport?: "auto" | "websocket" | "sse";
    ownerModelDiagnostics?: boolean;
  } = {},
): Promise<{
  dataDir: string;
  host: OpenGuiHost;
}> {
  const dataDir = resolve(
    options.dataDirectory ||
      process.env.OPENGUI_DATA_DIR ||
      join(homedir(), ".config", "OpenGUI-web"),
  );
  await mkdir(dataDir, { recursive: true });
  const environment = modelTransportEnvironment();
  const host = await createOpenGuiHost(dataDir, {
    ...options,
    usePiAiTransport: options.usePiAiTransport ?? environment.usePiAiTransport,
    usePiAiCodexTransport: options.usePiAiCodexTransport ?? environment.usePiAiCodexTransport,
    codexPiTransport: options.codexPiTransport ?? environment.codexPiTransport,
    openAiResponsesTransport:
      options.openAiResponsesTransport ?? environment.openAiResponsesTransport,
    ownerModelDiagnostics: options.ownerModelDiagnostics ?? environment.ownerModelDiagnostics,
  });
  return { dataDir, host };
}
