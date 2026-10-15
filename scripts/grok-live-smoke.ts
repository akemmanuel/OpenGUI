import type { PiCredential as Credential } from "../packages/harness/src/index.ts";
import { createPiModels, piBundledModels } from "../packages/harness/src/models/pi-ai-catalog.ts";
import { PiAiTransport } from "../packages/harness/src/models/pi-ai.ts";

const apiKey = process.env.XAI_API_KEY?.trim();
if (!apiKey) {
  console.log(
    "SKIPPED: XAI_API_KEY is not set; deterministic Grok conformance tests remain required.",
  );
  process.exit(0);
}

const modelId = process.env.XAI_GROK_MODEL?.trim() || "grok-build-0.1";
const installed = piBundledModels("xai");
const model = installed.find((item) => item.id === modelId) ?? { ...installed[0]!, id: modelId };
const stored = new Map<string, Credential>([["xai", { type: "api_key", key: apiKey }]]);
const models = createPiModels({
  credentials: {
    read: async (providerId) => stored.get(providerId),
    list: async () => [],
    modify: async (providerId, change) => (await change(stored.get(providerId))) ?? undefined,
    delete: async (providerId) => void stored.delete(providerId),
  },
});
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("Live smoke timed out")), 45_000);

try {
  const transport = new PiAiTransport({
    resolve: () => ({
      backendId: "xai",
      providerId: "xai",
      label: "xAI",
      protocol: "openai-responses",
      baseUrl: model.baseUrl,
      modelId,
      pi: { models, model },
    }),
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
          model: { connectionId: "xai", modelId },
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
  console.log(`PASSED: xAI live smoke through pi-ai completed with model ${modelId}.`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown live smoke failure";
  console.error(`FAILED: xAI live smoke through pi-ai: ${message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
