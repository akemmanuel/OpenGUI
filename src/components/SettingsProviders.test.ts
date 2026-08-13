import { describe, expect, test } from "vite-plus/test";
import {
  buildCustomModelConnection,
  createCustomBackendDraft,
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
