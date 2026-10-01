import type { ModelRequest } from "./transport.ts";

// Keep in sync with the local Pi extension's OpenCode request headers.
const OPENCODE_USER_AGENT = "opencode/1.18.30";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastTimestamp = 0;
let sequence = 0;

function opencodeId(prefix: "msg" | "ses") {
  const timestamp = Date.now();
  if (timestamp === lastTimestamp) sequence += 1;
  else {
    lastTimestamp = timestamp;
    sequence = 0;
  }
  const timePart = (BigInt(timestamp) * 0x1000n + BigInt(sequence))
    .toString(16)
    .padStart(12, "0")
    .slice(-12);
  const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(14)))
    .map((byte) => BASE62[byte % BASE62.length])
    .join("");
  return `${prefix}_${timePart}${randomPart}`;
}

function isOpenCodeEndpoint(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return (
      url.origin === "https://opencode.ai" &&
      (url.pathname === "/zen" || url.pathname.startsWith("/zen/"))
    );
  } catch {
    return false;
  }
}

/** Provider-only identifiers: never send durable Host, principal, or Session IDs upstream. */
export class OpenCodeRequestHeaders {
  readonly #sessions = new Map<string, string>();

  clear() {
    this.#sessions.clear();
  }

  forRequest(baseUrl: string, request: ModelRequest): Record<string, string> {
    if (!isOpenCodeEndpoint(baseUrl)) return {};
    const identity = request.identity;
    const key = identity
      ? JSON.stringify([identity.hostId, identity.principalId, identity.sessionId])
      : undefined;
    const sessionId = (key && this.#sessions.get(key)) || opencodeId("ses");
    if (key) this.#sessions.set(key, sessionId);
    return {
      "user-agent": OPENCODE_USER_AGENT,
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "x-opencode-session": sessionId,
      "x-opencode-request": opencodeId("msg"),
    };
  }
}
