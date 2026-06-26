import { describe, expect, test } from "vite-plus/test";
import type { HarnessId } from "@/agents";
import { createHarnessInventoryView } from "@/hooks/harness-inventory-view";
import type { HarnessInventory } from "@/types/electron";

function inventory(
  harnessId: HarnessId,
  overrides: Partial<HarnessInventory> = {},
): HarnessInventory {
  return {
    harnessId,
    displayName: harnessId,
    enabled: true,
    installed: false,
    status: "disabled",
    auth: { status: "unknown" },
    version: null,
    models: [],
    agents: [],
    checkedAt: "2026-01-01T00:00:00.000Z",
    diagnostics: {
      cli: {
        command: harnessId,
        resolvedPath: null,
        checkedPaths: [],
      },
    },
    ...overrides,
  };
}

describe("createHarnessInventoryView", () => {
  test("hides uninstalled Harnesses from selector rows", () => {
    const view = createHarnessInventoryView({
      candidateHarnessIds: ["pi", "codex"],
      inventories: [
        inventory("pi", { installed: false }),
        inventory("codex", { installed: true, status: "warning" }),
      ],
    });

    expect(view.selectorHarnessIds).toEqual(["codex"]);
    expect(view.installedHarnessIds).toEqual(["codex"]);
    expect(view.hasInstalledHarness).toBe(true);
  });

  test("keeps a locked session Harness visible even when inventory says it is not installed", () => {
    const view = createHarnessInventoryView({
      candidateHarnessIds: ["pi", "codex"],
      lockedHarnessId: "pi",
      inventories: [inventory("pi", { installed: false }), inventory("codex", { installed: true })],
    });

    expect(view.selectorHarnessIds).toEqual(["pi", "codex"]);
  });

  test("shows no selector rows while inventory is loading", () => {
    const view = createHarnessInventoryView({
      status: "loading",
      candidateHarnessIds: ["pi"],
      inventories: [inventory("pi", { installed: true })],
    });

    expect(view.selectorHarnessIds).toEqual([]);
  });

  test("tracks model-ready Harnesses separately from installed Harnesses", () => {
    const view = createHarnessInventoryView({
      candidateHarnessIds: ["pi", "codex"],
      inventories: [
        inventory("pi", { installed: true, status: "warning", models: [] }),
        inventory("codex", {
          installed: true,
          status: "ready",
          models: [{ providerID: "openai", modelID: "gpt-5" }],
        }),
      ],
    });

    expect(view.installedHarnessIds).toEqual(["pi", "codex"]);
    expect(view.modelReadyHarnessIds).toEqual(["codex"]);
    expect(view.hasUsableHarness).toBe(true);
  });
});
