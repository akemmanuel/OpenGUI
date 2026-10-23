import { describe, expect, test } from "vite-plus/test";
import {
  buildCustomModelConnection,
  createCustomBackendDraft,
  toggleReasoningEffort,
  validateCustomBackend,
} from "@/features/model-access/custom-backend";

describe("buildCustomModelConnection", () => {
  test("rejects a connection without an endpoint or model", () => {
    expect(
      buildCustomModelConnection({
        ...createCustomBackendDraft("user"),
        label: "Test",
        baseUrl: "  ",
      }),
    ).toBeNull();
    expect(
      buildCustomModelConnection({
        ...createCustomBackendDraft("user"),
        label: "Test",
        models: [{ ...createCustomBackendDraft("user").models[0]!, id: "  " }],
      }),
    ).toBeNull();
  });

  test("normalizes valid connection fields", () => {
    expect(
      buildCustomModelConnection({
        ...createCustomBackendDraft("user"),
        id: "connection-1",
        label: " Test backend ",
        baseUrl: "  https://models.example/v1/  ",
        apiKey: "  secret  ",
        models: [
          {
            ...createCustomBackendDraft("user").models[0]!,
            id: "  gpt-test  ",
            reasoning: true,
            route: "responses",
          },
        ],
      }),
    ).toMatchObject({
      id: "connection-1",
      label: "Test backend",
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      modelIds: ["gpt-test"],
      plane: "user",
      credentialKind: "byok",
      modelRoutes: { "gpt-test": "responses" },
      modelCapabilities: { "gpt-test": { reasoning: true } },
    });

    const connection = buildCustomModelConnection({
      ...createCustomBackendDraft("user"),
      label: "Test backend",
      models: [
        {
          ...createCustomBackendDraft("user").models[0]!,
          id: "gpt-test",
          reasoning: true,
          reasoningEfforts: [],
        },
      ],
    });
    expect(connection?.modelCapabilities?.["gpt-test"]).not.toHaveProperty("reasoningEfforts");
  });

  test("keeps selected reasoning levels in canonical order", () => {
    let efforts = toggleReasoningEffort([], "max", true);
    efforts = toggleReasoningEffort(efforts, "low", true);
    efforts = toggleReasoningEffort(efforts, "high", true);
    expect(efforts).toEqual(["low", "high", "max"]);
    expect(toggleReasoningEffort(efforts, "high", false)).toEqual(["low", "max"]);

    const connection = buildCustomModelConnection({
      ...createCustomBackendDraft("user"),
      label: "Test backend",
      models: [
        {
          ...createCustomBackendDraft("user").models[0]!,
          id: "claude-test",
          route: "anthropic-messages",
          reasoning: true,
          reasoningEfforts: efforts,
        },
      ],
    });
    expect(connection?.modelCapabilities?.["claude-test"]).toMatchObject({
      reasoning: true,
      reasoningEfforts: ["low", "high", "max"],
    });
  });

  test("reports duplicate upstream IDs before save", () => {
    const draft = createCustomBackendDraft("host");
    draft.label = "Company gateway";
    draft.models = [
      { ...draft.models[0]!, key: "one", id: "gpt-4.1" },
      { ...draft.models[0]!, key: "two", id: "gpt-4.1" },
    ];
    expect(validateCustomBackend(draft).models).toBe("duplicate");
    expect(buildCustomModelConnection(draft)).toBeNull();
  });
});
