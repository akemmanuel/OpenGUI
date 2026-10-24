import { redactProviderText } from "@opengui/harness";

/** ChatGPT-backed Codex endpoints; the same family the Codex CLI uses for its built-in tools. */
export const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface CodexToolCredential {
  accessToken: string;
  accountId?: string;
}

export interface CodexBackendRequest {
  /** Path below the Codex backend base, for example `alpha/search`. */
  path: string;
  body: unknown;
  label: string;
  /** `forceRefresh` is requested once after an unexpected 401. */
  credential: (forceRefresh: boolean) => Promise<CodexToolCredential>;
  signal: AbortSignal;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** ChatGPT access tokens carry the workspace account id the backend routes on. */
export function codexAccountIdFromToken(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = claims[JWT_CLAIM_PATH];
    const accountId =
      auth && typeof auth === "object"
        ? (auth as Record<string, unknown>).chatgpt_account_id
        : undefined;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}

async function responseDetail(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  let detail = text;
  try {
    const parsed = JSON.parse(text) as Record<string, any>;
    const candidate = parsed.detail ?? parsed.error?.message ?? parsed.message;
    if (typeof candidate === "string") detail = candidate;
    else if (candidate && typeof candidate.message === "string") detail = candidate.message;
  } catch {
    // Non-JSON error bodies are reported as bounded text.
  }
  return redactProviderText(detail.replace(/\s+/gu, " ").trim()).slice(0, 240);
}

function failureMessage(label: string, status: number, detail: string) {
  const reason =
    status === 401
      ? "ChatGPT authorization expired. Reconnect the Codex provider in Settings."
      : status === 403
        ? `${label} is not available for this ChatGPT account or workspace.`
        : status === 429
          ? `${label} usage limit reached for this ChatGPT account. Try again later.`
          : status >= 500
            ? `${label} is temporarily unavailable (${status}). Try again later.`
            : `${label} request failed (${status}).`;
  return detail ? `${reason} ${detail}` : reason;
}

/** POST JSON to a Codex backend endpoint with one forced credential refresh after a 401. */
export async function codexBackendPost<T>(request: CodexBackendRequest): Promise<T> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]);
  const url = `${(request.baseUrl ?? CODEX_BACKEND_BASE_URL).replace(/\/+$/u, "")}/${request.path}`;
  const body = JSON.stringify(request.body);
  for (const forceRefresh of [false, true]) {
    const credential = await request.credential(forceRefresh);
    const accountId = credential.accountId ?? codexAccountIdFromToken(credential.accessToken);
    let response: Response;
    try {
      response = await (request.fetchImpl ?? fetch)(url, {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          ...(accountId ? { "chatgpt-account-id": accountId } : {}),
          originator: "opengui",
          "user-agent": "OpenGUI/1.0",
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (signal.aborted) throw new Error(`${request.label} timed out. Try again.`);
      throw new Error(`${request.label} could not reach ChatGPT. Check the network connection.`);
    }
    // A 401 cannot have produced a result, so one refresh-and-retry is safe.
    if (response.status === 401 && !forceRefresh) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!response.ok)
      throw new Error(
        failureMessage(request.label, response.status, await responseDetail(response)),
      );
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error(`${request.label} returned an unreadable response.`);
    }
  }
  throw new Error(failureMessage(request.label, 401, ""));
}
