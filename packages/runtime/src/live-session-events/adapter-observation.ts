import type { Part, Message } from "../../../../src/protocol/harness-types.ts";
import type { HarnessId } from "../../../../src/agents/index.ts";
import type { LiveSessionScope } from "./live-session-event.ts";

export interface AdapterObservationSource {
  harnessId: HarnessId;
  nativeType?: string;
  nativeEventId?: string;
  transport?: "sse" | "sdk-callback" | "jsonl" | "poll" | "synthetic";
}

export type NormalizedMessageSnapshot = Message;

export type NormalizedPartSnapshot = Part;

export type NormalizedToolSnapshot = Part;

export type AdapterObservation =
  | {
      kind: "activity";
      scope: LiveSessionScope;
      state: "running" | "idle" | "error";
      source?: AdapterObservationSource;
    }
  | {
      kind: "message.snapshot";
      scope: LiveSessionScope;
      message: NormalizedMessageSnapshot;
      source?: AdapterObservationSource;
    }
  | {
      kind: "part.snapshot";
      scope: LiveSessionScope;
      messageId: string;
      part: NormalizedPartSnapshot;
      source?: AdapterObservationSource;
    }
  | {
      kind: "part.delta";
      scope: LiveSessionScope;
      messageId: string;
      partId: string;
      partKind: "text" | "thinking";
      text: string;
      source?: AdapterObservationSource;
    }
  | {
      kind: "tool.snapshot";
      scope: LiveSessionScope;
      messageId: string;
      part: NormalizedToolSnapshot;
      source?: AdapterObservationSource;
    }
  | {
      kind: "transcript.replaced";
      scope: LiveSessionScope;
      reason: "harness-replaced-message" | "reconnect" | "final-read";
      oldMessageId?: string;
      newMessageId?: string;
      source?: AdapterObservationSource;
    }
  | { kind: "error"; scope: LiveSessionScope; message: string; source?: AdapterObservationSource };
