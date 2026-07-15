import type { Clock, IdGenerator } from "../harness.ts";
import type { ModelRequest, ModelStreamEvent, ModelTransport } from "../models/transport.ts";

export interface FakeModelTurn {
  text?: string;
  textChunks?: string[];
  reasoning?: string;
  reasoningChunks?: string[];
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
}

export class FakeModel implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  readonly #turns: FakeModelTurn[];

  constructor(turns: FakeModelTurn[]) {
    this.#turns = [...turns];
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    if (signal.aborted) throw signal.reason;
    this.requests.push(structuredClone(request));
    const turn = this.#turns.shift();
    if (!turn) throw new Error("FakeModel has no scripted turn remaining");
    const reasoningChunks =
      turn.reasoningChunks ?? (turn.reasoning === undefined ? [] : [turn.reasoning]);
    for (const delta of reasoningChunks) yield { type: "reasoning_delta", delta };
    const textChunks = turn.textChunks ?? (turn.text === undefined ? [] : [turn.text]);
    for (const delta of textChunks) yield { type: "text_delta", delta };
    for (const toolCall of turn.toolCalls ?? []) yield { type: "tool_call", ...toolCall };
    yield { type: "completed" };
  }
}

export class FakeClock implements Clock {
  #current: Date;

  constructor(current: string | Date) {
    this.#current = new Date(current);
  }

  now() {
    return new Date(this.#current);
  }

  advance(milliseconds: number) {
    this.#current = new Date(this.#current.getTime() + milliseconds);
  }
}

export class SequenceIdGenerator implements IdGenerator {
  #value: number;

  constructor(start = 1) {
    this.#value = start;
  }

  next(prefix: "session" | "entry" | "run" | "follow_up") {
    const id = `${prefix}-${this.#value}`;
    this.#value += 1;
    return id;
  }
}
