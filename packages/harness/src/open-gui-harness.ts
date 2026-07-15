import { randomUUID } from "node:crypto";
import { buildModelContext } from "./context/build-context.ts";
import { buildSystemPrompt } from "./context/system-prompt.ts";
import type {
  Clock,
  CreateSessionInput,
  HarnessSession,
  IdGenerator,
  ModelSelection,
  OpenGuiHarness,
  OpenGuiHarnessOptions,
  ReasoningLevel,
  SessionEvent,
  SessionSnapshot,
} from "./harness.ts";
import { discoverSkills } from "./skills/discover.ts";
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

  run(prompt: { text: string }): AsyncIterable<SessionEvent> {
    return this.#harness.run(this.#id, prompt.text);
  }

  async followUp(prompt: { text: string }) {
    await this.#harness.followUp(this.#id, prompt.text);
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
    this.#store = new SqliteSessionStore(options.dataDirectory, this.#ids);
    this.#ready = this.#store.recoverInterruptedRuns(this.#clock.now().toISOString());
  }

  #assertOpen() {
    if (this.#closed) throw new Error("OpenGuiHarness is closed");
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

  async followUp(sessionId: string, rawText: string) {
    this.#assertOpen();
    const text = rawText.trim();
    if (!text) throw new Error("Follow-up text must not be empty");
    if (!this.#runningSessions.has(sessionId)) {
      throw new Error("Follow-ups can only be queued while a Session is running");
    }
    await this.#store.enqueueFollowUp(sessionId, text, this.#clock.now().toISOString());
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

  async *run(sessionId: string, text: string): AsyncIterable<SessionEvent> {
    this.#assertOpen();
    if (!text.trim()) throw new Error("Prompt text must not be empty");
    if (this.#runningSessions.has(sessionId))
      throw new Error("A run is already active for this Session");
    this.#runningSessions.add(sessionId);
    const abortController = new AbortController();
    this.#abortControllers.set(sessionId, abortController);
    let activeRunId: string | undefined;
    try {
      let nextPrompt = text;
      let followUpId: string | undefined;
      while (nextPrompt) {
        const runId = this.#ids.next("run");
        activeRunId = runId;
        const snapshot = await this.readSession(sessionId);
        if (!snapshot.model || !snapshot.reasoning)
          throw new Error("Session model selection is incomplete");
        const startedEntries = await this.#store.beginRun({
          sessionId,
          runId,
          text: nextPrompt,
          model: snapshot.model,
          reasoning: snapshot.reasoning,
          followUpId,
          now: this.#clock.now().toISOString(),
        });
        for (const entry of startedEntries) yield { type: "entry_appended", entry };

        while (true) {
          const current = await this.readSession(sessionId);
          let assistantText = "";
          let reasoningText = "";
          const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
          const { skills } = discoverSkills({
            projectDirectory: current.projectDirectory,
            homeDirectory: this.#homeDirectory,
          });
          for await (const event of this.#model.stream(
            {
              projectDirectory: current.projectDirectory,
              context: buildModelContext(current.entries),
              systemPrompt: buildSystemPrompt({
                projectDirectory: current.projectDirectory,
                shell: this.#shell,
                skills,
                now: this.#clock.now(),
              }),
            },
            abortController.signal,
          )) {
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
            yield {
              type: "entry_appended",
              entry: await this.#store.appendEntry(
                sessionId,
                "assistant_message",
                { runId, text: assistantText },
                this.#clock.now().toISOString(),
              ),
            };
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
            const output = await executeTool(
              {
                projectDirectory: current.projectDirectory,
                dataDirectory: this.#dataDirectory,
                sessionId,
                toolCallId: toolCall.id,
                shell: this.#shell,
                signal: abortController.signal,
              },
              toolCall.name,
              toolCall.input,
            );
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
        nextPrompt = followUp.prompt.text;
        followUpId = followUp.id;
      }
    } catch (error) {
      const entry = await this.#store.appendEntry(
        sessionId,
        abortController.signal.aborted ? "run_aborted" : "run_failed",
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
