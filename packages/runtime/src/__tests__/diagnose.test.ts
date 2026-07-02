import { describe, expect, test } from "vite-plus/test";
import { diagnoseFromInventories } from "../diagnose.ts";

describe("diagnoseFromInventories", () => {
  test("ok when at least one harness is ready", () => {
    const result = diagnoseFromInventories([
      {
        harnessId: "pi",
        displayName: "Pi",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "unknown" },
        version: "1",
        models: [],
        agents: [],
        message: "",
        checkedAt: "",
        diagnostics: { cli: { command: "pi", resolvedPath: "/usr/bin/pi", checkedPaths: [] } },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.harnesses[0]?.cliOnPath).toBe(true);
    expect(result.harnesses[0]?.ready).toBe(true);
  });

  test("not ok when no harness is ready", () => {
    const result = diagnoseFromInventories([
      {
        harnessId: "pi",
        displayName: "Pi",
        enabled: true,
        installed: false,
        status: "error",
        auth: { status: "unknown" },
        version: "",
        models: [],
        agents: [],
        message: "install pi",
        checkedAt: "",
        diagnostics: { cli: { command: "pi", resolvedPath: null, checkedPaths: [] } },
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.harnesses[0]?.cliOnPath).toBe(false);
    expect(result.harnesses[0]?.hint).toBe("install pi");
  });
});
