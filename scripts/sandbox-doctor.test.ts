import { describe, expect, test } from "vitest";
import { sandboxHostFindings } from "./sandbox-doctor.ts";

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
