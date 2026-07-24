import { describe, expect, test, vi } from "vite-plus/test";
import { waitForDevelopmentServers } from "./dev-desktop-helpers";

describe("Desktop development startup", () => {
  test("waits for both the Frontend and Host to return healthy responses", async () => {
    const responses = [
      new Response("starting", { status: 503 }),
      new Response("ok"),
      new Response("ok"),
      new Response("ok"),
    ];
    const fetch = vi.fn(async () => responses.shift() ?? new Response("ok"));
    const sleep = vi.fn(async () => {});
    await waitForDevelopmentServers({
      frontendUrl: "http://frontend",
      backendUrl: "http://backend",
      attempts: 2,
      fetch: fetch as typeof globalThis.fetch,
      sleep,
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("http://backend/api/health");
  });

  test("surfaces the last health failure after the bounded retry budget", async () => {
    await expect(
      waitForDevelopmentServers({
        frontendUrl: "http://frontend",
        backendUrl: "http://backend",
        attempts: 2,
        fetch: async () => new Response("unhealthy", { status: 500 }),
        sleep: async () => {},
      }),
    ).rejects.toThrow("did not become healthy after 2 attempts");
  });
});
