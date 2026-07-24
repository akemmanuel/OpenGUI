import { describe, expect, test } from "vite-plus/test";
import type { Provider } from "@/protocol/agent-types";
import {
  isModelAvailable,
  resolveAvailableAgent,
  resolveServerDefaultModel,
} from "./agent-model-selection";

const providers = [
  {
    id: "connection-a",
    name: "Connection A",
    models: {
      "model-a": { id: "model-a" },
      "vendor/model-b": { id: "vendor/model-b" },
    },
  },
  {
    id: "connection-b",
    name: "Connection B",
    models: { "model-c": { id: "model-c" } },
  },
] as unknown as Provider[];

describe("frontend model selection", () => {
  test("uses the first configured default that is actually available", () => {
    expect(
      resolveServerDefaultModel(providers, {
        missing: "not-present",
        "connection-b": "model-c",
        "connection-a": "model-a",
      }),
    ).toEqual({ providerID: "connection-a", modelID: "model-a" });
  });

  test("accepts a fully-qualified fallback without splitting model IDs containing slashes", () => {
    expect(
      resolveServerDefaultModel(providers, {
        legacy: "connection-a/vendor/model-b",
      }),
    ).toEqual({ providerID: "connection-a", modelID: "vendor/model-b" });
    expect(resolveServerDefaultModel(providers, { legacy: "unknown/model" })).toBeNull();
    expect(
      isModelAvailable(providers, { providerID: "connection-a", modelID: "vendor/model-b" }),
    ).toBe(true);
  });

  test("falls back from a stale Session agent rather than exposing an unavailable selection", () => {
    const agents = [{ name: "build" }, { name: "review" }] as never[];
    expect(
      resolveAvailableAgent({
        agents,
        sessionAgent: "removed-agent",
        hasSessionAgent: true,
        workspaceAgent: "build",
      }),
    ).toBeNull();
    expect(
      resolveAvailableAgent({
        agents,
        hasSessionAgent: false,
        workspaceAgent: "review",
      }),
    ).toBe("review");
  });
});
