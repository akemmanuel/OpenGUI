/**
 * OS-level CLI contract tests: real flock(1), fake docker(1) on PATH, no daemon.
 * Each test spawns the lifecycle CLI as an async child process (spawn, never
 * spawnSync) so in-test fake webhook/broker servers stay reachable while the
 * CLI runs. All spawns carry bounded timeouts.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { terminateDetachedProcessTree } from "./process-tree.ts";

const SCRIPT = fileURLToPath(new URL("./sandbox-shell-lifecycle.ts", import.meta.url));
const ID_A = `sha256:${"a".repeat(64)}`;
const ID_B = `sha256:${"b".repeat(64)}`;
const ID_C = `sha256:${"c".repeat(64)}`;
const ID_X = `sha256:${"d".repeat(64)}`;
const SPAWN_TIMEOUT = 55_000;

type Root = { dir: string; fakeBin: string; log: string; lock: string };
type CliResult = { status: number | null; stdout: string; stderr: string };

function makeRoot(): Root {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-cli-"));
  chmodSync(dir, 0o700);
  const root = {
    dir,
    fakeBin: join(dir, "bin"),
    log: join(dir, "docker.log"),
    lock: join(dir, "lifecycle.lock"),
  };
  roots.push(root);
  return root;
}

const FAKE_DOCKER = String.raw`#!/bin/bash
echo "docker $*" >> "$FAKE_DOCKER_LOG"
ref="${"$"}{@: -1}"
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  if [ "$FAKE_MODE" != "cleanup" ] && [ "$FAKE_IMAGE" = "missing" ]; then
    echo "Error: No such image: $ref" >&2; exit 1
  fi
  if [ -n "$FAKE_STDERR_PATH" ]; then
    echo "Error: No such image: $FAKE_STDERR_PATH" >&2; exit 1
  fi
  case "$ref" in
    "fixture/app:1") id="$FAKE_ID_A" ;;
    "fixture/app:2")
      if [ "$FAKE_KNOWN_GOOD" = "missing" ]; then echo "Error: No such image: $ref" >&2; exit 1; fi
      id="$FAKE_ID_X" ;;
    "fixture/app:new") id="$FAKE_ID_B" ;;
    "$FAKE_ID_A"|"$FAKE_ID_B"|"$FAKE_ID_C"|"$FAKE_ID_X") id="$ref" ;;
    *) echo "Error: No such image: $ref" >&2; exit 1 ;;
  esac
  case "$*" in
    *'{{.Id}}'*) echo "$id"; exit 0 ;;
    *'RepoDigests'*) echo "[\"${"$"}{FAKE_REPO_DIGESTS:-fixture/app@sha256:deadbeef}\"]"; exit 0 ;;
    *'Config.Labels'*) echo "${"$"}{FAKE_LABELS_JSON:-{}}"; exit 0 ;;
    *'{{json .}}'*)
      case "$ref" in
        "$FAKE_ID_A") echo "{\"Id\":\"$FAKE_ID_A\",\"RepoTags\":[\"fixture/app:1\"],\"RepoDigests\":[\"fixture/app@sha256:deadbeef\"],\"Config\":{\"Labels\":{}}}" ;;
        "$FAKE_ID_B") echo "{\"Id\":\"$FAKE_ID_B\",\"RepoTags\":[\"fixture/disposable:t1\"],\"RepoDigests\":[],\"Config\":{\"Labels\":{\"opengui.shell.disposable\":\"true\"}}}" ;;
        "$FAKE_ID_C")
          if [ "$FAKE_SHORT" = "1" ]; then
            echo '{"Id":"abc123","RepoTags":[],"RepoDigests":[],"Config":{"Labels":{"opengui.shell.disposable":"true"}}}'
          else
            echo "{\"Id\":\"$FAKE_ID_C\",\"RepoTags\":[\"unrelated/app:9\"],\"RepoDigests\":[],\"Config\":{\"Labels\":{}}}"
          fi ;;
        *) echo "Error: No such image: $ref" >&2; exit 1 ;;
      esac
      exit 0 ;;
  esac
  echo "$id"; exit 0
fi
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  if [ "$ref" != "$FAKE_KEEPER_NAME" ]; then
    echo "Error: No such container: $ref" >&2; exit 1
  fi
  case "$FAKE_KEEPER" in
    absent) echo "Error: No such container: $ref" >&2; exit 1 ;;
    matching) echo "[{\"Name\":\"/$ref\",\"Image\":\"$FAKE_ID_A\",\"State\":{\"Running\":false},\"Config\":{\"Image\":\"fixture/app:1\",\"Labels\":{\"opengui.shell.keeper\":\"true\",\"opengui.shell.image\":\"$FAKE_ID_A\"}}}]" ;;
    collision) echo "[{\"Name\":\"/$ref\",\"Image\":\"$FAKE_ID_C\",\"State\":{\"Running\":false},\"Config\":{\"Image\":\"other/app:9\",\"Labels\":{}}}]" ;;
    unlabeled) echo "[{\"Name\":\"/$ref\",\"Image\":\"$FAKE_ID_A\",\"State\":{\"Running\":false},\"Config\":{\"Image\":\"fixture/app:1\",\"Labels\":{}}}]" ;;
    mismatch) echo "[{\"Name\":\"/$ref\",\"Image\":\"$FAKE_ID_B\",\"State\":{\"Running\":false},\"Config\":{\"Image\":\"fixture/app:new\",\"Labels\":{\"opengui.shell.keeper\":\"true\",\"opengui.shell.image\":\"$FAKE_ID_B\"}}}]" ;;
    running) echo "[{\"Name\":\"/$ref\",\"Image\":\"$FAKE_ID_A\",\"State\":{\"Running\":true},\"Config\":{\"Image\":\"fixture/app:1\",\"Labels\":{\"opengui.shell.keeper\":\"true\",\"opengui.shell.image\":\"$FAKE_ID_A\"}}}]" ;;
  esac
  exit 0
fi
if [ "$1" = "create" ]; then echo "keeper-container-id"; exit 0; fi
if [ "$1" = "images" ]; then
  if [ "$FAKE_MODE" = "cleanup" ]; then
    echo "{\"ID\":\"$FAKE_ID_A\",\"Repository\":\"fixture/app\",\"Tag\":\"1\"}"
    echo "{\"ID\":\"$FAKE_ID_B\",\"Repository\":\"fixture/disposable\",\"Tag\":\"t1\"}"
    echo "{\"ID\":\"$FAKE_ID_C\",\"Repository\":\"unrelated/app\",\"Tag\":\"9\"}"
  fi
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "rm" ]; then exit 0; fi
if [ "$1" = "info" ]; then echo "runc"; echo "runsc"; exit 0; fi
echo "fake docker: unexpected $*" >&2; exit 1
`;

function writeFakeDocker(root: Root): void {
  mkdirSync(root.fakeBin, { recursive: true });
  writeFileSync(join(root.fakeBin, "docker"), FAKE_DOCKER, { mode: 0o755 });
}

function baseEnv(root: Root, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${root.fakeBin}:/usr/bin:/bin`,
    FAKE_DOCKER_LOG: root.log,
    FAKE_ID_A: ID_A,
    FAKE_ID_B: ID_B,
    FAKE_ID_C: ID_C,
    FAKE_ID_X: ID_X,
    FAKE_IMAGE: "present",
    FAKE_KEEPER: "absent",
    FAKE_KEEPER_NAME: "opengui-shell-image-keepalive",
    OPENGUI_SHELL_IMAGE: "fixture/app:1",
    OPENGUI_SHELL_LIFECYCLE_LOCK: root.lock,
    ...overrides,
  };
}

const roots: Root[] = [];

function runCli(
  root: Root,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  writeFakeDocker(root);
  return new Promise((resolve) => {
    // Detached so the recorded process group covers the CLI and any short-lived
    // grandchildren; the timeout below terminates the whole group, never orphans.
    const child = spawn(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
      env: { ...process.env, ...baseEnv(root), ...extraEnv },
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      void terminateDetachedProcessTree(child.pid, { force: true });
    }, SPAWN_TIMEOUT);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function dockerLog(root: Root): string {
  return existsSync(root.log) ? readFileSync(root.log, "utf8") : "";
}

const holders: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const holder of holders.splice(0)) {
    await terminateDetachedProcessTree(holder.pid, { force: true });
    await new Promise<void>((resolve) => {
      if (holder.exitCode !== null || holder.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 5000);
      holder.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  for (const root of roots.splice(0)) {
    try {
      rmSync(root.dir, { recursive: true });
    } catch {
      // Best effort: assertions already ran against these roots.
    }
  }
});

function holdLock(lockPath: string): Promise<ReturnType<typeof spawn>> {
  return new Promise((resolve, reject) => {
    // Own process group so cleanup terminates the holder and its sleep child.
    const holder = spawn("flock", [lockPath, "sleep", "30"], {
      stdio: "ignore",
      detached: true,
    });
    holders.push(holder);
    holder.once("error", reject);
    setTimeout(resolve, 500, holder);
  });
}

describe("lifecycle lock contract (real flock, fake docker)", () => {
  test("lock contention prevents execution and runs zero docker commands", async () => {
    const root = makeRoot();
    await holdLock(root.lock);
    const result = await runCli(root, ["retain", "--apply"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/contended/i);
    expect(dockerLog(root)).toBe("");
  });

  test("spoofed lock env cannot bypass real supervision", async () => {
    const root = makeRoot();
    await holdLock(root.lock);
    const result = await runCli(root, ["retain", "--apply"], { OPENGUI_LIFECYCLE_LOCK_HELD: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/contended/i);
    expect(dockerLog(root)).toBe("");
  });

  test("direct internal apply without a supervising lock is refused", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["__apply", "retain", "--apply"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/supervis/i);
    expect(dockerLog(root)).toBe("");
  });

  test("direct internal apply cannot borrow another process's held lock", async () => {
    const root = makeRoot();
    await holdLock(root.lock);
    const result = await runCli(root, ["__apply", "retain", "--apply"]);
    expect(result.status).toBe(2);
    expect(dockerLog(root)).toBe("");
  });

  test("healthy retain runs inside a real held lock", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["retain", "--apply"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/keeper created|nothing to do/i);
    expect(dockerLog(root)).toMatch(/docker create .*opengui-shell-image-keepalive/);
    const createLine = dockerLog(root)
      .split("\n")
      .find((line) => line.startsWith("docker create "));
    // Pin the inspected image even if its tag moves, without an implicit pull.
    expect(createLine?.endsWith(ID_A)).toBe(true);
    expect(createLine).toContain("--pull=never");
  });

  test("child operational failure is not misreported as lock contention", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["retain", "--apply"], { FAKE_IMAGE: "missing" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/image_missing/);
    expect(result.stderr).not.toMatch(/contended/i);
  });

  test("sequential transitions each acquire and release the lock", async () => {
    const root = makeRoot();
    const failed = await runCli(root, ["retain", "--apply"], { FAKE_IMAGE: "missing" });
    expect(failed.status).toBe(1);
    const ok = await runCli(root, ["retain", "--apply"]);
    expect(ok.status).toBe(0);
    expect(dockerLog(root)).toMatch(/docker create .*opengui-shell-image-keepalive/);
  });
});

describe("retain keeper states (fake docker)", () => {
  test("collision refuses without attempting create", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["retain", "--apply"], { FAKE_KEEPER: "collision" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/keeper_collision/);
    expect(dockerLog(root)).not.toMatch(/docker create/);
  });

  test("mismatch refuses and guides a new-name transition", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["retain", "--apply"], { FAKE_KEEPER: "mismatch" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/keeper_mismatch/);
    expect(result.stderr).toMatch(/--keeper/);
    expect(dockerLog(root)).not.toMatch(/docker create/);
  });

  test("running keeper is refused and never started", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["retain", "--apply"], { FAKE_KEEPER: "running" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/keeper_running/);
    expect(dockerLog(root)).not.toMatch(/docker create/);
    expect(dockerLog(root)).not.toMatch(/docker start/);
  });

  test("unlabeled pre-existing keeper requires explicit migration, never adoption", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["retain", "--apply"], { FAKE_KEEPER: "unlabeled" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/migrat/i);
    expect(dockerLog(root)).not.toMatch(/docker create/);
    expect(dockerLog(root)).not.toMatch(/docker rm/);
  });

  test("new-name keeper transition creates a labeled keeper without touching the old one", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["retain", "--apply", "--keeper", "opengui-shell-next"], {
      FAKE_KEEPER: "mismatch",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/keeper created/i);
    const log = dockerLog(root);
    expect(log).toMatch(/docker create .*--name opengui-shell-next/);
    expect(log).toMatch(/opengui\.shell\.keeper=true/);
    expect(log).not.toMatch(/docker rm/);
  });
});

describe("scoped cleanup against realistic docker output", () => {
  const cleanupEnv = { FAKE_MODE: "cleanup", FAKE_KEEPER: "matching" };

  test("dry run previews exactly one eligible full-ID removal", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["cleanup"], cleanupEnv);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`would run: docker image rm -- ${ID_B}`));
    expect(result.stdout).not.toContain(ID_C);
    expect(dockerLog(root)).not.toMatch(/docker image rm/);
  });

  test("apply removes only the eligible image, never protected or foreign", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["cleanup", "--apply"], cleanupEnv);
    expect(result.status).toBe(0);
    const log = dockerLog(root);
    expect(log).toMatch(new RegExp(`docker image rm -- ${ID_B}`));
    expect(log).not.toContain(`image rm -- ${ID_A}`);
    expect(log).not.toContain(`image rm -- ${ID_C}`);
    expect(log).not.toMatch(/prune/);
  });

  test("unresolvable protected reference fails closed with zero removals", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["cleanup", "--apply"], {
      ...cleanupEnv,
      FAKE_KNOWN_GOOD: "missing",
      OPENGUI_SHELL_KNOWN_GOOD_IMAGE: "fixture/app:2",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/protected|resolve|fail closed/i);
    expect(dockerLog(root)).not.toMatch(/docker image rm/);
  });

  test("non-conforming candidate IDs are never removed", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["cleanup", "--apply"], { ...cleanupEnv, FAKE_SHORT: "1" });
    expect(result.status).toBe(0);
    const log = dockerLog(root);
    expect(log).toMatch(new RegExp(`docker image rm -- ${ID_B}`));
    expect(log).not.toMatch(/image rm -- abc123/);
  });
});

describe("restore-verify relationship proof", () => {
  function archiveFixture(root: Root, bytes: string): { path: string; sha: string } {
    const path = join(root.dir, "shell-image.tar");
    writeFileSync(path, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    return { path, sha };
  }

  test("matching archive and loaded image report two separate facts", async () => {
    const root = makeRoot();
    const archive = archiveFixture(root, "fake-image-bytes");
    const result = await runCli(root, ["restore-verify"], {
      FAKE_KEEPER: "matching",
      OPENGUI_SHELL_RESTORE_ARCHIVE: archive.path,
      OPENGUI_SHELL_RESTORE_ARCHIVE_SHA256: archive.sha,
      OPENGUI_SHELL_RESTORE_IMAGE: "fixture/app:1",
      OPENGUI_SHELL_RESTORE_IMAGE_DIGEST: "fixture/app@sha256:deadbeef",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/archive checksum matches/i);
    expect(result.stdout).toMatch(/loaded image digest matches/i);
  });

  test("related archive with unrelated loaded digest fails closed", async () => {
    const root = makeRoot();
    const archive = archiveFixture(root, "fake-image-bytes");
    const result = await runCli(root, ["restore-verify"], {
      OPENGUI_SHELL_RESTORE_ARCHIVE: archive.path,
      OPENGUI_SHELL_RESTORE_ARCHIVE_SHA256: archive.sha,
      OPENGUI_SHELL_RESTORE_IMAGE: "fixture/app:1",
      OPENGUI_SHELL_RESTORE_IMAGE_DIGEST: "fixture/app@sha256:unrelated",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/restore_digest_mismatch/);
  });

  test("tampered archive fails on checksum before image comparison", async () => {
    const root = makeRoot();
    const archive = archiveFixture(root, "fake-image-bytes");
    const result = await runCli(root, ["restore-verify"], {
      OPENGUI_SHELL_RESTORE_ARCHIVE: archive.path,
      OPENGUI_SHELL_RESTORE_ARCHIVE_SHA256: "0".repeat(64),
      OPENGUI_SHELL_RESTORE_IMAGE: "fixture/app:1",
      OPENGUI_SHELL_RESTORE_IMAGE_DIGEST: "fixture/app@sha256:deadbeef",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/restore_checksum_mismatch/);
  });
});

describe("diagnostic secrecy in real CLI output", () => {
  test("unresolvable protected references are not echoed to diagnostics", async () => {
    const root = makeRoot();
    const privateReference = "/private/customer-path/credential-like-image";
    const result = await runCli(root, ["cleanup"], {
      OPENGUI_SHELL_KNOWN_GOOD_IMAGE: privateReference,
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(privateReference);
    expect(dockerLog(root)).not.toMatch(/docker image rm/);
  });
  test("raw docker stderr paths never reach normal diagnostics", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["check"], {
      FAKE_IMAGE: "present",
      FAKE_STDERR_PATH: "/root/secret/customer-path/image:1",
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("/root/secret/customer-path");
  });
});

describe("probe fixture lifecycle", () => {
  test("fixture initialization refuses an existing non-fixture directory without changing it", async () => {
    const root = makeRoot();
    const fixture = join(root.dir, "existing-project");
    mkdirSync(fixture, { mode: 0o755 });
    // chmod ignores umask, so the stand-in really is 0755 in any environment;
    // the assertions below (unchanged mode/children/content) are untouched.
    chmodSync(fixture, 0o755);
    writeFileSync(join(fixture, "customer-fixture.txt"), "must not change");
    const result = await runCli(root, ["probe", "--init-fixture"], {
      OPENGUI_SHELL_SANDBOX_ENDPOINT: "http://127.0.0.1:9",
      OPENGUI_SHELL_PROBE_FIXTURE_ROOT: fixture,
    });
    expect(result.status).not.toBe(0);
    expect(statSync(fixture).mode & 0o777).toBe(0o755);
    expect(existsSync(join(fixture, "project"))).toBe(false);
    expect(readFileSync(join(fixture, "customer-fixture.txt"), "utf8")).toBe("must not change");
  });
  test("absent fixture refuses with init guidance", async () => {
    const root = makeRoot();
    const missing = join(root.dir, "no-fixture");
    const result = await runCli(root, ["probe"], {
      OPENGUI_SHELL_SANDBOX_ENDPOINT: "http://127.0.0.1:9",
      OPENGUI_SHELL_PROBE_FIXTURE_ROOT: missing,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/probe_not_configured/);
    expect(result.stderr).toMatch(/--init-fixture/);
  });

  test("init creates a private disposable layout, then the broker attempt is honest", async () => {
    const root = makeRoot();
    const fixture = join(root.dir, "probe-fixture");
    const result = await runCli(root, ["probe", "--init-fixture"], {
      OPENGUI_SHELL_SANDBOX_ENDPOINT: "http://127.0.0.1:9",
      OPENGUI_SHELL_PROBE_FIXTURE_ROOT: fixture,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/broker_unreachable/);
    for (const entry of ["project", "readonly", "outside"]) {
      const path = join(fixture, entry);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).isDirectory()).toBe(true);
    }
    expect(statSync(fixture).mode & 0o777).toBe(0o700);
  });

  test("oversized broker bodies are rejected as too large", async () => {
    const root = makeRoot();
    const big = `{"exitCode":0,"output":"${"x".repeat(2 * 1024 * 1024)}"}`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(big);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const started = Date.now();
      const result = await runCli(root, ["probe", "--init-fixture"], {
        OPENGUI_SHELL_SANDBOX_ENDPOINT: `http://127.0.0.1:${port}`,
        OPENGUI_SHELL_PROBE_FIXTURE_ROOT: join(root.dir, "probe-fixture"),
      });
      expect(Date.now() - started).toBeLessThan(SPAWN_TIMEOUT);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/broker_rejected/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});

describe("failure alerts from check/probe", () => {
  test("failing check delivers a fixed fault summary to the fake webhook", async () => {
    const root = makeRoot();
    const received: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const result = await runCli(root, ["check", "--alert-on-failure"], {
        FAKE_IMAGE: "missing",
        OPENGUI_SHELL_LIFECYCLE_WEBHOOK_URL: `http://127.0.0.1:${port}/hook`,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/alert: delivered/);
      expect(received).toHaveLength(1);
      const payload = JSON.parse(received[0] ?? "") as unknown;
      expect(payload).toMatchObject({ fault: "image_missing" });
      expect(typeof (payload as { summary?: unknown }).summary).toBe("string");
      expect(received[0]).not.toContain("fixture-secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  test("webhook outage is reported as notify_failed without masking the check fault", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["check", "--alert-on-failure"], {
      FAKE_IMAGE: "missing",
      OPENGUI_SHELL_LIFECYCLE_WEBHOOK_URL: "http://127.0.0.1:9/hook",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/image_missing/);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/notify_failed/);
  });

  test("no alert traffic without the explicit flag", async () => {
    const root = makeRoot();
    const result = await runCli(root, ["check"], {
      FAKE_IMAGE: "missing",
      OPENGUI_SHELL_LIFECYCLE_WEBHOOK_URL: "http://127.0.0.1:9/hook",
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/alert:/);
  });
});
