import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { piAiCatalogConnection, type PiAiCatalogProviderId } from "./pi-ai-catalog.ts";
import type { OpenAiCompatibleConnection } from "./openai-chat.ts";

const FRESH_MS = 4 * 60 * 60 * 1000;
const factories = {
  "openai-codex": openaiCodexProvider,
  opencode: opencodeProvider,
  "opencode-go": opencodeGoProvider,
};
type Entry = { models: Model<any>[]; checkedAt: number; etag?: string };

// Only model metadata crosses this boundary. Endpoint URLs, headers and credentials
// always come from the Host's configured backend, never the remote catalog.
function parseModels(value: unknown, provider: PiAiCatalogProviderId): Model<any>[] {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value)
      : [];
  const supported = entries.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      [
        "openai-completions",
        "openai-responses",
        "openai-codex-responses",
        "anthropic-messages",
      ].includes(item.api),
  );
  if (supported.length === 0) throw new Error("Invalid or unsupported pi model catalog");
  return supported.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      typeof item.name !== "string" ||
      typeof item.reasoning !== "boolean" ||
      !Array.isArray(item.input) ||
      !item.input.every((v: unknown) => v === "text" || v === "image") ||
      !Number.isFinite(item.contextWindow) ||
      item.contextWindow <= 0 ||
      !Number.isFinite(item.maxTokens) ||
      item.maxTokens <= 0 ||
      (provider === "openai-codex" && item.api !== "openai-codex-responses") ||
      !item.cost ||
      !["input", "output", "cacheRead", "cacheWrite"].every(
        (key) =>
          typeof item.cost[key] === "number" &&
          Number.isFinite(item.cost[key]) &&
          item.cost[key] >= 0,
      )
    )
      throw new Error("Invalid pi model metadata");
    const thinkingLevelMap = item.thinkingLevelMap;
    if (
      thinkingLevelMap !== undefined &&
      (!thinkingLevelMap ||
        typeof thinkingLevelMap !== "object" ||
        Array.isArray(thinkingLevelMap) ||
        Object.entries(thinkingLevelMap).some(
          ([key, v]) =>
            !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(key) ||
            (v !== null && typeof v !== "string"),
        ))
    )
      throw new Error("Invalid thinking levels");
    // Compatibility flags are data, but routing/header overrides are not accepted.
    const compat = Object.fromEntries(
      Object.entries(item.compat ?? {}).filter(
        ([key, v]) =>
          (key.startsWith("supports") ||
            key.startsWith("requires") ||
            key === "forceAdaptiveThinking" ||
            key === "thinkingFormat" ||
            key === "maxTokensField") &&
          (typeof v === "boolean" || typeof v === "string"),
      ),
    );
    return {
      id: item.id,
      name: item.name,
      provider,
      api: item.api,
      baseUrl: "",
      reasoning: item.reasoning,
      input: item.input,
      contextWindow: item.contextWindow,
      maxTokens: item.maxTokens,
      cost: item.cost,
      thinkingLevelMap,
      compat,
    };
  });
}

/** Host-local catalog: bundled models, a persisted pi.dev overlay, and no auth. */
export class ModelCatalog {
  readonly #entries = new Map<PiAiCatalogProviderId, Entry>();
  readonly #pending = new Map<PiAiCatalogProviderId, Promise<void>>();
  readonly #directory: string;
  readonly #fetch: typeof fetch;
  constructor(directory: string, fetchImpl: typeof fetch = fetch) {
    this.#directory = directory;
    this.#fetch = fetchImpl;
  }

  connection(
    provider: PiAiCatalogProviderId,
    preset: Pick<OpenAiCompatibleConnection, "id" | "label" | "baseUrl" | "defaultModelId">,
    freeOnly = false,
  ) {
    const overlay = this.#entries.get(provider)?.models;
    const source = overlay && overlay.length > 0 ? overlay : factories[provider]().getModels();
    const models = new Map(source.map((model) => [model.id, model]));
    return piAiCatalogConnection(
      provider,
      preset,
      [...models.values()].filter(
        (model) => !freeOnly || (model.cost.input === 0 && model.cost.output === 0),
      ),
    );
  }

  refresh(provider: PiAiCatalogProviderId, force = false): Promise<void> {
    const pending = this.#pending.get(provider);
    if (pending) return pending;
    const task = this.#refresh(provider, force).finally(() => this.#pending.delete(provider));
    this.#pending.set(provider, task);
    return task;
  }

  async #refresh(provider: PiAiCatalogProviderId, force: boolean) {
    const path = join(this.#directory, `${provider}.json`);
    if (!this.#entries.has(provider)) {
      try {
        const stored = JSON.parse(await readFile(path, "utf8"));
        this.#entries.set(provider, {
          models: parseModels(stored.models, provider),
          checkedAt: typeof stored.checkedAt === "number" ? stored.checkedAt : 0,
          etag: typeof stored.etag === "string" ? stored.etag : undefined,
        });
      } catch {
        /* Missing or invalid cache: use bundled models. */
      }
    }
    const stored = this.#entries.get(provider);
    if (!force && stored && Date.now() - stored.checkedAt < FRESH_MS) return;
    try {
      const response = await this.#fetch(`https://pi.dev/api/models/providers/${provider}`, {
        headers: {
          accept: "application/json",
          ...(stored?.etag ? { "if-none-match": stored.etag } : {}),
        },
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok && !(response.status === 304 && stored))
        throw new Error(`pi catalog: ${response.status}`);
      const entry: Entry =
        response.status === 304 && stored
          ? { ...stored, checkedAt: Date.now() }
          : {
              models: parseModels(await response.json(), provider),
              checkedAt: Date.now(),
              etag: response.headers.get("etag") ?? undefined,
            };
      this.#entries.set(provider, entry);
      await mkdir(this.#directory, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(entry));
      await rename(temporary, path);
    } catch {
      // Back off failed refreshes too, without replacing the persisted catalog.
      this.#entries.set(provider, {
        models: [],
        ...this.#entries.get(provider),
        checkedAt: Date.now(),
      });
    }
  }
}
