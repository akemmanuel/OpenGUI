import type { QuestionAnswer } from "@opencode-ai/sdk/v2/client";
import type { HarnessId } from "../../src/agents/index.ts";
import type {
  HarnessResourceBundle,
  ProjectConnectResult,
  HarnessProjectSessionsResult,
} from "../../src/protocol/client.ts";
import type { SelectedModel } from "../../src/types/electron.d.ts";
import type { BackendEventBus } from "./event-bus.ts";
import type { SessionRecord } from "./session-types.ts";
import type { ProjectRecord } from "./storage-service.ts";

interface BridgeResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface HarnessControl {
  restart?: () => Promise<unknown>;
}

export interface HarnessTarget {
  directory?: string;
}

export interface ProjectConnectionConfig {
  baseUrl?: string;
  username?: string;
  password?: string;
  directory?: string;
}

export interface HarnessScope {
  projectId: string;
  sessionId?: string;
  harnessId: HarnessId;
  directory: string;
}

export class HarnessService {
  private readonly invoke: <T = unknown>(channel: string, args?: unknown[]) => Promise<T>;
  private readonly controls: ReadonlyMap<string, HarnessControl>;
  private readonly managedHarnessIds: readonly HarnessId[];
  private readonly events?: BackendEventBus;

  constructor(
    invoke: <T = unknown>(channel: string, args?: unknown[]) => Promise<T>,
    controls: ReadonlyMap<string, HarnessControl>,
    managedHarnessIds: readonly HarnessId[],
    events?: BackendEventBus,
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

  async connectProject(input: {
    project: ProjectRecord;
    scope: Pick<HarnessScope, "projectId" | "directory">;
    harnessIds?: HarnessId[];
    config?: ProjectConnectionConfig;
  }): Promise<ProjectConnectResult> {
    const harnessIds = this.harnessIdsOrAll(input.harnessIds);
    const results = await Promise.all(
      harnessIds.map(async (harnessId) => {
        try {
          await this.backendRpc(harnessId, "project:add", [
            {
              directory: input.scope.directory,
              baseUrl: input.config?.baseUrl,
              username: input.config?.username,
              password: input.config?.password,
            },
          ]);
          return { harnessId: harnessId, success: true as const };
        } catch (error) {
          return {
            harnessId: harnessId,
            success: false as const,
            error: error instanceof Error ? error.message : "Project connection failed",
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

  async disconnectProject(input: {
    project: ProjectRecord;
    scope: Pick<HarnessScope, "projectId" | "directory">;
    harnessIds?: HarnessId[];
  }): Promise<void> {
    await Promise.all(
      this.harnessIdsOrAll(input.harnessIds).map((harnessId) =>
        this.backendRpc(harnessId, "project:remove", [input.scope.directory, undefined]),
      ),
    );
  }

  async getProjectStatus(input: {
    project: ProjectRecord;
    scope: Pick<HarnessScope, "projectId" | "directory">;
    harnessIds?: HarnessId[];
  }): Promise<
    Record<
      string,
      { connected: boolean; statuses: Record<string, { type: string }>; error?: string }
    >
  > {
    const entries = await Promise.all(
      this.harnessIdsOrAll(input.harnessIds).map(async (harnessId) => {
        try {
          const statuses = await this.backendRpc<Record<string, { type: string }>>(
            harnessId,
            "session:statuses",
            [input.scope.directory, undefined],
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

  async listProjectSessions(input: {
    project: ProjectRecord;
    scope: Pick<HarnessScope, "projectId" | "directory">;
    harnessIds: HarnessId[];
  }): Promise<Array<{ harnessId: HarnessId; sessions: HarnessProjectSessionsResult["sessions"] }>> {
    const results = await Promise.all(
      input.harnessIds.map(async (harnessId) => {
        try {
          const sessions = await this.backendRpc<HarnessProjectSessionsResult["sessions"]>(
            harnessId,
            "session:list",
            [input.scope.directory, undefined],
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

  async createSession(input: {
    project: ProjectRecord;
    scope: HarnessScope;
    title?: string;
  }): Promise<unknown> {
    return this.backendRpc(input.scope.harnessId, "session:create", [
      input.title,
      input.scope.directory,
      undefined,
    ]);
  }

  async updateSession(input: {
    session: SessionRecord;
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

  async deleteSession(input: { session: SessionRecord; scope: HarnessScope }): Promise<boolean> {
    return this.backendRpc<boolean>(input.session.harnessId, "session:delete", [
      input.session.rawId,
      input.scope.directory,
      undefined,
    ]);
  }

  async listMessages(input: {
    session: SessionRecord;
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
    session: SessionRecord;
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
    session: SessionRecord;
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

  async abortSession(input: { session: SessionRecord }): Promise<void> {
    await this.backendRpc(input.session.harnessId, "abort", [input.session.rawId]);
  }

  async respondPermission(input: {
    session: SessionRecord;
    permissionId: string;
    response: "once" | "always" | "reject";
  }): Promise<void> {
    await this.backendRpc(input.session.harnessId, "permission", [
      input.session.rawId,
      input.permissionId,
      input.response,
    ]);
  }

  async replyQuestion(input: {
    harnessId: HarnessId;
    requestId: string;
    answers: QuestionAnswer[];
  }): Promise<void> {
    await this.backendRpc(input.harnessId, "question:reply", [input.requestId, input.answers]);
  }

  async rejectQuestion(input: { harnessId: HarnessId; requestId: string }): Promise<void> {
    await this.backendRpc(input.harnessId, "question:reject", [input.requestId]);
  }

  async forkSession(input: {
    session: SessionRecord;
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
    session: SessionRecord;
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
    session: SessionRecord;
    messageId: string;
    partId?: string;
  }): Promise<unknown> {
    return this.backendRpc(input.session.harnessId, "session:revert", [
      input.session.rawId,
      input.messageId,
      input.partId,
    ]);
  }

  async unrevertSession(input: { session: SessionRecord }): Promise<unknown> {
    return this.backendRpc(input.session.harnessId, "session:unrevert", [input.session.rawId]);
  }

  async loadResources(input: {
    project: ProjectRecord;
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
