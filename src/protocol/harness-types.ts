/** OpenGUI-facing Harness data shapes.
 *
 * These are deliberately structural protocol DTOs, not re-exported SDK types.
 * Harness Adapters may map richer SDK payloads into this shape; Frontend code
 * should only depend on the fields it renders or routes back to the Backend.
 */

export type JsonRecord = Record<string, unknown>;

export type McpLocalConfig = JsonRecord & { type?: "local" | "stdio"; command?: string };
export type McpRemoteConfig = JsonRecord & { type?: "remote" | "sse" | "http"; url?: string };

export interface McpStatus extends JsonRecord {
  status: string;
  error?: string;
}

export type HarnessConfig = JsonRecord;

export interface Model extends JsonRecord {
  id?: string;
  name: string;
  release_date: string;
  capabilities: { reasoning: boolean } & JsonRecord;
  limit?: { context?: number } & JsonRecord;
  variants?: Record<string, { disabled?: boolean } & JsonRecord>;
}

export interface Provider extends JsonRecord {
  id: string;
  name: string;
  source: string;
  models: Record<string, Model>;
}

export interface Agent extends JsonRecord {
  name: string;
  mode?: string;
  hidden?: boolean;
  color?: string;
}

export interface Command extends JsonRecord {
  name: string;
}

export interface HarnessSession extends JsonRecord {
  id: string;
  title?: string;
  directory: string;
  time: { created: number; updated?: number } & JsonRecord;
  model?: { providerID?: string; id?: string; variant?: string } & JsonRecord;
  revert?: { messageID?: string } & JsonRecord;
}

export type Message = TranscriptMessage &
  JsonRecord & { providerID: string; modelID: string; role: string };

export type PartState = { status?: string; metadata?: JsonRecord } & JsonRecord;

export type Part = TranscriptPart &
  JsonRecord & {
    sessionID: string;
    messageID: string;
    tokens: {
      total?: number;
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };

export type PermissionRequest = PermissionInteractionRequest & JsonRecord;

export type QuestionRequest = QuestionInteractionRequest & JsonRecord;

export type QuestionAnswer = QuestionInteractionAnswer;
import type {
  PermissionInteractionRequest,
  QuestionInteractionAnswer,
  QuestionInteractionRequest,
  TranscriptMessage,
  TranscriptPart,
} from "@/protocol/session-transcript";
