import { describe, expect, test } from "vite-plus/test";
import { piProviderConnectionId, RETIRED_PROVIDER_CONNECTION_IDS } from "./provider-catalogs.ts";

describe("pi provider connection ids", () => {
  test("keeps the connection ids that existing Sessions and offerings reference", () => {
    expect(piProviderConnectionId("openai-codex")).toBe("chatgpt-codex");
    expect(piProviderConnectionId("opencode")).toBe("opencode-zen");
    expect(piProviderConnectionId("opencode-go")).toBe("opencode-go");
    expect(piProviderConnectionId("anthropic")).toBe("anthropic");
  });

  test("routes both retired xAI connections to the pi xAI provider", () => {
    expect(RETIRED_PROVIDER_CONNECTION_IDS).toEqual({ supergrok: "xai", "xai-api": "xai" });
  });
});
