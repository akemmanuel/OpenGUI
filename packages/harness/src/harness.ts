import type { ModelTransport } from "./models/transport.ts";

export const SESSION_ENTRY_KINDS = [
  "session_created",
  "session_renamed",
  "model_changed",
  "reasoning_changed",
  "run_started",
  "user_message",
  "assistant_reasoning",
  "assistant_message",
  "tool_call",
  "tool_result",
  "compaction",
  "run_completed",
  "run_failed",
  "run_aborted",
  "run_interrupted",
] as const;

export type SessionEntryKind = (typeof SESSION_ENTRY_KINDS)[number];

export interface ModelSelection {
  connectionId: string;
  modelId: string;
}

export type ReasoningLevel =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface SessionEntry {
  id: string;
  sessionId: string;
  sequence: number;
  kind: SessionEntryKind;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type SessionStatus = "idle" | "running" | "failed" | "interrupted" | "stopped";

export interface SessionSummary {
  id: string;
  projectDirectory: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
}

export interface SessionSnapshot extends SessionSummary {
  model: ModelSelection | null;
  reasoning: ReasoningLevel | null;
  entries: SessionEntry[];
  followUps: FollowUp[];
}

export interface FollowUp {
  id: string;
  sequence: number;
  prompt: PromptInput;
  createdAt: string;
}

export interface CreateSessionInput {
  projectDirectory: string;
  title?: string;
  model: ModelSelection;
  reasoning: ReasoningLevel;
}

export interface PromptInput {
  text: string;
}

export type SessionEvent =
  | { type: "assistant_delta"; runId: string; delta: string }
  | { type: "reasoning_delta"; runId: string; delta: string }
  | { type: "entry_appended"; entry: SessionEntry };

export interface HarnessSession {
  read(): Promise<SessionSnapshot>;
  run(prompt: PromptInput): AsyncIterable<SessionEvent>;
  followUp(prompt: PromptInput): Promise<void>;
  abort(): Promise<void>;
  setModel(selection: ModelSelection): Promise<void>;
  setReasoning(reasoning: ReasoningLevel): Promise<void>;
  rename(title: string): Promise<void>;
  delete(): Promise<void>;
}

export interface OpenGuiHarness {
  listSessions(projectDirectory: string): Promise<SessionSummary[]>;
  createSession(input: CreateSessionInput): Promise<HarnessSession>;
  openSession(sessionId: string): Promise<HarnessSession>;
  close(): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: "session" | "entry" | "run" | "follow_up"): string;
}

export interface OpenGuiHarnessOptions {
  dataDirectory: string;
  model: ModelTransport;
  shell?: { executable?: string };
  /** Home directory used for `~/.agents/skills` discovery. Defaults to os.homedir(). */
  homeDirectory?: string;
  clock?: Clock;
  ids?: IdGenerator;
}
