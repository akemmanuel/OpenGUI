import { LiveSessionProjection } from "@opengui/runtime/client";
import type { LiveSessionEvent } from "@opengui/runtime/client";
import type { Message, Part } from "@/protocol/harness-types";
import type { MessageEntry } from "@/hooks/agent-state-types";
import type { ActiveTranscriptScope } from "@/features/session-transcript/transcript-input";

const TRANSCRIPT_DRIVING_TYPES = new Set<LiveSessionEvent["type"]>([
  "message.started",
  "message.finished",
  "part.started",
  "part.text.appended",
  "part.text.replaced",
  "part.state.changed",
  "tool.started",
  "tool.input.updated",
  "tool.output.appended",
  "tool.output.replaced",
  "tool.finished",
  "transcript.rebased",
]);

function scopeKey(scope: ActiveTranscriptScope): string {
  return `${scope.directory}\u0000${scope.harnessId}\u0000${scope.sessionId}`;
}

function livePartToHarnessPart(
  scope: ActiveTranscriptScope,
  messageId: string,
  part: ReturnType<LiveSessionProjection["getMessages"]>[number]["parts"][number],
): Part {
  const base = {
    id: part.id,
    sessionID: scope.sessionId,
    messageID: messageId,
    tokens: {},
  };
  if (part.type === "tool" || part.tool) {
    return {
      ...base,
      type: "tool",
      tool: part.tool ?? "tool",
      state: {
        status: part.status ?? "running",
        input: part.input,
        output: part.output,
      },
    } as Part;
  }
  if (part.type === "thinking" || part.type === "reasoning") {
    return {
      ...base,
      type: "reasoning",
      text: part.text ?? "",
      time: { start: 0 },
    } as Part;
  }
  return {
    ...base,
    type: "text",
    text: part.text ?? "",
  } as Part;
}

export function projectedMessageToEntry(
  scope: ActiveTranscriptScope,
  message: ReturnType<LiveSessionProjection["getMessages"]>[number],
): MessageEntry {
  const info: Message = {
    id: message.id,
    sessionID: scope.sessionId,
    role: message.role ?? "assistant",
    time: { created: Date.now(), ...(message.finished ? { completed: Date.now() } : {}) },
    providerID: "",
    modelID: "",
  };
  return {
    info,
    parts: message.parts.map((part) => livePartToHarnessPart(scope, message.id, part)),
  };
}

export class ActiveSessionLiveProjection {
  private projections = new Map<string, LiveSessionProjection>();
  private seenEventIds = new Set<string>();

  resetScope(scope: ActiveTranscriptScope | null): void {
    if (!scope) {
      this.projections.clear();
      this.seenEventIds.clear();
      return;
    }
    const key = scopeKey(scope);
    for (const existing of this.projections.keys()) {
      if (existing !== key) this.projections.delete(existing);
    }
    this.seenEventIds.clear();
  }

  ingest(event: LiveSessionEvent): MessageEntry | null {
    if (this.seenEventIds.has(event.id)) return null;
    this.seenEventIds.add(event.id);
    if (this.seenEventIds.size > 2000) {
      this.seenEventIds.clear();
      this.seenEventIds.add(event.id);
    }

    const scope: ActiveTranscriptScope = {
      directory: event.scope.directory,
      harnessId: event.scope.harnessId,
      sessionId: event.scope.sessionId,
    };

    switch (event.type) {
      case "run.started":
        return null;
      case "run.finished":
        return null;
      case "session.error":
        return null;
      case "transcript.rebased": {
        const replacement = event.replacement;
        if (replacement?.oldMessageId && replacement?.newMessageId) {
          const projection = this.projectionFor(scope);
          projection.replaceMessageId(replacement.oldMessageId, replacement.newMessageId);
        }
        return null;
      }
      default:
        break;
    }

    if (!TRANSCRIPT_DRIVING_TYPES.has(event.type)) return null;
    if (!event.messageId) return null;

    const projection = this.projectionFor(scope);
    projection.apply(event);

    const message = projection.getMessages().find((item) => item.id === event.messageId);
    if (!message) return null;
    return projectedMessageToEntry(scope, message);
  }

  private projectionFor(scope: ActiveTranscriptScope): LiveSessionProjection {
    const key = scopeKey(scope);
    let projection = this.projections.get(key);
    if (!projection) {
      projection = new LiveSessionProjection();
      this.projections.set(key, projection);
    }
    return projection;
  }
}
