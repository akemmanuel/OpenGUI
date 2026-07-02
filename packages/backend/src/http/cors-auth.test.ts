import { describe, expect, test } from "vite-plus/test";
import { createCorsAuth } from "./cors-auth.ts";

describe("createCorsAuth", () => {
  test("allows all requests when authToken is empty", () => {
    const cors = createCorsAuth({ authToken: "", allowedCorsOrigin: "https://app.example" });
    const request = new Request("http://127.0.0.1/api/capabilities");
    expect(cors.isAuthorizedRequest(request)).toBe(true);
  });

  test("requires Bearer token when authToken is set", () => {
    const cors = createCorsAuth({ authToken: "secret", allowedCorsOrigin: "*" });
    expect(
      cors.isAuthorizedRequest(
        new Request("http://127.0.0.1/api/sessions", {
          headers: { authorization: "Bearer secret" },
        }),
      ),
    ).toBe(true);
    expect(
      cors.isAuthorizedRequest(
        new Request("http://127.0.0.1/api/sessions", {
          headers: { Authorization: "Bearer wrong" },
        }),
      ),
    ).toBe(false);
    expect(cors.isAuthorizedRequest(new Request("http://127.0.0.1/api/sessions"))).toBe(false);
  });

  test("accepts token query parameter", () => {
    const cors = createCorsAuth({ authToken: "secret", allowedCorsOrigin: "*" });
    expect(
      cors.isAuthorizedRequest(new Request("http://127.0.0.1/api/sessions?token=secret")),
    ).toBe(true);
  });

  test("unauthorizedResponse returns AUTH_REQUIRED JSON with CORS headers", async () => {
    const cors = createCorsAuth({ authToken: "x", allowedCorsOrigin: "https://client.test" });
    const response = cors.unauthorizedResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.test");
    expect(await response.json()).toEqual({
      ok: false,
      error: "Unauthorized",
      code: "AUTH_REQUIRED",
      recoverable: true,
    });
  });

  test("optionsResponse returns 204 with CORS headers", () => {
    const cors = createCorsAuth({ authToken: "", allowedCorsOrigin: "*" });
    const response = cors.optionsResponse();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  test("withCors merges CORS headers onto existing response", async () => {
    const cors = createCorsAuth({ authToken: "", allowedCorsOrigin: "http://localhost:5173" });
    const response = cors.withCors(Response.json({ ok: true }));
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(await response.json()).toEqual({ ok: true });
  });
});
