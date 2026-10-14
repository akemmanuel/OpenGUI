import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type Grant = { root: string; access: "read" | "write" };
type ExecuteRequest = {
  projectDirectory: string;
  grants: Grant[];
  input: { command?: unknown; timeout?: unknown };
};
type DeployCredential = { root: string; key: string; knownHosts: string };
type ShellResult = {
  command: string | undefined;
  shell: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
};
export type SandboxExecution = (
  args: string[],
  name: string,
  timeoutSeconds: number,
  signal: AbortSignal,
) => Promise<ShellResult>;

/** Constant-time bearer check; hashing first equalizes lengths. */
export function bearerMatches(header: string | undefined, token: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}

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
  cgroupParent?: string;
}) {
  const args = [
    "run",
    "--pull=never",
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
    "--memory-swap",
    "2g",
    "--shm-size",
    "128m",
    "--cpus",
    "1.5",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=512m",
    "--tmpfs",
    "/home/opengui:rw,nosuid,nodev,size=128m",
    "-e",
    "HOME=/home/opengui",
    "-e",
    "CHROMIUM_PATH=/usr/bin/chromium",
    "-e",
    "OPENGUI_PLAYWRIGHT_MODULE=/opt/opengui-tools/node_modules/playwright/index.mjs",
    "-e",
    "PATH=/opt/opengui-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    "-e",
    "ASTRO_TELEMETRY_DISABLED=1",
    "--mount",
    `type=bind,src=${input.resolvConf},dst=/etc/resolv.conf,readonly`,
  ];
  if (input.cgroupParent) {
    if (!/^[a-zA-Z0-9_.-]+\.slice$/.test(input.cgroupParent))
      throw new Error("Invalid cgroup parent");
    args.push("--cgroup-parent", input.cgroupParent);
  }
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
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
  ) {
    throw new Error("Invalid timeout");
  }
  if (!Array.isArray(request.grants) || request.grants.length > 64)
    throw new Error("Invalid grants");
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
    timeoutSeconds: Math.min(900, typeof timeout === "number" ? timeout : 30),
    projectDirectory,
    grants,
  };
}

async function removeContainer(name: string) {
  await new Promise<void>((resolve) => {
    execFile("docker", ["rm", "-f", name], { timeout: 10_000 }, () => resolve());
  });
}

export async function executeSandbox(
  args: string[],
  name: string,
  timeoutSeconds: number,
  signal: AbortSignal,
  dependencies: {
    spawn?: (args: string[]) => ChildProcess;
    remove?: (name: string) => Promise<void>;
    maxOutputBytes?: number;
  } = {},
): Promise<ShellResult> {
  if (signal.aborted)
    return {
      command: args.at(-1),
      shell: "/bin/sh",
      exitCode: null,
      signal: null,
      output: "",
      truncated: false,
      timedOut: false,
      aborted: true,
    };
  const child = (
    dependencies.spawn ?? ((input) => spawn("docker", input, { stdio: ["ignore", "pipe", "pipe"] }))
  )(args);
  const limit = dependencies.maxOutputBytes ?? 64 * 1024;
  let tail = Buffer.alloc(0);
  let truncated = false;
  const capture = (chunk: Buffer) => {
    truncated ||= tail.length + chunk.length > limit;
    // Never retain a whole oversized chunk or an unbounded chunk list.
    tail =
      chunk.length >= limit
        ? Buffer.from(chunk.subarray(-limit))
        : Buffer.concat([tail.subarray(-Math.max(0, limit - chunk.length)), chunk]);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let closed = false;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", (error) => {
        closed = true;
        reject(error);
      });
      child.once("close", (code, exitSignal) => {
        closed = true;
        resolve({ code, signal: exitSignal });
      });
    },
  );
  let timedOut = false;
  let removal: Promise<void> | undefined;
  const cancel = () => {
    removal ??= (async () => {
      const deadline = Date.now() + 15_000;
      // Cancellation can race Docker's container creation. Retry the exact name
      // until the client exits; never search for or remove unrelated containers.
      do {
        await (dependencies.remove ?? removeContainer)(name);
        if (!closed) await delay(100);
      } while (!closed && Date.now() < deadline);
      if (!closed) {
        child.kill("SIGKILL");
        await (dependencies.remove ?? removeContainer)(name);
      }
    })();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, timeoutSeconds * 1000);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  let result;
  try {
    result = await completion;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    await removal;
  }
  return {
    command: args.at(-1),
    shell: "/bin/sh",
    exitCode: result.code,
    signal: result.signal,
    output: tail.toString("utf8"),
    truncated,
    timedOut,
    aborted: signal.aborted,
  };
}

export function createSandboxBroker(options: {
  image: string;
  allowedRoots: string[];
  resolvConf: string;
  token?: string;
  credentials?: DeployCredential[];
  maxConcurrent?: number;
  maxBodyBytes?: number;
  cgroupParent?: string;
  execute?: SandboxExecution;
}) {
  const maxConcurrent = options.maxConcurrent ?? 16;
  const maxBodyBytes = options.maxBodyBytes ?? 128 * 1024;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16)
    throw new Error("Invalid broker concurrency");
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1)
    throw new Error("Invalid broker body limit");
  const active = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const reject = (status: number) => {
      response
        .writeHead(status, { "content-type": "application/json", connection: "close" })
        .end(JSON.stringify({ denied: true, error: "Sandbox shell request was rejected" }));
    };
    if (request.method !== "POST" || request.url !== "/v1/execute") {
      reject(404);
      return;
    }
    if (options.token && !bearerMatches(request.headers.authorization, options.token)) {
      reject(401);
      return;
    }
    if (active.size >= maxConcurrent) {
      reject(429);
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    const abort = () => {
      if (!response.writableFinished) controller.abort();
    };
    request.once("aborted", abort);
    response.once("close", abort);
    let status = 400;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > maxBodyBytes) {
          status = 413;
          throw new Error("Request too large");
        }
        chunks.push(chunk as Buffer);
      }
      const parsed = parseRequest(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
        options.allowedRoots,
      );
      const credential = options.credentials?.find(
        (item) =>
          contains(realpathSync(item.root), parsed.projectDirectory) &&
          parsed.grants.some(
            (grant) => grant.access === "write" && contains(grant.root, realpathSync(item.root)),
          ),
      );
      const name = `opengui-shell-${randomUUID()}`;
      const result = await (options.execute ?? executeSandbox)(
        sandboxDockerArguments({
          image: options.image,
          name,
          credential,
          resolvConf: options.resolvConf,
          cgroupParent: options.cgroupParent,
          ...parsed,
        }),
        name,
        parsed.timeoutSeconds,
        controller.signal,
      );
      if (!controller.signal.aborted)
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch {
      if (!response.destroyed) reject(status);
    } finally {
      active.delete(controller);
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 2000;
  server.on("shutdown", () => {
    for (const controller of active) controller.abort();
  });
  return server;
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
  if (host && !token) throw new Error("Network broker requires authentication");
  if (!host && existsSync(socket)) rmSync(socket);
  const server = createSandboxBroker({
    image,
    allowedRoots,
    credentials,
    resolvConf,
    token,
    maxConcurrent: Number(process.env.OPENGUI_SHELL_MAX_CONCURRENT || 16),
    cgroupParent: process.env.OPENGUI_SHELL_CGROUP_PARENT,
  });
  const shutdown = () => {
    server.emit("shutdown");
    server.close();
    server.closeIdleConnections();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
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
