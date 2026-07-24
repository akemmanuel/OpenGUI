import type { MessageEntry } from "@/hooks/agent-state-types";
import type { ActorSnapshot } from "@/protocol/host-types";

export function createOptimisticUserMessage(input: {
  id: string;
  sessionId: string;
  text: string;
  actor?: ActorSnapshot;
  providerId?: string;
  modelId?: string;
  createdAt: number;
}): MessageEntry {
  return {
    info: {
      id: input.id,
      sessionID: input.sessionId,
      role: "user",
      actor: input.actor,
      providerID: input.providerId ?? "",
      modelID: input.modelId ?? "",
      time: { created: input.createdAt },
    },
    parts: [
      {
        id: `${input.id}:text`,
        type: "text",
        text: input.text,
        sessionID: input.sessionId,
        messageID: input.id,
        tokens: {},
      },
    ],
  };
}
