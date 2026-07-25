import type {
  HostEvent,
  CodexAuthStatus,
  HostModelConnection,
  HostSessionSnapshot,
  HostSkill,
  OpenGuiHostClient,
} from "@/protocol/host-types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SECRET_JSON_FIELD =
  /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)"\s*:\s*")[^"]*(")/giu;
const BEARER_CREDENTIAL = /(\bBearer\s+)[^\s,;]+/giu;
const SECRET_QUERY_PARAMETER = /([?&](?:api[_-]?key|access[_-]?token|token|secret)=)[^&#\s]+/giu;

/** Prevent untrusted Host/proxy diagnostics from becoming frontend secret disclosures. */
export function redactHostError(message: string): string {
  return message
    .replace(SECRET_JSON_FIELD, "$1[REDACTED]$2")
    .replace(BEARER_CREDENTIAL, "$1[REDACTED]")
    .replace(SECRET_QUERY_PARAMETER, "$1[REDACTED]");
}

export interface CreateHostClientOptions {
  baseUrl?: string;
  token?: string;
  resolveBaseUrl?: () => string | undefined;
  resolveToken?: () => string | undefined;
  fetchImpl?: FetchLike;
  reconnectDelayMs?: number;
}

async function readJson(response: Response) {
  const text = await response.text();
  let body: { ok?: boolean; value?: unknown; error?: string } | null = null;
  try {
    body = text ? (JSON.parse(text) as { ok?: boolean; value?: unknown; error?: string }) : null;
  } catch {
    body = null;
  }
  if (!response.ok || !body?.ok) {
    throw new Error(
      body?.error ? redactHostError(body.error) : `Host request failed (${response.status})`,
    );
  }
  return body.value;
}

export function createHostClient(options: CreateHostClientOptions = {}): OpenGuiHostClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  function resolveBase() {
    return (options.resolveBaseUrl?.() ?? options.baseUrl ?? "").replace(/\/+$/, "");
  }

  function resolveToken() {
    return options.resolveToken?.() ?? options.token ?? "";
  }

  async function request(path: string, init: RequestInit = {}) {
    const base = resolveBase();
    const headers = new Headers(init.headers);
    if (!headers.has("content-type") && init.body) {
      headers.set("content-type", "application/json");
    }
    const token = resolveToken();
    if (token && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    const url = path.startsWith("http") ? path : `${base}${path}`;
    return readJson(await fetchImpl(url, { ...init, headers }));
  }

  return {
    codexAuthStatus: async () => (await request("/api/host/auth/codex")) as CodexAuthStatus,
    beginCodexAuth: async () =>
      (await request("/api/host/auth/codex", { method: "POST", body: "{}" })) as CodexAuthStatus,
    pollCodexAuth: async () =>
      (await request("/api/host/auth/codex/poll", {
        method: "POST",
        body: "{}",
      })) as CodexAuthStatus,
    disconnectCodex: async () => {
      await request("/api/host/auth/codex", { method: "DELETE" });
    },
    subscriptionAuthStatus: async (provider) =>
      (await request(`/api/host/auth/${provider}`)) as CodexAuthStatus,
    beginSubscriptionAuth: async (provider) =>
      (await request(`/api/host/auth/${provider}`, {
        method: "POST",
        body: "{}",
      })) as CodexAuthStatus,
    pollSubscriptionAuth: async (provider) =>
      (await request(`/api/host/auth/${provider}/poll`, {
        method: "POST",
        body: "{}",
      })) as CodexAuthStatus,
    disconnectSubscription: async (provider) => {
      await request(`/api/host/auth/${provider}`, { method: "DELETE" });
    },
    health: async () =>
      (await request("/api/host/health")) as { ok: true; version: string; shell: string },
    listModelConnections: async () => (await request("/api/host/models")) as HostModelConnection[],
    upsertModelConnection: async (connection) =>
      (await request("/api/host/models", {
        method: "POST",
        body: JSON.stringify(connection),
      })) as HostModelConnection,
    removeModelConnection: async (connectionId) => {
      await request(`/api/host/models/${encodeURIComponent(connectionId)}`, {
        method: "DELETE",
      });
    },
    listProjects: async () =>
      (await request("/api/host/projects")) as Array<{ directory: string; name: string }>,
    registerProject: async (directory) =>
      (await request("/api/host/projects", {
        method: "POST",
        body: JSON.stringify({ directory }),
      })) as { directory: string; name: string },
    unregisterProject: async (directory) => {
      await request("/api/host/projects", {
        method: "DELETE",
        body: JSON.stringify({ directory }),
      });
    },
    listSkills: async (directory) =>
      (await request(`/api/host/skills?directory=${encodeURIComponent(directory)}`)) as HostSkill[],
    listSessions: async (directory) =>
      (await request(`/api/host/sessions?directory=${encodeURIComponent(directory)}`)) as Array<{
        id: string;
        projectDirectory: string;
        title: string;
        createdAt: string;
        updatedAt: string;
        status: HostSessionSnapshot["status"];
      }>,
    searchSessionMessages: async (directories, query) =>
      (await request("/api/host/session-message-search", {
        method: "POST",
        body: JSON.stringify({ directories, query }),
      })) as string[],
    createSession: async (input) =>
      (await request("/api/host/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      })) as HostSessionSnapshot,
    readSession: async (sessionId) =>
      (await request(`/api/host/sessions/${encodeURIComponent(sessionId)}`)) as HostSessionSnapshot,
    renameSession: async (sessionId, title) =>
      (await request(`/api/host/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      })) as HostSessionSnapshot,
    deleteSession: async (sessionId) => {
      await request(`/api/host/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    },
    setModel: async (sessionId, model) =>
      (await request(`/api/host/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ model }),
      })) as HostSessionSnapshot,
    setReasoning: async (sessionId, reasoning) =>
      (await request(`/api/host/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ reasoning }),
      })) as HostSessionSnapshot,
    prompt: async (sessionId, text, options) =>
      (await request(`/api/host/sessions/${encodeURIComponent(sessionId)}/prompt`, {
        method: "POST",
        body: JSON.stringify({
          text,
          // Preserve empty arrays: they mean "no skills", not "use defaults".
          ...(options?.skills !== undefined ? { skills: options.skills } : {}),
        }),
      })) as
        | { mode: "run"; startedEntries: HostSessionSnapshot["entries"] }
        | { mode: "follow_up"; followUp: HostSessionSnapshot["followUps"][number] },
    updateFollowUp: async (sessionId, followUpId, text) =>
      (await request(
        `/api/host/sessions/${encodeURIComponent(sessionId)}/follow-ups/${encodeURIComponent(followUpId)}`,
        { method: "PATCH", body: JSON.stringify({ text }) },
      )) as HostSessionSnapshot["followUps"],
    reorderFollowUp: async (sessionId, followUpId, index) =>
      (await request(
        `/api/host/sessions/${encodeURIComponent(sessionId)}/follow-ups/${encodeURIComponent(followUpId)}/reorder`,
        { method: "POST", body: JSON.stringify({ index }) },
      )) as HostSessionSnapshot["followUps"],
    removeFollowUp: async (sessionId, followUpId) =>
      (await request(
        `/api/host/sessions/${encodeURIComponent(sessionId)}/follow-ups/${encodeURIComponent(followUpId)}`,
        { method: "DELETE" },
      )) as HostSessionSnapshot["followUps"],
    sendFollowUpNow: async (sessionId, followUpId) =>
      (await request(
        `/api/host/sessions/${encodeURIComponent(sessionId)}/follow-ups/${encodeURIComponent(followUpId)}/send-now`,
        { method: "POST", body: "{}" },
      )) as HostSessionSnapshot["followUps"],
    abort: async (sessionId) => {
      await request(`/api/host/sessions/${encodeURIComponent(sessionId)}/abort`, {
        method: "POST",
        body: "{}",
      });
    },
    findFiles: async (directory, query) =>
      (await request("/api/rpc", {
        method: "POST",
        body: JSON.stringify({ channel: "files:find", args: [directory, query] }),
      })) as string[],
    subscribe: (listener, sessionId, onReady) => {
      const params = new URLSearchParams();
      if (sessionId) params.set("sessionId", sessionId);
      const controller = new AbortController();
      void (async () => {
        while (!controller.signal.aborted) {
          try {
            const url = `${resolveBase()}/api/host/events?${params.toString()}`;
            const headers = new Headers();
            const token = resolveToken();
            if (token) headers.set("authorization", `Bearer ${token}`);
            const response = await fetchImpl(url, { headers, signal: controller.signal });
            if (!response.ok || !response.body)
              throw new Error(`Event stream failed (${response.status})`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (!controller.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const frames = buffer.split(/\r?\n\r?\n/u);
              buffer = frames.pop() ?? "";
              for (const frame of frames) {
                const dataLine = frame.split(/\r?\n/u).find((line) => line.startsWith("data:"));
                if (!dataLine) continue;
                try {
                  const data = JSON.parse(dataLine.slice(5).trim()) as
                    | HostEvent
                    | { type: "ready" };
                  if ("type" in data && data.type === "ready") {
                    onReady?.();
                    continue;
                  }
                  listener(data as HostEvent);
                } catch {
                  // Ignore malformed SSE payloads.
                }
              }
            }
          } catch {
            if (controller.signal.aborted) return;
          }
          if (controller.signal.aborted) return;
          await new Promise<void>((resolve) => {
            const finishWaiting = () => {
              controller.signal.removeEventListener("abort", stopWaiting);
              resolve();
            };
            const stopWaiting = () => {
              clearTimeout(timer);
              finishWaiting();
            };
            const timer = setTimeout(finishWaiting, options.reconnectDelayMs ?? 1_000);
            controller.signal.addEventListener("abort", stopWaiting, { once: true });
          });
        }
      })().catch(() => undefined);
      return () => controller.abort();
    },
  };
}
