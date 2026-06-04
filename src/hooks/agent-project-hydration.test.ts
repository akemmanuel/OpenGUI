import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { HarnessId } from "@/agents";
import {
  buildBootstrapHydrationTasks,
  getPendingProjectHydrationBackendIds,
  hasProjectHydrationInFlight,
  isProjectHydrationComplete,
  runWithConcurrency,
  settleProjectHydration,
  startProjectHydration,
} from "./agent-project-hydration";

describe("project hydration state", () => {
  test("tracks pending, loading, completed, and failed backends", () => {
    const started = startProjectHydration(undefined, ["opencode", "pi"], 10);
    expect(started.loadingBackendIds.sort()).toEqual(["opencode", "pi"]);
    expect(getPendingProjectHydrationBackendIds(started, ["opencode", "pi", "codex"])).toEqual([
      "codex",
    ]);
    expect(hasProjectHydrationInFlight(started, ["opencode"])).toBe(true);
    expect(isProjectHydrationComplete(started, ["opencode", "pi"])).toBe(false);

    const settled = settleProjectHydration(started, {
      completedBackendIds: ["opencode"],
      failedBackends: { pi: "offline" },
      now: 20,
    });

    expect(settled.loadingBackendIds).toEqual([]);
    expect(settled.completedBackendIds).toEqual(["opencode"]);
    expect(settled.failedBackendIds).toEqual(["pi"]);
    expect(settled.errors.pi).toBe("offline");
    expect(isProjectHydrationComplete(settled, ["opencode", "pi"])).toBe(true);
    expect(hasProjectHydrationInFlight(settled, ["opencode", "pi"])).toBe(false);
  });

  test("retrying a failed backend moves it back to loading", () => {
    const failed = settleProjectHydration(undefined, {
      failedBackends: { codex: "failed" },
      now: 5,
    });

    const retried = startProjectHydration(failed, ["codex"], 10);

    expect(retried.loadingBackendIds).toEqual(["codex"]);
    expect(retried.failedBackendIds).toEqual([]);
    expect(retried.errors.codex).toBeUndefined();
  });
});

describe("buildBootstrapHydrationTasks", () => {
  test("stripes backend work across projects instead of exhausting one backend first", () => {
    const items = ["/repo-1", "/repo-2", "/repo-3", "/repo-4"];
    const harnessIds: HarnessId[] = ["opencode", "claude-code", "pi", "codex"];

    const tasks = buildBootstrapHydrationTasks({
      items,
      harnessIds,
      preferredBackendId: "opencode",
    });

    expect(tasks.slice(0, 4).map((task) => task.harnessId)).toEqual([
      "opencode",
      "claude-code",
      "pi",
      "codex",
    ]);
    expect(tasks.slice(0, 4).map((task) => task.item)).toEqual(items);
  });
});

describe("runWithConcurrency", () => {
  test("does not exceed the requested concurrency", async () => {
    let active = 0;
    let maxActive = 0;

    await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
