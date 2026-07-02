import type { Part } from "../../../src/protocol/harness-types.ts";
import type { HarnessEvent } from "../../../src/agents/backend.ts";

export interface DeltaFieldState {
  cursor: number;
  seenEventIds: Set<string>;
}

export interface DeltaApplyResult {
  part: Part;
  changed: boolean;
  duplicate: boolean;
}

export function applyTranscriptPartDelta(
  part: Part,
  event: Extract<HarnessEvent, { type: "message.part.delta" }>,
  state: DeltaFieldState,
): DeltaApplyResult {
  if (event.id && state.seenEventIds.has(event.id)) {
    return { part, changed: false, duplicate: true };
  }
  if (event.id) state.seenEventIds.add(event.id);

  const record = part as Record<string, unknown>;
  const current = typeof record[event.field] === "string" ? (record[event.field] as string) : "";
  const delta = event.delta;
  if (!delta) return { part, changed: false, duplicate: false };

  const coveredAtCursor = current.slice(state.cursor, state.cursor + delta.length);
  if (coveredAtCursor === delta) {
    state.cursor += delta.length;
    return { part, changed: false, duplicate: false };
  }

  if (state.cursor === 0 && current === delta) {
    state.cursor = delta.length;
    return { part, changed: false, duplicate: false };
  }

  if (current && delta.length > current.length && delta.startsWith(current)) {
    state.cursor = delta.length;
    return {
      part: { ...part, [event.field]: delta } as Part,
      changed: true,
      duplicate: false,
    };
  }

  state.cursor = current.length + delta.length;
  return {
    part: { ...part, [event.field]: current + delta } as Part,
    changed: true,
    duplicate: false,
  };
}
