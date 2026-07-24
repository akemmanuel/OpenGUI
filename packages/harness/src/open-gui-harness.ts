import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { buildModelContext } from "./context/build-context.ts";
import { buildSystemPrompt } from "./context/system-prompt.ts";
import { type ExecutionPolicy, unrestrictedExecutionPolicy } from "./execution-policy.ts";
import type {
  Clock,
  CreateSessionInput,
  HarnessSession,
  IdGenerator,
  ModelSelection,
  OpenGuiHarness,
  OpenGuiHarnessOptions,
  PromptInput,
  ReasoningLevel,
  SessionEvent,
  SessionSnapshot,
} from "./harness.ts";
import type { ModelToolName } from "./models/transport.ts";
import { discoverSkills, loadSkillsFromDir } from "./skills/discover.ts";
import type { Skill } from "./skills/types.ts";
import { SqliteSessionStore } from "./storage/sqlite-store.ts";
import { executeTool } from "./tools/execute-tool.ts";
import { resolveNativeShell, type ResolvedShell } from "./tools/shell-resolution.ts";

class SystemClock implements Clock {
  now() {
    return new Date();
  }
}

class RandomIdGenerator implements IdGenerator {
  next(prefix: "session" | "entry" | "run" | "follow_up") {
    return `${prefix}_${randomUUID()}`;
  }
}

function selectedModel(entries: SessionSnapshot["entries"]): ModelSelection | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "model_changed") return entry.payload.model as ModelSelection;
  }
  return null;
}

function selectedReasoning(entries: SessionSnapshot["entries"]): ReasoningLevel | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "reasoning_changed") return entry.payload.reasoning as ReasoningLevel;
  }
  return null;
}

class HarnessSessionImpl implements HarnessSession {
  readonly #harness: OpenGuiHarnessImpl;
  readonly #id: string;

  constructor(harness: OpenGuiHarnessImpl, id: string) {
    this.#harness = harness;
    this.#id = id;
  }

  async read(): Promise<SessionSnapshot> {
    return this.#harness.readSession(this.#id);
  }

  run(prompt: PromptInput): AsyncIterable<SessionEvent> {
    return this.#harness.run(this.#id, prompt);
  }

  async followUp(prompt: PromptInput) {
    return await this.#harness.followUp(this.#id, prompt);
  }

  async updateFollowUp(followUpId: string, prompt: PromptInput) {
    await this.#harness.updateFollowUp(this.#id, followUpId, prompt);
  }

  async reorderFollowUp(followUpId: string, index: number) {
    await this.#harness.reorderFollowUp(this.#id, followUpId, index);
  }

  async removeFollowUp(followUpId: string) {
    await this.#harness.removeFollowUp(this.#id, followUpId);
  }

  async abort() {
    this.#harness.abort(this.#id);
  }

  async setModel(selection: ModelSelection) {
    await this.#harness.setModel(this.#id, selection);
  }

  async setReasoning(reasoning: ReasoningLevel) {
    await this.#harness.setReasoning(this.#id, reasoning);
  }

  async rename(title: string) {
    await this.#harness.renameSession(this.#id, title);
  }

  async delete() {
    await this.#harness.deleteSession(this.#id);
  }
}

class OpenGuiHarnessImpl implements OpenGuiHarness {
  readonly #store: SqliteSessionStore;
  readonly #model: OpenGuiHarnessOptions["model"];
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #dataDirectory: string;
  readonly #homeDirectory: string | undefined;
  readonly #shell: ResolvedShell;
  readonly #resolveExecutionPolicy: OpenGuiHarnessOptions["resolveExecutionPolicy"];
  readonly #runningSessions = new Set<string>();
  readonly #abortControllers = new Map<string, AbortController>();
  readonly #ready: Promise<void>;
  #closed = false;

  constructor(options: OpenGuiHarnessOptions) {
    this.#clock = options.clock ?? new SystemClock();
    this.#ids = options.ids ?? new RandomIdGenerator();
    this.#model = options.model;
    this.#dataDirectory = options.dataDirectory;
    this.#homeDirectory = options.homeDirectory;
    this.#shell = resolveNativeShell({ configuredExecutable: options.shell?.executable });
    this.#resolveExecutionPolicy = options.resolveExecutionPolicy;
    this.#store = new SqliteSessionStore(options.dataDirectory, this.#ids);
    this.#ready = this.#store.recoverInterruptedRuns(this.#clock.now().toISOString());
  }

  #assertOpen() {
    if (this.#closed) throw new Error("OpenGuiHarness is closed");
  }

  async #currentExecutionPolicy(
    actor: PromptInput["actor"],
    projectDirectory: string,
  ): Promise<ExecutionPolicy> {
    return this.#resolveExecutionPolicy
      ? await this.#resolveExecutionPolicy(actor)
      : unrestrictedExecutionPolicy(projectDirectory);
  }

  async #executionPolicyWithProjectAccess(
    actor: PromptInput["actor"],
    projectDirectory: string,
  ): Promise<{ policy: ExecutionPolicy; canonicalProjectRoot: string }> {
    const policy = await this.#currentExecutionPolicy(actor, projectDirectory);
    const decision = await policy.authorizePath(resolve(projectDirectory), "read");
    if (!decision.allowed || !decision.canonicalPath) {
      throw new Error(
        `Execution policy denied Project access${decision.reason ? `: ${decision.reason}` : ""}`,
      );
    }
    return { policy, canonicalProjectRoot: decision.canonicalPath };
  }

  async #toolsForModel(
    policy: ExecutionPolicy,
    canonicalProjectRoot: string,
  ): Promise<ModelToolName[]> {
    if (!policy.restricted) {
      return ["read", "write", "edit", ...(policy.shellAllowed ? (["shell"] as const) : [])];
    }
    const writeDecision = await policy.authorizePath(canonicalProjectRoot, "write");
    return ["read", ...(writeDecision.allowed ? (["write", "edit"] as const) : [])];
  }

  async #skillsForRun(projectDirectory: string, policy: ExecutionPolicy): Promise<Skill[]> {
    if (!policy.restricted) {
      return discoverSkills({
        projectDirectory,
        homeDirectory: this.#homeDirectory,
      }).skills;
    }

    // Restricted discovery is deliberately project-local and only starts after
    // the Host has authorized the discovery root. Symlinked SKILL.md files are
    // rejected by loadSkillsFromDir.
    const requestedRoot = join(projectDirectory, ".agents", "skills");
    const decision = await policy.authorizePath(requestedRoot, "read");
    if (!decision.allowed || !decision.canonicalPath) return [];
    return loadSkillsFromDir(decision.canonicalPath, "project").skills;
  }

  async listSessions(projectDirectory: string) {
    this.#assertOpen();
    await this.#ready;
    return this.#store.listSessions(projectDirectory);
  }

  async createSession(input: CreateSessionInput): Promise<HarnessSession> {
    this.#assertOpen();
    await this.#ready;
    const id = this.#ids.next("session");
    await this.#store.createSession(input, id, this.#clock.now().toISOString());
    return new HarnessSessionImpl(this, id);
  }

  async openSession(sessionId: string): Promise<HarnessSession> {
    this.#assertOpen();
    await this.#ready;
    await this.#store.readSession(sessionId);
    return new HarnessSessionImpl(this, sessionId);
  }

  async readSession(sessionId: string): Promise<SessionSnapshot> {
    this.#assertOpen();
    await this.#ready;
    const { summary, entries } = await this.#store.readSession(sessionId);
    return {
      ...summary,
      model: selectedModel(entries),
      reasoning: selectedReasoning(entries),
      entries,
      followUps: await this.#store.listFollowUps(sessionId),
    };
  }

  async followUp(sessionId: string, prompt: PromptInput) {
    this.#assertOpen();
    const text = prompt.text.trim();
    if (!text) throw new Error("Follow-up text must not be empty");
    if (!this.#runningSessions.has(sessionId)) {
      throw new Error("Follow-ups can only be queued while a Session is running");
    }
    return await this.#store.enqueueFollowUp(
      sessionId,
      { text, ...(prompt.actor ? { actor: prompt.actor } : {}) },
      this.#clock.now().toISOString(),
    );
  }

  async updateFollowUp(sessionId: string, followUpId: string, prompt: PromptInput) {
    this.#assertOpen();
    const text = prompt.text.trim();
    if (!text) throw new Error("Follow-up text must not be empty");
    await this.#store.updateFollowUp(sessionId, followUpId, {
      text,
      ...(prompt.actor ? { actor: prompt.actor } : {}),
    });
  }

  async reorderFollowUp(sessionId: string, followUpId: string, index: number) {
    this.#assertOpen();
    await this.#store.reorderFollowUp(sessionId, followUpId, index);
  }

  async removeFollowUp(sessionId: string, followUpId: string) {
    this.#assertOpen();
    await this.#store.removeFollowUp(sessionId, followUpId);
  }

  abort(sessionId: string) {
    this.#assertOpen();
    this.#abortControllers.get(sessionId)?.abort();
  }

  async setModel(sessionId: string, selection: ModelSelection) {
    this.#assertOpen();
    await this.#store.appendEntry(
      sessionId,
      "model_changed",
      { model: selection },
      this.#clock.now().toISOString(),
    );
  }

  async setReasoning(sessionId: string, reasoning: ReasoningLevel) {
    this.#assertOpen();
    await this.#store.appendEntry(
      sessionId,
      "reasoning_changed",
      { reasoning },
      this.#clock.now().toISOString(),
    );
  }

  async renameSession(sessionId: string, rawTitle: string) {
    this.#assertOpen();
    const title = rawTitle.trim();
    if (!title) throw new Error("Session title must not be empty");
    await this.#store.renameSession(sessionId, title, this.#clock.now().toISOString());
  }

  async deleteSession(sessionId: string) {
    this.#assertOpen();
    if (this.#runningSessions.has(sessionId)) throw new Error("Cannot delete a running Session");
    await this.#store.deleteSession(sessionId);
  }

  async *run(sessionId: string, prompt: PromptInput): AsyncIterable<SessionEvent> {
    this.#assertOpen();
    if (!prompt.text.trim()) throw new Error("Prompt text must not be empty");
    if (this.#runningSessions.has(sessionId))
      throw new Error("A run is already active for this Session");
    this.#runningSessions.add(sessionId);
    const abortController = new AbortController();
    this.#abortControllers.set(sessionId, abortController);
    let activeRunId: string | undefined;
    let authorizationFailed = false;
    const revalidate = async (actor: PromptInput["actor"], projectDirectory: string) => {
      try {
        return await this.#executionPolicyWithProjectAccess(actor, projectDirectory);
      } catch (error) {
        authorizationFailed = true;
        abortController.abort(error);
        throw error;
      }
    };
    try {
      let nextPrompt: PromptInput | null = {
        text: prompt.text.trim(),
        ...(prompt.actor ? { actor: prompt.actor } : {}),
      };
      let followUpId: string | undefined;
      while (nextPrompt) {
        const runId = this.#ids.next("run");
        activeRunId = runId;
        const snapshot = await this.readSession(sessionId);
        if (!snapshot.model || !snapshot.reasoning)
          throw new Error("Session model selection is incomplete");
        // Resolve once at the durable run seam. Queued prompts retain their
        // actor, but never retain a stale policy snapshot.
        await revalidate(nextPrompt.actor, snapshot.projectDirectory);
        const startedEntries = await this.#store.beginRun({
          sessionId,
          runId,
          prompt: nextPrompt,
          model: snapshot.model,
          reasoning: snapshot.reasoning,
          followUpId,
          now: this.#clock.now().toISOString(),
        });
        for (const entry of startedEntries) yield { type: "entry_appended", entry };

        while (true) {
          const current = await this.readSession(sessionId);
          const initialAccess = await revalidate(nextPrompt.actor, current.projectDirectory);
          let assistantText = "";
          let reasoningText = "";
          const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
          const skills = await this.#skillsForRun(current.projectDirectory, initialAccess.policy);
          // Skill discovery can perform I/O, so refresh once more immediately
          // before exposing capabilities to the provider.
          const modelAccess = await revalidate(nextPrompt.actor, current.projectDirectory);
          const tools = await this.#toolsForModel(
            modelAccess.policy,
            modelAccess.canonicalProjectRoot,
          );
          const shellAvailable = tools.includes("shell");
          for await (const event of this.#model.stream(
            {
              projectDirectory: current.projectDirectory,
              context: buildModelContext(current.entries),
              tools,
              systemPrompt: buildSystemPrompt({
                projectDirectory: current.projectDirectory,
                ...(shellAvailable ? { shell: this.#shell } : {}),
                tools,
                skills,
                now: this.#clock.now(),
              }),
            },
            abortController.signal,
          )) {
            // Provider chunks are the finest useful revocation boundary. Do
            // not expose or retain a chunk until current actor and Project
            // access have both been re-resolved.
            await revalidate(nextPrompt.actor, current.projectDirectory);
            if (event.type === "text_delta") {
              assistantText += event.delta;
              yield { type: "assistant_delta", runId, delta: event.delta };
            } else if (event.type === "reasoning_delta") {
              reasoningText += event.delta;
              yield { type: "reasoning_delta", runId, delta: event.delta };
            } else if (event.type === "tool_call") {
              toolCalls.push({ id: event.id, name: event.name, input: event.input });
            }
          }

          if (reasoningText) {
            await revalidate(nextPrompt.actor, current.projectDirectory);
            yield {
              type: "entry_appended",
              entry: await this.#store.appendEntry(
                sessionId,
                "assistant_reasoning",
                { runId, text: reasoningText },
                this.#clock.now().toISOString(),
              ),
            };
          }

          if (toolCalls.length === 0) {
            await revalidate(nextPrompt.actor, current.projectDirectory);
            yield {
              type: "entry_appended",
              entry: await this.#store.appendEntry(
                sessionId,
                "assistant_message",
                { runId, text: assistantText },
                this.#clock.now().toISOString(),
              ),
            };
            await revalidate(nextPrompt.actor, current.projectDirectory);
            yield {
              type: "entry_appended",
              entry: await this.#store.appendEntry(
                sessionId,
                "run_completed",
                { runId },
                this.#clock.now().toISOString(),
              ),
            };
            activeRunId = undefined;
            break;
          }

          if (assistantText) {
            await revalidate(nextPrompt.actor, current.projectDirectory);
            yield {
              type: "entry_appended",
              entry: await this.#store.appendEntry(
                sessionId,
                "assistant_message",
                { runId, text: assistantText },
                this.#clock.now().toISOString(),
              ),
            };
          }

          for (const toolCall of toolCalls) {
            await revalidate(nextPrompt.actor, current.projectDirectory);
            yield {
              type: "entry_appended",
              entry: await this.#store.appendEntry(
                sessionId,
                "tool_call",
                { runId, toolCallId: toolCall.id, name: toolCall.name, input: toolCall.input },
                this.#clock.now().toISOString(),
              ),
            };
          }

          for (const toolCall of toolCalls) {
            // Re-resolve immediately before every effect. This is the final
            // enforcement seam for grants, removals, and revocations.
            const { policy: executionPolicy } = await revalidate(
              nextPrompt.actor,
              current.projectDirectory,
            );
            const output = await executeTool(
              {
                projectDirectory: current.projectDirectory,
                dataDirectory: this.#dataDirectory,
                sessionId,
                toolCallId: toolCall.id,
                shell: this.#shell,
                signal: abortController.signal,
                executionPolicy,
              },
              toolCall.name,
              toolCall.input,
            );
            await revalidate(nextPrompt.actor, current.projectDirectory);
            yield {
              type: "entry_appended",
              entry: await this.#store.appendEntry(
                sessionId,
                "tool_result",
                { runId, toolCallId: toolCall.id, name: toolCall.name, output },
                this.#clock.now().toISOString(),
              ),
            };
          }
        }

        const followUp = await this.#store.claimNextFollowUp(sessionId);
        if (!followUp) return;
        nextPrompt = followUp.prompt;
        followUpId = followUp.id;
      }
    } catch (error) {
      const entry = await this.#store.appendEntry(
        sessionId,
        abortController.signal.aborted && !authorizationFailed ? "run_aborted" : "run_failed",
        {
          ...(typeof activeRunId === "string" ? { runId: activeRunId } : {}),
          error: error instanceof Error ? error.message : String(error),
        },
        this.#clock.now().toISOString(),
      );
      yield { type: "entry_appended", entry };
      if (abortController.signal.aborted) return;
      throw error;
    } finally {
      this.#runningSessions.delete(sessionId);
      this.#abortControllers.delete(sessionId);
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#store.close();
  }
}

export function createOpenGuiHarness(options: OpenGuiHarnessOptions): OpenGuiHarness {
  return new OpenGuiHarnessImpl(options);
}
