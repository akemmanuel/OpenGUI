import { describe, expect, test, vi } from "vite-plus/test";
import { handlePermissionRequest } from "./permission.ts";
import { createMockApiRouteDeps } from "../test/mock-api-route-deps.ts";

describe("handlePermissionRequest", () => {
  test("returns null for unrelated paths", async () => {
    const deps = createMockApiRouteDeps();
    expect(
      await handlePermissionRequest(new Request("http://127.0.0.1/api/sessions"), deps),
    ).toBeNull();
  });

  test("POST respond requires sessionId and response", async () => {
    const deps = createMockApiRouteDeps();
    const response = await handlePermissionRequest(
      new Request("http://127.0.0.1/api/permissions/per-1/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "pi:session-1" }),
      }),
      deps,
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("sessionId and response"),
    });
  });

  test("POST respond forwards to harness permission handler", async () => {
    const respondPermission = vi.fn(async () => undefined);
    const deps = createMockApiRouteDeps({
      services: {
        harnesses: { respondPermission },
      } as never,
    });
    const response = await handlePermissionRequest(
      new Request("http://127.0.0.1/api/permissions/per-1/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "pi:session-1",
          response: "once",
          directory: "/tmp/opengui-test-repo",
          harnessId: "pi",
        }),
      }),
      deps,
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true, value: true });
    expect(respondPermission).toHaveBeenCalled();
  });
});
