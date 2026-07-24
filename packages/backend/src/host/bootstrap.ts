import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenGuiHost, type OpenGuiHost, type SessionAccessGate } from "./opengui-host.ts";
import type { ExecutionPolicyResolver } from "@opengui/harness";

export async function createHostContext(
  options: {
    resolveExecutionPolicy?: ExecutionPolicyResolver;
    sessionAccess?: SessionAccessGate;
  } = {},
): Promise<{
  dataDir: string;
  host: OpenGuiHost;
}> {
  const dataDir = resolve(
    process.env.OPENGUI_DATA_DIR || join(homedir(), ".config", "OpenGUI-web"),
  );
  await mkdir(dataDir, { recursive: true });
  const host = await createOpenGuiHost(dataDir, options);
  return { dataDir, host };
}
