import { describe, expect, test } from "vite-plus/test";
import { handleHarnessRequest } from "./harness.ts";
import { createMockApiRouteDeps } from "../test/mock-api-route-deps.ts";

type ApiJson = { ok: boolean; value?: unknown };

describe("handleHarnessRequest", () => {
  test("returns null for non-harness paths", async () => {
    const deps = createMockApiRouteDeps();
    const response = await handleHarnessRequest(new Request("http://127.0.0.1/api/sessions"), deps);
    expect(response).toBeNull();
  });

  test("GET /api/harnesses lists managed harness descriptors", async () => {
    const deps = createMockApiRouteDeps({
      services: {
        harnesses: {
          getManagedHarnessIds: () => ["pi", "codex"],
        },
      } as never,
    });
    const response = await handleHarnessRequest(
      new Request("http://127.0.0.1/api/harnesses"),
      deps,
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as ApiJson;
    expect(body.ok).toBe(true);
    expect(body.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "pi" }),
        expect.objectContaining({ id: "codex" }),
      ]),
    );
  });

  test("rejects non-GET methods", async () => {
    const deps = createMockApiRouteDeps();
    const response = await handleHarnessRequest(
      new Request("http://127.0.0.1/api/harnesses", { method: "POST" }),
      deps,
    );
    expect(response?.status).toBe(405);
  });
});
