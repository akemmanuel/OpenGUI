import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface ResolvedShell {
  executable: string;
  family: "posix" | "powershell";
}

function isExecutable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(command: string, environment: NodeJS.ProcessEnv) {
  if (isAbsolute(command)) return isExecutable(command) ? command : null;
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function shellFamily(executable: string): ResolvedShell["family"] {
  return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/iu.test(executable) ? "powershell" : "posix";
}

export function resolveNativeShell(input: {
  configuredExecutable?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}): ResolvedShell {
  const platform = input.platform ?? process.platform;
  const environment = input.environment ?? process.env;
  if (input.configuredExecutable) {
    const executable = findOnPath(input.configuredExecutable, environment);
    if (!executable)
      throw new Error(`Configured shell is not executable: ${input.configuredExecutable}`);
    return { executable, family: shellFamily(executable) };
  }
  if (platform === "win32") {
    const executable = findOnPath("pwsh", environment) ?? findOnPath("powershell.exe", environment);
    if (!executable) throw new Error("Neither pwsh nor Windows PowerShell is available");
    return { executable, family: "powershell" };
  }
  const configured = environment.SHELL ? findOnPath(environment.SHELL, environment) : null;
  return { executable: configured ?? "/bin/sh", family: "posix" };
}
