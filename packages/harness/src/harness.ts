import type { ModelTransport } from "./models/transport.ts";
import type { ExecutionPolicyResolver } from "./execution-policy.ts";
import type { AgentToolSource } from "./tools/agent-tools.ts";

export const SESSION_ENTRY_KINDS = [
  "session_created",
  "session_renamed",
  "model_changed",
  "reasoning_changed",
  "run_started",
  "user_message",
  "assistant_reasoning",
  "assistant_message",
  "provider_response",
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

/** Role-free identity captured when durable user intent is accepted by the Host. */
export interface DurableActor {
  type: "user" | "api_key" | "local";
  id: string;
  displayName: string;
}

export interface PromptInput {
  text: string;
  actor?: DurableActor;
  /**
   * Session skill allowlist for this turn.
   * `undefined` keeps the default auto catalog; an array (including empty)
   * is the exact set of skill names exposed to the model.
   */
  skills?: string[];
  /** Host-owned immutable content snapshots selected on the first turn. */
  skillPins?: Array<{ name: string; revision: string; directory: string }>;
}

export type SessionEvent =
  | { type: "assistant_delta"; runId: string; delta: string }
  | { type: "reasoning_delta"; runId: string; delta: string }
  | { type: "entry_appended"; entry: SessionEntry };

export interface HarnessSession {
  read(): Promise<SessionSnapshot>;
  run(prompt: PromptInput): AsyncIterable<SessionEvent>;
  /** Create a handoff checkpoint and stop. The next user turn resumes from it. */
  compact(actor?: DurableActor): AsyncIterable<SessionEvent>;
  followUp(prompt: PromptInput): Promise<FollowUp>;
  updateFollowUp(followUpId: string, prompt: PromptInput): Promise<void>;
  reorderFollowUp(followUpId: string, index: number): Promise<void>;
  removeFollowUp(followUpId: string): Promise<void>;
  abort(): Promise<void>;
  setModel(selection: ModelSelection): Promise<void>;
  setReasoning(reasoning: ReasoningLevel): Promise<void>;
  rename(title: string): Promise<void>;
  delete(): Promise<void>;
}

export interface OpenGuiHarness {
  listSessions(projectDirectory: string): Promise<SessionSummary[]>;
  searchSessionMessages(projectDirectories: readonly string[], query: string): Promise<string[]>;
  listAllSessions(): Promise<SessionSummary[]>;
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
  /** Stable, non-secret Host installation identity used only for transport/cache namespacing. */
  hostId?: string;
  model: ModelTransport;
  /** Additional Host-owned tools resolved and authorized for each model turn. */
  agentTools?: AgentToolSource;
  shell?: { executable?: string };
  /** In-band context handoff. The current model writes a checkpoint before context is reset. */
  compaction?: {
    enabled?: boolean;
    contextWindowTokens?: number;
    thresholdRatio?: number;
    /** Root for opengui/handoffs. Defaults to the current user's OS temp directory. */
    tempDirectory?: string;
  };
  /** Home directory used for `~/.agents/skills` discovery. Defaults to os.homedir(). */
  homeDirectory?: string;
  clock?: Clock;
  ids?: IdGenerator;
  /** Resolve current Host-owned execution capabilities for each durable actor. */
  resolveExecutionPolicy?: ExecutionPolicyResolver;
}
