import type { Session } from "@opencode-ai/sdk/v2/client";
import type { ClaudeCodeBridge, NativeBackendEvent } from "@/types/electron";
import type {
  AgentBackendCapabilities,
  AgentBackendDescriptor,
  AgentBackendEvent,
} from "./backend";
import {
  createBackendIdCodec,
  getTarget,
  normalizeBackendEventPayload,
  normalizeMessageSessionId,
  normalizePartSessionId,
  requireSuccess,
  tagBackendSession,
  type TaggedSession,
} from "./shared";

export interface ClaudeCodeBackendAdapter extends ClaudeCodeBridge, AgentBackendDescriptor {
  native: ClaudeCodeBridge;
}

const CLAUDE_CODE_CAPABILITIES: AgentBackendCapabilities = {
  sessions: true,
  streaming: true,
  messagePaging: true,
  images: false,
  models: true,
  agents: false,
  commands: true,
  compact: true,
  fork: true,
  revert: false,
  permissions: true,
  questions: false,
  providerAuth: false,
  mcp: false,
  skills: false,
  config: false,
  localServer: false,
};

const CLAUDE_CODE_WORKSPACE = {
  kind: "local-cli",
  fields: {
    serverUrl: false,
    username: false,
    password: false,
    directory: true,
  },
} as const;

const { compose: toCompositeSessionId, decompose: toRawSessionId } =
  createBackendIdCodec("claude-code");

function tagClaudeSession(
  session: TaggedSession,
  target?: { directory?: string; workspaceId?: string },
): TaggedSession {
  return tagBackendSession("claude-code", session, target);
}

function normalizeClaudeCodeEvent(event: NativeBackendEvent): AgentBackendEvent | null {
  if (event.type === "connection:status") {
    return {
      type: "connection.status",
      directory: event.directory,
      workspaceId: event.workspaceId,
      status: event.payload,
    };
  }
  if (event.type !== "claude-code:event") return null;
  const payload = (event.payload ?? null) as AgentBackendEvent | null;
  if (!payload) return null;
  switch (payload.type) {
    case "session.created":
      return {
        ...payload,
        session: tagClaudeSession(payload.session, {
          directory: payload.directory,
          workspaceId: payload.workspaceId,
        }),
      };
    case "session.replaced":
      return {
        ...payload,
        oldId: toCompositeSessionId(payload.oldId),
        newId: toCompositeSessionId(payload.newId),
        session: tagClaudeSession(payload.session, {
          directory: payload.directory,
          workspaceId: payload.workspaceId,
        }),
      };
    case "session.updated":
      return {
        ...payload,
        session: tagClaudeSession(payload.session, {
          directory: payload.directory,
          workspaceId: payload.workspaceId,
        }),
      };
    case "session.deleted":
      return { ...payload, sessionId: toCompositeSessionId(payload.sessionId) };
    default:
      return normalizeBackendEventPayload("claude-code", payload);
  }
}

export function createClaudeCodeBackend(
  bridge?: ClaudeCodeBridge,
): ClaudeCodeBackendAdapter | undefined {
  if (!bridge) return undefined;

  return {
    ...bridge,
    id: "claude-code",
    label: "Claude Code",
    workspace: CLAUDE_CODE_WORKSPACE,
    capabilities: CLAUDE_CODE_CAPABILITIES,
    native: bridge,
    host: {
      addProject: async (config) => {
        requireSuccess(await bridge.addProject(config), "Failed to add project");
      },
      removeProject: async (target) => {
        requireSuccess(
          await bridge.removeProject(target.directory ?? "", target.workspaceId),
          "Failed to remove project",
        );
      },
      disconnect: async () => {
        requireSuccess(await bridge.disconnect(), "Failed to disconnect");
      },
    },
    runtime: {
      listSessions: async (target) => {
        const { directory, workspaceId } = getTarget(target);
        const sessions = requireSuccess<Session[]>(
          await bridge.listSessions(directory, workspaceId),
          "Failed to list sessions",
        );
        return sessions.map((session) =>
          tagClaudeSession(session, {
            directory: directory ?? session.directory,
            workspaceId,
          }),
        );
      },
      createSession: async () => {
        throw new Error("Claude Code sessions start with first prompt");
      },
      startSession: async (input) => {
        const session = requireSuccess(await bridge.startSession(input), "Failed to start session");
        return tagClaudeSession(session, {
          directory: input.directory ?? session.directory,
          workspaceId: input.workspaceId,
        });
      },
      deleteSession: async (sessionId) => {
        const target = getTarget();
        return requireSuccess(
          await bridge.deleteSession(
            toRawSessionId(sessionId),
            target.directory,
            target.workspaceId,
          ),
          "Failed to delete session",
        );
      },
      renameSession: async (sessionId, title) => {
        const target = getTarget();
        const session = requireSuccess(
          await bridge.updateSession(
            toRawSessionId(sessionId),
            title,
            target.directory,
            target.workspaceId,
          ),
          "Failed to rename session",
        );
        return tagClaudeSession(session, target);
      },
      listSessionStatuses: async (target) => {
        const { directory, workspaceId } = getTarget(target);
        const statuses = requireSuccess(
          await bridge.getSessionStatuses(directory, workspaceId),
          "Failed to list session statuses",
        );
        return Object.fromEntries(
          Object.entries(statuses).map(([sessionId, status]) => [
            toCompositeSessionId(sessionId),
            status,
          ]),
        );
      },
      getMessages: async (sessionId, options) => {
        const { directory, workspaceId } = getTarget(options);
        const page = requireSuccess(
          await bridge.getMessages(toRawSessionId(sessionId), options, directory, workspaceId),
          "Failed to get messages",
        );
        return {
          ...page,
          messages: page.messages.map((entry) => ({
            info: normalizeMessageSessionId("claude-code", entry.info),
            parts: entry.parts.map((part) => normalizePartSessionId("claude-code", part)),
          })),
        };
      },
      prompt: async ({ sessionId, text, images, model, agent, variant }) => {
        requireSuccess(
          await bridge.prompt(toRawSessionId(sessionId), text, images, model, agent, variant),
          "Failed to send prompt",
        );
      },
      abort: async (sessionId) => {
        requireSuccess(await bridge.abort(toRawSessionId(sessionId)), "Failed to abort session");
      },
      compactSession: async (sessionId, model) => {
        requireSuccess(
          await bridge.summarizeSession(toRawSessionId(sessionId), model),
          "Failed to compact session",
        );
      },
      forkSession: async (sessionId, messageID) => {
        const session = requireSuccess(
          await bridge.forkSession(toRawSessionId(sessionId), messageID),
          "Failed to fork session",
        );
        return tagClaudeSession(session);
      },
      revertSession: async () => {
        throw new Error("Claude Code backend does not support session revert");
      },
      unrevertSession: async () => {
        throw new Error("Claude Code backend does not support session revert");
      },
      listProviders: async (target) => {
        const { directory, workspaceId } = getTarget(target);
        return requireSuccess(
          await bridge.getProviders(directory, workspaceId),
          "Failed to list providers",
        );
      },
      listAgents: async (target) => {
        const { directory, workspaceId } = getTarget(target);
        return requireSuccess(
          await bridge.getAgents(directory, workspaceId),
          "Failed to list agents",
        );
      },
      listCommands: async (target) => {
        const { directory, workspaceId } = getTarget(target);
        return requireSuccess(
          await bridge.getCommands(directory, workspaceId),
          "Failed to list commands",
        );
      },
      sendCommand: async ({ sessionId, command, args, model, agent, variant }) => {
        requireSuccess(
          await bridge.sendCommand(toRawSessionId(sessionId), command, args, model, agent, variant),
          "Failed to send command",
        );
      },
      respondPermission: async (sessionId, permissionId, response) => {
        requireSuccess(
          await bridge.respondPermission(toRawSessionId(sessionId), permissionId, response),
          "Failed to respond to permission request",
        );
      },
      replyQuestion: async () => {
        throw new Error("Claude Code backend does not support interactive questions");
      },
      rejectQuestion: async () => {
        throw new Error("Claude Code backend does not support interactive questions");
      },
      findFiles: async (target, query) => {
        return requireSuccess(
          await bridge.findFiles(target.directory ?? null, target.workspaceId, query),
          "Failed to find files",
        );
      },
      subscribe: (listener) =>
        bridge.onEvent((event) => {
          const normalized = normalizeClaudeCodeEvent(event);
          if (normalized) listener(normalized);
        }),
    },
  };
}
