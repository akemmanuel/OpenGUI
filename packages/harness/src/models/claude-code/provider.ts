/**
 * The `claude-code` pi provider: Claude models served by Claude Code through the Agent SDK,
 * with the user's Claude subscription, a `claude setup-token` token, or an Anthropic API key.
 * pi and OpenGUI see an ordinary provider; `runtime.ts` does the work.
 */
import {
  createAssistantMessageEventStream,
  createProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type Model,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { digest, errorMessage, transcriptEntries } from "./protocol.ts";
import {
  ClaudeCodeRuntime,
  decodeClaudeCodeCredential,
  encodeClaudeCodeCredential,
  writeJob,
  type ClaudeCodeCredential,
  type ClaudeCodeRuntimeOptions,
} from "./runtime.ts";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const CLAUDE_CODE_API = "claude-code";

/** Claude Code tokens and the local login do not expire on OpenGUI's side. */
const NEVER = Date.UTC(9999, 0, 1);

/** Models Claude Code serves, in menu order; metadata comes from pi's Anthropic catalog. */
const MODEL_IDS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5",
] as const;

/** Releases newer than the installed pi catalog: metadata of the nearest model, corrected. */
const NEWER_MODELS: Record<string, { from: string; name: string; cost: Model<Api>["cost"] }> = {
  "claude-fable-5-2": {
    from: "claude-fable-5-1",
    name: "Claude Fable 5.2",
    cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  },
};

let catalog: Model<Api>[] | undefined;

/** The models of the `claude-code` provider. */
export function claudeCodeModels(): Model<Api>[] {
  if (catalog) return catalog;
  const anthropic = builtinProviders().find((provider) => provider.id === "anthropic");
  const known = new Map((anthropic?.getModels() ?? []).map((model) => [model.id, model]));
  catalog = MODEL_IDS.flatMap((id) => {
    const newer = NEWER_MODELS[id];
    const source = known.get(id) ?? (newer ? known.get(newer.from) : undefined);
    if (!source) return [];
    const { compat: _compat, headers: _headers, ...metadata } = source;
    return [
      {
        ...structuredClone(metadata),
        ...(known.has(id) || !newer ? {} : { name: newer.name, cost: newer.cost }),
        id,
        api: CLAUDE_CODE_API,
        provider: CLAUDE_CODE_PROVIDER_ID,
        baseUrl: "claude-code://local",
      } as Model<Api>,
    ];
  });
  return catalog;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/** pi's thinking level as Claude Code's effort; no level keeps Claude Code's default. */
export function claudeCodeEffort(model: Model<Api>, level: ThinkingLevel | undefined) {
  if (!level) return undefined;
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return undefined;
  const effort = mapped ?? level;
  if ((EFFORTS as readonly string[]).includes(effort)) return effort as Effort;
  return level === "minimal" ? "low" : undefined;
}

type ClaudeCodeOAuthCredential = OAuthCredential & { mode?: "local" | "oauth-token" };

function oauthToCredential(credential: ClaudeCodeOAuthCredential): ClaudeCodeCredential {
  return credential.mode === "local"
    ? { mode: "local" }
    : { mode: "oauth-token", token: credential.access };
}

async function promptToken(interaction: ProviderAuthInteraction) {
  const token = (
    await interaction.prompt({
      type: "secret",
      message:
        "Run `claude setup-token` in a terminal, sign in with your Claude account, and paste the token it prints.",
      placeholder: "sk-ant-oat01-…",
      signal: interaction.signal,
    })
  ).trim();
  if (!token) throw new Error("No token was entered");
  return token;
}

export interface ClaudeCodeProviderOptions {
  /**
   * Whether this provider may use the account Claude Code is signed in to on this computer.
   * Only the Host's own scope may: a personal connection must bring its own credential.
   */
  allowLocalLogin?: boolean;
  runtime?: ClaudeCodeRuntime;
}

let sharedRuntime: ClaudeCodeRuntime | undefined;

/** The process-wide runtime, shared by every scope's provider. Credentials never share a process. */
export function claudeCodeRuntime(options?: ClaudeCodeRuntimeOptions) {
  sharedRuntime ??= new ClaudeCodeRuntime({
    log:
      process.env.OPENGUI_CLAUDE_CODE_DEBUG === "1"
        ? (message, fields) =>
            process.stderr.write(
              `[OpenGUI Claude Code] ${message} ${JSON.stringify(fields ?? {})}\n`,
            )
        : undefined,
    ...options,
  });
  return sharedRuntime;
}

/** Replaces the process-wide runtime, e.g. with a fake Claude Code in tests. */
export async function setClaudeCodeRuntime(runtime: ClaudeCodeRuntime | undefined) {
  if (sharedRuntime && sharedRuntime !== runtime) await sharedRuntime.close();
  sharedRuntime = runtime;
}

/** Stops every Claude Code process this OpenGUI process started. */
export async function closeClaudeCodeSessions() {
  await sharedRuntime?.close();
}

function errorResponse(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function errorStream(model: Model<Api>, message: string) {
  const stream = createAssistantMessageEventStream();
  const error = errorResponse(model, message);
  stream.push({ type: "error", reason: "error", error });
  stream.end(error);
  return stream;
}

/** Runtime failures are already worded for OpenGUI's error classification. */
function classified(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /^Claude\b/u.test(message) ? message : errorMessage(message);
}

export function createClaudeCodeProvider(options: ClaudeCodeProviderOptions = {}): Provider {
  const allowLocalLogin = options.allowLocalLogin ?? true;
  const runtime = () => options.runtime ?? claudeCodeRuntime();

  const streamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    streamOptions?: SimpleStreamOptions,
  ) => {
    let credential: ClaudeCodeCredential;
    try {
      credential = decodeClaudeCodeCredential(streamOptions?.apiKey);
    } catch (error) {
      return errorStream(model, classified(error));
    }
    if (credential.mode === "local" && !allowLocalLogin) {
      return errorStream(
        model,
        errorMessage("not logged in: this computer's Claude Code login is only for the Host"),
      );
    }
    const stream = createAssistantMessageEventStream();
    const started = Date.now();
    void (async () => {
      try {
        const systemPrompt = getCurrentSystemPrompt(context.messages);
        const tools = getCurrentTools(context.messages);
        const messages = transcriptEntries(context.messages);
        // OpenGUI passes a stable per-Session cache key; without one, the first turn identifies it.
        const key =
          streamOptions?.sessionId ??
          `anonymous:${digest({ systemPrompt, first: messages.slice(0, 1) })}`;
        const instance = runtime();
        const { job, session } = await instance.step({
          key,
          model,
          systemPrompt,
          tools,
          messages,
          effort: claudeCodeEffort(model, streamOptions?.reasoning),
          credential,
        });
        await writeJob({
          stream,
          job,
          model,
          signal: streamOptions?.signal,
          started,
          onAbort: () => instance.abort(session, job),
        });
      } catch (error) {
        const failed = errorResponse(model, classified(error));
        stream.push({ type: "error", reason: "error", error: failed });
        stream.end(failed);
      }
    })();
    return stream;
  };

  return createProvider({
    id: CLAUDE_CODE_PROVIDER_ID,
    name: "Claude Code",
    baseUrl: "claude-code://local",
    models: claudeCodeModels(),
    auth: {
      oauth: {
        name: "Claude subscription (through Claude Code)",
        loginLabel: "Sign in with Claude Code",
        isSubscription: true,
        async login(interaction) {
          let mode: "local" | "oauth-token" = "oauth-token";
          if (allowLocalLogin) {
            mode = (await interaction.prompt({
              type: "select",
              message: "How should OpenGUI sign in to Claude Code?",
              options: [
                {
                  id: "local",
                  label: "Use Claude Code's login on this computer",
                  description:
                    "Uses the account `claude` is signed in to. Run `claude` and /login first if it is not.",
                },
                {
                  id: "oauth-token",
                  label: "Paste a token from `claude setup-token`",
                  description: "A long-lived token for one Claude account.",
                },
              ],
              signal: interaction.signal,
            })) as "local" | "oauth-token";
          }
          if (mode === "local") {
            interaction.notify({
              type: "info",
              message:
                "OpenGUI uses the Claude account Claude Code is signed in to on this computer.",
            });
            return { type: "oauth", access: "local", refresh: "claude-code", expires: NEVER, mode };
          }
          const token = await promptToken(interaction);
          return { type: "oauth", access: token, refresh: "claude-code", expires: NEVER, mode };
        },
        async refresh(credential) {
          return { ...credential, expires: NEVER };
        },
        async toAuth(credential) {
          const decoded = oauthToCredential(credential as ClaudeCodeOAuthCredential);
          return { apiKey: encodeClaudeCodeCredential(decoded) };
        },
      },
      apiKey: {
        name: "Anthropic API key (through Claude Code)",
        async login(interaction) {
          const key = (
            await interaction.prompt({
              type: "secret",
              message: "Anthropic API key. Requests are billed to its Console organization.",
              placeholder: "sk-ant-api03-…",
              signal: interaction.signal,
            })
          ).trim();
          if (!key) throw new Error("No API key was entered");
          return { type: "api_key", key };
        },
        async resolve({ credential }) {
          // Never ambient: the provider is configured only by a stored key.
          return credential?.key
            ? { auth: { apiKey: credential.key }, source: "Anthropic API key" }
            : undefined;
        },
      },
    },
    api: {
      stream: (model, context, streamOptions) => streamSimple(model, context, streamOptions),
      streamSimple,
    },
  });
}
