import { useMemo } from "react";
import { resolveServerDefaultModel, useModelState } from "@/hooks/use-agent-state";
import type { MessageEntry } from "@/hooks/agent-state-types";
import { computeTokenTotal } from "@/lib/utils";

export type ContextInfo = {
  percent: number | null;
  tokens: number | null;
  cost: number | null;
  contextLimit: number | null;
  isEstimated: boolean;
};

type TokenUsage = {
  total: number;
  cost: number | null;
  messageIndex: number;
};

/**
 * A lightweight fallback until the provider reports token usage. It is deliberately
 * conservative: it gives the context meter useful live movement without claiming
 * tokenizer-level precision for arbitrary models.
 */
function estimateTokens(messages: readonly MessageEntry[]) {
  const text = messages
    .flatMap((message) =>
      message.parts.map((part) => {
        if (part.type === "text" || part.type === "reasoning") return part.text;
        if (part.type === "tool")
          return JSON.stringify(part.state.input ?? part.state.output ?? "");
        return "";
      }),
    )
    .join("");
  return text ? Math.ceil(text.length / 4) : 0;
}

export function getContextUsage(messages: readonly MessageEntry[]) {
  let last: TokenUsage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]?.info;
    if (msg?.role !== "assistant") continue;
    const t = "tokens" in msg ? msg.tokens : undefined;
    let total = t ? computeTokenTotal(t) : 0;
    const msgCost = "cost" in msg && typeof msg.cost === "number" ? msg.cost : null;

    if (total <= 0) {
      for (const part of messages[i]?.parts ?? []) {
        if (part.type === "step-finish" && "tokens" in part) {
          total += computeTokenTotal(part.tokens);
        }
      }
    }

    if (total > 0) {
      last = { total, cost: msgCost, messageIndex: i };
      break;
    }
  }

  if (!last) return { tokens: estimateTokens(messages), cost: null, isEstimated: true };

  const messagesSinceUsage = messages.slice(last.messageIndex + 1);
  const additionalTokens = estimateTokens(messagesSinceUsage);
  if (additionalTokens > 0) {
    return {
      tokens: last.total + additionalTokens,
      cost: last.cost,
      isEstimated: true,
    };
  }
  return { tokens: last.total, cost: last.cost, isEstimated: false };
}

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
    const none: ContextInfo = {
      percent: null,
      tokens: null,
      cost: null,
      contextLimit: null,
      isEstimated: false,
    };
    let latestAssistant: MessageEntry["info"] | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.info.role === "assistant") {
        latestAssistant = message.info;
        break;
      }
    }

    let provID = latestAssistant?.providerID ?? selectedModel?.providerID;
    let modID = latestAssistant?.modelID ?? selectedModel?.modelID;
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
    const usage = activeSessionId
      ? getContextUsage(messages)
      : { tokens: 0, cost: null, isEstimated: false };

    return {
      percent: Math.min(100, Math.max(0, Math.round((usage.tokens / contextLimit) * 100))),
      tokens: usage.tokens,
      cost: usage.cost,
      contextLimit,
      isEstimated: usage.isEstimated,
    };
  }, [activeSessionId, messages, providers, selectedModel, providerDefaults]);
}
