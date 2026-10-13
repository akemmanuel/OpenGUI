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
  /** Unset for deployments that do not configure the separate shell broker. */
  shellImageAvailable?: boolean;
};

export type DockerCommand = (arguments_: string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
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
  if (inspection.shellImageAvailable === false) {
    findings.push("OPENGUI_SHELL_IMAGE is not available in the selected Docker daemon");
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

const runDocker: DockerCommand = (arguments_) => {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function dockerOutput(format: string, docker: DockerCommand) {
  const result = docker(["info", "--format", format]);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "docker info failed");
  }
  return result.stdout.trim();
}

export function inspectSandboxHost(
  environment: NodeJS.ProcessEnv = process.env,
  docker: DockerCommand = runDocker,
) {
  const securityOptions = JSON.parse(dockerOutput("{{json .SecurityOptions}}", docker)) as string[];
  const runtimes = dockerOutput("{{range $name, $_ := .Runtimes}}{{println $name}}{{end}}", docker)
    .split(/\s+/u)
    .filter(Boolean);
  const image = environment.OPENGUI_SHELL_IMAGE;
  let shellImageAvailable: boolean | undefined;
  if (image !== undefined) {
    const result = docker(["image", "inspect", "--format", "{{.Id}}", "--", image]);
    shellImageAvailable =
      result.status === 0 && /^sha256:[a-f0-9]{64}$/u.test(result.stdout.trim());
  }
  return {
    securityOptions,
    runtimes,
    workspace: pathStatus(environment.OPENGUI_WORKSPACE),
    deployKey: pathStatus(environment.OPENGUI_GITHUB_DEPLOY_KEY_FILE),
    knownHosts: pathStatus(environment.OPENGUI_GITHUB_KNOWN_HOSTS_FILE),
    shellImageAvailable,
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
    console.info(
      "Sandbox Host preflight passed: Docker, runsc, files, and any configured shell image OK. " +
        "This is not proof of usable shell execution; run an authenticated restricted-grant probe.",
    );
  } catch (error) {
    console.error(
      `Sandbox Host inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
