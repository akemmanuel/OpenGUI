/**
 * OpenGUI-owned Session transcript presentation types.
 *
 * These shapes are the frontend seam for rendering Host transcript content.
 */

export interface TranscriptMessageEntry {
  info: TranscriptMessage;
  parts: TranscriptPart[];
}

export interface TranscriptMessageError {
  name: string;
  data?: unknown;
}

export interface TranscriptMessage {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | (string & {});
  time: {
    created: number;
    completed?: number;
  };
  error?: TranscriptMessageError;
  summary?: boolean | object;
  providerID?: string;
  modelID?: string;
  variant?: string;
  model?: {
    providerID?: string;
    modelID?: string;
    variant?: string;
  };
}

export type TranscriptPart =
  | TextTranscriptPart
  | FileTranscriptPart
  | ReasoningTranscriptPart
  | ToolCallTranscriptPart
  | NonRenderableTranscriptPart;

export interface BaseTranscriptPart {
  id: string;
  sessionID?: string;
  messageID?: string;
}

export interface TextTranscriptPart extends BaseTranscriptPart {
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: TranscriptPartTime;
  metadata?: Record<string, unknown>;
}

export interface FileTranscriptPart extends BaseTranscriptPart {
  type: "file";
  mime?: string;
  filename?: string;
  url: string;
  source?: unknown;
}

export interface ReasoningTranscriptPart extends BaseTranscriptPart {
  type: "reasoning";
  text: string;
  metadata?: Record<string, unknown>;
  time: TranscriptPartTime;
}

export interface ToolCallTranscriptPart extends BaseTranscriptPart {
  type: "tool";
  callID?: string;
  tool: string;
  state: ToolCallState;
  metadata?: Record<string, unknown>;
}

export type ToolCallStateStatus = "pending" | "running" | "completed" | "error" | (string & {});

export interface ToolCallState {
  status: ToolCallStateStatus;
  input?: unknown;
  raw?: string;
  title?: string;
  output?: unknown;
  error?: unknown;
  metadata?: unknown;
  time?: TranscriptPartTime;
  attachments?: TranscriptAttachment[];
}

export interface TranscriptPartTime {
  start?: number;
  end?: number;
  compacted?: number;
}

export interface TranscriptAttachment {
  mime?: string;
  filename?: string;
  url: string;
}

export type NonRenderableTranscriptPart =
  | ({ type: "step-start" } & BaseTranscriptPart)
  | ({ type: "step-finish" } & BaseTranscriptPart)
  | ({ type: "snapshot" } & BaseTranscriptPart)
  | ({ type: "patch" } & BaseTranscriptPart)
  | ({ type: "compaction" } & BaseTranscriptPart)
  | ({ type: "retry" } & BaseTranscriptPart)
  | ({ type: "subtask" } & BaseTranscriptPart)
  | ({ type: "agent" } & BaseTranscriptPart);

export type InteractionRequest = PermissionInteractionRequest | QuestionInteractionRequest;

export interface PermissionInteractionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
}

export interface QuestionInteractionRequest {
  id: string;
  sessionID: string;
  questions: QuestionPrompt[];
  tool?: {
    messageID: string;
    callID: string;
  };
}

export interface QuestionPrompt {
  question: string;
  header: string;
  options: QuestionPromptOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionPromptOption {
  label: string;
  description?: string;
}

export type QuestionInteractionAnswer = string[];
