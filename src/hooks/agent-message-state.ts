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

export function getMessageCreatedAt(message: { info: Message }): number {
  return message.info.time.created ?? 0;
}

export function getPartOrderValue(part: Part): number {
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

    return {
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
  });
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
