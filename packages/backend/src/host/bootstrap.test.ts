import { describe, expect, test } from "vite-plus/test";
import { modelTransportEnvironment } from "./bootstrap.ts";

describe("model transport environment", () => {
  test("documents the default pi-ai/native fallback routing", () => {
    expect(modelTransportEnvironment({})).toEqual({
      usePiAiTransport: true,
      usePiAiCodexTransport: true,
      codexPiTransport: "auto",
      openAiResponsesTransport: "auto",
      ownerModelDiagnostics: false,
    });
    expect(
      modelTransportEnvironment({
        OPENGUI_MODEL_TRANSPORT: "native",
        OPENGUI_CODEX_TRANSPORT: "native",
        OPENGUI_OPENAI_RESPONSES_TRANSPORT: "sse",
      }),
    ).toMatchObject({
      usePiAiTransport: false,
      usePiAiCodexTransport: false,
      openAiResponsesTransport: "sse",
    });
  });

  test("fails unknown values toward native/SSE and never enables diagnostics", () => {
    expect(
      modelTransportEnvironment({
        OPENGUI_MODEL_TRANSPORT: "surprise",
        OPENGUI_CODEX_TRANSPORT: "surprise",
        OPENGUI_OPENAI_RESPONSES_TRANSPORT: "surprise",
        OPENGUI_OWNER_MODEL_DIAGNOSTICS: "true",
      }),
    ).toEqual({
      usePiAiTransport: false,
      usePiAiCodexTransport: false,
      codexPiTransport: "auto",
      openAiResponsesTransport: "sse",
      ownerModelDiagnostics: false,
    });
  });
});
