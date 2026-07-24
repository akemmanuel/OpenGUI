import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ProcessTreeOptions = {
  platform?: NodeJS.Platform | (string & {});
  force?: boolean;
  execute?: (command: string, args: string[]) => Promise<unknown>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
};

/** Terminates a child started with `detached: true`, including its descendants. */
export async function terminateDetachedProcessTree(
  pid: number | undefined,
  options: ProcessTreeOptions = {},
) {
  if (!pid) return;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const args = ["/pid", String(pid), "/t", ...(options.force ? ["/f"] : [])];
    await (options.execute ?? execFileAsync)("taskkill", args).catch(() => undefined);
    return;
  }
  try {
    const name = options.force ? "SIGKILL" : "SIGTERM";
    if (options.signal) options.signal(-pid, name);
    else process.kill(-pid, name);
  } catch {
    // The process group may already have exited.
  }
}
