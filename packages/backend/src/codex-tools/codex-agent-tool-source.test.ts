import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { AgentToolScope } from "@opengui/harness";
import {
  createCodexAgentToolSource,
  DEFAULT_CODEX_TOOLS_SETTINGS,
  GENERATED_IMAGES_DIRECTORY,
  normalizeCodexToolsSettings,
  normalizeSearchOutput,
  type CodexAgentToolSourceOptions,
  type CodexToolRoute,
  type CodexToolsSettings,
} from "./codex-agent-tool-source.ts";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const ACCESS_TOKEN = [
  "header",
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } }),
  ).toString("base64url"),
  "signature",
].join(".");

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "opengui-codex-tools-"));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

function scope(): AgentToolScope {
  return {
    sessionId: "session_1",
    runId: "run_1",
    projectDirectory: project,
    model: { connectionId: "openai-codex", modelId: "gpt-5.6-sol" },
  };
}

function codexRoute(overrides: Partial<CodexToolRoute> = {}): CodexToolRoute {
  return {
    modelId: "gpt-5.6-sol",
    shared: false,
    credential: vi.fn(async () => ({ accessToken: ACCESS_TOKEN })),
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function source(
  options: Omit<Partial<CodexAgentToolSourceOptions>, "settings"> & {
    settings?: Partial<CodexToolsSettings>;
  } = {},
) {
  const { settings, ...rest } = options;
  return createCodexAgentToolSource({
    route: async () => codexRoute(),
    settings: () => ({ ...DEFAULT_CODEX_TOOLS_SETTINGS, ...settings }),
    authorizePath: async (_scope, path) => path,
    ...rest,
  });
}

const signal = () => new AbortController().signal;

describe("ChatGPT tool availability", () => {
  test("offers both tools only while the run uses a Codex model", async () => {
    const codex = await source().resolve(scope(), signal());
    expect(codex.definitions.map((definition) => definition.name)).toEqual([
      "web_search",
      "generate_image",
    ]);

    const other = await source({ route: async () => null }).resolve(scope(), signal());
    expect(other.definitions).toEqual([]);
    await expect(other.invoke({ name: "web_search", input: {} }, signal())).rejects.toThrow(
      /not available/,
    );
  });

  test("follows the Host policy and changes the tool generation with it", async () => {
    const searchOff = await source({ settings: { webSearch: "off" } }).resolve(scope(), signal());
    expect(searchOff.definitions.map((definition) => definition.name)).toEqual(["generate_image"]);

    const imagesOff = await source({ settings: { imageGeneration: false } }).resolve(
      scope(),
      signal(),
    );
    expect(imagesOff.definitions.map((definition) => definition.name)).toEqual(["web_search"]);
    expect(imagesOff.generation).not.toBe(searchOff.generation);

    const route = vi.fn(async () => codexRoute());
    const allOff = await source({
      route,
      settings: { webSearch: "off", imageGeneration: false },
    }).resolve(scope(), signal());
    expect(allOff.definitions).toEqual([]);
    expect(route).not.toHaveBeenCalled();
  });

  test("keeps shared offerings off the Host subscription unless allowed", async () => {
    const shared = async () => codexRoute({ shared: true });
    expect((await source({ route: shared }).resolve(scope(), signal())).definitions).toEqual([]);
    expect(
      (
        await source({ route: shared, settings: { sharedOfferings: true } }).resolve(
          scope(),
          signal(),
        )
      ).definitions,
    ).toHaveLength(2);
  });

  test("normalizes stored settings to known values", () => {
    expect(normalizeCodexToolsSettings(undefined)).toEqual(DEFAULT_CODEX_TOOLS_SETTINGS);
    expect(
      normalizeCodexToolsSettings({ webSearch: "cached", imageGeneration: false, extra: 1 }),
    ).toEqual({ webSearch: "cached", imageGeneration: false, sharedOfferings: false });
    expect(normalizeCodexToolsSettings({ webSearch: "everything" }).webSearch).toBe("live");
  });
});

describe("web_search", () => {
  test("searches through the Codex backend with Session-scoped state", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({
        encrypted_output: "opaque",
        output:
          "Node.js releases (https://nodejs.org/en/about/previous-releases)\nciteturn0search0 Node 24 is LTS.",
        results: [
          { title: "Node.js releases", url: "https://nodejs.org/en/about/previous-releases" },
          { title: "Duplicate", url: "https://nodejs.org/en/about/previous-releases" },
          { title: "Script", url: "javascript:alert(1)" },
          { url: "https://github.com/nodejs/node/releases" },
        ],
      }),
    );
    const tools = await source({ fetchImpl, settings: { webSearch: "cached" } }).resolve(
      scope(),
      signal(),
    );

    const result = await tools.invoke(
      {
        name: "web_search",
        input: { search_query: [{ q: " node lts ", recency: 30 }, { q: "" }] },
      },
      signal(),
    );

    expect(result).toEqual({
      content:
        "Node.js releases (https://nodejs.org/en/about/previous-releases)\n[turn0search0] Node 24 is LTS.",
      sources: [
        { title: "Node.js releases", url: "https://nodejs.org/en/about/previous-releases" },
        {
          title: "https://github.com/nodejs/node/releases",
          url: "https://github.com/nodejs/node/releases",
        },
      ],
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${ACCESS_TOKEN}`,
      "chatgpt-account-id": "acct_123",
      originator: "opengui",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      id: "session_1",
      model: "gpt-5.6-sol",
      commands: { search_query: [{ q: "node lts", recency: 30 }] },
      settings: { external_web_access: false, allowed_callers: ["direct"] },
      max_output_tokens: 2_500,
    });
  });

  test("refreshes the ChatGPT credential once after a 401", async () => {
    const credential = vi.fn(async () => ({ accessToken: ACCESS_TOKEN }));
    const route = codexRoute({ credential });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ detail: "expired" }, 401))
      .mockResolvedValueOnce(json({ output: "ok", results: [] }));
    const tools = await source({ route: async () => route, fetchImpl }).resolve(scope(), signal());

    await expect(
      tools.invoke({ name: "web_search", input: { open: [{ ref_id: "turn0search0" }] } }, signal()),
    ).resolves.toEqual({ content: "ok", sources: [] });
    expect(credential).toHaveBeenNthCalledWith(1, false);
    expect(credential).toHaveBeenNthCalledWith(2, true);
  });

  test("reports usage limits and rejects empty commands without calling ChatGPT", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ detail: "You've hit your usage limit." }, 429),
    );
    const tools = await source({ fetchImpl }).resolve(scope(), signal());

    await expect(
      tools.invoke({ name: "web_search", input: { search_query: [{ q: "news" }] } }, signal()),
    ).rejects.toThrow(
      "Web search usage limit reached for this ChatGPT account. Try again later. You've hit your usage limit.",
    );
    fetchImpl.mockClear();
    await expect(tools.invoke({ name: "web_search", input: {} }, signal())).rejects.toThrow(
      /at least one/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("removes private-use citation markers", () => {
    expect(normalizeSearchOutput("a citeturn0search1turn0search2 b ")).toBe(
      "a [turn0search1, turn0search2] b ",
    );
  });
});

describe("generate_image", () => {
  test("saves the image in the gitignored Project folder and attaches it for the model", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ data: [{ b64_json: PNG_1X1 }], background: "opaque" }),
    );
    const tools = await source({ fetchImpl }).resolve(scope(), signal());

    const result = (await tools.invoke(
      { name: "generate_image", input: { prompt: "A red fox" }, toolCallId: "call/1" },
      signal(),
    )) as Record<string, any>;

    const savedPath = join(project, GENERATED_IMAGES_DIRECTORY, "call_1.png");
    expect(result.savedPath).toBe(savedPath);
    expect(result.previewImages).toEqual([{ path: savedPath, mimeType: "image/png" }]);
    expect(result.attachments).toEqual([
      { type: "image", mimeType: "image/png", data: expect.any(String) },
    ]);
    expect(result.content).toContain(savedPath);
    expect(await readFile(savedPath, "base64")).toBe(PNG_1X1);
    expect(await readFile(join(project, GENERATED_IMAGES_DIRECTORY, ".gitignore"), "utf8")).toBe(
      "*\n",
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(JSON.parse(init?.body as string)).toEqual({
      prompt: "A red fox",
      background: "opaque",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    });

    // A second image for the same call id never overwrites the first.
    const again = (await tools.invoke(
      { name: "generate_image", input: { prompt: "Another fox" }, toolCallId: "call/1" },
      signal(),
    )) as Record<string, any>;
    expect(again.savedPath).toBe(join(project, GENERATED_IMAGES_DIRECTORY, "call_1-2.png"));
  });

  test("edits authorized reference images through the edits endpoint", async () => {
    await writeFile(join(project, "logo.png"), Buffer.from(PNG_1X1, "base64"));
    const authorizePath = vi.fn(async (_scope: AgentToolScope, path: string) => path);
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ data: [{ b64_json: PNG_1X1 }] }));
    const tools = await source({ fetchImpl, authorizePath }).resolve(scope(), signal());

    await tools.invoke(
      {
        name: "generate_image",
        input: {
          prompt: "Remove the background",
          transparent_background: true,
          referenced_image_paths: ["logo.png"],
        },
        toolCallId: "call_2",
      },
      signal(),
    );

    expect(authorizePath).toHaveBeenCalledWith(scope(), join(project, "logo.png"), "read");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      images: [{ image_url: `data:image/png;base64,${PNG_1X1}` }],
      prompt: "Remove the background",
      background: "transparent",
    });
  });

  test("refuses denied reference paths before spending image quota", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const tools = await source({
      fetchImpl,
      authorizePath: async (_scope, _path, access) => {
        if (access === "read") throw new Error("Path is not granted");
        return _path;
      },
    }).resolve(scope(), signal());

    await expect(
      tools.invoke(
        {
          name: "generate_image",
          input: { prompt: "Edit", referenced_image_paths: ["/etc/secret.png"] },
        },
        signal(),
      ),
    ).rejects.toThrow("Path is not granted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
