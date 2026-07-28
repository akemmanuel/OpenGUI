import {
  createModelCachePolicy,
  OpenAiResponsesWebSocketTransport,
  type ModelRequest,
} from "../packages/harness/src/index.ts";

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) {
  console.log("SKIPPED: OPENAI_API_KEY is not set.");
  process.exit(0);
}

const model = process.env.OPENAI_CACHE_SMOKE_MODEL?.trim() || "gpt-5.4-mini";
const request: ModelRequest = {
  identity: { hostId: "live-smoke", sessionId: "live-smoke", runId: "1", principalId: "local" },
  projectDirectory: process.cwd(),
  systemPrompt: "Reply with only OK.",
  tools: [],
  context: [
    {
      type: "user_message",
      text: "Confirm the transport is live.",
      model: { connectionId: "openai", modelId: model },
      reasoning: "none",
    },
  ],
  cache: createModelCachePolicy({
    systemPrompt: "Reply with only OK.",
    tools: [],
    permissionScope: "live-smoke",
    skillRevisions: [],
  }),
  delivery: { timeoutMs: 30_000, maxRetries: 0, maxRetryDelayMs: 0 },
};

const transport = new OpenAiResponsesWebSocketTransport({ mode: "websocket" });
try {
  const events = transport.stream(request, AbortSignal.timeout(30_000), {
    backendId: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelId: model,
    apiKey,
  });
  let completed = false;
  for await (const event of events) if (event.type === "completed") completed = true;
  if (!completed) throw new Error("incomplete");
  console.log("PASSED: direct OpenAI WebSocket/cache smoke completed.");
} catch {
  console.error("FAILED: direct OpenAI WebSocket/cache smoke failed (details suppressed).");
  process.exitCode = 1;
} finally {
  transport.close();
}
