const CONFIRM_PATH = "#/confirm-email";

/**
 * Reads an email-change confirmation token ONLY from the exact
 * `<origin>/#/confirm-email?token=…` fragment route that the backend issues.
 * Query-string aliases (`?emailChange=`) are never redeemed: tokens in the
 * query reach server/proxy logs and leak through Referer headers. They are
 * still scrubbed by removeEmailChangeToken for hygiene.
 */
export function readEmailChangeToken(url: string): string | null {
  const parsed = new URL(url);
  const hash = parsed.hash;
  const queryIndex = hash.indexOf("?");
  const path = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
  if (path !== CONFIRM_PATH) return null;
  const params = new URLSearchParams(queryIndex === -1 ? "" : hash.slice(queryIndex + 1));
  const token = params.get("token") ?? params.get("emailChange");
  return token?.trim() || null;
}

export function removeEmailChangeToken(url: string): string {
  const parsed = new URL(url);
  // Only the legacy flow-specific alias is scrubbed top-level; a bare `token`
  // parameter may belong to another flow and is left alone outside our route.
  parsed.searchParams.delete("emailChange");
  if (parsed.hash.includes("?")) {
    const [path = "", query = ""] = parsed.hash.split("?", 2);
    const params = new URLSearchParams(query);
    params.delete("emailChange");
    params.delete("token");
    parsed.hash = params.size ? `${path}?${params}` : path;
  }
  return parsed.toString();
}
