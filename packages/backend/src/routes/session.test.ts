import { describe, expect, test, vi } from "vite-plus/test";
import { handleSessionRequest } from "./session.ts";
import { createMockApiRouteDeps } from "../test/mock-api-route-deps.ts";
import type { BackendServiceContext } from "../../../../server/services/index.ts";

const canonical = "/tmp/opengui-test-repo";

type ApiJson = { ok: boolean; value?: { sessions?: unknown[] } & Record<string, unknown> };

function sessionServices() {
  return {
    harnesses: {
      listDirectorySessions: vi.fn(async () => [
        {
          harnessId: "pi" as const,
          sessions: [{ id: "raw-1", title: "One", status: { type: "idle" } }],
        },
      ]),
      createSession: vi.fn(async () => ({
        id: "pi:new",
        rawId: "new",
        directory: canonical,
        harnessId: "pi",
        title: "New",
        status: "idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
      getManagedHarnessIds: () => ["pi"],
    },
    sessions: {
      listQueue: vi.fn(async () => []),
    },
  } as unknown as BackendServiceContext;
}

describe("handleSessionRequest", () => {
  test("POST /api/sessions/query requires object body", async () => {
    const deps = createMockApiRouteDeps({ services: sessionServices() });
    const response = await handleSessionRequest(
      new Request("http://127.0.0.1/api/sessions/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([]),
      }),
      deps,
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ ok: false });
  });

  test("GET /api/queues requires directory and harnessId", async () => {
    const deps = createMockApiRouteDeps({ canonicalDirectory: canonical });
    const response = await handleSessionRequest(new Request("http://127.0.0.1/api/queues"), deps);
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("directory and harnessId"),
    });
  });

  test("GET /api/sessions lists sessions when directory and harnessId provided", async () => {
    const services = sessionServices();
    const deps = createMockApiRouteDeps({ services, canonicalDirectory: canonical });
    const response = await handleSessionRequest(
      new Request(
        `http://127.0.0.1/api/sessions?directory=${encodeURIComponent(canonical)}&harnessId=pi`,
      ),
      deps,
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as ApiJson;
    expect(body.ok).toBe(true);
    expect(body.value?.sessions).toHaveLength(1);
  });

  test("POST /api/sessions requires harnessId and directory", async () => {
    const deps = createMockApiRouteDeps({ services: sessionServices() });
    const response = await handleSessionRequest(
      new Request("http://127.0.0.1/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: canonical }),
      }),
      deps,
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ ok: false, error: "harnessId is required" });
  });

  test("GET /api/sessions/:id returns session for read", async () => {
    const deps = createMockApiRouteDeps({ canonicalDirectory: canonical });
    const response = await handleSessionRequest(
      new Request("http://127.0.0.1/api/sessions/session-1"),
      deps,
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      ok: true,
      value: expect.objectContaining({ id: "pi:session-1" }),
    });
  });

  test("GET /api/sessions/:id/queue returns queue envelope", async () => {
    const services = {
      ...sessionServices(),
      queues: {
        listSessionQueue: vi.fn(async () => [{ id: "q1", text: "queued" }]),
      },
    } as unknown as BackendServiceContext;
    const deps = createMockApiRouteDeps({
      services,
      canonicalDirectory: canonical,
      sessionQueueScope: async () => ({ directory: canonical, harnessId: "pi" }),
    });
    const response = await handleSessionRequest(
      new Request("http://127.0.0.1/api/sessions/session-1/queue"),
      deps,
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as ApiJson;
    expect(body.ok).toBe(true);
    expect(body.value).toEqual([{ id: "q1", text: "queued" }]);
  });

  test("unknown session subpath returns 404", async () => {
    const deps = createMockApiRouteDeps();
    const response = await handleSessionRequest(
      new Request("http://127.0.0.1/api/sessions/session-1/unknown-action"),
      deps,
    );
    expect(response?.status).toBe(404);
  });
});
