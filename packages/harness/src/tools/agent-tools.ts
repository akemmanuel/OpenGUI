import type { DurableActor, ModelSelection } from "../harness.ts";
import { contentFingerprint, type ModelToolDefinition } from "../models/transport.ts";

export interface AgentToolScope {
  sessionId: string;
  runId: string;
  projectDirectory: string;
  actor?: DurableActor;
  /** Session model selected for this run; provider-bound tools use it to pick credentials. */
  model?: ModelSelection | null;
}

export interface AgentToolSet {
  generation: string;
  definitions: readonly ModelToolDefinition[];
  invoke(
    call: { name: string; input: unknown; toolCallId?: string },
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface AgentToolSource {
  resolve(scope: AgentToolScope, signal: AbortSignal): Promise<AgentToolSet>;
}

/** Merge independent tool sources into one set; names must stay unique across sources. */
export function combineAgentToolSources(sources: readonly AgentToolSource[]): AgentToolSource {
  return {
    async resolve(scope, signal) {
      const sets = await Promise.all(sources.map((source) => source.resolve(scope, signal)));
      const owners = new Map<string, AgentToolSet>();
      for (const set of sets) {
        for (const definition of set.definitions) {
          if (owners.has(definition.name))
            throw new Error(`Additional tool name is not unique: ${definition.name}`);
          owners.set(definition.name, set);
        }
      }
      return {
        generation: contentFingerprint(sets.map((set) => set.generation)).slice(0, 24),
        definitions: sets.flatMap((set) => set.definitions),
        async invoke(call, invokeSignal) {
          const owner = owners.get(call.name);
          if (!owner) throw new Error(`Unknown additional tool: ${call.name}`);
          return await owner.invoke(call, invokeSignal);
        },
      };
    },
  };
}
