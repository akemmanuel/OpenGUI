import type { AdapterObservation, NormalizedPartSnapshot } from "./adapter-observation.ts";
import type { LiveSessionEvent, LiveSessionScope } from "./live-session-event.ts";

type LiveSessionEventInput = LiveSessionEvent extends infer Event
  ? Event extends LiveSessionEvent
    ? Omit<Event, "version" | "id" | "seq" | "time" | "scope">
    : never
  : never;

interface MessageState {
  started: boolean;
  role?: string;
  finished?: boolean;
}
interface PartState {
  started: boolean;
  kind: string;
  text: string;
  tool?: string;
  status?: string;
  inputFingerprint?: string;
  output: string;
}
interface State {
  seq: number;
  activity: "idle" | "running" | "error";
  currentRunId?: string;
  runCounter: number;
  messages: Map<string, MessageState>;
  parts: Map<string, PartState>;
}

export class LiveSessionEventNormalizer {
  private states = new Map<string, State>();

  ingest(observation: AdapterObservation): LiveSessionEvent[] {
    const state = this.state(observation.scope);
    const emit = (event: LiveSessionEventInput) => this.event(observation.scope, state, event);
    switch (observation.kind) {
      case "activity": {
        if (state.activity !== "running" && observation.state === "running") {
          state.currentRunId = `${observation.scope.sessionId}:run:${++state.runCounter}`;
          state.activity = "running";
          return [emit({ type: "run.started", runId: state.currentRunId })];
        }
        if (state.activity === "running" && observation.state !== "running") {
          const runId = state.currentRunId;
          state.currentRunId = undefined;
          state.activity = observation.state;
          const out = [
            emit({
              type: "run.finished",
              runId,
              reason: observation.state === "error" ? "error" : "idle",
            }),
          ];
          if (observation.state === "error")
            out.push(emit({ type: "session.error", message: "Session entered error state" }));
          return out;
        }
        state.activity = observation.state;
        return [];
      }
      case "message.snapshot":
        return this.ensureMessage(
          observation.scope,
          state,
          observation.message.id,
          observation.message.role,
        );
      case "part.delta": {
        const out = this.ensurePart(
          observation.scope,
          state,
          observation.messageId,
          observation.partId,
          observation.partKind,
        );
        const part = state.parts.get(partKey(observation.messageId, observation.partId))!;
        part.text += observation.text;
        out.push(
          emit({
            type: "part.text.appended",
            runId: state.currentRunId,
            messageId: observation.messageId,
            partId: observation.partId,
            partKind: observation.partKind,
            text: observation.text,
          }),
        );
        return out;
      }
      case "part.snapshot":
        return this.ingestPartSnapshot(
          observation.scope,
          state,
          observation.messageId,
          observation.part,
        );
      case "tool.snapshot":
        return this.ingestToolSnapshot(
          observation.scope,
          state,
          observation.messageId,
          observation.part,
        );
      case "transcript.replaced":
        return [
          emit({
            type: "transcript.rebased",
            reason: observation.reason,
            ...(observation.oldMessageId && observation.newMessageId
              ? {
                  replacement: {
                    oldMessageId: observation.oldMessageId,
                    newMessageId: observation.newMessageId,
                  },
                }
              : {}),
          }),
        ];
      case "error":
        return [emit({ type: "session.error", message: observation.message })];
    }
  }

  evict(scope: LiveSessionScope): void {
    this.states.delete(key(scope));
  }

  private ingestPartSnapshot(
    scope: LiveSessionScope,
    state: State,
    messageId: string,
    part: NormalizedPartSnapshot,
  ): LiveSessionEvent[] {
    const kind = part.type === "reasoning" ? "thinking" : part.type;
    if (kind !== "text" && kind !== "thinking") return [];
    const out = this.ensurePart(scope, state, messageId, part.id, kind);
    const partState = state.parts.get(partKey(messageId, part.id))!;
    const next = typeof part.text === "string" ? part.text : "";
    if (next !== partState.text) {
      if (next.startsWith(partState.text))
        out.push(
          this.event(scope, state, {
            type: "part.text.appended",
            runId: state.currentRunId,
            messageId,
            partId: part.id,
            partKind: kind,
            text: next.slice(partState.text.length),
          }),
        );
      else
        out.push(
          this.event(scope, state, {
            type: "part.text.replaced",
            runId: state.currentRunId,
            messageId,
            partId: part.id,
            partKind: kind,
            text: next,
            reason: "snapshot-rewrite",
          }),
        );
      partState.text = next;
    }
    return out;
  }

  private ingestToolSnapshot(
    scope: LiveSessionScope,
    state: State,
    messageId: string,
    part: NormalizedPartSnapshot,
  ): LiveSessionEvent[] {
    const out = this.ensurePart(scope, state, messageId, part.id, "tool");
    const p = state.parts.get(partKey(messageId, part.id))!;
    const tool = typeof part.tool === "string" ? part.tool : "tool";
    if (!p.tool) {
      p.tool = tool;
      out.push(
        this.event(scope, state, {
          type: "tool.started",
          runId: state.currentRunId,
          messageId,
          partId: part.id,
          tool,
        }),
      );
    }

    const input = part.state && "input" in part.state ? part.state.input : undefined;
    if (input !== undefined) {
      const inputFingerprint = stableFingerprint(input);
      if (inputFingerprint !== p.inputFingerprint) {
        p.inputFingerprint = inputFingerprint;
        out.push(
          this.event(scope, state, {
            type: "tool.input.updated",
            runId: state.currentRunId,
            messageId,
            partId: part.id,
            input,
          }),
        );
      }
    }

    const output = toolSnapshotOutput(part);
    if (output && output !== p.output) {
      if (p.output && output.startsWith(p.output)) {
        out.push(
          this.event(scope, state, {
            type: "tool.output.appended",
            runId: state.currentRunId,
            messageId,
            partId: part.id,
            text: output.slice(p.output.length),
          }),
        );
      } else {
        out.push(
          this.event(scope, state, {
            type: "tool.output.replaced",
            runId: state.currentRunId,
            messageId,
            partId: part.id,
            text: output,
            reason: "snapshot-rewrite",
          }),
        );
      }
      p.output = output;
    }

    const status = typeof part.state?.status === "string" ? part.state.status : undefined;
    if (status && status !== p.status) {
      p.status = status;
      out.push(
        this.event(scope, state, {
          type: "part.state.changed",
          runId: state.currentRunId,
          messageId,
          partId: part.id,
          state: status,
        }),
      );
      if (["completed", "error", "failed"].includes(status))
        out.push(
          this.event(scope, state, {
            type: "tool.finished",
            runId: state.currentRunId,
            messageId,
            partId: part.id,
            status,
          }),
        );
    }
    return out;
  }

  private ensureMessage(
    scope: LiveSessionScope,
    state: State,
    messageId: string,
    role?: string,
  ): LiveSessionEvent[] {
    if (state.messages.has(messageId)) return [];
    state.messages.set(messageId, { started: true, role });
    return [
      this.event(scope, state, {
        type: "message.started",
        runId: state.currentRunId,
        messageId,
        role,
      }),
    ];
  }

  private ensurePart(
    scope: LiveSessionScope,
    state: State,
    messageId: string,
    partId: string,
    kind: string,
  ): LiveSessionEvent[] {
    const out = this.ensureMessage(scope, state, messageId);
    const pk = partKey(messageId, partId);
    if (!state.parts.has(pk)) {
      state.parts.set(pk, { started: true, kind, text: "", output: "" });
      out.push(
        this.event(scope, state, {
          type: "part.started",
          runId: state.currentRunId,
          messageId,
          partId,
          partKind: kind,
        }),
      );
    }
    return out;
  }

  private state(scope: LiveSessionScope): State {
    const k = key(scope);
    let state = this.states.get(k);
    if (!state) {
      state = { seq: 0, activity: "idle", runCounter: 0, messages: new Map(), parts: new Map() };
      this.states.set(k, state);
    }
    return state;
  }

  private event(
    scope: LiveSessionScope,
    state: State,
    event: LiveSessionEventInput,
  ): LiveSessionEvent {
    const seq = ++state.seq;
    return {
      version: 1,
      id: `${scope.sessionId}:live:${seq}`,
      seq,
      scope,
      time: { observed: Date.now() },
      ...event,
    } as LiveSessionEvent;
  }
}

function key(scope: LiveSessionScope): string {
  return `${scope.directory}\u0000${scope.harnessId}\u0000${scope.sessionId}`;
}

function partKey(messageId: string, partId: string): string {
  return `${messageId}\u0000${partId}`;
}

function stableFingerprint(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolSnapshotOutput(part: NormalizedPartSnapshot): string {
  const state = part.state;
  if (!state || typeof state !== "object") return "";
  if ("output" in state && typeof state.output === "string") return state.output;
  if ("error" in state && typeof state.error === "string") return state.error;
  if ("metadata" in state && state.metadata && typeof state.metadata === "object") {
    const metadata = state.metadata as Record<string, unknown>;
    if (typeof metadata.output === "string") return metadata.output;
  }
  return "";
}
