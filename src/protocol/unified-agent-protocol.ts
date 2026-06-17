// Experimental draft: one tiny unified protocol shape for OpenGUI <-> agents.
// Intentionally rudimentary: only types, no implementation, no transport assumptions.

export type AgentId = "opencode" | "claude-code" | "pi" | "codex" | "grok-build" | (string & {});

export type RequestId = string;
export type EventId = string;
export type SessionId = string;
export type MessageId = string;
export type PartId = string;
export type TurnId = string;
export type Cwd = string;

export interface AgentTarget {
  agent?: AgentId;
}

export interface AgentRequest<TParams = unknown> {
  id: RequestId;
  method: AgentMethod;
  target?: AgentTarget;
  params?: TParams;
}

export type AgentResponse<TResult = unknown> =
  | {
      id: RequestId;
      ok: true;
      result: TResult;
    }
  | {
      id: RequestId;
      ok: false;
      error: AgentError;
    };

export interface AgentError {
  code:
    | "UNKNOWN"
    | "UNSUPPORTED_METHOD"
    | "INVALID_REQUEST"
    | "AUTH_REQUIRED"
    | "PERMISSION_DENIED"
    | "NOT_FOUND"
    | "ABORTED"
    | "AGENT_UNAVAILABLE";
  message: string;
  recoverable?: boolean;
  details?: unknown;
}

export type AgentMethod =
  | "agent.info"
  | "agent.capabilities"
  | "session.list"
  | "session.start"
  | "session.stop"
  | "session.delete"
  | "session.rename"
  | "session.messages"
  | "session.turn.send"
  | "session.turn.interrupt"
  | "session.compact"
  | "session.fork"
  | "session.revert"
  | "permission.respond"
  | "question.reply"
  | "question.reject"
  | "model.list"
  | "command.list"
  | "file.find";

export interface AgentEvent<TPayload = unknown> {
  id: EventId;
  type: AgentEventType;
  time: string;
  target?: AgentTarget;
  sessionId?: SessionId;
  turnId?: TurnId;
  payload: TPayload;
}

export type AgentEventType =
  | "session.started"
  | "session.updated"
  | "session.stopped"
  | "session.deleted"
  | "session.status"
  | "turn.started"
  | "turn.completed"
  | "turn.interrupted"
  | "message.updated"
  | "message.part.updated"
  | "message.part.delta"
  | "message.part.removed"
  | "message.removed"
  | "permission.requested"
  | "permission.cleared"
  | "question.requested"
  | "question.cleared"
  | "error";

export interface AgentInfo {
  id: AgentId;
  name: string;
  version?: string;
}

export interface AgentCapabilities {
  sessions?: boolean;
  streaming?: boolean;
  messages?: boolean;
  models?: boolean;
  commands?: boolean;
  permissions?: boolean;
  questions?: boolean;
  files?: boolean;
  sessionModelSwitch?: "in-session" | "restart-required" | "unsupported";
}

export interface SessionRef {
  id: SessionId;
  agent: AgentId;
  cwd?: Cwd;
  title?: string;
  status?: "starting" | "ready" | "running" | "stopped" | "error";
  model?: string;
  activeTurnId?: TurnId;
  createdAt?: string;
  updatedAt?: string;
}

export interface MessageRef {
  id: MessageId;
  sessionId: SessionId;
  turnId?: TurnId;
  role?: "user" | "assistant" | "system" | "tool";
  parts?: MessagePart[];
}

export type MessagePart =
  | { id: PartId; type: "text"; text: string }
  | { id: PartId; type: "tool"; name: string; input?: unknown; output?: unknown }
  | { id: PartId; type: string; data?: unknown };

export interface SessionListParams {
  cwd?: Cwd;
}

export interface SessionListResult {
  sessions: SessionRef[];
}

export interface SessionStartParams {
  sessionId?: SessionId;
  cwd?: Cwd;
  title?: string;
  model?: string;
  agent?: string;
  variant?: string;
  resume?: unknown;
}

export interface SessionStartResult {
  session: SessionRef;
}

export interface SessionTurnSendParams {
  sessionId: SessionId;
  text: string;
  model?: string;
  agent?: string;
  variant?: string;
}

export interface SessionTurnSendResult {
  sessionId: SessionId;
  turnId: TurnId;
  resume?: unknown;
}

export interface FileFindParams {
  cwd: Cwd;
  query: string;
  limit?: number;
}

export interface FileFindResult {
  files: string[];
}

export interface MessagePartDeltaPayload {
  messageId: MessageId;
  partId: PartId;
  field: string;
  delta: string;
}
