import { randomUUID } from "node:crypto";
import {
  redactProviderText,
  type PiAuthEvent,
  type PiAuthInteraction,
  type PiAuthPrompt,
  type PiCredential,
  type PiCredentialStore,
} from "@opengui/harness";
import {
  piProviderConnectionId,
  type ProviderAuthMethod,
  type ProviderLoginEvent,
  type ProviderLoginPrompt,
  type ProviderLoginStatus,
} from "@opengui/protocol";
import type { KeyedSerialLock } from "../effect/serial-lock.ts";

/** One pi provider credential. Personal credentials carry their owner's actor id. */
export type ProviderCredentialEntry = {
  providerId: string;
  ownerId?: string;
  credential: PiCredential;
};

/** Keyed by model connection id. */
export type ProviderCredentials = Record<string, ProviderCredentialEntry>;

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validCredential(value: unknown): PiCredential | null {
  if (!plainObject(value)) return null;
  if (value.type === "oauth") {
    return typeof value.access === "string" &&
      value.access.length > 0 &&
      typeof value.refresh === "string" &&
      value.refresh.length > 0 &&
      typeof value.expires === "number" &&
      Number.isFinite(value.expires)
      ? (structuredClone(value) as PiCredential)
      : null;
  }
  if (value.type !== "api_key") return null;
  if (value.key !== undefined && typeof value.key !== "string") return null;
  const env = plainObject(value.env)
    ? Object.fromEntries(
        Object.entries(value.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;
  return {
    type: "api_key",
    ...(value.key ? { key: value.key } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function validProviderCredentials(value: unknown): ProviderCredentials {
  if (!plainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([connectionId, entry]) => {
      if (!plainObject(entry) || typeof entry.providerId !== "string") return [];
      const credential = validCredential(entry.credential);
      if (!credential) return [];
      return [
        [
          connectionId,
          {
            providerId: entry.providerId,
            ...(typeof entry.ownerId === "string" ? { ownerId: entry.ownerId } : {}),
            credential,
          },
        ],
      ];
    }),
  );
}

/** OpenGUI's pre-pi OAuth token shape: `{ accessToken, refreshToken, expiresAt, accountId? }`. */
function legacyOAuth(value: unknown): PiCredential | null {
  if (!plainObject(value)) return null;
  const { accessToken, refreshToken, expiresAt, accountId } = value;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    typeof refreshToken !== "string" ||
    !refreshToken ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt)
  ) {
    return null;
  }
  return {
    type: "oauth",
    access: accessToken,
    refresh: refreshToken,
    expires: expiresAt,
    ...(typeof accountId === "string" && accountId ? { accountId } : {}),
  };
}

function legacyPersonal(value: unknown, provider?: "xai") {
  if (!plainObject(value)) return [];
  return Object.entries(value).flatMap(([ownerId, raw]) => {
    const item = provider ? (plainObject(raw) ? raw[provider] : undefined) : raw;
    if (!plainObject(item) || typeof item.connectionId !== "string") return [];
    const credential = legacyOAuth(item.tokens);
    return credential ? [{ ownerId, connectionId: item.connectionId, credential }] : [];
  });
}

/** Connection ids the pi provider list replaced; their settings rows and API keys are folded in. */
const LEGACY_CONNECTION_IDS = [
  "chatgpt-codex",
  "supergrok",
  "xai-api",
  "opencode-zen",
  "opencode-go",
];

/**
 * Folds the first-party Codex, SuperGrok, xAI API and OpenCode credentials into pi provider
 * credentials. Connection ids are preserved, so Sessions and offerings keep resolving.
 */
export function migrateLegacyProviderCredentials<Connection extends { id: string }>(input: {
  providerCredentials: ProviderCredentials;
  apiKeys: Record<string, string>;
  modelConnections: Connection[];
  codexTokens?: unknown;
  subscriptionTokens?: unknown;
  personalCodexTokens?: unknown;
  personalSubscriptionTokens?: unknown;
}) {
  const credentials = { ...input.providerCredentials };
  const add = (connectionId: string, entry: ProviderCredentialEntry) => {
    credentials[connectionId] ??= entry;
  };
  const codex = legacyOAuth(input.codexTokens);
  if (codex) add("chatgpt-codex", { providerId: "openai-codex", credential: codex });
  for (const item of legacyPersonal(input.personalCodexTokens)) {
    add(item.connectionId, {
      providerId: "openai-codex",
      ownerId: item.ownerId,
      credential: item.credential,
    });
  }
  const xaiKey = input.apiKeys["xai-api"];
  const xaiOAuth = legacyOAuth(
    plainObject(input.subscriptionTokens) ? input.subscriptionTokens.xai : undefined,
  );
  if (xaiKey) add("xai", { providerId: "xai", credential: { type: "api_key", key: xaiKey } });
  else if (xaiOAuth) add("xai", { providerId: "xai", credential: xaiOAuth });
  for (const item of legacyPersonal(input.personalSubscriptionTokens, "xai")) {
    add(item.connectionId, {
      providerId: "xai",
      ownerId: item.ownerId,
      credential: item.credential,
    });
  }
  for (const [connectionId, providerId] of [
    ["opencode-zen", "opencode"],
    ["opencode-go", "opencode-go"],
  ] as const) {
    if (!input.modelConnections.some((connection) => connection.id === connectionId)) continue;
    const key = input.apiKeys[connectionId];
    add(connectionId, { providerId, credential: { type: "api_key", ...(key ? { key } : {}) } });
  }
  const apiKeys = Object.fromEntries(
    Object.entries(input.apiKeys).filter(([id]) => !LEGACY_CONNECTION_IDS.includes(id)),
  );
  const modelConnections = input.modelConnections.filter(
    (connection) => !LEGACY_CONNECTION_IDS.includes(connection.id),
  );
  return { providerCredentials: credentials, apiKeys, modelConnections };
}

/** The connection id of `ownerId`'s credential for a provider (Host scope when undefined). */
export function providerCredentialConnectionId(
  credentials: ProviderCredentials,
  providerId: string,
  ownerId?: string,
) {
  if (!ownerId) {
    const id = piProviderConnectionId(providerId);
    const entry = credentials[id];
    return entry && !entry.ownerId && entry.providerId === providerId ? id : undefined;
  }
  return Object.entries(credentials).find(
    ([, entry]) => entry.ownerId === ownerId && entry.providerId === providerId,
  )?.[0];
}

/** pi credential storage for one scope: the Host (no owner) or one personal actor. */
export function createHostCredentialStore(input: {
  ownerId?: string;
  current: () => ProviderCredentials;
  update: (change: (credentials: ProviderCredentials) => ProviderCredentials) => Promise<void>;
  lock: KeyedSerialLock;
}): PiCredentialStore {
  const { ownerId } = input;
  const lockKey = (providerId: string) => JSON.stringify([ownerId ?? null, providerId]);
  const read = (providerId: string) => {
    const credentials = input.current();
    const id = providerCredentialConnectionId(credentials, providerId, ownerId);
    return id ? structuredClone(credentials[id]!.credential) : undefined;
  };
  return {
    read: async (providerId) => read(providerId),
    list: async () =>
      Object.values(input.current())
        .filter((entry) => entry.ownerId === ownerId)
        .map((entry) => ({ providerId: entry.providerId, type: entry.credential.type })),
    modify: (providerId, change) =>
      input.lock.run(lockKey(providerId), async () => {
        const current = read(providerId);
        const next = await change(current);
        if (!next) return current;
        await input.update((credentials) => {
          const id =
            providerCredentialConnectionId(credentials, providerId, ownerId) ??
            (ownerId ? `personal-${randomUUID()}` : piProviderConnectionId(providerId));
          return {
            ...credentials,
            [id]: {
              providerId,
              ...(ownerId ? { ownerId } : {}),
              credential: structuredClone(next),
            },
          };
        });
        return next;
      }),
    delete: (providerId) =>
      input.lock.run(lockKey(providerId), async () => {
        await input.update((credentials) => {
          const id = providerCredentialConnectionId(credentials, providerId, ownerId);
          if (!id) return credentials;
          const next = { ...credentials };
          delete next[id];
          return next;
        });
      }),
  };
}

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_LOGIN_EVENTS = 12;
const MAX_LOGIN_INPUT_LENGTH = 16 * 1024;

function publicPrompt(id: string, prompt: PiAuthPrompt): ProviderLoginPrompt {
  if (prompt.type === "select") {
    return {
      id,
      type: "select",
      message: prompt.message,
      options: prompt.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    };
  }
  return {
    id,
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
  };
}

function publicEvent(event: PiAuthEvent): ProviderLoginEvent {
  if (event.type === "auth_url") {
    return {
      type: "auth_url",
      url: event.url,
      ...(event.instructions ? { instructions: event.instructions } : {}),
    };
  }
  if (event.type === "device_code") {
    return {
      type: "device_code",
      userCode: event.userCode,
      verificationUri: event.verificationUri,
      ...(event.intervalSeconds ? { intervalSeconds: event.intervalSeconds } : {}),
      ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}),
    };
  }
  if (event.type === "info") {
    return {
      type: "info",
      message: event.message,
      ...(event.links?.length
        ? { links: event.links.map((link) => ({ url: link.url, label: link.label })) }
        : {}),
    };
  }
  return { type: "progress", message: event.message };
}

type LoginSession = {
  status: ProviderLoginStatus;
  controller: AbortController;
  pending?: { id: string; resolve: (value: string) => void };
  done: Promise<void>;
};

/**
 * Interactive pi sign-in flows, one per scope and provider. pi drives each flow; prompts wait
 * here until the user answers them through the Host API.
 */
export class ProviderLogins {
  readonly #sessions = new Map<string, LoginSession>();

  status(key: string): ProviderLoginStatus | undefined {
    const session = this.#sessions.get(key);
    return session ? structuredClone(session.status) : undefined;
  }

  begin(
    key: string,
    input: { providerId: string; method: ProviderAuthMethod },
    run: (interaction: PiAuthInteraction) => Promise<string | undefined>,
  ) {
    this.cancel(key);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Sign-in timed out")),
      LOGIN_TIMEOUT_MS,
    );
    timeout.unref?.();
    const session: LoginSession = {
      status: { providerId: input.providerId, method: input.method, state: "running", events: [] },
      controller,
      done: Promise.resolve(),
    };
    const clearPrompt = (id: string) => {
      if (session.pending?.id !== id) return;
      session.pending = undefined;
      delete session.status.prompt;
      if (session.status.state === "awaiting_input") session.status.state = "running";
    };
    const interaction: PiAuthInteraction = {
      signal: controller.signal,
      prompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          if (controller.signal.aborted) {
            reject(controller.signal.reason);
            return;
          }
          const id = randomUUID();
          const abort = () => {
            clearPrompt(id);
            reject(prompt.signal?.reason ?? controller.signal.reason);
          };
          session.pending = {
            id,
            resolve: (value) => {
              prompt.signal?.removeEventListener("abort", abort);
              controller.signal.removeEventListener("abort", abort);
              clearPrompt(id);
              resolve(value);
            },
          };
          session.status.prompt = publicPrompt(id, prompt);
          session.status.state = "awaiting_input";
          prompt.signal?.addEventListener("abort", abort, { once: true });
          controller.signal.addEventListener("abort", abort, { once: true });
        }),
      notify: (event) => {
        session.status.events = [...session.status.events, publicEvent(event)].slice(
          -MAX_LOGIN_EVENTS,
        );
      },
    };
    session.done = run(interaction).then(
      (connectionId) => {
        session.status.state = "succeeded";
        if (connectionId) session.status.connectionId = connectionId;
      },
      (error: unknown) => {
        session.status.state = controller.signal.aborted ? "cancelled" : "failed";
        if (session.status.state === "failed") {
          session.status.error = redactProviderText(
            error instanceof Error ? error.message : "Sign-in failed",
          );
        }
      },
    );
    void session.done.finally(() => {
      clearTimeout(timeout);
      delete session.status.prompt;
      session.pending = undefined;
    });
    this.#sessions.set(key, session);
    return structuredClone(session.status);
  }

  /** Answers the waiting prompt, then gives the flow a moment to reach its next step. */
  async respond(key: string, promptId: string, value: string) {
    const session = this.#sessions.get(key);
    if (!session?.pending || session.pending.id !== promptId) {
      throw new Error("This sign-in step is no longer waiting for input");
    }
    if (value.length > MAX_LOGIN_INPUT_LENGTH) throw new Error("Sign-in input is too long");
    session.pending.resolve(value);
    await Promise.race([session.done, new Promise((resolve) => setTimeout(resolve, 1_500))]);
    return structuredClone(session.status);
  }

  cancel(key: string) {
    const session = this.#sessions.get(key);
    if (!session) return undefined;
    if (session.status.state === "running" || session.status.state === "awaiting_input") {
      session.controller.abort(new Error("Sign-in cancelled"));
      session.status.state = "cancelled";
      delete session.status.prompt;
    }
    this.#sessions.delete(key);
    return structuredClone(session.status);
  }

  clear() {
    for (const key of this.#sessions.keys()) this.cancel(key);
  }
}
