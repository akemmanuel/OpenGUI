import type { MessageEntry } from "@/hooks/agent-state-types";
import type { Part } from "@/protocol/harness-types";

function assistantTextLength(entry: MessageEntry): number {
  if (entry.info.role !== "assistant") return 0;
  return entry.parts.reduce(
    (sum, part) =>
      sum + (part.type === "text" || part.type === "reasoning" ? (part.text?.length ?? 0) : 0),
    0,
  );
}

function mergeEntryPreferLongerLive(live: MessageEntry, page: MessageEntry): MessageEntry {
  if (live.info.role === "assistant" && page.info.role === "assistant") {
    if (assistantTextLength(page) > assistantTextLength(live)) return page;
  }
  const pagePartsById = new Map(page.parts.map((p) => [p.id, p]));
  const livePartIds = new Set(live.parts.map((p) => p.id));
  let changed = false;
  const mergedParts = live.parts.map((livePart) => {
    const pagePart = pagePartsById.get(livePart.id);
    if (!pagePart) return livePart;
    const merged = mergePartPreferRichPage(livePart, pagePart);
    if (merged !== livePart) changed = true;
    return merged;
  });
  const pageOnlyParts = page.parts.filter((p) => !livePartIds.has(p.id));
  if (pageOnlyParts.length === 0 && !changed) return live;
  return { ...live, parts: [...mergedParts, ...pageOnlyParts] };
}

function mergePartPreferRichPage(live: Part, page: Part): Part {
  if (live.type !== "tool" || page.type !== "tool") return live;

  const liveState = live.state ?? { status: "pending", input: {} };
  const pageState = page.state ?? { status: "pending", input: {} };
  const nextState = { ...liveState } as Record<string, unknown>;
  let changed = false;

  const copyIfPageHasValue = (key: "input" | "output" | "error" | "metadata" | "attachments") => {
    if (!(key in pageState)) return;
    const pageValue = (pageState as unknown as Record<string, unknown>)[key];
    if (pageValue === undefined) return;
    if (
      JSON.stringify((liveState as unknown as Record<string, unknown>)[key]) ===
      JSON.stringify(pageValue)
    ) {
      return;
    }
    nextState[key] = pageValue;
    changed = true;
  };

  copyIfPageHasValue("input");
  copyIfPageHasValue("output");
  copyIfPageHasValue("error");
  copyIfPageHasValue("metadata");
  copyIfPageHasValue("attachments");

  const pageStatus = pageState.status;
  const liveStatus = liveState.status;
  if (
    typeof pageStatus === "string" &&
    pageStatus !== liveStatus &&
    (pageStatus === "completed" || pageStatus === "error" || liveStatus !== "running")
  ) {
    nextState.status = pageStatus;
    changed = true;
  }

  if (!changed) return live;
  return {
    ...live,
    tool: page.tool || live.tool,
    state: nextState as unknown as typeof live.state,
  };
}

function mergePageWithoutShorteningLive(
  liveMessages: MessageEntry[],
  pageMessages: MessageEntry[],
): MessageEntry[] {
  const liveById = new Map(liveMessages.map((m) => [m.info.id, m]));
  const pageIds = new Set(pageMessages.map((m) => m.info.id));
  const merged: MessageEntry[] = [];

  for (const pageEntry of pageMessages) {
    const liveEntry = liveById.get(pageEntry.info.id);
    merged.push(liveEntry ? mergeEntryPreferLongerLive(liveEntry, pageEntry) : pageEntry);
  }

  for (const liveEntry of liveMessages) {
    if (!pageIds.has(liveEntry.info.id)) merged.push(liveEntry);
  }

  merged.sort((a, b) => {
    const ta = a.info.time?.created ?? 0;
    const tb = b.info.time?.created ?? 0;
    return ta - tb;
  });

  return merged;
}

/**
 * While a session is running, page reads may add missing older messages but must not
 * replace longer/newer live assistant text with shorter stale page text.
 */
export function mergeTranscriptPageWithLive(
  liveMessages: MessageEntry[],
  pageMessages: MessageEntry[],
  options: { running: boolean; phase: "initial" | "older" | "final" },
): MessageEntry[] {
  if (options.phase === "final") {
    return mergePageWithoutShorteningLive(liveMessages, pageMessages);
  }

  if (options.phase === "older") {
    const liveIds = new Set(liveMessages.map((m) => m.info.id));
    const olderOnly = pageMessages.filter((m) => !liveIds.has(m.info.id));
    return [...olderOnly, ...liveMessages];
  }

  if (!options.running) {
    if (liveMessages.length > 0) {
      return mergePageWithoutShorteningLive(liveMessages, pageMessages);
    }
    return pageMessages;
  }
  return mergePageWithoutShorteningLive(liveMessages, pageMessages);
}
