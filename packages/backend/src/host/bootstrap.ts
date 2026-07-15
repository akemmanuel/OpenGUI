import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenGuiHost, type OpenGuiHost } from "./opengui-host.ts";

export async function createHostContext(): Promise<{
  dataDir: string;
  host: OpenGuiHost;
}> {
  const dataDir = resolve(
    process.env.OPENGUI_DATA_DIR || join(homedir(), ".config", "OpenGUI-web"),
  );
  await mkdir(dataDir, { recursive: true });
  const host = await createOpenGuiHost(dataDir);
  return { dataDir, host };
}
