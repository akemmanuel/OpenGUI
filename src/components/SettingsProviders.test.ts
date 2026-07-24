import { describe, expect, test } from "vite-plus/test";
import { buildCustomModelConnection } from "./SettingsProviders";

describe("buildCustomModelConnection", () => {
  test("rejects a connection without an endpoint or model", () => {
    expect(
      buildCustomModelConnection({
        id: "connection-1",
        baseUrl: "  ",
        apiKey: "secret",
        modelId: "gpt-test",
        plane: "user",
      }),
    ).toBeNull();
    expect(
      buildCustomModelConnection({
        id: "connection-1",
        baseUrl: "https://models.example/v1",
        apiKey: "secret",
        modelId: "  ",
        plane: "user",
      }),
    ).toBeNull();
  });

  test("normalizes valid connection fields", () => {
    expect(
      buildCustomModelConnection({
        id: "connection-1",
        baseUrl: "  https://models.example/v1  ",
        apiKey: "  secret  ",
        modelId: "  gpt-test  ",
        plane: "user",
      }),
    ).toEqual({
      id: "connection-1",
      label: "gpt-test",
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      modelIds: ["gpt-test"],
      plane: "user",
      credentialKind: "byok",
    });
  });
});
