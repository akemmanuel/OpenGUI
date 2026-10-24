import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { ModelRequest, ModelStreamEvent } from "@opengui/harness";
import { OpenGuiHost } from "./opengui-host.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function codexHostDirectory() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "opengui-codex-tools-host-"));
  directories.push(dataDirectory);
  await writeFile(
    join(dataDirectory, "opengui-host-secrets.json"),
    JSON.stringify({
      codex: {
        accessToken: "access",
        refreshToken: "refresh",
        accountId: "account",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
  return dataDirectory;
}

function requestUrl(input: string | URL | Request) {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : input;
}

function codexFetch() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = requestUrl(input);
    if (url === "https://chatgpt.com/backend-api/codex/alpha/search")
      return Response.json({
        output: "Node 24 is LTS.",
        results: [{ title: "Node.js", url: "https://nodejs.org" }],
      });
    return Response.json({
      "gpt-6-astra": {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        api: "openai-codex-responses",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 272000,
        maxTokens: 128000,
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
      },
    });
  });
}

describe("OpenGuiHost ChatGPT tools", () => {
  test("offers ChatGPT tools to Codex runs and calls them with the Codex credential", async () => {
    const dataDirectory = await codexHostDirectory();
    const fetchImpl = codexFetch();
    const requests: ModelRequest[] = [];
    const host = new OpenGuiHost(dataDirectory, {
      fetchImpl,
      model: {
        async *stream(request): AsyncIterable<ModelStreamEvent> {
          requests.push(request);
          if (requests.length === 1)
            yield {
              type: "tool_call",
              id: "search-1",
              name: "web_search",
              input: { search_query: [{ q: "node lts" }] },
            };
          else yield { type: "text_delta", delta: "Node 24." };
          yield { type: "completed" };
        },
      },
    });
    await host.start();
    try {
      const session = await host.createSession({
        projectDirectory: dataDirectory,
        model: { connectionId: "chatgpt-codex", modelId: "gpt-6-astra" },
        reasoning: "none",
      });
      await host.prompt(session.id, { text: "Which Node is LTS?" });
      await host.waitForIdle(session.id);

      expect(requests[0]?.toolDefinitions?.map((definition) => definition.name)).toEqual(
        expect.arrayContaining(["web_search", "generate_image"]),
      );
      const searchCall = fetchImpl.mock.calls.find(
        ([input]) => requestUrl(input) === "https://chatgpt.com/backend-api/codex/alpha/search",
      );
      expect(searchCall?.[1]?.headers).toMatchObject({
        authorization: "Bearer access",
        originator: "opengui",
      });
      expect(JSON.parse(searchCall?.[1]?.body as string)).toMatchObject({
        id: session.id,
        model: "gpt-6-astra",
      });
      const result = (await host.readSession(session.id)).entries.find(
        (entry) => entry.kind === "tool_result",
      );
      expect(result?.payload.output).toEqual({
        content: "Node 24 is LTS.",
        sources: [{ title: "Node.js", url: "https://nodejs.org" }],
      });
    } finally {
      await host.close();
    }
  });

  test("persists the Host policy and withholds disabled tools", async () => {
    const dataDirectory = await codexHostDirectory();
    const requests: ModelRequest[] = [];
    const model = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        requests.push(request);
        yield { type: "text_delta", delta: "ok" };
        yield { type: "completed" };
      },
    };
    const host = new OpenGuiHost(dataDirectory, { fetchImpl: codexFetch(), model });
    await host.start();
    try {
      await expect(host.setCodexToolsSettings({ webSearch: "sometimes" })).rejects.toThrow(
        /webSearch/,
      );
      expect(await host.setCodexToolsSettings({ webSearch: "off" })).toEqual({
        webSearch: "off",
        imageGeneration: true,
        sharedOfferings: false,
      });
    } finally {
      await host.close();
    }

    const restarted = new OpenGuiHost(dataDirectory, {
      fetchImpl: codexFetch(),
      model,
    });
    await restarted.start();
    try {
      expect(restarted.getCodexToolsSettings().webSearch).toBe("off");
      const session = await restarted.createSession({
        projectDirectory: dataDirectory,
        model: { connectionId: "chatgpt-codex", modelId: "gpt-6-astra" },
        reasoning: "none",
      });
      await restarted.prompt(session.id, { text: "hello" });
      await restarted.waitForIdle(session.id);
      const names = requests.at(-1)?.toolDefinitions?.map((definition) => definition.name);
      expect(names).toContain("generate_image");
      expect(names).not.toContain("web_search");
    } finally {
      await restarted.close();
    }
  });
});
