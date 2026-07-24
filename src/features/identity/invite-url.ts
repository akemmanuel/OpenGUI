export function readInviteToken(url: string): string | null {
  const parsed = new URL(url);
  const queryToken = parsed.searchParams.get("invite") ?? parsed.searchParams.get("inviteToken");
  if (queryToken?.trim()) return queryToken.trim();

  const hashQuery = parsed.hash.includes("?")
    ? parsed.hash.slice(parsed.hash.indexOf("?") + 1)
    : "";
  const hashToken = new URLSearchParams(hashQuery).get("invite");
  return hashToken?.trim() || null;
}

export function buildInviteLink(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("invite", token);
  parsed.searchParams.delete("inviteToken");
  return parsed.toString();
}

export function removeInviteToken(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete("invite");
  parsed.searchParams.delete("inviteToken");
  if (parsed.hash.includes("?")) {
    const [path = "", query = ""] = parsed.hash.split("?", 2);
    const params = new URLSearchParams(query);
    params.delete("invite");
    parsed.hash = params.size ? `${path}?${params}` : path;
  }
  return parsed.toString();
}
