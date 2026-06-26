import { describe, expect, test } from "vite-plus/test";
import { deriveSelectionFromMessages } from "./agent-session-activation";

describe("deriveSelectionFromMessages", () => {
  test("ignores assistant model fields", () => {
    const derived = deriveSelectionFromMessages([
      {
        info: {
          id: "m1",
          role: "assistant",
          sessionID: "s1",
          providerID: "openai",
          modelID: "gpt-5",
          variant: "high",
        } as never,
        parts: [],
      },
    ]);

    expect(derived).toEqual({ selectedModel: null, selectedAgent: null, variant: undefined });
  });

  test("derives selected model from latest user message selection", () => {
    const derived = deriveSelectionFromMessages([
      {
        info: {
          id: "m1",
          role: "user",
          sessionID: "s1",
          agent: "reviewer",
          model: { providerID: "openai", modelID: "gpt-5" },
          variant: "high",
        } as never,
        parts: [],
      },
      {
        info: {
          id: "m2",
          role: "assistant",
          sessionID: "s1",
          model: { providerID: "anthropic", modelID: "sonnet" },
        } as never,
        parts: [],
      },
    ]);

    expect(derived).toEqual({
      selectedModel: { providerID: "openai", modelID: "gpt-5" },
      selectedAgent: "reviewer",
      variant: "high",
    });
  });
});
