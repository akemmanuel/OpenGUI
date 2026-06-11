import { SubprocessCLITransport } from "./subprocess-cli-transport.js";
import { toUserMessage } from "./query.js";
import type { ClaudeAgentOptions, Message, SDKUserMessage, Transport } from "./types.js";

export class ClaudeSDKClient implements AsyncIterable<Message> {
  private transport?: Transport;
  public options: ClaudeAgentOptions;
  private customTransport?: Transport;

  constructor(options: ClaudeAgentOptions = {}, customTransport?: Transport) {
    this.options = options;
    this.customTransport = customTransport;
  }

  async connect(
    prompt?: string | AsyncIterable<SDKUserMessage | Record<string, unknown>>,
  ): Promise<void> {
    this.transport = this.customTransport ?? new SubprocessCLITransport(this.options);
    await this.transport.connect();
    if (typeof prompt === "string") await this.sendMessage(prompt);
    else if (prompt)
      void (async () => {
        for await (const msg of prompt) await this.transport!.write(msg);
      })();
  }

  async disconnect(): Promise<void> {
    await this.transport?.disconnect();
  }
  async sendMessage(message: string | SDKUserMessage | Record<string, unknown>): Promise<void> {
    if (!this.transport) throw new Error("client is not connected");
    await this.transport.write(typeof message === "string" ? toUserMessage(message) : message);
  }
  async interrupt(): Promise<void> {
    if (!this.transport?.interrupt) throw new Error("transport does not support interrupt");
    await this.transport.interrupt();
  }
  messages(): AsyncIterable<Message> {
    if (!this.transport) throw new Error("client is not connected");
    return this.transport.read();
  }
  [Symbol.asyncIterator](): AsyncIterator<Message> {
    return this.messages()[Symbol.asyncIterator]();
  }
}
