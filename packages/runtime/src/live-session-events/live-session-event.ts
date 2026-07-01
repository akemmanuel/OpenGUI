import type { HarnessId } from "../../../../src/agents/index.ts";

export interface LiveSessionScope {
  directory: string;
  harnessId: HarnessId;
  sessionId: string;
}

export type LiveSessionEventType =
  | "run.started"
  | "run.finished"
  | "message.started"
  | "message.finished"
  | "part.started"
  | "part.text.appended"
  | "part.text.replaced"
  | "part.state.changed"
  | "tool.started"
  /** Emitted when normalizer maps tool input snapshots (not all harnesses yet). */
  | "tool.input.updated"
  /** Emitted when normalizer maps progressive tool output (not all harnesses yet). */
  | "tool.output.appended"
  | "tool.output.replaced"
  | "tool.finished"
  | "transcript.rebased"
  | "session.error";

interface LiveSessionEventBase {
  version: 1;
  id: string;
  seq: number;
  type: LiveSessionEventType;
  scope: LiveSessionScope;
  runId?: string;
  messageId?: string;
  partId?: string;
  time: { observed: number };
}

export type LiveSessionEvent =
  | (LiveSessionEventBase & { type: "run.started" })
  | (LiveSessionEventBase & { type: "run.finished"; reason: "idle" | "error" })
  | (LiveSessionEventBase & { type: "message.started"; role?: string })
  | (LiveSessionEventBase & { type: "message.finished" })
  | (LiveSessionEventBase & { type: "part.started"; partKind: string })
  | (LiveSessionEventBase & {
      type: "part.text.appended";
      partKind: "text" | "thinking";
      text: string;
    })
  | (LiveSessionEventBase & {
      type: "part.text.replaced";
      partKind: "text" | "thinking";
      text: string;
      reason: "snapshot-rewrite" | "transcript-rebase";
    })
  | (LiveSessionEventBase & { type: "part.state.changed"; state: string })
  | (LiveSessionEventBase & { type: "tool.started"; tool: string })
  | (LiveSessionEventBase & { type: "tool.input.updated"; input: unknown })
  | (LiveSessionEventBase & { type: "tool.output.appended"; text: string })
  | (LiveSessionEventBase & {
      type: "tool.output.replaced";
      text: string;
      reason: "snapshot-rewrite" | "transcript-rebase";
    })
  | (LiveSessionEventBase & { type: "tool.finished"; status: string })
  | (LiveSessionEventBase & {
      type: "transcript.rebased";
      reason: "harness-replaced-message" | "reconnect" | "final-read";
      replacement?: {
        oldMessageId: string;
        newMessageId: string;
      };
    })
  | (LiveSessionEventBase & { type: "session.error"; message: string });

export type LiveSessionEventHandler = (event: LiveSessionEvent) => void;
