import { describe, expect, test } from "vite-plus/test";
import {
  CHATGPT_CODEX_PRESET,
  OPENCODE_GO_PRESET,
  SUPERGROK_PRESET,
  XAI_API_PRESET,
} from "./provider-catalogs.ts";

describe("first-party provider catalogs", () => {
  test("leaves the ChatGPT Codex model catalog to pi-ai", () => {
    expect(CHATGPT_CODEX_PRESET).toMatchObject({
      id: "chatgpt-codex",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      modelIds: [],
    });
  });

  test("keeps the SuperGrok OAuth alias separate from API-key model IDs", () => {
    expect(SUPERGROK_PRESET).toMatchObject({
      defaultModelId: "grok-build",
      modelIds: ["grok-build"],
    });
    expect(SUPERGROK_PRESET.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(SUPERGROK_PRESET.modelCapabilities["grok-build"].context).toBe(256_000);
    expect(XAI_API_PRESET).toMatchObject({
      baseUrl: "https://api.x.ai/v1",
      defaultModelId: "grok-build-0.1",
      modelIds: ["grok-build-0.1", "grok-code-fast-1", "grok-code-fast", "grok-code-fast-1-0825"],
    });
    expect(XAI_API_PRESET.modelIds).not.toContain("grok-build");
    expect(XAI_API_PRESET.modelCapabilities["grok-build-0.1"]?.context).toBe(256_000);
  });

  test("leaves OpenCode Go model metadata to pi-ai", () => {
    expect(OPENCODE_GO_PRESET).toMatchObject({
      id: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      modelIds: [],
    });
  });
});
