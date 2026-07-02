import type { HarnessEvent } from "../../../src/agents/backend.ts";
import type { Message, Part } from "../../../src/protocol/harness-types.ts";
import { applyTranscriptPartDelta, type DeltaFieldState } from "./transcript-part-delta.ts";

export interface TranscriptMessageEntry {
  info: Message;
  parts: Part[];
}

export interface MessagePageResult {
  messages: TranscriptMessageEntry[];
  nextCursor: string | null;
}

export interface SessionTranscriptScope {
  directory: string;
  harnessId: string;
  sessionId: string;
}

export interface GetMessagesOptions {
  before?: string | null;
  limit?: number;
}

export interface HydrateMessagesOptions {
  before?: string | null;
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

function getStringField(record: Record<string, unknown>, field: string): string {
  const v = record[field];
  return typeof v === "string" ? v : "";
}

function mergeStringFields(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const out = { ...next };
  for (const field of fields) {
    const prevVal = getStringField(prev, field);
    const nextVal = getStringField(out, field);
    if (prevVal.length > nextVal.length && prevVal.startsWith(nextVal)) {
      out[field] = prevVal;
    }
  }
  return out;
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
  const merged = mergeStringFields(prev, next, ["text"]);
  return { ...existing, ...incoming, ...merged } as Part;
}

function mergePart(incoming: Part, existing?: Part): Part {
  if (!existing) return incoming;
  if (incoming.type === "tool") return mergeToolPart(incoming, existing);
  if (incoming.type === "text" || incoming.type === "reasoning") {
    return mergeTextLikePart(incoming, existing);
  }
  return { ...existing, ...incoming };
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
): { messages: TranscriptMessageEntry[]; changed: boolean } {
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
  return { messages: changed ? next : messages, changed };
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

function partFieldKey(messageID: string, partID: string, field: string): string {
  return `${messageID}\u0000${partID}\u0000${field}`;
}

function partKeyPrefix(messageID: string, partID: string): string {
  return `${messageID}\u0000${partID}\u0000`;
}

function messageKeyPrefix(messageID: string): string {
  return `${messageID}\u0000`;
}

export interface SessionTranscriptProjection {
  readonly scope: SessionTranscriptScope;
  hydrateFromHarnessPage(page: MessagePageResult, options?: HydrateMessagesOptions): void;
  ingestHarnessEvent(event: HarnessEvent): HarnessEvent[];
  getMessages(options?: GetMessagesOptions): TranscriptMessageEntry[];
  getRevision(): number;
  replaceSnapshot(messages: TranscriptMessageEntry[]): void;
  mergeSnapshotPage(
    incoming: TranscriptMessageEntry[],
    options?: { preserveOlderThanFirstIncoming?: boolean },
  ): TranscriptMessageEntry[];
}

export function createSessionTranscriptProjection(
  scope: SessionTranscriptScope,
): SessionTranscriptProjection {
  const messagesById = new Map<string, TranscriptMessageEntry>();
  let messageOrder: string[] = [];
  const partOrderByMessage = new Map<string, string[]>();
  const deltaFields = new Map<string, DeltaFieldState>();
  let revision = 0;

  const bump = () => {
    revision += 1;
  };

  const getDeltaState = (messageID: string, partID: string, field: string): DeltaFieldState => {
    const key = partFieldKey(messageID, partID, field);
    let state = deltaFields.get(key);
    if (!state) {
      state = { cursor: 0, seenEventIds: new Set() };
      deltaFields.set(key, state);
    }
    return state;
  };

  const deleteDeltaStateForPart = (messageID: string, partID: string) => {
    const prefix = partKeyPrefix(messageID, partID);
    for (const key of deltaFields.keys()) {
      if (key.startsWith(prefix)) deltaFields.delete(key);
    }
  };

  const deleteDeltaStateForMessage = (messageID: string) => {
    const prefix = messageKeyPrefix(messageID);
    for (const key of deltaFields.keys()) {
      if (key.startsWith(prefix)) deltaFields.delete(key);
    }
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

  const replacePartOrderFromPage = (messageID: string, parts: readonly Part[]) => {
    const incoming = parts.map((part) => part.id);
    const current = partOrder(messageID);
    partOrderByMessage.set(
      messageID,
      applyCanonicalOrderBlock(current, incoming, { noOverlap: "prepend" }),
    );
  };

  const placeMessageAt = (messageID: string, index: number) => {
    messageOrder = messageOrder.filter((id) => id !== messageID);
    const bounded = Math.max(0, Math.min(index, messageOrder.length));
    messageOrder.splice(bounded, 0, messageID);
  };

  const removeMessageCompletely = (messageID: string): boolean => {
    const existed = messagesById.delete(messageID);
    messageOrder = messageOrder.filter((id) => id !== messageID);
    partOrderByMessage.delete(messageID);
    deleteDeltaStateForMessage(messageID);
    return existed;
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

  const orderedParts = (messageID: string, parts: readonly Part[]): Part[] => {
    const partsById = new Map(parts.map((part) => [part.id, part]));
    const order = partOrder(messageID);
    for (const part of parts) ensurePartOrder(messageID, part.id);
    return order.filter((id) => partsById.has(id)).map((id) => partsById.get(id)!);
  };

  const orderedMessages = (): TranscriptMessageEntry[] => {
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
  };

  const makePlaceholderEntry = (messageId: string, sessionId: string): TranscriptMessageEntry => ({
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "assistant",
      time: { created: Date.now() },
    } as Message,
    parts: [],
  });

  const getEntry = (messageId: string, sessionId: string): TranscriptMessageEntry => {
    const existing = messagesById.get(messageId);
    if (existing) return existing;
    ensureMessageOrder(messageId);
    const entry = makePlaceholderEntry(messageId, sessionId);
    messagesById.set(messageId, entry);
    return entry;
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

  const upsertPartInEntry = (
    entry: TranscriptMessageEntry,
    part: Part,
  ): { entry: TranscriptMessageEntry; changed: boolean } => {
    ensurePartOrder(entry.info.id, part.id);
    const idx = entry.parts.findIndex((p) => p.id === part.id);
    const previous = idx >= 0 ? entry.parts[idx] : undefined;
    const merged = mergePart(part, previous);
    const parts = [...entry.parts];
    if (idx >= 0) parts[idx] = merged;
    else parts.push(merged);
    const next = finalizeToolsForCompletedMessage({
      ...entry,
      parts: orderedParts(entry.info.id, parts),
    });
    return { entry: next, changed: idx < 0 || merged !== previous };
  };

  const ingest = (event: HarnessEvent): HarnessEvent[] => {
    const out: HarnessEvent[] = [];
    switch (event.type) {
      case "message.updated": {
        const msg = event.message;
        if (msg.sessionID !== scope.sessionId) return out;
        const prev = messagesById.get(msg.id);
        const entry: TranscriptMessageEntry = {
          info: msg,
          parts: prev?.parts ?? [],
        };
        setEntry(entry);
        out.push({ type: "message.updated", message: entry.info });
        return out;
      }
      case "message.replaced": {
        if (event.sessionID !== scope.sessionId) return out;
        const oldIndex = messageOrder.indexOf(event.oldId);
        removeMessageCompletely(event.oldId);
        partOrderByMessage.set(event.message.id, uniqueIds(event.parts.map((part) => part.id)));
        if (oldIndex >= 0) placeMessageAt(event.message.id, oldIndex);
        const entry: TranscriptMessageEntry = {
          info: event.message,
          parts: orderedParts(
            event.message.id,
            event.parts.map((p) => mergePart(p, undefined)),
          ),
        };
        setEntry(entry);
        out.push({
          type: "message.replaced",
          sessionID: event.sessionID,
          oldId: event.oldId,
          message: entry.info,
          parts: entry.parts,
        });
        return out;
      }
      case "message.part.updated": {
        const part = event.part;
        if (part.sessionID !== scope.sessionId) return out;
        const entry = getEntry(part.messageID, part.sessionID);
        const next = upsertPartInEntry(entry, part);
        setEntry(next.entry);
        const projected = next.entry.parts.find((p) => p.id === part.id) ?? part;
        out.push({ type: "message.part.updated", part: projected });
        return out;
      }
      case "message.part.delta": {
        if (event.sessionID !== scope.sessionId) return out;
        const entry = getEntry(event.messageID, event.sessionID);
        const idx = entry.parts.findIndex((p) => p.id === event.partID);
        const existing =
          idx >= 0
            ? entry.parts[idx]
            : ({
                id: event.partID,
                type: "text",
                text: "",
                sessionID: event.sessionID,
                messageID: event.messageID,
              } as Part);
        const nextPart = applyTranscriptPartDelta(
          existing,
          event,
          getDeltaState(event.messageID, event.partID, event.field),
        );
        if (nextPart.duplicate || !nextPart.changed) return out;
        const next = upsertPartInEntry(entry, nextPart.part);
        setEntry(next.entry);
        const projected = next.entry.parts.find((p) => p.id === event.partID) ?? nextPart.part;
        out.push({ type: "message.part.updated", part: projected });
        return out;
      }
      case "message.part.removed": {
        if (event.sessionID !== scope.sessionId) return out;
        const entry = messagesById.get(event.messageID);
        if (!entry) return out;
        const existed = entry.parts.some((p) => p.id === event.partID);
        if (!existed) return out;
        const parts = entry.parts.filter((p) => p.id !== event.partID);
        partOrderByMessage.set(
          event.messageID,
          partOrder(event.messageID).filter((id) => id !== event.partID),
        );
        deleteDeltaStateForPart(event.messageID, event.partID);
        setEntry({ ...entry, parts });
        out.push(event);
        return out;
      }
      case "message.removed": {
        if (event.sessionID !== scope.sessionId) return out;
        if (!removeMessageCompletely(event.messageID)) return out;
        bump();
        out.push(event);
        return out;
      }
      case "session.status": {
        if (event.sessionID !== scope.sessionId) return out;
        if (event.status?.type === "idle") {
          const finalized = finalizeRunningToolsInMessages(orderedMessages(), scope.sessionId);
          for (const entry of finalized.messages) messagesById.set(entry.info.id, entry);
          if (finalized.changed) bump();
          for (const entry of finalized.messages) {
            for (const part of entry.parts) {
              if (part.type === "tool") {
                out.push({ type: "message.part.updated", part });
              }
            }
          }
        }
        out.push(event);
        return out;
      }
      default:
        return out;
    }
  };

  const mergePageEntries = (page: MessagePageResult, options?: HydrateMessagesOptions) => {
    const incomingMessageIds: string[] = [];
    for (const incoming of page.messages) {
      if (incoming.info.sessionID !== scope.sessionId) continue;
      incomingMessageIds.push(incoming.info.id);
      replacePartOrderFromPage(incoming.info.id, incoming.parts);
      const existing = messagesById.get(incoming.info.id);
      if (!existing) {
        setEntry(
          {
            info: incoming.info,
            parts: orderedParts(incoming.info.id, incoming.parts),
          },
          false,
        );
        continue;
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
          info: mergeMessageInfo(incoming.info, existing.info),
          parts: orderedParts(incoming.info.id, [...partsById.values()]),
        },
        false,
      );
    }

    if (incomingMessageIds.length > 0) {
      messageOrder = applyCanonicalOrderBlock(messageOrder, incomingMessageIds, {
        beforeId: options?.before ?? null,
        noOverlap: "prepend",
      });
      for (const id of incomingMessageIds) {
        const entry = messagesById.get(id);
        if (entry) applyMessageRelationships(entry.info);
      }
    }
  };

  return {
    scope,
    getRevision: () => revision,
    getMessages: (options) => {
      let list = orderedMessages();
      if (options?.before) {
        const beforeIdx = list.findIndex((m) => m.info.id === options.before);
        if (beforeIdx > 0) list = list.slice(0, beforeIdx);
        else if (beforeIdx === 0) list = [];
      }
      if (options?.limit !== undefined && options.limit >= 0) {
        list = list.slice(Math.max(0, list.length - options.limit));
      }
      return list;
    },
    hydrateFromHarnessPage(page, options) {
      mergePageEntries(page, options);
      bump();
    },
    ingestHarnessEvent: ingest,
    replaceSnapshot(messages) {
      messagesById.clear();
      messageOrder = [];
      partOrderByMessage.clear();
      deltaFields.clear();
      for (const entry of messages) {
        if (entry.info.sessionID !== scope.sessionId) continue;
        messageOrder.push(entry.info.id);
        partOrderByMessage.set(entry.info.id, uniqueIds(entry.parts.map((part) => part.id)));
        messagesById.set(
          entry.info.id,
          finalizeToolsForCompletedMessage({
            ...entry,
            parts: orderedParts(entry.info.id, entry.parts),
          }),
        );
      }
      bump();
    },
    mergeSnapshotPage(incoming) {
      mergePageEntries({ messages: incoming, nextCursor: null });
      bump();
      return orderedMessages();
    },
  };
}

function mergeMessageInfo(incoming: Message, existing: Message): Message {
  const incTime = incoming.time as { created?: number; completed?: number } | undefined;
  const exTime = existing.time as { created?: number; completed?: number } | undefined;
  const completed = incTime?.completed ?? exTime?.completed;
  return {
    ...existing,
    ...incoming,
    time: {
      created: incTime?.created ?? exTime?.created ?? Date.now(),
      ...(completed !== undefined ? { completed } : {}),
    },
  } as Message;
}

export function projectHarnessEventForSession(
  projection: SessionTranscriptProjection,
  event: HarnessEvent,
): HarnessEvent[] {
  return projection.ingestHarnessEvent(event);
}
