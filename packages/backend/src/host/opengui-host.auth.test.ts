import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { OpenGuiHost } from "./opengui-host.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function directory() {
  const value = await mkdtemp(join(tmpdir(), "opengui-auth-test-"));
  directories.push(value);
  return value;
}

describe("OpenGuiHost authentication persistence", () => {
  test("persists an OpenCode Go API key separately and never returns it", async () => {
    const dataDirectory = await directory();
    const catalogFetch = vi.fn(async () =>
      Response.json({
        data: [{ id: "glm-5.2" }, { id: "qwen3.7-max" }, { id: "hy3-preview" }],
      }),
    );
    const host = new OpenGuiHost(dataDirectory, { fetchImpl: catalogFetch as typeof fetch });
    await host.start();
    await host.listSessions(dataDirectory);
    await host.upsertModelConnection({
      id: "opencode-go",
      label: "OpenCode Go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "go-secret",
      modelIds: ["glm-5.2"],
    });

    expect(host.listModelConnections()).toEqual([
      expect.objectContaining({
        id: "opencode-go",
        label: "OpenCode Go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        defaultModelId: "glm-5.2",
        modelIds: ["glm-5.2", "qwen3.7-max"],
      }),
    ]);
    await host.close();

    const secretsPath = join(dataDirectory, "opengui-host-secrets.json");
    expect(JSON.parse(await readFile(secretsPath, "utf8"))).toMatchObject({
      "opencode-go": "go-secret",
    });
    expect((await stat(secretsPath)).mode & 0o777).toBe(0o600);

    const restarted = new OpenGuiHost(dataDirectory, { fetchImpl: catalogFetch as typeof fetch });
    await restarted.start();
    await restarted.listSessions(dataDirectory);
    expect(restarted.listModelConnections()[0]?.id).toBe("opencode-go");
    await restarted.close();
  });

  test("rejects malformed Codex and legacy OpenCode OAuth credentials", async () => {
    const dataDirectory = await directory();
    await writeFile(
      join(dataDirectory, "opengui-host-secrets.json"),
      JSON.stringify({
        codex: { accessToken: "access" },
        subscriptions: {
          opencode: { accessToken: "oauth", refreshToken: "refresh", expiresAt: Date.now() + 1e6 },
        },
      }),
      { mode: 0o600 },
    );
    const host = new OpenGuiHost(dataDirectory);
    await host.start();
    await host.listSessions(dataDirectory);

    expect(host.codexAuthStatus().connected).toBe(false);
    expect(host.listModelConnections()).toEqual([]);
    await host.close();
  });
});
