import { describe, expect, test } from "vite-plus/test";
import {
  CHATGPT_CODEX_PRESET,
  OPENCODE_GO_PRESET,
  SUPERGROK_PRESET,
  supportedOpenCodeGoModelIds,
} from "./provider-catalogs.ts";

describe("first-party provider catalogs", () => {
  test("uses the documented ChatGPT Codex subscription catalog and default", () => {
    expect(CHATGPT_CODEX_PRESET.defaultModelId).toBe("gpt-5.6-sol");
    expect(CHATGPT_CODEX_PRESET.modelIds).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(CHATGPT_CODEX_PRESET.modelIds).not.toContain("gpt-5.2-codex");
  });

  test("keeps the SuperGrok OAuth alias separate from API-key model IDs", () => {
    expect(SUPERGROK_PRESET).toMatchObject({
      defaultModelId: "grok-build",
      modelIds: ["grok-build"],
    });
  });

  test("only offers discovered OpenCode Go models with documented transports", () => {
    expect(
      supportedOpenCodeGoModelIds([...OPENCODE_GO_PRESET.modelIds, "glm-5", "hy3-preview"]),
    ).toEqual(OPENCODE_GO_PRESET.modelIds);
    expect(OPENCODE_GO_PRESET.modelRoutes["qwen3.7-max"]).toBe("anthropic-messages");
    expect(OPENCODE_GO_PRESET.modelRoutes["glm-5.2"]).toBe("openai-chat");
  });
});
