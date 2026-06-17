import type { QuestionAnswer } from "@opencode-ai/sdk/v2/client";
import type { HarnessId } from "../../../src/agents/index.ts";
import type {
  DirectoryRegisterResult,
  HarnessResourceBundle,
} from "../../../src/protocol/client.ts";
import type { SelectedModel } from "../../../src/types/electron.d.ts";
import type { HarnessControl } from "./harness-runtime.ts";
import type { DirectoryScopeRef } from "./directory-scope-types.ts";
import { directoryRef } from "./directory-ref.ts";
import { DEFAULT_OPENCODE_BASE_URL } from "./default-server-url.ts";

interface BridgeResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Session row from harness `session:list` RPC (runtime SDK). */
export interface RuntimeListedSession {
  id: string;
  title?: string;
  status?: string | { type?: string };
  directory?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Minimal session shape for harness RPC routing (backend session index). */
export interface RuntimeSessionRef {
  id: string;
  rawId: string;
  directory: string;
  harnessId: HarnessId;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessTarget {
  directory?: string;
}

export interface DirectoryConnectionConfig {
  baseUrl?: string;
  username?: string;
  password?: string;
  directory?: string;
}

export interface HarnessScope {
  sessionId?: string;
  harnessId: HarnessId;
  directory: string;
}

export interface HarnessLifecycleEvents {
  emit(
    type: "harness.restarted",
    payload: { harnessId: string },
    refs?: { harnessId: string },
  ): void;
}

export class HarnessService {
  private readonly invoke: <T = unknown>(channel: string, args?: unknown[]) => Promise<T>;
  private readonly controls: ReadonlyMap<string, HarnessControl>;
  private readonly managedHarnessIds: readonly HarnessId[];
  private readonly events?: HarnessLifecycleEvents;

  constructor(
    invoke: <T = unknown>(channel: string, args?: unknown[]) => Promise<T>,
    controls: ReadonlyMap<string, HarnessControl>,
    managedHarnessIds: readonly HarnessId[],
    events?: HarnessLifecycleEvents,
  ) {
    this.invoke = invoke;
    this.controls = controls;
    this.managedHarnessIds = managedHarnessIds;
    this.events = events;
  }

  async restartHarness(harnessId: string): Promise<void> {
    const control = this.controls.get(harnessId);
    if (!control?.restart) throw new Error("Restart not available");
    await control.restart();
    this.events?.emit("harness.restarted", { harnessId }, { harnessId });
  }

  async restartAllHarnesses(): Promise<void> {
    for (const harnessId of this.managedHarnessIds) {
      await this.restartHarness(harnessId);
    }
  }

  getManagedHarnessIds(): readonly HarnessId[] {
    return this.managedHarnessIds;
  }

  async registerDirectory(input: {
    directory: string;
    harnessIds?: HarnessId[];
    config?: DirectoryConnectionConfig;
  }): Promise<DirectoryRegisterResult> {
    const directory = input.directory;
    return this.registerDirectoryWithScope({
      scopeRef: directoryRef(directory),
      scope: { directory },
      harnessIds: input.harnessIds,
      config: input.config,
    });
  }

  private async registerDirectoryWithScope(input: {
    scopeRef: DirectoryScopeRef;
    scope: Pick<HarnessScope, "directory">;
    harnessIds?: HarnessId[];
    config?: DirectoryConnectionConfig;
  }): Promise<DirectoryRegisterResult> {
    const harnessIds = this.harnessIdsOrAll(input.harnessIds);
    const results = await Promise.all(
      harnessIds.map(async (harnessId) => {
        try {
          const baseUrl =
            input.config?.baseUrl?.trim() ||
            (harnessId === "opencode" ? DEFAULT_OPENCODE_BASE_URL : undefined);
          await this.backendRpc(harnessId, "project:add", [
            {
              directory: input.scope.directory,
              baseUrl,
              username: input.config?.username,
              password: input.config?.password,
            },
          ]);
          return { harnessId: harnessId, success: true as const };
        } catch (error) {
          return {
            harnessId: harnessId,
            success: false as const,
            error: error instanceof Error ? error.message : "Directory registration failed",
          };
        }
      }),
    );

    return {
      connectedHarnessIds: results.flatMap((result) => (result.success ? [result.harnessId] : [])),
      errors: results.flatMap((result) =>
        result.success ? [] : [{ harnessId: result.harnessId, error: result.error }],
      ),
    };
  }

  async releaseDirectory(input: { directory: string; harnessIds?: HarnessId[] }): Promise<void> {
    await Promise.all(
      this.harnessIdsOrAll(input.harnessIds).map((harnessId) =>
        this.backendRpc(harnessId, "project:remove", [input.directory]),
      ),
    );
  }

  /** Tear down harness IPC clients (Pi daemon SSE, OpenCode connections) so Node can exit. */
  async shutdownHarnessClients(): Promise<void> {
    await Promise.all(
      this.managedHarnessIds.map(async (harnessId) => {
        try {
          await this.invoke(`${harnessId}:disconnect`, []);
        } catch {
          /* harness may already be disconnected */
        }
      }),
    );
  }

  async getDirectoryStatus(input: {
    directory: string;
    harnessIds?: HarnessId[];
  }): Promise<
    Record<
      string,
      { connected: boolean; statuses: Record<string, { type: string }>; error?: string }
    >
  > {
    const directory = input.directory;
    const entries = await Promise.all(
      this.harnessIdsOrAll(input.harnessIds).map(async (harnessId) => {
        try {
          const statuses = await this.backendRpc<Record<string, { type: string }>>(
            harnessId,
            "session:statuses",
            [directory],
          );
          return [harnessId, { connected: true, statuses }] as const;
        } catch (error) {
          return [
            harnessId,
            {
              connected: false,
              statuses: {},
              error: error instanceof Error ? error.message : String(error),
            },
          ] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  async listDirectorySessions(input: {
    directory: string;
    harnessIds: HarnessId[];
  }): Promise<Array<{ harnessId: HarnessId; sessions: RuntimeListedSession[] }>> {
    const directory = input.directory;
    const results = await Promise.all(
      input.harnessIds.map(async (harnessId) => {
        try {
          const sessions = await this.backendRpc<RuntimeListedSession[]>(
            harnessId,
            "session:list",
            [directory],
          );
          return { harnessId: harnessId, sessions };
        } catch {
          return null;
        }
      }),
    );
    return results.filter((result): result is NonNullable<(typeof results)[number]> =>
      Boolean(result),
    );
  }

  async createSession(input: { scope: HarnessScope; title?: string }): Promise<unknown> {
    return this.backendRpc(input.scope.harnessId, "session:create", [
      input.title,
      input.scope.directory,
      undefined,
    ]);
  }

  async updateSession(input: {
    session: RuntimeSessionRef;
    scope: HarnessScope;
    title: string;
  }): Promise<unknown> {
    return this.backendRpc(input.session.harnessId, "session:update", [
      input.session.rawId,
      input.title,
      input.scope.directory,
      undefined,
    ]);
  }

  async deleteSession(input: {
    session: RuntimeSessionRef;
    scope: HarnessScope;
  }): Promise<boolean> {
    return this.backendRpc<boolean>(input.session.harnessId, "session:delete", [
      input.session.rawId,
      input.scope.directory,
      undefined,
    ]);
  }

  async listMessages(input: {
    session: RuntimeSessionRef;
    scope: HarnessScope;
    options?: { limit?: number; before?: string | null };
  }): Promise<unknown> {
    return this.backendRpc(input.session.harnessId, "messages", [
      input.session.rawId,
      input.options,
      input.scope.directory,
      undefined,
    ]);
  }

  async promptSession(input: {
    session: RuntimeSessionRef;
    scope: HarnessScope;
    text: string;
    model?: SelectedModel;
    agent?: string;
    variant?: string;
  }): Promise<void> {
    await this.backendRpc(input.session.harnessId, "prompt", [
      input.session.rawId,
      input.text,
      undefined,
      input.model,
      input.agent,
      input.variant,
      input.scope.directory,
      undefined,
    ]);
  }

  async sendCommand(input: {
    session: RuntimeSessionRef;
    scope: HarnessScope;
    command: string;
    args: string;
    model?: SelectedModel;
    agent?: string;
    variant?: string;
  }): Promise<void> {
    await this.backendRpc(input.session.harnessId, "command:send", [
      input.session.rawId,
      input.command,
      input.args,
      input.model,
      input.agent,
      input.variant,
      input.scope.directory,
      undefined,
    ]);
  }

  async abortSession(input: { session: RuntimeSessionRef; scope: HarnessScope }): Promise<void> {
    await this.backendRpc(input.session.harnessId, "abort", [
      input.session.rawId,
      input.scope.directory,
      undefined,
    ]);
  }

  async respondPermission(input: {
    session: RuntimeSessionRef;
    permissionId: string;
    response: "once" | "always" | "reject";
    scope?: { directory?: string };
  }): Promise<void> {
    await this.backendRpc(input.session.harnessId, "permission", [
      input.session.rawId,
      input.permissionId,
      input.response,
      input.scope?.directory,
    ]);
  }

  async replyQuestion(input: {
    harnessId: HarnessId;
    requestId: string;
    answers: QuestionAnswer[];
    target?: HarnessTarget;
  }): Promise<void> {
    await this.backendRpc(input.harnessId, "question:reply", [
      input.requestId,
      input.answers,
      input.target?.directory,
    ]);
  }

  async rejectQuestion(input: {
    harnessId: HarnessId;
    requestId: string;
    target?: HarnessTarget;
  }): Promise<void> {
    await this.backendRpc(input.harnessId, "question:reject", [
      input.requestId,
      input.target?.directory,
    ]);
  }

  async forkSession(input: {
    session: RuntimeSessionRef;
    scope: HarnessScope;
    messageId?: string;
  }): Promise<unknown> {
    return this.backendRpc(input.session.harnessId, "session:fork", [
      input.session.rawId,
      input.messageId,
      input.scope.directory,
      undefined,
    ]);
  }

  async compactSession(input: {
    session: RuntimeSessionRef;
    scope: HarnessScope;
    model?: SelectedModel;
  }): Promise<void> {
    await this.backendRpc(input.session.harnessId, "session:summarize", [
      input.session.rawId,
      input.model,
      input.scope.directory,
      undefined,
    ]);
  }

  async revertSession(input: {
    session: RuntimeSessionRef;
    scope: HarnessScope;
    messageId: string;
    partId?: string;
  }): Promise<unknown> {
    return this.backendRpc(input.session.harnessId, "session:revert", [
      input.session.rawId,
      input.messageId,
      input.partId,
      input.scope.directory,
      undefined,
    ]);
  }

  async unrevertSession(input: {
    session: RuntimeSessionRef;
    scope: HarnessScope;
  }): Promise<unknown> {
    return this.backendRpc(input.session.harnessId, "session:unrevert", [
      input.session.rawId,
      input.scope.directory,
      undefined,
    ]);
  }

  async loadResources(input: {
    scopeRef: DirectoryScopeRef;
    scope: HarnessScope;
  }): Promise<HarnessResourceBundle> {
    const args = [input.scope.directory, undefined];
    const [providersData, agentsData, commandsData] = await Promise.all([
      this.backendRpc<HarnessResourceBundle["providersData"]>(
        input.scope.harnessId,
        "providers",
        args,
      ),
      this.backendRpc<HarnessResourceBundle["agentsData"]>(input.scope.harnessId, "agents", args),
      this.backendRpc<HarnessResourceBundle["commandsData"]>(
        input.scope.harnessId,
        "commands",
        args,
      ),
    ]);
    return { providersData, agentsData, commandsData };
  }

  private harnessIdsOrAll(harnessIds?: HarnessId[]) {
    return harnessIds?.length ? harnessIds : [...this.managedHarnessIds];
  }

  private async backendRpc<T>(
    harnessId: HarnessId,
    suffix: string,
    args: unknown[] = [],
  ): Promise<T> {
    const result = await this.invoke<BridgeResult<T>>(`${harnessId}:${suffix}`, args);
    if (
      result &&
      typeof result === "object" &&
      "success" in result &&
      typeof result.success === "boolean"
    ) {
      if (!result.success)
        throw new Error(result.error || `Harness call failed: ${harnessId}:${suffix}`);
      return result.data as T;
    }
    return result as T;
  }
}

export function createHarnessService(input: {
  invoke: <T = unknown>(channel: string, args?: unknown[]) => Promise<T>;
  controls: ReadonlyMap<string, HarnessControl>;
  managedHarnessIds: readonly HarnessId[];
  events?: HarnessLifecycleEvents;
}): HarnessService {
  return new HarnessService(input.invoke, input.controls, input.managedHarnessIds, input.events);
}
