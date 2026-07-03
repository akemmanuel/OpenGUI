import type { Message, Part } from "../../../src/protocol/harness-types.ts";
import type { LiveSessionEvent } from "./live-session-events/live-session-event.ts";
import {
  type MessagePageResult,
  type SessionTranscriptScope,
  type TranscriptMessageEntry,
  createSessionTranscriptProjection,
} from "./session-transcript-projection.ts";

export interface LiveSessionTranscriptProjection {
  readonly scope: SessionTranscriptScope;
  hydrateFromHarnessPage(page: MessagePageResult, options?: { before?: string | null }): void;
  ingestLiveSessionEvents(events: LiveSessionEvent[]): void;
  getMessages(): TranscriptMessageEntry[];
  getRevision(): number;
}

const TOOL_TERMINAL = new Set(["completed", "error"]);

function isToolTerminal(status: string | undefined): boolean {
  return status !== undefined && TOOL_TERMINAL.has(status);
}

function toolStatusRank(status: string | undefined): number {
  if (status === "completed" || status === "error") return 3;
  if (status === "running") return 2;
  if (status === "pending") return 1;
  return 0;
}

function mergeToolPart(incoming: Part, existing?: Part): Part {
  if (!existing || existing.type !== "tool" || incoming.type !== "tool") {
    return incoming;
  }
  const prevStatus = existing.state?.status;
  const nextStatus = incoming.state?.status;
  if (isToolTerminal(prevStatus) && !isToolTerminal(nextStatus)) {
    return existing;
  }
  if (
    isToolTerminal(nextStatus) &&
    isToolTerminal(prevStatus) &&
    toolStatusRank(prevStatus) >= toolStatusRank(nextStatus)
  ) {
    return { ...existing, ...incoming, state: { ...existing.state, ...incoming.state } };
  }
  if (toolStatusRank(nextStatus) >= toolStatusRank(prevStatus)) {
    return { ...existing, ...incoming, state: { ...existing.state, ...incoming.state } };
  }
  return existing;
}

function mergeTextLikePart(incoming: Part, existing?: Part): Part {
  if (!existing) return incoming;
  const prev = existing as Record<string, unknown>;
  const next = incoming as Record<string, unknown>;
  const out = { ...next };
  const prevText = typeof prev.text === "string" ? prev.text : "";
  const nextText = typeof out.text === "string" ? out.text : "";
  if (prevText.length > nextText.length && prevText.startsWith(nextText)) {
    out.text = prevText;
  }
  return { ...existing, ...incoming, ...out } as Part;
}

function mergePart(incoming: Part, existing?: Part): Part {
  if (!existing) return incoming;
  if (incoming.type === "tool") return mergeToolPart(incoming, existing);
  if (incoming.type === "text" || incoming.type === "reasoning") {
    return mergeTextLikePart(incoming, existing);
  }
  return { ...existing, ...incoming };
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function applyCanonicalOrderBlock(
  current: readonly string[],
  incomingIds: readonly string[],
  options?: { beforeId?: string | null; noOverlap?: "prepend" | "append" },
): string[] {
  const incoming = uniqueIds(incomingIds);
  if (incoming.length === 0) return [...current];

  const incomingSet = new Set(incoming);
  const withoutIncoming = current.filter((id) => !incomingSet.has(id));
  let insertAt: number | null = null;

  if (options?.beforeId) {
    const anchorIdx = withoutIncoming.indexOf(options.beforeId);
    insertAt = anchorIdx >= 0 ? anchorIdx : 0;
  }

  if (insertAt === null) {
    const overlapIndexes = incoming.map((id) => current.indexOf(id)).filter((idx) => idx >= 0);
    if (overlapIndexes.length > 0) {
      const firstOverlap = Math.min(...overlapIndexes);
      insertAt = current.slice(0, firstOverlap).filter((id) => !incomingSet.has(id)).length;
    }
  }

  if (insertAt === null) {
    insertAt = options?.noOverlap === "append" ? withoutIncoming.length : 0;
  }

  return [...withoutIncoming.slice(0, insertAt), ...incoming, ...withoutIncoming.slice(insertAt)];
}

function finalizeToolsForCompletedMessage(entry: TranscriptMessageEntry): TranscriptMessageEntry {
  const time = entry.info.time as { completed?: number } | undefined;
  if (!time?.completed) return entry;
  let changed = false;
  const parts = entry.parts.map((part) => {
    if (part.type !== "tool") return part;
    const status = part.state?.status;
    if (status !== "running" && status !== "pending") return part;
    changed = true;
    return {
      ...part,
      state: { ...part.state, status: "completed" as const },
    } as Part;
  });
  return changed ? { ...entry, parts } : entry;
}

function finalizeRunningToolsInMessages(
  messages: TranscriptMessageEntry[],
  sessionId: string,
): TranscriptMessageEntry[] {
  let changed = false;
  const next = messages.map((entry) => {
    if (entry.info.sessionID !== sessionId) return entry;
    let entryChanged = false;
    const parts = entry.parts.map((part) => {
      if (part.type !== "tool") return part;
      const status = part.state?.status;
      if (status !== "running" && status !== "pending") return part;
      entryChanged = true;
      changed = true;
      return { ...part, state: { ...part.state, status: "completed" as const } } as Part;
    });
    return entryChanged ? { ...entry, parts } : entry;
  });
  return changed ? next : messages;
}

function textPart(
  scope: SessionTranscriptScope,
  messageId: string,
  partId: string,
  text: string,
  kind: string,
): Part {
  if (kind === "thinking") {
    return {
      id: partId,
      sessionID: scope.sessionId,
      messageID: messageId,
      type: "reasoning",
      text,
      time: { start: 0 },
      tokens: {},
    } as Part;
  }
  return {
    id: partId,
    sessionID: scope.sessionId,
    messageID: messageId,
    type: "text",
    text,
    tokens: {},
  } as Part;
}

function toolPartFromLive(
  scope: SessionTranscriptScope,
  messageId: string,
  partId: string,
  tool: string,
  status: string,
  input?: unknown,
  output?: string,
): Part {
  return {
    id: partId,
    sessionID: scope.sessionId,
    messageID: messageId,
    type: "tool",
    tool,
    tokens: {},
    state: {
      status,
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
    },
  } as Part;
}

export function createLiveSessionTranscriptProjection(
  scope: SessionTranscriptScope,
): LiveSessionTranscriptProjection {
  const harnessProjection = createSessionTranscriptProjection(scope);
  const messagesById = new Map<string, TranscriptMessageEntry>();
  let messageOrder: string[] = [];
  const partOrderByMessage = new Map<string, string[]>();
  let revision = 0;
  const livePartMeta = new Map<string, { tool?: string; kind?: string }>();

  const bump = () => {
    revision += 1;
  };

  const partOrder = (messageID: string): string[] => {
    let order = partOrderByMessage.get(messageID);
    if (!order) {
      order = [];
      partOrderByMessage.set(messageID, order);
    }
    return order;
  };

  const ensureMessageOrder = (messageID: string) => {
    if (!messageOrder.includes(messageID)) messageOrder.push(messageID);
  };

  const ensurePartOrder = (messageID: string, partID: string) => {
    const order = partOrder(messageID);
    if (!order.includes(partID)) order.push(partID);
  };

  const orderedParts = (messageID: string, parts: readonly Part[]): Part[] => {
    const partsById = new Map(parts.map((part) => [part.id, part]));
    const order = partOrder(messageID);
    for (const part of parts) ensurePartOrder(messageID, part.id);
    return order.filter((id) => partsById.has(id)).map((id) => partsById.get(id)!);
  };

  const moveMessageAfter = (parentID: string, childID: string): boolean => {
    const parentIdx = messageOrder.indexOf(parentID);
    const childIdx = messageOrder.indexOf(childID);
    if (parentIdx < 0 || childIdx < 0 || childIdx > parentIdx) return false;
    messageOrder.splice(childIdx, 1);
    const nextParentIdx = messageOrder.indexOf(parentID);
    messageOrder.splice(nextParentIdx + 1, 0, childID);
    return true;
  };

  const applyMessageRelationships = (message: Message) => {
    const parentID =
      "parentID" in message && typeof message.parentID === "string" ? message.parentID : "";
    if (parentID) moveMessageAfter(parentID, message.id);

    for (const entry of messagesById.values()) {
      const childParent =
        "parentID" in entry.info && typeof entry.info.parentID === "string"
          ? entry.info.parentID
          : "";
      if (childParent === message.id) moveMessageAfter(message.id, entry.info.id);
    }
  };

  const setEntry = (entry: TranscriptMessageEntry, bumpRevision = true) => {
    ensureMessageOrder(entry.info.id);
    for (const part of entry.parts) ensurePartOrder(entry.info.id, part.id);
    const finalized = finalizeToolsForCompletedMessage({
      ...entry,
      parts: orderedParts(entry.info.id, entry.parts),
    });
    messagesById.set(finalized.info.id, finalized);
    applyMessageRelationships(finalized.info);
    if (bumpRevision) bump();
  };

  const getEntry = (messageId: string): TranscriptMessageEntry => {
    const existing = messagesById.get(messageId);
    if (existing) return existing;
    ensureMessageOrder(messageId);
    const entry: TranscriptMessageEntry = {
      info: {
        id: messageId,
        sessionID: scope.sessionId,
        role: "assistant",
        time: { created: Date.now() },
        providerID: "",
        modelID: "",
      } as Message,
      parts: [],
    };
    messagesById.set(messageId, entry);
    return entry;
  };

  const upsertPart = (messageId: string, part: Part): void => {
    const entry = getEntry(messageId);
    const idx = entry.parts.findIndex((p) => p.id === part.id);
    const previous = idx >= 0 ? entry.parts[idx] : undefined;
    const merged = mergePart(part, previous);
    const parts = [...entry.parts];
    if (idx >= 0) parts[idx] = merged;
    else parts.push(merged);
    setEntry({ ...entry, parts });
  };

  const removePart = (messageId: string, partId: string): void => {
    const entry = messagesById.get(messageId);
    if (!entry || !entry.parts.some((p) => p.id === partId)) return;
    const parts = entry.parts.filter((p) => p.id !== partId);
    partOrderByMessage.set(
      messageId,
      partOrder(messageId).filter((id) => id !== partId),
    );
    livePartMeta.delete(`${messageId}\u0000${partId}`);
    setEntry({ ...entry, parts });
  };

  const removeMessage = (messageId: string): void => {
    if (!messagesById.delete(messageId)) return;
    messageOrder = messageOrder.filter((id) => id !== messageId);
    partOrderByMessage.delete(messageId);
    for (const key of livePartMeta.keys()) {
      if (key.startsWith(`${messageId}\u0000`)) livePartMeta.delete(key);
    }
    bump();
  };

  const replaceMessageId = (oldId: string, newId: string): void => {
    if (oldId === newId) return;
    const existing = messagesById.get(oldId);
    if (!existing) return;
    const oldIndex = messageOrder.indexOf(oldId);
    removeMessage(oldId);
    const entry: TranscriptMessageEntry = {
      info: { ...existing.info, id: newId },
      parts: existing.parts.map((part) => ({ ...part, messageID: newId })),
    };
    partOrderByMessage.set(newId, uniqueIds(entry.parts.map((p) => p.id)));
    if (oldIndex >= 0) {
      messageOrder.splice(oldIndex, 0, newId);
    } else {
      ensureMessageOrder(newId);
    }
    setEntry(entry);
  };

  const mergeHarnessEntryIntoLive = (incoming: TranscriptMessageEntry) => {
    const existing = messagesById.get(incoming.info.id);
    if (!existing) {
      setEntry(
        {
          info: incoming.info,
          parts: incoming.parts.map((p) => ({ ...p })),
        },
        false,
      );
      return;
    }
    const partsById = new Map(existing.parts.map((p) => [p.id, p]));
    for (const part of incoming.parts) {
      partsById.set(part.id, mergePart(part, partsById.get(part.id)));
    }
    const incomingIds = new Set(incoming.parts.map((p) => p.id));
    for (const part of existing.parts) {
      if (!incomingIds.has(part.id)) partsById.set(part.id, part);
    }
    setEntry(
      {
        info: { ...existing.info, ...incoming.info },
        parts: [...partsById.values()],
      },
      false,
    );
  };

  const syncFromHarnessProjection = () => {
    const messages = harnessProjection.getMessages();
    const incomingIds = messages.map((entry) => entry.info.id);
    messageOrder = applyCanonicalOrderBlock(messageOrder, incomingIds, { noOverlap: "prepend" });
    for (const entry of messages) {
      partOrderByMessage.set(entry.info.id, uniqueIds(entry.parts.map((p) => p.id)));
      mergeHarnessEntryIntoLive(entry);
    }
    revision = Math.max(revision, harnessProjection.getRevision());
  };

  const ingestOne = (event: LiveSessionEvent): void => {
    if (event.scope.sessionId !== scope.sessionId) return;
    if (event.scope.directory !== scope.directory) return;
    if (event.scope.harnessId !== scope.harnessId) return;

    const messageId = event.messageId;
    const partId = event.partId;

    switch (event.type) {
      case "message.started": {
        if (!messageId) return;
        const entry = getEntry(messageId);
        const role = event.role ?? entry.info.role ?? "assistant";
        setEntry({
          ...entry,
          info: { ...entry.info, role } as Message,
        });
        return;
      }
      case "message.finished": {
        if (!messageId) return;
        const entry = getEntry(messageId);
        const time = entry.info.time as { created?: number; completed?: number };
        setEntry({
          ...entry,
          info: {
            ...entry.info,
            time: { created: time.created ?? Date.now(), completed: Date.now() },
          } as Message,
        });
        return;
      }
      case "part.started": {
        if (!messageId || !partId) return;
        livePartMeta.set(`${messageId}\u0000${partId}`, { kind: event.partKind });
        return;
      }
      case "part.text.appended":
      case "part.text.replaced": {
        if (!messageId || !partId) return;
        const meta = livePartMeta.get(`${messageId}\u0000${partId}`);
        const kind = event.partKind ?? meta?.kind ?? "text";
        const entry = getEntry(messageId);
        const existing = entry.parts.find((p) => p.id === partId);
        const prevText =
          existing && (existing.type === "text" || existing.type === "reasoning")
            ? ((existing as { text?: string }).text ?? "")
            : "";
        const nextText =
          event.type === "part.text.appended" ? `${prevText}${event.text}` : event.text;
        upsertPart(messageId, textPart(scope, messageId, partId, nextText, kind));
        return;
      }
      case "part.state.changed": {
        if (!messageId || !partId) return;
        if (event.state === "removed") {
          removePart(messageId, partId);
        }
        return;
      }
      case "tool.started": {
        if (!messageId || !partId) return;
        livePartMeta.set(`${messageId}\u0000${partId}`, { tool: event.tool, kind: "tool" });
        const entry = getEntry(messageId);
        const existing = entry.parts.find((p) => p.id === partId);
        const status = existing?.type === "tool" ? existing.state?.status : undefined;
        upsertPart(
          messageId,
          toolPartFromLive(
            scope,
            messageId,
            partId,
            event.tool,
            status && isToolTerminal(status) ? status : "running",
            existing?.type === "tool" ? existing.state?.input : undefined,
            existing?.type === "tool" ? (existing.state?.output as string | undefined) : undefined,
          ),
        );
        return;
      }
      case "tool.input.updated": {
        if (!messageId || !partId) return;
        const meta = livePartMeta.get(`${messageId}\u0000${partId}`);
        const entry = getEntry(messageId);
        const existing = entry.parts.find((p) => p.id === partId);
        const toolName =
          meta?.tool ?? (existing?.type === "tool" ? existing.tool : undefined) ?? "tool";
        const status =
          existing?.type === "tool" ? (existing.state?.status ?? "running") : "running";
        const output =
          existing?.type === "tool" ? (existing.state?.output as string | undefined) : undefined;
        upsertPart(
          messageId,
          toolPartFromLive(scope, messageId, partId, toolName, status, event.input, output),
        );
        return;
      }
      case "tool.output.appended":
      case "tool.output.replaced": {
        if (!messageId || !partId) return;
        const meta = livePartMeta.get(`${messageId}\u0000${partId}`);
        const entry = getEntry(messageId);
        const existing = entry.parts.find((p) => p.id === partId);
        const toolName =
          meta?.tool ?? (existing?.type === "tool" ? existing.tool : undefined) ?? "tool";
        const status =
          existing?.type === "tool" ? (existing.state?.status ?? "running") : "running";
        const input = existing?.type === "tool" ? existing.state?.input : undefined;
        const prevOut =
          existing?.type === "tool" ? ((existing.state?.output as string | undefined) ?? "") : "";
        const nextOut =
          event.type === "tool.output.appended" ? `${prevOut}${event.text}` : event.text;
        upsertPart(
          messageId,
          toolPartFromLive(scope, messageId, partId, toolName, status, input, nextOut),
        );
        return;
      }
      case "tool.finished": {
        if (!messageId || !partId) return;
        const meta = livePartMeta.get(`${messageId}\u0000${partId}`);
        const entry = getEntry(messageId);
        const existing = entry.parts.find((p) => p.id === partId);
        const toolName =
          meta?.tool ?? (existing?.type === "tool" ? existing.tool : undefined) ?? "tool";
        const input = existing?.type === "tool" ? existing.state?.input : undefined;
        const output =
          existing?.type === "tool" ? (existing.state?.output as string | undefined) : undefined;
        const incoming = toolPartFromLive(
          scope,
          messageId,
          partId,
          toolName,
          event.status,
          input,
          output,
        );
        if (existing?.type === "tool" && isToolTerminal(existing.state?.status)) {
          const prevStatus = existing.state?.status;
          const nextStatus = event.status;
          if (
            !isToolTerminal(nextStatus) ||
            toolStatusRank(prevStatus) >= toolStatusRank(nextStatus)
          ) {
            return;
          }
        }
        upsertPart(messageId, incoming);
        return;
      }
      case "message.removed": {
        if (!messageId) return;
        removeMessage(messageId);
        return;
      }
      case "transcript.rebased": {
        const replacement = event.replacement;
        if (replacement?.oldMessageId && replacement?.newMessageId) {
          replaceMessageId(replacement.oldMessageId, replacement.newMessageId);
        }
        return;
      }
      case "run.finished": {
        if (event.reason !== "idle") return;
        const list = finalizeRunningToolsInMessages(
          [...messagesById.values()].map((e) => ({
            ...e,
            parts: orderedParts(e.info.id, e.parts),
          })),
          scope.sessionId,
        );
        for (const entry of list) messagesById.set(entry.info.id, entry);
        bump();
        return;
      }
      case "run.started":
      case "session.error":
        return;
      default:
        return;
    }
  };

  return {
    scope,
    hydrateFromHarnessPage(page, options) {
      harnessProjection.hydrateFromHarnessPage(page, options);
      syncFromHarnessProjection();
    },
    ingestLiveSessionEvents(events) {
      for (const event of events) ingestOne(event);
    },
    getMessages: () => {
      const out: TranscriptMessageEntry[] = [];
      const emitted = new Set<string>();
      for (const id of messageOrder) {
        const entry = messagesById.get(id);
        if (!entry) continue;
        emitted.add(id);
        out.push({ ...entry, parts: orderedParts(entry.info.id, entry.parts) });
      }
      for (const entry of messagesById.values()) {
        if (emitted.has(entry.info.id)) continue;
        ensureMessageOrder(entry.info.id);
        out.push({ ...entry, parts: orderedParts(entry.info.id, entry.parts) });
      }
      return out;
    },
    getRevision: () => revision,
  };
}
