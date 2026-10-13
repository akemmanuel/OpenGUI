import { describe, expect, test, vi } from "vitest";
import { inspectSandboxHost, sandboxHostFindings, type DockerCommand } from "./sandbox-doctor.ts";

describe("sandbox Host doctor", () => {
  test("accepts a rootless Docker daemon with runsc and private deployment files", () => {
    expect(
      sandboxHostFindings({
        securityOptions: ["name=rootless", "name=seccomp,profile=builtin"],
        runtimes: ["runc", "runsc"],
        workspace: { exists: true, directory: true, mode: 0o750 },
        deployKey: { exists: true, directory: false, mode: 0o600 },
        knownHosts: { exists: true, directory: false, mode: 0o644 },
      }),
    ).toEqual([]);
  });

  test("rejects an unavailable configured shell image even when Docker and files are healthy", () => {
    expect(
      sandboxHostFindings({
        securityOptions: ["name=rootless"],
        runtimes: ["runc", "runsc"],
        workspace: { exists: true, directory: true, mode: 0o750 },
        deployKey: { exists: true, directory: false, mode: 0o600 },
        knownHosts: { exists: true, directory: false, mode: 0o644 },
        shellImageAvailable: false,
      }),
    ).toContain("OPENGUI_SHELL_IMAGE is not available in the selected Docker daemon");
  });

  test.each([
    { label: "present image", status: 0, stdout: `sha256:${"a".repeat(64)}\n`, available: true },
    { label: "missing image", status: 1, stdout: "", available: false },
    { label: "Docker error", status: null, stdout: "", available: false },
    { label: "invalid inspection output", status: 0, stdout: "null\n", available: false },
  ])(
    "inspects the configured image without pulling it: $label",
    ({ status, stdout, available }) => {
      const docker = vi.fn<DockerCommand>((arguments_) => {
        if (arguments_[0] === "image") {
          return { status, stdout, stderr: "fixture diagnostic with private content" };
        }
        return {
          status: 0,
          stdout: arguments_[2]?.includes("SecurityOptions") ? '["name=rootless"]' : "runsc\n",
          stderr: "",
        };
      });
      const inspection = inspectSandboxHost(
        {
          OPENGUI_SHELL_IMAGE: "fixture/image:release",
          OPENGUI_SHELL_BROKER_TOKEN: "fixture-secret",
        },
        docker,
      );
      expect(inspection.shellImageAvailable).toBe(available);
      expect(docker).toHaveBeenCalledWith([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        "--",
        "fixture/image:release",
      ]);
      expect(docker).toHaveBeenCalledTimes(3);
      const diagnostics = JSON.stringify(sandboxHostFindings(inspection));
      expect(diagnostics).not.toContain("fixture-secret");
      expect(diagnostics).not.toContain("private content");
      expect(diagnostics).not.toContain("fixture/image");
    },
  );

  test("does not require or inspect an image for broker-free deployments", () => {
    const docker = vi.fn<DockerCommand>((arguments_) => ({
      status: 0,
      stdout: arguments_[2]?.includes("SecurityOptions") ? '["name=rootless"]' : "runsc\n",
      stderr: "",
    }));
    expect(inspectSandboxHost({}, docker).shellImageAvailable).toBeUndefined();
    expect(docker).toHaveBeenCalledTimes(2);
    expect(docker.mock.calls.every(([arguments_]) => arguments_[0] === "info")).toBe(true);
  });

  test("reports unsafe or incomplete hosts without exposing credential contents", () => {
    expect(
      sandboxHostFindings({
        securityOptions: ["name=seccomp,profile=builtin"],
        runtimes: ["runc"],
        workspace: { exists: false, directory: false, mode: 0 },
        deployKey: { exists: true, directory: false, mode: 0o644 },
        knownHosts: { exists: false, directory: false, mode: 0 },
      }),
    ).toEqual([
      "Docker is not running in rootless mode",
      'Docker runtime "runsc" is not registered',
      "OPENGUI_WORKSPACE is not an existing directory",
      "GitHub deploy key must not be accessible by group or other users",
      "GitHub known-hosts file does not exist",
    ]);
  });
});
