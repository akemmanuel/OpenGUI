import { useMemo } from "react";
import { resolveServerDefaultModel, useModelState } from "@/hooks/use-agent-state";
import type { MessageEntry } from "@/hooks/agent-state-types";
import { computeTokenTotal } from "@/lib/utils";

export type ContextInfo = {
  percent: number | null;
  tokens: number | null;
  cost: number | null;
  contextLimit: number | null;
};

export function useContextInfo({
  activeSessionId,
  messages,
  providers,
  selectedModel,
  providerDefaults,
}: {
  activeSessionId: string | null;
  messages: MessageEntry[];
  providers: ReturnType<typeof useModelState>["providers"];
  selectedModel: ReturnType<typeof useModelState>["selectedModel"];
  providerDefaults: ReturnType<typeof useModelState>["providerDefaults"];
}): ContextInfo {
  return useMemo(() => {
    const none: ContextInfo = { percent: null, tokens: null, cost: null, contextLimit: null };
    if (!activeSessionId) return none;

    let last: { providerID: string; modelID: string; total: number; cost: number | null } | null =
      null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]?.info;
      if (msg?.role !== "assistant" || !("providerID" in msg) || !("modelID" in msg)) continue;
      const t = "tokens" in msg ? msg.tokens : undefined;
      let total = t ? computeTokenTotal(t) : 0;
      const msgCost = "cost" in msg && typeof msg.cost === "number" ? msg.cost : null;

      if (total <= 0) {
        for (const part of messages[i]?.parts ?? []) {
          if (part.type === "step-finish" && "tokens" in part)
            total += computeTokenTotal(part.tokens);
        }
      }

      if (total > 0) {
        last = { providerID: msg.providerID, modelID: msg.modelID, total, cost: msgCost };
        break;
      }
    }

    let provID = last?.providerID ?? selectedModel?.providerID;
    let modID = last?.modelID ?? selectedModel?.modelID;
    if (!provID || !modID) {
      const fallback = resolveServerDefaultModel(providers, providerDefaults);
      if (fallback) {
        provID = fallback.providerID;
        modID = fallback.modelID;
      }
    }
    if (!provID || !modID) return none;

    const contextLimit = providers.find((p) => p.id === provID)?.models[modID]?.limit?.context;
    if (!contextLimit) return none;
    if (!last) return { percent: 0, tokens: null, cost: null, contextLimit };

    return {
      percent: Math.min(100, Math.max(0, Math.round((last.total / contextLimit) * 100))),
      tokens: last.total,
      cost: last.cost,
      contextLimit,
    };
  }, [activeSessionId, messages, providers, selectedModel, providerDefaults]);
}
