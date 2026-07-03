export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk"
  | "auto";
export type SettingSource = "user" | "project" | "local";

export type SystemPrompt =
  | string
  | { type: "preset"; preset: "claude_code"; append?: string }
  | { type: "file"; path: string };

export interface ClaudeAgentOptions {
  cliPath?: string;
  pathToClaudeCodeExecutable?: string;
  cwd?: string;
  env?: Record<string, string>;
  entrypoint?: string;
  systemPrompt?: SystemPrompt | null;
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  model?: string;
  permissionPromptToolName?: string;
  permissionMode?: PermissionMode;
  continueConversation?: boolean;
  resume?: string;
  sessionId?: string;
  settings?: string;
  addDirs?: string[];
  mcpServers?: string | Record<string, unknown>;
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  strictMcpConfig?: boolean;
  settingSources?: SettingSource[];
  extraArgs?: Record<string, string | number | boolean | null | undefined>;
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    context: ToolPermissionContext,
  ) => Promise<PermissionResult> | PermissionResult;
  hooks?: Record<string, Array<{ matcher?: string; hooks?: HookCallback[]; timeout?: number }>>;
  enableFileCheckpointing?: boolean;
  title?: string;
  thinking?: Record<string, unknown>;
  maxThinkingTokens?: number;
  stderr?: (chunk: string) => void;
}

export type PermissionUpdate = Record<string, unknown>;
export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
    }
  | { behavior: "deny"; message?: string; interrupt?: boolean };
export interface ToolPermissionContext {
  signal?: AbortSignal | null;
  suggestions?: PermissionUpdate[];
  toolUseID?: string;
  tool_use_id?: string;
  agentID?: string;
  agent_id?: string;
  blockedPath?: string;
  blocked_path?: string;
  decisionReason?: string;
  decision_reason?: string;
  title?: string;
  displayName?: string;
  display_name?: string;
  description?: string;
}
export type HookCallback = (
  input: unknown,
  toolUseID?: string,
  context?: { signal?: AbortSignal | null },
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type SDKUserMessage = {
  type: "user";
  session_id?: string;
  message: { role: "user"; content: string | unknown[] };
  parent_tool_use_id?: string | null;
};

export type Message = Record<string, unknown> & { type?: string };

export interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  write(message: unknown): Promise<void>;
  writeRaw?(data: string): Promise<void>;
  endInput?(): Promise<void>;
  read(): AsyncIterable<Message>;
  interrupt?(): Promise<void>;
}
