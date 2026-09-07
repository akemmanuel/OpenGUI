import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { ModelCatalog } from "./model-catalog.ts";

const preset = {
  id: "chatgpt-codex",
  label: "Codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  defaultModelId: "gpt-5.4",
};
const astra = {
  id: "gpt-6-astra",
  name: "GPT-6 Astra",
  api: "openai-codex-responses",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 272000,
  maxTokens: 128000,
  cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
  thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: "max" },
  compat: { supportsOpenAIGrammarTools: true },
};
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "opengui-catalog-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Host model catalog", () => {
  test("adds a released model without a package update, preserving routing and defaults", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          [astra.id]: {
            ...astra,
            baseUrl: "https://untrusted.invalid",
            headers: { authorization: "remote" },
          },
          unsupported: { ...astra, id: "unsupported", api: "google-generative-ai" },
        },
        { headers: { etag: '"v1"' } },
      ),
    );
    const catalog = new ModelCatalog(await directory(), fetchImpl as typeof fetch);
    await Promise.all([catalog.refresh("openai-codex"), catalog.refresh("openai-codex")]);
    const connection = catalog.connection("openai-codex", preset);
    expect(connection.baseUrl).toBe(preset.baseUrl);
    expect(connection.defaultModelId).toBe("gpt-5.4");
    expect(connection.modelIds).toContain(astra.id);
    expect(connection.modelIds).not.toContain("unsupported");
    expect(connection.modelRoutes?.[astra.id]).toBe("responses");
    expect(connection.modelCapabilities?.[astra.id]).toMatchObject({
      context: 272000,
      maxTokens: 128000,
      reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(JSON.stringify(connection)).not.toContain("untrusted");
    expect(JSON.stringify(connection)).not.toContain("authorization");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await catalog.refresh("openai-codex");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("restores the disk cache and revalidates it with an ETag", async () => {
    const path = await directory();
    const first = new ModelCatalog(
      path,
      vi.fn(async () => Response.json([astra], { headers: { etag: '"v1"' } })) as typeof fetch,
    );
    await first.refresh("openai-codex");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }));
    const restarted = new ModelCatalog(path, fetchImpl as typeof fetch);
    await restarted.refresh("openai-codex");
    expect(fetchImpl).not.toHaveBeenCalled();
    await restarted.refresh("openai-codex", true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://pi.dev/api/models/providers/openai-codex",
      expect.objectContaining({ headers: { accept: "application/json", "if-none-match": '"v1"' } }),
    );
    expect(restarted.connection("openai-codex", preset).modelIds).toContain(astra.id);
  });

  test.each(
    [
      [],
      [{ ...astra, maxTokens: -1 }],
      [{ ...astra, api: "unknown-api" }],
      [{ ...astra, thinkingLevelMap: { high: {} } }],
    ].map((invalid) => ({ invalid })),
  )("keeps cached models after an invalid response: $invalid", async ({ invalid }) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json([astra]))
      .mockResolvedValueOnce(Response.json(invalid));
    const catalog = new ModelCatalog(await directory(), fetchImpl);
    await catalog.refresh("openai-codex");
    await catalog.refresh("openai-codex", true);
    expect(catalog.connection("openai-codex", preset).modelIds).toContain(astra.id);
  });

  test("uses bundled models when the cache is corrupt and the network is unavailable", async () => {
    const path = await directory();
    await writeFile(join(path, "openai-codex.json"), "broken json");
    const catalog = new ModelCatalog(path, vi.fn().mockRejectedValue(new Error("offline")));
    await catalog.refresh("openai-codex");
    expect(catalog.connection("openai-codex", preset).modelIds).toContain("gpt-5.4");
  });

  test("does not offer paid Zen models without a key", async () => {
    const catalog = new ModelCatalog(
      await directory(),
      vi.fn(async () =>
        Response.json([
          { ...astra, api: "openai-responses" },
          {
            ...astra,
            id: "new-free-model",
            api: "openai-completions",
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ]),
      ) as typeof fetch,
    );
    await catalog.refresh("opencode");
    expect(catalog.connection("opencode", preset, true).modelIds).toContain("new-free-model");
    expect(catalog.connection("opencode", preset, true).modelIds).not.toContain(astra.id);
    expect(catalog.connection("opencode", preset).modelIds).toContain(astra.id);
  });
});
