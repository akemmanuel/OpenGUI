import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, test } from "vitest";
import {
  KEEPER_CONTAINER_DEFAULT,
  acquireOwnLock,
  assertBrokerTarget,
  assessShellReadiness,
  checkImageProvenance,
  checkRollbackTarget,
  closeLifecycleLock,
  collectBoundedBody,
  collectCleanupCandidates,
  createBrokerProbeExecutor,
  defaultLockPath,
  dockerErrorSummary,
  faultLine,
  faultSummary,
  fixtureLayout,
  initFixtureLayout,
  keeperApplyDecision,
  keeperLabelToResolve,
  liveBrokerPost,
  openLifecycleLock,
  parseKeeperProbe,
  parseLifecycleArgs,
  planScopedCleanup,
  planUpgrade,
  readLifecycleEnv,
  realFlockFd,
  requestHostname,
  resolveImageId,
  resolveProtectedIds,
  resolveShellImageReference,
  runRestrictedProbe,
  sendLifecycleAlert,
  sha256FileStream,
  supportedCleanupFilter,
  validateLockPath,
  verifyConfigConsistency,
  verifyEligibleBeforeRemove,
  verifyFixtureLayout,
  verifyKeeper,
  verifyKeeperWithLabel,
  verifyRestoration,
  verifyRuntime,
  verifyShellImage,
  type CandidateImage,
  type DockerCommand,
  type DockerResult,
  type ProbeExecutor,
} from "./sandbox-shell-lifecycle.ts";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const OTHER_ID = `sha256:${"b".repeat(64)}`;
const FOREIGN_ID = `sha256:${"c".repeat(64)}`;

function fakeDocker(handler: (arguments_: string[]) => DockerResult): DockerCommand {
  return handler;
}

describe("shell image verification", () => {
  test("absent image fails verification without pulling anything", () => {
    const calls: string[][] = [];
    const docker = fakeDocker((arguments_) => {
      calls.push(arguments_);
      return { status: 1, stdout: "", stderr: "No such image" };
    });
    const result = verifyShellImage("fixture/missing:1", docker);
    expect(result.available).toBe(false);
    expect(result.fault).toBe("image_missing");
    expect(calls.every((arguments_) => arguments_[0] !== "pull")).toBe(true);
  });

  test("present image reports id, digests, and revision label", () => {
    const docker = fakeDocker((arguments_) => {
      if (arguments_.join(" ").includes("{{.Id}}")) {
        return { status: 0, stdout: `${IMAGE_ID}\n`, stderr: "" };
      }
      if (arguments_.join(" ").includes("RepoDigests")) {
        return { status: 0, stdout: '["fixture/img@sha256:dead"]\n', stderr: "" };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ "org.opencontainers.image.revision": "abc123" }),
        stderr: "",
      };
    });
    const result = verifyShellImage("fixture/img:1", docker);
    expect(result.available).toBe(true);
    expect(result.imageId).toBe(IMAGE_ID);
    expect(result.digest).toBe("fixture/img@sha256:dead");
    expect(result.revisionLabel).toBe("abc123");
  });

  test("undefined reference fails instead of inspecting the world", () => {
    const docker = fakeDocker(() => {
      throw new Error("docker must not be called");
    });
    expect(verifyShellImage(undefined, docker).fault).toBe("image_missing");
  });

  test("missing digest and revision produce provenance guidance", () => {
    const notes = checkImageProvenance({
      reference: "fixture/img:1",
      available: true,
      imageId: IMAGE_ID,
    });
    expect(notes.join("\n")).toMatch(/digest/i);
    expect(notes.join("\n")).toMatch(/revision/i);
  });

  test("pinned digest and revision silence provenance guidance", () => {
    expect(
      checkImageProvenance({
        reference: "fixture/img:1",
        available: true,
        imageId: IMAGE_ID,
        digest: "fixture/img@sha256:dead",
        revisionLabel: "abc123",
      }),
    ).toEqual([]);
  });
});

describe("runtime verification", () => {
  test("missing runsc fails with runtime_unavailable", () => {
    const docker = fakeDocker(() => ({ status: 0, stdout: "runc\n", stderr: "" }));
    const result = verifyRuntime(docker);
    expect(result.available).toBe(false);
    expect(result.fault).toBe("runtime_unavailable");
  });

  test("daemon failure fails closed", () => {
    const docker = fakeDocker(() => ({ status: null, stdout: "", stderr: "refused" }));
    expect(verifyRuntime(docker).available).toBe(false);
  });
});

describe("diagnostic secrecy", () => {
  test("docker stderr paths never leak through summaries", () => {
    const hostile = "Error: No such image: /root/secret/customer-path/image:1";
    const summary = dockerErrorSummary(hostile);
    expect(summary).not.toContain("/root/secret/customer-path");
    expect(summary).toMatch(/not found/);
  });

  test("fixed fault summaries carry no customer data", () => {
    for (const fault of [
      "image_missing",
      "keeper_collision",
      "probe_failed",
      "lock_contended",
    ] as const) {
      expect(faultLine(fault)).toMatch(new RegExp(`^${fault}: .+`));
    }
    expect(faultSummary("lifecycle_test")).toMatch(/test/i);
  });
});

function keeperInspectStdout(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([
    {
      Id: "keeper-container-id",
      Name: `/${KEEPER_CONTAINER_DEFAULT}`,
      Image: IMAGE_ID,
      State: { Running: false },
      Config: { Labels: { "opengui.shell.keeper": "true", "opengui.shell.image": IMAGE_ID } },
      ...overrides,
    },
  ]);
}

describe("keeper verification", () => {
  test("missing keeper reports keeper_missing", () => {
    const docker = fakeDocker(() => ({
      status: 1,
      stdout: "",
      stderr: "No such container: opengui-shell-image-keepalive",
    }));
    const probe = parseKeeperProbe(KEEPER_CONTAINER_DEFAULT, docker);
    expect(probe.state).toBe("absent");
    expect(verifyKeeper(IMAGE_ID, probe, []).fault).toBe("keeper_missing");
  });

  test("matching unstarted owned keeper passes", () => {
    const docker = fakeDocker(() => ({ status: 0, stdout: keeperInspectStdout(), stderr: "" }));
    const probe = parseKeeperProbe(KEEPER_CONTAINER_DEFAULT, docker);
    expect(verifyKeeper(IMAGE_ID, probe, [IMAGE_ID]).ok).toBe(true);
  });

  test("keeper image mismatch fails", () => {
    const docker = fakeDocker(() => ({ status: 0, stdout: keeperInspectStdout(), stderr: "" }));
    const probe = parseKeeperProbe(KEEPER_CONTAINER_DEFAULT, docker);
    expect(verifyKeeper(OTHER_ID, probe, [IMAGE_ID]).fault).toBe("keeper_mismatch");
  });

  test("foreign container with the keeper name is a collision", () => {
    const docker = fakeDocker(() => ({
      status: 0,
      stdout: keeperInspectStdout({ Config: { Labels: { "other.vendor": "x" } } }),
      stderr: "",
    }));
    const probe = parseKeeperProbe(KEEPER_CONTAINER_DEFAULT, docker);
    expect(probe.state).toBe("collision");
    expect(verifyKeeper(IMAGE_ID, probe, []).fault).toBe("keeper_collision");
  });

  test("started keeper fails", () => {
    const docker = fakeDocker(() => ({
      status: 0,
      stdout: keeperInspectStdout({ State: { Running: true } }),
      stderr: "",
    }));
    const probe = parseKeeperProbe(KEEPER_CONTAINER_DEFAULT, docker);
    expect(verifyKeeper(IMAGE_ID, probe, [IMAGE_ID]).fault).toBe("keeper_running");
  });

  test("only our own label pin is resolved, never foreign image refs", () => {
    const docker = fakeDocker(() => ({
      status: 0,
      stdout: keeperInspectStdout({ Config: { Labels: {} } }),
      stderr: "",
    }));
    const probe = parseKeeperProbe(KEEPER_CONTAINER_DEFAULT, docker);
    expect(keeperLabelToResolve(probe)).toBeUndefined();
  });

  test("unresolvable label pin fails closed as unverifiable", () => {
    const docker = fakeDocker((arguments_) => {
      if (arguments_[0] === "container") {
        return { status: 0, stdout: keeperInspectStdout(), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "No such image" };
    });
    const probe = parseKeeperProbe(KEEPER_CONTAINER_DEFAULT, docker);
    expect(verifyKeeperWithLabel(IMAGE_ID, probe, docker).fault).toBe("keeper_unverifiable");
  });

  test("keeper decisions: noop, create, and guided refusals", () => {
    expect(keeperApplyDecision({ ok: true }).action).toBe("noop");
    expect(keeperApplyDecision({ ok: false, fault: "keeper_missing" }).action).toBe("create");
    const migration = keeperApplyDecision({
      ok: false,
      fault: "keeper_collision",
      sameImage: true,
    });
    expect(migration.action).toBe("refuse");
    if (migration.action === "refuse") expect(migration.guidance).toMatch(/migrat/i);
    const foreign = keeperApplyDecision({ ok: false, fault: "keeper_collision", sameImage: false });
    expect(foreign.action).toBe("refuse");
    const mismatch = keeperApplyDecision({ ok: false, fault: "keeper_mismatch" });
    expect(mismatch.action).toBe("refuse");
    if (mismatch.action === "refuse") expect(mismatch.guidance).toMatch(/--keeper/);
  });
});

describe("config consistency", () => {
  test("drift blocks transitions", () => {
    expect(
      verifyConfigConsistency({
        shellImage: IMAGE_ID,
        keeperImage: OTHER_ID,
        brokerImage: IMAGE_ID,
      }).fault,
    ).toBe("config_mismatch");
  });

  test("consistent triple passes", () => {
    expect(
      verifyConfigConsistency({
        shellImage: IMAGE_ID,
        keeperImage: IMAGE_ID,
        brokerImage: IMAGE_ID,
      }).ok,
    ).toBe(true);
  });
});

describe("honest shell readiness", () => {
  test("image inspect alone is never shell readiness", () => {
    const report = assessShellReadiness({
      webOk: true,
      imageAvailable: true,
      runtimeAvailable: true,
      probeConfigured: false,
      probe: undefined,
    });
    expect(report.web.ok).toBe(true);
    expect(report.shell).toEqual({ ok: false, fault: "probe_not_configured" });
  });

  test("missing image classifies as image_missing", () => {
    const report = assessShellReadiness({
      webOk: true,
      imageAvailable: false,
      runtimeAvailable: true,
      probeConfigured: true,
      probe: { ok: false, fault: "broker_unreachable" },
    });
    expect(report.shell.fault).toBe("image_missing");
  });

  test("full green requires image, runtime, and a real probe", () => {
    const report = assessShellReadiness({
      webOk: true,
      imageAvailable: true,
      runtimeAvailable: true,
      probeConfigured: true,
      probe: { ok: true },
    });
    expect(report.shell.ok).toBe(true);
  });
});

const fixture = {
  projectRoot: "/tmp/fixture-grant-project",
  readOnlyRoot: "/tmp/fixture-grant-readonly",
  outsideRoot: "/tmp/fixture-outside",
  identityPath: "/tmp/fixture-identity.txt",
};

function allowWriteDenyRestExecutor(): ProbeExecutor {
  return async (input) => {
    if (input.projectDirectory === fixture.outsideRoot) return { denied: true, error: "rejected" };
    if (input.command.includes(fixture.identityPath)) return { denied: true, error: "rejected" };
    if (input.projectDirectory === fixture.readOnlyRoot && input.command.startsWith("touch ")) {
      return { exitCode: 1, output: "Read-only file system" };
    }
    return { exitCode: 0, output: "probe-ok" };
  };
}

describe("restricted-grant execution probe", () => {
  test("missing executor or fixture fails probe_not_configured", async () => {
    expect((await runRestrictedProbe(undefined, undefined)).fault).toBe("probe_not_configured");
  });

  test("healthy fixture probe passes all four checks", async () => {
    const report = await runRestrictedProbe(allowWriteDenyRestExecutor(), fixture);
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual({
      writeGrant: true,
      readOnlyEnforced: true,
      outOfGrantDenied: true,
      identityDataDenied: true,
    });
  });

  test("executor that wrongly allows out-of-grant access fails closed", async () => {
    const permissive: ProbeExecutor = async () => ({ exitCode: 0, output: "leaked" });
    const report = await runRestrictedProbe(permissive, fixture);
    expect(report.ok).toBe(false);
    expect(report.fault).toBe("probe_policy_breach");
  });

  test("broker outage surfaces broker_unreachable", async () => {
    const down: ProbeExecutor = async () => {
      const error = new Error("unreachable") as Error & { code?: string };
      error.code = "broker_unreachable";
      throw error;
    };
    const report = await runRestrictedProbe(down, fixture);
    expect(report.fault).toBe("broker_unreachable");
  });

  test("broker HTTP mapping rejects 401 without echoing the endpoint", async () => {
    const httpPost = async (
      url: string,
      _body: string,
      _headers: Record<string, string>,
      _opts: { timeoutMs: number },
    ) => {
      expect(url).toBe("http://127.0.0.1:9/v1/execute");
      return { status: 401, body: "unauthorized" };
    };
    const executor = createBrokerProbeExecutor("http://127.0.0.1:9", "fixture-secret", httpPost);
    await expect(
      executor({ projectDirectory: fixture.projectRoot, grants: [], command: "true" }),
    ).rejects.toMatchObject({ code: "broker_unauthorized" });
  });

  test("unsupported endpoint protocols are rejected", () => {
    expect(() => assertBrokerTarget("ftp://example.com/x")).toThrow();
    expect(assertBrokerTarget("/run/broker.sock")).toEqual({
      socket: true,
      target: "/run/broker.sock",
    });
  });
});

describe("scoped cleanup", () => {
  const images: CandidateImage[] = [
    { id: IMAGE_ID, repoTags: ["fixture/app:1"], labels: {} },
    { id: OTHER_ID, repoTags: ["fixture/app:2"], labels: {} },
    {
      id: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      repoTags: ["fixture/disposable:t1"],
      labels: { "opengui.shell.disposable": "true" },
    },
    { id: FOREIGN_ID, repoTags: ["unrelated/app:9"], labels: {} },
    { id: "abc123", repoTags: [], labels: { "opengui.shell.disposable": "true" } },
  ];

  test("preserves by immutable ID, removes only labeled disposables", () => {
    const plan = planScopedCleanup({ protectedIds: [IMAGE_ID, OTHER_ID], images });
    expect(plan.eligible.map((item) => item.id)).toHaveLength(1);
    expect(plan.preserve.map((item) => item.id)).toEqual(
      expect.arrayContaining([IMAGE_ID, OTHER_ID]),
    );
    expect(plan.excludedForeign.map((item) => item.id)).toContain(FOREIGN_ID);
    expect(plan.excludedForeign.map((item) => item.id)).toContain("abc123");
    expect(plan.removeArgv).toHaveLength(1);
    expect(plan.removeArgv[0]?.at(-1)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("never emits global prune verbs and documents keeper limits", () => {
    const plan = planScopedCleanup({ protectedIds: [IMAGE_ID], images });
    const serialized = JSON.stringify(plan.removeArgv);
    expect(serialized).not.toContain("prune");
    expect(serialized).not.toContain("system");
    expect(plan.warnings.join("\n")).toMatch(/forced removal/i);
  });

  test("protected references resolve to IDs; unresolvable fails the caller closed", () => {
    const docker = fakeDocker((arguments_) => {
      const ref = arguments_.at(-1);
      if (ref === "fixture/app:1") return { status: 0, stdout: `${IMAGE_ID}\n`, stderr: "" };
      return { status: 1, stdout: "", stderr: "No such image" };
    });
    expect(resolveImageId("fixture/app:1", docker)).toBe(IMAGE_ID);
    expect(resolveImageId("short-id", docker)).toBeUndefined();
    const resolved = resolveProtectedIds(["fixture/app:1", "fixture/gone:9"], docker);
    expect(resolved.ids).toEqual([IMAGE_ID]);
    expect(resolved.unresolved).toEqual(["fixture/gone:9"]);
  });

  test("candidates come from --no-trunc listing plus per-image inspect", () => {
    const docker = fakeDocker((arguments_) => {
      if (arguments_[0] === "images") {
        expect(arguments_).toContain("--no-trunc");
        return {
          status: 0,
          stdout: `${JSON.stringify({ ID: IMAGE_ID, Repository: "fixture/app", Tag: "1" })}\nnot-json\n`,
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          Id: IMAGE_ID,
          RepoTags: ["fixture/app:1"],
          Config: { Labels: { "opengui.shell.disposable": "true" } },
        }),
        stderr: "",
      };
    });
    const { listed, candidates, skipped } = collectCleanupCandidates(docker);
    expect(listed).toBe(true);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.labels["opengui.shell.disposable"]).toBe("true");
    expect(skipped).toBe(1);
  });

  test("pre-remove re-verification refuses protected or relabeled images", () => {
    const docker = fakeDocker(() => ({
      status: 0,
      stdout: JSON.stringify({ Id: IMAGE_ID, Config: { Labels: {} } }),
      stderr: "",
    }));
    expect(verifyEligibleBeforeRemove(IMAGE_ID, [], docker)).toBe(false);
    expect(verifyEligibleBeforeRemove(IMAGE_ID, [IMAGE_ID], docker)).toBe(false);
    expect(verifyEligibleBeforeRemove("abc123", [], docker)).toBe(false);
  });

  test("cleanup filter is label-scoped", () => {
    expect(supportedCleanupFilter()).toContain("opengui.shell.disposable");
  });
});

describe("upgrade and rollback", () => {
  test("upgrade plan blocks until everything is green and never updates in place", () => {
    const plan = planUpgrade({
      currentKnownGood: IMAGE_ID,
      newImageAvailable: true,
      keeperMatchesNew: false,
      configMatchesNew: false,
      probeOk: false,
    });
    expect(plan.canMarkKnownGood).toBe(false);
    expect(plan.blockers.length).toBeGreaterThan(0);
    expect(plan.steps.join("\n")).toMatch(/never updated in place/);
    expect(plan.steps.join("\n")).toMatch(/restart.*operator/i);
  });

  test("rollback to an absent image is refused", () => {
    expect(checkRollbackTarget({ targetImage: IMAGE_ID, targetAvailable: false })).toEqual({
      ok: false,
      fault: "image_missing",
    });
    expect(checkRollbackTarget({ targetImage: IMAGE_ID, targetAvailable: true }).ok).toBe(true);
  });
});

describe("offline restoration", () => {
  test("missing expectations are unverifiable", () => {
    expect(verifyRestoration({ imageLoaded: false }).fault).toBe("restore_unverifiable");
  });

  test("tampered archive fails before image comparison", () => {
    expect(
      verifyRestoration({
        expectedArchiveSha256: "aa",
        actualArchiveSha256: "bb",
        imageLoaded: true,
        expectedImageDigest: "fixture/img@sha256:aa",
        actualImageDigest: "fixture/img@sha256:aa",
      }).fault,
    ).toBe("restore_checksum_mismatch");
  });

  test("unloaded image fails instead of claiming verification", () => {
    expect(
      verifyRestoration({
        expectedArchiveSha256: "aa",
        actualArchiveSha256: "aa",
        imageLoaded: false,
        expectedImageDigest: "fixture/img@sha256:aa",
      }).fault,
    ).toBe("image_missing");
  });

  test("unrelated loaded digest fails closed", () => {
    expect(
      verifyRestoration({
        expectedArchiveSha256: "aa",
        actualArchiveSha256: "aa",
        imageLoaded: true,
        expectedImageDigest: "fixture/img@sha256:aa",
        actualImageDigest: "fixture/img@sha256:bb",
      }).fault,
    ).toBe("restore_digest_mismatch");
  });

  test("matching archive and image verify as separate facts", () => {
    expect(
      verifyRestoration({
        expectedArchiveSha256: "aa",
        actualArchiveSha256: "aa",
        imageLoaded: true,
        expectedImageDigest: "fixture/img@sha256:aa",
        actualImageDigest: "fixture/img@sha256:aa",
      }).ok,
    ).toBe(true);
  });

  test("streaming hash matches the expected digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-hash-"));
    const path = join(dir, "archive.tar");
    writeFileSync(path, "fake-image-bytes");
    await expect(sha256FileStream(path)).resolves.toBe(
      createHash("sha256").update("fake-image-bytes").digest("hex"),
    );
  });
});

describe("lifecycle lock primitives", () => {
  test("default lock lives under the private runtime dir", () => {
    expect(defaultLockPath()).toBe(
      join(process.env.XDG_RUNTIME_DIR ?? "/run", "opengui-shell-lifecycle.lock"),
    );
  });

  test("lock paths outside private owner-controlled dirs are refused", () => {
    expect(validateLockPath("/tmp/predictable.lock").ok).toBe(false);
    expect(validateLockPath("relative.lock").ok).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-lock-"));
    try {
      chmodSync(dir, 0o700);
      expect(validateLockPath(join(dir, "lifecycle.lock")).ok).toBe(true);
      symlinkSync(join(dir, "real.lock"), join(dir, "link.lock"));
      expect(validateLockPath(join(dir, "link.lock")).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("own-fd locking holds the kernel lock until close", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-ownfd-"));
    chmodSync(dir, 0o700);
    const lock = join(dir, "own.lock");
    const first = openLifecycleLock(lock);
    const second = openLifecycleLock(lock);
    try {
      expect(acquireOwnLock(first, realFlockFd)).toBe("acquired");
      expect(acquireOwnLock(second, realFlockFd)).toBe("contended");
      closeLifecycleLock(first);
      expect(acquireOwnLock(second, realFlockFd)).toBe("acquired");
    } finally {
      closeLifecycleLock(first);
      closeLifecycleLock(second);
      rmSync(dir, { recursive: true });
    }
  });

  test("missing flock binary fails closed as unavailable, never held", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-noflock-"));
    chmodSync(dir, 0o700);
    const handle = openLifecycleLock(join(dir, "own.lock"));
    try {
      expect(acquireOwnLock(handle, () => ({ status: null, error: new Error("ENOENT") }))).toBe(
        "unavailable",
      );
    } finally {
      closeLifecycleLock(handle);
      rmSync(dir, { recursive: true });
    }
  });

  test("symlinked or malformed lock paths fail closed at open", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-badlock-"));
    chmodSync(dir, 0o700);
    try {
      writeFileSync(join(dir, "real.lock"), "");
      symlinkSync(join(dir, "real.lock"), join(dir, "link.lock"));
      expect(() => openLifecycleLock(join(dir, "link.lock"))).toThrow();
      expect(() => openLifecycleLock("relative.lock")).toThrow();
      expect(() => openLifecycleLock(join(dir, "no-such-dir", "own.lock"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("bounded HTTP bodies", () => {
  function fakeResponse(events: Array<"data" | "end" | "destroy">): IncomingMessage {
    const stream = new PassThrough() as PassThrough & Pick<IncomingMessage, "destroy">;
    queueMicrotask(() => {
      for (const event of events) {
        if (event === "data") stream.write(Buffer.alloc(8));
        if (event === "end") stream.end();
        if (event === "destroy") stream.destroy(new Error("boom"));
      }
    });
    return stream as unknown as IncomingMessage;
  }

  test("normal bodies resolve", async () => {
    await expect(collectBoundedBody(fakeResponse(["data", "end"]), 64)).resolves.toHaveLength(8);
  });

  test("oversized bodies reject without unbounded buffering", async () => {
    await expect(
      collectBoundedBody(fakeResponse(["data", "data", "data", "end"]), 16),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  test("destroyed streams reject", async () => {
    await expect(collectBoundedBody(fakeResponse(["destroy"]), 64)).rejects.toThrow();
  });
});

describe("probe fixture layout", () => {
  test("missing root never verifies", () => {
    expect(verifyFixtureLayout(undefined).ok).toBe(false);
    expect(verifyFixtureLayout("relative/path").ok).toBe(false);
  });

  test("init creates a private disposable layout", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-fixture-"));
    const root = join(dir, "probe-fixture");
    try {
      const layout = initFixtureLayout(root);
      expect(verifyFixtureLayout(root).ok).toBe(true);
      expect(layout.identityFile).toContain("identity-fixture");
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(fixtureLayout(root).project).toBe(join(root, "project"));
      expect(initFixtureLayout(root)).toEqual(layout);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("init refuses an existing non-fixture directory without changing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-fixture-"));
    const root = join(dir, "existing-project");
    mkdirSync(root, { mode: 0o755 });
    chmodSync(root, 0o755);
    writeFileSync(join(root, "customer-fixture.txt"), "must not change");
    try {
      expect(() => initFixtureLayout(root)).toThrow(/not a lifecycle fixture/);
      expect(statSync(root).mode & 0o777).toBe(0o755);
      expect(existsSync(join(root, "project"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("init refuses symlinked roots, children, and markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-fixture-"));
    try {
      const outside = join(dir, "outside-target");
      mkdirSync(outside);
      const linkRoot = join(dir, "link-root");
      symlinkSync(outside, linkRoot);
      expect(() => initFixtureLayout(linkRoot)).toThrow();
      const owned = join(dir, "owned");
      initFixtureLayout(owned);
      rmSync(join(owned, "project"), { recursive: true });
      symlinkSync(outside, join(owned, "project"));
      expect(() => initFixtureLayout(owned)).toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("bounded HTTP with deadlines", () => {
  test("IPv6 literals are unbracketed for the request layer", () => {
    expect(requestHostname(new URL("http://[::1]:8080/hook"))).toBe("::1");
    expect(requestHostname(new URL("http://127.0.0.1:8080/hook"))).toBe("127.0.0.1");
  });

  test("invalid endpoint URLs reject with a fixed message", async () => {
    const hostile = "http://exa mple.com/hook";
    await expect(liveBrokerPost(hostile, "{}", {}, { timeoutMs: 1000 })).rejects.toThrow(
      "invalid endpoint URL",
    );
  });

  test("a hanging server hits the deadline instead of hanging", async () => {
    const server = createServer(() => {
      // Accept and stall forever; the client deadline must win.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const started = Date.now();
      await expect(
        liveBrokerPost(`http://127.0.0.1:${port}/hook`, "{}", {}, { timeoutMs: 500 }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  test("a dripping body cannot outlast the deadline", async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      const drip = setInterval(() => response.write("x"), 400);
      request.on("close", () => clearInterval(drip));
      response.on("close", () => clearInterval(drip));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const started = Date.now();
      await expect(
        liveBrokerPost(`http://127.0.0.1:${port}/hook`, "{}", {}, { timeoutMs: 700 }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});

describe("alert webhook carries fixed summaries only", () => {
  test("unconfigured webhook stays OFF without network use", async () => {
    const httpPost = async () => {
      throw new Error("network must not be used");
    };
    const result = await sendLifecycleAlert(
      { webhookUrl: undefined, faultCode: "image_missing" },
      httpPost,
    );
    expect(result).toEqual({
      delivered: false,
      skipped: true,
      fault: "notify_skipped",
      attempts: 0,
    });
  });

  test("non-loopback http is rejected without sending", async () => {
    let called = false;
    const result = await sendLifecycleAlert(
      { webhookUrl: "http://example.com/hook", faultCode: "image_missing" },
      async () => {
        called = true;
        return { status: 200 };
      },
    );
    expect(called).toBe(false);
    expect(result.fault).toBe("notify_failed");
  });
});

describe("environment and defaults", () => {
  test("prefers the tested App image as the shell image until pinned", () => {
    expect(resolveShellImageReference({ appImage: "fixture/app:1" })).toEqual({
      reference: "fixture/app:1",
      pinnedFromAppImage: true,
    });
    expect(
      resolveShellImageReference({ shellImage: "fixture/shell:2", appImage: "fixture/app:1" }),
    ).toEqual({ reference: "fixture/shell:2", pinnedFromAppImage: false });
  });

  test("reads lifecycle env without echoing secrets", () => {
    const env = readLifecycleEnv({
      OPENGUI_SHELL_IMAGE: "fixture/img:1",
      OPENGUI_SHELL_BROKER_TOKEN: "fixture-secret",
      OPENGUI_SHELL_SANDBOX_TOKEN: "fixture-secret-2",
    });
    expect(env.shellImage).toBe("fixture/img:1");
    expect(JSON.stringify(env)).not.toContain("fixture-secret");
  });

  test("CLI arg parsing keeps a minimal explicit surface", () => {
    expect(parseLifecycleArgs(["check"]).command).toBe("check");
    for (const command of ["check", "probe", "retain", "cleanup", "upgrade-plan"] as const) {
      expect(parseLifecycleArgs([command]).command).toBe(command);
    }
    expect(parseLifecycleArgs(["cleanup", "--apply"]).apply).toBe(true);
    expect(parseLifecycleArgs(["probe", "--init-fixture"]).initFixture).toBe(true);
    expect(parseLifecycleArgs(["check", "--alert-on-failure"]).alertOnFailure).toBe(true);
    expect(parseLifecycleArgs(["retain", "--keeper", "next-name"]).keeper).toBe("next-name");
    expect(() => parseLifecycleArgs(["__apply", "retain", "--apply"])).toThrow();
    expect(() => parseLifecycleArgs(["nuke-everything"])).toThrow();
    expect(() => parseLifecycleArgs(["retain", "--keeper", "../evil"])).toThrow();
  });
});
