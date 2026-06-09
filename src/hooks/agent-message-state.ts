import type { Message, Part } from "@opencode-ai/sdk/v2/client";
import type { InternalAgentState, MessageEntry } from "@/hooks/agent-state-types";

export const MESSAGE_PAGE_SIZE = 30;
/**
 * Keep a generous active-session window so long local transcripts do not appear truncated.
 * Rendering is virtualized, so the DOM cost stays bounded while we avoid discarding history early.
 */
const MAX_MESSAGE_WINDOW = 1000;
/** Maximum number of idle session message snapshots to keep in the LRU cache */
export const MAX_SESSION_BUFFER_CACHE = 8;

type DeltaTrackedPart = Part & { _deltaPositions?: Record<string, number> };

const OPTIMISTIC_USER_PREFIX = "local-user:";

export function getMessageText(entry: MessageEntry): string {
  return entry.parts
    .flatMap((part) => {
      const record = part as Record<string, unknown>;
      return part.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n")
    .trim();
}

export function isOptimisticUserMessage(entry: MessageEntry): boolean {
  return entry.info.id.startsWith(OPTIMISTIC_USER_PREFIX) && entry.info.role === "user";
}

export function removeMatchingOptimisticUserMessage(
  messages: MessageEntry[],
  canonical: MessageEntry,
): MessageEntry[] {
  if (canonical.info.role !== "user" || isOptimisticUserMessage(canonical)) return messages;
  const canonicalText = getMessageText(canonical);
  if (!canonicalText) return messages;
  const key = `${canonical.info.sessionID}\0${canonicalText}`;
  const filtered = messages.filter(
    (message) =>
      !(
        isOptimisticUserMessage(message) &&
        `${message.info.sessionID}\0${getMessageText(message)}` === key
      ),
  );
  return filtered.length === messages.length ? messages : filtered;
}

export function createOptimisticUserMessage({
  id,
  sessionID,
  text,
  createdAt,
}: {
  id: string;
  sessionID: string;
  text: string;
  createdAt: number;
}): MessageEntry {
  const messageID = `${OPTIMISTIC_USER_PREFIX}${id}`;
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: createdAt },
    } as Message,
    parts: [
      {
        id: `${messageID}:text`,
        type: "text",
        text,
        sessionID,
        messageID,
        time: { start: createdAt, end: createdAt },
      } as Part,
    ],
  };
}

function getPartOrderValue(part: Part): number {
  const timedPart = part as Part & { time?: { start?: number; end?: number } };
  return timedPart.time?.start ?? timedPart.time?.end ?? 0;
}

export function createPlaceholderMessageEntry(sessionID: string, messageID: string): MessageEntry {
  return {
    info: {
      id: messageID,
      sessionID,
      ...(messageID.startsWith("synthetic-user:") ? { role: "user" } : {}),
    } as Message,
    parts: [],
  };
}

export function createPlaceholderPart(
  sessionID: string,
  messageID: string,
  partID: string,
  field: string,
): DeltaTrackedPart {
  return {
    id: partID,
    type: "text",
    text: "",
    sessionID,
    messageID,
    [field]: "",
    _deltaPositions: { [field]: 0 },
  } as DeltaTrackedPart;
}

export function tagPartWithDeltaPositions(part: Part, previous?: Part): DeltaTrackedPart {
  const prevPositions = (previous as Record<string, unknown> | undefined)?._deltaPositions as
    | Record<string, number>
    | undefined;
  const normalizedPositions: Record<string, number> = {};

  if (prevPositions) {
    const partRecord = part as Record<string, unknown>;
    for (const [key, pos] of Object.entries(prevPositions)) {
      if (!Number.isFinite(pos)) continue;
      const value = partRecord[key];
      if (typeof value !== "string") continue;
      normalizedPositions[key] = Math.min(Math.max(pos, 0), value.length);
    }
  } else {
    const partRecord = part as Record<string, unknown>;
    for (const [key, value] of Object.entries(partRecord)) {
      if (typeof value === "string" && value.length > 0) {
        normalizedPositions[key] = value.length;
      }
    }
  }

  return {
    ...part,
    _deltaPositions: normalizedPositions,
  } as DeltaTrackedPart;
}

export function mergeSnapshotPartWithExisting(part: Part, previous?: Part): DeltaTrackedPart {
  const tagged = tagPartWithDeltaPositions(part, previous);
  if (!previous) return tagged;

  const prevRecord = previous as Record<string, unknown>;
  const nextRecord = tagged as Record<string, unknown>;
  const prevPositions = (prevRecord._deltaPositions as Record<string, number> | undefined) ?? {};
  const mergedPositions = {
    ...(nextRecord._deltaPositions as Record<string, number> | undefined),
  };

  for (const [field, prevPosRaw] of Object.entries(prevPositions)) {
    if (!Number.isFinite(prevPosRaw)) continue;
    const prevVal = prevRecord[field];
    const nextVal = nextRecord[field];
    if (typeof prevVal !== "string" || typeof nextVal !== "string") continue;

    if (prevVal.length > nextVal.length && prevVal.startsWith(nextVal)) {
      nextRecord[field] = prevVal;
      mergedPositions[field] = Math.min(Math.max(prevPosRaw, 0), prevVal.length);
      continue;
    }

    const currentPos = mergedPositions[field];
    const fallbackPos =
      typeof currentPos === "number" && Number.isFinite(currentPos) ? currentPos : nextVal.length;
    mergedPositions[field] = Math.min(Math.max(fallbackPos, 0), nextVal.length);
  }

  nextRecord._deltaPositions = mergedPositions;
  return nextRecord as DeltaTrackedPart;
}

export function applyStreamingDeltaToPart(
  existingPart: Part,
  field: string,
  delta: string,
): DeltaTrackedPart {
  const existingRecord = existingPart as Record<string, unknown>;
  const currentRaw = existingRecord[field];
  const currentVal = typeof currentRaw === "string" ? currentRaw : "";
  const positions = (existingRecord._deltaPositions as Record<string, number> | undefined) ?? {};
  const rawDeltaPos = positions[field] ?? 0;
  const numericDeltaPos = Number.isFinite(rawDeltaPos) ? rawDeltaPos : 0;

  const existing: DeltaTrackedPart =
    typeof currentRaw === "string"
      ? (existingPart as DeltaTrackedPart)
      : ({ ...existingPart, [field]: currentVal } as DeltaTrackedPart);

  if (numericDeltaPos > currentVal.length) {
    return {
      ...existing,
      _deltaPositions: { ...positions, [field]: currentVal.length },
    };
  }

  const deltaPos = Math.max(0, numericDeltaPos);
  const nextPos = deltaPos + delta.length;

  if (nextPos <= currentVal.length) {
    const expected = currentVal.slice(deltaPos, nextPos);
    return {
      ...existing,
      _deltaPositions: {
        ...positions,
        [field]: expected === delta ? nextPos : currentVal.length,
      },
    };
  }

  const overlap = currentVal.length - deltaPos;
  if (overlap > 0) {
    const expectedOverlap = currentVal.slice(deltaPos);
    const deltaPrefix = delta.slice(0, overlap);
    if (expectedOverlap !== deltaPrefix) {
      return {
        ...existing,
        _deltaPositions: { ...positions, [field]: currentVal.length },
      };
    }
  }

  const newText = delta.slice(Math.max(0, overlap));
  return {
    ...existing,
    [field]: currentVal + newText,
    _deltaPositions: { ...positions, [field]: nextPos },
  };
}

export function getChildSessionId(part: Part): string | undefined {
  if (
    part.type === "tool" &&
    part.tool.toLowerCase() === "task" &&
    "metadata" in part.state &&
    part.state.metadata
  ) {
    const meta = part.state.metadata as Record<string, unknown>;
    if (typeof meta.sessionId === "string") return meta.sessionId;
  }
  return undefined;
}

export function bufferNonActiveEvent(
  state: InternalAgentState,
  sessionID: string,
  messageID: string,
  updater: (entry: { info: Message; parts: Record<string, Part> }) => {
    info: Message;
    parts: Record<string, Part>;
  },
): InternalAgentState {
  if (state.trackedChildSessionIds.has(sessionID)) {
    const buf = { ...state.childSessions };
    const sessBuf = { ...buf[sessionID] };
    const entry = sessBuf[messageID] ?? {
      info: { id: messageID, sessionID } as Message,
      parts: {},
    };
    sessBuf[messageID] = updater(entry);
    buf[sessionID] = sessBuf;
    return { ...state, childSessions: buf };
  }
  const buf = { ...state._sessionBuffers };
  const existing = buf[sessionID] ?? {
    messages: {},
    hasMore: false,
    cursor: null,
  };
  const msgMap = { ...existing.messages };
  const entry = msgMap[messageID] ?? {
    info: { id: messageID, sessionID } as Message,
    parts: {},
  };
  msgMap[messageID] = updater(entry);
  buf[sessionID] = { ...existing, messages: msgMap };
  return { ...state, _sessionBuffers: buf };
}

export function normalizeMessageEntries(
  incoming: MessageEntry[],
  existingMessages: MessageEntry[],
): MessageEntry[] {
  const existingByMsgId = new Map<string, MessageEntry>();
  for (const message of existingMessages) existingByMsgId.set(message.info.id, message);

  return incoming.map((message) => {
    const existing = existingByMsgId.get(message.info.id);
    const existingPartsById = new Map<string, Part>();
    if (existing) {
      for (const part of existing.parts) existingPartsById.set(part.id, part);
    }

    const normalized = {
      ...message,
      parts: message.parts.map((part) => {
        const prev = existingPartsById.get(part.id);
        if (prev) {
          const prevText = ((prev as Record<string, unknown>).text as string) ?? "";
          const nextText = ((part as Record<string, unknown>).text as string) ?? "";
          if (prevText.length >= nextText.length) return prev;
        }
        if ((part as Record<string, unknown>)._deltaPositions) return part;
        return tagPartWithDeltaPositions(part);
      }),
    };

    return finalizeRunningToolPartsForCompletedMessage(normalized);
  });
}

export function finalizeRunningToolPartsForCompletedMessage(entry: MessageEntry): MessageEntry {
  const time = entry.info.time as { completed?: number } | undefined;
  if (!time?.completed) return entry;

  let changed = false;
  const parts = entry.parts.map((part) => {
    if (part.type !== "tool") return part;
    const status = part.state.status;
    if (status !== "running" && status !== "pending") return part;
    changed = true;
    return {
      ...part,
      state: { ...part.state, status: "completed" as const },
    } as Part;
  });

  return changed ? { ...entry, parts } : entry;
}

export function finalizeRunningToolPartsForSession(
  messages: MessageEntry[],
  sessionID: string,
): MessageEntry[] {
  let changed = false;
  const next = messages.map((entry) => {
    if (entry.info.sessionID !== sessionID) return entry;
    let entryChanged = false;
    const parts = entry.parts.map((part) => {
      if (part.type !== "tool") return part;
      const status = part.state.status;
      if (status !== "running" && status !== "pending") return part;
      entryChanged = true;
      changed = true;
      return { ...part, state: { ...part.state, status: "completed" as const } } as Part;
    });
    return entryChanged ? { ...entry, parts } : entry;
  });
  return changed ? next : messages;
}

export function mergeMessageSnapshot(
  incomingMessages: MessageEntry[],
  existingMessages: MessageEntry[],
): MessageEntry[] {
  const normalizedMessages = normalizeMessageEntries(incomingMessages, existingMessages);
  if (normalizedMessages.length === 0) return limitMessageWindow(existingMessages);

  const canonicalUserTexts = new Set(
    normalizedMessages
      .filter((message) => message.info.role === "user")
      .map((message) => `${message.info.sessionID}\0${getMessageText(message)}`),
  );
  const optimisticIdsToDrop = new Set(
    existingMessages
      .filter(
        (message) =>
          isOptimisticUserMessage(message) &&
          canonicalUserTexts.has(`${message.info.sessionID}\0${getMessageText(message)}`),
      )
      .map((message) => message.info.id),
  );

  const existingByMsgId = new Map<string, MessageEntry>();
  for (const message of existingMessages) existingByMsgId.set(message.info.id, message);

  const mergedMessages = normalizedMessages.map((incoming) => {
    const existing = existingByMsgId.get(incoming.info.id);
    if (!existing) return incoming;

    const incomingPartIds = new Set(incoming.parts.map((part) => part.id));
    const preservedParts = existing.parts.filter((part) => !incomingPartIds.has(part.id));
    if (preservedParts.length === 0) return incoming;

    return {
      ...incoming,
      parts: [...incoming.parts, ...preservedParts].sort(
        (a, b) => getPartOrderValue(a) - getPartOrderValue(b) || a.id.localeCompare(b.id),
      ),
    };
  });

  const incomingIds = new Set(incomingMessages.map((message) => message.info.id));
  const serverLast = normalizedMessages[normalizedMessages.length - 1];
  const serverLastCreated = serverLast?.info.time.created ?? 0;
  for (const entry of existingMessages) {
    if (incomingIds.has(entry.info.id) || optimisticIdsToDrop.has(entry.info.id)) continue;
    const entryCreated = entry.info.time.created ?? 0;
    if (entryCreated > serverLastCreated) mergedMessages.push(entry);
  }

  return limitMessageWindow(mergedMessages);
}

export function limitMessageWindow(messages: MessageEntry[]): MessageEntry[] {
  if (messages.length <= MAX_MESSAGE_WINDOW) return messages;
  return messages.slice(messages.length - MAX_MESSAGE_WINDOW);
}

export function updateMessageArray(
  messages: MessageEntry[],
  messageID: string,
  updater: (entry: MessageEntry | undefined) => MessageEntry | null,
): { messages: MessageEntry[]; found: boolean } {
  const index = messages.findIndex((message) => message.info.id === messageID);
  if (index < 0) {
    const created = updater(undefined);
    if (!created) return { messages, found: false };
    return { messages: [...messages, created], found: false };
  }

  const updated = updater(messages[index]);
  if (!updated) {
    return {
      messages: messages.filter((message) => message.info.id !== messageID),
      found: true,
    };
  }

  const nextMessages = [...messages];
  nextMessages[index] = updated;
  return { messages: nextMessages, found: true };
}
