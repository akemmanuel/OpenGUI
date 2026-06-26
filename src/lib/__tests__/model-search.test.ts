import { describe, expect, test } from "vite-plus/test";
import {
  filterModelSearchCandidates,
  findExactModelReferenceMatch,
  fuzzyMatch,
  type ModelSearchCandidate,
} from "../model-search";

const models: ModelSearchCandidate[] = [
  {
    value: "anthropic/claude-sonnet-4",
    providerID: "anthropic",
    modelID: "claude-sonnet-4",
    providerName: "Anthropic",
    label: "Claude Sonnet 4",
  },
  {
    value: "anthropic/claude-opus-4",
    providerID: "anthropic",
    modelID: "claude-opus-4",
    providerName: "Anthropic",
    label: "Claude Opus 4",
  },
  {
    value: "openai/gpt-5.1-codex-max",
    providerID: "openai",
    modelID: "gpt-5.1-codex-max",
    providerName: "OpenAI",
    label: "GPT 5.1 Codex Max",
  },
  {
    value: "custom/claude-sonnet-4",
    providerID: "custom",
    modelID: "claude-sonnet-4",
    providerName: "Custom",
    label: "Claude Sonnet 4 Mirror",
  },
];

describe("findExactModelReferenceMatch", () => {
  test("matches canonical provider/model references", () => {
    expect(findExactModelReferenceMatch("openai/gpt-5.1-codex-max", models)?.value).toBe(
      "openai/gpt-5.1-codex-max",
    );
  });

  test("matches bare model IDs when unique", () => {
    expect(findExactModelReferenceMatch("claude-opus-4", models)?.value).toBe(
      "anthropic/claude-opus-4",
    );
  });

  test("rejects ambiguous bare model IDs", () => {
    expect(findExactModelReferenceMatch("claude-sonnet-4", models)).toBeUndefined();
  });
});

describe("filterModelSearchCandidates", () => {
  test("supports multi-token fuzzy matching", () => {
    const matches = filterModelSearchCandidates(models, "anthropic sonnet");
    expect(matches[0]?.value).toBe("anthropic/claude-sonnet-4");
  });

  test("matches compressed fuzzy queries like codexmax", () => {
    const matches = filterModelSearchCandidates(models, "codexmax");
    expect(matches[0]?.value).toBe("openai/gpt-5.1-codex-max");
  });

  test("matches canonical provider/model token sequences", () => {
    const matches = filterModelSearchCandidates(models, "openai gpt5");
    expect(matches[0]?.value).toBe("openai/gpt-5.1-codex-max");
  });
});

describe("fuzzyMatch", () => {
  test("prefers exact matches over partial ones", () => {
    const exact = fuzzyMatch("opus", "opus");
    const partial = fuzzyMatch("opus", "claude-opus-4");

    expect(exact.matches).toBe(true);
    expect(partial.matches).toBe(true);
    expect(exact.score).toBeLessThan(partial.score);
  });

  test("prefers word-boundary matches over scattered matches", () => {
    const boundary = fuzzyMatch("sonnet", "claude sonnet 4");
    const scattered = fuzzyMatch("sonnet", "clasoxnynzet");

    expect(boundary.matches).toBe(true);
    expect(scattered.matches).toBe(true);
    expect(boundary.score).toBeLessThan(scattered.score);
  });
});
