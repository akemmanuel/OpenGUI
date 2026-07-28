import type { DurableActor } from "../harness.ts";
import type { ModelToolDefinition } from "../models/transport.ts";

export interface AgentToolScope {
  sessionId: string;
  runId: string;
  projectDirectory: string;
  actor?: DurableActor;
}

export interface AgentToolSet {
  generation: string;
  definitions: readonly ModelToolDefinition[];
  invoke(call: { name: string; input: unknown }, signal: AbortSignal): Promise<unknown>;
}

export interface AgentToolSource {
  resolve(scope: AgentToolScope, signal: AbortSignal): Promise<AgentToolSet>;
}
