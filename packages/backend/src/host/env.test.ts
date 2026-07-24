import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { readBackendHostEnv } from "./env.ts";

afterEach(() => vi.unstubAllEnvs());

describe("Host identity mode", () => {
  test("defaults ordinary Hosts to remote identity", () => {
    vi.stubEnv("OPENGUI_MODE", "combined");
    vi.stubEnv("OPENGUI_IDENTITY_MODE", "");
    expect(readBackendHostEnv().identityMode).toBe("remote");
  });

  test("rejects Desktop Local bypass outside a loopback sidecar", () => {
    vi.stubEnv("OPENGUI_MODE", "api-only");
    vi.stubEnv("OPENGUI_IDENTITY_MODE", "desktop-local");
    vi.stubEnv("HOST", "0.0.0.0");
    expect(() => readBackendHostEnv()).toThrow(
      "Desktop Local identity bypass requires the loopback desktop sidecar",
    );
  });

  test("defaults remote path grants to enforced and keeps Desktop Local disabled", () => {
    expect(readBackendHostEnv().pathGrantsMode).toBe("enforced");
    vi.stubEnv("OPENGUI_MODE", "desktop-sidecar");
    vi.stubEnv("OPENGUI_IDENTITY_MODE", "desktop-local");
    vi.stubEnv("HOST", "127.0.0.1");
    expect(readBackendHostEnv().pathGrantsMode).toBe("disabled");
  });

  test("rejects an unknown path grant mode", () => {
    vi.stubEnv("OPENGUI_PATH_GRANTS", "audit");
    expect(() => readBackendHostEnv()).toThrow(
      "OPENGUI_PATH_GRANTS must be 'disabled' or 'enforced'",
    );
  });
});
