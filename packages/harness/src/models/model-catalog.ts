import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  piAiCatalogConnection,
  piBundledModels,
  piProvider,
  type PiAiCatalogProviderId,
} from "./pi-ai-catalog.ts";
import type { OpenAiCompatibleConnection } from "./openai-chat.ts";

const FRESH_MS = 4 * 60 * 60 * 1000;
type Entry = { models: Model<Api>[]; checkedAt: number; etag?: string };

function validModel(item: any) {
  return (
    item &&
    typeof item === "object" &&
    typeof item.id === "string" &&
    item.id.trim() &&
    typeof item.name === "string" &&
    typeof item.reasoning === "boolean" &&
    Array.isArray(item.input) &&
    item.input.every((v: unknown) => v === "text" || v === "image") &&
    Number.isFinite(item.contextWindow) &&
    item.contextWindow > 0 &&
    Number.isFinite(item.maxTokens) &&
    item.maxTokens > 0 &&
    item.cost &&
    ["input", "output", "cacheRead", "cacheWrite"].every(
      (key) =>
        typeof item.cost[key] === "number" &&
        Number.isFinite(item.cost[key]) &&
        item.cost[key] >= 0,
    ) &&
    (item.thinkingLevelMap === undefined ||
      (item.thinkingLevelMap &&
        typeof item.thinkingLevelMap === "object" &&
        !Array.isArray(item.thinkingLevelMap) &&
        Object.entries(item.thinkingLevelMap).every(
          ([key, v]) =>
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(key) &&
            (v === null || typeof v === "string"),
        )))
  );
}

// Only model metadata crosses this boundary. Endpoint URLs and headers always come from the
// installed pi provider, and credentials from the Host, never from the remote catalog.
function parseModels(value: unknown, provider: PiAiCatalogProviderId): Model<Api>[] {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value)
      : [];
  const bundled = piBundledModels(provider);
  const apis = new Set(bundled.map((model) => model.api));
  const models = entries.flatMap((item: any): Model<Api>[] => {
    if (!validModel(item) || !apis.has(item.api)) return [];
    const installed =
      bundled.find((model) => model.id === item.id && model.api === item.api) ??
      bundled.find((model) => model.api === item.api)!;
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
    const sameModel = installed.id === item.id;
    return [
      {
        id: item.id,
        name: item.name,
        provider,
        api: item.api,
        baseUrl: installed.baseUrl,
        ...(sameModel && installed.headers ? { headers: { ...installed.headers } } : {}),
        reasoning: item.reasoning,
        input: item.input,
        contextWindow: item.contextWindow,
        maxTokens: item.maxTokens,
        cost: item.cost,
        thinkingLevelMap: item.thinkingLevelMap,
        compat: { ...(sameModel ? installed.compat : undefined), ...compat },
      } as Model<Api>,
    ];
  });
  if (models.length === 0) throw new Error("Invalid or unsupported pi model catalog");
  return models;
}

/** Host-local catalog: online pi.dev models with a persisted offline cache, and no auth. */
export class ModelCatalog {
  readonly #entries = new Map<PiAiCatalogProviderId, Entry>();
  readonly #pending = new Map<PiAiCatalogProviderId, Promise<void>>();
  readonly #directory: string;
  readonly #fetch: typeof fetch;
  constructor(directory: string, fetchImpl: typeof fetch = fetch) {
    this.#directory = directory;
    this.#fetch = fetchImpl;
  }

  #models(provider: PiAiCatalogProviderId, freeOnly: boolean) {
    return (this.#entries.get(provider)?.models ?? []).filter(
      (model) => !freeOnly || (model.cost.input === 0 && model.cost.output === 0),
    );
  }

  connection(
    provider: PiAiCatalogProviderId,
    preset: Pick<OpenAiCompatibleConnection, "id" | "label" | "baseUrl" | "defaultModelId">,
    freeOnly = false,
  ) {
    return piAiCatalogConnection(provider, preset, this.#models(provider, freeOnly));
  }

  /** A listed model, ready to stream through its pi provider. */
  model(provider: PiAiCatalogProviderId, modelId: string): Model<Api> | undefined {
    const model = this.#models(provider, false).find((item) => item.id === modelId);
    return model ? structuredClone(model) : undefined;
  }

  refresh(provider: PiAiCatalogProviderId, force = false): Promise<void> {
    if (!piProvider(provider)) return Promise.resolve();
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
        /* Missing or invalid cache: fetch online; no installed-model fallback. */
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
      // Back off failed refreshes too, retaining only cached online models.
      this.#entries.set(provider, {
        models: [],
        ...this.#entries.get(provider),
        checkedAt: Date.now(),
      });
    }
  }
}
