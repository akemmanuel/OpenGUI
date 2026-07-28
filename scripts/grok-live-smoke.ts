import { CodexResponsesTransport } from "../packages/harness/src/models/codex-responses.ts";

const apiKey = process.env.XAI_API_KEY?.trim();
if (!apiKey) {
  console.log(
    "SKIPPED: XAI_API_KEY is not set; deterministic Grok conformance tests remain required.",
  );
  process.exit(0);
}

const model = process.env.XAI_GROK_MODEL?.trim() || "grok-build-0.1";
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("Live smoke timed out")), 45_000);

try {
  const transport = new CodexResponsesTransport({
    endpoint: "https://api.x.ai/v1/responses",
    requestLabel: "xAI API live smoke",
    getCredential: async () => ({ accessToken: apiKey, accountId: "" }),
  });
  let text = "";
  let completed = false;
  for await (const event of transport.stream(
    {
      projectDirectory: process.cwd(),
      systemPrompt: "This is a connectivity smoke test. Do not call tools.",
      tools: [],
      context: [
        {
          type: "user_message",
          text: "Reply with exactly: OpenGUI Grok smoke OK",
          model: { connectionId: "xai-api", modelId: model },
          reasoning: "none",
        },
      ],
    },
    controller.signal,
  )) {
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "completed") completed = true;
  }
  if (!completed || !text.trim()) throw new Error("Live response was empty or incomplete");
  console.log(`PASSED: xAI Responses live smoke completed with model ${model}.`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown live smoke failure";
  console.error(`FAILED: xAI Responses live smoke: ${message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
