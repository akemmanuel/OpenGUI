import { describe, expect, test } from "vite-plus/test";
import {
  listProjectHarnessSessionQueryErrors,
  mapSessionQueryErrorsForProject,
} from "@/hooks/session-query-errors";

describe("session-query-errors", () => {
  test("maps per-harness query errors for the matching project directory", () => {
    const failed = mapSessionQueryErrorsForProject({
      projectKey: "ws:/repo",
      directory: "/repo",
      harnessIds: ["pi", "codex"],
      queryResult: {
        items: [],
        errors: [
          { directory: "/repo", harnessId: "pi", error: "Harness offline" },
          { directory: "/other", harnessId: "codex", error: "ignored" },
        ],
      },
    });
    expect(failed).toEqual({ pi: "Harness offline" });
  });

  test("lists hydration errors as harness rows", () => {
    expect(
      listProjectHarnessSessionQueryErrors({
        errors: { pi: "offline", codex: "" },
      }),
    ).toEqual([{ harnessId: "pi", error: "offline" }]);
  });
});
