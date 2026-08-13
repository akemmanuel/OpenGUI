import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildModelContext } from "./context/build-context.ts";
import {
  buildHandoffPrompt,
  compactionPaths,
  DEFAULT_COMPACTION_THRESHOLD_RATIO,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateContextTokens,
  latestCompletedCompaction,
} from "./context/compaction.ts";
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
import {
  createModelCachePolicy,
  DEFAULT_MODEL_DELIVERY,
  ModelTransportError,
  normalizeModelError,
  redactProviderText,
  type ModelRequest,
  type ModelToolName,
  type ProviderResponseMetadata,
} from "./models/transport.ts";
import { discoverSkills, loadSkillsFromDir } from "./skills/discover.ts";
import { selectSkillsForPrompt } from "./skills/format-prompt.ts";
import type { Skill } from "./skills/types.ts";
import { SqliteSessionStore } from "./storage/sqlite-store.ts";
import { executeTool, limitToolResult } from "./tools/execute-tool.ts";
import { toolDefinitionsFor } from "./tools/tool-definitions.ts";
import type { AgentToolSet } from "./tools/agent-tools.ts";
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

async function promiseWithAbort<T>(pending: Promise<T>, signal: AbortSignal) {
  return await new Promise<T>((resolvePending, rejectPending) => {
    const aborted = () => rejectPending(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    void pending.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolvePending(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        rejectPending(error);
      },
    );
  });
}

async function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal) {
  return await promiseWithAbort(iterator.next(), signal);
}

function selectedModel(entries: SessionSnapshot["entries"]): ModelSelection | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "model_changed") return entry.payload.model as ModelSelection;
  }
  return null;
}

function normalizePromptInput(prompt: PromptInput): PromptInput {
  const text = prompt.text.trim();
  const hasSkills = prompt.skills !== undefined;
  const skills = hasSkills
    ? Array.from(
        new Set((prompt.skills ?? []).map((name) => name.trim()).filter((name) => name.length > 0)),
      )
    : undefined;
  return {
    text,
    ...(prompt.actor ? { actor: prompt.actor } : {}),
    ...(hasSkills ? { skills } : {}),
    ...(prompt.skillPins ? { skillPins: prompt.skillPins.map((pin) => ({ ...pin })) } : {}),
  };
}

type SkillPin = NonNullable<PromptInput["skillPins"]>[number];

function lockedSkillPinsFromEntries(entries: SessionSnapshot["entries"]): SkillPin[] | null {
  for (const entry of entries) {
    if (entry.kind !== "user_message") continue;
    const pins = entry.payload.skillPins;
    if (!Array.isArray(pins)) continue;
    const valid = pins.filter(
      (pin): pin is SkillPin =>
        Boolean(pin) &&
        typeof pin === "object" &&
        typeof (pin as SkillPin).name === "string" &&
        /^[a-f0-9]{64}$/u.test((pin as SkillPin).revision) &&
        typeof (pin as SkillPin).directory === "string",
    );
    return valid.length === pins.length ? valid : [];
  }
  return null;
}

/** First durable selection locks the Session catalog for prompt-cache stability. */
function lockedSkillsFromEntries(entries: SessionSnapshot["entries"]): string[] | null {
  for (const entry of entries) {
    if (entry.kind !== "user_message") continue;
    if (!Object.hasOwn(entry.payload, "skills")) continue;
    const skills = entry.payload.skills;
    if (!Array.isArray(skills)) return [];
    return Array.from(
      new Set(
        skills
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    );
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

  compact(actor?: PromptInput["actor"]): AsyncIterable<SessionEvent> {
    return this.#harness.compact(this.#id, actor);
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

  async takeFollowUp(followUpId: string) {
    return await this.#harness.takeFollowUp(this.#id, followUpId);
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
  readonly #agentTools: OpenGuiHarnessOptions["agentTools"];
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #dataDirectory: string;
  readonly #hostId: string;
  readonly #homeDirectory: string | undefined;
  readonly #shell: ResolvedShell;
  readonly #resolveExecutionPolicy: OpenGuiHarnessOptions["resolveExecutionPolicy"];
  readonly #shellExecutor: OpenGuiHarnessOptions["shellExecutor"];
  readonly #compaction: Required<NonNullable<OpenGuiHarnessOptions["compaction"]>>;
  readonly #runningSessions = new Set<string>();
  readonly #abortControllers = new Map<string, AbortController>();
  readonly #runCompletions = new Map<string, Promise<void>>();
  readonly #completeRuns = new Map<string, () => void>();
  readonly #ready: Promise<void>;
  #closed = false;

  constructor(options: OpenGuiHarnessOptions) {
    this.#clock = options.clock ?? new SystemClock();
    this.#ids = options.ids ?? new RandomIdGenerator();
    this.#model = options.model;
    this.#agentTools = options.agentTools;
    this.#dataDirectory = options.dataDirectory;
    this.#hostId =
      options.hostId ??
      `legacy_${createHash("sha256").update(options.dataDirectory).digest("hex").slice(0, 24)}`;
    this.#homeDirectory = options.homeDirectory;
    this.#shell = resolveNativeShell({ configuredExecutable: options.shell?.executable });
    this.#resolveExecutionPolicy = options.resolveExecutionPolicy;
    this.#shellExecutor = options.shellExecutor;
    this.#compaction = {
      enabled: options.compaction?.enabled ?? true,
      contextWindowTokens: options.compaction?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      thresholdRatio: options.compaction?.thresholdRatio ?? DEFAULT_COMPACTION_THRESHOLD_RATIO,
      tempDirectory: options.compaction?.tempDirectory ?? tmpdir(),
    };
    if (this.#compaction.thresholdRatio <= 0 || this.#compaction.thresholdRatio >= 1) {
      throw new Error("Compaction thresholdRatio must be greater than 0 and less than 1");
    }
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
    return [
      "read",
      ...(writeDecision.allowed ? (["write", "edit"] as const) : []),
      ...(policy.shellAllowed ? (["shell"] as const) : []),
    ];
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

  async #pinSkills(skills: Skill[]): Promise<{ skills: Skill[]; pins: SkillPin[] }> {
    const pinnedSkills: Skill[] = [];
    const pins: SkillPin[] = [];
    for (const skill of skills) {
      const files: Array<{ path: string; contents: Uint8Array }> = [];
      const visit = async (directory: string, prefix: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const absolute = join(directory, entry.name);
          const info = await lstat(absolute);
          if (
            info.isSymbolicLink() ||
            (!info.isDirectory() && !info.isFile()) ||
            (info.isFile() && info.nlink !== 1)
          ) {
            throw new Error(`Skill ${skill.name} contains a link or special file`);
          }
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await visit(absolute, path);
          else files.push({ path, contents: new Uint8Array(await readFile(absolute)) });
        }
      };
      await visit(skill.baseDir, "");
      const hash = createHash("sha256");
      for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
        hash.update(file.path);
        hash.update("\0");
        hash.update(file.contents);
        hash.update("\0");
      }
      const revision = hash.digest("hex");
      const finalDirectory = join(this.#dataDirectory, "skill-pins", revision, skill.name);
      try {
        if (!(await lstat(finalDirectory)).isDirectory()) throw new Error("Invalid skill pin");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const stage = `${finalDirectory}.stage-${randomUUID()}`;
        await mkdir(stage, { recursive: true });
        try {
          for (const file of files) {
            const target = join(stage, ...file.path.split("/"));
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, file.contents, { flag: "wx", mode: 0o600 });
          }
          await mkdir(dirname(finalDirectory), { recursive: true });
          await rename(stage, finalDirectory).catch((renameError) => {
            const code = (renameError as NodeJS.ErrnoException).code;
            if (code !== "EEXIST" && code !== "ENOTEMPTY") throw renameError;
          });
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      }
      const loaded = loadSkillsFromDir(finalDirectory, skill.source).skills.find(
        (item) => item.name === skill.name,
      );
      if (!loaded) throw new Error(`Pinned skill ${skill.name} is invalid`);
      pinnedSkills.push(loaded);
      pins.push({ name: skill.name, revision, directory: finalDirectory });
    }
    return { skills: pinnedSkills, pins };
  }

  async #skillsFromPins(pins: SkillPin[]): Promise<Skill[]> {
    const result: Skill[] = [];
    for (const pin of pins) {
      const files: Array<{ path: string; contents: Uint8Array }> = [];
      const visit = async (directory: string, prefix: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const absolute = join(directory, entry.name);
          const info = await lstat(absolute);
          if (
            info.isSymbolicLink() ||
            (!info.isDirectory() && !info.isFile()) ||
            (info.isFile() && info.nlink !== 1)
          )
            throw new Error(`Pinned skill ${pin.name} is not immutable`);
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await visit(absolute, path);
          else files.push({ path, contents: new Uint8Array(await readFile(absolute)) });
        }
      };
      await visit(pin.directory, "");
      const hash = createHash("sha256");
      for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
        hash.update(file.path);
        hash.update("\0");
        hash.update(file.contents);
        hash.update("\0");
      }
      if (hash.digest("hex") !== pin.revision)
        throw new Error(`Pinned skill ${pin.name} content changed`);
      const skill = loadSkillsFromDir(pin.directory, "project").skills.find(
        (item) => item.name === pin.name,
      );
      if (!skill) throw new Error(`Pinned skill ${pin.name} is unavailable`);
      result.push(skill);
    }
    return result;
  }

  async listSessions(projectDirectory: string) {
    this.#assertOpen();
    await this.#ready;
    return this.#store.listSessions(projectDirectory);
  }

  async searchSessionMessages(projectDirectories: readonly string[], query: string) {
    this.#assertOpen();
    await this.#ready;
    return this.#store.searchSessionMessages(projectDirectories, query);
  }

  async listAllSessions() {
    this.#assertOpen();
    await this.#ready;
    return this.#store.listAllSessions();
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
      normalizePromptInput(prompt),
      this.#clock.now().toISOString(),
    );
  }

  async updateFollowUp(sessionId: string, followUpId: string, prompt: PromptInput) {
    this.#assertOpen();
    const text = prompt.text.trim();
    if (!text) throw new Error("Follow-up text must not be empty");
    const existing = (await this.#store.listFollowUps(sessionId)).find(
      (item) => item.id === followUpId,
    );
    await this.#store.updateFollowUp(
      sessionId,
      followUpId,
      normalizePromptInput({
        text,
        actor: prompt.actor ?? existing?.prompt.actor,
        skills: prompt.skills ?? existing?.prompt.skills,
      }),
    );
  }

  async reorderFollowUp(sessionId: string, followUpId: string, index: number) {
    this.#assertOpen();
    await this.#store.reorderFollowUp(sessionId, followUpId, index);
  }

  async removeFollowUp(sessionId: string, followUpId: string) {
    this.#assertOpen();
    await this.#store.removeFollowUp(sessionId, followUpId);
  }

  async takeFollowUp(sessionId: string, followUpId: string) {
    this.#assertOpen();
    return await this.#store.takePendingFollowUp(sessionId, followUpId);
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

  async *#performCompaction(input: {
    sessionId: string;
    runId: string;
    snapshot: SessionSnapshot;
    tools: ModelToolName[];
    systemPrompt: string;
    signal: AbortSignal;
    tokensBefore: number;
    reason: "manual" | "threshold";
    revalidate: () => Promise<{ policy: ExecutionPolicy; canonicalProjectRoot: string }>;
    actor?: PromptInput["actor"];
  }): AsyncIterable<SessionEvent> {
    const paths = compactionPaths(this.#compaction.tempDirectory, input.sessionId, input.runId);
    await mkdir(paths.directory, { recursive: true });
    yield {
      type: "entry_appended",
      entry: await this.#store.appendEntry(
        input.sessionId,
        "compaction",
        {
          runId: input.runId,
          status: "started",
          handoffDirectory: paths.directory,
          handoffPath: paths.handoffPath,
          tokensBefore: input.tokensBefore,
          thresholdRatio: this.#compaction.thresholdRatio,
          reason: input.reason,
        },
        this.#clock.now().toISOString(),
      ),
    };

    const context = [
      ...buildModelContext(input.snapshot.entries),
      {
        type: "user_message" as const,
        text: buildHandoffPrompt(paths),
        model: input.snapshot.model!,
        reasoning: input.snapshot.reasoning!,
      },
    ];

    while (true) {
      let assistantText = "";
      let reasoningText = "";
      const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      const modelRequest: ModelRequest = {
        identity: {
          hostId: this.#hostId,
          sessionId: input.sessionId,
          runId: input.runId,
          principalId: input.actor ? `${input.actor.type}:${input.actor.id}` : "local:legacy",
        },
        projectDirectory: input.snapshot.projectDirectory,
        actor: input.actor,
        context,
        tools: input.tools,
        systemPrompt: input.systemPrompt,
        cache: createModelCachePolicy({
          systemPrompt: input.systemPrompt,
          tools: input.tools,
          toolSchemas: toolDefinitionsFor(input.tools),
          permissionScope: { tools: input.tools, project: input.snapshot.projectDirectory },
          skillRevisions:
            lockedSkillPinsFromEntries(input.snapshot.entries)?.map((pin) => pin.revision) ?? [],
          compactionId: latestCompletedCompaction(input.snapshot.entries)?.entry.id,
        }),
        delivery: { ...DEFAULT_MODEL_DELIVERY },
      };
      let providerResponse: ProviderResponseMetadata | undefined;
      for await (const event of this.#model.stream(modelRequest, input.signal)) {
        await input.revalidate();
        input.signal.throwIfAborted();
        if (event.type === "text_delta") {
          assistantText += event.delta;
          yield { type: "assistant_delta", runId: input.runId, delta: event.delta };
        } else if (event.type === "reasoning_delta") {
          reasoningText += event.delta;
          yield { type: "reasoning_delta", runId: input.runId, delta: event.delta };
        } else if (event.type === "tool_call") {
          toolCalls.push({ id: event.id, name: event.name, input: event.input });
        } else if (event.type === "completed") {
          providerResponse = event.response;
        }
      }

      if (providerResponse) {
        yield {
          type: "entry_appended",
          entry: await this.#store.appendEntry(
            input.sessionId,
            "provider_response",
            { runId: input.runId, response: providerResponse, purpose: "compaction" },
            this.#clock.now().toISOString(),
          ),
        };
      }

      if (reasoningText) {
        yield {
          type: "entry_appended",
          entry: await this.#store.appendEntry(
            input.sessionId,
            "assistant_reasoning",
            { runId: input.runId, text: reasoningText, purpose: "compaction" },
            this.#clock.now().toISOString(),
          ),
        };
      }
      if (assistantText) {
        context.push({ type: "assistant_message", text: assistantText });
        yield {
          type: "entry_appended",
          entry: await this.#store.appendEntry(
            input.sessionId,
            "assistant_message",
            { runId: input.runId, text: assistantText, purpose: "compaction" },
            this.#clock.now().toISOString(),
          ),
        };
      }
      if (toolCalls.length === 0) break;

      for (const toolCall of toolCalls) {
        context.push({
          type: "tool_call",
          toolCallId: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        });
        yield {
          type: "entry_appended",
          entry: await this.#store.appendEntry(
            input.sessionId,
            "tool_call",
            {
              runId: input.runId,
              toolCallId: toolCall.id,
              name: toolCall.name,
              input: toolCall.input,
              purpose: "compaction",
            },
            this.#clock.now().toISOString(),
          ),
        };
      }
      for (const toolCall of toolCalls) {
        const { policy } = await input.revalidate();
        input.signal.throwIfAborted();
        const output = await executeTool(
          {
            projectDirectory: input.snapshot.projectDirectory,
            dataDirectory: this.#dataDirectory,
            sessionId: input.sessionId,
            toolCallId: toolCall.id,
            shell: this.#shell,
            signal: input.signal,
            executionPolicy: policy,
          },
          toolCall.name,
          toolCall.input,
        );
        context.push({
          type: "tool_result",
          toolCallId: toolCall.id,
          name: toolCall.name,
          output,
        });
        yield {
          type: "entry_appended",
          entry: await this.#store.appendEntry(
            input.sessionId,
            "tool_result",
            {
              runId: input.runId,
              toolCallId: toolCall.id,
              name: toolCall.name,
              output,
              purpose: "compaction",
            },
            this.#clock.now().toISOString(),
          ),
        };
      }
    }

    let handoff: string;
    try {
      handoff = await readFile(paths.handoffPath, "utf8");
    } catch {
      throw new Error(`Compaction did not create ${paths.handoffPath}`);
    }
    if (!handoff.trim()) throw new Error(`Compaction created an empty ${paths.handoffPath}`);

    yield {
      type: "entry_appended",
      entry: await this.#store.appendEntry(
        input.sessionId,
        "compaction",
        {
          runId: input.runId,
          status: "completed",
          handoffDirectory: paths.directory,
          handoffPath: paths.handoffPath,
          handoff,
          tokensBefore: input.tokensBefore,
          thresholdRatio: this.#compaction.thresholdRatio,
          model: input.snapshot.model,
          reasoning: input.snapshot.reasoning,
          reason: input.reason,
        },
        this.#clock.now().toISOString(),
      ),
    };
  }

  async *compact(sessionId: string, actor?: PromptInput["actor"]): AsyncIterable<SessionEvent> {
    this.#assertOpen();
    if (this.#runningSessions.has(sessionId)) {
      throw new Error("Cannot compact a running Session");
    }
    this.#runningSessions.add(sessionId);
    const abortController = new AbortController();
    this.#abortControllers.set(sessionId, abortController);
    let completeRun!: () => void;
    this.#runCompletions.set(
      sessionId,
      new Promise<void>((resolve) => {
        completeRun = resolve;
      }),
    );
    this.#completeRuns.set(sessionId, completeRun);
    const runId = this.#ids.next("run");
    let authorizationFailed = false;
    const revalidate = async (projectDirectory: string) => {
      try {
        return await this.#executionPolicyWithProjectAccess(actor, projectDirectory);
      } catch (error) {
        authorizationFailed = true;
        abortController.abort(error);
        throw error;
      }
    };
    try {
      const snapshot = await this.readSession(sessionId);
      if (!snapshot.model || !snapshot.reasoning) {
        throw new Error("Session model selection is incomplete");
      }
      if (!snapshot.entries.some((entry) => entry.kind === "user_message")) {
        throw new Error("There is no Session context to compact");
      }
      const initialAccess = await revalidate(snapshot.projectDirectory);
      const lockedSkills = lockedSkillsFromEntries(snapshot.entries);
      const existingPins = lockedSkillPinsFromEntries(snapshot.entries);
      const pinned = existingPins
        ? { skills: await this.#skillsFromPins(existingPins), pins: existingPins }
        : await this.#pinSkills(
            selectSkillsForPrompt(
              await this.#skillsForRun(snapshot.projectDirectory, initialAccess.policy),
              lockedSkills ?? undefined,
            ),
          );
      const skills = pinned.skills;
      const modelAccess = await revalidate(snapshot.projectDirectory);
      const tools = await this.#toolsForModel(modelAccess.policy, modelAccess.canonicalProjectRoot);
      const shellAvailable = tools.includes("shell");
      const systemPrompt = buildSystemPrompt({
        projectDirectory: snapshot.projectDirectory,
        ...(shellAvailable ? { shell: this.#shell } : {}),
        tools,
        skills,
        now: this.#clock.now(),
      });
      if (!existingPins) {
        await this.#store.pinSessionSkills(sessionId, pinned.pins);
      }
      yield {
        type: "entry_appended",
        entry: await this.#store.appendEntry(
          sessionId,
          "run_started",
          { runId, purpose: "compaction" },
          this.#clock.now().toISOString(),
        ),
      };
      const contextTokens = estimateContextTokens(
        buildModelContext(snapshot.entries),
        systemPrompt,
      );
      for await (const event of this.#performCompaction({
        sessionId,
        runId,
        snapshot,
        tools,
        systemPrompt,
        signal: abortController.signal,
        tokensBefore: contextTokens,
        reason: "manual",
        actor,
        revalidate: () => revalidate(snapshot.projectDirectory),
      })) {
        yield event;
      }
      yield {
        type: "entry_appended",
        entry: await this.#store.appendEntry(
          sessionId,
          "run_completed",
          { runId, purpose: "compaction" },
          this.#clock.now().toISOString(),
        ),
      };
    } catch (error) {
      const entry = await this.#store.appendEntry(
        sessionId,
        abortController.signal.aborted && !authorizationFailed ? "run_aborted" : "run_failed",
        {
          runId,
          purpose: "compaction",
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
      this.#completeRuns.get(sessionId)?.();
      this.#completeRuns.delete(sessionId);
      this.#runCompletions.delete(sessionId);
    }
  }

  async *run(sessionId: string, prompt: PromptInput): AsyncIterable<SessionEvent> {
    this.#assertOpen();
    if (!prompt.text.trim()) throw new Error("Prompt text must not be empty");
    if (this.#runningSessions.has(sessionId))
      throw new Error("A run is already active for this Session");
    this.#runningSessions.add(sessionId);
    let completeRun!: () => void;
    this.#runCompletions.set(
      sessionId,
      new Promise<void>((resolve) => {
        completeRun = resolve;
      }),
    );
    this.#completeRuns.set(sessionId, completeRun);
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
      let nextPrompt: PromptInput | null = normalizePromptInput(prompt);
      let followUpId: string | undefined;
      while (nextPrompt) {
        let admittedSkills: Skill[];
        const runId = this.#ids.next("run");
        activeRunId = runId;
        const snapshot = await this.readSession(sessionId);
        if (!snapshot.model || !snapshot.reasoning)
          throw new Error("Session model selection is incomplete");
        // Once a Session has a skill allowlist on its first user message, every
        // later turn reuses it so the system-prompt skills section stays stable
        // for provider prompt caching.
        const lockedSkills = lockedSkillsFromEntries(snapshot.entries);
        if (lockedSkills !== null) {
          nextPrompt = { ...nextPrompt, skills: lockedSkills };
        }
        // Resolve once at the durable run seam. Queued prompts retain their
        // actor, but never retain a stale policy snapshot.
        const admission = await revalidate(nextPrompt.actor, snapshot.projectDirectory);
        const existingPins = lockedSkillPinsFromEntries(snapshot.entries);
        if (existingPins) {
          admittedSkills = await this.#skillsFromPins(existingPins);
          nextPrompt = {
            ...nextPrompt,
            skills: existingPins.map((pin) => pin.name),
            skillPins: existingPins,
          };
        } else {
          const pinned = await this.#pinSkills(
            selectSkillsForPrompt(
              await this.#skillsForRun(snapshot.projectDirectory, admission.policy),
              nextPrompt.skills,
            ),
          );
          admittedSkills = pinned.skills;
          nextPrompt = {
            ...nextPrompt,
            skills: pinned.pins.map((pin) => pin.name),
            skillPins: pinned.pins,
          };
        }
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
        let runAgentToolSet: AgentToolSet | undefined;

        while (true) {
          const current = await this.readSession(sessionId);
          const initialAccess = await revalidate(nextPrompt.actor, current.projectDirectory);
          let assistantText = "";
          let reasoningText = "";
          const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
          let pins: SkillPin[] | null | undefined =
            nextPrompt.skillPins ?? lockedSkillPinsFromEntries(current.entries);
          if (!pins) {
            const pinned = await this.#pinSkills(
              selectSkillsForPrompt(
                await this.#skillsForRun(current.projectDirectory, initialAccess.policy),
                nextPrompt.skills,
              ),
            );
            admittedSkills = pinned.skills;
            pins = pinned.pins;
            nextPrompt = {
              ...nextPrompt,
              skills: pins.map((pin) => pin.name),
              skillPins: pins,
            };
            await this.#store.pinSessionSkills(sessionId, pins);
          }
          const skills = admittedSkills;
          // Skill discovery can perform I/O, so refresh once more immediately
          // before exposing capabilities to the provider.
          const modelAccess = await revalidate(nextPrompt.actor, current.projectDirectory);
          const tools = await this.#toolsForModel(
            modelAccess.policy,
            modelAccess.canonicalProjectRoot,
          );
          runAgentToolSet ??= await this.#agentTools?.resolve(
            {
              sessionId,
              runId,
              projectDirectory: current.projectDirectory,
              ...(nextPrompt.actor ? { actor: nextPrompt.actor } : {}),
            },
            abortController.signal,
          );
          const agentToolSet = runAgentToolSet;
          const builtInDefinitions = toolDefinitionsFor(tools);
          const builtInNames = new Set(builtInDefinitions.map((definition) => definition.name));
          const duplicate = agentToolSet?.definitions.find((definition) =>
            builtInNames.has(definition.name),
          );
          if (duplicate)
            throw new Error(`Additional tool conflicts with built-in: ${duplicate.name}`);
          const toolDefinitions = [...builtInDefinitions, ...(agentToolSet?.definitions ?? [])];
          const modelToolNames = toolDefinitions.map((definition) => definition.name);
          const shellAvailable = modelToolNames.includes("shell");
          const systemPrompt = buildSystemPrompt({
            projectDirectory: current.projectDirectory,
            ...(shellAvailable ? { shell: this.#shell } : {}),
            tools: modelToolNames,
            skills,
            now: this.#clock.now(),
          });
          const modelContext = buildModelContext(current.entries);
          const contextTokens = estimateContextTokens(modelContext, systemPrompt);
          const shouldCompact =
            this.#compaction.enabled &&
            contextTokens >=
              this.#compaction.contextWindowTokens * this.#compaction.thresholdRatio &&
            latestCompletedCompaction(current.entries)?.entry.id !== current.entries.at(-1)?.id;
          if (shouldCompact) {
            for await (const event of this.#performCompaction({
              sessionId,
              runId,
              snapshot: current,
              tools,
              systemPrompt,
              signal: abortController.signal,
              tokensBefore: contextTokens,
              reason: "threshold",
              actor: nextPrompt.actor,
              revalidate: () => revalidate(nextPrompt!.actor, current.projectDirectory),
            })) {
              yield event;
            }
            continue;
          }
          const request: ModelRequest = {
            identity: {
              hostId: this.#hostId,
              sessionId,
              runId,
              principalId: nextPrompt.actor
                ? `${nextPrompt.actor.type}:${nextPrompt.actor.id}`
                : "local:legacy",
            },
            projectDirectory: current.projectDirectory,
            actor: nextPrompt.actor,
            context: modelContext,
            tools: modelToolNames,
            toolDefinitions,
            systemPrompt,
            cache: createModelCachePolicy({
              systemPrompt,
              tools: modelToolNames,
              toolSchemas: toolDefinitions,
              permissionScope: {
                project: modelAccess.canonicalProjectRoot,
                tools: modelToolNames,
                restricted: modelAccess.policy.restricted,
                agentToolGeneration: agentToolSet?.generation,
              },
              skillRevisions: (pins ?? []).map((pin) => pin.revision),
              compactionId: latestCompletedCompaction(current.entries)?.entry.id,
            }),
            delivery: { ...DEFAULT_MODEL_DELIVERY },
          };
          const modelIterator = this.#model
            .stream(request, abortController.signal)
            [Symbol.asyncIterator]();
          let providerResponse: ProviderResponseMetadata | undefined;
          try {
            while (true) {
              const nextModelEvent = await nextWithAbort(modelIterator, abortController.signal);
              if (nextModelEvent.done) break;
              const event = nextModelEvent.value;
              // Provider chunks are the finest useful revocation boundary. Do
              // not expose or retain a chunk until current actor and Project
              // access have both been re-resolved.
              await revalidate(nextPrompt.actor, current.projectDirectory);
              abortController.signal.throwIfAborted();
              if (event.type === "text_delta") {
                assistantText += event.delta;
                yield { type: "assistant_delta", runId, delta: event.delta };
              } else if (event.type === "reasoning_delta") {
                reasoningText += event.delta;
                yield { type: "reasoning_delta", runId, delta: event.delta };
              } else if (event.type === "tool_call") {
                toolCalls.push({ id: event.id, name: event.name, input: event.input });
              } else if (event.type === "completed") {
                providerResponse = event.response;
              }
            }
          } finally {
            await modelIterator.return?.();
          }

          if (providerResponse) {
            await revalidate(nextPrompt.actor, current.projectDirectory);
            yield {
              type: "entry_appended",
              entry: await this.#store.appendEntry(
                sessionId,
                "provider_response",
                { runId, response: providerResponse },
                this.#clock.now().toISOString(),
              ),
            };
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
            const displayName = toolDefinitions.find(
              (definition) => definition.name === toolCall.name,
            )?.title;
            yield {
              type: "entry_appended",
              entry: await this.#store.appendEntry(
                sessionId,
                "tool_call",
                {
                  runId,
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  ...(displayName ? { displayName } : {}),
                  input: toolCall.input,
                },
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
            abortController.signal.throwIfAborted();
            const toolContext = {
              projectDirectory: current.projectDirectory,
              dataDirectory: this.#dataDirectory,
              sessionId,
              toolCallId: toolCall.id,
              shell: this.#shell,
              signal: abortController.signal,
              executionPolicy,
              shellExecutor: this.#shellExecutor,
            };
            let output: unknown;
            try {
              output = agentToolSet?.definitions.some(
                (definition) => definition.name === toolCall.name,
              )
                ? await promiseWithAbort(
                    agentToolSet
                      .invoke(
                        { name: toolCall.name, input: toolCall.input },
                        abortController.signal,
                      )
                      .then((result) => limitToolResult(toolContext, result)),
                    abortController.signal,
                  )
                : await executeTool(toolContext, toolCall.name, toolCall.input);
            } catch (error) {
              if (abortController.signal.aborted) throw error;
              output = {
                status: "error",
                summary: redactProviderText(
                  error instanceof Error ? error.message : "Connected tool failed",
                ),
              };
            }
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
      const normalizedError = normalizeModelError(
        error,
        authorizationFailed ? undefined : abortController.signal,
      );
      if (error instanceof ModelTransportError && typeof activeRunId === "string") {
        yield {
          type: "entry_appended",
          entry: await this.#store.appendEntry(
            sessionId,
            "provider_response",
            { runId: activeRunId, response: error.response },
            this.#clock.now().toISOString(),
          ),
        };
      }
      const entry = await this.#store.appendEntry(
        sessionId,
        abortController.signal.aborted && !authorizationFailed ? "run_aborted" : "run_failed",
        {
          ...(typeof activeRunId === "string" ? { runId: activeRunId } : {}),
          error:
            authorizationFailed && error instanceof Error
              ? error.message
              : (normalizedError.detail ?? normalizedError.message),
          normalizedError,
        },
        this.#clock.now().toISOString(),
      );
      yield { type: "entry_appended", entry };
      if (abortController.signal.aborted) return;
      throw error;
    } finally {
      this.#runningSessions.delete(sessionId);
      this.#abortControllers.delete(sessionId);
      this.#completeRuns.get(sessionId)?.();
      this.#completeRuns.delete(sessionId);
      this.#runCompletions.delete(sessionId);
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#abortControllers.values()) controller.abort();
    await Promise.all(this.#runCompletions.values());
    await this.#store.close();
  }
}

export function createOpenGuiHarness(options: OpenGuiHarnessOptions): OpenGuiHarness {
  return new OpenGuiHarnessImpl(options);
}
