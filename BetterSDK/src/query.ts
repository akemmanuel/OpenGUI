import { SubprocessCLITransport } from "./subprocess-cli-transport.js";
import { SDKQuery } from "./sdk-query.js";
import type { ClaudeAgentOptions, Message, SDKUserMessage, Transport } from "./types.js";

export function query(input: {
  prompt: string | AsyncIterable<SDKUserMessage | Record<string, unknown>>;
  options?: ClaudeAgentOptions;
  transport?: Transport;
}): SDKQuery {
  const transport = input.transport ?? new SubprocessCLITransport(input.options ?? {});
  const handle = new SDKQuery(transport, input.options ?? {});
  void (async () => {
    await transport.connect();
    await handle.initialize().catch(() => null);
    if (typeof input.prompt === "string") await transport.write(toUserMessage(input.prompt));
    else for await (const msg of input.prompt) await transport.write(msg);
    if (!input.options?.canUseTool && !input.options?.hooks) await (transport.endInput?.() ?? transport.disconnect());
  })().catch((error) => handle.fail(error));
  return handle;
}

export function toUserMessage(content: string): SDKUserMessage {
  return { type: "user", session_id: "", message: { role: "user", content }, parent_tool_use_id: null };
}

