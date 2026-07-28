import {
  createModelCachePolicy,
  PiAiTransport,
  type ModelRequest,
} from "../packages/harness/src/index.ts";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) {
  console.log("SKIPPED: ANTHROPIC_API_KEY is not set.");
  process.exit(0);
}

const model = process.env.ANTHROPIC_CACHE_SMOKE_MODEL?.trim() || "claude-sonnet-4-5";
const request: ModelRequest = {
  identity: { hostId: "live-smoke", sessionId: "live-smoke", runId: "1", principalId: "local" },
  projectDirectory: process.cwd(),
  systemPrompt: "Reply with only OK.",
  tools: [],
  context: [
    {
      type: "user_message",
      text: "Confirm prompt caching is accepted.",
      model: { connectionId: "anthropic", modelId: model },
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

const transport = new PiAiTransport({
  resolve: async () => ({
    backendId: "anthropic",
    label: "Anthropic live smoke",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    modelId: model,
    apiKey,
  }),
});
try {
  let completed = false;
  for await (const event of transport.stream(request, AbortSignal.timeout(30_000))) {
    if (event.type === "completed") completed = true;
  }
  if (!completed) throw new Error("incomplete");
  console.log("PASSED: Anthropic caching smoke completed.");
} catch {
  console.error("FAILED: Anthropic caching smoke failed (details suppressed).");
  process.exitCode = 1;
} finally {
  transport.close();
}
