import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  contentFingerprint,
  processImageFile,
  type AgentToolScope,
  type AgentToolSource,
  type ModelToolDefinition,
} from "@opengui/harness";
import { codexBackendPost, type CodexToolCredential } from "./codex-backend.ts";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const GENERATE_IMAGE_TOOL_NAME = "generate_image";
/** Gitignored Project folder for generated images, next to `.opengui-uploads`. */
export const GENERATED_IMAGES_DIRECTORY = ".opengui-images";

const IMAGE_MODEL = "gpt-image-2";
const MAX_REFERENCE_IMAGES = 5;
const MAX_SEARCH_SOURCES = 10;
const SEARCH_TIMEOUT_MS = 90_000;
const IMAGE_TIMEOUT_MS = 5 * 60_000;
const SEARCH_OUTPUT_TOKENS = { short: 1_500, medium: 2_500, long: 4_000 } as const;

export type CodexWebSearchMode = "off" | "cached" | "live";

/** Host-wide policy for the ChatGPT-backed tools offered alongside Codex models. */
export interface CodexToolsSettings {
  webSearch: CodexWebSearchMode;
  imageGeneration: boolean;
  /** Let Accounts use these tools through a shared model offering on the Host's subscription. */
  sharedOfferings: boolean;
}

export const DEFAULT_CODEX_TOOLS_SETTINGS: CodexToolsSettings = {
  webSearch: "live",
  imageGeneration: true,
  sharedOfferings: false,
};

export function normalizeCodexToolsSettings(value: unknown): CodexToolsSettings {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    webSearch:
      record.webSearch === "off" || record.webSearch === "cached" || record.webSearch === "live"
        ? record.webSearch
        : DEFAULT_CODEX_TOOLS_SETTINGS.webSearch,
    imageGeneration:
      typeof record.imageGeneration === "boolean"
        ? record.imageGeneration
        : DEFAULT_CODEX_TOOLS_SETTINGS.imageGeneration,
    sharedOfferings:
      typeof record.sharedOfferings === "boolean"
        ? record.sharedOfferings
        : DEFAULT_CODEX_TOOLS_SETTINGS.sharedOfferings,
  };
}

/** The Codex credential selected for one run, or null when the run is not on a Codex model. */
export interface CodexToolRoute {
  /** Upstream Codex model id the search backend attributes requests to. */
  modelId: string;
  /** True when a shared model offering runs on the Host's ChatGPT subscription. */
  shared: boolean;
  credential(forceRefresh: boolean): Promise<CodexToolCredential>;
}

export interface CodexAgentToolSourceOptions {
  route(scope: AgentToolScope): Promise<CodexToolRoute | null>;
  settings(): CodexToolsSettings;
  /** Authorize a Host path for the scope's actor; returns the canonical path or throws. */
  authorizePath(
    scope: AgentToolScope,
    path: string,
    access: "read" | "write",
    options?: { allowMissingLeaf?: boolean },
  ): Promise<string>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const WEB_SEARCH_DEFINITION: ModelToolDefinition = {
  name: WEB_SEARCH_TOOL_NAME,
  title: "Web search",
  maxResultBytes: 32 * 1024,
  description: `Search the internet and read web pages through the user's ChatGPT account.

Commands (combine several in one call when useful):
- search_query: [{"q": "..."}] runs up to 4 searches. Optional "recency" (days) and "domains" filters.
- open: [{"ref_id": "turn0search0"}] or [{"ref_id": "https://example.com", "lineno": 120}] reads a result or URL.
- find: [{"ref_id": "turn0fetch1", "pattern": "text"}] finds text in an opened page.
- response_length: "short" | "medium" | "long" controls how much text is returned.

Use this tool when information may have changed recently (news, prices, releases, laws, schedules, library versions), when the user asks to search or verify, when a specific page is referenced, or when you are unsure about a niche fact.

Results contain reference IDs such as turn0search0. Use them only in later web_search calls; never show them to the user. Cite web sources in the final answer as Markdown links next to the claims they support, for example [Node.js releases](https://nodejs.org/en/about/previous-releases). Link to the page itself, not to a search results page.`,
  parameters: {
    type: "object",
    properties: {
      search_query: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            q: { type: "string" },
            recency: { type: "integer", description: "Only results from the last N days." },
            domains: { type: "array", items: { type: "string" } },
          },
          required: ["q"],
        },
      },
      open: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref_id: { type: "string", description: "A result reference ID or a URL." },
            lineno: { type: "integer" },
          },
          required: ["ref_id"],
        },
      },
      find: {
        type: "array",
        items: {
          type: "object",
          properties: { ref_id: { type: "string" }, pattern: { type: "string" } },
          required: ["ref_id", "pattern"],
        },
      },
      response_length: { type: "string", enum: ["short", "medium", "long"] },
    },
  },
};

const GENERATE_IMAGE_DEFINITION: ModelToolDefinition = {
  name: GENERATE_IMAGE_TOOL_NAME,
  title: "Image generation",
  description: `Generate a raster image from a description, or edit existing images, through the user's ChatGPT account.

Use it for photos, illustrations, mockups, textures, sprites, concept art, or transparent cutouts. Prefer writing SVG, HTML, or CSS instead when the request is for simple shapes, diagrams, icons that match existing vector assets, or anything better produced as code.

- Write a clear, specific prompt: subject, style or medium, composition, lighting, colors, and any exact text in quotes. Keep the user's details; add only what materially improves the result.
- To edit or use images as references, pass their file paths in referenced_image_paths (at most 5). Images the user attached or that were generated earlier have file paths in the conversation.
- Set transparent_background to true for cutouts, stickers, or background removal.
- Generation can take one to two minutes. Call the tool once per distinct image.

The result is shown to the user automatically and saved in the Project's ${GENERATED_IMAGES_DIRECTORY} folder. If the Project needs the image elsewhere, copy it to that path.`,
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      transparent_background: { type: "boolean" },
      referenced_image_paths: {
        type: "array",
        maxItems: MAX_REFERENCE_IMAGES,
        items: { type: "string" },
      },
    },
    required: ["prompt"],
  },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function searchCommands(input: unknown) {
  const raw = record(input);
  const searchQuery = (Array.isArray(raw.search_query) ? raw.search_query : [])
    .map(record)
    .filter((query) => typeof query.q === "string" && query.q.trim())
    .slice(0, 4)
    .map((query) => ({
      q: String(query.q).trim(),
      ...(typeof query.recency === "number" && query.recency > 0
        ? { recency: Math.floor(query.recency) }
        : {}),
      ...(stringList(query.domains).length ? { domains: stringList(query.domains) } : {}),
    }));
  const open = (Array.isArray(raw.open) ? raw.open : [])
    .map(record)
    .filter((item) => typeof item.ref_id === "string" && item.ref_id.trim())
    .map((item) => ({
      ref_id: String(item.ref_id).trim(),
      ...(typeof item.lineno === "number" && item.lineno >= 0
        ? { lineno: Math.floor(item.lineno) }
        : {}),
    }));
  const find = (Array.isArray(raw.find) ? raw.find : [])
    .map(record)
    .filter((item) => typeof item.ref_id === "string" && typeof item.pattern === "string")
    .map((item) => ({ ref_id: String(item.ref_id), pattern: String(item.pattern) }));
  const responseLength = Object.hasOwn(SEARCH_OUTPUT_TOKENS, String(raw.response_length))
    ? (raw.response_length as keyof typeof SEARCH_OUTPUT_TOKENS)
    : undefined;
  if (!searchQuery.length && !open.length && !find.length)
    throw new Error("web_search needs at least one search_query, open, or find command");
  return {
    ...(searchQuery.length ? { search_query: searchQuery } : {}),
    ...(open.length ? { open } : {}),
    ...(find.length ? { find } : {}),
    // The backend requires a longer response for more than three queries.
    ...(responseLength
      ? { response_length: responseLength }
      : searchQuery.length > 3
        ? { response_length: "medium" as const }
        : {}),
  };
}

/**
 * The search backend marks citations with private-use delimiters
 * (U+E200 open, U+E202 separator, U+E201 close). Keep the reference IDs
 * readable for the model and never let the raw markers reach a transcript.
 */
export function normalizeSearchOutput(output: string) {
  return output
    .replace(/[^]*([^]*)/gu, (_match, refs) => {
      const ids = String(refs).split("").filter(Boolean);
      return ids.length ? `[${ids.join(", ")}]` : "";
    })
    .replace(/[-]/gu, "");
}

function searchSources(results: unknown) {
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  const sources: Array<{ title: string; url: string }> = [];
  for (const item of results.map(record)) {
    const url = typeof item.url === "string" ? item.url : "";
    if (!/^https?:\/\//iu.test(url) || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : url,
      url,
    });
    if (sources.length >= MAX_SEARCH_SOURCES) break;
  }
  return sources;
}

function safeFileSegment(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "image";
}

/** Write a generated image under the Project's gitignored image folder without overwriting. */
async function saveGeneratedImage(
  options: CodexAgentToolSourceOptions,
  scope: AgentToolScope,
  bytes: Buffer,
  toolCallId: string,
) {
  const project = await options.authorizePath(scope, scope.projectDirectory, "write");
  const directory = await options.authorizePath(
    scope,
    join(project, GENERATED_IMAGES_DIRECTORY),
    "write",
    { allowMissingLeaf: true },
  );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ".gitignore"), "*\n", { flag: "wx" }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const base = safeFileSegment(toolCallId);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const name = attempt === 0 ? `${base}.png` : `${base}-${attempt + 1}.png`;
    const path = await options.authorizePath(scope, join(directory, name), "write", {
      allowMissingLeaf: true,
    });
    try {
      await writeFile(path, bytes, { flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not choose a free file name for the generated image");
}

async function referenceImages(
  options: CodexAgentToolSourceOptions,
  scope: AgentToolScope,
  paths: string[],
) {
  if (paths.length > MAX_REFERENCE_IMAGES)
    throw new Error(`referenced_image_paths accepts at most ${MAX_REFERENCE_IMAGES} images`);
  return await Promise.all(
    paths.map(async (rawPath) => {
      const requested = isAbsolute(rawPath)
        ? resolve(rawPath)
        : resolve(scope.projectDirectory, rawPath);
      const path = await options.authorizePath(scope, requested, "read");
      const image = await processImageFile(path).catch(() => null);
      if (!image) throw new Error(`Referenced file is not a supported image: ${rawPath}`);
      return { image_url: `data:${image.mimeType};base64,${image.data}` };
    }),
  );
}

/** ChatGPT web search and image generation, offered only while a run uses a Codex model. */
export function createCodexAgentToolSource(options: CodexAgentToolSourceOptions): AgentToolSource {
  return {
    async resolve(scope) {
      const settings = options.settings();
      const enabled = settings.webSearch !== "off" || settings.imageGeneration;
      const route = enabled ? await options.route(scope) : null;
      const available = route && (!route.shared || settings.sharedOfferings) ? route : null;
      const definitions = available
        ? [
            ...(settings.webSearch !== "off" ? [WEB_SEARCH_DEFINITION] : []),
            ...(settings.imageGeneration ? [GENERATE_IMAGE_DEFINITION] : []),
          ]
        : [];
      return {
        generation: contentFingerprint({
          tools: definitions.map((definition) => definition.name),
          webSearch: settings.webSearch,
        }).slice(0, 24),
        definitions,
        async invoke(call, signal) {
          if (!available || !definitions.some((definition) => definition.name === call.name))
            throw new Error(`ChatGPT tool is not available: ${call.name}`);
          const credential = available.credential.bind(available);
          if (call.name === WEB_SEARCH_TOOL_NAME) {
            const commands = searchCommands(call.input);
            const length = commands.response_length ?? "medium";
            const response = await codexBackendPost<{ output?: unknown; results?: unknown }>({
              path: "alpha/search",
              label: "Web search",
              credential,
              signal,
              timeoutMs: SEARCH_TIMEOUT_MS,
              fetchImpl: options.fetchImpl,
              baseUrl: options.baseUrl,
              body: {
                // Search state (reference IDs) is scoped to this Session.
                id: scope.sessionId,
                model: available.modelId,
                commands,
                settings: {
                  external_web_access: settings.webSearch === "live",
                  allowed_callers: ["direct"],
                },
                max_output_tokens: SEARCH_OUTPUT_TOKENS[length],
              },
            });
            const content =
              typeof response.output === "string" ? normalizeSearchOutput(response.output) : "";
            return {
              content: content || "No results.",
              sources: searchSources(response.results),
            };
          }

          const input = record(call.input);
          const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
          if (!prompt) throw new Error("generate_image requires a prompt");
          const references = await referenceImages(
            options,
            scope,
            stringList(input.referenced_image_paths),
          );
          const background = input.transparent_background === true ? "transparent" : "opaque";
          const response = await codexBackendPost<{ data?: Array<{ b64_json?: unknown }> }>({
            path: references.length ? "images/edits" : "images/generations",
            label: "Image generation",
            credential,
            signal,
            timeoutMs: IMAGE_TIMEOUT_MS,
            fetchImpl: options.fetchImpl,
            baseUrl: options.baseUrl,
            body: {
              ...(references.length ? { images: references } : {}),
              prompt,
              background,
              model: IMAGE_MODEL,
              quality: "auto",
              size: "auto",
            },
          });
          const encoded = response.data?.[0]?.b64_json;
          if (typeof encoded !== "string" || !encoded)
            throw new Error("Image generation returned no image");
          const bytes = Buffer.from(encoded, "base64");
          let savedPath: string | undefined;
          let saveError: string | undefined;
          try {
            savedPath = await saveGeneratedImage(
              options,
              scope,
              bytes,
              call.toolCallId ?? randomUUID(),
            );
          } catch (error) {
            saveError = error instanceof Error ? error.message : "unknown error";
          }
          // Model-facing copy stays below provider image limits; the saved file keeps full size.
          const preview = savedPath ? await processImageFile(savedPath).catch(() => null) : null;
          const attachment = preview
            ? { type: "image" as const, data: preview.data, mimeType: preview.mimeType }
            : { type: "image" as const, data: encoded, mimeType: "image/png" };
          return {
            content: savedPath
              ? `Generated image saved to ${savedPath}. It is already shown to the user, so do not embed it again unless asked. To use it elsewhere in the Project, copy it and keep the original.`
              : `Generated image could not be saved to the Project (${saveError}). It is attached here but the user may not see it.`,
            ...(savedPath
              ? { savedPath, previewImages: [{ path: savedPath, mimeType: "image/png" }] }
              : {}),
            transparentBackground: background === "transparent",
            attachments: [attachment],
          };
        },
      };
    },
  };
}
