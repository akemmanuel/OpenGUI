import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  createSandboxBroker,
  executeSandbox,
  sandboxDockerArguments,
  type SandboxExecution,
} from "./sandbox-shell-broker.ts";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opengui-broker-")));
  directories.push(root);
  return root;
}

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1/execute`;
}

function okResult(command = "pwd") {
  return {
    command,
    shell: "/bin/sh",
    exitCode: 0,
    signal: null,
    output: "ok",
    truncated: false,
    timedOut: false,
    aborted: false,
  };
}

function body(root: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    projectDirectory: root,
    grants: [{ root, access: "write" }],
    input: { command: "pwd" },
    ...extra,
  });
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(signal: string) {
    this.killed.push(signal);
    return true;
  }
}

describe("sandbox shell broker", () => {
  test("mounts only effective grants and preserves access modes", () => {
    const args = sandboxDockerArguments({
      image: "shell-image",
      name: "call-1",
      projectDirectory: "/work/client/site",
      resolvConf: "/etc/resolv.conf",
      grants: [
        { root: "/work/client", access: "write" },
        { root: "/reference", access: "read" },
      ],
      command: "git status",
    });
    expect(args).toContain("type=bind,src=/work/client,dst=/work/client");
    expect(args).toContain("type=bind,src=/reference,dst=/reference,readonly");
    expect(args).toContain("--pull=never");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain("/app/.opengui-data");
    expect(args.slice(-5)).toEqual([
      "/work/client/site",
      "shell-image",
      "/bin/sh",
      "-lc",
      "git status",
    ]);
  });

  test("places shells in a validated cgroup slice", () => {
    const base = {
      image: "shell-image",
      name: "call-1",
      projectDirectory: "/work",
      resolvConf: "/etc/resolv.conf",
      grants: [{ root: "/work", access: "write" as const }],
      command: "true",
    };
    const args = sandboxDockerArguments({ ...base, cgroupParent: "opengui-workloads.slice" });
    expect(args[args.indexOf("--cgroup-parent") + 1]).toBe("opengui-workloads.slice");
    expect(() => sandboxDockerArguments({ ...base, cgroupParent: "../escape" })).toThrow(
      "Invalid cgroup parent",
    );
  });

  test("rejects unauthenticated requests and unknown routes", async () => {
    const root = await workspace();
    const endpoint = await listen(
      createSandboxBroker({
        image: "shell-image",
        allowedRoots: [root],
        resolvConf: "/etc/resolv.conf",
        token: "secret",
        execute: async () => okResult(),
      }),
    );
    expect((await fetch(endpoint, { method: "POST", body: body(root) })).status).toBe(401);
    for (const authorization of ["Bearer secre", "Bearer secret2", "bearer secret"]) {
      const denied = await fetch(endpoint, {
        method: "POST",
        headers: { authorization },
        body: body(root),
      });
      expect(denied.status).toBe(401);
    }
    expect(
      (await fetch(endpoint.replace("/v1/execute", "/other"), { method: "POST" })).status,
    ).toBe(404);
    const ok = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: body(root),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ exitCode: 0, output: "ok" });
  });

  test("answers 429 before execution once every slot is busy", async () => {
    const root = await workspace();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const execute: SandboxExecution = async () => {
      started += 1;
      await gate;
      return okResult();
    };
    const endpoint = await listen(
      createSandboxBroker({
        image: "shell-image",
        allowedRoots: [root],
        resolvConf: "/etc/resolv.conf",
        maxConcurrent: 1,
        execute,
      }),
    );
    const first = fetch(endpoint, { method: "POST", body: body(root) });
    await expect.poll(() => started).toBe(1);
    const second = await fetch(endpoint, { method: "POST", body: body(root) });
    expect(second.status).toBe(429);
    expect(started).toBe(1);
    release();
    expect((await first).status).toBe(200);
  });

  test("refuses oversized bodies and grants outside allowed roots", async () => {
    const root = await workspace();
    const outside = await workspace();
    const endpoint = await listen(
      createSandboxBroker({
        image: "shell-image",
        allowedRoots: [root],
        resolvConf: "/etc/resolv.conf",
        maxBodyBytes: 512,
        execute: async () => okResult(),
      }),
    );
    const large = await fetch(endpoint, {
      method: "POST",
      body: body(root, { input: { command: "x".repeat(2048) } }),
    });
    expect(large.status).toBe(413);
    const escaped = await fetch(endpoint, { method: "POST", body: body(outside) });
    expect(escaped.status).toBe(400);
  });

  test("validates concurrency bounds", () => {
    for (const maxConcurrent of [0, 17, 1.5]) {
      expect(() =>
        createSandboxBroker({
          image: "shell-image",
          allowedRoots: ["/"],
          resolvConf: "/etc/resolv.conf",
          maxConcurrent,
        }),
      ).toThrow("Invalid broker concurrency");
    }
  });
});

describe("sandbox shell execution", () => {
  test("keeps a bounded output tail and reports truncation", async () => {
    const child = new FakeChild();
    const pending = executeSandbox(["run", "echo"], "shell-1", 30, new AbortController().signal, {
      spawn: () => child as unknown as ChildProcess,
      remove: async () => {},
      maxOutputBytes: 8,
    });
    child.stdout.emit("data", Buffer.from("0123456789"));
    child.stderr.emit("data", Buffer.from("ab"));
    child.emit("close", 0, null);
    const result = await pending;
    expect(result.output).toBe("456789ab");
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("abort removes exactly the invocation container", async () => {
    const child = new FakeChild();
    const removed: string[] = [];
    const controller = new AbortController();
    const pending = executeSandbox(["run", "sleep"], "shell-2", 30, controller.signal, {
      spawn: () => child as unknown as ChildProcess,
      remove: async (name) => {
        removed.push(name);
        child.emit("close", null, "SIGKILL");
      },
    });
    controller.abort();
    const result = await pending;
    expect(removed).toEqual(["shell-2"]);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  test("already-aborted requests never spawn docker", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const result = await executeSandbox(["run"], "shell-3", 30, controller.signal, {
      spawn: () => {
        spawned = true;
        return new FakeChild() as unknown as ChildProcess;
      },
    });
    expect(spawned).toBe(false);
    expect(result.aborted).toBe(true);
  });
});
