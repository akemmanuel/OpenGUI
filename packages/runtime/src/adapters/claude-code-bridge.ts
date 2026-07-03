/**
 * ESM bridge module loaded by main.ts via dynamic import().
 * Hosts Claude Code Agent SDK project/session state and wires IPC handlers.
 */

import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { access, readFile, readdir } from "node:fs/promises";
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
} from "../../../../BetterSDK/dist/index.js";
import {
  makeHarnessProjectKey as makeProjectKey,
  makeHarnessSessionIdCodec,
  normalizeHarnessDirectory as normalizeDir,
  nowHarnessConnection as nowConnection,
} from "./harness-adapter-kit.ts";
import {
  makeHarnessBridgeEventEmitter,
  registerHarnessRpcHandlers,
} from "./harness-adapter-host.ts";
import {
  buildProvidersFromSupportedModels,
  buildVariantQueryOptions,
  deriveModelFamily,
  deriveModelName,
  FALLBACK_SUPPORTED_MODELS,
  MODEL_DISCOVERY_TTL_MS,
} from "./claude-code-models.ts";
import {
  coerceHarnessString,
  makeReasoningPart,
  makeSessionFromInfo,
  makeSessionTitle,
  makeTextPart,
  mapClaudeModelId,
  normalizeToolInput,
  tagMessageEntrySession,
} from "./claude-code-bridge-mapping.ts";
import {
  contentToTextSegmentsFromBlocks as contentToTextSegments,
  getMessageBlocksFromEntry as getMessageBlocks,
  getToolResultBlocksFromMessage as getToolResultBlocks,
  mapAssistantContentForLive as mapAssistantContent,
  mapHistoryEntries,
  mapUserHistoryMessageFromEntry as mapUserHistoryMessage,
  type ClaudeHistoryEntry,
  mergeToolResultIntoPart,
  makeSyntheticUserMessage,
} from "./claude-code-bridge-history.ts";
import type {
  ClaudeActiveQueryEntry,
  ClaudeAgentOptions,
  ClaudeGetMessagesOptions,
  ClaudeMessageBundle,
  ClaudeMessagePart,
  ClaudePendingTempState,
  ClaudePlaceholderSession,
  ClaudeProjectSlot,
  ClaudeProjectTarget,
  ClaudeProviderCatalog,
  ClaudeSessionModelSelection,
  MakeClaudeQueryOptionsInput,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  StartQueryParams,
  ToolPermissionContext,
} from "./claude-code-bridge-types.ts";
import type { ClaudeSupportedModel } from "./claude-code-models.ts";
import type { SDKQuery } from "../../../../BetterSDK/dist/index.js";

// t3code-style Claude integration: use the user-installed Claude Code CLI.
// The Claude Agent SDK is only the JS transport layer; the native `claude`
// executable is managed outside OpenGUI (`claude update`, package manager,
// or CLAUDE_CODE_EXECUTABLE override). This avoids bundling optional SDK
// platform binaries and avoids pnpm/Electron packaging resolution traps.
const CLAUDE_EXECUTABLE_PATH = process.env.CLAUDE_CODE_EXECUTABLE?.trim() || "claude";

const CLAUDE_CODE_SESSION_PREFIX = "claude-code:";
const { toFrontendSessionId, toRawSessionId } = makeHarnessSessionIdCodec(
  CLAUDE_CODE_SESSION_PREFIX,
);

const BUILTIN_COMMANDS: ClaudeCommandRow[] = [
  {
    name: "compact",
    description: "Compact older session context",
    source: "command",
    template: "/compact",
    hints: [],
  },
  {
    name: "clear",
    description: "Clear current conversation state",
    source: "command",
    template: "/clear",
    hints: [],
  },
  {
    name: "help",
    description: "Show available slash commands",
    source: "command",
    template: "/help",
    hints: [],
  },
];

function makeClaudeEnv() {
  return {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: "OpenGUI",
  };
}

function makeClaudeQueryOptions(input: MakeClaudeQueryOptionsInput = {}): ClaudeAgentOptions {
  const {
    cwd,
    model,
    permissionMode = "default",
    includePartialMessages = true,
    canUseTool,
    variant,
    modelInfo,
    resume,
    probe = false,
    title,
  } = input;
  return {
    cwd,
    resume,
    model,
    title,
    pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE_PATH,
    includePartialMessages,
    settingSources: ["user", "project", "local"],
    permissionMode: permissionMode as PermissionMode,
    env: makeClaudeEnv(),
    ...(probe
      ? {}
      : {
          tools: { type: "preset", preset: "claude_code" },
          disallowedTools: ["AskUserQuestion"],
        }),
    ...(canUseTool ? { canUseTool } : {}),
    ...buildVariantQueryOptions(variant, modelInfo),
  };
}

async function* holdOpenPrompt() {
  yield* [];
  await new Promise(() => {});
}

function getSessionDirectory(
  info: { cwd?: string } | null | undefined,
  target: ClaudeProjectTarget = {},
) {
  return normalizeDir(info?.cwd || target.directory || process.cwd());
}

function claudeSessionModelFromSelection(
  model: { modelID?: string } | null | undefined,
  variant: string | undefined,
): ClaudeSessionModelSelection {
  const modelId = mapClaudeModelId(model?.modelID);
  return {
    providerID: "anthropic",
    id: modelId,
    ...(typeof variant === "string" && variant ? { variant } : {}),
  };
}

function deriveClaudeSessionModel(
  history:
    | Array<{ type?: string; message?: { model?: string; modelId?: string } }>
    | null
    | undefined,
): ClaudeSessionModelSelection | null {
  let modelId: string | null = null;
  for (const entry of history ?? []) {
    if (entry?.type !== "assistant") continue;
    const rawModel = entry?.message?.model ?? entry?.message?.modelId;
    const mapped = mapClaudeModelId(rawModel);
    if (mapped) modelId = mapped;
  }
  if (!modelId) return null;
  return { providerID: "anthropic", id: modelId };
}

function defaultAssistantInfo(
  sessionId: string,
  messageId: string,
  directory: string,
  modelId = "default",
) {
  return {
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: modelId,
    providerID: "anthropic",
    mode: "claude-code",
    agent: "claude",
    path: {
      cwd: directory,
      root: directory,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readCommandDescription(path: string) {
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw.split(/\r?\n/);
    let inFrontmatter = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "---") {
        inFrontmatter = !inFrontmatter;
        continue;
      }
      if (inFrontmatter) continue;
      return trimmed.replace(/^#+\s*/, "").slice(0, 120);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

type ClaudeCommandRow = {
  name: string;
  description?: string;
  source: string;
  template: string;
  hints: string[];
};

async function scanCommandDirectory(baseDir: string): Promise<ClaudeCommandRow[]> {
  const results: ClaudeCommandRow[] = [];
  if (!baseDir || !(await pathExists(baseDir))) return results;
  const entries = await readdir(baseDir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (extname(entry.name).toLowerCase() !== ".md") continue;
    const fullPath = join(entry.parentPath, entry.name);
    const relativeName = basename(entry.name, extname(entry.name)).trim();
    if (!relativeName) continue;
    results.push({
      name: relativeName,
      description: await readCommandDescription(fullPath),
      source: "command",
      template: `/${relativeName} $ARGUMENTS`,
      hints: [],
    });
  }
  return results;
}

async function listClaudeCommands(directory: string) {
  const commands = [...BUILTIN_COMMANDS];
  const localCommands = await scanCommandDirectory(
    join(normalizeDir(directory), ".claude", "commands"),
  );
  const globalCommands = await scanCommandDirectory(join(homedir(), ".claude", "commands"));
  const seen = new Set(commands.map((item) => item.name));
  for (const command of [...localCommands, ...globalCommands]) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    commands.push(command);
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function sanitizePermissionUpdates(suggestions: unknown): PermissionUpdate[] {
  if (!Array.isArray(suggestions)) return [];
  const validDestinations = new Set([
    "userSettings",
    "projectSettings",
    "localSettings",
    "session",
    "cliArg",
  ]);
  const validBehaviors = new Set(["allow", "deny", "ask"]);
  const validModes = new Set([
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
    "auto",
  ]);
  return suggestions.flatMap((item): PermissionUpdate[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const destination = row.destination;
    if (typeof destination !== "string" || !validDestinations.has(destination)) return [];
    if (row.type === "setMode") {
      const mode = row.mode;
      if (typeof mode !== "string" || !validModes.has(mode)) return [];
      return [{ type: "setMode", mode, destination }];
    }
    if (row.type === "addDirectories" || row.type === "removeDirectories") {
      const directories = Array.isArray(row.directories)
        ? row.directories.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          )
        : [];
      if (directories.length === 0) return [];
      return [{ type: row.type, directories, destination }];
    }
    if (row.type === "addRules" || row.type === "replaceRules" || row.type === "removeRules") {
      const behavior = row.behavior;
      if (typeof behavior !== "string" || !validBehaviors.has(behavior)) return [];
      const rules = Array.isArray(row.rules)
        ? row.rules
            .filter((rule): rule is { toolName: string; ruleContent?: string } =>
              Boolean(
                rule &&
                typeof rule === "object" &&
                typeof (rule as { toolName?: string }).toolName === "string",
              ),
            )
            .map((rule) => ({
              toolName: rule.toolName,
              ...(typeof rule.ruleContent === "string" ? { ruleContent: rule.ruleContent } : {}),
            }))
        : [];
      if (rules.length === 0) return [];
      return [
        {
          type: row.type,
          rules,
          behavior,
          destination,
        },
      ];
    }
    return [];
  });
}

class ClaudeCodeBridgeManager {
  emit: (event: Record<string, unknown>) => void;
  projects: Map<string, ClaudeProjectSlot>;
  activeQueries: Map<string, ClaudeActiveQueryEntry>;
  providerCatalogs: Map<string, ClaudeProviderCatalog>;
  providerCatalogPromises: Map<string, Promise<ClaudeProviderCatalog>>;
  pendingTempSessions: Map<string, ClaudePendingTempState>;
  placeholderSessions: Map<string, ClaudePlaceholderSession>;
  replacementAliases: Map<string, string>;
  messageCache: Map<string, Map<string, ClaudeMessageBundle>>;

  constructor(emit: (event: Record<string, unknown>) => void) {
    this.emit = emit;
    this.projects = new Map();
    this.activeQueries = new Map();
    this.providerCatalogs = new Map();
    this.providerCatalogPromises = new Map();
    // Maps tempSessionId → pending state for new sessions resolved before system/init
    this.pendingTempSessions = new Map();
    // Claude Code does not have a native "empty session" primitive. The app
    // still asks every harness to create a session before the first prompt, so
    // keep a local placeholder and turn it into a real Claude session when the
    // first prompt arrives.
    this.placeholderSessions = new Map();
    this.replacementAliases = new Map();
    this.messageCache = new Map();
  }

  cacheMessage(sessionId: string, entry: ClaudeMessageBundle) {
    if (!sessionId || !entry?.info?.id) return;
    const rawId = toRawSessionId(sessionId);
    const cache = this.messageCache.get(rawId) ?? new Map<string, ClaudeMessageBundle>();
    cache.set(entry.info.id, tagMessageEntrySession(entry));
    this.messageCache.set(rawId, cache);
  }

  cleanupPendingTempSession(tempSessionId: string) {
    if (!tempSessionId) return;
    const rawId = toRawSessionId(tempSessionId);
    this.pendingTempSessions.delete(rawId);
    this.pendingTempSessions.delete(tempSessionId);
    this.activeQueries.delete(rawId);
    this.activeQueries.delete(tempSessionId);
    this.placeholderSessions.delete(rawId);
    this.placeholderSessions.delete(tempSessionId);
  }

  cleanupTargetCaches(directory: string, workspaceId: string | undefined) {
    for (const [tempSessionId, state] of this.pendingTempSessions.entries()) {
      if (state?.target?.directory === directory && state?.target?.workspaceId === workspaceId) {
        this.pendingTempSessions.delete(tempSessionId);
      }
    }
    const key = makeProjectKey(workspaceId, directory);
    this.providerCatalogs.delete(key);
    this.providerCatalogPromises.delete(key);
  }

  emitConnectionStatus(target: ClaudeProjectTarget, status: Record<string, unknown>) {
    this.emit({
      type: "connection:status",
      directory: target.directory,
      workspaceId: target.workspaceId,
      payload: nowConnection(status),
    });
  }

  attachProject(config: ClaudeProjectTarget & { directory: string }) {
    const directory = normalizeDir(config.directory);
    const target = { directory, workspaceId: config.workspaceId };
    const key = makeProjectKey(target.workspaceId, target.directory);
    this.projects.set(key, { ...config, directory });
    this.emitConnectionStatus(target, { state: "connected" });
  }

  removeProject(directory: string, workspaceId: string | undefined) {
    const normalized = normalizeDir(directory);
    const key = makeProjectKey(workspaceId, normalized);
    this.projects.delete(key);
    for (const [sessionId, entry] of this.activeQueries.entries()) {
      if (entry.directory !== normalized || entry.workspaceId !== workspaceId) continue;
      void entry.query?.close?.();
      this.activeQueries.delete(sessionId);
    }
    this.cleanupTargetCaches(normalized, workspaceId);
    this.emitConnectionStatus(
      { directory: normalized, workspaceId },
      { state: "idle", error: null },
    );
  }

  disconnect() {
    for (const entry of this.activeQueries.values()) {
      void entry.query?.close?.();
    }
    this.activeQueries.clear();
    this.pendingTempSessions.clear();
    this.placeholderSessions.clear();
    this.providerCatalogs.clear();
    this.providerCatalogPromises.clear();
    for (const project of this.projects.values()) {
      this.emitConnectionStatus(
        { directory: project.directory, workspaceId: project.workspaceId },
        { state: "idle", error: null },
      );
    }
    this.projects.clear();
  }

  resolveTarget(directory: string | undefined, workspaceId: string | undefined, sessionId: string) {
    sessionId = toRawSessionId(sessionId);
    const normalized = normalizeDir(directory);
    if (normalized) return { directory: normalized, workspaceId };
    const active = sessionId ? this.activeQueries.get(sessionId) : null;
    if (active) {
      return { directory: active.directory, workspaceId: active.workspaceId };
    }
    const pending = sessionId ? this.pendingTempSessions.get(sessionId) : null;
    if (pending?.target) {
      return pending.target;
    }
    const placeholder = sessionId ? this.placeholderSessions.get(sessionId) : null;
    if (placeholder?.target) {
      return placeholder.target;
    }
    if (this.projects.size !== 1) {
      throw new Error("Claude Code operation requires a Project directory");
    }
    const first = this.projects.values().next().value;
    return {
      directory: normalizeDir(first?.directory || process.cwd()),
      workspaceId: workspaceId ?? first?.workspaceId,
    };
  }

  getCachedProviderCatalog(
    directory: string | undefined,
    workspaceId: string | undefined,
    sessionId: string,
  ) {
    const target = this.resolveTarget(directory, workspaceId, sessionId);
    const key = makeProjectKey(target.workspaceId, target.directory);
    const cached = this.providerCatalogs.get(key);
    if (!cached) return null;
    if (Date.now() - cached.loadedAt > MODEL_DISCOVERY_TTL_MS) return null;
    return cached;
  }

  async discoverProviders(
    directory: string | undefined,
    workspaceId: string | undefined,
    sessionId: string,
  ) {
    const target = this.resolveTarget(directory, workspaceId, sessionId);
    const key = makeProjectKey(target.workspaceId, target.directory);
    const cached = this.getCachedProviderCatalog(directory, workspaceId, sessionId);
    if (cached) return cached;
    const inflight = this.providerCatalogPromises.get(key);
    if (inflight) return await inflight;

    const load = (async () => {
      try {
        const probe = query({
          prompt: holdOpenPrompt(),
          options: makeClaudeQueryOptions({
            cwd: target.directory,
            model: "haiku",
            permissionMode: "acceptEdits",
            probe: true,
          }),
        });
        try {
          const supportedModels = await probe.supportedModels();
          const effectiveModels: ClaudeSupportedModel[] =
            Array.isArray(supportedModels) && supportedModels.length > 0
              ? (supportedModels as ClaudeSupportedModel[])
              : FALLBACK_SUPPORTED_MODELS;
          const catalog = {
            loadedAt: Date.now(),
            target,
            supportedModels: effectiveModels,
            providers: buildProvidersFromSupportedModels(effectiveModels),
          };
          this.providerCatalogs.set(key, catalog);
          return catalog;
        } finally {
          void probe.close();
        }
      } catch {
        const catalog = {
          loadedAt: Date.now(),
          target,
          supportedModels: FALLBACK_SUPPORTED_MODELS,
          providers: buildProvidersFromSupportedModels(FALLBACK_SUPPORTED_MODELS),
        };
        this.providerCatalogs.set(key, catalog);
        return catalog;
      } finally {
        this.providerCatalogPromises.delete(key);
      }
    })();

    this.providerCatalogPromises.set(key, load);
    return await load;
  }

  lookupModelInfo(
    modelId: string | undefined,
    directory: string | undefined,
    workspaceId: string | undefined,
    sessionId: string,
  ) {
    if (typeof modelId !== "string" || !modelId.trim()) return null;
    const catalog = this.getCachedProviderCatalog(directory, workspaceId, sessionId);
    if (!catalog) return null;
    const raw = modelId.trim().toLowerCase();
    for (const model of catalog.supportedModels) {
      if (typeof model?.value === "string" && model.value.toLowerCase() === raw) {
        return model;
      }
    }
    for (const model of catalog.supportedModels) {
      const name = deriveModelName(model).toLowerCase();
      const family = deriveModelFamily(model).toLowerCase();
      if (raw === family || raw.includes(family) || (name && raw.includes(name))) {
        return model;
      }
    }
    return null;
  }

  async listSessions(directory: string | undefined, workspaceId: string | undefined) {
    const target = this.resolveTarget(directory, workspaceId, "");
    const sessions = await listSessions({ dir: target.directory, limit: 10_000 });
    const scopedSessions = sessions.filter(
      (info) => getSessionDirectory(info, target) === target.directory,
    );
    return await Promise.all(
      scopedSessions.map(async (info) => {
        const sessionTarget = {
          directory: getSessionDirectory(info, target),
          workspaceId: target.workspaceId,
        };
        let model: ClaudeSessionModelSelection | string | undefined = info?.model as
          | ClaudeSessionModelSelection
          | string
          | undefined;
        if (!model && info?.sessionId) {
          try {
            const derived = deriveClaudeSessionModel(
              await getSessionMessages(info.sessionId, {
                dir: sessionTarget.directory,
                includeSystemMessages: false,
              }),
            );
            model = derived ?? undefined;
          } catch {
            model = undefined;
          }
        }
        return makeSessionFromInfo({ ...info, model }, sessionTarget);
      }),
    );
  }

  async getMessages(
    sessionId: string,
    options: ClaudeGetMessagesOptions | null | undefined,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    sessionId = toRawSessionId(sessionId);
    sessionId = this.replacementAliases.get(sessionId) ?? sessionId;
    const target = this.resolveTarget(directory, workspaceId, sessionId);

    // For pending temp sessions (created before system/init arrives), return
    // just the synthetic user message so the renderer has something to show
    // while the Claude Code subprocess is still initialising.
    const pendingTemp = this.pendingTempSessions.get(sessionId);
    if (pendingTemp) {
      const synthetic = makeSyntheticUserMessage(
        sessionId,
        pendingTemp.syntheticUserId,
        pendingTemp.promptText,
        mapClaudeModelId(pendingTemp.model?.modelID),
      );
      return { messages: [tagMessageEntrySession(synthetic)], nextCursor: null };
    }

    if (this.placeholderSessions.has(sessionId)) {
      return { messages: [], nextCursor: null };
    }

    const cached = [...(this.messageCache.get(sessionId)?.values() ?? [])];
    if (cached.length > 0) {
      return { messages: cached, nextCursor: null };
    }

    const history = await getSessionMessages(sessionId, {
      dir: target.directory,
      includeSystemMessages: false,
    });
    const mapped = mapHistoryEntries(history, target).map(tagMessageEntrySession);
    const limit = Math.max(1, options?.limit ?? 100);
    const before = options?.before ?? null;
    if (mapped.length === 0) return { messages: [], nextCursor: null };
    let endIndex = mapped.length;
    if (before) {
      const foundIndex = mapped.findIndex((entry) => entry.info.id === before);
      endIndex = foundIndex >= 0 ? foundIndex : mapped.length;
    }
    const startIndex = Math.max(0, endIndex - limit);
    const page = mapped.slice(startIndex, endIndex);
    const nextCursor = startIndex > 0 ? (page[0]?.info.id ?? null) : null;
    return { messages: page, nextCursor };
  }

  listSessionStatuses(directory: string | undefined, workspaceId: string | undefined) {
    const target = this.resolveTarget(directory, workspaceId, "");
    const statuses: Record<string, { type: string }> = {};
    for (const [sessionId, entry] of this.activeQueries.entries()) {
      if (entry.directory !== target.directory) continue;
      if ((entry.workspaceId ?? undefined) !== (target.workspaceId ?? undefined)) {
        continue;
      }
      statuses[toFrontendSessionId(sessionId)] = { type: "busy" };
    }
    return statuses;
  }

  async renameSession(
    sessionId: string,
    title: string,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    sessionId = toRawSessionId(sessionId);
    const target = this.resolveTarget(directory, workspaceId, sessionId);
    await renameSession(sessionId, title, { dir: target.directory });
    const info = await getSessionInfo(sessionId, { dir: target.directory });
    return makeSessionFromInfo(
      info ?? { sessionId, summary: title, lastModified: Date.now() },
      target,
      title,
    );
  }

  async deleteSession(
    sessionId: string,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    sessionId = toRawSessionId(sessionId);
    const target = this.resolveTarget(directory, workspaceId, sessionId);
    await deleteSession(sessionId, { dir: target.directory });
    if (this.activeQueries.has(sessionId)) {
      void this.activeQueries.get(sessionId)?.query?.close?.();
      this.activeQueries.delete(sessionId);
    }
    this.cleanupPendingTempSession(sessionId);
    this.emit({
      type: "claude-code:event",
      payload: {
        type: "session.deleted",
        directory: target.directory,
        workspaceId: target.workspaceId,
        sessionId,
      },
    });
    return true;
  }

  async forkSession(
    sessionId: string,
    messageID: string,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    sessionId = toRawSessionId(sessionId);
    const target = this.resolveTarget(directory, workspaceId, sessionId);
    const result = await forkSession(sessionId, {
      dir: target.directory,
      upToMessageId: messageID,
    });
    const info = await getSessionInfo(result.sessionId, { dir: target.directory });
    const session = makeSessionFromInfo(
      info ?? { sessionId: result.sessionId, summary: "Fork", lastModified: Date.now() },
      target,
      "Fork",
    );
    this.emit({
      type: "claude-code:event",
      payload: {
        type: "session.created",
        directory: target.directory,
        workspaceId: target.workspaceId,
        session,
      },
    });
    return session;
  }

  makePermissionHandler(targetRef: () => { sessionId?: string } & ClaudeProjectTarget) {
    return (
      toolName: string,
      input: Record<string, unknown>,
      context: ToolPermissionContext,
    ): Promise<PermissionResult> =>
      new Promise((resolve) => {
        const target = targetRef();
        const sessionId = target.sessionId;
        if (!sessionId) {
          resolve({
            behavior: "allow",
            updatedInput: input,
            toolUseID: context.toolUseID,
          });
          return;
        }
        const requestId = crypto.randomUUID();
        const normalizedInput =
          input && typeof input === "object" && !Array.isArray(input) ? input : {};
        const pending = {
          resolve,
          input: normalizedInput,
          suggestions: sanitizePermissionUpdates(context.suggestions),
          toolUseID: context.toolUseID,
        };
        const entry = this.activeQueries.get(sessionId);
        if (!entry) {
          resolve({
            behavior: "allow",
            updatedInput: normalizedInput,
            toolUseID: context.toolUseID,
          });
          return;
        }
        entry.pendingPermissions.set(requestId, pending);
        this.emit({
          type: "claude-code:event",
          payload: {
            type: "permission.requested",
            request: {
              id: requestId,
              sessionID: sessionId,
              permission: context.title || context.displayName || context.description || toolName,
              patterns: [context.blockedPath].filter(Boolean),
              metadata: {
                toolName,
                input: normalizedInput,
                description: context.description,
                decisionReason: context.decisionReason,
              },
              always: pending.suggestions.flatMap((item) =>
                "rules" in item && Array.isArray(item.rules)
                  ? item.rules
                      .map((rule) => rule.ruleContent)
                      .filter((value): value is string => typeof value === "string")
                  : [],
              ),
            },
          },
        });
      });
  }

  emitSessionStatus(sessionId: string, type: string) {
    sessionId = toRawSessionId(sessionId);
    this.emit({
      type: "claude-code:event",
      payload: {
        type: "session.status",
        sessionID: sessionId,
        status: { type },
      },
    });
  }

  ensureActiveQuery(
    sessionId: string,
    queryHandle: SDKQuery,
    target: ClaudeProjectTarget & { directory: string },
  ) {
    sessionId = toRawSessionId(sessionId);
    let entry = this.activeQueries.get(sessionId);
    if (!entry) {
      entry = {
        query: queryHandle,
        directory: target.directory,
        workspaceId: target.workspaceId,
        pendingPermissions: new Map(),
      };
      this.activeQueries.set(sessionId, entry);
    } else {
      entry.query = queryHandle;
    }
    return entry;
  }

  async refreshSessionInfo(
    sessionId: string,
    target: ClaudeProjectTarget & { directory: string },
    fallbackTitle: string,
  ) {
    sessionId = toRawSessionId(sessionId);
    try {
      const info = await getSessionInfo(sessionId, { dir: target.directory });
      if (!info) return;
      this.emit({
        type: "claude-code:event",
        payload: {
          type: "session.updated",
          directory: target.directory,
          workspaceId: target.workspaceId,
          session: makeSessionFromInfo(
            {
              ...info,
              model:
                info.model ??
                (this.activeQueries.has(sessionId)
                  ? claudeSessionModelFromSelection(
                      this.activeQueries.get(sessionId)?.model,
                      this.activeQueries.get(sessionId)?.variant,
                    )
                  : undefined),
            },
            target,
            fallbackTitle,
          ),
        },
      });
    } catch {
      /* ignore */
    }
  }

  emitSyntheticUserMessage(state: ClaudePendingTempState) {
    if (!state.sessionId || state.syntheticUserEmitted) return;
    const mapped = makeSyntheticUserMessage(
      state.sessionId,
      state.syntheticUserId,
      state.promptText,
      mapClaudeModelId(state.model?.modelID),
    );
    this.cacheMessage(state.sessionId, mapped);
    this.emit({
      type: "claude-code:event",
      payload: { type: "message.updated", message: mapped.info },
    });
    for (const part of mapped.parts) {
      this.emit({
        type: "claude-code:event",
        payload: { type: "message.part.updated", part },
      });
    }
    state.syntheticUserEmitted = true;
  }

  rememberToolPart(state: ClaudePendingTempState, part: ClaudeMessagePart) {
    if (!part || part.type !== "tool") return;
    if (typeof part.callID === "string") state.toolParts.set(part.callID, part);
    const metaId =
      part.state?.metadata && typeof part.state.metadata === "object"
        ? part.state.metadata.id
        : undefined;
    if (typeof metaId === "string") {
      state.toolParts.set(metaId, part);
    }
  }

  updateTrackedToolPart(
    state: ClaudePendingTempState,
    toolUseId: string,
    updater: (current: ClaudeMessagePart) => ClaudeMessagePart,
  ) {
    const current = state.toolParts.get(toolUseId);
    if (!current || current.type !== "tool") return false;
    const nextPart = updater(current);
    state.toolParts.set(toolUseId, nextPart);
    this.rememberToolPart(state, nextPart);
    this.emit({
      type: "claude-code:event",
      payload: { type: "message.part.updated", part: nextPart },
    });
    return true;
  }

  enrichAssistantToolSnapshot(state: ClaudePendingTempState, block: Record<string, unknown>) {
    if (!block || typeof block !== "object" || block.type !== "tool_use" || !block.id) {
      return;
    }
    const blockId = coerceHarnessString(block.id);
    this.updateTrackedToolPart(state, blockId, (current) => ({
      ...current,
      callID: blockId || current.callID,
      tool: typeof block.name === "string" ? block.name : current.tool,
      state: {
        ...current.state,
        input: normalizeToolInput(
          typeof block.name === "string" ? block.name : current.tool || "tool",
          (block.input && typeof block.input === "object" && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : current.state?.input) || {},
        ),
        title: typeof block.name === "string" ? block.name : current.state?.title,
        metadata: {
          ...(current.state?.metadata && typeof current.state.metadata === "object"
            ? current.state.metadata
            : {}),
          id: block.id,
        },
      },
    }));
  }

  applyToolResult(state: ClaudePendingTempState, block: Record<string, unknown>) {
    const toolUseId =
      typeof block.tool_use_id === "string"
        ? block.tool_use_id
        : typeof block.tool_use_id === "number"
          ? String(block.tool_use_id)
          : undefined;
    if (!toolUseId) return false;
    return this.updateTrackedToolPart(state, toolUseId, (current) =>
      mergeToolResultIntoPart(current, block),
    );
  }

  handleQueryMessage(message: Record<string, unknown>, state: ClaudePendingTempState) {
    const rawSession = message.session_id;
    const sessionId =
      typeof rawSession === "string"
        ? rawSession
        : typeof rawSession === "number"
          ? String(rawSession)
          : state.sessionId;
    if (!sessionId) return;

    const prevTempId = state.tempSessionId;

    // If the real sessionId from the subprocess differs from our temp ID we
    // need to rename the session in the renderer before updating state.sessionId.
    if (prevTempId && sessionId !== prevTempId) {
      // Move the activeQueries entry from tempId → realId.
      const entry = this.activeQueries.get(prevTempId);
      if (entry) {
        this.activeQueries.delete(prevTempId);
        this.activeQueries.set(sessionId, entry);
      }
      // Remove the pending-temp tracking now that we have the real ID.
      this.pendingTempSessions.delete(prevTempId);
      this.replacementAliases.set(prevTempId, sessionId);
      state.replacedFromSessionId = prevTempId;
      const tempCache = this.messageCache.get(prevTempId);
      if (tempCache && !this.messageCache.has(sessionId))
        this.messageCache.set(sessionId, tempCache);
      state.tempSessionId = null;
    }

    state.sessionId = sessionId;
    if (!state.query) return;
    const activeEntry = this.ensureActiveQuery(sessionId, state.query, state.target);
    activeEntry.model = state.model;
    activeEntry.variant = state.variant;

    if (message.type === "system" && message.subtype === "init") {
      const realSession = {
        ...makeSessionFromInfo(
          {
            sessionId,
            summary: state.fallbackTitle,
            lastModified: Date.now(),
            createdAt: Date.now(),
            cwd: state.target.directory,
            model: claudeSessionModelFromSelection(state.model, state.variant),
          },
          state.target,
          state.fallbackTitle,
        ),
        _syntheticUserId: state.syntheticUserId,
      };

      if (prevTempId && sessionId !== prevTempId) {
        // Tell the renderer to rename all state from tempId → realId.
        this.emit({
          type: "claude-code:event",
          payload: {
            type: "session.replaced",
            oldId: prevTempId,
            newId: sessionId,
            directory: state.target.directory,
            workspaceId: state.target.workspaceId,
            session: realSession,
          },
        });
      } else {
        // First-time init for an existing session (no temp ID) — emit normally.
        this.emit({
          type: "claude-code:event",
          payload: {
            type: "session.created",
            directory: state.target.directory,
            workspaceId: state.target.workspaceId,
            session: realSession,
          },
        });
        this.emitSyntheticUserMessage(state);
        this.emitSessionStatus(sessionId, "busy");
      }
      return;
    }

    if (message.type === "user") {
      const toolResults = getToolResultBlocks(message);
      if (toolResults.length > 0) {
        for (const block of toolResults) {
          this.applyToolResult(state, block);
        }
        return;
      }
      const userText = contentToTextSegments(getMessageBlocks(message)).join("\n\n").trim();
      if (state.syntheticUserEmitted && userText === String(state.promptText ?? "").trim()) {
        return;
      }
      state.syntheticUserEmitted = true;
      const mapped = mapUserHistoryMessage(message as ClaudeHistoryEntry, sessionId);
      this.emit({
        type: "claude-code:event",
        payload: { type: "message.updated", message: mapped.info },
      });
      for (const part of mapped.parts) {
        this.emit({
          type: "claude-code:event",
          payload: { type: "message.part.updated", part },
        });
      }
      return;
    }

    if (!state.syntheticUserEmitted) {
      this.emitSyntheticUserMessage(state);
    }

    if (message.type === "stream_event") {
      const event = message.event as Record<string, unknown> | null | undefined;
      if (!event || typeof event !== "object") return;
      const eventType = typeof event.type === "string" ? event.type : "";
      if (eventType === "message_start") {
        const startMsg = event.message as { id?: string; model?: string } | undefined;
        const messageId = startMsg?.id;
        if (!messageId) return;
        state.currentAssistantMessageId = messageId;
        state.currentMessageParts.clear();
        const info = defaultAssistantInfo(
          sessionId,
          messageId,
          state.target.directory,
          mapClaudeModelId(startMsg?.model),
        );
        this.emit({
          type: "claude-code:event",
          payload: { type: "message.updated", message: info },
        });
        return;
      }
      const messageId = state.currentAssistantMessageId;
      if (!messageId) return;
      if (eventType === "content_block_start") {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (!block || typeof block !== "object") return;
        const blockIndex = typeof event.index === "number" ? event.index : 0;
        const blockType = typeof block.type === "string" ? block.type : "";
        let part: ClaudeMessagePart;
        if (blockType === "thinking" || blockType === "redacted_thinking") {
          part = makeReasoningPart(
            sessionId,
            messageId,
            blockIndex,
            coerceHarnessString(block.thinking ?? block.text),
          );
        } else if (blockType === "tool_use") {
          const toolName = typeof block.name === "string" ? block.name : "tool";
          const toolInput =
            block.input && typeof block.input === "object" && !Array.isArray(block.input)
              ? (block.input as Record<string, unknown>)
              : {};
          part = {
            id: `${messageId}:tool:${blockIndex}`,
            sessionID: sessionId,
            messageID: messageId,
            type: "tool",
            callID:
              (typeof block.id === "string" ? block.id : undefined) ||
              `${messageId}:call:${blockIndex}`,
            tool: toolName,
            state: {
              status: "running",
              input: normalizeToolInput(toolName, toolInput),
              output: "",
              title: toolName,
              metadata: { id: block.id },
              time: { start: Date.now() },
            },
          };
          this.rememberToolPart(state, part);
        } else {
          part = makeTextPart(sessionId, messageId, blockIndex, coerceHarnessString(block.text));
        }
        state.currentMessageParts.set(part.id, part);
        this.emit({
          type: "claude-code:event",
          payload: { type: "message.part.updated", part },
        });
        return;
      }
      if (eventType === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        const deltaType = typeof delta?.type === "string" ? delta.type : "";
        const blockIndex = typeof event.index === "number" ? event.index : 0;
        const partId =
          deltaType === "text_delta"
            ? `${messageId}:text:${blockIndex}`
            : deltaType === "thinking_delta"
              ? `${messageId}:reasoning:${blockIndex}`
              : `${messageId}:tool:${blockIndex}`;
        const part = state.currentMessageParts.get(partId);
        if (!part) return;
        if (deltaType === "text_delta") {
          this.emit({
            type: "claude-code:event",
            payload: {
              type: "message.part.delta",
              sessionID: sessionId,
              messageID: messageId,
              partID: part.id,
              field: "text",
              delta: delta?.text,
            },
          });
          return;
        }
        if (deltaType === "thinking_delta") {
          this.emit({
            type: "claude-code:event",
            payload: {
              type: "message.part.delta",
              sessionID: sessionId,
              messageID: messageId,
              partID: part.id,
              field: "text",
              delta: delta?.thinking,
            },
          });
          return;
        }
        if (deltaType === "input_json_delta" && part.type === "tool") {
          const prevMeta =
            part.state?.metadata && typeof part.state.metadata === "object"
              ? part.state.metadata
              : {};
          const nextPart: ClaudeMessagePart = {
            ...part,
            state: {
              ...part.state,
              metadata: {
                ...prevMeta,
                rawInput: `${(prevMeta as { rawInput?: string }).rawInput ?? ""}${coerceHarnessString(delta?.partial_json)}`,
              },
            },
          };
          state.currentMessageParts.set(part.id, nextPart);
          this.rememberToolPart(state, nextPart);
          this.emit({
            type: "claude-code:event",
            payload: { type: "message.part.updated", part: nextPart },
          });
        }
        return;
      }
      if (eventType === "message_stop") {
        state.currentAssistantMessageId = null;
        state.currentMessageParts.clear();
      }
      return;
    }

    if (message.type === "assistant") {
      const assistantBody = message.message as
        | { id?: string; model?: string; content?: unknown }
        | undefined;
      const messageId =
        assistantBody?.id || state.currentAssistantMessageId || coerceHarnessString(message.uuid);
      const info = {
        ...defaultAssistantInfo(
          sessionId,
          messageId,
          state.target.directory,
          mapClaudeModelId(assistantBody?.model),
        ),
        time: {
          created: Date.now(),
          completed: Date.now(),
        },
        error: message.error
          ? {
              name: message.error,
              data: { message: message.error },
            }
          : undefined,
      };
      this.emit({
        type: "claude-code:event",
        payload: { type: "message.updated", message: info },
      });
      const contentBlocks = Array.isArray(assistantBody?.content) ? assistantBody.content : [];
      for (const block of contentBlocks) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "tool_use"
        ) {
          this.enrichAssistantToolSnapshot(state, block as Record<string, unknown>);
        }
      }
      const hasStreamedParts =
        state.currentAssistantMessageId === messageId && state.currentMessageParts.size > 0;
      const parts = mapAssistantContent(sessionId, messageId, assistantBody?.content);
      this.cacheMessage(sessionId, { info, parts });
      if (!hasStreamedParts) {
        for (const part of parts) {
          if (part.type === "tool") this.rememberToolPart(state, part);
          this.emit({
            type: "claude-code:event",
            payload: { type: "message.part.updated", part },
          });
        }
      }
      return;
    }

    if (message.type === "system" && message.subtype === "session_state_changed") {
      this.emitSessionStatus(sessionId, message.state === "idle" ? "idle" : "busy");
      return;
    }

    if (message.type === "auth_status" && message.error) {
      this.emit({
        type: "claude-code:event",
        payload: { type: "session.error", sessionID: sessionId, error: message.error },
      });
      return;
    }

    if (message.type === "result") {
      if (message.is_error && Array.isArray(message.errors) && message.errors.length > 0) {
        this.emit({
          type: "claude-code:event",
          payload: {
            type: "session.error",
            sessionID: sessionId,
            error: message.errors.join("\n"),
          },
        });
      }
      this.emitSessionStatus(sessionId, "idle");
      if (state.replacedFromSessionId) this.emitSessionStatus(state.replacedFromSessionId, "idle");
      state.toolParts.clear();
      state.currentAssistantMessageId = null;
      state.currentMessageParts.clear();
    }
  }

  startQuery({
    sessionId: rawSessionId,
    text = "",
    title,
    directory,
    workspaceId,
    model,
    variant,
  }: StartQueryParams) {
    let sessionId: string | undefined =
      typeof rawSessionId === "string" && rawSessionId.trim()
        ? toRawSessionId(rawSessionId)
        : undefined;
    const placeholder = sessionId ? this.placeholderSessions.get(sessionId) : null;
    if (placeholder) {
      directory ??= placeholder.target.directory;
      workspaceId ??= placeholder.target.workspaceId;
      title ??= placeholder.title;
      // Do not pass the placeholder UUID to Claude Code as a resume id; it is
      // only a renderer/backend id until the subprocess emits the real session.
      sessionId = undefined;
    }
    const target = this.resolveTarget(directory, workspaceId, sessionId ?? "");
    const modelInfo = this.lookupModelInfo(
      model?.modelID,
      target.directory,
      target.workspaceId,
      sessionId ?? "",
    );
    let state: ClaudePendingTempState;
    const targetRef = () => ({ sessionId: state.sessionId, ...target });

    // For new sessions (no sessionId yet) pre-generate a temporary UUID so we
    // can emit session.created + the synthetic user message immediately, letting
    // the IPC call return right away instead of blocking for ~8 s until the
    // Claude Code subprocess sends its first system/init message.
    const tempSessionId: string | null =
      !sessionId || placeholder ? (placeholder?.id ?? sessionId ?? crypto.randomUUID()) : null;
    const effectiveSessionId = sessionId ?? tempSessionId ?? crypto.randomUUID();

    state = {
      sessionId: effectiveSessionId,
      // Remember the original tempId so we can emit session.replaced when
      // the real session_id arrives in system/init.
      tempSessionId,
      target,
      query: null,
      resolveSession: null,
      rejectSession: null,
      fallbackTitle: makeSessionTitle(text, title),
      promptText: text,
      model,
      variant: typeof variant === "string" ? variant : undefined,
      syntheticUserId: `synthetic-user:${crypto.randomUUID()}`,
      syntheticUserEmitted: false,
      currentAssistantMessageId: null,
      currentMessageParts: new Map(),
      toolParts: new Map(),
    };
    const options = makeClaudeQueryOptions({
      cwd: target.directory,
      resume: placeholder ? undefined : sessionId,
      model: model?.modelID,
      canUseTool: this.makePermissionHandler(targetRef),
      variant,
      modelInfo,
      title: sessionId ? undefined : state.fallbackTitle,
    });
    const iterator = query({ prompt: text, options });
    state.query = iterator;

    // Always register, emit the synthetic user message, and mark session busy
    // immediately — both for new sessions (using the tempSessionId) and for
    // existing ones.  This makes the user's message appear in the UI right away
    // rather than waiting for the subprocess to start.
    const activeEntry = this.ensureActiveQuery(effectiveSessionId, iterator, target);
    activeEntry.model = model;
    activeEntry.variant = variant;
    this.emitSyntheticUserMessage(state);
    this.emitSessionStatus(effectiveSessionId, "busy");

    let sessionPromise;
    if (tempSessionId) {
      // Emit session.created right now with the temp ID so the renderer can
      // display the session in the sidebar and load messages immediately.
      const tempSession = {
        ...makeSessionFromInfo(
          {
            sessionId: tempSessionId,
            summary: state.fallbackTitle,
            lastModified: Date.now(),
            createdAt: Date.now(),
            cwd: target.directory,
            model: claudeSessionModelFromSelection(state.model, state.variant),
          },
          target,
          state.fallbackTitle,
        ),
        _syntheticUserId: state.syntheticUserId,
      };
      this.emit({
        type: "claude-code:event",
        payload: {
          type: "session.created",
          directory: target.directory,
          workspaceId: target.workspaceId,
          session: tempSession,
        },
      });
      // Store state so getMessages can return the synthetic message while
      // the subprocess is still initialising.
      this.pendingTempSessions.set(tempSessionId, state);
      this.placeholderSessions.delete(tempSessionId);
      // Resolve immediately — no need to wait for system/init.
      sessionPromise = Promise.resolve(tempSession);
    } else {
      // Existing session — nothing extra to do; caller doesn't await.
      sessionPromise = Promise.resolve(null);
    }

    void (async () => {
      try {
        for await (const message of iterator) {
          this.handleQueryMessage(message, state);
        }
        if (state.sessionId) {
          await this.refreshSessionInfo(state.sessionId, target, state.fallbackTitle);
          this.activeQueries.delete(state.sessionId);
        }
      } catch (error) {
        console.error("[claude-code] query failed", error);
        this.emit({
          type: "claude-code:event",
          payload: {
            type: "session.error",
            sessionID: state.sessionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        this.emitSessionStatus(state.sessionId, "idle");
        this.activeQueries.delete(state.sessionId);
      } finally {
        if (state.tempSessionId) this.cleanupPendingTempSession(state.tempSessionId);
      }
    })();
    return sessionPromise;
  }

  async startSession({
    text,
    title,
    directory,
    workspaceId,
    model,
    variant,
  }: {
    text?: string;
    title?: string;
    directory?: string;
    workspaceId?: string;
    model?: unknown;
    variant?: unknown;
  }) {
    return await this.startQuery({
      text,
      title,
      directory,
      workspaceId,
      model:
        model && typeof model === "object" && !Array.isArray(model)
          ? (model as { modelID?: string })
          : undefined,
      variant: typeof variant === "string" ? variant : undefined,
    });
  }

  async createSession({
    title,
    directory,
    workspaceId,
  }: {
    title?: string;
    directory?: string;
    workspaceId?: string;
  }) {
    const target = this.resolveTarget(directory, workspaceId, "");
    const tempSessionId = crypto.randomUUID();
    const session = makeSessionFromInfo(
      {
        sessionId: tempSessionId,
        summary: title || "New Claude Code session",
        lastModified: Date.now(),
        createdAt: Date.now(),
        cwd: target.directory,
      },
      target,
      title || "New Claude Code session",
    );
    this.placeholderSessions.set(tempSessionId, {
      id: tempSessionId,
      target,
      title: session.title,
    });
    return session;
  }

  async prompt(
    sessionId: string,
    text: string,
    _images: unknown,
    model: unknown,
    _agent: unknown,
    variant: unknown,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    sessionId = toRawSessionId(sessionId);
    void this.startQuery({
      sessionId,
      text,
      directory,
      workspaceId,
      model:
        model && typeof model === "object" && !Array.isArray(model)
          ? (model as { modelID?: string })
          : undefined,
      variant: typeof variant === "string" ? variant : undefined,
    });
    return true;
  }

  async abort(sessionId: string) {
    sessionId = toRawSessionId(sessionId);
    const entry = this.activeQueries.get(sessionId);
    void entry?.query?.close?.();
    this.activeQueries.delete(sessionId);
    this.cleanupPendingTempSession(sessionId);
    this.emitSessionStatus(sessionId, "idle");
    return true;
  }

  async respondPermission(sessionId: string, permissionId: string, response: unknown) {
    sessionId = toRawSessionId(sessionId);
    const entry = this.activeQueries.get(sessionId);
    const pending = entry?.pendingPermissions.get(permissionId);
    if (!pending || !entry) return true;
    entry.pendingPermissions.delete(permissionId);
    if (response === "reject") {
      pending.resolve({
        behavior: "deny",
        message: "Rejected by user",
        interrupt: true,
      });
      return true;
    }
    pending.resolve({
      behavior: "allow",
      updatedInput: pending.input,
      toolUseID: pending.toolUseID,
      ...(response === "always" && pending.suggestions.length > 0
        ? { updatedPermissions: pending.suggestions }
        : {}),
    });
    return true;
  }

  async sendCommand(
    sessionId: string,
    command: string,
    args: string,
    model: unknown,
    _agent: unknown,
    variant: unknown,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    sessionId = toRawSessionId(sessionId);
    const text = `/${command}${args ? ` ${args}` : ""}`;
    await this.prompt(sessionId, text, [], model, undefined, variant, directory, workspaceId);
    return true;
  }

  async summarizeSession(
    sessionId: string,
    model: unknown,
    directory: string | undefined,
    workspaceId: string | undefined,
  ) {
    sessionId = toRawSessionId(sessionId);
    await this.sendCommand(
      sessionId,
      "compact",
      "",
      model,
      undefined,
      undefined,
      directory,
      workspaceId,
    );
    return true;
  }

  async getProviders(directory: string | undefined, workspaceId: string | undefined) {
    const catalog = await this.discoverProviders(directory, workspaceId, "");
    return catalog.providers;
  }

  async getAgents() {
    return [];
  }

  async getCommands(directory: string | undefined, workspaceId: string | undefined) {
    const target = this.resolveTarget(directory, workspaceId, "");
    return await listClaudeCommands(target.directory);
  }
}

type ClaudeIpcMain = Parameters<typeof registerHarnessRpcHandlers>[1];
type ClaudeGetWindows = Parameters<typeof makeHarnessBridgeEventEmitter>[1];

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

export function setupClaudeCodeBridge(ipcMain: ClaudeIpcMain, getWindows: ClaudeGetWindows) {
  const emit = makeHarnessBridgeEventEmitter("claude-code", getWindows);
  let manager = new ClaudeCodeBridgeManager(emit);

  registerHarnessRpcHandlers("claude-code", ipcMain, {
    "project:add": (config) => {
      const row = config && typeof config === "object" && !Array.isArray(config) ? config : {};
      const directory = asString((row as { directory?: unknown }).directory, "directory");
      manager.attachProject({
        directory,
        workspaceId: asOptionalString((row as { workspaceId?: unknown }).workspaceId),
      });
      return true;
    },
    "project:remove": (directory, workspaceId) => {
      manager.removeProject(asString(directory, "directory"), asOptionalString(workspaceId));
      return true;
    },
    disconnect: () => {
      manager.disconnect();
      return true;
    },
    "session:list": (directory, workspaceId) =>
      manager.listSessions(asOptionalString(directory), asOptionalString(workspaceId)),
    "session:create": (title, directory, workspaceId) =>
      manager.createSession({
        title: asOptionalString(title),
        directory: asOptionalString(directory),
        workspaceId: asOptionalString(workspaceId),
      }),
    "session:delete": (sessionId, directory, workspaceId) =>
      manager.deleteSession(
        asString(sessionId, "sessionId"),
        asOptionalString(directory),
        asOptionalString(workspaceId),
      ),
    "session:update": (sessionId, title, directory, workspaceId) =>
      manager.renameSession(
        asString(sessionId, "sessionId"),
        asString(title, "title"),
        asOptionalString(directory),
        asOptionalString(workspaceId),
      ),
    "session:statuses": (directory, workspaceId) =>
      manager.listSessionStatuses(asOptionalString(directory), asOptionalString(workspaceId)),
    "session:fork": (sessionId, messageID, directory, workspaceId) =>
      manager.forkSession(
        asString(sessionId, "sessionId"),
        asString(messageID, "messageID"),
        asOptionalString(directory),
        asOptionalString(workspaceId),
      ),
    providers: (directory, workspaceId) =>
      manager.getProviders(asOptionalString(directory), asOptionalString(workspaceId)),
    agents: () => manager.getAgents(),
    commands: (directory, workspaceId) =>
      manager.getCommands(asOptionalString(directory), asOptionalString(workspaceId)),
    messages: (sessionId, options, directory, workspaceId) =>
      manager.getMessages(
        asString(sessionId, "sessionId"),
        options && typeof options === "object" && !Array.isArray(options)
          ? (options as ClaudeGetMessagesOptions)
          : undefined,
        asOptionalString(directory),
        asOptionalString(workspaceId),
      ),
    "session:start": (input) => {
      const row =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      return manager.startSession({
        text: asOptionalString(row.text),
        title: asOptionalString(row.title),
        directory: asOptionalString(row.directory),
        workspaceId: asOptionalString(row.workspaceId),
        model:
          row.model && typeof row.model === "object" && !Array.isArray(row.model)
            ? (row.model as { modelID?: string })
            : undefined,
        variant: asOptionalString(row.variant),
      });
    },
    prompt: async (sessionId, text, images, model, agent, variant, directory, workspaceId) => {
      await manager.prompt(
        asString(sessionId, "sessionId"),
        asString(text, "text"),
        images,
        model,
        agent,
        variant,
        asOptionalString(directory),
        asOptionalString(workspaceId),
      );
      return true;
    },
    abort: (sessionId) => manager.abort(asString(sessionId, "sessionId")),
    permission: (sessionId, permissionId, response) =>
      manager.respondPermission(
        asString(sessionId, "sessionId"),
        asString(permissionId, "permissionId"),
        response,
      ),
    "command:send": (sessionId, command, args, model, agent, variant, directory, workspaceId) =>
      manager.sendCommand(
        asString(sessionId, "sessionId"),
        asString(command, "command"),
        asString(args, "args"),
        model,
        agent,
        variant,
        asOptionalString(directory),
        asOptionalString(workspaceId),
      ),
    "session:summarize": (sessionId, model, directory, workspaceId) =>
      manager.summarizeSession(
        asString(sessionId, "sessionId"),
        model,
        asOptionalString(directory),
        asOptionalString(workspaceId),
      ),
  });

  return {
    async restart() {
      manager.disconnect();
      manager = new ClaudeCodeBridgeManager(emit);
      return true;
    },
  };
}
