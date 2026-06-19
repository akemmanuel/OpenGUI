import type { MessageEntry } from "@/hooks/agent-state-types";
import { limitMessageWindow } from "@/features/session-transcript/message-utils";

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
  const livePartIds = new Set(live.parts.map((p) => p.id));
  const pageOnlyParts = page.parts.filter((p) => !livePartIds.has(p.id));
  if (pageOnlyParts.length === 0) return live;
  return { ...live, parts: [...live.parts, ...pageOnlyParts] };
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

  return limitMessageWindow(merged);
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
    return limitMessageWindow([...olderOnly, ...liveMessages]);
  }

  if (!options.running) {
    return limitMessageWindow(pageMessages);
  }
  return mergePageWithoutShorteningLive(liveMessages, pageMessages);
}
