import type {
  HookCallbackMatcher,
  McpSdkServerConfigWithInstance,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export type FakeClaudeCodeTurn =
  | { text: string; calls?: Array<{ id: string; name: string; input: unknown }> }
  | { error: string };

/** What the fake Claude Code saw: the user content of each turn and every tool result. */
export interface FakeClaudeCodeProcess {
  options: Options;
  prompts: unknown[][];
  toolResults: Array<{ name: string; content: unknown }>;
  closed: boolean;
}

/**
 * A stand-in for Claude Code's agent loop: it reads streamed user messages, asks `model`
 * for each assistant turn, streams it the way Claude Code does, and runs tool calls through
 * the in-process MCP server and PreToolUse hook exactly as Claude Code would.
 */
export function fakeClaudeCode(
  model: (process: FakeClaudeCodeProcess, history: unknown[]) => FakeClaudeCodeTurn,
) {
  const processes: FakeClaudeCodeProcess[] = [];
  let messageCounter = 0;
  const query = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }) => {
    const process: FakeClaudeCodeProcess = { options, prompts: [], toolResults: [], closed: false };
    processes.push(process);
    const history: unknown[] = [];
    const server = (options.mcpServers!.og as McpSdkServerConfigWithInstance).instance;
    const hook = (options.hooks!.PreToolUse as HookCallbackMatcher[])[0]!.hooks[0]!;
    const output: SDKMessage[] = [];
    let wake: (() => void) | undefined;
    const emit = (message: unknown) => {
      output.push(message as SDKMessage);
      wake?.();
    };
    const stream = (event: unknown) =>
      emit({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" });

    const run = async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "fake-claude-code", version: "1" });
      await client.connect(clientTransport);
      const pending: unknown[][] = [];
      const iterator = prompt[Symbol.asyncIterator]();
      let reading: Promise<IteratorResult<SDKUserMessage>> | undefined;
      const nextPrompt = async () => {
        reading ??= iterator.next();
        const next = await reading;
        reading = undefined;
        return next;
      };
      while (!process.closed) {
        const queued = pending.shift();
        let content = queued;
        if (!content) {
          const next = await nextPrompt();
          if (next.done) return;
          content = next.value.message.content as unknown[];
        }
        process.prompts.push(content);
        history.push({ role: "user", content });
        // One Claude Code turn: assistant messages until one without tool calls.
        while (!process.closed) {
          const turn = model(process, history);
          if ("error" in turn) {
            emit({ type: "result", subtype: "success", is_error: true, result: turn.error });
            break;
          }
          const id = `msg_${++messageCounter}`;
          stream({
            type: "message_start",
            message: { id, usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
          });
          let index = 0;
          if (turn.text) {
            stream({
              type: "content_block_start",
              index,
              content_block: { type: "text", text: "" },
            });
            for (const piece of turn.text.match(/.{1,4}/gu) ?? []) {
              stream({
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: piece },
              });
            }
            stream({ type: "content_block_stop", index });
            index += 1;
          }
          for (const call of turn.calls ?? []) {
            stream({
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: call.id,
                name: `mcp__og__${call.name}`,
                input: {},
              },
            });
            stream({
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
            });
            stream({ type: "content_block_stop", index });
            index += 1;
          }
          const stop = turn.calls?.length ? "tool_use" : "end_turn";
          stream({
            type: "message_delta",
            delta: { stop_reason: stop },
            usage: { output_tokens: 7 },
          });
          stream({ type: "message_stop" });
          // Claude Code also yields the whole message; the runtime must not count it twice.
          emit({
            type: "assistant",
            message: { id, content: [{ type: "text", text: turn.text }], stop_reason: stop },
            parent_tool_use_id: null,
          });
          history.push({ role: "assistant", ...turn });
          if (!turn.calls?.length) {
            emit({ type: "result", subtype: "success", is_error: false, result: turn.text });
            break;
          }
          for (const call of turn.calls) {
            await hook(
              {
                hook_event_name: "PreToolUse",
                tool_name: `mcp__og__${call.name}`,
                tool_input: call.input,
                tool_use_id: call.id,
              } as never,
              call.id,
              { signal: new AbortController().signal },
            );
            const result = await client.callTool({
              name: call.name,
              arguments: call.input as Record<string, unknown>,
            });
            process.toolResults.push({ name: call.name, content: result.content });
            history.push({ role: "tool", id: call.id, content: result.content });
          }
          // Messages that arrived during the tool batch follow its results.
          while (true) {
            const ready = await Promise.race([
              nextPrompt(),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 5)),
            ]);
            if (!ready || ready.done) break;
            pending.push(ready.value.message.content as unknown[]);
          }
          if (pending.length > 0) break;
        }
      }
    };
    void run();
    async function* messages() {
      while (!process.closed) {
        const message = output.shift();
        if (message) {
          yield message;
          continue;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    }
    const generator = messages() as unknown as Query;
    generator.close = () => {
      process.closed = true;
      wake?.();
    };
    return generator;
  };
  return { query, processes };
}
