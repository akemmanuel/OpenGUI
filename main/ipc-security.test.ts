import { describe, expect, test, vi } from "vite-plus/test";
import {
  assertBackendFetchRequest,
  assertProjectPath,
  registerValidatedIpcHandler,
} from "./ipc-security";

describe("Desktop IPC security boundary", () => {
  test.each([
    [{ url: "/api/health" }, { url: "/api/health", method: "GET", headers: {}, body: undefined }],
    [
      {
        url: "/api/sessions",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      {
        url: "/api/sessions",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    ],
  ])("accepts a bounded backend request", (input, expected) => {
    expect(assertBackendFetchRequest(input, "http://127.0.0.1:4123")).toEqual(expected);
  });

  test.each([
    [null],
    [{ url: "https://evil.example" }],
    [{ url: "/", method: "CONNECT" }],
    [{ url: "/", headers: { authorization: "Bearer stolen" } }],
    [{ url: "/", headers: { test: ["not", "a", "string"] } }],
    [{ url: "/", body: 42 }],
  ])("rejects malformed or authority-bearing backend request %j", (request) => {
    expect(() => assertBackendFetchRequest(request, "http://127.0.0.1:4123")).toThrow();
  });

  test.each([
    ["linux", "/home/person/project", "/home/person/project"],
    ["darwin", "/Users/person/project", "/Users/person/project"],
    ["win32", "C:\\Work\\Project", "C:\\Work\\Project"],
  ] as const)("accepts an absolute project path on %s", (platform, value, expected) => {
    expect(assertProjectPath(value, platform)).toBe(expected);
  });

  test.each([
    ["linux", "relative/path"],
    ["linux", "/tmp/a\0b"],
    ["win32", "\\relative"],
    ["win32", "C:relative"],
    ["darwin", ""],
  ] as const)("rejects an unsafe project path on %s", (platform, value) => {
    expect(() => assertProjectPath(value, platform)).toThrow();
  });

  test("invokes a registered handler only for the application document", async () => {
    let registered: ((event: unknown, value: unknown) => unknown) | undefined;
    const handler = vi.fn(async (value: unknown) => value);
    registerValidatedIpcHandler({
      ipcMain: { handle: (_channel, next) => (registered = next) },
      channel: "secure:test",
      appEntryUrl: "file:///app/dist/index.html",
      validate: (value) => String(value),
      handler,
    });

    await expect(
      registered?.({ senderFrame: { url: "file:///app/dist/index.html?detach=x" } }, "ok"),
    ).resolves.toBe("ok");
    await expect(
      registered?.({ senderFrame: { url: "https://evil.example" } }, "blocked"),
    ).rejects.toThrow("untrusted IPC sender");
    expect(handler).toHaveBeenCalledOnce();
  });
});
