import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vite-plus/test";
import { startWebServer } from "./start-web-server";

function host(servesFrontend = false) {
  return {
    env: { hostname: "127.0.0.1", port: 41234, servesFrontend },
    app: { fetch: vi.fn() },
  };
}

describe("standalone Host server startup", () => {
  test("propagates Host bootstrap errors to the process entrypoint", () => {
    expect(() =>
      startWebServer({
        createBackendHost: () => {
          throw new Error("invalid Host configuration");
        },
      }),
    ).toThrow("invalid Host configuration");
  });

  test("propagates synchronous listen failures to the process entrypoint", () => {
    expect(() =>
      startWebServer({
        createBackendHost: () => host() as never,
        serve: (() => {
          throw new Error("listen failed");
        }) as never,
      }),
    ).toThrow("listen failed");
  });

  test.each([
    [false, "OpenGUI API-only running at http://127.0.0.1:41234"],
    [true, "OpenGUI combined running at http://127.0.0.1:41234"],
  ])("binds the configured interface and reports mode", (servesFrontend, message) => {
    const server = new EventEmitter();
    const info = vi.fn();
    const serve = vi.fn((_options, listening) => {
      listening?.({} as never);
      return server;
    });
    startWebServer({
      createBackendHost: () => host(servesFrontend) as never,
      serve: serve as never,
      info,
    });

    expect(serve).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "127.0.0.1",
        port: 41234,
        overrideGlobalObjects: false,
      }),
      expect.any(Function),
    );
    expect(info).toHaveBeenCalledWith(message);
  });

  test("surfaces an asynchronous bind error before listening", () => {
    const server = new EventEmitter();
    const startupError = vi.fn();
    startWebServer({
      createBackendHost: () => host() as never,
      serve: (() => server) as never,
      startupError,
    });
    const error = new Error("EADDRINUSE");
    server.emit("error", error);
    expect(startupError).toHaveBeenCalledWith(error);
  });

  test("surfaces a server error even when it arrives after the listening callback", () => {
    const server = new EventEmitter();
    const startupError = vi.fn();
    startWebServer({
      createBackendHost: () => host() as never,
      serve: ((_options: unknown, listening: () => void) => {
        listening();
        return server;
      }) as never,
      startupError,
    });
    const error = new Error("runtime failure");
    server.emit("error", error);
    expect(startupError).toHaveBeenCalledWith(error);
  });
});
