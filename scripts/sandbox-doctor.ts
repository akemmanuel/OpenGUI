import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

type PathStatus = { exists: boolean; directory: boolean; mode: number };

export type SandboxHostInspection = {
  securityOptions: string[];
  runtimes: string[];
  workspace: PathStatus;
  deployKey: PathStatus;
  knownHosts: PathStatus;
};

export function sandboxHostFindings(inspection: SandboxHostInspection) {
  const findings: string[] = [];
  if (!inspection.securityOptions.some((option) => option === "name=rootless")) {
    findings.push("Docker is not running in rootless mode");
  }
  if (!inspection.runtimes.includes("runsc")) {
    findings.push('Docker runtime "runsc" is not registered');
  }
  if (!inspection.workspace.exists || !inspection.workspace.directory) {
    findings.push("OPENGUI_WORKSPACE is not an existing directory");
  }
  if (!inspection.deployKey.exists) {
    findings.push("GitHub deploy key does not exist");
  } else if ((inspection.deployKey.mode & 0o077) !== 0) {
    findings.push("GitHub deploy key must not be accessible by group or other users");
  }
  if (!inspection.knownHosts.exists) {
    findings.push("GitHub known-hosts file does not exist");
  }
  return findings;
}

function pathStatus(path: string | undefined): PathStatus {
  if (!path) return { exists: false, directory: false, mode: 0 };
  try {
    const info = statSync(path);
    return { exists: true, directory: info.isDirectory(), mode: info.mode & 0o777 };
  } catch {
    return { exists: false, directory: false, mode: 0 };
  }
}

function dockerOutput(format: string) {
  const result = spawnSync("docker", ["info", "--format", format], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "docker info failed");
  }
  return result.stdout.trim();
}

export function inspectSandboxHost(environment: NodeJS.ProcessEnv = process.env) {
  const securityOptions = JSON.parse(dockerOutput("{{json .SecurityOptions}}")) as string[];
  const runtimes = dockerOutput("{{range $name, $_ := .Runtimes}}{{println $name}}{{end}}")
    .split(/\s+/u)
    .filter(Boolean);
  return {
    securityOptions,
    runtimes,
    workspace: pathStatus(environment.OPENGUI_WORKSPACE),
    deployKey: pathStatus(environment.OPENGUI_GITHUB_DEPLOY_KEY_FILE),
    knownHosts: pathStatus(environment.OPENGUI_GITHUB_KNOWN_HOSTS_FILE),
  } satisfies SandboxHostInspection;
}

function main() {
  try {
    const findings = sandboxHostFindings(inspectSandboxHost());
    if (findings.length > 0) {
      console.error("Sandbox Host is not ready:");
      for (const finding of findings) console.error(`- ${finding}`);
      process.exitCode = 1;
      return;
    }
    console.info("Sandbox Host is ready: rootless Docker, runsc, workspace, and GitHub files OK");
  } catch (error) {
    console.error(
      `Sandbox Host inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
