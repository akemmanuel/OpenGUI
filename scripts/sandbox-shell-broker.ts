import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type Grant = { root: string; access: "read" | "write" };
type ExecuteRequest = {
  projectDirectory: string;
  grants: Grant[];
  input: { command?: unknown; timeout?: unknown };
};
type DeployCredential = { root: string; key: string; knownHosts: string };

function contains(root: string, path: string) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("../") && value !== ".." && !isAbsolute(value));
}

export function sandboxDockerArguments(input: {
  image: string;
  name: string;
  projectDirectory: string;
  grants: Grant[];
  credential?: DeployCredential;
  resolvConf: string;
  command: string;
}) {
  const args = [
    "run",
    "--rm",
    "--name",
    input.name,
    "--runtime",
    "runsc",
    "--read-only",
    "--network",
    "bridge",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "1.5",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=256m",
    "--tmpfs",
    "/home/opengui:rw,nosuid,nodev,size=512m",
    "-e",
    "HOME=/home/opengui",
    "--mount",
    `type=bind,src=${input.resolvConf},dst=/etc/resolv.conf,readonly`,
  ];
  for (const grant of input.grants) {
    args.push(
      "--mount",
      `type=bind,src=${grant.root},dst=${grant.root}${grant.access === "read" ? ",readonly" : ""}`,
    );
  }
  if (input.credential) {
    args.push(
      "--mount",
      `type=bind,src=${input.credential.key},dst=/run/secrets/github_deploy_key,readonly`,
      "--mount",
      `type=bind,src=${input.credential.knownHosts},dst=/run/secrets/github_known_hosts,readonly`,
      "-e",
      "GIT_SSH_COMMAND=ssh -i /run/secrets/github_deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/run/secrets/github_known_hosts -o StrictHostKeyChecking=yes",
    );
  }
  args.push("-w", input.projectDirectory, input.image, "/bin/sh", "-lc", input.command);
  return args;
}

function parseRequest(value: unknown, allowedRoots: string[]) {
  if (!value || typeof value !== "object") throw new Error("Invalid request");
  const request = value as ExecuteRequest;
  const command = request.input?.command;
  if (typeof command !== "string" || !command.trim()) throw new Error("Invalid command");
  const timeout = request.input.timeout;
  if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0)) {
    throw new Error("Invalid timeout");
  }
  const grants = request.grants.map((grant) => {
    if (grant.access !== "read" && grant.access !== "write") throw new Error("Invalid grant");
    const root = realpathSync(grant.root);
    if (root.includes(",") || !allowedRoots.some((allowed) => contains(allowed, root))) {
      throw new Error("Grant is outside allowed roots");
    }
    return { root, access: grant.access };
  });
  const projectDirectory = realpathSync(request.projectDirectory);
  if (!grants.some((grant) => contains(grant.root, projectDirectory))) {
    throw new Error("Project is outside grants");
  }
  return {
    command,
    timeoutSeconds: Math.min(5_000, typeof timeout === "number" ? timeout : 30),
    projectDirectory,
    grants,
  };
}

async function execute(args: string[], name: string, timeoutSeconds: number) {
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const capture = (chunk: Buffer) => {
    chunks.push(chunk);
    bytes += chunk.length;
    while (bytes > 4 * 1024 && chunks.length > 1) bytes -= chunks.shift()!.length;
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  }, timeoutSeconds * 1_000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  ).finally(() => clearTimeout(timer));
  return {
    command: args.at(-1),
    shell: "/bin/sh",
    exitCode: result.code,
    signal: result.signal,
    output: Buffer.concat(chunks)
      .subarray(-4 * 1024)
      .toString("utf8"),
    truncated: bytes > 4 * 1024,
    timedOut,
    aborted: false,
  };
}

function main() {
  const socket = process.env.OPENGUI_SHELL_BROKER_SOCKET || "/run/opengui-shell-broker.sock";
  const host = process.env.OPENGUI_SHELL_BROKER_HOST;
  const port = Number(process.env.OPENGUI_SHELL_BROKER_PORT || 0);
  const token = process.env.OPENGUI_SHELL_BROKER_TOKEN;
  const image = process.env.OPENGUI_SHELL_IMAGE;
  if (!image) throw new Error("OPENGUI_SHELL_IMAGE is required");
  const allowedRoots = (process.env.OPENGUI_SHELL_ALLOWED_ROOTS || "")
    .split(",")
    .filter(Boolean)
    .map((path) => realpathSync(path));
  if (!allowedRoots.length) throw new Error("OPENGUI_SHELL_ALLOWED_ROOTS is required");
  const credentials = JSON.parse(
    process.env.OPENGUI_SHELL_DEPLOY_CREDENTIALS || "[]",
  ) as DeployCredential[];
  const resolvConf = realpathSync(process.env.OPENGUI_SHELL_RESOLV_CONF || "/etc/resolv.conf");
  if (existsSync(socket)) rmSync(socket);
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/execute") {
      response.writeHead(404).end();
      return;
    }
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const parsed = parseRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")), allowedRoots);
      const credential = credentials.find((item) =>
        contains(realpathSync(item.root), parsed.projectDirectory),
      );
      const name = `opengui-shell-${randomUUID()}`;
      const result = await execute(
        sandboxDockerArguments({ image, name, credential, resolvConf, ...parsed }),
        name,
        parsed.timeoutSeconds,
      );
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ denied: true, error: "Sandbox shell request was rejected" }));
    }
  });
  if (host && port > 0) {
    server.listen(port, host, () =>
      console.info(`OpenGUI shell broker listening on ${host}:${port}`),
    );
  } else {
    server.listen(socket, () => {
      chmodSync(socket, 0o660);
      console.info(`OpenGUI shell broker listening on ${socket}`);
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
